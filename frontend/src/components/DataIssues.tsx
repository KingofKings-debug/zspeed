import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { QuarantineIncident, QuarantineStatus, FailureCategory } from "../types";
import MappingRepair from "./MappingRepair";

interface Props {
  onViewVehicle?: (vehicleId: string) => void;
}

const CATEGORY_LABELS: Record<FailureCategory, string> = {
  SCHEMA_CHANGE: "Format change",
  INVALID_VALUE: "Invalid sensor data",
  MISSING_VEHICLE_MAPPING: "Unregistered vehicle",
  EXPIRED_AUTH: "Expired authorisation",
  INFRA_ERROR: "Infrastructure error",
  UNSUPPORTED_OEM: "Unsupported OEM",
  UNKNOWN_FORMAT: "Unknown format",
  INVALID_COORDINATES: "Invalid GPS coordinates",
  INVALID_TIME: "Invalid timestamp",
  TYPE_ERROR: "Changed value type",
  IDEMPOTENCY_CONFLICT: "Conflicting event identity",
};

const STATUS_CONFIG: Record<QuarantineStatus, { label: string; cls: string }> = {
  UNRESOLVED: { label: "Unresolved", cls: "status-error" },
  MAPPING_READY: { label: "Mapping ready", cls: "status-authorising" },
  REPLAYING: { label: "Replaying…", cls: "status-verifying" },
  RESOLVED: { label: "Resolved", cls: "status-active" },
  REPLAY_FAILED: { label: "Replay failed", cls: "status-degraded" },
};

