import { useState, useEffect } from "react";
import { api } from "../api";
import type { Vehicle } from "../types";

function statusLabel(status: string): { text: string; className: string } {
  switch (status) {
    case "RECEIVING": return { text: "Receiving data", className: "status-receiving" };
    case "AWAITING_DATA": return { text: "Awaiting data", className: "status-awaiting" };
    case "NO_CONNECTION": return { text: "No connection", className: "status-no-connection" };
    case "UNAUTHORISED_VEHICLE": return { text: "Unauthorised", className: "status-error" };
    case "STALE": return { text: "Stale data", className: "status-degraded" };
    default: return { text: status, className: "status-no-connection" };
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "\u2014";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface VehicleListProps {
  onImport: () => void;
  onSelectVehicle?: (vehicleId: string) => void;
}

export default function VehicleList({ onImport, onSelectVehicle }: VehicleListProps) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [addVin, setAddVin] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState("");

  async function loadVehicles(searchTerm?: string) {
    try {
      setLoading(true);
      const data = await api.getVehicles(searchTerm);
      setVehicles(data.vehicles);
    } catch (err) {
      console.error("Failed to load vehicles:", err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadVehicles();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      loadVehicles(search || undefined);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  async function handleAdd() {
    if (!addVin.trim()) return;
    setAdding(true);
    setAddError("");
    try {
      await api.addVehicle(addVin.trim(), addLabel.trim() || undefined);
      setAddVin("");
      setAddLabel("");
      setShowAdd(false);
      loadVehicles(search || undefined);
    } catch (err: any) {
      setAddError(err.message || "Failed to add vehicle");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div>
      <div className="section-header">
        <div>
          <h1 className="section-title">Vehicles</h1>
          <p className="section-subtitle">{vehicles.length} vehicle{vehicles.length !== 1 ? "s" : ""} in fleet</p>
        </div>
        <div className="flex gap-2">
          <button className="btn btn-secondary" onClick={() => setShowAdd(!showAdd)}>
            Add vehicle
          </button>
          <button className="btn btn-primary" onClick={onImport}>
            Import CSV
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="card mb-4">
          <div className="card-body">
            <div style={{ display: "flex", gap: "8px", alignItems: "flex-end", flexWrap: "wrap" }}>
              <div className="form-group" style={{ marginBottom: 0, flex: "1 1 240px" }}>
                <label className="form-label" htmlFor="add-vin">VIN</label>
                <input
                  id="add-vin"
                  className="input-field"
                  value={addVin}
                  onChange={(e) => setAddVin(e.target.value.toUpperCase())}
                  placeholder="17-character VIN"
                  maxLength={17}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: "1 1 160px" }}>
                <label className="form-label" htmlFor="add-label">Label (optional)</label>
                <input
                  id="add-label"
                  className="input-field"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="e.g. Fleet Van 06"
                />
              </div>
              <button className="btn btn-primary" onClick={handleAdd} disabled={adding || !addVin.trim()}>
                {adding ? <span className="spinner" /> : null}
                Add
              </button>
              <button className="btn btn-secondary" onClick={() => setShowAdd(false)}>
                Cancel
              </button>
            </div>
            {addError && <div className="alert alert-error mt-2">{addError}</div>}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <div className="search-bar">
            <input
              className="input-field"
              placeholder="Search VIN, label, or manufacturer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search vehicles"
            />
          </div>
        </div>

        {loading ? (
          <div className="loading-state">
            <div className="spinner spinner-lg" />
            Loading vehicles...
          </div>
        ) : vehicles.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">No vehicles found</div>
            <p className="empty-state-text">
              {search ? "No vehicles match your search." : "Import a CSV or add vehicles individually to get started."}
            </p>
            {!search && (
              <button className="btn btn-primary" onClick={onImport}>Import vehicles</button>
            )}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Label</th>
                <th>VIN</th>
                <th>Manufacturer</th>
                <th>Data status</th>
                <th>Last update</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {vehicles.map((v) => {
                const status = statusLabel(v.data_status);
                return (
                  <tr key={v.id} style={{ cursor: onSelectVehicle ? "pointer" : undefined }} onClick={() => onSelectVehicle?.(v.id)}>
                    <td>{v.label || <span className="text-muted">No label</span>}</td>
                    <td className="mono">{v.vin}</td>
                    <td>{v.suggested_manufacturer || <span className="text-muted">Unknown</span>}</td>
                    <td>
                      <span className={`status-badge ${status.className}`}>
                        <span className="status-dot" />
                        {status.text}
                      </span>
                    </td>
                    <td className="text-sm text-muted">{formatDate(v.last_data_at)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {onSelectVehicle && (
                        <button className="btn btn-ghost btn-sm" onClick={() => onSelectVehicle(v.id)}>
                          View →
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
