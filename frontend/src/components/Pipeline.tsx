import { useState, useEffect, useCallback } from "react";
import { api, authedFetch, ApiError } from "../api";
import type { PipelineHealth, RawEvent, MappingProfile } from "../types";
import { subscribeToFleetEvents } from "../socket";

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

export default function Pipeline() {
  const [health, setHealth] = useState<SectionState<PipelineHealth>>(sectionInit());
  const [quarantined, setQuarantined] = useState<SectionState<RawEvent[]>>(sectionInit());
  const [profiles, setProfiles] = useState<SectionState<MappingProfile[]>>(sectionInit());
  const [activeTab, setActiveTab] = useState<"health" | "quarantine" | "mappings">("health");
  const [replayError, setReplayError] = useState<string | null>(null);

  const loadHealth = useCallback(async () => {
    setHealth((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await authedFetch("/api/ingestion/pipeline-health");
      if (!res.ok) throw new ApiError(res.status, "server_error", `Failed to load health: ${res.status}`);
      const data = await res.json();
      setHealth({ data, loading: false, error: null });
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) return;
      setHealth({ data: null, loading: false, error: err.message || "Failed to load pipeline health." });
    }
  }, []);

  const loadQuarantine = useCallback(async () => {
    setQuarantined((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await authedFetch("/api/ingestion/quarantine");
      if (!res.ok) throw new ApiError(res.status, "server_error", `Failed to load quarantine: ${res.status}`);
      const data = await res.json();
      setQuarantined({ data: data.events || [], loading: false, error: null });
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) return;
      setQuarantined({ data: null, loading: false, error: err.message || "Failed to load quarantined events." });
    }
  }, []);

  const loadMappings = useCallback(async () => {
    setProfiles((s) => ({ ...s, loading: true, error: null }));
    try {
      const res = await authedFetch("/api/ingestion/mappings");
      if (!res.ok) throw new ApiError(res.status, "server_error", `Failed to load mappings: ${res.status}`);
      const data = await res.json();
      setProfiles({ data: data.profiles || [], loading: false, error: null });
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) return;
      setProfiles({ data: null, loading: false, error: err.message || "Failed to load mapping profiles." });
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadQuarantine();
    loadMappings();
    const unsubscribe = subscribeToFleetEvents((msg) => {
      if (
        msg.eventType === "quarantine:count" ||
        msg.eventType === "connection:health" ||
        msg.eventType === "pipeline:health"
      ) {
        loadHealth();
        loadQuarantine();
        loadMappings();
      }
    });
    return () => unsubscribe();
  }, [loadHealth, loadQuarantine, loadMappings]);

  async function handleReplay(profileId: string) {
    setReplayError(null);
    try {
      const res = await authedFetch("/api/ingestion/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping_profile_id: profileId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(data.message || `Replay failed: ${res.status}`);
      }
      loadQuarantine();
    } catch (err: any) {
      setReplayError(err.message || "Failed to start replay.");
    }
  }

  return (
    <div>
      <div className="section-header">
        <div>
          <h1 className="section-title">Data Pipeline</h1>
          <p className="section-subtitle">Manage ingestion health, quarantines, and mapping profiles</p>
        </div>
      </div>

      {replayError && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          {replayError}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 12 }} onClick={() => setReplayError(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "16px",
          marginBottom: "24px",
          borderBottom: "1px solid var(--color-border-light)",
          paddingBottom: "12px",
        }}
      >
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
          Quarantine ({quarantined.data?.length ?? "…"})
        </button>
        <button
          className={`btn ${activeTab === "mappings" ? "btn-secondary" : "btn-ghost"}`}
          onClick={() => setActiveTab("mappings")}
        >
          Mapping Profiles
        </button>
      </div>

      {activeTab === "health" && (
        <>
          {health.loading ? (
            <div className="loading-state">
              <div className="spinner spinner-lg" />
              Loading pipeline health…
            </div>
          ) : health.error ? (
            <SectionError message={health.error} onRetry={loadHealth} />
          ) : health.data ? (
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-card-label">Total Events Processed</div>
                <div className="stat-card-value text-primary">{health.data.processed}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Quarantined (Action Req)</div>
                <div className="stat-card-value text-warning">{health.data.quarantined}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Duplicate Events</div>
                <div className="stat-card-value text-muted">{health.data.duplicates}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Total Received</div>
                <div className="stat-card-value">{health.data.total_events}</div>
              </div>
            </div>
          ) : null}
        </>
      )}

      {activeTab === "quarantine" && (
        <>
          {quarantined.loading ? (
            <div className="loading-state">
              <div className="spinner spinner-lg" />
              Loading quarantined events…
            </div>
          ) : quarantined.error ? (
            <SectionError message={quarantined.error} onRetry={loadQuarantine} />
          ) : (
            <>
              <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px" }}>Quarantined Events</h2>
              {(quarantined.data?.length ?? 0) === 0 ? (
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
                    {quarantined.data!.map((q) => (
                      <tr key={q.id}>
                        <td>{new Date(q.recorded_at).toLocaleString()}</td>
                        <td className="mono">{q.source_vehicle_id}</td>
                        <td>
                          <span className="status-badge status-authorising">{q.processing_status}</span>
                        </td>
                        <td
                          className="mono"
                          style={{
                            fontSize: "11px",
                            maxWidth: "300px",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {q.payload}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}

      {activeTab === "mappings" && (
        <>
          {profiles.loading ? (
            <div className="loading-state">
              <div className="spinner spinner-lg" />
              Loading mapping profiles…
            </div>
          ) : profiles.error ? (
            <SectionError message={profiles.error} onRetry={loadMappings} />
          ) : (
            <>
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
                  {(profiles.data || []).map((p) => (
                    <tr key={p.id}>
                      <td className="mono">{p.id}</td>
                      <td>{p.mapping_version}</td>
                      <td>
                        <span
                          className={`status-badge ${
                            p.status === "ACTIVE"
                              ? "status-active"
                              : p.status === "RETIRED"
                              ? "status-error"
                              : "status-authorising"
                          }`}
                        >
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
            </>
          )}
        </>
      )}
    </div>
  );
}
