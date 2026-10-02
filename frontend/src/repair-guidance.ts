const names: Record<string, string> = { timestamp: 'Reading time', event_time: 'Reading time', lat: 'Map latitude', lon: 'Map longitude', lng: 'Map longitude', speed_mph: 'Speed (miles/hour)', vehicle_speed: 'Speed', battery_soc: 'Battery level', state_of_charge: 'Battery level', soc: 'Battery level', latitude: 'Map latitude', longitude: 'Map longitude', ignition_status: 'Engine status', odometer: 'Distance travelled' };
export const measurementName = (name: string) => names[name] || name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());

const aliases: Record<string, string[]> = {
  sig_event_time: ['timestamp', 'eventtime', 'recordedat', 'timemeasured', 'datetime'],
  sig_speed: ['speed', 'vehiclespeed', 'velocity'], sig_soc: ['soc', 'battery', 'batterylevel', 'stateofcharge'],
  sig_latitude: ['lat', 'latitude'], sig_longitude: ['lng', 'lon', 'longitude'],
  sig_odometer: ['odometer', 'mileage', 'distancetravelled'], sig_ignition: ['ignition', 'ignitionstatus', 'enginestatus'],
};
export function suggestedSource(signalId: string, paths: { path: string; example?: unknown }[]): string | undefined {
  const matches = paths.filter(field => aliases[signalId]?.includes(field.path.split('.').pop()!.replace(/[^a-z]/gi, '').toLowerCase()));
  return matches.length === 1 ? matches[0].path : undefined;
}
export function timeConversion(value: unknown) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) return Number(value) > 1e11 ? 'UNIX_MILLISECONDS' : 'UNIX_SECONDS';
  return 'ISO_TIME';
}
export function availableUnits(signal: string): string[] {
  if (signal === 'sig_event_time') return ['ISO_TIME', 'UNIX_SECONDS', 'UNIX_MILLISECONDS'];
  if (signal === 'sig_speed') return ['DIRECT', 'MPH_TO_KMH'];
  if (signal === 'sig_odometer') return ['DIRECT', 'MILES_TO_KM', 'METRES_TO_KM'];
  if (signal === 'sig_soc') return ['DIRECT', 'FRACTION_TO_PERCENT'];
  if (['sig_latitude', 'sig_longitude'].includes(signal)) return ['DIRECT', 'MICRODEGREES_TO_DEGREES'];
  return ['DIRECT', 'ENUM_MAP'];
}
export function statusChoices(signal: string): {value: string; label: string}[] {
  const choices: Record<string, string[]> = { sig_ignition: ['ON', 'OFF'], sig_charging: ['CHARGING', 'NOT_CHARGING'], sig_idle_state: ['IDLE', 'MOVING'], sig_harsh_brake: ['YES', 'NO'] };
  return (choices[signal] || []).map(value => ({ value, label: value === 'NOT_CHARGING' ? 'Not charging' : value[0] + value.slice(1).toLowerCase() }));
}
export function fieldAction(field: {status: string; raw?: unknown; signal: string}) {
  if (field.status === 'missing') return 'Not supplied';
  if (field.status !== 'blocked') return 'Ready';
  if (field.raw === null || field.raw === undefined) return 'Choose a reading';
  if (['latitude', 'longitude'].includes(field.signal)) return 'Check location and units';
  if (field.signal === 'event_time') return 'Check date format';
  return 'Check reading and units';
}
