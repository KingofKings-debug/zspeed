import { Router } from "express";
import { oemRepository } from "../repositories/oem.repository.js";
import { vehicleRepository } from "../repositories/vehicle.repository.js";
import { connectionRepository } from "../repositories/connection.repository.js";
import { getFleetId } from "../middleware/fleet.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const fleetId = getFleetId(req);
    const oems = oemRepository.findAll();

    const oemsWithCounts = oems.map((oem) => {
      const vehicles = vehicleRepository.findByOem(oem.id, fleetId);
      const connections = connectionRepository.findByOem(oem.id, fleetId);

      const activeConnection = connections.find((c) => c.status === "ACTIVE");

      return {
        ...oem,
        vehicle_count: vehicles.length,
        connections: connections.map((c) => ({
          id: c.id,
          label: c.label,
          status: c.status,
          vehicle_count: c.vehicle_count,
          last_data_received: c.last_data_received,
          error_message: c.error_message,
        })),
        has_active_connection: !!activeConnection,
        needs_setup: vehicles.length > 0 && connections.length === 0,
      };
    });

    res.json({ oems: oemsWithCounts });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const oem = oemRepository.findById(req.params.id);
    if (!oem) {
      res.status(404).json({ status: 404, code: "NOT_FOUND", message: "OEM not found" });
      return;
    }
    res.json(oem);
  } catch (err) {
    next(err);
  }
});

export default router;
