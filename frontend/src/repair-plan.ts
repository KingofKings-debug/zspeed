import { suggestedSource, timeConversion } from './repair-guidance';

export interface RepairRule { signal_id: string; sources: string[]; conversion: string; required: boolean; enum_map?: Record<string,string>; scale?: number; offset?: number }
export interface RepairConfiguration { name: string; rules: RepairRule[]; live_mode: string; discriminator?: {path:string;value:string}; field_decisions?: Record<string,'IGNORE'|'REMOVED'> }
export type RepairMode = 'fields'|'units'|'added'|'removed'|'codes'|'time'|'location';
export const repairModes: {id:RepairMode;title:string;action:string}[] = [
  {id:'fields',title:'Fix changed field names',action:'Match old and new fields'},
  {id:'units',title:'Fix measurement units',action:'Choose the units being sent'},
  {id:'added',title:'Set up new readings',action:'Use a new field or leave it unused'},
  {id:'removed',title:'Handle missing readings',action:'Stop expecting a removed field'},
  {id:'codes',title:'Fix changed status codes',action:'Choose what each status means'},
  {id:'time',title:'Fix reading dates and times',action:'Choose the date format'},
  {id:'location',title:'Fix map coordinates',action:'Match latitude, longitude and units'},
];
export function modeForCategory(category:string): RepairMode {
  if(category==='INVALID_TIME') return 'time';
  if(category==='INVALID_COORDINATES') return 'location';
  if(['INVALID_VALUE','TYPE_ERROR'].includes(category)) return 'units';
  return 'fields';
}
export const valueAt = (payload:any,path:string): any => payload && Object.prototype.hasOwnProperty.call(payload,path) ? payload[path] : path.split('.').reduce((value,part)=>value?.[part],payload);
export function baselineRules(context:any): RepairRule[] {
  if(context.baseline) return context.baseline.rules.filter((rule:RepairRule)=>rule.required||rule.sources.some(source=>valueAt(context.baseline.sample,source)!=null));
  const paths=new Set(context.paths.map((field:any)=>field.path));
  const template=[...context.templates].sort((a:any,b:any)=>b.rules.filter((rule:any)=>paths.has(rule.source_field_path)).length-a.rules.filter((rule:any)=>paths.has(rule.source_field_path)).length)[0];
  return (template?.rules||[]).map((rule:any)=>({signal_id:rule.destination_signal_id,sources:[rule.source_field_path],conversion:rule.destination_signal_id==='sig_event_time'?timeConversion(context.paths.find((field:any)=>field.path===rule.source_field_path)?.example):rule.conversion_type,required:rule.destination_signal_id==='sig_event_time',...(rule.enum_mapping?{enum_map:JSON.parse(rule.enum_mapping)}:{})}));
}
export function changedFields(context:any,configuration:RepairConfiguration) {
  const old=baselineRules(context);
  const paths=new Set(context.paths.map((field:any)=>field.path));
  return old.filter(rule=>!rule.sources.some(source=>paths.has(source))).map(rule=>({rule,current:configuration.rules.find(current=>current.signal_id===rule.signal_id),suggestion:suggestedSource(rule.signal_id,context.paths)}));
}
export function unusedFields(context:any,configuration:RepairConfiguration) {
  const used=new Set(configuration.rules.flatMap(rule=>rule.sources));
  const known=new Set(baselineRules(context).flatMap(rule=>rule.sources));
  return context.paths.filter((field:any)=>!used.has(field.path)&&!known.has(field.path));
}
export function setReading(configuration:RepairConfiguration,signalId:string,path:string,example:unknown): RepairConfiguration {
  const existing=configuration.rules.find(rule=>rule.signal_id===signalId);
  const rule:RepairRule={signal_id:signalId,sources:[path,...(existing?.sources||[]).filter(source=>source!==path)].filter(Boolean).slice(0,5),conversion:signalId==='sig_event_time'?timeConversion(example):existing?.conversion||'DIRECT',required:signalId==='sig_event_time'||existing?.required===true,...(existing?.enum_map?{enum_map:existing.enum_map}:{}),...(existing?.scale!==undefined?{scale:existing.scale,offset:existing.offset}:{})};
  const decisions={...configuration.field_decisions}; delete decisions[path];
  return {...configuration,rules:existing?configuration.rules.map(current=>current.signal_id===signalId?rule:current):[...configuration.rules,rule],field_decisions:decisions};
}
export function removeReading(configuration:RepairConfiguration,rule:RepairRule): RepairConfiguration {
  if(rule.signal_id==='sig_event_time') throw new Error('Choose another reading-time field first');
  const ids=['sig_latitude','sig_longitude'].includes(rule.signal_id)?['sig_latitude','sig_longitude']:[rule.signal_id];
  const removed=[rule,...configuration.rules.filter(current=>ids.includes(current.signal_id))];
  const remaining=configuration.rules.filter(current=>!ids.includes(current.signal_id));
  const sources=[...new Set(removed.flatMap(current=>current.sources))].filter(source=>source&&!remaining.some(current=>current.sources.includes(source)));
  return {...configuration,rules:remaining,field_decisions:{...configuration.field_decisions,...Object.fromEntries(sources.map(source=>[source,'REMOVED' as const]))}};
}
export function displayConverted(rule:RepairRule,raw:unknown): string {
  if(raw==null) return 'Not supplied';
  if(rule.conversion==='ENUM_MAP') return rule.enum_map?.[String(raw)]||'Choose its meaning';
  if(rule.conversion==='ISO_TIME') { const time=Date.parse(String(raw));return Number.isFinite(time)&&/(Z|[+-]\d{2}:?\d{2})$/i.test(String(raw))?new Date(time).toLocaleString():'Choose a date format'; }
  const number=(typeof raw==='number'||(typeof raw==='string'&&raw.trim()))?Number(raw):NaN;
  if(!Number.isFinite(number)) return rule.conversion==='DIRECT'?String(raw):'Check the reading';
  const conversions:Record<string,(value:number)=>number>={DIRECT:value=>value,MPH_TO_KMH:value=>value*1.60934,MILES_TO_KM:value=>value*1.60934,FRACTION_TO_PERCENT:value=>value*100,METRES_TO_KM:value=>value/1000,CELSIUS_FROM_FAHRENHEIT:value=>(value-32)*5/9,MICRODEGREES_TO_DEGREES:value=>value/1e6,SCALE_OFFSET:value=>value*(rule.scale??1)+(rule.offset??0)};
  if(['UNIX_SECONDS','UNIX_MILLISECONDS'].includes(rule.conversion)){const time=number*(rule.conversion==='UNIX_SECONDS'?1000:1);return Number.isFinite(time)&&time>0&&time<8.64e15?new Date(time).toLocaleString():'Check the reading time';}
  const result=conversions[rule.conversion]?.(number);
  return result!==undefined&&Number.isFinite(result)?Number(result.toFixed(5)).toString():'Check the units';
}
