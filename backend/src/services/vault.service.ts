import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { v4 as uuid } from "uuid";
import { config } from "../config.js";
import { queryOne, run } from "../db/pool.js";

const SENSITIVE_KEYS = new Set([
  "password",
  "client_secret",
  "api_key",
  "apiKey",
  "secret",
  "token",
  "auth_token",
  "private_key",
  "credentials",
]);

export function storeSecret(data: Record<string, any>): string {
  const secretRef = `sec_${uuid()}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const text = JSON.stringify(data);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  run(
    `INSERT INTO encrypted_credentials (secret_ref, iv, tag, encrypted_data, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(secret_ref) DO UPDATE SET
       iv = excluded.iv,
       tag = excluded.tag,
       encrypted_data = excluded.encrypted_data,
       updated_at = datetime('now')`,
    [secretRef, iv.toString("hex"), tag, encrypted]
  );

  return secretRef;
}

export function getSecret(secretRef: string): Record<string, any> | null {
  try {
    const row = queryOne<{ iv: string; tag: string; encrypted_data: string }>(
      "SELECT iv, tag, encrypted_data FROM encrypted_credentials WHERE secret_ref = ?",
      [secretRef]
    );
    if (!row) return null;

    const decipher = createDecipheriv(
      "aes-256-gcm",
      config.encryptionKey,
      Buffer.from(row.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(row.tag, "hex"));
    let decrypted = decipher.update(row.encrypted_data, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

export function redactSensitive<T>(input: T): T {
  if (!input || typeof input !== "object") return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitive(item)) as unknown as T;
  }

  const result: Record<string, any> = {};
  for (const [key, val] of Object.entries(input)) {
    if (SENSITIVE_KEYS.has(key)) {
      result[key] = "[REDACTED]";
    } else if (typeof val === "object" && val !== null) {
      result[key] = redactSensitive(val);
    } else {
      result[key] = val;
    }
  }

  return result as T;
}
