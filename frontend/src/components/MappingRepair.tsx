import { useEffect, useState } from "react";
import { api } from "../api";

interface Rule { signal_id: string; sources: string[]; conversion: string; required: boolean; enum_map?: Record<string, string>; scale?: number; offset?: number }
interface Configuration { name: string; rules: Rule[]; live_mode: string; discriminator?: { path: string; value: string } }
const conversions: Record<string, string> = {
  DIRECT: "Keep value / numeric text → number", MPH_TO_KMH: "Miles/hour → kilometres/hour", MILES_TO_KM: "Miles → kilometres", FRACTION_TO_PERCENT: "Fraction (0–1) → percent", METRES_TO_KM: "Metres → kilometres", CELSIUS_FROM_FAHRENHEIT: "Fahrenheit → Celsius", MICRODEGREES_TO_DEGREES: "GPS microdegrees → degrees", ISO_TIME: "ISO timestamp with timezone", UNIX_SECONDS: "Unix timestamp in seconds", UNIX_MILLISECONDS: "Unix timestamp in milliseconds", ENUM_MAP: "Translate flags or status codes", SCALE_OFFSET: "Multiply and add (custom units)",
};
const cases = [
  ["renamed", "Field renamed or moved", "Choose its new location in the source dropdown. Add the old location as a fallback when both formats are in use."],
  ["added", "OEM added a field", "Add a measurement if the platform already supports it. Unused fields stay in the original saved event; they do not need a mapping."],
  ["removed", "Field removed or sometimes null", "Leave an optional measurement unknown, or remove its rule. Keep event time required. Missing measurements cannot be reconstructed from a mapping."],
  ["units", "Units, numbers, or GPS changed", "Choose the conversion explicitly. Check the before/after preview. For swapped GPS fields, select the correct source for each coordinate. Corrupt values stay blocked."],
  ["codes", "Flags or status codes changed", "Use a value translation for each OEM code. Unknown codes stay blocked instead of being guessed."],
  ["time", "Timestamp format changed", "Choose seconds, milliseconds, or ISO with timezone. An ambiguous local time needs the OEM to supply timezone information."],
  ["versions", "Old and new formats coexist", "Add fallback sources or a format/version filter. Start with rejected formats only; replacing recognized formats needs extra care."],
  ["identity", "Vehicle IDs, credentials, duplicates, or broken JSON", "Map vehicles or reconnect in Connections. Conflicting event IDs and malformed JSON need an OEM correction; changing field mappings will not fix them."],
  ["arrays", "Nested objects or arrays", "Dropdowns include nested paths and sampled array positions. A changing array of many sensor records needs an ingestion adapter, not a fixed-position mapping."],
];
const showValue = (value: any) => value === null || value === undefined ? "Unknown" : typeof value === "object" ? JSON.stringify(value) : String(value);
const label = (name: string) => name.replace(/_/g, " ").replace(/^./, char => char.toUpperCase());
const atPath = (payload: any, path: string) => payload?.[path] ?? path.split(".").reduce((value: any, part) => value?.[part], payload);

function startingConfiguration(context: any): Configuration {
  const paths = new Set(context.paths.map((field: any) => field.path));
  const templates = [...context.templates].sort((a: any, b: any) => b.rules.filter((rule: any) => paths.has(rule.source_field_path)).length - a.rules.filter((rule: any) => paths.has(rule.source_field_path)).length);
  const rules: Rule[] = (templates[0]?.rules || []).map((rule: any) => ({ signal_id: rule.destination_signal_id, sources: [rule.source_field_path], conversion: rule.destination_signal_id === "sig_event_time" ? (context.paths.find((field: any) => field.path === rule.source_field_path)?.type === "number" ? "UNIX_MILLISECONDS" : "ISO_TIME") : rule.conversion_type, required: rule.destination_signal_id === "sig_event_time", ...(rule.enum_mapping ? { enum_map: JSON.parse(rule.enum_mapping) } : {}) }));
  if (!rules.length) rules.push({ signal_id: "sig_speed", sources: ["speed"], conversion: "DIRECT", required: true });
  if (!rules.some(rule => rule.signal_id === "sig_event_time")) {
    const timeField = context.paths.find((field: any) => /timestamp|time_measured|event_time|recorded_at/.test(field.path));
    rules.push({ signal_id: "sig_event_time", sources: [timeField?.path || "timestamp"], conversion: timeField?.type === "number" ? (Number(timeField.example) > 1e11 ? "UNIX_MILLISECONDS" : "UNIX_SECONDS") : "ISO_TIME", required: true });
  }
  const priority = ["sig_event_time", "sig_speed", "sig_latitude", "sig_longitude", "sig_soc", "sig_odometer", "sig_ignition", "sig_heading"];
  rules.sort((a, b) => (priority.includes(a.signal_id) ? priority.indexOf(a.signal_id) : 99) - (priority.includes(b.signal_id) ? priority.indexOf(b.signal_id) : 99));
  return { name: `${context.incident.oem_name || "OEM"} format repair`, rules, live_mode: "invalid_only" };
}

