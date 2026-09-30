import { useState, useEffect } from "react";
import { simulatorApi } from "./api";
import type { SimStatus, SimVehicle, SimScenario, SimMetrics } from "./types";

const SCENARIO_LABELS: Record<string, { label: string; desc: string }> = {
  delivery_outage: { label: "Delivery Outage", desc: "Drop webhooks and block connector responses" },
  transient_5xx: { label: "Transient 500 Server Errors", desc: "Return 500 on 20% of OEM requests" },
  rate_limit: { label: "Rate Limiting (HTTP 429)", desc: "Trigger 429 Too Many Requests responses" },
  expired_auth: { label: "Expired Auth Tokens / Keys", desc: "Revoke OAuth tokens & API keys" },
  duplicate_delivery: { label: "Duplicate Deliveries", desc: "Send duplicated sample payloads" },
  delayed_out_of_order: { label: "Delayed Out-of-Order Delivery", desc: "Deliver past samples after newer ones" },
  breaking_schema: { label: "Breaking Schema Changes", desc: "Omit required fields or alter structure" },
  invalid_sensor_value: { label: "Invalid Sensor Readings", desc: "Inject negative battery, extreme speeds" },
  missing_gps: { label: "Missing GPS / Coordinates", desc: "Set lat/lon to null in telemetry samples" },
  gps_noise: { label: "GPS Telemetry Drift / Noise", desc: "Inject random jitter into position coordinates" },
};

