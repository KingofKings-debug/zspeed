import { getDb } from './pool.js';

export function installActivityGroups(): void {
  const db=getDb();
  if(db.prepare("SELECT 1 FROM _migrations WHERE name='013_background_activities'").get()) return;
  db.transaction(()=>{
    db.exec(`ALTER TABLE job_queue ADD COLUMN activity_id TEXT;
      CREATE INDEX idx_job_activity ON job_queue(activity_id,status);
      CREATE TABLE background_activities(id TEXT PRIMARY KEY,fleet_id TEXT NOT NULL,group_key TEXT NOT NULL,
        kind TEXT NOT NULL,vehicle_id TEXT,label TEXT NOT NULL,first_queued_at TEXT NOT NULL,last_queued_at TEXT NOT NULL,started_at TEXT);
      CREATE INDEX idx_activity_session ON background_activities(fleet_id,group_key,last_queued_at DESC);
      CREATE INDEX idx_activity_recent ON background_activities(fleet_id,last_queued_at DESC);
      CREATE VIEW background_job_context AS SELECT j.id,
        COALESCE(j.fleet_id,r.fleet_id,rp.fleet_id,pb.fleet_id,v.fleet_id) fleet_id,
        CASE WHEN j.job_type IN ('NORMALIZE_RAW_EVENT','BUILD_PROJECTIONS') THEN 'TELEMETRY' ELSE j.job_type END kind,
        CASE WHEN j.job_type IN ('NORMALIZE_RAW_EVENT','BUILD_PROJECTIONS')
          THEN COALESCE(v.id,r.connection_id||':'||r.source_vehicle_id,j.id) ELSE j.id END group_key,
        v.id vehicle_id,COALESCE(v.label,v.vin,r.source_vehicle_id,'Fleet operations') label
      FROM job_queue j LEFT JOIN raw_events r ON r.id=json_extract(j.payload,'$.rawEventId')
      LEFT JOIN vehicle_source_mappings m ON m.connection_id=r.connection_id AND m.oem_vehicle_id=r.source_vehicle_id
      LEFT JOIN replay_jobs rp ON rp.id=json_extract(j.payload,'$.jobId')
      LEFT JOIN projection_rebuild_jobs pb ON pb.id=json_extract(j.payload,'$.jobId')
      LEFT JOIN vehicles v ON v.id=COALESCE(json_extract(j.payload,'$.vehicleId'),pb.vehicle_id,m.vehicle_id);`);
    const body=`
      INSERT INTO background_activities(id,fleet_id,group_key,kind,vehicle_id,label,first_queued_at,last_queued_at)
      SELECT NEW.id,c.fleet_id,c.group_key,c.kind,c.vehicle_id,c.label,
        strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at),strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at)
      FROM background_job_context c WHERE c.id=NEW.id AND c.fleet_id IS NOT NULL AND NOT EXISTS(
        SELECT 1 FROM background_activities a WHERE a.fleet_id=c.fleet_id AND a.group_key=c.group_key AND a.kind=c.kind
        AND julianday(NEW.created_at)>=julianday(a.first_queued_at)
        AND julianday(NEW.created_at)<=julianday(a.last_queued_at)+5.0/1440);
      UPDATE job_queue SET activity_id=(SELECT a.id FROM background_activities a JOIN background_job_context c
        ON c.id=NEW.id AND a.fleet_id=c.fleet_id AND a.group_key=c.group_key AND a.kind=c.kind
        WHERE julianday(NEW.created_at)>=julianday(a.first_queued_at)
        AND julianday(NEW.created_at)<=julianday(a.last_queued_at)+5.0/1440 ORDER BY a.last_queued_at DESC LIMIT 1) WHERE id=NEW.id;
      UPDATE background_activities SET last_queued_at=MAX(last_queued_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at))
        WHERE id=(SELECT activity_id FROM job_queue WHERE id=NEW.id);`;
    db.exec(`CREATE TRIGGER assign_activity_insert AFTER INSERT ON job_queue WHEN NEW.activity_id IS NULL BEGIN ${body} END;
      CREATE TRIGGER assign_activity_fleet AFTER UPDATE OF fleet_id ON job_queue WHEN NEW.activity_id IS NULL BEGIN ${body} END;
      CREATE TRIGGER activity_started AFTER UPDATE OF status ON job_queue WHEN NEW.status='RUNNING' BEGIN
        UPDATE background_activities SET started_at=COALESCE(started_at,NEW.started_at) WHERE id=NEW.activity_id; END;`);
    const assign=db.prepare('UPDATE job_queue SET fleet_id=fleet_id WHERE id=?');
    for(const job of db.prepare('SELECT id FROM job_queue ORDER BY julianday(created_at),id').all() as any[]) assign.run(job.id);
    db.exec('UPDATE background_activities SET started_at=(SELECT MIN(started_at) FROM job_queue WHERE activity_id=background_activities.id)');
    db.exec("INSERT INTO _migrations(name) VALUES('013_background_activities')");
  })();
}
