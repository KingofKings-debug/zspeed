import { useEffect, useState } from "react";
import { api } from "../api";
import RepairWorkbench from "./RepairWorkbench";
import { baselineRules, repairModes, modeForCategory, changedFields, unusedFields, type RepairMode } from "../repair-plan";
import { measurementName, suggestedSource, timeConversion, fieldAction } from "../repair-guidance";

interface Rule { signal_id: string; sources: string[]; conversion: string; required: boolean; enum_map?: Record<string, string>; scale?: number; offset?: number }
interface Configuration { name: string; rules: Rule[]; live_mode: string; discriminator?: { path: string; value: string }; field_decisions?: Record<string, "IGNORE" | "REMOVED"> }
const conversions: Record<string, string> = {
  DIRECT: "As supplied", MPH_TO_KMH: "Miles per hour", MILES_TO_KM: "Miles", FRACTION_TO_PERCENT: "Battery fraction (0 to 1)", METRES_TO_KM: "Metres", CELSIUS_FROM_FAHRENHEIT: "Fahrenheit", MICRODEGREES_TO_DEGREES: "Location as whole numbers (microdegrees)", ISO_TIME: "Date and time (e.g. 2026-10-01T10:00:00Z)", UNIX_SECONDS: "Time number in seconds (e.g. 1790856000)", UNIX_MILLISECONDS: "Time number in milliseconds (e.g. 1790856000000)", ENUM_MAP: "Status codes — choose what they mean", SCALE_OFFSET: "Custom units",
};
const showValue = (value: any) => value === null || value === undefined ? "Unknown" : typeof value === "object" ? JSON.stringify(value) : String(value);
const label = measurementName;
const atPath = (payload: any, path: string) => payload?.[path] ?? path.split(".").reduce((value: any, part) => value?.[part], payload);

function startingConfiguration(context: any): Configuration {
  const paths = new Set(context.paths.map((field: any) => field.path));
  let rules: Rule[] = baselineRules(context).map(rule => ({ ...rule, sources: [...rule.sources] }));
  if (!rules.length) rules.push({ signal_id: "sig_speed", sources: ["speed"], conversion: "DIRECT", required: true });
  if (!rules.some(rule => rule.signal_id === "sig_event_time")) {
    const timeField = context.paths.find((field: any) => /timestamp|time_measured|event_time|recorded_at/.test(field.path));
    rules.push({ signal_id: "sig_event_time", sources: [timeField?.path || "timestamp"], conversion: timeField?.type === "number" ? (Number(timeField.example) > 1e11 ? "UNIX_MILLISECONDS" : "UNIX_SECONDS") : "ISO_TIME", required: true });
  }
  for (const rule of rules) {
    if (!paths.has(rule.sources[0])) {
      const suggestion = suggestedSource(rule.signal_id, context.paths);
      if (suggestion) rule.sources = [suggestion, ...rule.sources.filter(source => source !== suggestion)].slice(0, 5);
    }
    if (rule.signal_id === "sig_event_time") rule.conversion = timeConversion(context.paths.find((field: any) => field.path === rule.sources[0])?.example);
  }
  rules = rules.filter(rule => rule.required || rule.sources.some(source => paths.has(source)));
  if (rules.length === 1) rules.push({ signal_id: "sig_speed", sources: [""], conversion: "DIRECT", required: false });
  const priority = ["sig_event_time", "sig_speed", "sig_latitude", "sig_longitude", "sig_soc", "sig_odometer", "sig_ignition", "sig_heading"];
  rules.sort((a, b) => (priority.includes(a.signal_id) ? priority.indexOf(a.signal_id) : 99) - (priority.includes(b.signal_id) ? priority.indexOf(b.signal_id) : 99));
  return { name: `${context.incident.oem_name || "OEM"} format repair`, rules, live_mode: "invalid_only" };
}

