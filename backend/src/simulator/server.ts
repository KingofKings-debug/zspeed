import express from "express";
import cors from "cors";
import http from "http";
import volteraRoutes from "./routes/voltera.routes.js";
import crestlineRoutes from "./routes/crestline.routes.js";
import navarroRoutes from "./routes/navarro.routes.js";
import controlRoutes from "./routes/control.routes.js";
import { engine } from "./engine.js";
import { initSimulatorDb } from "./db.js";

const app = express();
const server = http.createServer(app);

const defaultAllowedOrigins = [
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];
const allowedOrigins = process.env.SIMULATOR_ALLOWED_ORIGINS
  ? process.env.SIMULATOR_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : defaultAllowedOrigins;

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        callback(null, true);
      } else {
        callback(new Error("CORS origin not allowed by simulator"));
      }
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

function requireSimulatorAdminKey(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
): void {
  const configuredKey = process.env.SIMULATOR_ADMIN_KEY || "sim-admin-secret-2026";
  const providedKey =
    (req.headers["x-simulator-admin-key"] as string) ||
    (req.headers.authorization?.replace(/^Bearer\s+/i, ""));

  if (!providedKey || providedKey !== configuredKey) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Simulator administration endpoints require valid X-Simulator-Admin-Key",
    });
    return;
  }
  next();
}

app.use("/oem/voltera", volteraRoutes);
app.use("/oem/crestline", crestlineRoutes);
app.use("/oem/navarro", navarroRoutes);
app.use("/api/simulator", requireSimulatorAdminKey, controlRoutes);

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "zspeed-oem-simulator",
    timestamp: new Date().toISOString(),
  });
});

const PORT = parseInt(process.env.SIMULATOR_PORT || "3002", 10);
let isListening = false;

export function startSimulatorServer(): Promise<http.Server> {
  if (isListening) {
    return Promise.resolve(server);
  }
  isListening = true;
  initSimulatorDb();
  engine.start();

  return new Promise((resolve) => {
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`OEM Simulator Server running on port ${PORT}`);
      resolve(server);
    });
  });
}

export { app, server };
