import { useState, useEffect } from "react";
import { api } from "../api";
import type { PipelineHealth, RawEvent, MappingProfile } from "../types";
import { subscribeToFleetEvents } from "../socket";

export default function Pipeline() {
  const [health, setHealth] = useState<PipelineHealth | null>(null);
  const [quarantined, setQuarantined] = useState<RawEvent[]>([]);
  const [profiles, setProfiles] = useState<MappingProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"health" | "quarantine" | "mappings">("health");

  async function loadData() {
    try {
      const [healthRes, quarRes, mapRes] = await Promise.all([
        fetch("/api/ingestion/pipeline-health").then(res => res.json()),
        fetch("/api/ingestion/quarantine").then(res => res.json()),
        fetch("/api/ingestion/mappings").then(res => res.json())
      ]);
      setHealth(healthRes);
      setQuarantined(quarRes.events || []);
      setProfiles(mapRes.profiles || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
    const unsubscribe = subscribeToFleetEvents((msg) => {
      if (
        msg.eventType === "quarantine:count" ||
        msg.eventType === "connection:health" ||
        msg.eventType === "pipeline:health"
      ) {
        loadData();
      }
    });
    return () => unsubscribe();
  }, []);

  async function handleReplay(profileId: string) {
    try {
      await fetch("/api/ingestion/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping_profile_id: profileId })
      });
      alert("Replay job started!");
      loadData();
    } catch (err) {
      alert("Failed to start replay");
    }
  }

  if (loading && !health) {
    return <div className="p-8">Loading pipeline data...</div>;
  }

  return (
    <div>
      <div className="section-header">
        <div>
          <h1 className="section-title">Data Pipeline</h1>
          <p className="section-subtitle">Manage ingestion health, quarantines, and mapping profiles</p>
        </div>
      </div>

      <div style={{ display: "flex", gap: "16px", marginBottom: "24px", borderBottom: "1px solid var(--color-border-light)", paddingBottom: "12px" }}>
        <button 
          className={`btn ${activeTab === "health" ? "btn-secondary" : "btn-ghost"}`}
          onClick={() => setActiveTab("health")}
        >
          Health Overview
        </button>
        <button 
          className={`btn ${activeTab === "quarantine" ? "btn-secondary" : "btn-ghost"}`}
          onClick={() => setActiveTab("quarantine")}
        >
          Quarantine ({quarantined.length})
        </button>
        <button 
          className={`btn ${activeTab === "mappings" ? "btn-secondary" : "btn-ghost"}`}
          onClick={() => setActiveTab("mappings")}
        >
          Mapping Profiles
        </button>
      </div>

      {activeTab === "health" && health && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-card-label">Total Events Processed</div>
            <div className="stat-card-value text-primary">{health.processed}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Quarantined (Action Req)</div>
            <div className="stat-card-value text-warning">{health.quarantined}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Duplicate Events</div>
            <div className="stat-card-value text-muted">{health.duplicates}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Total Received</div>
            <div className="stat-card-value">{health.total_events}</div>
          </div>
        </div>
      )}

      {activeTab === "quarantine" && (
        <div>
          <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px" }}>Quarantined Events</h2>
          {quarantined.length === 0 ? (
            <div className="alert alert-success">No events currently quarantined.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Vehicle ID</th>
                  <th>Status</th>
                  <th>Raw Payload</th>
                </tr>
              </thead>
              <tbody>
                {quarantined.map(q => (
                  <tr key={q.id}>
                    <td>{new Date(q.recorded_at).toLocaleString()}</td>
                    <td className="mono">{q.source_vehicle_id}</td>
                    <td><span className="status-badge status-authorising">{q.processing_status}</span></td>
                    <td className="mono" style={{ fontSize: "11px", maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {q.payload}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === "mappings" && (
        <div>
          <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px" }}>Mapping Profiles</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Profile ID</th>
                <th>Version</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td>{p.mapping_version}</td>
                  <td>
                    <span className={`status-badge ${p.status === "ACTIVE" ? "status-active" : p.status === "RETIRED" ? "status-error" : "status-authorising"}`}>
                      {p.status}
                    </span>
                  </td>
                  <td>
                    {p.status === "ACTIVE" && (
                      <button className="btn btn-sm btn-secondary" onClick={() => handleReplay(p.id)}>
                        Replay Quarantined Events
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
