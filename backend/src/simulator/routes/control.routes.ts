import { Router, Request, Response } from "express";
import { engine } from "../engine.js";
import {
  getSimulatorDb,
  getAllSimulatorScenarios,
  setSimulatorScenario,
  getSimulatorMetrics,
} from "../db.js";

const router = Router();

router.get("/status", (_req: Request, res: Response) => {
  const status = engine.getStatus();
  const scenarios = getAllSimulatorScenarios();
  const metrics = getSimulatorMetrics();

  res.json({
    ...status,
    scenarios,
    metrics,
  });
});

router.post("/start", (_req: Request, res: Response) => {
  engine.start();
  res.json({ success: true, message: "Simulation started", status: engine.getStatus() });
});

router.post("/pause", (_req: Request, res: Response) => {
  engine.pause();
  res.json({ success: true, message: "Simulation paused", status: engine.getStatus() });
});

router.post("/resume", (_req: Request, res: Response) => {
  engine.resume();
  res.json({ success: true, message: "Simulation resumed", status: engine.getStatus() });
});

router.post("/stop", (_req: Request, res: Response) => {
  engine.stop();
  res.json({ success: true, message: "Simulation stopped", status: engine.getStatus() });
});

router.post("/reset", (req: Request, res: Response) => {
  const seed = typeof req.body.seed === "number" ? req.body.seed : 12345;
  const count = typeof req.body.vehicle_count === "number" ? req.body.vehicle_count : 10;
  const mult = typeof req.body.speed_multiplier === "number" ? req.body.speed_multiplier : 1.0;

  engine.reset(seed, count, mult);
  res.json({ success: true, message: "Simulation reset", status: engine.getStatus() });
});

router.post("/speed", (req: Request, res: Response) => {
  const mult = parseFloat(req.body.speed_multiplier);
  if (isNaN(mult) || mult <= 0) {
    res.status(400).json({ error: "Invalid speed_multiplier" });
    return;
  }
  engine.setSpeedMultiplier(mult);
  res.json({ success: true, speedMultiplier: mult, status: engine.getStatus() });
});

router.get("/scenarios", (_req: Request, res: Response) => {
  res.json({ scenarios: getAllSimulatorScenarios() });
});

router.post("/scenarios", (req: Request, res: Response) => {
  const { scenario, enabled, config } = req.body;
  if (!scenario || typeof enabled !== "boolean") {
    res.status(400).json({ error: "Missing scenario or enabled boolean" });
    return;
  }
  setSimulatorScenario(scenario, enabled, config || {});
  res.json({ success: true, scenario, enabled, scenarios: getAllSimulatorScenarios() });
});

router.get("/metrics", (_req: Request, res: Response) => {
  res.json({ metrics: getSimulatorMetrics() });
});

router.get("/vehicles", (_req: Request, res: Response) => {
  const db = getSimulatorDb();
  const vehicles = db.prepare(`
    SELECT v.*,
      (SELECT MAX(s.sample_seq) FROM sim_samples s WHERE s.vehicle_id = v.id) as sample_seq,
      (SELECT s.timestamp FROM sim_samples s WHERE s.vehicle_id = v.id ORDER BY s.sample_seq DESC LIMIT 1) as sample_timestamp
    FROM sim_vehicles v
    ORDER BY v.oem_id, v.id
  `).all();
  res.json({ vehicles });
});

router.get("/webhooks/pending", (_req: Request, res: Response) => {
  const db = getSimulatorDb();
  const deliveries = db.prepare("SELECT * FROM sim_webhook_deliveries WHERE status = 'PENDING' ORDER BY created_at ASC").all();
  res.json({ count: deliveries.length, deliveries });
});

router.get("/webhooks/exhausted", (_req: Request, res: Response) => {
  const db = getSimulatorDb();
  const deliveries = db.prepare("SELECT * FROM sim_webhook_deliveries WHERE status = 'EXHAUSTED' ORDER BY created_at DESC").all();
  res.json({ count: deliveries.length, deliveries });
});

router.post("/webhooks/retry-exhausted", (_req: Request, res: Response) => {
  const db = getSimulatorDb();
  const result = db.prepare(`
    UPDATE sim_webhook_deliveries
    SET status = 'PENDING', attempts = 0, next_retry_at = datetime('now')
    WHERE status = 'EXHAUSTED'
  `).run();
  res.json({ success: true, retried_count: result.changes });
});

router.get("/webhooks/status", (_req: Request, res: Response) => {
  const db = getSimulatorDb();
  const rows = db.prepare("SELECT status, count(*) as c FROM sim_webhook_deliveries GROUP BY status").all() as { status: string; c: number }[];
  const counts: Record<string, number> = { PENDING: 0, DELIVERED: 0, EXHAUSTED: 0, CANCELLED: 0 };
  for (const r of rows) {
    counts[r.status] = r.c;
  }
  res.json(counts);
});

export default router;
