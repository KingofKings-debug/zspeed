import { useState } from "react";
import { api } from "../api";
import type { DiscoveredVehicle } from "../types";

type WizardStep = "authorize" | "discover" | "select" | "activate" | "complete";

const STEPS: { key: WizardStep; label: string }[] = [
  { key: "authorize", label: "Authorise" },
  { key: "discover", label: "Discover" },
  { key: "select", label: "Select" },
  { key: "activate", label: "Activate" },
  { key: "complete", label: "Done" },
];

interface ConnectionWizardProps {
  oemId: string;
  oemName: string;
  onClose: () => void;
}

interface SelectedVehicle {
  oem_vehicle_id: string;
  vin: string;
  model: string;
  year: number;
  categories: string[];
  available_categories: string[];
  selected: boolean;
}

export default function ConnectionWizard({ oemId, oemName, onClose }: ConnectionWizardProps) {
  const [step, setStep] = useState<WizardStep>("authorize");
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [connLabel, setConnLabel] = useState(`${oemName} Account`);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");

  const [discoveredVehicles, setDiscoveredVehicles] = useState<SelectedVehicle[]>([]);

  const [activationResult, setActivationResult] = useState<{ activated: number; unmapped: number } | null>(null);

  const currentIdx = STEPS.findIndex((s) => s.key === step);

  function stepClass(idx: number): string {
    if (idx < currentIdx) return "wizard-step completed";
    if (idx === currentIdx) return "wizard-step active";
    return "wizard-step";
  }

  async function handleAuthorize() {
    setLoading(true);
    setError("");
    try {
      const conn = await api.createConnection(oemId, connLabel);
      setConnectionId(conn.id);

      const credentials: Record<string, string> = {};
      if (apiKey) {
        credentials.api_key = apiKey;
      } else {
        credentials.username = username || "demo_user";
        credentials.password = password || "demo_pass";
      }

      const result = await api.authorizeConnection(conn.id, credentials);
      if (result.success) {
        setStep("discover");
        await loadDiscoveredVehicles(conn.id);
      } else {
        setError(result.error || "Authorisation failed. Check your credentials.");
      }
    } catch (err: any) {
      setError(err.message || "Failed to authorise");
    } finally {
      setLoading(false);
    }
  }

  async function loadDiscoveredVehicles(connId: string) {
    setLoading(true);
    try {
      const data = await api.discoverVehicles(connId);
      setDiscoveredVehicles(
        data.vehicles.map((v: DiscoveredVehicle) => ({
          oem_vehicle_id: v.oem_vehicle_id,
          vin: v.vin,
          model: v.model,
          year: v.year,
          categories: [...v.available_categories],
          available_categories: v.available_categories,
          selected: true,
        }))
      );
    } catch (err: any) {
      setError(err.message || "Vehicle discovery failed");
    } finally {
      setLoading(false);
    }
  }

  function toggleVehicle(idx: number) {
    setDiscoveredVehicles((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], selected: !next[idx].selected };
      return next;
    });
  }

  function toggleCategory(vehicleIdx: number, cat: string) {
    setDiscoveredVehicles((prev) => {
      const next = [...prev];
      const v = { ...next[vehicleIdx] };
      if (v.categories.includes(cat)) {
        v.categories = v.categories.filter((c) => c !== cat);
      } else {
        v.categories = [...v.categories, cat];
      }
      next[vehicleIdx] = v;
      return next;
    });
  }

  async function handleActivate() {
    if (!connectionId) return;
    setLoading(true);
    setError("");
    try {
      const selected = discoveredVehicles
        .filter((v) => v.selected)
        .map((v) => ({
          oem_vehicle_id: v.oem_vehicle_id,
          vin: v.vin,
          categories: v.categories,
        }));

      const result = await api.activateConnection(connectionId, selected);
      setActivationResult(result);
      setStep("complete");
    } catch (err: any) {
      setError(err.message || "Activation failed");
    } finally {
      setLoading(false);
    }
  }

  const selectedCount = discoveredVehicles.filter((v) => v.selected).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: "700px" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Connect {oemName}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="modal-body">
          <div className="wizard-steps">
            {STEPS.map((s, i) => (
              <div key={s.key} className={stepClass(i)}>
                <span className="wizard-step-number">{i + 1}</span>
                {s.label}
              </div>
            ))}
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          {step === "authorize" && (
            <div className="wizard-body">
              <p className="text-sm mb-4">
                Provide your {oemName} fleet account credentials. This is a simulated
                authorisation for demonstration purposes.
              </p>

              <div className="form-group">
                <label className="form-label" htmlFor="conn-label">Connection label</label>
                <input
                  id="conn-label"
                  className="input-field"
                  value={connLabel}
                  onChange={(e) => setConnLabel(e.target.value)}
                  placeholder="e.g. US East Fleet Account"
                />
                <p className="form-help">Descriptive name to distinguish multiple accounts</p>
              </div>

              {oemId === "oem_crestline" ? (
                <div className="form-group">
                  <label className="form-label" htmlFor="api-key">API key</label>
                  <input
                    id="api-key"
                    className="input-field"
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="Enter your Crestline API key (any value for demo)"
                  />
                  <p className="form-help">Enter any value. Use "fail" to test error handling.</p>
                </div>
              ) : (
                <>
                  <div className="form-group">
                    <label className="form-label" htmlFor="auth-user">Account email</label>
                    <input
                      id="auth-user"
                      className="input-field"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="demo@fleet.example (leave blank for demo)"
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="auth-pass">Password</label>
                    <input
                      id="auth-pass"
                      className="input-field"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password (leave blank for demo)"
                    />
                    <p className="form-help">Enter "fail" as username or password to test error handling.</p>
                  </div>
                </>
              )}

              <div className="wizard-footer">
                <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                <button className="btn btn-primary" onClick={handleAuthorize} disabled={loading}>
                  {loading ? <><span className="spinner" /> Authorising...</> : "Authorise account"}
                </button>
              </div>
            </div>
          )}

          {step === "discover" && (
            <div className="wizard-body">
              {loading ? (
                <div className="loading-state">
                  <div className="spinner spinner-lg" />
                  Discovering vehicles on your {oemName} account...
                </div>
              ) : (
                <>
                  <div className="alert alert-success">
                    Account authorised. Found {discoveredVehicles.length} vehicle{discoveredVehicles.length !== 1 ? "s" : ""} on your {oemName} account.
                  </div>
                  <p className="text-sm mb-4">
                    These vehicles were discovered through your authorised account.
                    Proceed to select which vehicles and data categories to enable.
                  </p>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>OEM ID</th>
                        <th>VIN</th>
                        <th>Model</th>
                        <th>Year</th>
                      </tr>
                    </thead>
                    <tbody>
                      {discoveredVehicles.map((v) => (
                        <tr key={v.oem_vehicle_id}>
                          <td className="mono text-sm">{v.oem_vehicle_id}</td>
                          <td className="mono">{v.vin}</td>
                          <td>{v.model}</td>
                          <td>{v.year}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="wizard-footer">
                    <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
                    <button className="btn btn-primary" onClick={() => setStep("select")}>
                      Select vehicles and data
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === "select" && (
            <div className="wizard-body">
              <p className="text-sm mb-4">
                Select which vehicles to map and which data categories to enable for each.
              </p>

              {discoveredVehicles.map((v, i) => (
                <div
                  key={v.oem_vehicle_id}
                  style={{
                    border: "1px solid var(--color-border-light)",
                    borderRadius: "var(--radius-sm)",
                    padding: "12px 14px",
                    marginBottom: "8px",
                    opacity: v.selected ? 1 : 0.5,
                  }}
                >
                  <div className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={v.selected}
                      onChange={() => toggleVehicle(i)}
                      id={`vehicle-${i}`}
                      aria-label={`Select ${v.vin}`}
                    />
                    <label htmlFor={`vehicle-${i}`} style={{ fontWeight: 500 }}>
                      {v.model} ({v.year})
                    </label>
                    <span className="mono text-xs text-muted" style={{ marginLeft: "auto" }}>{v.vin}</span>
                  </div>

                  {v.selected && (
                    <div className="category-tags" style={{ marginTop: "8px", marginLeft: "24px" }}>
                      {v.available_categories.map((cat) => (
                        <button
                          key={cat}
                          className={`category-tag ${v.categories.includes(cat) ? "selected" : ""}`}
                          onClick={() => toggleCategory(i, cat)}
                          style={{ cursor: "pointer", border: "none" }}
                          type="button"
                          aria-pressed={v.categories.includes(cat)}
                          aria-label={`Toggle ${cat}`}
                        >
                          {cat.replace(/_/g, " ")}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}

              <div className="wizard-footer">
                <button className="btn btn-secondary" onClick={() => setStep("discover")}>
                  Back
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => setStep("activate")}
                  disabled={selectedCount === 0}
                >
                  Review activation ({selectedCount} vehicle{selectedCount !== 1 ? "s" : ""})
                </button>
              </div>
            </div>
          )}

          {step === "activate" && (
            <div className="wizard-body">
              <h3 style={{ fontSize: "15px", fontWeight: 600, marginBottom: "16px" }}>Activation summary</h3>

              <div className="alert alert-info">
                Activating this connection will link {selectedCount} vehicle{selectedCount !== 1 ? "s" : ""} to
                your {oemName} account. Data delivery will begin once {oemName} confirms access.
                An active account connection does not guarantee that all vehicles are authorised or
                sending telemetry.
              </div>

              <table className="data-table" style={{ marginTop: "16px" }}>
                <thead>
                  <tr>
                    <th>Vehicle</th>
                    <th>VIN</th>
                    <th>Data categories</th>
                  </tr>
                </thead>
                <tbody>
                  {discoveredVehicles.filter((v) => v.selected).map((v) => (
                    <tr key={v.oem_vehicle_id}>
                      <td>{v.model} ({v.year})</td>
                      <td className="mono">{v.vin}</td>
                      <td>
                        <div className="category-tags">
                          {v.categories.map((c) => (
                            <span key={c} className="category-tag selected">{c.replace(/_/g, " ")}</span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="wizard-footer">
                <button className="btn btn-secondary" onClick={() => setStep("select")}>
                  Back
                </button>
                <button className="btn btn-primary" onClick={handleActivate} disabled={loading}>
                  {loading ? <><span className="spinner" /> Activating...</> : "Activate connection"}
                </button>
              </div>
            </div>
          )}

          {step === "complete" && activationResult && (
            <div className="wizard-body">
              <div className="alert alert-success">
                Connection activated successfully.
              </div>

              <div className="stats-grid" style={{ marginTop: "16px" }}>
                <div className="stat-card">
                  <span className="stat-card-label">Vehicles mapped</span>
                  <span className="stat-card-value success">{activationResult.activated}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-card-label">Unmapped</span>
                  <span className="stat-card-value warning">{activationResult.unmapped}</span>
                </div>
              </div>

              <p className="text-sm text-muted mt-4">
                Mapped vehicles will show "Awaiting data" until telemetry arrives from {oemName}.
                This typically takes a few seconds in this simulated environment.
                You can check the vehicle list or connection health from the connections page.
              </p>

              {activationResult.unmapped > 0 && (
                <p className="text-sm text-muted mt-2">
                  {activationResult.unmapped} vehicle{activationResult.unmapped !== 1 ? "s" : ""} could not
                  be mapped. They may not exist in your fleet or the OEM did not grant access.
                </p>
              )}

              <div className="wizard-footer">
                <div />
                <button className="btn btn-primary" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
