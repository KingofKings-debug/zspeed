import { Router, Request, Response } from "express";
import { getSimulatorDb, getSimulatorScenario, recordSimulatorMetric } from "../db.js";
import { simulatorCommonMiddleware } from "./common.js";

const router = Router();
router.use(simulatorCommonMiddleware);

router.post("/oauth/token", (req: Request, res: Response) => {
  const { username, password, client_id, client_secret } = req.body;

  if (username === "fail" || password === "fail" || client_secret === "fail") {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "invalid_grant",
      message: "Invalid credentials. Check your Voltera portal login.",
    });
    return;
  }

  const expiredScenario = getSimulatorScenario("expired_auth");
  if (expiredScenario.enabled) {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "unauthorized",
      message: "Voltera credentials expired or revoked.",
    });
    return;
  }

  res.json({
    access_token: `vlt_tok_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "telemetry:read fleet:read",
  });
});

function verifyVolteraToken(req: Request, res: Response, next: () => void) {
  const expiredScenario = getSimulatorScenario("expired_auth");
  if (expiredScenario.enabled) {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "token_expired",
      message: "Voltera access token has expired or is invalid.",
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.includes("invalid")) {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid Bearer token.",
    });
    return;
  }

  next();
}

router.get("/v1/vehicles", verifyVolteraToken, (req: Request, res: Response) => {
  const db = getSimulatorDb();
  const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string, 10) || 5));
  const offset = (page - 1) * limit;

  const total = (
    db
      .prepare("SELECT COUNT(*) as c FROM sim_vehicles WHERE oem_id = 'oem_voltera'")
      .get() as any
  )?.c || 0;

  const rows = db
    .prepare(
      "SELECT id, vin, make, model, year FROM sim_vehicles WHERE oem_id = 'oem_voltera' ORDER BY id ASC LIMIT ? OFFSET ?"
    )
    .all(limit, offset) as any[];

  const vehicles = rows.map((r) => ({
    oem_vehicle_id: r.id,
    vin: r.vin,
    model: `${r.make} ${r.model}`,
    year: r.year,
    available_categories: [
      "location",
      "fuel_level",
      "odometer",
      "engine_status",
      "tire_pressure",
      "battery_voltage",
    ],
  }));

  res.json({
    contract: "voltera-simulation-v1",
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
    has_more: offset + rows.length < total,
    vehicles,
  });
});

router.post("/v1/vehicles/verify-access", verifyVolteraToken, (req: Request, res: Response) => {
  const { vehicle_ids } = req.body;
  const list = Array.isArray(vehicle_ids) ? vehicle_ids : [];

  const results = list.map((vehicleId: string) => ({
    vehicleId,
    accessible: vehicleId !== "VLT-004",
  }));

  res.json({ results });
});

router.get("/v1/vehicles/:id/telemetry/latest", verifyVolteraToken, (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getSimulatorDb();

  const sample = db
    .prepare(
      "SELECT * FROM sim_samples WHERE oem_id = 'oem_voltera' AND vehicle_id = ? ORDER BY sample_seq DESC LIMIT 1"
    )
    .get(id) as any;

  if (!sample) {
    res.status(404).json({
      error: "vehicle_not_found",
      message: `No telemetry found for Voltera vehicle ${id}`,
    });
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(sample.payload);
  } catch {}

  recordSimulatorMetric("samples_delivered");

  res.json({
    contract: "voltera-simulation-v1",
    vehicle_id: id,
    event_id: sample.id,
    sequence: sample.sample_seq,
    source_timestamp: sample.timestamp,
    payload,
  });
});

router.get("/v1/vehicles/:id/telemetry/history", verifyVolteraToken, (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getSimulatorDb();

  const cursor = parseInt(req.query.cursor as string, 10) || 0;
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string, 10) || 10));
  const since = req.query.since as string | undefined;

  const maxSeqRow = db
    .prepare("SELECT MAX(sample_seq) as max_seq FROM sim_samples WHERE oem_id = 'oem_voltera' AND vehicle_id = ?")
    .get(id) as any;
  const maxSeq = maxSeqRow?.max_seq || 0;
  const effectiveCursor = cursor > maxSeq ? 0 : cursor;

  let querySql = `
    SELECT * FROM sim_samples
    WHERE oem_id = 'oem_voltera' AND vehicle_id = ? AND sample_seq > ?
  `;
  const params: any[] = [id, effectiveCursor];

  if (since) {
    querySql += " AND timestamp >= ?";
    params.push(since);
  }

  querySql += " ORDER BY sample_seq ASC LIMIT ?";
  params.push(limit);

  let samples = db.prepare(querySql).all(...params) as any[];

  const dupScenario = getSimulatorScenario("duplicate_delivery");
  if (dupScenario.enabled && samples.length > 0) {
    samples = [samples[0], ...samples];
  }

  const outOfOrderScenario = getSimulatorScenario("delayed_out_of_order");
  if (outOfOrderScenario.enabled && samples.length > 1) {
    samples = [...samples].reverse();
  }

  const events = samples.map((s) => {
    let parsed = {};
    try {
      parsed = JSON.parse(s.payload);
    } catch {}
    return {
      event_id: s.id,
      sequence: s.sample_seq,
      timestamp: s.timestamp,
      payload: parsed,
    };
  });

  const lastSeq = samples.length > 0 ? samples[samples.length - 1].sample_seq : (cursor > maxSeq ? maxSeq : cursor);

  if (events.length > 0) {
    recordSimulatorMetric("samples_delivered", events.length);
  }

  res.json({
    contract: "voltera-simulation-v1",
    vehicle_id: id,
    events,
    next_cursor: String(lastSeq),
    has_more: samples.length === limit,
  });
});

router.get("/health", (req: Request, res: Response) => {
  const expiredScenario = getSimulatorScenario("expired_auth");
  if (expiredScenario.enabled) {
    res.status(401).json({
      healthy: false,
      message: "Voltera simulator credentials expired",
      expired: true,
    });
    return;
  }

  res.json({
    healthy: true,
    message: "Voltera OEM simulation service active",
  });
});

export default router;
