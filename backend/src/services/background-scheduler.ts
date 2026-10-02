export function workerBudget(requestsPerSecond:number, pendingWrites:number, hour:number) {
  const busy=requestsPerSecond>=5 || pendingWrites>=200;
  const start=Number(process.env.MAINTENANCE_START_HOUR || 0),end=Number(process.env.MAINTENANCE_END_HOUR || 6);
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||start>23||end<0||end>24) throw new Error('Maintenance hours must be whole hours within 0–24');
  const quiet=start<=end ? hour>=start&&hour<end : hour>=start||hour<end;
  return {mode:busy?'BUSY':quiet?'QUIET_HOURS':'NORMAL',jobs:pendingWrites>=200?20:busy?4:quiet?20:10,reads:busy?1:quiet?8:3,
    allowMaintenance:!busy,intervalMs:1000};
}
