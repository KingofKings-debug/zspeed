import { describe, it, expect } from 'vitest';
import { suggestedSource, timeConversion, availableUnits, fieldAction, measurementName, statusChoices } from '../../../frontend/src/repair-guidance';

describe('Fleet manager repair choices', () => {
  it('suggests a renamed nested reading only when there is one clear match', () => {
    expect(suggestedSource('sig_speed', [{path: 'telemetry.velocity'}])).toBe('telemetry.velocity');
    expect(suggestedSource('sig_speed', [{path: 'old.speed'}, {path: 'new.speed'}])).toBeUndefined();
    expect(suggestedSource('sig_speed', [{path: 'engine.rotation'}])).toBeUndefined();
  });
  it('offers the right date format for numeric seconds, milliseconds and date text', () => {
    expect(timeConversion(1790856000)).toBe('UNIX_SECONDS');
    expect(timeConversion('1790856000000')).toBe('UNIX_MILLISECONDS');
    expect(timeConversion('2026-10-01T10:00:00Z')).toBe('ISO_TIME');
  });
  it('keeps unit choices relevant to each measurement', () => {
    expect(availableUnits('sig_speed')).toEqual(['DIRECT', 'MPH_TO_KMH']);
    expect(availableUnits('sig_event_time')).not.toContain('DIRECT');
    expect(availableUnits('sig_soc')).toContain('FRACTION_TO_PERCENT');
  });
  it('turns blocked readings into specific repair actions', () => {
    expect(fieldAction({status:'blocked', signal:'latitude', raw:900})).toBe('Check location and units');
    expect(fieldAction({status:'blocked', signal:'event_time', raw:null})).toBe('Choose a reading');
    expect(fieldAction({status:'missing', signal:'odometer'})).toBe('Not supplied');
    expect(fieldAction({status:'mapped', signal:'vehicle_speed', raw:0})).toBe('Ready');
  });
  it('uses everyday measurement and engine status names', () => {
    expect(measurementName('event_time')).toBe('Reading time');
    expect(statusChoices('sig_ignition')).toEqual([{value:'ON',label:'On'}, {value:'OFF',label:'Off'}]);
  });
});
