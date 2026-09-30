import { useState, useEffect } from "react";
import { api } from "../api";
import type { SupportedOem } from "../types";
import { useFleetOverview, vehicleStore } from "../store/vehicleStore";
import { subscribeToFleetEvents } from "../socket";

interface OverviewProps {
  onNavigate: (view: string) => void;
  onImport: () => void;
}

export default function Overview({ onNavigate, onImport }: OverviewProps) {
  const storeStats = useFleetOverview();
  const [oems, setOems] = useState<SupportedOem[]>([]);
  const [insights, setInsights] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [drilldown, setDrilldown] = useState<{ category: string; title: string; count: number; vehicles: any[] } | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [vehiclesData, oemsData, insightsData] = await Promise.all([
          api.getVehicles(),
          api.getOems(),
          api.getInsights(),
        ]);
        if (vehiclesData?.vehicles) {
          vehicleStore.initializeFromSnapshot(vehiclesData.vehicles);
        }
        setOems(oemsData.oems || []);
        setInsights(insightsData);
      } catch (err) {
        console.error("Failed to load overview:", err);
      } finally {
        setLoading(false);
      }
    }
    load();

    const unsubscribe = subscribeToFleetEvents((msg) => {
      if (msg.eventType === "fleet:insights") {
        setInsights(msg.payload);
      }
    });
    return () => unsubscribe();
  }, []);

  async function openDrilldown(category: string, title: string) {
    try {
      const res = await api.getInsightDrilldown(category);
      setDrilldown({ category, title, count: res.count, vehicles: res.vehicles || [] });
    } catch (err) {
      console.error(err);
    }
  }

  if (loading && storeStats.total === 0) {
    return (
      <div className="loading-state">
        <div className="spinner spinner-lg" />
        Loading fleet data...
      </div>
    );
  }

  const needsSetup = oems.filter((o) => o.needs_setup);
  const connected = oems.filter((o) => o.has_active_connection);

  return (
    <div>
      <div className="section-header">
        <div>
          <h1 className="section-title">Fleet Overview</h1>
          <p className="section-subtitle">Vehicle onboarding and connection status</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={() => {
            const a = document.createElement("a");
            a.href = "/api/sample-csv";
            a.download = "fleet-sample.csv";
            a.click();
          }}>
            Download sample CSV
          </button>
          <button className="btn btn-primary" onClick={onImport}>
            Import vehicles
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-card-label">Total vehicles</span>
          <span className="stat-card-value">{storeStats.total}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Receiving data</span>
          <span className="stat-card-value success">{storeStats.receiving}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Moving</span>
          <span className="stat-card-value" style={{ color: "var(--color-primary)" }}>{storeStats.moving}</span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Idle / Parked</span>
          <span className="stat-card-value warning">{storeStats.idle + storeStats.parked}</span>
        </div>
      </div>

      {insights && (
        <div className="card mb-4 mt-4" style={{ marginTop: 24, marginBottom: 24 }}>
          <div className="card-header">
            <span className="card-header-title">Actionable Insights</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 1, background: "var(--color-border-light)" }}>
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("service_needed", "Service Needed")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-error)", marginBottom: 4 }}>Service Needed</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.service_needed}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Active diagnostic faults</div>
              </div>
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("safety_attention", "Safety Attention")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-warning)", marginBottom: 4 }}>Safety Attention</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.safety_attention}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Recent harsh braking / speeding</div>
              </div>
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("charging_needed", "Charging Required")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-primary)", marginBottom: 4 }}>Charging Required</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.charging_needed}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Battery below 20%</div>
              </div>
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("data_quality_issues", "Data Quality Issues")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-warning)", marginBottom: 4 }}>Data Quality</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.data_quality_issues}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Vehicles with unresolved quarantine or stale data</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {drilldown && (
        <div className="modal-backdrop" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div className="card" style={{ width: "90%", maxWidth: 650, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
            <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="card-header-title">{drilldown.title} ({drilldown.count} affected)</span>
              <button className="btn btn-ghost btn-sm" onClick={() => setDrilldown(null)}>✕</button>
            </div>
            <div className="card-body" style={{ overflowY: "auto", flex: 1 }}>
              {drilldown.vehicles.length === 0 ? (
                <div style={{ textAlign: "center", padding: 24, color: "var(--color-text-secondary)" }}>
                  No vehicles currently affected.
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--color-border-light)", textAlign: "left" }}>
                      <th style={{ padding: "8px 12px" }}>Vehicle</th>
                      <th style={{ padding: "8px 12px" }}>VIN</th>
                      <th style={{ padding: "8px 12px" }}>Detail / Status</th>
                      <th style={{ padding: "8px 12px" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drilldown.vehicles.map((v) => (
                      <tr key={v.vehicle_id} style={{ borderBottom: "1px solid var(--color-border-light)" }}>
                        <td style={{ padding: "8px 12px", fontWeight: 600 }}>{v.label}</td>
                        <td style={{ padding: "8px 12px", fontFamily: "monospace" }}>{v.vin}</td>
                        <td style={{ padding: "8px 12px" }}>{v.metric_value || v.status || "Attention required"}</td>
                        <td style={{ padding: "8px 12px" }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => {
                              setDrilldown(null);
                              onNavigate(drilldown.category === "data_quality_issues" ? "issues" : "vehicles");
                            }}
                          >
                            View
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ padding: 16, borderTop: "1px solid var(--color-border-light)", display: "flex", justifyContent: "flex-end" }}>
              <button className="btn btn-secondary" onClick={() => setDrilldown(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {needsSetup.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">
            <span className="card-header-title">OEMs requiring connection</span>
          </div>
          <div className="card-body">
            {needsSetup.map((oem) => (
              <div key={oem.id} className="oem-card" style={{ border: "none", padding: "12px 0" }}>
                <div className="oem-card-info">
                  <div className="oem-card-name">{oem.name}</div>
                  <div className="oem-card-meta">
                    <span>{oem.vehicle_count} vehicle{oem.vehicle_count !== 1 ? "s" : ""}</span>
                    <span className="status-badge status-no-connection">
                      <span className="status-dot" />
                      Connection required
                    </span>
                  </div>
                </div>
                <div className="oem-card-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onNavigate("connections")}
                  >
                    Connect OEM
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {connected.length > 0 && (
        <div className="card mb-4">
          <div className="card-header">
            <span className="card-header-title">Active connections</span>
            <button className="btn btn-ghost btn-sm" onClick={() => onNavigate("connections")}>
              View all
            </button>
          </div>
          <div className="card-body">
            {connected.map((oem) => (
              <div key={oem.id} className="oem-card" style={{ border: "none", padding: "12px 0" }}>
                <div className="oem-card-info">
                  <div className="oem-card-name">{oem.name}</div>
                  <div className="oem-card-meta">
                    <span>{oem.vehicle_count} vehicle{oem.vehicle_count !== 1 ? "s" : ""}</span>
                    {oem.connections.filter((c) => c.status === "ACTIVE").map((c) => (
                      <span key={c.id} className="status-badge status-active">
                        <span className="status-dot" />
                        Account connected
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-header-title">Quick actions</span>
        </div>
        <div className="card-body" style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button className="btn btn-secondary" onClick={onImport}>
            Import vehicles from CSV
          </button>
          <button className="btn btn-secondary" onClick={() => onNavigate("vehicles")}>
            View vehicle list
          </button>
          <button className="btn btn-secondary" onClick={() => onNavigate("connections")}>
            Manage OEM connections
          </button>
        </div>
      </div>
    </div>
  );
}
