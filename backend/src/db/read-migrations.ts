import { getDb } from './pool.js';

/** Transactional outbox: changes and their refresh requests commit together. */
export function installReadOutbox(): void {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM _migrations WHERE name='012_read_outbox'").get()) {
    // Upgrade early local snapshots of this migration without touching event data.
    if (!(db.pragma('table_info(replay_jobs)') as any[]).some(c=>c.name==='items_initialized')) {
      db.transaction(()=>{
        db.exec(`ALTER TABLE replay_jobs ADD COLUMN items_initialized INTEGER NOT NULL DEFAULT 0;
          CREATE TABLE IF NOT EXISTS replay_job_items(job_id TEXT NOT NULL REFERENCES replay_jobs(id),raw_event_id TEXT NOT NULL REFERENCES raw_events(id),status TEXT NOT NULL DEFAULT 'PENDING',PRIMARY KEY(job_id,raw_event_id));
          CREATE INDEX IF NOT EXISTS idx_replay_job_items_pending ON replay_job_items(job_id,status);`);
      })();
    }
    return;
  }
  db.transaction(() => {
    db.exec(`CREATE TABLE read_refresh_queue (
      kind TEXT NOT NULL, entity_id TEXT NOT NULL, vehicle_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1, changed_at TEXT NOT NULL DEFAULT (datetime('now')), queued_at TEXT NOT NULL DEFAULT (datetime('now')),
      attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, error TEXT,
      PRIMARY KEY(kind, entity_id));
      CREATE INDEX idx_read_refresh_ready ON read_refresh_queue(retry_at, changed_at);
      CREATE INDEX IF NOT EXISTS idx_trip_events_trip ON trip_events(trip_id);
      CREATE INDEX IF NOT EXISTS idx_normalized_vehicle_raw ON normalized_events(vehicle_id, raw_event_id);`);
    db.exec(`ALTER TABLE job_queue ADD COLUMN fleet_id TEXT;
      ALTER TABLE replay_jobs ADD COLUMN items_initialized INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE replay_job_items(job_id TEXT NOT NULL REFERENCES replay_jobs(id), raw_event_id TEXT NOT NULL REFERENCES raw_events(id),
        status TEXT NOT NULL DEFAULT 'PENDING', PRIMARY KEY(job_id,raw_event_id));
      CREATE INDEX idx_replay_job_items_pending ON replay_job_items(job_id,status);
      CREATE INDEX idx_job_queue_fleet_created ON job_queue(fleet_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_queue_ready ON job_queue(status,run_after,priority,created_at);`);
    const fleetForJob = (payload:string) => `COALESCE(json_extract(${payload},'$.fleetId'),
      (SELECT fleet_id FROM vehicles WHERE id=json_extract(${payload},'$.vehicleId')),
      (SELECT fleet_id FROM raw_events WHERE id=json_extract(${payload},'$.rawEventId')),
      (SELECT fleet_id FROM replay_jobs WHERE id=json_extract(${payload},'$.jobId')),
      (SELECT fleet_id FROM projection_rebuild_jobs WHERE id=json_extract(${payload},'$.jobId')))`;
    db.exec(`UPDATE job_queue SET fleet_id=${fleetForJob('job_queue.payload')};
      CREATE TRIGGER read_job_fleet AFTER INSERT ON job_queue BEGIN
      UPDATE job_queue SET fleet_id=${fleetForJob('NEW.payload')} WHERE id=NEW.id; END;`);
    const enqueue = (kind: string, id: string, vehicle: string) => `
      INSERT INTO read_refresh_queue(kind, entity_id, vehicle_id) SELECT '${kind}', ${id}, ${vehicle} WHERE ${vehicle} IS NOT NULL
      ON CONFLICT(kind, entity_id) DO UPDATE SET generation=generation+1, changed_at=datetime('now'), attempts=0, retry_at=NULL, error=NULL;`;
    for (const [table, vehicle] of [
      ['vehicles', 'id'], ['vehicle_current_state', 'vehicle_id'],
      ['normalized_events', 'vehicle_id'], ['quarantine_records', 'vehicle_id'],
    ]) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        let sql = enqueue('vehicle', `${row}.${vehicle}`, `${row}.${vehicle}`);
        if (table === 'quarantine_records') sql += `INSERT INTO read_refresh_queue(kind,entity_id,vehicle_id)
          SELECT 'trip', id, vehicle_id FROM trips WHERE vehicle_id=${row}.vehicle_id
          ON CONFLICT(kind,entity_id) DO UPDATE SET generation=generation+1, changed_at=datetime('now'), attempts=0, retry_at=NULL, error=NULL;`;
        db.exec(`CREATE TRIGGER read_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN ${sql} END;`);
      }
    }
    for (const table of ['trips', 'trip_routes', 'trip_events']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        const id = table === 'trips' ? `${row}.id` : `${row}.trip_id`;
        const vehicle = table === 'trips' ? `${row}.vehicle_id` : `(SELECT vehicle_id FROM trips WHERE id=${id})`;
        db.exec(`CREATE TRIGGER read_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table} BEGIN
          ${enqueue('trip', id, vehicle)} ${enqueue('vehicle', vehicle, vehicle)} END;`);
      }
    }
    db.exec(`INSERT INTO read_refresh_queue(kind,entity_id,vehicle_id) SELECT 'vehicle',id,id FROM vehicles;
      INSERT INTO read_refresh_queue(kind,entity_id,vehicle_id) SELECT 'trip',id,vehicle_id FROM trips;
      INSERT INTO _migrations(name) VALUES('012_read_outbox');`);
  })();
}