export default function MappingRepair({ incidentId, onClose, onComplete }: { incidentId: string; onClose: () => void; onComplete: () => void }) {
  const [context, setContext] = useState<any>(null);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [profile, setProfile] = useState<{ id: string; revision: number; status: string } | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<any>(null);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [resultIndex, setResultIndex] = useState(0);
  const [scenario, setScenario] = useState("renamed");
  const [reviewed, setReviewed] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [pollVersion, setPollVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.getRepairContext(incidentId).then(data => {
      if (cancelled) return;
      setContext(data);
      setConfiguration(data.existing?.configuration || startingConfiguration(data));
      if (data.existing) {
        setProfile({ id: data.existing.id, revision: data.existing.revision, status: data.existing.status });
        if (["ACTIVE", "RETIRED"].includes(data.existing.status)) setStep(3);
      }
      if (data.latestJob) {
        setJob(data.latestJob);
        if (!["COMPLETED", "FAILED"].includes(data.latestJob.status)) setJobId(data.latestJob.id);
      }
    }).catch(err => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [incidentId]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.getReplayJob(jobId);
        if (cancelled) return;
        setJob(next); setError("");
        if (["COMPLETED", "FAILED"].includes(next.status)) {
          onComplete();
          api.getRepairContext(incidentId).then(updated => { if (!cancelled) setContext(updated); }).catch(() => {});
        }
        else timer = setTimeout(poll, 2000);
      } catch (err: any) { if (!cancelled) setError(`Recovery status unavailable: ${err.message}. The server job continues; check status again.`); }
    };
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [jobId, pollVersion]);

  function change(next: Configuration) { setConfiguration(next); setReport(null); setReviewed(false); setError(""); }
  function changeRule(index: number, updates: Partial<Rule>) {
    if (!configuration) return;
    change({ ...configuration, rules: configuration.rules.map((rule, i) => i === index ? { ...rule, ...updates } : rule) });
  }
  async function test() {
    if (!configuration) return;
    setBusy(true); setError("");
    try {
      const draft = await api.saveMappingRepair(incidentId, configuration, profile?.status === "DRAFT" ? profile.id : undefined, profile?.status === "DRAFT" ? profile.revision : undefined);
      setProfile({ ...draft, status: "DRAFT" });
      setReport(await api.testMappingRepair(draft.id)); setResultIndex(0); setStep(2);
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  async function publish() {
    if (!profile) return;
    setBusy(true); setError("");
    try {
      const response = await api.publishMappingRepair(profile.id, profile.revision);
      setReport(response.report); setProfile({ ...profile, status: "ACTIVE" }); setStep(3); onComplete();
    } catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  async function recover() {
    if (!profile) return;
    setBusy(true); setError("");
    try { const response = await api.replayMappingRepair(profile.id); setJobId(response.jobId); setPollVersion(version => version + 1); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  async function disable() {
    if (!profile) return;
    setBusy(true); setError("");
    try { await api.disableMappingRepair(profile.id); setProfile({ ...profile, status: "RETIRED" }); onComplete(); }
    catch (err: any) { setError(err.message); } finally { setBusy(false); }
  }
  function newVersion() { setProfile(null); setReport(null); setReviewed(false); setJobId(null); setJob(null); setStep(1); }
  const currentResult = report?.results[resultIndex];
  const published = profile?.status === "ACTIVE";
  const working = job && !["COMPLETED", "FAILED"].includes(job.status);
  const pathOptions = (value: string) => <>
    <option value="">Choose an OEM field…</option>
    {value && !context.paths.some((field: any) => field.path === value) && <option value={value}>{value} — not present in these examples</option>}
    {context.paths.map((field: any) => <option key={field.path} value={field.path}>{field.path} · {showValue(field.example).slice(0, 45)}</option>)}
  </>;

  return <div className="modal-overlay"><section className="modal repair-modal" role="dialog" aria-modal="true" aria-labelledby="repair-title">
    <div className="modal-header"><div><h2 id="repair-title" className="modal-title">Repair OEM data mapping</h2><p className="text-muted">Inspect → map → test → recover</p></div><button className="close-btn" aria-label="Close mapping repair" onClick={onClose}>✕</button></div>
    <div className="repair-steps" aria-label="Repair steps">{["1. Understand", "2. Map fields", "3. Test examples", "4. Apply & recover"].map((title, index) => <button key={title} className={step === index ? "active" : ""} disabled={busy || !context || (index === 2 && !report) || (index === 3 && !published && !report && !job && profile?.status !== "RETIRED")} onClick={() => setStep(index)}>{title}</button>)}</div>
    <div className="modal-body repair-body">
      {error && <div className="alert alert-error" role="alert">{error}{jobId && <button className="btn btn-secondary btn-sm" onClick={() => setPollVersion(version => version + 1)}>Check recovery status</button>}</div>}
      {!context || !configuration ? <p>{error ? "Close and reopen this issue to load it again." : "Loading saved OEM examples…"}</p> : <>
        <div className="repair-scope"><strong>{context.incident.oem_name || "OEM"}</strong><span>{context.total.toLocaleString()} quarantined events in this issue</span><span>This connection only</span></div>
        {step === 0 && <>
          <h3>What changed in the OEM data?</h3><p className="text-muted">Use original saved examples to diagnose the change. No data is changed during inspection or testing.</p>
          <label className="repair-label">Problem to solve<select className="input-field" value={scenario} onChange={event => setScenario(event.target.value)}>{cases.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
          <div className="alert alert-info">{cases.find(([id]) => id === scenario)?.[2]}</div>
          <label className="repair-label">Saved example<select className="input-field" value={sampleIndex} onChange={event => setSampleIndex(Number(event.target.value))}>{context.samples.map((sample: any, index: number) => <option key={sample.id} value={index}>Example {index + 1} · {sample.source_vehicle_id} · {new Date(sample.recorded_at).toLocaleString()}</option>)}</select></label>
          {context.samples[sampleIndex] ? <div className="repair-payload"><table className="data-table"><thead><tr><th>OEM field</th><th>Value in selected example</th></tr></thead><tbody>{context.paths.map((field: any) => <tr key={field.path}><td className="mono">{field.path}</td><td>{showValue(atPath(context.samples[sampleIndex].payload, field.path)).slice(0, 160)}</td></tr>)}</tbody></table><details><summary>View original JSON for the selected example</summary><pre>{JSON.stringify(context.samples[sampleIndex].payload, null, 2)}</pre></details></div> : <div className="alert alert-success">No quarantined events remain in this issue.</div>}
          <button className="btn btn-primary" disabled={!context.samples.length} onClick={() => setStep(1)}>Map the fields</button>
        </>}
        {step === 1 && <>
          <h3>Connect OEM fields to vehicle measurements</h3><p className="text-muted">Existing rules are a starting point. Check the source and units for each measurement. An optional missing value stays unknown.</p>
          {(published || profile?.status === "RETIRED") && <div className="alert alert-info">This version is locked. <button className="btn btn-secondary btn-sm" onClick={newVersion}>Create a new version</button></div>}
          <fieldset disabled={published || busy || profile?.status === "RETIRED"} className="repair-fieldset">
            <label className="repair-label">Mapping name<input className="input-field" maxLength={100} value={configuration.name} onChange={event => change({ ...configuration, name: event.target.value })} /></label>
            <div className="repair-rule-list">{configuration.rules.map((rule, index) => {
              const signal = context.signals.find((item: any) => item.id === rule.signal_id);
              const missing = !rule.sources.some(source => context.paths.some((field: any) => field.path === source));
              return <div className="repair-rule" key={rule.signal_id}>
                <div className="repair-rule-title"><strong>{label(signal?.name || rule.signal_id)} {signal?.unit && <small>({signal.unit})</small>}</strong>{missing && <span className="repair-warning">Source not found</span>}<button className="btn btn-ghost btn-sm" disabled={rule.signal_id === "sig_event_time"} aria-label={`Remove ${signal?.name} mapping`} onClick={() => change({ ...configuration, rules: configuration.rules.filter((_, i) => i !== index) })}>Remove</button></div>
                <div className="repair-rule-inputs"><label className="repair-label">OEM source<select className="input-field" value={rule.sources[0] || ""} onChange={event => changeRule(index, { sources: [event.target.value, ...rule.sources.slice(1)] })}>{pathOptions(rule.sources[0])}</select></label><label className="repair-label">Conversion<select className="input-field" value={rule.conversion} onChange={event => changeRule(index, { conversion: event.target.value, ...(event.target.value === "ENUM_MAP" ? { enum_map: rule.enum_map || {} } : {}), ...(event.target.value === "SCALE_OFFSET" ? { scale: 1, offset: 0 } : {}) })}>{Object.entries(conversions).map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label><label className="repair-check"><input type="checkbox" checked={rule.required} disabled={rule.signal_id === "sig_event_time"} onChange={event => changeRule(index, { required: event.target.checked })} /> Required</label></div>
                <details className="repair-fallback"><summary>Fallback for older formats {rule.sources.length > 1 ? `(${rule.sources.length - 1})` : ""}</summary>{rule.sources.slice(1).map((source, sourceIndex) => <div className="repair-enum-row" key={sourceIndex}><select className="input-field" aria-label="Fallback OEM source" value={source} onChange={event => changeRule(index, { sources: rule.sources.map((item, i) => i === sourceIndex + 1 ? event.target.value : item) })}>{pathOptions(source)}</select><button className="btn btn-ghost btn-sm" onClick={() => changeRule(index, { sources: rule.sources.filter((_, i) => i !== sourceIndex + 1) })}>Remove</button></div>)}<button className="btn btn-secondary btn-sm" disabled={rule.sources.length >= 5} onClick={() => changeRule(index, { sources: [...rule.sources, ""] })}>Add fallback field</button><p className="text-muted">The first non-null source is used. Put the preferred new field first.</p></details>
                {rule.conversion === "ENUM_MAP" && <div className="repair-enums"><strong>OEM value → platform value</strong>{Object.entries(rule.enum_map || {}).map(([key, value]) => <div className="repair-enum-row" key={key}><span className="mono">{key}</span><input className="input-field" aria-label={`Platform value for ${key}`} value={value} placeholder="e.g. ON, OFF, YES, NO" onChange={event => changeRule(index, { enum_map: { ...rule.enum_map, [key]: event.target.value } })} /><button className="btn btn-ghost btn-sm" aria-label={`Remove value ${key}`} onClick={() => { const map = { ...rule.enum_map }; delete map[key]; changeRule(index, { enum_map: map }); }}>Remove</button></div>)}<button className="btn btn-secondary btn-sm" onClick={() => {
                  const values = context.samples.map((sample: any) => rule.sources.reduce((found: any, path) => found ?? path.split(".").reduce((value: any, part) => value?.[part], sample.payload), undefined)).filter((value: any) => value !== undefined && value !== null);
                  const map = { ...rule.enum_map }; values.forEach((value: any) => { if (!Object.prototype.hasOwnProperty.call(map, String(value))) map[String(value)] = ""; }); changeRule(index, { enum_map: map });
                }}>Add codes from saved examples</button><label className="repair-label">Add another OEM code<input className="input-field" placeholder="Type a code, then press Enter" onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); const input = event.currentTarget; if (input.value.trim()) { changeRule(index, { enum_map: { ...rule.enum_map, [input.value.trim()]: "" } }); input.value = ""; } } }} /></label></div>}
                {rule.conversion === "SCALE_OFFSET" && <div className="repair-rule-inputs"><label className="repair-label">Multiply by<input className="input-field" type="number" step="any" value={rule.scale ?? 1} onChange={event => changeRule(index, { scale: Number(event.target.value) })} /></label><label className="repair-label">Then add<input className="input-field" type="number" step="any" value={rule.offset ?? 0} onChange={event => changeRule(index, { offset: Number(event.target.value) })} /></label></div>}
              </div>;
            })}</div>
            <label className="repair-label">Add a measurement<select className="input-field" value="" onChange={event => { if (event.target.value) change({ ...configuration, rules: [...configuration.rules, { signal_id: event.target.value, sources: [""], conversion: "DIRECT", required: false }] }); }}><option value="">Choose a platform measurement…</option>{context.signals.filter((signal: any) => !configuration.rules.some(rule => rule.signal_id === signal.id)).map((signal: any) => <option key={signal.id} value={signal.id}>{label(signal.name)} {signal.unit || ""}</option>)}</select></label>
            <div className="repair-deployment"><h3>Where should this mapping apply?</h3><select className="input-field" aria-label="Mapping application scope" value={configuration.live_mode} onChange={event => change({ ...configuration, live_mode: event.target.value })}><option value="invalid_only">Rejected formats on this connection + historical recovery</option><option value="replay_only">Historical recovery only; keep live ingestion unchanged</option><option value="matching">All matching formats on this connection + historical recovery</option></select>{configuration.live_mode === "matching" && <p className="repair-warning">This can change recognized live data. Use a format filter when the same field name has different meanings or units.</p>}<label className="repair-check"><input type="checkbox" checked={!!configuration.discriminator} onChange={event => change({ ...configuration, discriminator: event.target.checked ? { path: "", value: "" } : undefined })} /> Only apply when an OEM format/version field matches</label>{configuration.discriminator && <div className="repair-rule-inputs"><select className="input-field" aria-label="Format filter field" value={configuration.discriminator.path} onChange={event => change({ ...configuration, discriminator: { ...configuration.discriminator!, path: event.target.value } })}>{pathOptions(configuration.discriminator.path)}</select><input className="input-field" aria-label="Expected format filter value" placeholder="Expected value, e.g. v3" value={configuration.discriminator.value} onChange={event => change({ ...configuration, discriminator: { ...configuration.discriminator!, value: event.target.value } })} /></div>}</div>
          </fieldset>
          {!published && <button className="btn btn-primary" disabled={busy || !context.samples.length || profile?.status === "RETIRED"} onClick={test}>{busy ? "Saving and testing…" : "Save draft & test examples"}</button>}
        </>}
        {step === 2 && report && <>
          <h3>Review the results before applying</h3><div className="stats-grid"><div className="stat-card"><div className="stat-card-label">Examples tested</div><div className="stat-card-value">{report.sampled}</div></div><div className="stat-card"><div className="stat-card-label">Ready to recover</div><div className="stat-card-value text-success">{report.passed}</div></div><div className="stat-card"><div className="stat-card-label">Still blocked</div><div className="stat-card-value text-warning">{report.blocked}</div></div></div>
          <p className="text-muted">These are sampled oldest and newest events, not an estimate for the whole backlog. Recovery validates every event individually. Originals remain saved.</p>
          {report.regression_checked > 0 && <div className={`alert ${report.regression_failed ? "alert-error" : "alert-success"}`}>{report.regression_checked} recent recognized examples checked; {report.regression_failed} failed. Passing validates format and ranges, not whether an OEM's unit semantics are correct.</div>}
          {report.regression_changed > 0 && <details className="repair-payload"><summary>{report.regression_changed} recognized examples would produce changed measurements — review before publishing</summary><table className="data-table"><thead><tr><th>Measurement</th><th>Existing mapping</th><th>Proposed mapping</th></tr></thead><tbody>{report.regressions.flatMap((regression: any) => regression.changes.map((change: any) => <tr key={`${regression.id}-${change.signal}`}><td>{label(change.signal)}</td><td>{showValue(change.before)}</td><td>{showValue(change.after)}</td></tr>))}</tbody></table></details>}
          <select className="input-field" aria-label="Test result example" value={resultIndex} onChange={event => setResultIndex(Number(event.target.value))}>{report.results.map((result: any, index: number) => <option key={result.id} value={index}>Example {index + 1} · {result.success ? "Ready" : "Blocked"} · {result.id.slice(0, 8)}</option>)}</select>
          {currentResult && <><div className={currentResult.success ? "alert alert-success" : "alert alert-warning"}>{currentResult.success ? "This example can be normalized with this mapping." : currentResult.errors.join(" · ")}</div><div className="repair-payload"><table className="data-table"><thead><tr><th>Measurement</th><th>OEM field & original value</th><th>Mapped value</th><th>Result</th></tr></thead><tbody>{currentResult.fields.map((field: any) => <tr key={field.signal}><td>{label(field.signal)}</td><td><span className="mono">{field.source || "Missing"}</span><br />{showValue(field.raw).slice(0, 80)}</td><td>{showValue(field.value).slice(0, 120)}</td><td>{field.status}</td></tr>)}</tbody></table></div>{currentResult.warnings.length > 0 && <p className="text-muted">{currentResult.warnings.join(" · ")}</p>}</>}
          <button className="btn btn-secondary" onClick={() => setStep(1)}>Adjust mapping</button> <button className="btn btn-primary" disabled={!report.passed || !!report.regression_failed} onClick={() => setStep(3)}>Review application</button>
        </>}
        {step === 3 && <>
          <h3>{published ? "Mapping published" : "Apply this tested mapping"}</h3><p><strong>{configuration.name}</strong> · {configuration.rules.length} mapped measurements</p><div className="alert alert-info">{configuration.live_mode === "replay_only" ? "Historical recovery only. Live ingestion stays unchanged." : configuration.live_mode === "matching" ? "Applies to matching live payloads on this connection and historical recovery." : "Applies to formats rejected by existing contracts on this connection and historical recovery."} {configuration.discriminator && `Filter: ${configuration.discriminator.path} = ${configuration.discriminator.value}.`}</div>
          {!published && profile?.status !== "RETIRED" && <><p>Publishing creates an immutable connection-specific version. Shared OEM mappings and other fleets are preserved. Recovering older events rebuilds their affected trips and maps.</p><label className="repair-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> I checked the source fields, conversions, timestamps, and test results.</label><button className="btn btn-primary" disabled={busy || !reviewed || !report?.passed || !!report?.regression_failed} onClick={publish}>{busy ? "Publishing…" : "Publish mapping"}</button></>}
          {published && <><p>Start recovery separately. Events that still fail remain quarantined with their reasons; valid history will be restored.</p><div className="repair-actions"><button className="btn btn-primary" disabled={busy || working || job?.status === "COMPLETED"} onClick={recover}>{working ? "Recovery is running…" : "Recover this issue’s events"}</button><button className="btn btn-secondary" disabled={busy || working} onClick={newVersion}>Create a new version</button><button className="btn btn-ghost" disabled={busy || working} onClick={disable}>Disable this mapping</button></div></>}
          {profile?.status === "RETIRED" && <div className="alert alert-warning">This mapping is disabled. Recovered history is retained. <button className="btn btn-secondary" onClick={newVersion}>Create a corrected version</button></div>}
          {job && <div className="repair-job" role="status"><strong>Recovery: {label(job.final_outcome || job.status)}</strong><progress max={100} value={job.progress_pct || 0} /><p>{job.processed_events || 0} recovered · {job.error_events || 0} still blocked · {job.total_events || 0} selected</p>{job.error_message && <div className="alert alert-error">{job.error_message}</div>}{job.status === "COMPLETED" && job.error_events > 0 && <p>Review the remaining issues for invalid measurements, missing fields, or vehicle mappings. They were not replaced with guessed data.</p>}</div>}
        </>}
      </>}
    </div><div className="modal-footer"><span className="text-muted">Saved drafts can be reopened. Closing this screen does not stop a recovery job.</span><button className="btn btn-secondary" onClick={onClose}>Close</button></div>
  </section></div>;
}
