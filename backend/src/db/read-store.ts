import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const connections = new Map<string, Database.Database>();
export function readStorePath(replica = false): string {
  const primary = path.resolve(process.env.OVERRIDE_DB_PATH || process.env.DB_PATH || 'data/zspeed.db');
  return path.resolve((!process.env.OVERRIDE_DB_PATH && process.env[replica ? 'READ_REPLICA_PATH' : 'READ_MODEL_PATH']) || `${primary}.${replica ? 'replica' : 'reads'}.db`);
}
export function openReadStore(replica = false, readonly = false): Database.Database {
  const filename = readStorePath(replica);
  const key = `${filename}:${readonly}`;
  let db = connections.get(key);
  if (db) return db;
  if (!readonly) fs.mkdirSync(path.dirname(filename), { recursive: true });
  db = new Database(filename, { readonly, fileMustExist: readonly, timeout: readonly ? 100 : 1000 });
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
      kind TEXT NOT NULL, entity_id TEXT NOT NULL, vehicle_id TEXT NOT NULL, fleet_id TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL, body TEXT,
      replicated INTEGER NOT NULL DEFAULT 0, summary TEXT, started_at TEXT, PRIMARY KEY(kind,entity_id));
      CREATE INDEX IF NOT EXISTS snapshots_vehicle ON snapshots(kind,vehicle_id);
      CREATE INDEX IF NOT EXISTS snapshots_fleet ON snapshots(kind,fleet_id);
      CREATE INDEX IF NOT EXISTS snapshots_unreplicated ON snapshots(replicated,updated_at);`);
    db.exec('CREATE INDEX IF NOT EXISTS snapshots_trip_time ON snapshots(kind,vehicle_id,started_at DESC)');
  }
  db.pragma('cache_size = -8192');
  connections.set(key, db);
  return db;
}
export function closeReadStores(): void {
  for (const db of connections.values()) db.close();
  connections.clear();
}
export function replicaSnapshot(kind: string, id: string, fleetId: string, vehicleId?: string): any {
  try {
    const row = openReadStore(true, true).prepare(`SELECT * FROM snapshots WHERE kind=? AND entity_id=? AND fleet_id=?`).get(kind, id, fleetId) as any;
    if (!row?.body || (vehicleId && row.vehicle_id !== vehicleId)) return null;
    return { ...JSON.parse(row.body), freshness: { updatedAt: row.updated_at, revision: row.revision, source: 'read-replica', eventualConsistency: true } };
  } catch (error: any) {
    if (error.code === 'SQLITE_CANTOPEN') return null;
    throw error;
  }
}
