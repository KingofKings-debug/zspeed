import { useEffect, useState } from 'react';
import { availableUnits, measurementName, statusChoices } from '../repair-guidance';
import { baselineRules, changedFields, displayConverted, removeReading, repairModes, setReading, unusedFields, valueAt, type RepairConfiguration, type RepairMode, type RepairRule } from '../repair-plan';

const show = (value:unknown) => value == null ? 'Not supplied' : String(value);
const unitNames:Record<string,string> = { MPH_TO_KMH:'Miles per hour', MILES_TO_KM:'Miles', FRACTION_TO_PERCENT:'Fraction (0–1)', METRES_TO_KM:'Metres', MICRODEGREES_TO_DEGREES:'Whole-number coordinates (microdegrees)', CELSIUS_FROM_FAHRENHEIT:'Fahrenheit', ISO_TIME:'Date with timezone', UNIX_SECONDS:'Time in seconds', UNIX_MILLISECONDS:'Time in milliseconds', ENUM_MAP:'Status codes', SCALE_OFFSET:'Custom units' };

export default function RepairWorkbench({context,configuration,onChange,mode,onModeChange,disabled,focusSignal}: {context:any;configuration:RepairConfiguration;onChange:(configuration:RepairConfiguration)=>void;mode:RepairMode;onModeChange:(mode:RepairMode)=>void;disabled:boolean;focusSignal?:string}) {
  const [sampleIndex,setSampleIndex]=useState(0);
  const [selected,setSelected]=useState(focusSignal||configuration.rules.find(rule=>rule.signal_id==='sig_speed')?.signal_id||configuration.rules[0]?.signal_id);
  const [recentAction,setRecentAction]=useState('');
  useEffect(()=>{if(focusSignal)setSelected(focusSignal);},[focusSignal]);
  const sample=context.samples[sampleIndex]?.payload;
  const oldRules=baselineRules(context);
  const changes=changedFields(context,configuration).sort((a,b)=>a.rule.signal_id==='sig_event_time'?1:b.rule.signal_id==='sig_event_time'?-1:0);
  const additions=unusedFields(context,configuration);
  const removed=changes.filter(({current}:any)=>!current?.sources.some((path:string)=>context.paths.some((field:any)=>field.path===path)));
  const pendingAdded=additions.filter((field:any)=>configuration.field_decisions?.[field.path]!=='IGNORE').length;
  const pendingRemoved=removed.filter(({rule}:any)=>configuration.field_decisions?.[rule.sources[0]]!=='REMOVED').length;
  const signal=(id:string)=>context.signals.find((item:any)=>item.id===id);
  const name=(id:string)=>measurementName(signal(id)?.name||id);
  const update=(id:string,patch:Partial<RepairRule>)=>onChange({...configuration,rules:configuration.rules.map(rule=>rule.signal_id===id?{...rule,...patch}:rule)});
  const choose=(id:string,path:string)=>{onChange(setReading(configuration,id,path,context.paths.find((field:any)=>field.path===path)?.example));setRecentAction(path?`${path} is now used for ${name(id)}`:'Choose an incoming field');};
  const options=<><option value="">Choose the matching field…</option>{context.paths.map((field:any)=><option key={field.path} value={field.path}>{field.path} · {show(field.example).slice(0,60)}</option>)}</>;
  const preview=(rule:RepairRule)=>{
    const raw=rule.sources.reduce((found:any,path)=>found??valueAt(sample,path),undefined);
    const converted=displayConverted(mode==='codes'&&statusChoices(rule.signal_id).length?{...rule,conversion:'ENUM_MAP'}:rule,raw);
    const spec=signal(rule.signal_id);
    const outside=raw!=null&&spec?.data_type==='NUMBER'&&(!Number.isFinite(Number(converted))||(spec.valid_range_min!=null&&Number(converted)<spec.valid_range_min)||(spec.valid_range_max!=null&&Number(converted)>spec.valid_range_max));
    return <div className={`repair-inline-preview ${outside?'repair-preview-invalid':''}`}>{!(mode==='fields'&&rule.signal_id==='sig_event_time')&&<><div><small>Received</small><strong>{show(raw)}</strong></div><span aria-hidden="true">→</span></>}<div><small>After this repair</small><strong>{converted} {rule.signal_id!=='sig_event_time'&&spec?.unit}</strong></div>{outside&&<><small>Outside the allowed range</small>{mode==='fields'?<button className="btn btn-secondary btn-sm" onClick={()=>{setSelected(rule.signal_id);onModeChange(['sig_latitude','sig_longitude'].includes(rule.signal_id)?'location':'units');}}>Fix units</button>:<small>Check the units or choose a different field</small>}</>}</div>;
  };
  const sourceControl=(id:string,current?:RepairRule)=><label className="repair-label">New field for {name(id)}<select className="input-field" value={current?.sources.find(source=>context.paths.some((field:any)=>field.path===source))||''} onChange={event=>choose(id,event.target.value)}>{options}</select></label>;
  const eligible=configuration.rules.filter(rule=>mode==='time'?rule.signal_id==='sig_event_time':mode==='location'?['sig_latitude','sig_longitude'].includes(rule.signal_id):mode==='codes'?signal(rule.signal_id)?.data_type==='STRING'&&rule.signal_id!=='sig_event_time':signal(rule.signal_id)?.data_type==='NUMBER');
  const current=eligible.find(rule=>rule.signal_id===selected)||eligible[0];
  const missingLocation=['sig_latitude','sig_longitude'].filter(id=>!configuration.rules.some(rule=>rule.signal_id===id));

  return <div className="repair-workbench">
    <nav className="repair-kind-tabs" aria-label="Type of repair">{repairModes.map(item=><button key={item.id} className={mode===item.id?'active':''} onClick={()=>onModeChange(item.id)}>{item.title}{item.id==='fields'&&changes.length>0&&<small>{changes.length}</small>}{item.id==='added'&&pendingAdded>0&&<small>{pendingAdded}</small>}{item.id==='removed'&&pendingRemoved>0&&<small>{pendingRemoved}</small>}</button>)}</nav>
    <div className="repair-workbench-heading"><label className="repair-label">Preview vehicle record<select className="input-field" value={sampleIndex} onChange={event=>setSampleIndex(Number(event.target.value))}>{context.samples.map((record:any,index:number)=><option key={record.id} value={index}>{record.source_vehicle_id} · Example {index+1}</option>)}</select></label>{recentAction&&<div className="repair-decision" role="status">✓ {recentAction}</div>}</div>
    <fieldset disabled={disabled} className="repair-fieldset">
      {mode==='fields'&&<>
        <div className="repair-match-heading"><span>Previously expected</span><span>Use this incoming field</span><span>Reading preview</span></div>
        {(changes.length?changes:configuration.rules.map(rule=>({rule:oldRules.find(old=>old.signal_id===rule.signal_id)||rule,current:rule}))).map(({rule,current}:any)=><div className="repair-match-row" key={rule.signal_id}>
          <div><strong>{name(rule.signal_id)}</strong><small className="mono">{rule.sources.join(' / ')}</small>{context.baseline&&<small>Last accepted: {show(rule.sources.reduce((found:any,path:string)=>found??valueAt(context.baseline.sample,path),undefined))}</small>}</div>
          <div>{sourceControl(rule.signal_id,current)}{rule.signal_id!=='sig_event_time'&&<button className="btn btn-ghost btn-sm" onClick={()=>onChange(removeReading(configuration,current||rule))}>{['sig_latitude','sig_longitude'].includes(rule.signal_id)?'Stop using map coordinates':'No longer sent'}</button>}</div>
          <div>{current?preview(current):<span className="repair-warning">{configuration.field_decisions?.[rule.sources[0]]==='REMOVED'?'No longer expected':'Choose a field'}</span>}</div>
        </div>)}
        <button className="btn btn-secondary" onClick={()=>onModeChange('units')}>Check measurement units</button>
      </>}
      {mode==='removed'&&<>
        {removed.length===0?<div className="alert alert-success">All previously expected fields have a match in these examples.</div>:removed.map(({rule}:any)=>{
          const accepted=configuration.field_decisions?.[rule.sources[0]]==='REMOVED';
          return <div className="repair-missing-card" key={rule.signal_id}><div><h4>{name(rule.signal_id)}</h4><span className="mono">{rule.sources.join(' / ')}</span><span className="repair-warning">Not supplied in the sampled records</span></div><div>{sourceControl(rule.signal_id,configuration.rules.find(current=>current.signal_id===rule.signal_id))}{rule.signal_id==='sig_event_time'?<strong>Choose another time field to continue</strong>:<button className={`btn ${accepted?'btn-secondary':'btn-primary'}`} onClick={()=>onChange(removeReading(configuration,configuration.rules.find(current=>current.signal_id===rule.signal_id)||rule))}>{accepted?'✓ No longer expected':['sig_latitude','sig_longitude'].includes(rule.signal_id)?'Stop using map coordinates':'Stop expecting this reading'}</button>}</div></div>;
        })}
        <div className="repair-outcome-note">Historical values stay saved. This repair will no longer require these readings.</div>
      </>}
      {mode==='added'&&<>
        {configuration.rules.filter(rule=>!oldRules.some(old=>old.signal_id===rule.signal_id)).map(rule=><div className="repair-added-row" key={rule.signal_id}><div><strong>✓ {name(rule.signal_id)} added</strong><small>{rule.sources[0]}</small></div>{preview(rule)}</div>)}
        {additions.length===0?<div className="alert alert-success">Every new field is already matched to a measurement.</div>:additions.map((field:any)=><div className="repair-added-row" key={field.path}><div><strong>{field.path}</strong><small>Received: {show(valueAt(sample,field.path))}</small></div><label className="repair-label">Use this field as<select className="input-field" aria-label={`Use ${field.path} as`} value={configuration.field_decisions?.[field.path]==='IGNORE'?'IGNORE':''} onChange={event=>{
          if(event.target.value==='IGNORE')onChange({...configuration,field_decisions:{...configuration.field_decisions,[field.path]:'IGNORE'}});
          else if(event.target.value)choose(event.target.value,field.path);
          else {const decisions={...configuration.field_decisions};delete decisions[field.path];onChange({...configuration,field_decisions:decisions});}
        }}><option value="">Choose a measurement…</option><option value="IGNORE">Keep in original record only</option>{context.signals.map((item:any)=><option key={item.id} value={item.id}>{measurementName(item.name)}{configuration.rules.some(rule=>rule.signal_id===item.id)?' — replace current field':''}</option>)}</select></label>{configuration.field_decisions?.[field.path]==='IGNORE'&&<span className="repair-decision">✓ Kept in original record</span>}</div>)}
        <details className="repair-advanced"><summary>Add another measurement</summary><label className="repair-label">Measurement<select className="input-field" value="" onChange={event=>{if(event.target.value){onChange({...configuration,rules:[...configuration.rules,{signal_id:event.target.value,sources:[''],conversion:event.target.value==='sig_event_time'?'ISO_TIME':'DIRECT',required:event.target.value==='sig_event_time'}]});setSelected(event.target.value);onModeChange(event.target.value==='sig_event_time'?'time':'fields');}}}><option value="">Choose a measurement…</option>{context.signals.filter((item:any)=>!configuration.rules.some(rule=>rule.signal_id===item.id)).map((item:any)=><option key={item.id} value={item.id}>{measurementName(item.name)}</option>)}</select></label></details>
      </>}
      {['units','time','codes','location'].includes(mode)&&<>
        {mode==='location'&&missingLocation.map(id=><div className="repair-guided-card" key={id}>{sourceControl(id)}</div>)}
        {eligible.length>1&&<label className="repair-label">Measurement to fix<select className="input-field" value={current?.signal_id||''} onChange={event=>setSelected(event.target.value)}>{eligible.map(rule=><option key={rule.signal_id} value={rule.signal_id}>{name(rule.signal_id)}</option>)}</select></label>}
        {current?<div className="repair-guided-card">{sourceControl(current.signal_id,current)}
          {mode!=='codes'&&<label className="repair-label">{mode==='time'?'The provider now sends time as':'The provider now sends this in'}<select className="input-field" value={current.conversion} onChange={event=>update(current.signal_id,{conversion:event.target.value,...(event.target.value==='SCALE_OFFSET'?{scale:1,offset:0}:{})})}>{[...new Set([...availableUnits(current.signal_id),...(signal(current.signal_id)?.unit==='°C'?['CELSIUS_FROM_FAHRENHEIT']:[]),current.conversion])].map(id=><option key={id} value={id}>{id==='DIRECT'?signal(current.signal_id)?.unit||'As supplied':unitNames[id]||id}</option>)}</select></label>}
          {mode==='codes'&&<div className="repair-code-choices">{[...new Set([...Object.keys(current.enum_map||{}),...context.samples.map((record:any)=>current.sources.reduce((found:any,path)=>found??valueAt(record.payload,path),undefined)).filter((value:any)=>value!=null).map(String)])].map(code=><label className="repair-label" key={code}>When the provider sends “{code}”, show{statusChoices(current.signal_id).length?<select className="input-field" value={current.enum_map?.[code]||''} onChange={event=>update(current.signal_id,{conversion:'ENUM_MAP',enum_map:{...current.enum_map,[code]:event.target.value}})}><option value="">Choose what it means…</option>{statusChoices(current.signal_id).map(choice=><option key={choice.value} value={choice.value}>{choice.label}</option>)}</select>:<input className="input-field" value={current.enum_map?.[code]||''} onChange={event=>update(current.signal_id,{conversion:'ENUM_MAP',enum_map:{...current.enum_map,[code]:event.target.value}})} />}</label>)}</div>}
          {current.conversion==='SCALE_OFFSET'&&<div className="repair-rule-inputs"><label className="repair-label">Multiply by<input className="input-field" type="number" step="any" value={current.scale??1} onChange={event=>update(current.signal_id,{scale:Number(event.target.value)})} /></label><label className="repair-label">Then add<input className="input-field" type="number" step="any" value={current.offset??0} onChange={event=>update(current.signal_id,{offset:Number(event.target.value)})} /></label></div>}
          {preview(current)}<small className="text-muted">Preview only · All saved examples are checked before applying</small>
        </div>:<div className="alert alert-info">Choose the incoming field under New readings to add this measurement.</div>}
      </>}
    </fieldset>
  </div>;
}
