import { useState, useEffect } from "react";
import { api } from "../api";
import type { VehicleStats, SupportedOem } from "../types";

interface OverviewProps {
  onNavigate: (view: string) => void;
  onImport: () => void;
}

export default function Overview({ onNavigate, onImport }: OverviewProps) {
  const [stats, setStats] = useState<VehicleStats | null>(null);
  const [oems, setOems] = useState<SupportedOem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [statsData, oemsData] = await Promise.all([
          api.getStats(),
          api.getOems(),
        ]);
        setStats(statsData);
        setOems(oemsData.oems);
      } catch (err) {
        console.error("Failed to load overview:", err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
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

      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <span className="stat-card-label">Total vehicles</span>
            <span className="stat-card-value">{stats.total}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card-label">Receiving data</span>
            <span className="stat-card-value success">{stats.receiving}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card-label">Connection required</span>
            <span className="stat-card-value warning">{stats.no_connection}</span>
          </div>
          <div className="stat-card">
            <span className="stat-card-label">Attention needed</span>
            <span className="stat-card-value error">{stats.attention}</span>
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
