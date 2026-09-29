import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { seedDatabase } from "./db/seed.js";
import { fleetContext } from "./middleware/fleet.js";
import { errorHandler } from "./middleware/error.js";
import vehicleRoutes from "./routes/vehicle.routes.js";
import oemRoutes from "./routes/oem.routes.js";
import connectionRoutes from "./routes/connection.routes.js";
import integrationRoutes from "./routes/integration.routes.js";
import ingestionRoutes from "./routes/ingestion.routes.js";
import quarantineRoutes from "./routes/quarantine.routes.js";
import vehicleDetailRoutes from "./routes/vehicle-detail.routes.js";
import { startWorker } from "./services/worker.service.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(fleetContext);

app.use("/api/vehicles", vehicleRoutes);
app.use("/api/vehicles", vehicleDetailRoutes);
app.use("/api/oems", oemRoutes);
app.use("/api/connections", connectionRoutes);
app.use("/api/integration-requests", integrationRoutes);
app.use("/api/ingestion", ingestionRoutes);
app.use("/api/quarantine", quarantineRoutes);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sampleCsvPath = path.resolve(__dirname, "../../sample-data/fleet-sample.csv");

app.get("/api/sample-csv", (_req, res) => {
  if (fs.existsSync(sampleCsvPath)) {
    res.download(sampleCsvPath, "fleet-sample.csv");
  } else {
    res.status(404).json({ message: "Sample CSV not found" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use(errorHandler);

async function start() {
  try {
    runMigrations();
    seedDatabase();
    startWorker();

    app.listen(config.port, () => {
      console.log(`Server running on port ${config.port}`);
      console.log(`CORS origin: ${config.corsOrigin}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

start();
