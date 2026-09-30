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

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/oem/voltera", volteraRoutes);
app.use("/oem/crestline", crestlineRoutes);
app.use("/oem/navarro", navarroRoutes);
app.use("/api/simulator", controlRoutes);

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
