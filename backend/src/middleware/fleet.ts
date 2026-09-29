import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

export function fleetContext(req: Request, _res: Response, next: NextFunction): void {
  const fleetId = req.headers["x-fleet-id"] as string || config.defaultFleetId;
  (req as any).fleetId = fleetId;
  next();
}

export function getFleetId(req: Request): string {
  return (req as any).fleetId || config.defaultFleetId;
}
