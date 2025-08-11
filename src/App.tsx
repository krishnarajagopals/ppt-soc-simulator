// App.tsx — SoC Performance-Power-Thermal Simulator (with PDF + YouTube links)
// Additions:
// - Header buttons: "📺 Watch Demo" (YouTube) and "📄 Model PDF" (file in /public)
// - Everything else is your latest working version (incl. Ceff control)

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

////////////////////////////////////////////////////////////////////////////////
// CHANGE THESE TWO LINES ONLY to point to your real links:
const YOUTUBE_URL = "https://www.youtube.com/watch?v=iQu5MXEQQCo";       // <-- replace with your YouTube link
const PDF_PATH    =  import.meta.env.BASE_URL + "PPT_Simulator_Equations.pdf";                  // <-- replace with your PDF file name in /public
////////////////////////////////////////////////////////////////////////////////

interface SimPoint {
  t: number; power: number; temp: number; perfMIPS: number; energyWh: number; battPct: number; f: number; V: number;
}
type EndReason = "running" | "completed" | "battery" | "overheat" | "reset";

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function App() {
  useEffect(() => { document.title = "SoC Performance-Power-Thermal Simulator"; }, []);

  // --- User knobs ---
  const [workloadMix, setWorkloadMix] = useState(0.9);      // 0 mem-bound → 1 compute-bound
  const [ceffNF, setCeffNF] = useState(1.2);                // Effective switched capacitance in nF (≈ W/(V^2·GHz))
  const [manualOverride, setManualOverride] = useState(false);

  const [freqGHz, setFreqGHz] = useState(2.2);
  const [vdd, setVdd] = useState(0.9);

  const [ambient, setAmbient] = useState(25);
  const [thermalLimit, setThermalLimit] = useState(42);
  const [overheatGrace, setOverheatGrace] = useState(5);    // min 1 s enforced below
  const [batteryWh, setBatteryWh] = useState(0.75);
  const [workloadGI, setWorkloadGI] = useState(1000);

  const [speed, setSpeed] = useState(75);
  const [playing, setPlaying] = useState(false);

  
  //const [Rth, setRth] = useState(8.0);       // °C/W
  const Rth = 8.0; // °C/W

  const [tauSec, setTauSec] = useState(60);  // s (Cth = tau/Rth)

  // --- Fixed model params (except Ceff which is user-controlled) ---
  const P = {
    Pleak0: 0.6,  // W baseline at ~0.8–0.9 V, 25°C
    kV: 2.0,
    gamma: 0.04,
    IPCmin: 0.5,
    IPCmax: 2.0,
    dt: 0.25,     // s
    fMin: 0.6, fMax: 3.5, vMin: 0.6, vMax: 1.1,
    pstates: [
      { f: 3.0, V: 1.05 },
      { f: 2.6, V: 0.98 },
      { f: 2.2, V: 0.92 },
      { f: 1.8, V: 0.86 },
      { f: 1.4, V: 0.80 },
      { f: 1.0, V: 0.74 },
      { f: 0.8, V: 0.70 },
    ],
    slewStepSec: 0.3,
  } as const;

  // Derived from workload
  const alpha = 0.5 + 0.5 * workloadMix;
  const ipc = P.IPCmin + (P.IPCmax - P.IPCmin) * workloadMix;

  // --- Sim state ---
  const [series, setSeries] = useState<SimPoint[]>([]);
  const [endReason, setEndReason] = useState<EndReason>("running");
  const [remainingGI, setRemainingGI] = useState(workloadGI);
  const [throttling, setThrottling] = useState(false);

  // --- Mutable refs for loop ---
  const T_ref = useRef(ambient);
  const EWh_ref = useRef(0);
  const t_ref = useRef(0);
  const overheatAccum_ref = useRef(0);
  const remainingGI_ref = useRef(workloadGI);
  const slewCooldown_ref = useRef(0);

  const pIndex_ref = useRef<number>(2);
  const f_ref = useRef<number>(P.pstates[pIndex_ref.current].f);
  const V_ref = useRef<number>(P.pstates[pIndex_ref.current].V);

  const resetSim = () => {
    T_ref.current = ambient; EWh_ref.current = 0; t_ref.current = 0;
    overheatAccum_ref.current = 0;
    remainingGI_ref.current = workloadGI; setRemainingGI(workloadGI);
    setSeries([]); setEndReason("running"); setThrottling(false);
    pIndex_ref.current = 2; f_ref.current = P.pstates[2].f; V_ref.current = P.pstates[2].V;
    slewCooldown_ref.current = 0;
  };

  useEffect(() => {
    if (!playing) { remainingGI_ref.current = workloadGI; setRemainingGI(workloadGI); }
  }, [workloadGI, playing]);

  const targetPIndex = useMemo(() => {
    const n = P.pstates.length;
    let idx = Math.round((1 - workloadMix) * (n - 1));
    return clamp(idx, 0, n - 1);
  }, [P.pstates.length, workloadMix]);

  // Main loop (fixed tick for smooth charts)
  useEffect(() => {
    if (!playing) return;
    const tickMs = 100, maxSpeed = 50;

    const handle = window.setInterval(() => {
      let vtime = (tickMs / 1000) * clamp(speed, 1, maxSpeed);
      let localEnd: EndReason | null = null;
      let localThrottling = throttling;
      const newPoints: SimPoint[] = [];

      while (vtime > 0 && (localEnd ?? endReason) === "running") {
        const h = Math.min(P.dt, vtime);
        vtime -= h;

        // Governor with hysteresis
        let thermalTriggered = false;
        if (!manualOverride) {
          if (slewCooldown_ref.current > 0) slewCooldown_ref.current = Math.max(0, slewCooldown_ref.current - h);

          const HYST = 2.0;
          let desired = targetPIndex;
          const cur = pIndex_ref.current;

          if (T_ref.current >= thermalLimit) { desired = Math.min(cur + 1, P.pstates.length - 1); thermalTriggered = true; }
          else if (T_ref.current > thermalLimit - HYST) { desired = Math.max(cur, desired); }

          const battPctNow = Math.max(0, 100 * (1 - EWh_ref.current / batteryWh));
          if (battPctNow < 20) desired = Math.max(desired, 3);

          if (slewCooldown_ref.current === 0) {
            if (desired < cur) pIndex_ref.current = cur - 1;
            else if (desired > cur) pIndex_ref.current = cur + 1;

            if (pIndex_ref.current !== cur) {
              f_ref.current = P.pstates[pIndex_ref.current].f;
              V_ref.current = P.pstates[pIndex_ref.current].V;
              slewCooldown_ref.current = P.slewStepSec;
            }
          }
        } else {
          f_ref.current = clamp(freqGHz, P.fMin, P.fMax);
          V_ref.current = clamp(vdd, P.vMin, P.vMax);
        }

        // Performance
        const perfGIPS = Math.max(0, ipc * f_ref.current);
        const perfMIPS = perfGIPS * 1000;

        // Power (uses user-controlled Ceff)
        // ceffNF in nF numerically equals W/(V^2·GHz) under our scaling.
        const Pdyn = ceffNF * V_ref.current * V_ref.current * f_ref.current * alpha;
        const Pleak = P.Pleak0 * Math.exp(P.kV * (V_ref.current - 0.8)) * Math.exp(P.gamma * (T_ref.current - 25));
        const Ptot = Pdyn + Pleak;

        // Work & completion
        const dWorkGI = perfGIPS * h;
        remainingGI_ref.current = Math.max(0, remainingGI_ref.current - dWorkGI);
        if (remainingGI_ref.current <= 0) { setRemainingGI(0); localEnd = "completed"; }
        else setRemainingGI(remainingGI_ref.current);

        // Thermal RC
        const Cth = Math.max(1e-6, tauSec / Math.max(1e-6, Rth));
        const tau = Rth * Cth;
        const Tss = ambient + Ptot * Rth;
        T_ref.current += (Tss - T_ref.current) * (1 - Math.exp(-h / tau));

        // Energy & battery
        EWh_ref.current += (Ptot * h) / 3600;
        const battPct = Math.max(0, 100 * (1 - EWh_ref.current / batteryWh));

        // Overheat grace with decay
        const OVERHEAT_MARGIN = 5;
        if (T_ref.current > thermalLimit + OVERHEAT_MARGIN) overheatAccum_ref.current += h;
        else overheatAccum_ref.current = Math.max(0, overheatAccum_ref.current - 2 * h);

        // Record point
        t_ref.current += h;
        newPoints.push({
          t: +t_ref.current.toFixed(2),
          power: +Ptot.toFixed(3),
          temp: +T_ref.current.toFixed(3),
          perfMIPS: +perfMIPS.toFixed(1),
          energyWh: +EWh_ref.current.toFixed(5),
          battPct: +battPct.toFixed(2),
          f: +f_ref.current.toFixed(2),
          V: +V_ref.current.toFixed(2),
        });

        localThrottling = thermalTriggered || T_ref.current >= thermalLimit;
        if (EWh_ref.current >= batteryWh) localEnd = "battery";
        if (overheatAccum_ref.current >= Math.max(1, overheatGrace)) localEnd = "overheat";
      }

      if (newPoints.length) {
        setSeries(prev => {
          const cap = prev.length > 3000 ? prev.slice(prev.length - 1500) : prev;
          return [...cap, ...newPoints];
        });
      }
      if (localThrottling !== throttling) setThrottling(localThrottling);
      if (localEnd && endReason === "running") setEndReason(localEnd);
    }, tickMs);

    return () => window.clearInterval(handle);
  }, [
    playing, speed, endReason,
    workloadMix, manualOverride, freqGHz, vdd,
    targetPIndex, ambient, thermalLimit, overheatGrace, batteryWh, Rth, tauSec,
    P.Pleak0, P.kV, P.gamma, P.dt, P.pstates.length, P.slewStepSec,
    ipc, alpha, throttling, ceffNF,
  ]);

  const last = series.at(-1);
  const progressPct = useMemo(() => {
    const done = Math.max(0, workloadGI - remainingGI);
    return workloadGI > 0 ? clamp((100 * done) / workloadGI, 0, 100) : 0;
  }, [remainingGI, workloadGI]);

  const stateText = useMemo(() => {
    if (endReason === "completed") return "Completed";
    if (endReason === "battery" || endReason === "overheat") return "Stopped";
    return playing ? "Running" : "Paused";
  }, [endReason, playing]);

  const activeIndex = pIndex_ref.current;
  const Cth = useMemo(() => Math.max(1e-6, tauSec / Math.max(1e-6, Rth)), [tauSec, Rth]);

  return (
    <div style={styles.page}>
      {/* Header with title + links */}
      <header style={styles.header}>
        <div>
          <h1 style={styles.title}>SoC Performance-Power-Thermal Simulator</h1>
          <div style={styles.tagline}>Interactive DVFS &amp; Thermal Management</div>
        </div>

        <div style={styles.links}>
          <a href={YOUTUBE_URL} target="_blank" rel="noreferrer" style={styles.linkBtn}>📺 Watch Model Details</a>
          <a href={PDF_PATH} target="_blank" rel="noreferrer" style={styles.linkBtn}>📄 Model PDF</a>
        </div>
      </header>

      <div style={styles.grid}>
        {/* LEFT: Controls + Summary */}
        <section style={styles.card}>
          <h2 style={styles.h2}>Controls</h2>

          {/* Workload + end labels */}
          <div style={{ marginBottom: 10 }}>
            <div style={{ marginBottom: 8, fontSize: 18, fontWeight: 700 }}>
              Workload Mix (compute→mem): {workloadMix.toFixed(2)}
            </div>
            <input
              type="range" min={0} max={1} step={0.01}
              value={workloadMix}
              onChange={(e) => setWorkloadMix(parseFloat(e.target.value))}
              style={{ width: "100%" }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, opacity: 0.8, marginTop: 4 }}>
              <span>Memory</span><span>Compute</span>
            </div>
          </div>

          {/* Ceff (nF) just under workload */}
          <div style={{ marginBottom: 12 }}>
            <NumberField
              label="Ceff (nF)"
              value={ceffNF}
              setValue={(n) => setCeffNF(Number.isFinite(n) ? Math.max(0.1, n) : 1.2)}
            />
            <div style={{ fontSize: 14, opacity: 0.8, marginTop: 6 }}>
              Effective Chip Capacitance
            </div>
          </div>

          {/* Manual override */}
          <label style={{ ...styles.row, marginBottom: 8 }}>
            <input type="checkbox" checked={manualOverride} onChange={(e) => setManualOverride(e.target.checked)} />
            <span style={{ marginLeft: 10, fontWeight: 700 }}>Manual f/V override</span>
          </label>

          <details style={{ marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 700 }}>Expert: Frequency & Voltage</summary>
            <div>
              <Range label={`Frequency: ${freqGHz.toFixed(2)} GHz`} min={P.fMin} max={P.fMax} step={0.05} value={freqGHz} onChange={setFreqGHz} disabled={!manualOverride} />
              <Range label={`Vdd: ${vdd.toFixed(2)} V`} min={P.vMin} max={P.vMax} step={0.01} value={vdd} onChange={setVdd} disabled={!manualOverride} />
            </div>
          </details>

          <div style={styles.controlsGrid}>
            <NumberField label="Ambient (°C)" value={ambient} setValue={setAmbient} />
            <NumberField label="Thermal Limit (°C)" value={thermalLimit} setValue={setThermalLimit} />
            <NumberField label="Overheat Grace (s)" value={overheatGrace} setValue={(n) => setOverheatGrace(Math.max(1, Number.isFinite(n) ? n : 1))} />
            <NumberField label="Battery Capacity (Wh)" value={batteryWh} setValue={setBatteryWh} />
            <NumberField label="Workload (Billion Instructions)" value={workloadGI} setValue={setWorkloadGI} />
          </div>

          {/* Tau control (label clarified) */}
          <div style={{ marginTop: 12 }}>
            <Range
              label={`τ (Thermal Time Constant): ${tauSec.toFixed(0)} s  —  τ = Rth × Cth`}
              min={20} max={300} step={5} value={tauSec} onChange={setTauSec}
            />
            <div style={{ fontSize: 16 }}>
              <b>Rth</b> = {Rth.toFixed(1)} °C/W,&nbsp;
              <b>Cth</b> = {(Cth).toFixed(1)} J/°C
            </div>
          </div>

          <div style={{ marginTop: 16, display: "flex", gap: 12, alignItems: "center" }}>
            <button onClick={() => { if (endReason !== "running") { resetSim(); } setPlaying(true); }} disabled={playing} style={styles.btn}>Play</button>
            <button onClick={() => setPlaying(false)} disabled={!playing} style={styles.btn}>Pause</button>
            <button onClick={() => { setPlaying(false); resetSim(); }} style={styles.btn}>Reset</button>

            <div style={{ marginLeft: 16, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 18, fontWeight: 700 }}>Speed:</span>
              <input type="range" min={1} max={100} step={1} value={speed} onChange={(e) => setSpeed(parseInt(e.target.value))} />
              <span style={{ width: 60, textAlign: "right", fontVariantNumeric: "tabular-nums", fontSize: 18, fontWeight: 800 }}>{speed}x</span>
            </div>
          </div>

          {/* Summary */}
          <h2 style={{ ...styles.h2, marginTop: 22 }}>Summary</h2>
          <div style={styles.summaryGrid}>
            <Stat label="Perf (MIPS)" value={(last ? last.perfMIPS : 0).toFixed(0)} />
            <Stat label="Elapsed Time (s)" value={(series.length ? series[series.length - 1].t : 0).toFixed(1)} />
            <Stat label="Remaining Workload (Billion Instructions)" value={remainingGI.toFixed(1)} />
            <div style={{ gridColumn: "1 / -1", fontSize: 16 }}>
              <b>Perf = IPC(workload) × freq</b> — units: <b>MIPS</b>
            </div>
          </div>
        </section>

        {/* RIGHT: Status + DVFS + Charts */}
        <section style={{ ...styles.card, ...styles.phoneCard }}>
          <div style={{ ...styles.statusBar, justifyContent: "flex-start", gap: 18 }}>
            <MiniBattery pct={last ? last.battPct : 100} />
            <span style={styles.statusLabel}>State:</span>
            <span style={styles.statusValue}>{stateText}</span>
            <span style={styles.statusDivider}>•</span>
            <span style={styles.statusLabel}>f:</span>
            <span style={styles.statusValue}>{last ? last.f.toFixed(2) : "--"} GHz</span>
            <span style={styles.statusDivider}>•</span>
            <span style={styles.statusLabel}>V:</span>
            <span style={styles.statusValue}>{last ? last.V.toFixed(2) : "--"} V</span>
            <span style={styles.statusDivider}>•</span>
            <span style={styles.statusLabel}>Skin T:</span>
            <span style={styles.statusValue}>{last ? last.temp.toFixed(1) : "--"} °C</span>
            {throttling && <span style={styles.throttleBadge}>THROTTLING</span>}
          </div>

          {/* Debug mini-line */}
          <div style={{ margin: "8px 0 12px", fontSize: 16 }}>
            t: {(series.at(-1)?.t ?? 0).toFixed(1)} s,&nbsp;
            P: {(series.at(-1)?.power ?? 0).toFixed(2)} W,&nbsp;
            T: {(series.at(-1)?.temp ?? 0).toFixed(1)} °C,&nbsp;
            Tss≈ {last ? (ambient + last.power * Rth).toFixed(1) : "--"} °C,&nbsp;
            P-state: P{pIndex_ref.current}
          </div>

          {/* DVFS Table (tight height) */}
          <div style={{ overflowX: "auto", marginBottom: 10 }}>
            <table style={styles.dvfsTableTight}>
              <thead>
                <tr>
                  <th style={styles.dvfsThTight}>P-state</th>
                  <th style={styles.dvfsThTight}>f (GHz)</th>
                  <th style={styles.dvfsThTight}>V (V)</th>
                </tr>
              </thead>
              <tbody>
                {P.pstates.map((ps, idx) => {
                  const active = idx === activeIndex;
                  return (
                    <tr key={idx} style={active ? styles.dvfsTrActive : styles.dvfsTr}>
                      <td style={styles.dvfsTdTight}>P{idx}</td>
                      <td style={styles.dvfsTdTight}>{ps.f.toFixed(2)}</td>
                      <td style={styles.dvfsTdTight}>{ps.V.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Progress */}
          <div style={{ display: "flex", alignItems: "center", gap: 16, margin: "8px 0 16px 0" }}>
            <div style={{ flex: 1, height: 18, background: "#22252b", border: "2px solid #2a2a31", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ width: `${progressPct}%`, height: "100%", background: "#8bc34a" }} />
            </div>
            <div style={{ minWidth: 360, fontSize: 18, fontWeight: 700 }}>
              Remaining Workload: {remainingGI.toFixed(1)} Billion Instructions ({progressPct.toFixed(1)}%)
            </div>
          </div>

          {/* Charts */}
          <div style={styles.chartsGrid}>
            <Card title="Power & Temp over Time">
              <ResponsiveContainer width="100%" height={380}>
                <LineChart data={series} margin={{ left: 16, right: 16, top: 14, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="t" tickFormatter={(v) => `${v}s`} tick={{ fontSize: 18, fontWeight: 700 }} />
                  <YAxis yAxisId="left" label={{ value: "W", angle: -90, position: "insideLeft", offset: 8 }} tick={{ fontSize: 18, fontWeight: 700 }} />
                  <YAxis yAxisId="right" orientation="right" label={{ value: "°C", angle: -90, position: "insideRight", offset: 8 }} tick={{ fontSize: 18, fontWeight: 700 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 18, fontWeight: 700 }} />
                  <Line yAxisId="left"  type="monotone" dataKey="power"   name="Power (W)"  stroke="#ff5722" strokeWidth={5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  <Line yAxisId="right" type="monotone" dataKey="temp"    name="Temp (°C)"  stroke="#2196f3" strokeWidth={5} strokeDasharray="6 4" dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Performance (MIPS) & Energy (Wh) over Time">
              <ResponsiveContainer width="100%" height={380}>
                <LineChart data={series} margin={{ left: 16, right: 16, top: 14, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="t" tickFormatter={(v) => `${v}s`} tick={{ fontSize: 18, fontWeight: 700 }} />
                  <YAxis yAxisId="left" label={{ value: "MIPS", angle: -90, position: "insideLeft", offset: 8 }} tick={{ fontSize: 18, fontWeight: 700 }} />
                  <YAxis yAxisId="right" orientation="right" label={{ value: "Wh", angle: -90, position: "insideRight", offset: 8 }} tick={{ fontSize: 18, fontWeight: 700 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 18, fontWeight: 700 }} />
                  <Line yAxisId="left"  type="monotone" dataKey="perfMIPS" name="Perf (MIPS)" stroke="#4caf50" strokeWidth={5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                  <Line yAxisId="right" type="monotone" dataKey="energyWh" name="Energy (Wh)" stroke="#fbc02d" strokeWidth={5} strokeDasharray="6 4" dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>
        </section>
      </div>
    </div>
  );
}

// --- Small UI helpers ---
function Range({ label, min, max, step, value, onChange, disabled, }:
  { label: string; min: number; max: number; step: number; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div style={{ marginBottom: 16, opacity: disabled ? 0.6 : 1 }}>
      <div style={{ marginBottom: 8, fontSize: 18, fontWeight: 700 }}>{label}</div>
      <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(parseFloat(e.target.value))} style={{ width: "100%" }} />
    </div>
  );
}

function NumberField({ label, value, setValue, min, }:
  { label: string; value: number; setValue: (n: number) => void; min?: number; }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span style={{ fontSize: 18, fontWeight: 700, opacity: 0.95 }}>{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        onChange={(e) => setValue(parseFloat(e.target.value))}
        style={styles.number}
      />
    </label>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#0f0f12", border: "2px solid #2a2a31", borderRadius: 14, padding: 12, marginBottom: 16 }}>
      <h3 style={{ margin: "4px 8px 10px", fontSize: 22, fontWeight: 800, opacity: 0.9 }}>{title}</h3>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

function MiniBattery({ pct }: { pct: number }) {
  const clamped = clamp(pct, 0, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ position: "relative", width: 60, height: 30, border: "3px solid #bbb", borderRadius: 6 }}>
        <div style={{ position: "absolute", right: -7, top: 10, width: 7, height: 10, background: "#bbb", borderRadius: 2 }} />
        <div style={{ height: "100%", width: `${clamped}%`, background: clamped < 30 ? "#ff5252" : "#69f0ae" }} />
      </div>
      <span style={{ fontSize: 22, fontWeight: 900 }}>{clamped.toFixed(0)}%</span>
    </div>
  );
}

// --- Styles ---
const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#0f0f12", color: "#f2f2f2", padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto", fontSize: 18, fontWeight: 700 },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 },
  title: { margin: 0, fontSize: 40, fontWeight: 900 },
  tagline: { marginTop: 6, fontSize: 17, fontWeight: 700, opacity: 0.88 },
  links: { display: "flex", gap: 12 },
  linkBtn: {
    display: "inline-block",
    padding: "8px 12px",
    borderRadius: 10,
    border: "2px solid #2a2a31",
    background: "#20202a",
    color: "#e9f2ff",
    textDecoration: "none",
    fontWeight: 800,
  } as React.CSSProperties,

  grid: { display: "grid", gridTemplateColumns: "1fr 2fr", gap: 20 },
  card: { background: "#17171b", border: "2px solid #2a2a31", borderRadius: 14, padding: 18 },
  h2: { margin: 0, marginBottom: 14, fontSize: 26, fontWeight: 800 },
  row: { display: "flex", alignItems: "center", fontSize: 18 },
  controlsGrid: { display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 14, marginTop: 10 },
  phoneCard: { position: "relative", paddingTop: 12 },

  statusBar: { display: "flex", alignItems: "center", gap: 16, fontSize: 18, padding: "10px 14px", borderRadius: 12, background: "#0f0f12", border: "2px solid #2a2a31", marginBottom: 12 },
  statusLabel: { fontSize: 20, fontWeight: 800, opacity: 0.9 },
  statusValue: { fontSize: 22, fontWeight: 900 },
  statusDivider: { opacity: 0.6 },

  // DVFS tight table
  dvfsTableTight: { width: "100%", borderCollapse: "collapse" as const, fontSize: 16 },
  dvfsThTight: { textAlign: "left" as const, padding: "6px 8px", borderBottom: "2px solid #2a2a31", color: "#cfcfd6", fontWeight: 800 },
  dvfsTdTight: { padding: "6px 8px", borderBottom: "2px solid #2a2a31", fontWeight: 750 },
  dvfsTr: { background: "#141418" },
  dvfsTrActive: { background: "#1e2a18", outline: "2px solid #4caf50" },

  number: { background: "#101013", color: "#f2f2f2", border: "2px solid #2a2a31", borderRadius: 10, padding: "10px 12px", fontSize: 18, fontWeight: 700 },
  btn: { background: "#2a2a31", border: "2px solid #393945", borderRadius: 10, padding: "8px 12px", color: "#eee", cursor: "pointer", fontSize: 18, fontWeight: 800 },
  select: { background: "#101013", color: "#f2f2f2", border: "2px solid #2a2a31", borderRadius: 8, padding: "8px 10px", fontSize: 18, fontWeight: 700 },

  summaryGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0,1fr))", gap: 12, marginTop: 8 },
  stat: { background: "#101013", border: "2px solid #2a2a31", borderRadius: 12, padding: 12 },
  statLabel: { fontSize: 16, color: "#cfcfd6", fontWeight: 700 },
  statValue: { marginTop: 6, fontSize: 24, fontWeight: 900 },

  chartsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },

  throttleBadge: {
    marginLeft: 12, padding: "4px 10px", borderRadius: 999,
    fontSize: 16, fontWeight: 900, color: "#0b0b0b", background: "#ffcc00",
    border: "2px solid #ff9800", boxShadow: "0 0 0 2px rgba(255,152,0,0.2)",
  } as React.CSSProperties,
};

export default App;
