import { useState, useEffect } from "react";
import { api } from "../api";
import type { SupportedOem } from "../types";

function connectionStatusLabel(status: string): { text: string; className: string } {
  switch (status) {
    case "ACTIVE": return { text: "Account connected", className: "status-active" };
    case "AUTHORISING": return { text: "Authorising...", className: "status-authorising" };
    case "VERIFYING": return { text: "Verifying access", className: "status-verifying" };
    case "NOT_CONFIGURED": return { text: "Not configured", className: "status-no-connection" };
    case "DEGRADED": return { text: "Degraded", className: "status-degraded" };
    case "EXPIRED": return { text: "Expired", className: "status-error" };
    case "DISCONNECTED": return { text: "Disconnected", className: "status-no-connection" };
    default: return { text: status, className: "status-no-connection" };
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface OemConnectionsProps {
  onConnect: (oemId: string, oemName: string) => void;
  onRequestIntegration: () => void;
  onRefresh: () => void;
}

export default function OemConnections({ onConnect, onRequestIntegration, onRefresh }: OemConnectionsProps) {
  const [oems, setOems] = useState<SupportedOem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api.getOems();
      setOems(data.oems);
    } catch (err) {
      console.error("Failed to load OEMs:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDisconnect(connectionId: string) {
    setActionLoading(connectionId);
    try {
      await api.disconnectConnection(connectionId);
      await load();
      onRefresh();
    } catch (err) {
      console.error("Disconnect failed:", err);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReconnect(connectionId: string) {
    setActionLoading(connectionId);
    try {
      await api.reconnectConnection(connectionId);
      await load();
      onRefresh();
    } catch (err) {
      console.error("Reconnect failed:", err);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleHealthCheck(connectionId: string) {
    setActionLoading(connectionId);
    try {
      await api.checkHealth(connectionId);
      await load();
    } catch (err) {
      console.error("Health check failed:", err);
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <div className="loading-state">
        <div className="spinner spinner-lg" />
        Loading OEM connections...
      </div>
    );
  }

  return (
    <div>
      <div className="section-header">
        <div>
          <h1 className="section-title">OEM Connections</h1>
          <p className="section-subtitle">Manage manufacturer integrations for your fleet</p>
        </div>
        <button className="btn btn-secondary" onClick={onRequestIntegration}>
          Request new integration
        </button>
      </div>

      {oems.map((oem) => (
        <div key={oem.id} className="oem-card mb-2">
          <div className="oem-card-info" style={{ flex: 1 }}>
            <div className="oem-card-name">{oem.name}</div>
            <div className="oem-card-meta">
              <span>{oem.vehicle_count} vehicle{oem.vehicle_count !== 1 ? "s" : ""} in fleet</span>
              <span className="text-muted">{oem.supported_categories.length} data categories</span>
            </div>

            {oem.connections.length > 0 ? (
              <div className="mt-4">
                {oem.connections.map((conn) => {
                  const status = connectionStatusLabel(conn.status);
                  const isLoading = actionLoading === conn.id;

                  return (
                    <div
                      key={conn.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "10px 14px",
                        border: "1px solid var(--color-border-light)",
                        borderRadius: "var(--radius-sm)",
                        marginBottom: "6px",
                        flexWrap: "wrap",
                        gap: "8px",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 500, fontSize: "13px" }}>{conn.label}</div>
                        <div className="connection-detail" style={{ marginTop: "4px" }}>
                          <span className={`status-badge ${status.className}`}>
                            <span className="status-dot" />
                            {status.text}
                          </span>
                          {conn.status === "ACTIVE" && (
                            <span className="text-xs text-muted">
                              {conn.last_data_received
                                ? `Last data: ${formatDate(conn.last_data_received)}`
                                : "Awaiting first data delivery"
                              }
                            </span>
                          )}
                          {conn.vehicle_count > 0 && (
                            <span className="text-xs text-muted">
                              {conn.vehicle_count} vehicle{conn.vehicle_count !== 1 ? "s" : ""} mapped
                            </span>
                          )}
                          {conn.error_message && (
                            <span className="text-xs" style={{ color: "var(--color-error)" }}>
                              {conn.error_message}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {conn.status === "ACTIVE" && (
                          <>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => handleHealthCheck(conn.id)}
                              disabled={isLoading}
                            >
                              {isLoading ? <span className="spinner" /> : "Check health"}
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => handleDisconnect(conn.id)}
                              disabled={isLoading}
                            >
                              Disconnect
                            </button>
                          </>
                        )}
                        {(conn.status === "DISCONNECTED" || conn.status === "EXPIRED" || conn.status === "DEGRADED") && (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleReconnect(conn.id)}
                            disabled={isLoading}
                          >
                            {isLoading ? <span className="spinner" /> : "Reconnect"}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : oem.vehicle_count > 0 ? (
              <div className="alert alert-warning mt-4" style={{ marginBottom: 0 }}>
                Connection required. {oem.vehicle_count} vehicle{oem.vehicle_count !== 1 ? "s" : ""} from this manufacturer need an OEM account connection to receive data.
              </div>
            ) : null}
          </div>

          <div className="oem-card-actions">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onConnect(oem.id, oem.name)}
            >
              {oem.connections.length > 0 ? "Add connection" : "Connect OEM"}
            </button>
          </div>
        </div>
      ))}

      <div className="card mt-4">
        <div className="card-body">
          <div className="empty-state" style={{ padding: "16px" }}>
            <div className="empty-state-title">Missing a manufacturer?</div>
            <p className="empty-state-text">
              Request an integration for OEMs not listed above. We will assess connector availability and contact you.
            </p>
            <button className="btn btn-secondary" onClick={onRequestIntegration}>
              Request integration
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
