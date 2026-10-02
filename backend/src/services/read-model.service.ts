import { getDb, query, queryOne, run } from '../db/pool.js';
import { openReadStore } from '../db/read-store.js';
import { getVehicleCurrentDetail, getTripGeoJson } from './projection.service.js';

export function bootstrapReadModels():void {
  const source=openReadStore(),replica=openReadStore(true);
  if(!source.prepare('SELECT 1 FROM snapshots LIMIT 1').get()) {
    // Derived stores are disposable. A new source resets replica revisions before backfill.
    replica.prepare('DELETE FROM snapshots').run();
    getDb().transaction(()=>{
      run("INSERT OR IGNORE INTO read_refresh_queue(kind,entity_id,vehicle_id) SELECT 'vehicle',id,id FROM vehicles");
      run("INSERT OR IGNORE INTO read_refresh_queue(kind,entity_id,vehicle_id) SELECT 'trip',id,vehicle_id FROM trips");
    })();
  }
  if(!replica.prepare('SELECT 1 FROM snapshots LIMIT 1').get()) source.prepare('UPDATE snapshots SET replicated=0').run();
}

export function saveSnapshot(kind: string, id: string, vehicleId: string, fleetId: string, body: any): void {
  const db = openReadStore();
  db.prepare(`INSERT INTO snapshots(kind,entity_id,vehicle_id,fleet_id,revision,updated_at,body,replicated,summary,started_at)
    VALUES(?,?,?,?,1,?,?,0,?,?) ON CONFLICT(kind,entity_id) DO UPDATE SET
    vehicle_id=excluded.vehicle_id,fleet_id=excluded.fleet_id,revision=revision+1,
    updated_at=excluded.updated_at,body=excluded.body,summary=excluded.summary,started_at=excluded.started_at,replicated=0`)
    .run(kind,id,vehicleId,fleetId,new Date().toISOString(),body === null ? null : JSON.stringify(body),body?.trip ? JSON.stringify(body.trip) : null,body?.trip?.started_at || null);
}

function buildSnapshot(job: any): void {
  const vehicle = queryOne<any>('SELECT * FROM vehicles WHERE id=?', [job.vehicle_id]);
  if (!vehicle) {
    const old = openReadStore().prepare('SELECT fleet_id FROM snapshots WHERE kind=? AND entity_id=?').get(job.kind,job.entity_id) as any;
    if (old) saveSnapshot(job.kind,job.entity_id,job.vehicle_id,old.fleet_id,null);
    return;
  }
  if (job.kind === 'vehicle') {
    const detail = getVehicleCurrentDetail(vehicle.id);
    const stats = queryOne<any>(`SELECT COUNT(*) AS trips, COALESCE(SUM(distance_km),0) AS distanceKm,
      COALESCE(SUM(duration_seconds),0) AS durationSeconds FROM trips WHERE vehicle_id=? AND projection_status IN ('CURRENT','REBUILDING')`,[vehicle.id]);
    const tags = [];
    if (detail.dataQuality.unresolvedEvents) tags.push('DATA_QUALITY');
    if (!detail.currentState) tags.push('AWAITING_DATA');
    if (detail.currentState?.latestValues?.fault_code) tags.push('FAULT_REPORTED');
    saveSnapshot('vehicle',vehicle.id,vehicle.id,vehicle.fleet_id,{...detail,stats,healthTags:tags});
    return;
  }
  const trip = queryOne<any>('SELECT * FROM trips WHERE id=?',[job.entity_id]);
  if (!trip || !['CURRENT','REBUILDING'].includes(trip.projection_status)) {
    saveSnapshot('trip',job.entity_id,vehicle.id,vehicle.fleet_id,null); return;
  }
  const route = queryOne<any>('SELECT has_gaps,point_count FROM trip_routes WHERE trip_id=?',[trip.id]);
  const events = query<any>(`SELECT te.*,ne.canonical_values AS source_canonical_values FROM trip_events te
    LEFT JOIN normalized_events ne ON ne.id=te.source_normalized_event_id WHERE te.trip_id=? ORDER BY te.event_time`,[trip.id]);
  const count = queryOne<any>(`SELECT COUNT(DISTINCT raw_event_id) AS count FROM quarantine_records
    WHERE vehicle_id=? AND status!='RESOLVED' AND first_failure_at>=? AND first_failure_at<=?`,
    [vehicle.id,trip.started_at,trip.ended_at || new Date().toISOString()])?.count || 0;
  const issues = new Set<string>(JSON.parse(trip.quality_notes || '[]'));
  if (route?.has_gaps) issues.add('MISSING_GPS_SEGMENTS');
  if (count) issues.add('QUARANTINED_EVENTS');
  if (trip.projection_status === 'REBUILDING') issues.add('PROJECTION_REBUILDING');
  saveSnapshot('trip',trip.id,vehicle.id,vehicle.fleet_id,{
    trip:{...trip,...route,event_count:events.length}, route:getTripGeoJson(trip.id),events,
    quality:{tripId:trip.id,projectionStatus:trip.projection_status,completeness:trip.completeness_pct,
      hasGaps:!!route?.has_gaps,pointCount:route?.point_count || 0,quarantinedEvents:count,issues:[...issues]},
  });
}

