import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(",")
    : ["http://localhost:5173", "http://localhost:5174", "http://127.0.0.1:5173", "http://127.0.0.1:5174"],
  nodeEnv: process.env.NODE_ENV || "development",
  defaultFleetId: process.env.DEFAULT_FLEET_ID || "fleet_demo_001",
  demoMode: (process.env.DEMO_MODE || "true") === "true",
  demoSecret: process.env.DEMO_SECRET || "zspeed-demo-2026",
};
