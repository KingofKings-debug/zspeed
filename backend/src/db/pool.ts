import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, "../../../data/zspeed.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
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
