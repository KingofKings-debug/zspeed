import { useState, useEffect, useCallback } from "react";
import { api, ApiError } from "../api";
import type { SupportedOem } from "../types";
import { useFleetOverview, vehicleStore } from "../store/vehicleStore";
import { subscribeToFleetEvents } from "../socket";

interface OverviewProps {
  onNavigate: (view: string) => void;
  onImport: () => void;
}

interface SectionState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

function sectionInit<T>(): SectionState<T> {
  return { data: null, loading: true, error: null };
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="alert alert-error" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <span>{message}</span>
      <button className="btn btn-secondary btn-sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

export default function Overview({ onNavigate, onImport }: OverviewProps) {
  const storeStats = useFleetOverview();

  const [vehicles, setVehicles] = useState<SectionState<any[]>>(sectionInit());
  const [oems, setOems] = useState<SectionState<SupportedOem[]>>(sectionInit());
  const [insights, setInsights] = useState<SectionState<any>>(sectionInit());
  const [drilldown, setDrilldown] = useState<{ category: string; title: string; count: number; vehicles: any[] } | null>(null);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<string | null>(null);

  const loadVehicles = useCallback(async (mountedRef?: { current: boolean }) => {
    setVehicles((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.getVehicles();
      if (mountedRef && !mountedRef.current) return;
      if (data?.vehicles) {
        vehicleStore.initializeFromSnapshot(data.vehicles);
      }
      setVehicles({ data: data?.vehicles ?? [], loading: false, error: null });
    } catch (err: any) {
      if (mountedRef && !mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) return;
      setVehicles({ data: null, loading: false, error: err.message || "Failed to load vehicles." });
    }
  }, []);

  const loadOems = useCallback(async (mountedRef?: { current: boolean }) => {
    setOems((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.getOems();
      if (mountedRef && !mountedRef.current) return;
      setOems({ data: data?.oems ?? [], loading: false, error: null });
    } catch (err: any) {
      if (mountedRef && !mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) return;
      setOems({ data: null, loading: false, error: err.message || "Failed to load OEM connections." });
    }
  }, []);

  const loadInsights = useCallback(async (mountedRef?: { current: boolean }) => {
    setInsights((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.getInsights();
      if (mountedRef && !mountedRef.current) return;
      setInsights({ data, loading: false, error: null });
    } catch (err: any) {
      if (mountedRef && !mountedRef.current) return;
      if (err instanceof ApiError && err.status === 401) return;
      setInsights({ data: null, loading: false, error: err.message || "Failed to load insights." });
    }
  }, []);

  useEffect(() => {
    const mountedRef = { current: true };
    loadVehicles(mountedRef);
    loadOems(mountedRef);
    loadInsights(mountedRef);
    return () => {
      mountedRef.current = false;
    };
  }, [loadVehicles, loadOems, loadInsights]);

  useEffect(() => {
    const unsubscribe = subscribeToFleetEvents((msg) => {
      if (msg.eventType === "fleet:insights") {
        setInsights({ data: msg.payload, loading: false, error: null });
      }
    });
    return () => unsubscribe();
  }, []);

  async function openDrilldown(category: string, title: string) {
    setDrilldownLoading(true);
    setDrilldownError(null);
    try {
      const res = await api.getInsightDrilldown(category);
      setDrilldown({ category, title, count: res.count, vehicles: res.vehicles || [] });
    } catch (err: any) {
      setDrilldownError(err.message || "Failed to load drill-down.");
    } finally {
      setDrilldownLoading(false);
    }
  }

  const needsSetup = (oems.data || []).filter((o) => o.needs_setup);
  const connected = (oems.data || []).filter((o) => o.has_active_connection);

  return (
    <div>
      <div className="section-header">
        <div>
          <h1 className="section-title">Fleet Overview</h1>
          <p className="section-subtitle">Vehicle onboarding and connection status</p>
        </div>
        <div className="flex gap-2">
          <button
            className="btn btn-secondary"
            onClick={() => {
              const a = document.createElement("a");
              a.href = "/api/sample-csv";
              a.download = "fleet-sample.csv";
              a.click();
            }}
          >
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
          <span className="stat-card-value" style={{ color: "var(--color-primary)" }}>
            {storeStats.moving}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-card-label">Idle / Parked</span>
          <span className="stat-card-value warning">{storeStats.idle + storeStats.parked}</span>
        </div>
      </div>

      {vehicles.error && (
        <div style={{ marginTop: 16 }}>
          <SectionError message={vehicles.error} onRetry={() => loadVehicles()} />
        </div>
      )}

      <div className="card mb-4 mt-4" style={{ marginTop: 24, marginBottom: 24 }}>
        <div className="card-header">
          <span className="card-header-title">Actionable Insights</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {insights.loading ? (
            <div className="loading-state" style={{ minHeight: 80 }}>
              <div className="spinner" />
              Loading insights…
            </div>
          ) : insights.error ? (
            <div style={{ padding: 16 }}>
              <SectionError message={insights.error} onRetry={() => loadInsights()} />
            </div>
          ) : insights.data ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                gap: 1,
                background: "var(--color-border-light)",
              }}
            >
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("service_needed", "Service Needed")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-error)", marginBottom: 4 }}>
                  Service Needed
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.data.service_needed}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Active diagnostic faults</div>
              </div>
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("safety_attention", "Safety Attention")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-warning)", marginBottom: 4 }}>
                  Safety Attention
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.data.safety_attention}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Recent harsh braking / speeding</div>
              </div>
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("charging_needed", "Charging Required")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-primary)", marginBottom: 4 }}>
                  Charging Required
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.data.charging_needed}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Battery below 20%</div>
              </div>
              <div
                style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }}
                onClick={() => openDrilldown("data_quality_issues", "Data Quality Issues")}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-warning)", marginBottom: 4 }}>
                  Data Quality
                </div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.data.data_quality_issues}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>
                  Vehicles with unresolved quarantine or stale data
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {drilldownLoading && (
        <div className="loading-state" style={{ minHeight: 60 }}>
          <div className="spinner" />
          Loading…
        </div>
      )}
      {drilldownError && (
        <div style={{ margin: "16px 0" }}>
          <SectionError message={drilldownError} onRetry={() => drilldown && openDrilldown(drilldown.category, drilldown.title)} />
        </div>
      )}

      {drilldown && (
        <div
          className="modal-backdrop"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div className="card" style={{ width: "90%", maxWidth: 650, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
            <div className="card-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="card-header-title">
                {drilldown.title} ({drilldown.count} affected)
              </span>
              <button className="btn btn-ghost btn-sm" onClick={() => setDrilldown(null)}>
                ✕
              </button>
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
              <button className="btn btn-secondary" onClick={() => setDrilldown(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {oems.loading ? null : oems.error ? (
        <div style={{ marginBottom: 16 }}>
          <SectionError message={oems.error} onRetry={() => loadOems()} />
        </div>
      ) : (
        <>
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
                        <span>
                          {oem.vehicle_count} vehicle{oem.vehicle_count !== 1 ? "s" : ""}
                        </span>
                        <span className="status-badge status-no-connection">
                          <span className="status-dot" />
                          Connection required
                        </span>
                      </div>
                    </div>
                    <div className="oem-card-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => onNavigate("connections")}>
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
                        <span>
                          {oem.vehicle_count} vehicle{oem.vehicle_count !== 1 ? "s" : ""}
                        </span>
                        {oem.connections
                          .filter((c) => c.status === "ACTIVE")
                          .map((c) => (
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
        </>
      )}

      {!vehicles.loading && vehicles.data !== null && vehicles.data.length === 0 && !vehicles.error && (
        <div className="card mb-4">
          <div className="card-body">
            <div className="empty-state-title">No vehicles yet</div>
            <p className="empty-state-text">Import a CSV or add vehicles individually to get started.</p>
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onImport}>
              Import vehicles
            </button>
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
