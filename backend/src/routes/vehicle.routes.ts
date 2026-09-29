import { Router } from "express";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { previewImport, confirmImport, addSingleVehicle } from "../services/import.service.js";
import { getFleetId } from "../middleware/fleet.js";
import { AppError } from "../middleware/error.js";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const search = req.query.search as string | undefined;
    const vehicles = vehicleRepository.findByFleet(fleetId, search);
    res.json({ vehicles });
  } catch (err) {
    next(err);
  }
});

router.get("/stats", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const stats = vehicleRepository.countByFleet(fleetId);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const vehicle = vehicleRepository.findById(req.params.id, fleetId);
    if (!vehicle) {
      throw new AppError(404, "NOT_FOUND", "Vehicle not found");
    }
    res.json(vehicle);
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { vin, label } = req.body;
    if (!vin) {
      throw new AppError(400, "VALIDATION_ERROR", "VIN is required");
    }
    const vehicle = addSingleVehicle(fleetId, vin, label);
    res.status(201).json(vehicle);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "VALIDATION_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

router.post("/import/preview", upload.single("file"), async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    let csvContent: string;

    if (req.file) {
      csvContent = req.file.buffer.toString("utf-8");
    } else if (req.body.csv) {
      csvContent = req.body.csv;
    } else {
      throw new AppError(400, "VALIDATION_ERROR", "No CSV file or content provided");
    }

    const result = previewImport(fleetId, csvContent);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/import/:batchId/confirm", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const result = confirmImport(fleetId, req.params.batchId);
    res.json(result);
  } catch (err: any) {
    if (err.message && !err.statusCode) {
      next(new AppError(400, "IMPORT_ERROR", err.message));
    } else {
      next(err);
    }
  }
});

export default router;