function formatDate(d: string | null): string {
  if (!d) return "–";
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function StaleProjectionTags({ projections }: { projections: any }) {
  let list: string[] = [];
  if (Array.isArray(projections)) list = projections;
  else if (typeof projections === "string") {
    try { list = JSON.parse(projections); } catch {}
  }
  if (!list.length) return null;
  return (
    <div className="stale-tags">
      {list.map((p) => (
        <span key={p} className="stale-tag">{p}</span>
      ))}
    </div>
  );
}

function IncidentActionButton({
  incident,
  onAcknowledge,
  onReconnect,
  onRetry,
}: {
  incident: QuarantineIncident;
  onAcknowledge: () => void;
  onReconnect: () => void;
  onRetry: () => void;
}) {
  if (incident.status === "MAPPING_READY" || incident.status === "REPLAY_FAILED") {
    return (
      <button className="btn btn-primary btn-sm" onClick={onRetry}>
        Retry replay
      </button>
    );
  }
  if (incident.failure_category === "EXPIRED_AUTH" && incident.status === "UNRESOLVED") {
    return (
      <button className="btn btn-secondary btn-sm" onClick={onReconnect}>
        Reconnect account
      </button>
    );
  }
  if (!incident.acknowledged_at && incident.status === "UNRESOLVED") {
    return (
      <button className="btn btn-secondary btn-sm" onClick={onAcknowledge}>
        Acknowledge
      </button>
    );
  }
  if (incident.acknowledged_at) {
    return <span className="text-muted" style={{ fontSize: 12 }}>Acknowledged</span>;
  }
  return null;
}

function IncidentRow({
  incident,
  onSelect,
  onAcknowledge,
  onReconnect,
  onRetry,
}: {
  incident: QuarantineIncident;
  onSelect: () => void;
  onAcknowledge: () => void;
  onReconnect: () => void;
  onRetry: () => void;
}) {
  const statusCfg = STATUS_CONFIG[incident.status] || { label: incident.status, cls: "" };
  return (
    <tr className="incident-row" onClick={onSelect} style={{ cursor: "pointer" }}>
      <td>
        <div className="incident-title">{incident.title}</div>
        <div className="incident-category text-muted">{CATEGORY_LABELS[incident.failure_category]}</div>
      </td>
      <td>{incident.oem_name || incident.oem_id || "–"}</td>
      <td className="mono">{incident.affected_vehicle_count}</td>
      <td className="mono">{incident.unresolved_event_count}</td>
      <td>
        <StaleProjectionTags projections={incident.stale_projections} />
      </td>
      <td className="mono" style={{ whiteSpace: "nowrap" }}>{formatDate(incident.first_failure_at)}</td>
      <td className="mono" style={{ whiteSpace: "nowrap" }}>{formatDate(incident.latest_at)}</td>
      <td>
        <span className={`status-badge ${statusCfg.cls}`}>
          <span className="status-dot" />
          {statusCfg.label}
        </span>
      </td>
      <td onClick={(e) => e.stopPropagation()}>
        <IncidentActionButton
          incident={incident}
          onAcknowledge={onAcknowledge}
          onReconnect={onReconnect}
          onRetry={onRetry}
        />
      </td>
    </tr>
  );
}

function IncidentDetailPanel({
  incident,
  onClose,
  onViewVehicle,
  onRepair,
}: {
  incident: QuarantineIncident;
  onClose: () => void;
  onViewVehicle?: (id: string) => void;
  onRepair: () => void;
}) {
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailError, setDetailError] = useState("");

  useEffect(() => {
    setLoading(true);
    setDetailError("");
    api.getIncidentVehicles(incident.id)
      .then((r) => setVehicles(r.vehicles || []))
      .catch((error) => setDetailError(error.message))
      .finally(() => setLoading(false));
  }, [incident.id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">Data issue detail</span>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ maxHeight: "70vh", overflowY: "auto" }}>
          <div className="incident-detail-header">
            {detailError && <div className="alert alert-error">Affected vehicles could not be loaded: {detailError}</div>}
            <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>{incident.title}</h3>
            <div className="text-muted" style={{ fontSize: 13, marginBottom: 16 }}>
              {incident.description}
            </div>
          </div>

          <div className="detail-grid">
            <div className="detail-item">
              <strong>Category</strong>
              <span>{CATEGORY_LABELS[incident.failure_category]}</span>
            </div>
            <div className="detail-item">
              <strong>OEM</strong>
              <span>{incident.oem_name || "–"}</span>
            </div>
            <div className="detail-item">
              <strong>Unresolved events</strong>
              <span>{incident.unresolved_event_count}</span>
            </div>
            <div className="detail-item">
              <strong>First seen</strong>
              <span>{formatDate(incident.first_failure_at)}</span>
            </div>
            <div className="detail-item">
              <strong>Last seen</strong>
              <span>{formatDate(incident.latest_at)}</span>
            </div>
            <div className="detail-item">
              <strong>Last valid data</strong>
              <span>{formatDate(incident.last_valid_data_at)}</span>
            </div>
          </div>

          {incident.failure_category === "SCHEMA_CHANGE" && (
            <div className="alert alert-warning" style={{ marginTop: 16 }}>
              <span>📋</span>
              <div>
                The OEM has changed its data format. Use the mapping workbench to inspect examples, test updated fields, and recover valid saved events.
              </div>
            </div>
          )}

          {incident.failure_category === "EXPIRED_AUTH" && (
            <div className="alert alert-info" style={{ marginTop: 16 }}>
              <span>🔑</span>
              <div>
                The connection authorisation has expired. You can reconnect the account from the Connections page.
              </div>
            </div>
          )}

          {incident.failure_category === "MISSING_VEHICLE_MAPPING" && (
            <div className="alert alert-info" style={{ marginTop: 16 }}>
              <span>🚗</span>
              <div>
                The OEM is reporting vehicles that are not registered in your fleet. Add the vehicles through the Connections setup.
              </div>
            </div>
          )}

          <div style={{ marginTop: 20 }}>
            <div className="card-header-title" style={{ marginBottom: 10 }}>Affected vehicles ({vehicles.length})</div>
            {loading ? (
              <div className="loading-state"><div className="spinner" /></div>
            ) : vehicles.length === 0 ? (
              <div className="text-muted" style={{ fontSize: 13 }}>No vehicles identified.</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>VIN</th>
                    <th>Quarantined events</th>
                    <th>Last failure</th>
                    <th>Last valid data</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {vehicles.map((v) => (
                    <tr key={v.id}>
                      <td>{v.label || v.vin}</td>
                      <td className="mono">{v.vin}</td>
                      <td className="mono">{v.quarantined_count}</td>
                      <td className="mono">{formatDate(v.last_failure_at)}</td>
                      <td className="mono">{formatDate(v.last_valid_data_at)}</td>
                      <td>
                        {onViewVehicle && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => { onViewVehicle(v.id); onClose(); }}
                          >
                            View →
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="modal-footer">
          {incident.connection_id && incident.status !== "RESOLVED" && <button className="btn btn-primary" onClick={onRepair}>Repair mapping & recover events</button>}
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function DataIssues({ onViewVehicle }: Props) {
  const [incidents, setIncidents] = useState<QuarantineIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("UNRESOLVED");
  const [selectedIncident, setSelectedIncident] = useState<QuarantineIncident | null>(null);
  const [repairIncidentId, setRepairIncidentId] = useState<string | null>(null);
  const [summary, setSummary] = useState<any>(null);

  const loadIncidents = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([
      api.getQuarantineIncidents(statusFilter || undefined),
      api.getQuarantineSummary(),
    ])
      .then(([incRes, sumRes]) => {
        setIncidents(incRes.incidents || []);
        setSummary(sumRes);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [statusFilter]);

  useEffect(() => { loadIncidents(); }, [loadIncidents]);

  const handleAcknowledge = async (id: string) => {
    await api.acknowledgeIncident(id);
    loadIncidents();
  };

  const handleReconnect = async (incident: QuarantineIncident) => {
    if (incident.connection_id) {
      try {
        await api.reconnectConnection(incident.connection_id);
        loadIncidents();
      } catch (e: any) {
        alert(`Reconnect failed: ${e.message}`);
      }
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await api.retryIncident(id);
      loadIncidents();
    } catch (e: any) {
      alert(`Retry failed: ${e.message}`);
    }
  };

  return (
    <div>
      <div className="section-header">
        <div>
          <div className="section-title">Data Issues</div>
          <div className="section-subtitle">Data quality issues affecting vehicle projections</div>
          <p className="text-muted">Open an issue to inspect OEM examples and repair changed fields before recovering historical data.</p>
        </div>
      </div>

      {summary && (
        <div className="stats-grid" style={{ marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-card-label">Unresolved</div>
            <div className={`stat-card-value ${(summary.unresolved || 0) > 0 ? "error" : "success"}`}>
              {summary.unresolved || 0}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Affected Vehicles</div>
            <div className="stat-card-value warning">{summary.total_affected_vehicles || 0}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Quarantined Events</div>
            <div className="stat-card-value">{summary.total_unresolved_events || 0}</div>
          </div>
          <div className="stat-card">
            <div className="stat-card-label">Mapping Ready</div>
            <div className="stat-card-value">{summary.mapping_ready || 0}</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-header-title">Active issues</span>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              className="input-field"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              style={{ width: "auto" }}
            >
              <option value="">All statuses</option>
              <option value="UNRESOLVED">Unresolved</option>
              <option value="MAPPING_READY">Mapping ready</option>
              <option value="REPLAYING">Replaying</option>
              <option value="RESOLVED">Resolved</option>
              <option value="REPLAY_FAILED">Replay failed</option>
            </select>
            <button className="btn btn-secondary btn-sm" onClick={loadIncidents}>Refresh</button>
          </div>
        </div>

        {loading ? (
          <div className="loading-state"><div className="spinner spinner-lg" /></div>
        ) : error ? (
          <div className="alert alert-error" style={{ margin: 16 }}>{error}</div>
        ) : incidents.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">No issues found</div>
            <div className="empty-state-text">
              {(summary?.total_unresolved_events || 0) > 0
                ? "Issues remain in another status. Choose All statuses to see mappings awaiting recovery or events that are still blocked."
                : statusFilter === "UNRESOLVED"
                ? "All data is flowing correctly."
                : "No issues match this filter."}
            </div>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>OEM</th>
                  <th>Vehicles</th>
                  <th>Events</th>
                  <th>Stale data</th>
                  <th>First seen</th>
                  <th>Last seen</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => (
                  <IncidentRow
                    key={incident.id}
                    incident={incident}
                    onSelect={() => setSelectedIncident(incident)}
                    onAcknowledge={() => handleAcknowledge(incident.id)}
                    onReconnect={() => handleReconnect(incident)}
                    onRetry={() => handleRetry(incident.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedIncident && (
        <IncidentDetailPanel
          incident={selectedIncident}
          onClose={() => setSelectedIncident(null)}
          onViewVehicle={onViewVehicle}
          onRepair={() => { setRepairIncidentId(selectedIncident.id); setSelectedIncident(null); }}
        />
      )}
      {repairIncidentId && <MappingRepair incidentId={repairIncidentId} onClose={() => { setRepairIncidentId(null); loadIncidents(); }} onComplete={loadIncidents} />}
    </div>
  );
}
