import { useState, useRef } from "react";
import { api } from "../api";
import type { ImportBatch, ImportRow } from "../types";

interface ImportFlowProps {
  onClose: () => void;
}

export default function ImportFlow({ onClose }: ImportFlowProps) {
  const [step, setStep] = useState<"upload" | "preview" | "confirmed">("upload");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [confirmResult, setConfirmResult] = useState<{ created: number; skipped: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(file: File) {
    if (!file.name.endsWith(".csv")) {
      setError("Please upload a CSV file.");
      return;
    }

    setLoading(true);
    setError("");
    try {
      const result = await api.previewImport(file);
      setBatch(result.batch);
      setRows(result.rows);
      setStep("preview");
    } catch (err: any) {
      setError(err.message || "Import preview failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleConfirm() {
    if (!batch) return;
    setLoading(true);
    setError("");
    try {
      const result = await api.confirmImport(batch.id);
      setConfirmResult(result);
      setStep("confirmed");
    } catch (err: any) {
      setError(err.message || "Import confirmation failed");
    } finally {
      setLoading(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  const validRows = rows.filter((r) => r.is_valid && !r.is_duplicate);
  const errorRows = rows.filter((r) => !r.is_valid);
  const duplicateRows = rows.filter((r) => r.is_duplicate);
  const uncertainRows = rows.filter((r) => r.is_valid && !r.is_duplicate && r.is_uncertain_match);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: "720px" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">
            {step === "upload" && "Import vehicles"}
            {step === "preview" && "Review import"}
            {step === "confirmed" && "Import complete"}
          </h2>
          <button className="close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>

        <div className="modal-body">
          {error && <div className="alert alert-error">{error}</div>}

          {step === "upload" && (
            <>
              <div
                className="import-dropzone"
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                onClick={() => fileRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileRef.current?.click(); }}
                aria-label="Upload CSV file"
              >
                {loading ? (
                  <div className="loading-state" style={{ padding: "8px" }}>
                    <div className="spinner spinner-lg" />
                    Processing file...
                  </div>
                ) : (
                  <>
                    <div className="import-dropzone-text">
                      Drop a CSV file here or click to browse
                    </div>
                    <div className="import-dropzone-hint">
                      File must contain a "vin" column. Optional "label" column.
                    </div>
                  </>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
              <div className="mt-4">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = "/api/sample-csv";
                    a.download = "fleet-sample.csv";
                    a.click();
                  }}
                >
                  Download sample CSV
                </button>
              </div>
            </>
          )}

          {step === "preview" && batch && (
            <>
              <div className="stats-grid" style={{ marginBottom: "16px" }}>
                <div className="stat-card">
                  <span className="stat-card-label">Total rows</span>
                  <span className="stat-card-value">{batch.total_rows}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-card-label">Valid</span>
                  <span className="stat-card-value success">{batch.valid_rows}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-card-label">Errors</span>
                  <span className="stat-card-value error">{batch.error_rows}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-card-label">Duplicates</span>
                  <span className="stat-card-value warning">{batch.duplicate_rows}</span>
                </div>
              </div>

              {uncertainRows.length > 0 && (
                <div className="alert alert-warning mb-4">
                  {uncertainRows.length} vehicle{uncertainRows.length !== 1 ? "s" : ""} {uncertainRows.length === 1 ? "has" : "have"} uncertain manufacturer matches. Review the rows highlighted below before confirming.
                </div>
              )}

              <div className="card">
                <div style={{ overflowX: "auto" }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Row</th>
                        <th>VIN</th>
                        <th>Label</th>
                        <th>Manufacturer</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr
                          key={r.id}
                          className={
                            !r.is_valid ? "row-error" :
                            r.is_duplicate ? "row-duplicate" :
                            r.is_uncertain_match ? "row-uncertain" : ""
                          }
                        >
                          <td className="text-muted">{r.row_number}</td>
                          <td className="mono">{r.vin}</td>
                          <td>{r.label || <span className="text-muted">\u2014</span>}</td>
                          <td>
                            {r.suggested_manufacturer || <span className="text-muted">Unknown</span>}
                            {r.is_uncertain_match && (
                              <span className="text-xs text-muted" style={{ marginLeft: "6px" }}>(uncertain)</span>
                            )}
                          </td>
                          <td>
                            {!r.is_valid && (
                              <span className="status-badge status-error">
                                <span className="status-dot" />
                                {r.error_message}
                              </span>
                            )}
                            {r.is_duplicate && (
                              <span className="status-badge status-awaiting">
                                <span className="status-dot" />
                                {r.error_message || "Duplicate"}
                              </span>
                            )}
                            {r.is_valid && !r.is_duplicate && (
                              <span className="status-badge status-active">
                                <span className="status-dot" />
                                Valid
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {step === "confirmed" && confirmResult && (
            <div>
              <div className="alert alert-success">
                Import complete. {confirmResult.created} vehicle{confirmResult.created !== 1 ? "s" : ""} added to your fleet.
                {confirmResult.skipped > 0 && ` ${confirmResult.skipped} skipped (already exist).`}
              </div>
              <p className="text-sm text-muted mt-2">
                Vehicles with identified manufacturers can now be connected through the OEM connections page.
                Vehicles with unknown or uncertain manufacturers will appear in your fleet list but require manual OEM assignment.
              </p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          {step === "upload" && (
            <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          )}
          {step === "preview" && (
            <>
              <button className="btn btn-secondary" onClick={() => { setStep("upload"); setBatch(null); setRows([]); }}>
                Upload different file
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConfirm}
                disabled={loading || validRows.length === 0}
              >
                {loading ? <span className="spinner" /> : null}
                Confirm import ({validRows.length} vehicle{validRows.length !== 1 ? "s" : ""})
              </button>
            </>
          )}
          {step === "confirmed" && (
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          )}
        </div>
      </div>
    </div>
  );
}
