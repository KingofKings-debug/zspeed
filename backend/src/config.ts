import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

export const config = {
  port: parseInt(process.env.PORT || "3001", 10),
  databaseUrl: process.env.DATABASE_URL || "postgresql://zspeed:zspeed_dev@localhost:5432/zspeed",
  corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
  nodeEnv: process.env.NODE_ENV || "development",
  defaultFleetId: process.env.DEFAULT_FLEET_ID || "fleet_demo_001",
};