export default function App() {
  const [status, setStatus] = useState<SimStatus | null>(null);
  const [scenarios, setScenarios] = useState<Record<string, SimScenario>>({});
  const [metrics, setMetrics] = useState<SimMetrics>({});
  const [vehicles, setVehicles] = useState<SimVehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const [seedInput, setSeedInput] = useState(12345);
  const [countInput, setCountInput] = useState(10);
  const [speedMultiplier, setSpeedMultiplier] = useState(1.0);

  async function loadData() {
    try {
      const [statusData, vehiclesData] = await Promise.all([
        simulatorApi.getStatus(),
        simulatorApi.getVehicles(),
      ]);
      setStatus(statusData);
      setScenarios(statusData.scenarios || {});
      setMetrics(statusData.metrics || {});
      setVehicles(vehiclesData.vehicles || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to connect to simulator backend");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    if (!autoRefresh) return;
    const interval = setInterval(loadData, 1500);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  async function handleStart() {
    try {
      await simulatorApi.start();
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handlePausePhysics() {
    try {
      await simulatorApi.pause();
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleResumePhysics() {
    try {
      await simulatorApi.resume();
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleStop() {
    try {
      await simulatorApi.stop();
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleReset() {
    try {
      await simulatorApi.reset(seedInput, countInput, speedMultiplier);
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleSetSpeed(mult: number) {
    try {
      setSpeedMultiplier(mult);
      await simulatorApi.setSpeed(mult);
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  }

  async function handleToggleScenario(name: string, currentVal: boolean) {
    try {
      await simulatorApi.setScenario(name, !currentVal);
      await loadData();
    } catch (e: any) {
      alert(e.message);
    }
  }

  const isDeliveryOutageActive = Boolean(scenarios["delivery_outage"]?.enabled);
  const stateAdvancing = metrics["state_advancing"] || 0;
  const samplesGenerated = metrics["samples_generated"] || 0;
  const samplesDelivered = (metrics["samples_delivered"] || 0) +
    (metrics["voltera_telemetry_delivered"] || 0) +
    (metrics["crestline_telemetry_delivered"] || 0) +
    (metrics["navarro_webhooks_dispatched"] || 0);

  return (
    <div className="sim-container">
      <div className="sim-banner">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="sim-banner-badge">Notice</span>
          <span>Simulator console — demo/testing only</span>
        </div>
        <span style={{ fontSize: 12, opacity: 0.9 }}>
          Isolated external OEM simulator (Port 3002)
        </span>
      </div>

      <div className="sim-header">
        <div className="sim-title-group">
          <h1>
            Automotive OEM Simulation Console
            {status && (
              <span
                className={`sim-status-pill ${
                  !status.running ? "stopped" : status.paused ? "paused" : "running"
                }`}
              >
                <span className="pulse-dot" />
                {!status.running ? "Stopped" : status.paused ? "Physics Paused" : "Running"}
              </span>
            )}
          </h1>
          <p>
            Deterministic vehicle kinematic engine, simulated OEM endpoints, and controlled fault injection.
          </p>
        </div>

        <div className="btn-group">
          <button
            className={`btn btn-outage ${isDeliveryOutageActive ? "active" : ""}`}
            onClick={() => handleToggleScenario("delivery_outage", isDeliveryOutageActive)}
          >
            {isDeliveryOutageActive ? "DELIVERY OUTAGE ACTIVE" : "Toggle Delivery Outage"}
          </button>

          {!status?.running ? (
            <button className="btn btn-primary" onClick={handleStart}>
              Start Engine
            </button>
          ) : status.paused ? (
            <button className="btn btn-primary" onClick={handleResumePhysics}>
              Resume Physics
            </button>
          ) : (
            <button className="btn btn-warning" onClick={handlePausePhysics}>
              Pause Physics
            </button>
          )}

          <button
            className="btn btn-danger"
            onClick={handleStop}
            disabled={!status?.running}
          >
            Stop
          </button>
          <button className="btn" onClick={handleReset}>
            Reset Simulation
          </button>
          <button
            className="btn"
            onClick={() => setAutoRefresh(!autoRefresh)}
            style={{ minWidth: 90 }}
          >
            {autoRefresh ? "Pause UI" : "Live UI"}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            background: "rgba(218, 54, 51, 0.2)",
            border: "1px solid #da3633",
            color: "#f85149",
            padding: "12px 16px",
            borderRadius: 6,
            marginBottom: 20,
          }}
        >
          {error}
        </div>
      )}

      <div className="sim-grid">
        <div className="card">
          <div className="card-title">
            <span>Pipeline Progression Diagnostics</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Source stages</span>
          </div>

          <div className="metrics-row">
            <div className="metric-box">
              <div className="metric-label">Vehicle State Advancing</div>
              <div className="metric-val green">{stateAdvancing.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Physics ticks</div>
            </div>
            <div className="metric-box">
              <div className="metric-label">Samples Generated</div>
              <div className="metric-val blue">{samplesGenerated.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>OEM telemetry samples</div>
            </div>
            <div className="metric-box">
              <div className="metric-label">Samples Delivered</div>
              <div className="metric-val amber">{samplesDelivered.toLocaleString()}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>Polled / Webhook sent</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, fontSize: 12 }}>
            <div style={{ background: "var(--bg-surface)", padding: 8, borderRadius: 4 }}>
              <div style={{ fontWeight: 600, color: "var(--text-bright)" }}>Voltera Motors</div>
              <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
                Requests: {metrics["voltera_requests"] || 0}
              </div>
              <div style={{ color: "var(--text-muted)" }}>
                Delivered: {metrics["voltera_telemetry_delivered"] || 0}
              </div>
              <div style={{ color: "var(--text-muted)" }}>
                5xx: {metrics["voltera_500_errors"] || 0} | 429: {metrics["voltera_429_rate_limit"] || 0}
              </div>
            </div>

            <div style={{ background: "var(--bg-surface)", padding: 8, borderRadius: 4 }}>
              <div style={{ fontWeight: 600, color: "var(--text-bright)" }}>Crestline Auto</div>
              <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
                Requests: {metrics["crestline_requests"] || 0}
              </div>
              <div style={{ color: "var(--text-muted)" }}>
                Delivered: {metrics["crestline_telemetry_delivered"] || 0}
              </div>
              <div style={{ color: "var(--text-muted)" }}>
                5xx: {metrics["crestline_500_errors"] || 0} | 429: {metrics["crestline_429_rate_limit"] || 0}
              </div>
            </div>

            <div style={{ background: "var(--bg-surface)", padding: 8, borderRadius: 4 }}>
              <div style={{ fontWeight: 600, color: "var(--text-bright)" }}>Navarro Webhooks</div>
              <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
                Dispatched: {metrics["navarro_webhooks_dispatched"] || 0}
              </div>
              <div style={{ color: "var(--text-muted)" }}>
                Failed: {metrics["navarro_webhooks_failed"] || 0}
              </div>
              <div style={{ color: "var(--text-muted)" }}>
                Retries: {metrics["navarro_webhooks_retried"] || 0}
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-title">
            <span>Simulation Parameters</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Seed & Kinematics</span>
          </div>

          <div className="param-row">
            <label>Random Seed:</label>
            <input
              type="number"
              value={seedInput}
              onChange={(e) => setSeedInput(parseInt(e.target.value, 10) || 0)}
            />
          </div>

          <div className="param-row">
            <label>Vehicle Count:</label>
            <input
              type="number"
              min="1"
              max="100"
              value={countInput}
              onChange={(e) => setCountInput(parseInt(e.target.value, 10) || 1)}
            />
          </div>

          <div className="param-row">
            <label>Simulation Speed:</label>
            <div className="btn-group" style={{ flex: 1 }}>
              {[0.5, 1.0, 2.0, 5.0, 10.0].map((m) => (
                <button
                  key={m}
                  className={`btn ${speedMultiplier === m ? "btn-primary" : ""}`}
                  style={{ padding: "4px 8px", fontSize: 12 }}
                  onClick={() => handleSetSpeed(m)}
                >
                  {m}x
                </button>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 14, display: "flex", justifyContent: "flex-end" }}>
            <button className="btn btn-primary" onClick={handleReset}>
              Apply & Re-initialize
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 24 }}>
        <div className="card-title">
          <span>Failure & Edge Case Scenarios</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Inject anomalies into simulated OEM feeds
          </span>
        </div>

        <div className="scenario-list">
          {Object.keys(SCENARIO_LABELS).map((scKey) => {
            const sc = SCENARIO_LABELS[scKey];
            const isEnabled = Boolean(scenarios[scKey]?.enabled);

            return (
              <div
                key={scKey}
                className={`scenario-card ${isEnabled ? "active" : ""}`}
                onClick={() => handleToggleScenario(scKey, isEnabled)}
              >
                <div className="scenario-info">
                  <span className="scenario-name">{sc.label}</span>
                  <span className="scenario-desc">{sc.desc}</span>
                </div>
                <label className="toggle-switch">
                  <input type="checkbox" checked={isEnabled} readOnly />
                  <span className="slider" />
                </label>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-title">
          <span>Simulated Vehicles ({vehicles.length})</span>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Real-time physical kinematic states & generated sample sequence
          </span>
        </div>

        <div className="table-wrapper">
          <table className="sim-table">
            <thead>
              <tr>
                <th>Vehicle ID</th>
                <th>OEM / Model</th>
                <th>Movement</th>
                <th>Speed (km/h)</th>
                <th>Target</th>
                <th>Position (Lat, Lon)</th>
                <th>Heading</th>
                <th>SOC / Fuel</th>
                <th>Odometer</th>
                <th>Sample Seq</th>
                <th>Sample Timestamp</th>
                <th>Fault</th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const badgeClass =
                  v.status === "MOVING"
                    ? "badge-moving"
                    : v.status === "IDLE"
                    ? "badge-idle"
                    : v.status === "CHARGING"
                    ? "badge-charging"
                    : "badge-parked";

                return (
                  <tr key={v.id}>
                    <td className="mono" style={{ fontWeight: 600, color: "var(--text-bright)" }}>
                      {v.id}
                    </td>
                    <td>
                      {v.oem_id.replace("oem_", "").toUpperCase()} · {v.make} {v.model}
                    </td>
                    <td>
                      <span className={`badge ${badgeClass}`}>{v.status}</span>
                    </td>
                    <td className="mono" style={{ fontWeight: 600, color: v.speed > 0 ? "#3fb950" : "var(--text-muted)" }}>
                      {v.speed.toFixed(1)} km/h
                    </td>
                    <td className="mono" style={{ color: "var(--text-muted)" }}>
                      {v.target_speed.toFixed(1)}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>
                      {v.lat.toFixed(5)}, {v.lon.toFixed(5)}
                    </td>
                    <td className="mono">{Math.round(v.heading)}°</td>
                    <td className="mono">
                      {v.soc !== null ? `${v.soc.toFixed(1)}% SOC` : `${v.fuel_level.toFixed(1)}% Fuel`}
                    </td>
                    <td className="mono">{v.odometer.toFixed(1)} km</td>
                    <td className="mono" style={{ color: "#58a6ff", fontWeight: 600 }}>
                      #{v.sample_seq ?? "—"}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {v.sample_timestamp ? new Date(v.sample_timestamp).toLocaleTimeString() : "—"}
                    </td>
                    <td>
                      {v.fault_code ? (
                        <span className="badge badge-fault">{v.fault_code}</span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>None</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
