import { Router, Request, Response } from "express";
import { v4 as uuid } from "uuid";
import { getSimulatorDb, getSimulatorScenario, recordSimulatorMetric } from "../db.js";
import { simulatorCommonMiddleware } from "./common.js";

const router = Router();
router.use(simulatorCommonMiddleware);

function verifyCrestlineApiKey(req: Request, res: Response, next: () => void) {
  const expiredScenario = getSimulatorScenario("expired_auth");
  if (expiredScenario.enabled) {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "api_key_revoked",
      message: "Crestline API key has been revoked or expired.",
    });
    return;
  }

  const apiKey = (req.headers["x-api-key"] as string) || (req.query.api_key as string);
  if (!apiKey || apiKey === "fail") {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "invalid_api_key",
      message: "Invalid API key. Provide a valid Crestline dealer API key in X-API-Key header.",
    });
    return;
  }

  next();
}

router.get("/v1/fleet/vehicles", verifyCrestlineApiKey, (req: Request, res: Response) => {
  const db = getSimulatorDb();
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string, 10) || 5));
  const cursor = (req.query.cursor as string) || "";

  let sql = `
    SELECT id, vin, make, model, year
    FROM sim_vehicles
    WHERE oem_id = 'oem_crestline'
  `;
  const params: any[] = [];
  if (cursor) {
    sql += " AND id > ?";
    params.push(cursor);
  }
  sql += " ORDER BY id ASC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as any[];

  const data = rows.map((r) => ({
    oem_vehicle_id: r.id,
    vin: r.vin,
    model: `${r.make} ${r.model}`,
    year: r.year,
    available_categories: ["location", "odometer", "engine_status", "diagnostics", "door_status"],
  }));

  const nextCursor = rows.length > 0 ? rows[rows.length - 1].id : null;

  res.json({
    contract: "crestline-simulation-v1",
    data,
    pagination: {
      next_cursor: nextCursor,
      has_more: rows.length === limit,
    },
  });
});

router.post("/v1/fleet/verify-access", verifyCrestlineApiKey, (req: Request, res: Response) => {
  const { vehicle_ids } = req.body;
  const list = Array.isArray(vehicle_ids) ? vehicle_ids : [];

  const results = list.map((vehicleId: string) => ({
    vehicleId,
    accessible: true,
  }));

  res.json({ results });
});

router.get("/v1/vehicles/:id/feed", verifyCrestlineApiKey, (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getSimulatorDb();

  const sample = db
    .prepare(
      "SELECT * FROM sim_samples WHERE oem_id = 'oem_crestline' AND vehicle_id = ? ORDER BY sample_seq DESC LIMIT 1"
    )
    .get(id) as any;

  if (!sample) {
    res.status(404).json({
      error: "vehicle_not_found",
      message: `No feed available for Crestline vehicle ${id}`,
    });
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(sample.payload);
  } catch {}

  recordSimulatorMetric("samples_delivered");

  res.json({
    contract: "crestline-simulation-v1",
    event_id: sample.id,
    sequence: sample.sample_seq,
    ...payload,
  });
});

router.get("/v1/vehicles/:id/history", verifyCrestlineApiKey, (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getSimulatorDb();

  const cursor = parseInt(req.query.cursor as string, 10) || 0;
  const limit = Math.max(1, Math.min(50, parseInt(req.query.limit as string, 10) || 10));
  const since = req.query.since as string | undefined;

  const maxSeqRow = db
    .prepare("SELECT MAX(sample_seq) as max_seq FROM sim_samples WHERE oem_id = 'oem_crestline' AND vehicle_id = ?")
    .get(id) as any;
  const maxSeq = maxSeqRow?.max_seq || 0;
  const effectiveCursor = cursor > maxSeq ? 0 : cursor;

  let querySql = `
    SELECT * FROM sim_samples
    WHERE oem_id = 'oem_crestline' AND vehicle_id = ? AND sample_seq > ?
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

  const data = samples.map((s) => {
    let parsed = {};
    try {
      parsed = JSON.parse(s.payload);
    } catch {}
    return {
      event_id: s.id,
      sequence: s.sample_seq,
      time: s.timestamp,
      payload: parsed,
    };
  });

  const lastSeq = samples.length > 0 ? samples[samples.length - 1].sample_seq : (cursor > maxSeq ? maxSeq : cursor);

  if (data.length > 0) {
    recordSimulatorMetric("samples_delivered", data.length);
  }

  res.json({
    contract: "crestline-simulation-v1",
    vehicle_identifier: id,
    data,
    pagination: {
      next_cursor: String(lastSeq),
      has_more: samples.length === limit,
    },
  });
});

router.post("/v1/webhooks/subscriptions", verifyCrestlineApiKey, (req: Request, res: Response) => {
  const { target_url, secret, events } = req.body;
  if (!target_url || !secret) {
    res.status(400).json({
      error: "validation_error",
      message: "target_url and secret are required",
    });
    return;
  }

  const subId = `sub_crestline_${uuid().slice(0, 8)}`;
  const db = getSimulatorDb();

  db.prepare(`
    INSERT INTO sim_subscriptions (id, oem_id, target_url, secret, active)
    VALUES (?, 'oem_crestline', ?, ?, 1)
  `).run(subId, target_url, secret);

  res.status(201).json({
    contract: "crestline-simulation-v1",
    subscription_id: subId,
    status: "ACTIVE",
    target_url,
    events: events || ["telemetry"],
  });
});

router.delete("/v1/webhooks/subscriptions/:id", verifyCrestlineApiKey, (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getSimulatorDb();
  db.prepare("DELETE FROM sim_subscriptions WHERE id = ?").run(id);
  db.prepare("UPDATE sim_webhook_deliveries SET status = 'CANCELLED' WHERE subscription_id = ? AND status = 'PENDING'").run(id);

  res.json({
    contract: "crestline-simulation-v1",
    subscription_id: id,
    status: "CANCELLED",
  });
});

router.get("/health", (req: Request, res: Response) => {
  const expiredScenario = getSimulatorScenario("expired_auth");
  if (expiredScenario.enabled) {
    res.status(401).json({
      healthy: false,
      message: "Crestline simulator API key invalid/expired",
      expired: true,
    });
    return;
  }

  res.json({
    healthy: true,
    message: "Crestline OEM simulation service active",
  });
});

export default router;
