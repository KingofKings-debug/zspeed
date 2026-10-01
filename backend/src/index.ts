import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config, validateProductionConfig } from "./config.js";
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
import authRoutes from "./routes/auth.routes.js";
import vehicleDetailRoutes from "./routes/vehicle-detail.routes.js";
import { startWorker } from "./services/worker.service.js";
import { initializeDeliveries } from "./services/delivery.service.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { createServer } from "http";
import { initSocket } from "./socket.js";

const app = express();
const httpServer = createServer(app);
initSocket(httpServer);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: config.corsOrigin, credentials: true }));
app.use(
  express.json({
    limit: "10mb",
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));

app.use("/api/auth", authRoutes);

app.use((req, res, next) => {
  if (
    req.path.startsWith("/api/ingestion/webhooks/") ||
    req.path === "/api/health" ||
    req.path === "/api/sample-csv"
  ) {
    return next();
  }
  fleetContext(req, res, next);
});

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
    validateProductionConfig();
    runMigrations();
    seedDatabase();
    startWorker();
    initializeDeliveries();

    httpServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `\n[ERROR] Port ${config.port} is already in use.\n` +
          `Another backend instance may still be running.\n` +
          `Kill it first:\n` +
          `  Windows:  netstat -ano | findstr :${config.port}  → then  taskkill /F /PID <pid>\n` +
          `  Mac/Linux: lsof -ti:${config.port} | xargs kill -9\n`
        );
        process.exit(1);
      }
      throw err;
    });

    httpServer.listen(config.port, "0.0.0.0", () => {
      console.log(`Server running on port ${config.port} (0.0.0.0)`);
      console.log(`CORS origin: ${config.corsOrigin}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

export { app, httpServer };

if (process.env.NODE_ENV !== "test") {
  start();
}
