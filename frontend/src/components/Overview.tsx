import { useState, useEffect } from "react";
import { api } from "../api";
import type { SupportedOem } from "../types";
import { useFleetOverview, vehicleStore } from "../store/vehicleStore";

interface OverviewProps {
  onNavigate: (view: string) => void;
  onImport: () => void;
}

export default function Overview({ onNavigate, onImport }: OverviewProps) {
  const storeStats = useFleetOverview();
  const [oems, setOems] = useState<SupportedOem[]>([]);
  const [insights, setInsights] = useState<any>(null);
  const [loading, setLoading] = useState(true);

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
  }, []);

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
              <div style={{ background: "var(--color-bg-primary)", padding: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-error)", marginBottom: 4 }}>Service Needed</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.service_needed}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Active diagnostic faults</div>
              </div>
              <div style={{ background: "var(--color-bg-primary)", padding: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-warning)", marginBottom: 4 }}>Safety Attention</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.safety_attention}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Recent harsh braking / speeding</div>
              </div>
              <div style={{ background: "var(--color-bg-primary)", padding: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-primary)", marginBottom: 4 }}>Charging Required</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.charging_needed}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Battery below 20%</div>
              </div>
              <div style={{ background: "var(--color-bg-primary)", padding: 16, cursor: "pointer" }} onClick={() => onNavigate("issues")}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-warning)", marginBottom: 4 }}>Data Quality</div>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{insights.data_quality_issues}</div>
                <div style={{ fontSize: 11, color: "var(--color-text-secondary)" }}>Vehicles with unresolved quarantine</div>
              </div>
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
                    Set up connection
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
