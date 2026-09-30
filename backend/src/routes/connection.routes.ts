import { Router } from "express";
import { connectionRepository } from "../repositories/connection.repository.js";
import { getFleetId } from "../middleware/fleet.js";
import { AppError } from "../middleware/error.js";
import {
  createConnection,
  authorizeConnection,
  discoverVehicles,
  activateConnection,
  disconnectConnection,
  reconnectConnection,
  checkConnectionHealth,
} from "../services/connection.service.js";

const router = Router();

function verifyConnection(connectionId: string, fleetId: string) {
  const conn = connectionRepository.findById(connectionId, fleetId);
  if (!conn) {
    throw new AppError(404, "NOT_FOUND", "Connection not found");
  }
  return conn;
}

router.get("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const connections = connectionRepository.findByFleet(fleetId);
    res.json({ connections });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const conn = verifyConnection(req.params.id, fleetId);
    res.json(conn);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { oem_id, label } = req.body;
    if (!oem_id) {
      throw new AppError(400, "VALIDATION_ERROR", "oem_id is required");
    }
    const conn = createConnection(fleetId, oem_id, label);
    res.status(201).json(conn);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "CONNECTION_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.post("/:id/authorize", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyConnection(req.params.id, fleetId);
    const { credentials } = req.body;
    if (!credentials) {
      throw new AppError(400, "VALIDATION_ERROR", "credentials are required");
    }
    const result = await authorizeConnection(req.params.id, fleetId, credentials);
    res.json(result);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "AUTH_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.get("/:id/discover", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyConnection(req.params.id, fleetId);
    const vehicles = await discoverVehicles(req.params.id, fleetId);
    res.json({ vehicles });
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "DISCOVERY_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.post("/:id/activate", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyConnection(req.params.id, fleetId);
    const { vehicles } = req.body;
    if (!vehicles || !Array.isArray(vehicles)) {
      throw new AppError(400, "VALIDATION_ERROR", "vehicles array is required");
    }
    const result = await activateConnection(req.params.id, fleetId, vehicles);
    res.json(result);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "ACTIVATION_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.post("/:id/disconnect", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyConnection(req.params.id, fleetId);
    await disconnectConnection(req.params.id, fleetId);
    res.json({ success: true });
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "DISCONNECT_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.post("/:id/reconnect", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyConnection(req.params.id, fleetId);
    const result = await reconnectConnection(req.params.id, fleetId);
    res.json(result);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "RECONNECT_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.get("/:id/health", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    verifyConnection(req.params.id, fleetId);
    const result = await checkConnectionHealth(req.params.id, fleetId);
    res.json(result);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "HEALTH_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

export default router;
