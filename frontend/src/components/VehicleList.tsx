import { useState, useEffect } from "react";
import { api, ApiError } from "../api";
import { useFleetVehicles, vehicleStore, type LiveVehicleEntry } from "../store/vehicleStore";

function renderMovementBadge(state: string) {
  switch (state) {
    case "MOVING":
      return <span className="status-badge status-active"><span className="status-dot" />Moving</span>;
    case "IDLE":
      return <span className="status-badge status-receiving"><span className="status-dot" />Stationary</span>;
    case "PARKED":
      return <span className="status-badge status-awaiting"><span className="status-dot" />Parked</span>;
    case "CHARGING":
      return <span className="status-badge status-active"><span className="status-dot" />Charging</span>;
    default:
      return <span className="status-badge status-awaiting"><span className="status-dot" />{state}</span>;
  }
}

function renderFreshnessBadge(freshness: string) {
  switch (freshness) {
    case "LIVE":
      return <span className="status-badge status-active"><span className="status-dot" />Live</span>;
    case "STALE":
      return <span className="status-badge status-degraded"><span className="status-dot" />Delayed</span>;
    case "OFFLINE":
      return <span className="status-badge status-no-connection"><span className="status-dot" />Offline</span>;
    default:
      return <span className="status-badge status-awaiting"><span className="status-dot" />Awaiting data</span>;
  }
}

interface VehicleListProps {
  onImport: () => void;
  onSelectVehicle?: (vehicleId: string) => void;
}

export default function VehicleList({ onImport, onSelectVehicle }: VehicleListProps) {
  const storeEntries = useFleetVehicles();
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addVin, setAddVin] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [adding, setAdding] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState("");

  async function loadVehicles(searchTerm?: string) {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.getVehicles(searchTerm);
      vehicleStore.initSnapshot(data.vehicles);
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 401) return;
      setLoadError(err.message || "Failed to load vehicles.");
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

  const filteredEntries = storeEntries.filter((entry) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    const v = entry.vehicle;
    return (
      v.vin.toLowerCase().includes(term) ||
      (v.label && v.label.toLowerCase().includes(term)) ||
      (v.suggested_manufacturer && v.suggested_manufacturer.toLowerCase().includes(term))
    );
  });

  return (
    <div>
      <div className="section-header">
        <div>
          <h1 className="section-title">Vehicles</h1>
          <p className="section-subtitle">{storeEntries.length} vehicle{storeEntries.length !== 1 ? "s" : ""} in fleet</p>
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

        {loading && storeEntries.length === 0 ? (
          <div className="loading-state">
            <div className="spinner spinner-lg" />
            Loading vehicles...
          </div>
        ) : loadError ? (
          <div className="card-body">
            <div className="alert alert-error" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <span>{loadError}</span>
              <button className="btn btn-secondary btn-sm" onClick={() => loadVehicles(search || undefined)}>Retry</button>
            </div>
          </div>
        ) : filteredEntries.length === 0 ? (
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
                <th>Speed</th>
                <th>Movement</th>
                <th>Freshness</th>
                <th>Last update</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filteredEntries.map((entry) => {
                const v = entry.vehicle;
                return (
                  <tr
                    key={v.id}
                    data-testid={`vehicle-row-${v.id}`}
                    style={{ cursor: onSelectVehicle ? "pointer" : undefined }}
                    onClick={() => onSelectVehicle?.(v.id)}
                  >
                    <td>{v.label || <span className="text-muted">No label</span>}</td>
                    <td className="mono">{v.vin}</td>
                    <td>{v.suggested_manufacturer || <span className="text-muted">Unknown</span>}</td>
                    <td data-testid={`vehicle-speed-${v.id}`} style={{ fontWeight: 600 }}>
                      {entry.speed !== null && entry.speed !== undefined
                        ? `${entry.speed.toFixed(1)} ${entry.speedUnit || "km/h"}`
                        : <span className="text-muted">–</span>}
                    </td>
                    <td>{renderMovementBadge(entry.movementState)}</td>
                    <td>{renderFreshnessBadge(entry.dataFreshness)}</td>
                    <td className="text-sm text-muted">{entry.lastUpdatedAge}</td>
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
