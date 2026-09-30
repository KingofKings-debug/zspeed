import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

function resolveSimulatorDbPath(): string {
  if (process.env.SIMULATOR_OVERRIDE_DB_PATH) {
    return path.resolve(process.env.SIMULATOR_OVERRIDE_DB_PATH);
  }
  if (process.env.SIMULATOR_DB_PATH) {
    return path.resolve(process.env.SIMULATOR_DB_PATH);
  }
  return path.resolve(process.cwd(), "data", "simulator.db");
}

let simDb: Database.Database | null = null;
let currentSimDbPath: string | null = null;

export function getSimulatorDb(): Database.Database {
  const targetPath = resolveSimulatorDbPath();
  if (simDb && currentSimDbPath === targetPath) {
    return simDb;
  }
  if (simDb && currentSimDbPath !== targetPath) {
    simDb.close();
    simDb = null;
  }
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  simDb = new Database(targetPath);
  simDb.pragma("journal_mode = WAL");
  simDb.pragma("foreign_keys = ON");
  currentSimDbPath = targetPath;
  initSimulatorDb(simDb);
  return simDb;
}

export function closeSimulatorDb(): void {
  if (simDb) {
    simDb.close();
    simDb = null;
    currentSimDbPath = null;
  }
}

export function initSimulatorDb(database?: Database.Database): void {
  const dbInstance = database || getSimulatorDb();

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS sim_runs (
      run_id TEXT PRIMARY KEY,
      seed INTEGER NOT NULL,
      status TEXT NOT NULL,
      speed_multiplier REAL NOT NULL DEFAULT 1.0,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sim_vehicles (
      id TEXT PRIMARY KEY,
      oem_id TEXT NOT NULL,
      vin TEXT NOT NULL UNIQUE,
      make TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER NOT NULL,
      route_index INTEGER NOT NULL DEFAULT 0,
      route_progress REAL NOT NULL DEFAULT 0.0,
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      altitude REAL NOT NULL DEFAULT 15.0,
      heading REAL NOT NULL DEFAULT 0.0,
      speed REAL NOT NULL DEFAULT 0.0,
      target_speed REAL NOT NULL DEFAULT 0.0,
      acceleration REAL NOT NULL DEFAULT 0.0,
      odometer REAL NOT NULL DEFAULT 10000.0,
      soc REAL NOT NULL DEFAULT 85.0,
      fuel_level REAL NOT NULL DEFAULT 80.0,
      ignition TEXT NOT NULL DEFAULT 'ON',
      charging INTEGER NOT NULL DEFAULT 0,
      fault_code TEXT,
      status TEXT NOT NULL DEFAULT 'MOVING',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sim_samples (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      oem_id TEXT NOT NULL,
      vehicle_id TEXT NOT NULL,
      sample_seq INTEGER NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(run_id, oem_id, vehicle_id, sample_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_sim_samples_veh ON sim_samples(vehicle_id, sample_seq);
    CREATE INDEX IF NOT EXISTS idx_sim_samples_oem ON sim_samples(oem_id, sample_seq);
    CREATE INDEX IF NOT EXISTS idx_sim_samples_time ON sim_samples(vehicle_id, timestamp);

    CREATE TABLE IF NOT EXISTS sim_subscriptions (
      id TEXT PRIMARY KEY,
      oem_id TEXT NOT NULL,
      target_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sim_webhook_deliveries (
      id TEXT PRIMARY KEY,
      subscription_id TEXT NOT NULL,
      target_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      oem_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_retry_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      delivered_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sim_wh_status ON sim_webhook_deliveries(status, next_retry_at);
    CREATE INDEX IF NOT EXISTS idx_sim_wh_sub ON sim_webhook_deliveries(subscription_id);

    CREATE TABLE IF NOT EXISTS sim_scenarios (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      config TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS sim_metrics (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function recordSimulatorMetric(key: string, inc = 1): void {
  const db = getSimulatorDb();
  db.prepare(`
    INSERT INTO sim_metrics (key, count) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET count = count + ?
  `).run(key, inc, inc);
}

export function getSimulatorMetrics(): Record<string, number> {
  const db = getSimulatorDb();
  const rows = db.prepare("SELECT key, count FROM sim_metrics").all() as { key: string; count: number }[];
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.key] = row.count;
  }
  return result;
}

export function getSimulatorScenario(name: string): { enabled: boolean; config: any } {
  const db = getSimulatorDb();
  const row = db.prepare("SELECT enabled, config FROM sim_scenarios WHERE name = ?").get(name) as { enabled: number; config: string } | undefined;
  if (!row) {
    return { enabled: false, config: {} };
  }
  let parsed = {};
  try {
    parsed = JSON.parse(row.config);
  } catch {}
  return { enabled: Boolean(row.enabled), config: parsed };
}

export function setSimulatorScenario(name: string, enabled: boolean, config: any = {}): void {
  const db = getSimulatorDb();
  db.prepare(`
    INSERT INTO sim_scenarios (name, enabled, config) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET enabled = ?, config = ?
  `).run(name, enabled ? 1 : 0, JSON.stringify(config), enabled ? 1 : 0, JSON.stringify(config));
}

export function getAllSimulatorScenarios(): Record<string, { enabled: boolean; config: any }> {
  const db = getSimulatorDb();
  const rows = db.prepare("SELECT name, enabled, config FROM sim_scenarios").all() as { name: string; enabled: number; config: string }[];
  const result: Record<string, { enabled: boolean; config: any }> = {};
  for (const r of rows) {
    let cfg = {};
    try {
      cfg = JSON.parse(r.config);
    } catch {}
    result[r.name] = { enabled: Boolean(r.enabled), config: cfg };
  }
  return result;
}

export function cleanupOldSamples(keepCountPerVehicle = 500): void {
  const db = getSimulatorDb();
  const vehicles = db.prepare("SELECT DISTINCT vehicle_id FROM sim_samples").all() as { vehicle_id: string }[];
  for (const v of vehicles) {
    db.prepare(`
      DELETE FROM sim_samples
      WHERE vehicle_id = ?
      AND id NOT IN (
        SELECT id FROM sim_samples WHERE vehicle_id = ? ORDER BY sample_seq DESC LIMIT ?
      )
    `).run(v.vehicle_id, v.vehicle_id, keepCountPerVehicle);
  }
}
