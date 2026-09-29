import { Router } from "express";
import { v4 as uuid } from "uuid";
import { integrationRequestRepository } from "../repositories/oem.repository.js";
import { getFleetId } from "../middleware/fleet.js";
import { AppError } from "../middleware/error.js";

const router = Router();

router.post("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const { manufacturer_name, fleet_size, desired_categories, contact_notes } = req.body;

    if (!manufacturer_name) {
      throw new AppError(400, "VALIDATION_ERROR", "manufacturer_name is required");
    }

    const request = integrationRequestRepository.create({
      id: uuid(),
      fleet_id: fleetId,
      manufacturer_name,
      fleet_size: fleet_size || 0,
      desired_categories: desired_categories || [],
      contact_notes: contact_notes || null,
      status: "SUBMITTED",
    });

    res.status(201).json(request);
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const requests = integrationRequestRepository.findByFleet(fleetId);
    res.json({ requests });
  } catch (err) {
    next(err);
  }
});

export default router;