export default function MappingRepair({ incidentId, onClose, onComplete, onConnections }: { incidentId: string; onClose: () => void; onComplete: () => void; onConnections?: () => void }) {
  const [context, setContext] = useState<any>(null);
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [profile, setProfile] = useState<{ id: string; revision: number; status: string } | null>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<any>(null);
  const [sampleIndex, setSampleIndex] = useState(0);
  const [resultIndex, setResultIndex] = useState(0);
  const [readingIndex, setReadingIndex] = useState(0);
  const [repairMode, setRepairMode] = useState<RepairMode>("fields");
  const [requestSaved, setRequestSaved] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [pollVersion, setPollVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.getRepairContext(incidentId).then(data => {
      if (cancelled) return;
      setContext(data);
      const target = data.affected_signals?.[0];
      setRepairMode(target?.id === 'sig_event_time' ? 'time' : ['sig_latitude','sig_longitude'].includes(target?.id) ? 'location' : target?.data_type === 'STRING' ? 'codes' : modeForCategory(data.incident.failure_category));
      if(data.nextAction === "readings") setStep(1);
      const initial = data.existing?.configuration || startingConfiguration(data);
      setConfiguration(initial);
      setReadingIndex(Math.max(0, initial.rules.findIndex((rule: Rule) => rule.signal_id === target?.id)));
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
      const recovery = await api.replayMappingRepair(profile.id);
      setJobId(recovery.jobId); setPollVersion(version => version + 1);
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
  function downloadRequest() {
    const provider = context.incident.oem_name || "Vehicle data provider";
    const text = [`Correction request: ${provider}`, `Issue: ${incidentId}`, `Connection: ${context.incident.connection_id}`,
      context.conflicts?.length ? "Please resend the held readings with a unique record number for each reading. The same record number was received with different values." : "Please resend the held records as complete vehicle readings with a reading time and valid location/measurement values.",
      `Held records in this issue: ${context.total}`, `Examples included: ${context.samples.length}`,
      ...context.conflicts.map((conflict: any) => JSON.stringify(conflict, null, 2)),
      context.conflicts.length ? "" : JSON.stringify(context.samples, null, 2)].join("\n\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `vehicle-data-correction-${incidentId}.txt`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setRequestSaved(true);
  }
  const currentResult = report?.results[resultIndex];
  const published = profile?.status === "ACTIVE";
  const working = job && !["COMPLETED", "FAILED"].includes(job.status);
  const needsProvider = context?.nextAction === "provider";
  const needsConnection = ["reconnect", "vehicle"].includes(context?.nextAction);

  const pathOptions = (value: string) => <>
    <option value="">Choose the matching reading…</option>
    {value && !context.paths.some((field: any) => field.path === value) && <option value={value}>{value} — not present in these examples</option>}
    {context.paths.map((field: any) => <option key={field.path} value={field.path}>{label(field.path.split('.').pop())} · {showValue(field.example).slice(0, 45)}{field.path.includes('.') ? ` (${field.path})` : ''}</option>)}
  </>;

  return <div className="modal-overlay"><section className="modal repair-modal" role="dialog" aria-modal="true" aria-labelledby="repair-title">
    <div className="modal-header"><div><h2 id="repair-title" className="modal-title">{needsProvider || needsConnection ? "Review held readings" : repairModes.find(item => item.id === repairMode)?.title}</h2><p className="text-muted">Review readings · Preview · Restore</p></div><button className="close-btn" aria-label="Close mapping repair" onClick={onClose}>✕</button></div>
    <div className="repair-steps" aria-label="Repair steps" hidden={needsProvider || needsConnection}>{["1. Choose repair", "2. Fix readings", "3. Preview", "4. Restore"].map((title, index) => <button key={title} className={step === index ? "active" : ""} disabled={busy || !context || (index === 2 && !report) || (index === 3 && !published && !report && !job && profile?.status !== "RETIRED")} onClick={() => setStep(index)}>{title}</button>)}</div>
    <div className="modal-body repair-body">
      {error && <div className="alert alert-error" role="alert">{error}{jobId && <button className="btn btn-secondary btn-sm" onClick={() => setPollVersion(version => version + 1)}>Check recovery status</button>}</div>}
      {!context || !configuration ? <p>{error ? "Close and reopen this issue to load it again." : "Loading saved OEM examples…"}</p> : <>
        <div className="repair-scope"><strong>{context.incident.oem_name || "OEM"}</strong><span>{context.total.toLocaleString()} readings waiting for review</span></div>
        {(needsProvider || needsConnection) ? <div className="repair-guided-start">
          <h3>{needsConnection ? context.nextAction === "reconnect" ? "Reconnect your vehicle account" : "Choose which vehicle these readings belong to" : context.conflicts.length ? "One record number, different readings" : "The received records are incomplete"}</h3>
          {needsConnection ? <button className="btn btn-primary" onClick={onConnections}>Open Connections</button> : <>
            {context.conflicts.length > 0 && <><label className="repair-label">Vehicle record<select className="input-field" value={sampleIndex} onChange={event => setSampleIndex(Number(event.target.value))}>{context.conflicts.map((conflict: any, index: number) => <option key={conflict.id} value={index}>{conflict.vehicle} · Record {conflict.reference}</option>)}</select></label>
              {context.conflicts[sampleIndex] && <div className="repair-payload"><table className="data-table"><thead><tr><th>Reading</th><th>Received earlier</th><th>Held for review</th></tr></thead><tbody>
                <tr><td>Vehicle</td><td>{context.conflicts[sampleIndex].previous?.vehicle || "Unavailable"}</td><td>{context.conflicts[sampleIndex].vehicle}</td></tr>
                <tr><td>Received</td><td>{context.conflicts[sampleIndex].previous ? new Date(context.conflicts[sampleIndex].previous.received_at).toLocaleString() : "Unavailable"}</td><td>{new Date(context.conflicts[sampleIndex].received_at).toLocaleString()}</td></tr>
                {context.conflicts[sampleIndex].differences.map((field: any) => <tr key={field.field}><td>{label(field.field.split('.').pop())}</td><td>{showValue(field.saved)}</td><td className="repair-warning">{showValue(field.incoming)}</td></tr>)}
              </tbody></table></div>}
            </>}
            <div className="repair-next-action"><strong>Next step: request corrected records from {context.incident.oem_name || "your vehicle data provider"}</strong><button className="btn btn-primary" onClick={downloadRequest}>{requestSaved ? "Download request again" : "Download correction request"}</button>{requestSaved && <span role="status">Request ready to share with your provider</span>}</div>
            <div className="alert alert-success">Your existing vehicle history is kept. These readings remain held for review.</div>
          </>}
        </div> : <>
        {step === 0 && <>
          <h3>What changed in these readings?</h3>
          <div className="repair-type-cards">{repairModes.map(item => <button className="repair-type-card" key={item.id} onClick={() => { setRepairMode(item.id); setStep(1); }}><strong>{item.title}</strong><span>{item.action}</span>{item.id === "fields" && <small>{changedFields(context, configuration).length} previous fields to review</small>}{item.id === "added" && <small>{unusedFields(context, configuration).length} unmatched incoming fields</small>}</button>)}</div>
        </>}
        {step === 1 && <>
          <RepairWorkbench context={context} configuration={configuration} onChange={change} mode={repairMode} onModeChange={setRepairMode} disabled={busy || published || profile?.status === "RETIRED"} focusSignal={configuration.rules[readingIndex]?.signal_id} />
          {(published || profile?.status === "RETIRED") && <div className="alert alert-info">This version is locked. <button className="btn btn-secondary btn-sm" onClick={newVersion}>Create a new version</button></div>}
          <details className="repair-advanced"><summary>More options: additional readings, status codes and older formats</summary>
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
          </fieldset></details>
        </>}
        {step === 2 && report && <>
          <h3>Review the results before applying</h3><div className="stats-grid"><div className="stat-card"><div className="stat-card-label">Examples tested</div><div className="stat-card-value">{report.sampled}</div></div><div className="stat-card"><div className="stat-card-label">Ready to recover</div><div className="stat-card-value text-success">{report.passed}</div></div><div className="stat-card"><div className="stat-card-label">Still blocked</div><div className="stat-card-value text-warning">{report.blocked}</div></div></div>
          <p className="text-muted">Preview of {report.sampled} saved examples. Every reading is checked during restoration.</p>
          {report.regression_checked > 0 && <div className={`alert ${report.regression_failed ? "alert-error" : "alert-success"}`}>{report.regression_checked} recent recognized examples checked; {report.regression_failed} failed. Passing validates format and ranges, not whether an OEM's unit semantics are correct.</div>}
          {report.regression_changed > 0 && <details className="repair-payload"><summary>{report.regression_changed} recognized examples would produce changed measurements — review before publishing</summary><table className="data-table"><thead><tr><th>Measurement</th><th>Existing mapping</th><th>Proposed mapping</th></tr></thead><tbody>{report.regressions.flatMap((regression: any) => regression.changes.map((change: any) => <tr key={`${regression.id}-${change.signal}`}><td>{label(change.signal)}</td><td>{showValue(change.before)}</td><td>{showValue(change.after)}</td></tr>))}</tbody></table></details>}
          <select className="input-field" aria-label="Test result example" value={resultIndex} onChange={event => setResultIndex(Number(event.target.value))}>{report.results.map((result: any, index: number) => <option key={result.id} value={index}>Example {index + 1} · {result.success ? "Ready" : "Blocked"} · {result.id.slice(0, 8)}</option>)}</select>
          {currentResult && <><div className={currentResult.success ? "alert alert-success" : "alert alert-warning"}>{currentResult.success ? "These readings are ready to restore." : currentResult.nextAction === "provider" ? "This record needs a correction from your vehicle data provider." : ["vehicle", "reconnect"].includes(currentResult.nextAction) ? "Your vehicle connection needs attention." : "Select the highlighted measurement to fix it."}</div>{!currentResult.success && currentResult.nextAction === "provider" && <button className="btn btn-primary" onClick={downloadRequest}>Download correction request</button>}{!currentResult.success && ["vehicle", "reconnect"].includes(currentResult.nextAction) && <button className="btn btn-primary" onClick={onConnections}>Open Connections</button>}<div className="repair-payload"><table className="data-table"><thead><tr><th>Measurement</th><th>Received reading</th><th>Mapped value</th><th>Result</th></tr></thead><tbody>{currentResult.fields.map((field: any) => <tr key={field.signal}><td>{label(field.signal)}</td><td><span className="mono">{field.source || "Missing"}</span><br />{showValue(field.raw).slice(0, 80)}</td><td>{showValue(field.value).slice(0, 120)}</td><td>{field.status === "blocked" ? <button className="btn btn-secondary btn-sm" onClick={() => { const index = configuration.rules.findIndex(rule => context.signals.find((item: any) => item.id === rule.signal_id)?.name === field.signal); setReadingIndex(Math.max(0, index)); setRepairMode(field.signal === "event_time" ? "time" : ["latitude", "longitude"].includes(field.signal) ? "location" : context.signals.find((item: any) => item.name === field.signal)?.data_type === "STRING" ? "codes" : field.raw == null ? "fields" : "units"); setStep(1); }}>{fieldAction(field)}</button> : fieldAction(field)}</td></tr>)}</tbody></table></div><details><summary>Record checks</summary><ul>{currentResult.errors.map((message: string, index: number) => <li key={index}>{message}</li>)}</ul></details></>}
          <button className="btn btn-secondary" onClick={() => setStep(1)}>Change a reading</button> <button className="btn btn-primary" disabled={!report.passed || !!report.regression_failed} onClick={() => setStep(3)}>Continue to restore</button>
        </>}
        {step === 3 && <>
          <h3>{published ? "Repair enabled" : "Restore your vehicle readings"}</h3><p><strong>{configuration.rules.length} vehicle measurements</strong></p><div className="alert alert-info">{configuration.live_mode === "replay_only" ? "Restore saved readings only." : configuration.live_mode === "matching" ? "Restore saved readings and use this repair for matching new readings." : "Restore saved readings and use this repair for new readings that need it."} {configuration.discriminator && `Filter: ${configuration.discriminator.path} = ${configuration.discriminator.value}.`}</div>
          {!published && profile?.status !== "RETIRED" && <><label className="repair-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /> The preview shows the correct readings and units.</label><button className="btn btn-primary" disabled={busy || !reviewed || !report?.passed || !!report?.regression_failed} onClick={publish}>{busy ? "Applying…" : "Restore valid readings"}</button></>}
          {published && <><div className="repair-actions"><button className="btn btn-primary" disabled={busy || working || job?.status === "COMPLETED"} onClick={recover}>{working ? "Recovery is running…" : "Restore saved readings"}</button><button className="btn btn-secondary" disabled={busy || working} onClick={newVersion}>Create a new version</button><button className="btn btn-ghost" disabled={busy || working} onClick={disable}>Disable this mapping</button></div></>}
          {profile?.status === "RETIRED" && <div className="alert alert-warning">This mapping is disabled. Recovered history is retained. <button className="btn btn-secondary" onClick={newVersion}>Create a corrected version</button></div>}
          {job && <div className="repair-job" role="status"><strong>Recovery: {label(job.final_outcome || job.status)}</strong><progress max={100} value={job.progress_pct || 0} /><p>{job.processed_events || 0} recovered · {job.error_events || 0} still blocked · {job.total_events || 0} selected</p>{job.error_message && <div className="alert alert-error">{job.error_message}</div>}{job.status === "COMPLETED" && job.error_events > 0 && <p>Review the remaining issues for invalid measurements, missing fields, or vehicle mappings. They were not replaced with guessed data.</p>}</div>}
        </>}
      </>}
      </>}
    </div><div className="modal-footer"><span className="text-muted">Saved drafts can be reopened. Closing this screen does not stop a recovery job.</span>{step === 1 && context && !needsProvider && !needsConnection && !published && <button className="btn btn-primary" disabled={busy || !context.samples.length || profile?.status === "RETIRED"} onClick={test}>{busy ? "Checking readings…" : "Preview repaired readings"}</button>}<button className="btn btn-secondary" onClick={onClose}>Close</button></div>
  </section></div>;
}
