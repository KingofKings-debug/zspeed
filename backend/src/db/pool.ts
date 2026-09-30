import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

function resolveDbPath(): string {
  if (process.env.OVERRIDE_DB_PATH) {
    return path.resolve(process.env.OVERRIDE_DB_PATH);
  }
  if (process.env.DB_PATH) {
    return path.resolve(process.env.DB_PATH);
  }
  return path.resolve(process.cwd(), "data", "zspeed.db");
}

let db: Database.Database | null = null;
let currentDbPath: string | null = null;

export function getDb(): Database.Database {
  const targetPath = resolveDbPath();
  if (db && currentDbPath === targetPath) {
    return db;
  }
  if (db && currentDbPath !== targetPath) {
    db.close();
    db = null;
  }
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db = new Database(targetPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  currentDbPath = targetPath;
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    currentDbPath = null;
  }
}

export function query<T = any>(sql: string, params?: unknown[]): T[] {
  const database = getDb();
  const stmt = database.prepare(sql);
  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith("SELECT") || trimmed.startsWith("WITH") || trimmed.startsWith("PRAGMA")) {
    return stmt.all(...(params || [])) as T[];
  }
  stmt.run(...(params || []));
  return [] as T[];
}

export function run(sql: string, params?: unknown[]): Database.RunResult {
  const database = getDb();
  const stmt = database.prepare(sql);
  return stmt.run(...(params || []));
}

export function queryOne<T = any>(sql: string, params?: unknown[]): T | undefined {
  const database = getDb();
  const stmt = database.prepare(sql);
  return stmt.get(...(params || [])) as T | undefined;
}

export function transaction<T>(fn: () => T): T {
  const database = getDb();
  const txn = database.transaction(fn);
  return txn();
}

export function execRaw(sql: string): void {
  const database = getDb();
  database.exec(sql);
}
