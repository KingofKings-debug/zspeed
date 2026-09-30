import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { v4 as uuid } from "uuid";

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

const ENCRYPTION_KEY = randomBytes(32);
const secretStore = new Map<string, { iv: string; tag: string; encrypted: string }>();

export function storeSecret(data: Record<string, any>): string {
  const secretRef = `sec_${uuid()}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const text = JSON.stringify(data);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  secretStore.set(secretRef, {
    iv: iv.toString("hex"),
    tag,
    encrypted,
  });

  return secretRef;
}

export function getSecret(secretRef: string): Record<string, any> | null {
  const entry = secretStore.get(secretRef);
  if (!entry) return null;

  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      ENCRYPTION_KEY,
      Buffer.from(entry.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    let decrypted = decipher.update(entry.encrypted, "hex", "utf8");
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
