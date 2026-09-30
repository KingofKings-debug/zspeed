import { Router, Request, Response } from "express";
import { getSimulatorDb, getSimulatorScenario, recordSimulatorMetric } from "../db.js";
import { simulatorCommonMiddleware } from "./common.js";

const router = Router();
router.use(simulatorCommonMiddleware);

router.post("/oauth/token", (req: Request, res: Response) => {
  const { username } = req.body;
  if (username === "fail") {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "invalid_grant",
      message: "Authentication failed. Verify Navarro fleet credentials.",
    });
    return;
  }

  const expiredScenario = getSimulatorScenario("expired_auth");
  if (expiredScenario.enabled) {
    recordSimulatorMetric("errors_returned");
    res.status(401).json({
      error: "unauthorized",
      message: "Navarro credentials expired or revoked.",
    });
    return;
  }

  res.json({
    access_token: `nav_tok_${Date.now()}`,
    token_type: "Bearer",
    expires_in: 3600,
  });
});

router.get("/v1/vehicles", (req: Request, res: Response) => {
  const db = getSimulatorDb();
  const rows = db
    .prepare(
      "SELECT id, vin, make, model, year FROM sim_vehicles WHERE oem_id = 'oem_navarro' ORDER BY id ASC"
    )
    .all() as any[];

  const vehicles = rows.map((r) => ({
    oem_vehicle_id: r.id,
    vin: r.vin,
    model: `${r.make} ${r.model}`,
    year: r.year,
    available_categories: [
      "location",
      "fuel_level",
      "odometer",
      "cargo_weight",
      "temperature_zone",
      "driver_hours",
    ],
  }));

  res.json({
    contract: "navarro-simulation-v1",
    vehicles,
  });
});

router.get("/v1/vehicles/:id/telemetry", (req: Request, res: Response) => {
  const { id } = req.params;
  const db = getSimulatorDb();

  const sample = db
    .prepare(
      "SELECT * FROM sim_samples WHERE oem_id = 'oem_navarro' AND vehicle_id = ? ORDER BY sample_seq DESC LIMIT 1"
    )
    .get(id) as any;

  if (!sample) {
    res.status(404).json({
      error: "vehicle_not_found",
      message: `No telemetry found for Navarro vehicle ${id}`,
    });
    return;
  }

  let payload = {};
  try {
    payload = JSON.parse(sample.payload);
  } catch {}

  res.json({
    contract: "navarro-simulation-v1",
    vehicle_id: id,
    event_id: sample.id,
    timestamp: sample.timestamp,
    payload,
  });
});

router.get("/health", (req: Request, res: Response) => {
  res.json({
    healthy: true,
    message: "Navarro OEM simulation service active",
  });
});

export default router;
