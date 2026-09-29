import { useState } from "react";
import { api } from "../api";

const CATEGORIES = [
  "location",
  "fuel_level",
  "odometer",
  "engine_status",
  "tire_pressure",
  "battery_voltage",
  "diagnostics",
  "door_status",
  "cargo_weight",
  "temperature_zone",
  "driver_hours",
];

interface RequestIntegrationProps {
  onClose: () => void;
}

export default function RequestIntegration({ onClose }: RequestIntegrationProps) {
  const [manufacturer, setManufacturer] = useState("");
  const [fleetSize, setFleetSize] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitted, setSubmitted] = useState(false);

  function toggleCategory(cat: string) {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  }

  async function handleSubmit() {
    if (!manufacturer.trim()) {
      setError("Manufacturer name is required.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      await api.submitIntegrationRequest({
        manufacturer_name: manufacturer.trim(),
        fleet_size: parseInt(fleetSize) || 0,
        desired_categories: categories,
        contact_notes: notes || undefined,
      });
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || "Failed to submit request");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Request OEM integration</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="modal-body">
          {submitted ? (
            <>
              <div className="alert alert-success">
                Integration request submitted. Our team will review your request and
                assess connector availability for this manufacturer.
              </div>
              <p className="text-sm text-muted mt-2">
                Building a new OEM connector requires establishing a data partnership
                with the manufacturer. A VIN alone does not provide access to protected
                vehicle telemetry data. We will contact you when we have an update.
              </p>
            </>
          ) : (
            <>
              {error && <div className="alert alert-error">{error}</div>}

              <div className="alert alert-info mb-4">
                Request support for a manufacturer not currently on our platform.
                Building a connector requires a data partnership with the OEM.
                Submitting a request does not guarantee integration availability.
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="mfg-name">Manufacturer name</label>
                <input
                  id="mfg-name"
                  className="input-field"
                  value={manufacturer}
                  onChange={(e) => setManufacturer(e.target.value)}
                  placeholder="e.g. Meridian Electric"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="fleet-size">Fleet size (vehicles from this OEM)</label>
                <input
                  id="fleet-size"
                  className="input-field"
                  type="number"
                  min="0"
                  value={fleetSize}
                  onChange={(e) => setFleetSize(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div className="form-group">
                <label className="form-label">Desired data categories</label>
                <div className="category-tags" style={{ gap: "6px" }}>
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={`category-tag ${categories.includes(cat) ? "selected" : ""}`}
                      onClick={() => toggleCategory(cat)}
                      style={{ cursor: "pointer", border: "none", padding: "4px 10px" }}
                      aria-pressed={categories.includes(cat)}
                    >
                      {cat.replace(/_/g, " ")}
                    </button>
                  ))}
                </div>
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="notes">Additional notes</label>
                <textarea
                  id="notes"
                  className="input-field"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any relevant details about your use case..."
                />
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          {submitted ? (
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleSubmit}
                disabled={loading || !manufacturer.trim()}
              >
                {loading ? <span className="spinner" /> : null}
                Submit request
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
