import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function getValidEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (envKey) {
    if (envKey.length === 64) {
      return Buffer.from(envKey, "hex");
    }
    if (envKey.length === 32) {
      return Buffer.from(envKey, "utf8");
    }
    throw new Error("ENCRYPTION_KEY must be a 32-byte string or 64-character hex string");
  }
  if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE === "false") {
    throw new Error("ENCRYPTION_KEY must be set in production mode");
  }
  return Buffer.from("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", "hex");
}

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : [
        "http://localhost:5173",
        "http://localhost:5174",
        "http://localhost:5175",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:5175",
      ],
  nodeEnv: process.env.NODE_ENV || "development",
  defaultFleetId: process.env.DEFAULT_FLEET_ID || "fleet_demo_001",
  demoMode: process.env.DEMO_MODE !== undefined
    ? process.env.DEMO_MODE === "true"
    : process.env.NODE_ENV !== "production",
  demoSecret: process.env.DEMO_SECRET || "zspeed-demo-2026",
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === "production" ? "" : "zspeed-jwt-secret-2026"),
  encryptionKey: getValidEncryptionKey(),
};

export function validateProductionConfig(): void {
  if (config.nodeEnv === "production" && config.demoMode) {
    throw new Error("DEMO_MODE cannot be enabled in production environment");
  }
  if (!config.demoMode) {
    if (!process.env.JWT_SECRET) {
      throw new Error("Production authentication secret (JWT_SECRET) must be configured when DEMO_MODE is disabled");
    }
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error("Production encryption key (ENCRYPTION_KEY) must be configured when DEMO_MODE is disabled");
    }
  }
}
