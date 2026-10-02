import '../config.js';
import { queryOne,query } from '../db/pool.js';
import { openReadStore } from '../db/read-store.js';
import { processBatch,recoverAbandonedJobs } from './worker.service.js';
import { refreshReadModels,replicateReadModels,saveSnapshot,bootstrapReadModels } from './read-model.service.js';
import { workerBudget } from './background-scheduler.js';
import { getBackgroundActivities } from './background-activity.service.js';

let requests=0;
process.on('message',(message:any)=>{ if(message?.type==='load') requests=message.requests; });
process.on('disconnect',()=>process.exit(0));
recoverAbandonedJobs(0); // The supervisor holds an exclusive host lock; previous child has exited.
bootstrapReadModels();
let lastStatus=0;
function status(mode:string) {
  for (const fleet of query<any>('SELECT id FROM fleets')) {
    const refresh=queryOne<any>(`SELECT COUNT(*) pending,COALESCE(SUM(q.error IS NOT NULL),0) failed,
      MIN(q.changed_at) oldest FROM read_refresh_queue q JOIN vehicles v ON v.id=q.vehicle_id WHERE v.fleet_id=?`,[fleet.id]);
    const activities=getBackgroundActivities(fleet.id);
    const counts=query<any>('SELECT status,COUNT(*) count FROM job_queue WHERE fleet_id=? GROUP BY status',[fleet.id]);
    const replication=openReadStore().prepare('SELECT COUNT(*) pending,MIN(updated_at) oldest FROM snapshots WHERE fleet_id=? AND replicated=0').get(fleet.id);
    saveSnapshot('jobs',fleet.id,'',fleet.id,{mode,heartbeat:new Date().toISOString(),refresh,activities,counts,replication});
  }
}
function tick() {
  let interval=1000;
  try {
    const pending=queryOne<any>("SELECT COUNT(*) count FROM job_queue WHERE status='PENDING'")?.count || 0;
    const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:process.env.MAINTENANCE_TIMEZONE || 'UTC',hour:'2-digit',hourCycle:'h23'}).format(new Date()));
    const budget=workerBudget(requests,pending,hour); interval=budget.intervalMs;
    // Refresh before and after work so existing snapshots remain available during catch-up.
    refreshReadModels(budget.reads);
    replicateReadModels();
    processBatch('background-worker',budget.jobs,budget.allowMaintenance);
    refreshReadModels(budget.reads);
    if(Date.now()-lastStatus>=5000) { status(budget.mode); lastStatus=Date.now(); }
    replicateReadModels();
  } catch(error) { console.error('[background]',error); }
  setTimeout(tick,interval);
}
tick();
