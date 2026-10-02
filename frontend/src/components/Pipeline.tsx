import { useState, useEffect, useCallback, useRef } from "react";
import { api, authedFetch, ApiError } from "../api";
import type { PipelineHealth, RawEvent, MappingProfile } from "../types";
import { subscribeToFleetEvents } from "../socket";
import MappingRepair from "./MappingRepair";
import { createBackgroundRefresh } from '../background-refresh';

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

export default function Pipeline({ onConnections }: { onConnections?: () => void }) {
  const [health, setHealth] = useState<SectionState<PipelineHealth>>(sectionInit());
  const [quarantined, setQuarantined] = useState<SectionState<RawEvent[]>>(sectionInit());
  const [profiles, setProfiles] = useState<SectionState<MappingProfile[]>>(sectionInit());
  const [activeTab, setActiveTab] = useState<"health" | "quarantine" | "mappings">("health");
  const [replayError, setReplayError] = useState<string | null>(null);
  const [repairIncidentId, setRepairIncidentId] = useState<string | null>(null);
  const [repairIssues, setRepairIssues] = useState<any[]>([]);
  const refreshers=useRef<Record<string,ReturnType<typeof createBackgroundRefresh<any>>>>({});

  const loadHealth = useCallback(async () => {
    setHealth(s=>({...s,loading:s.data===null}));
    await refreshers.current.health?.refresh();
  }, []);

  const loadQuarantine = useCallback(async () => {
    setQuarantined(s=>({...s,loading:s.data===null}));
    await refreshers.current.quarantine?.refresh();
  }, []);

  const loadMappings = useCallback(async () => {
    setProfiles(s=>({...s,loading:s.data===null}));
    await refreshers.current.mappings?.refresh();
  }, []);

  useEffect(() => {
    let active=true;
    const get=async(path:string)=>{
      const response=await authedFetch(path);
      if(!response.ok)throw new ApiError(response.status,'server_error','Updates are temporarily unavailable.');
      return response.json();
    };
    refreshers.current={
      health:createBackgroundRefresh(()=>get('/api/ingestion/pipeline-health'),data=>setHealth({data,loading:false,error:null}),()=>setHealth(s=>({...s,loading:false,error:'Status updates are delayed. Your last figures remain available.'}))),
      quarantine:createBackgroundRefresh(()=>get('/api/ingestion/quarantine'),data=>setQuarantined({data:data.events||[],loading:false,error:null}),()=>setQuarantined(s=>({...s,loading:false,error:'Record updates are delayed. Your last results remain available.'}))),
      mappings:createBackgroundRefresh(()=>get('/api/ingestion/mappings'),data=>setProfiles({data:data.profiles||[],loading:false,error:null}),()=>setProfiles(s=>({...s,loading:false,error:'Mapping updates are delayed. Your last profiles remain available.'}))),
    };
    loadHealth();
    loadQuarantine();
    loadMappings();
    api.getQuarantineIncidents().then(result => {if(active)setRepairIssues(result.incidents.filter(incident => incident.status !== "RESOLVED"));}).catch(() => {});
    let refreshTimer:ReturnType<typeof setTimeout>|undefined;
    const unsubscribe = subscribeToFleetEvents((msg) => {
      if (
        msg.eventType === "quarantine:count" ||
        msg.eventType === "connection:health" ||
        msg.eventType === "pipeline:health"
      ) {
        if(!refreshTimer) refreshTimer=setTimeout(()=>{refreshTimer=undefined;loadHealth();loadQuarantine();},750);
      }
    });
    return () => {active=false;unsubscribe();clearTimeout(refreshTimer);Object.values(refreshers.current).forEach(task=>task.dispose());};
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
          <p className="section-subtitle">Monitor incoming vehicle data, review held records and manage OEM mappings.</p>
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
          {health.error && <SectionError message={health.error} onRetry={loadHealth} />}
          {health.loading && !health.data ? (
            <div className="loading-state">
              <div className="spinner spinner-lg" />
              Loading pipeline health…
            </div>
          ) : health.data ? (
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-card-label">Total Events Processed</div>
                <div className="stat-card-value text-primary">{health.data.processed}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card-label">Records requiring review</div>
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
          {quarantined.error && <SectionError message={quarantined.error} onRetry={loadQuarantine} />}
          {quarantined.loading && !quarantined.data ? (
            <div className="loading-state">
              <div className="spinner spinner-lg" />
              Loading quarantined events…
            </div>
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
          {profiles.error && <SectionError message={profiles.error} onRetry={loadMappings} />}
          {profiles.loading && !profiles.data ? (
            <div className="loading-state">
              <div className="spinner spinner-lg" />
              Loading mapping profiles…
            </div>
          ) : (
            <>
              <h2 style={{ fontSize: "16px", fontWeight: 600, marginBottom: "16px" }}>Mapping Profiles</h2>
              <div className="card" style={{ padding: 16, marginBottom: 20 }}><h3>Restore vehicle readings</h3><p className="text-muted">Choose the issue you want to fix.</p>{repairIssues.length ? <select className="input-field" aria-label="Issue to repair" value="" onChange={event => setRepairIncidentId(event.target.value || null)}><option value="">Choose a data issue…</option>{repairIssues.map(incident => <option key={incident.id} value={incident.id}>{incident.oem_name} · {incident.title} · {incident.unresolved_event_count} events</option>)}</select> : <p>No active issues. Open Data Issues after an OEM format changes.</p>}</div>
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
                        {p.status === "ACTIVE" && !(p as any).repair_connection_id && (
                          <button className="btn btn-sm btn-secondary" onClick={() => handleReplay(p.id)}>
                            Replay Quarantined Events
                          </button>
                        )}
                        {(p as any).repair_connection_id && <span className="text-muted">Connection-specific repair · use the workbench</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
      {repairIncidentId && <MappingRepair incidentId={repairIncidentId} onClose={() => { setRepairIncidentId(null); loadMappings(); loadQuarantine(); }} onComplete={() => { loadMappings(); loadQuarantine(); loadHealth(); }} onConnections={onConnections} />}
    </div>
  );
}