/** Single worker, bounded batches. An acknowledged generation can never erase newer changes. */
export function refreshReadModels(limit=1, debounceSeconds=2): number {
  // Reserve capacity for current vehicle data, without starving historical trip bundles.
  if(limit>=2) {
    const due="(retry_at IS NULL OR retry_at<=datetime('now')) AND (changed_at<=datetime('now',?) OR queued_at<=datetime('now','-10 seconds') OR generation=1)";
    const jobs=[...query<any>(`SELECT * FROM read_refresh_queue WHERE kind='vehicle' AND ${due} ORDER BY queued_at LIMIT ?`,[`-${debounceSeconds} seconds`,Math.max(1,Math.floor(limit/2))]),
      ...query<any>(`SELECT * FROM read_refresh_queue WHERE kind='trip' AND ${due} ORDER BY queued_at LIMIT ?`,[`-${debounceSeconds} seconds`,Math.max(1,Math.ceil(limit/2))])];
    return processRefreshJobs(jobs);
  }
  const jobs = query<any>(`SELECT * FROM read_refresh_queue WHERE (retry_at IS NULL OR retry_at<=datetime('now'))
    AND (changed_at<=datetime('now',?) OR queued_at<=datetime('now','-10 seconds') OR generation=1) ORDER BY queued_at,kind DESC LIMIT ?`,[`-${debounceSeconds} seconds`,limit]);
  return processRefreshJobs(jobs);
}
function processRefreshJobs(jobs:any[]):number {
  for (const job of jobs) {
    try {
      getDb().transaction(() => buildSnapshot(job))();
      run('DELETE FROM read_refresh_queue WHERE kind=? AND entity_id=? AND generation=?',[job.kind,job.entity_id,job.generation]);
    } catch (error: any) {
      run(`UPDATE read_refresh_queue SET attempts=attempts+1,error=?,retry_at=datetime('now',?)
        WHERE kind=? AND entity_id=? AND generation=?`,[error.message,`+${Math.min(300,2**Math.min(job.attempts+1,8))} seconds`,job.kind,job.entity_id,job.generation]);
    }
  }
  return jobs.length;
}

/** Durable incremental replication; restart resumes unacknowledged rows. */
export function replicateReadModels(limit=20): number {
  const source = openReadStore();
  const rows = source.prepare('SELECT * FROM snapshots WHERE replicated=0 ORDER BY updated_at LIMIT ?').all(limit) as any[];
  if (!rows.length) return 0;
  const replica = openReadStore(true);
  replica.transaction(() => {
    const upsert = replica.prepare(`INSERT INTO snapshots(kind,entity_id,vehicle_id,fleet_id,revision,updated_at,body,replicated,summary,started_at)
      VALUES(@kind,@entity_id,@vehicle_id,@fleet_id,@revision,@updated_at,@body,1,@summary,@started_at)
      ON CONFLICT(kind,entity_id) DO UPDATE SET vehicle_id=excluded.vehicle_id,fleet_id=excluded.fleet_id,
      revision=excluded.revision,updated_at=excluded.updated_at,body=excluded.body,summary=excluded.summary,started_at=excluded.started_at,replicated=1
      WHERE excluded.revision>snapshots.revision`);
    for (const row of rows) upsert.run(row);
  })();
  const ack = source.prepare('UPDATE snapshots SET replicated=1 WHERE kind=? AND entity_id=? AND revision=?');
  source.transaction(() => { for (const row of rows) ack.run(row.kind,row.entity_id,row.revision); })();
  return rows.length;
}
