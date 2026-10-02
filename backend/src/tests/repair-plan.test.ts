import { describe,it,expect } from 'vitest';
import { baselineRules, changedFields, unusedFields, setReading, removeReading, displayConverted, modeForCategory, type RepairConfiguration } from '../../../frontend/src/repair-plan';
const config=():RepairConfiguration=>({name:'Fleet repair',live_mode:'invalid_only',rules:[{signal_id:'sig_event_time',sources:['timestamp'],conversion:'ISO_TIME',required:true},{signal_id:'sig_speed',sources:['speed_mph'],conversion:'MPH_TO_KMH',required:false},{signal_id:'sig_odometer',sources:['odo'],conversion:'DIRECT',required:false}]});
const context=()=>({baseline:{rules:config().rules,sample:{timestamp:'2026-10-01T10:00:00Z',speed_mph:45,odo:300}},templates:[],paths:[{path:'timestamp',example:'2026-10-01T11:00:00Z'},{path:'telemetry.velocity',example:0},{path:'firmware',example:'v4'}]});
describe('Issue-specific self-service repair plans',()=>{
  it('opens different fixes for time, coordinates, values and format changes',()=>{
    expect(modeForCategory('INVALID_TIME')).toBe('time');expect(modeForCategory('INVALID_COORDINATES')).toBe('location');expect(modeForCategory('INVALID_VALUE')).toBe('units');expect(modeForCategory('SCHEMA_CHANGE')).toBe('fields');
  });
  it('compares received fields against the last working connection setup',()=>{
    expect(baselineRules(context())).toEqual(config().rules);
    expect(changedFields(context(),config()).map(change=>change.rule.signal_id)).toEqual(['sig_speed','sig_odometer']);
    expect(changedFields(context(),config())[0].suggestion).toBe('telemetry.velocity');
  });
  it('renames a field and keeps an older format as a fallback, including zero',()=>{
    const next=setReading(config(),'sig_speed','telemetry.velocity',0);
    expect(next.rules[1].sources).toEqual(['telemetry.velocity','speed_mph']);
    expect(displayConverted({...next.rules[1],conversion:'DIRECT'},0)).toBe('0');
    expect(unusedFields(context(),next).map((field:any)=>field.path)).toEqual(['firmware']);
  });
  it('adds supported readings and clears a prior unused-field decision',()=>{
    const next=setReading({...config(),field_decisions:{firmware:'IGNORE'}},'sig_fault_code','firmware','v4');
    expect(next.rules.find(rule=>rule.signal_id==='sig_fault_code')?.sources).toEqual(['firmware']);
    expect(next.field_decisions?.firmware).toBeUndefined();
    expect(config().rules).toHaveLength(3);
  });
  it('records a removed field, preserves other readings and prevents removing time',()=>{
    const original=config();const next=removeReading(original,original.rules[2]);
    expect(next.rules.map(rule=>rule.signal_id)).toEqual(['sig_event_time','sig_speed']);expect(next.field_decisions).toEqual({odo:'REMOVED'});expect(original.rules).toHaveLength(3);
    expect(()=>removeReading(original,original.rules[0])).toThrow('reading-time');
  });
  it('removes map coordinates as a pair when one coordinate is no longer supplied',()=>{
    const original={...config(),rules:[...config().rules,{signal_id:'sig_latitude',sources:['lat'],conversion:'DIRECT',required:false},{signal_id:'sig_longitude',sources:['lon'],conversion:'DIRECT',required:false}]};
    const next=removeReading(original,original.rules[3]);
    expect(next.rules.some(rule=>['sig_latitude','sig_longitude'].includes(rule.signal_id))).toBe(false);expect(next.field_decisions).toEqual({lat:'REMOVED',lon:'REMOVED'});
  });
  it.each([['MPH_TO_KMH',10,'16.0934'],['MILES_TO_KM',10,'16.0934'],['METRES_TO_KM',1500,'1.5'],['FRACTION_TO_PERCENT',0.7,'70'],['MICRODEGREES_TO_DEGREES',51500000,'51.5'],['CELSIUS_FROM_FAHRENHEIT',212,'100']])('previews %s conversion before saving',(conversion,value,expected)=>{
    expect(displayConverted({...config().rules[1],conversion:conversion as string},value)).toBe(expected);
  });
  it('keeps absent or invalid values visible instead of turning them into numbers',()=>{
    expect(displayConverted(config().rules[1],null)).toBe('Not supplied');expect(displayConverted(config().rules[1],{})).toBe('Check the reading');
    expect(displayConverted(config().rules[1],Infinity)).toBe('Check the reading');
    expect(displayConverted({...config().rules[1],conversion:'UNIX_SECONDS'},-1)).toBe('Check the reading time');
    expect(displayConverted({...config().rules[0],conversion:'ISO_TIME'},'2026-10-01 10:00:00')).toBe('Choose a date format');
  });
  it('previews a selected status meaning and flags unassigned codes',()=>{
    const rule={...config().rules[1],conversion:'ENUM_MAP',enum_map:{running:'ON'}};
    expect(displayConverted(rule,'running')).toBe('ON');expect(displayConverted(rule,'new-status')).toBe('Choose its meaning');
  });
});
