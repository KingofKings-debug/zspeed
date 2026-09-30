import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";
import { AppError } from "./error.js";

export interface AuthIdentity {
  userId: string;
  fleetId: string;
  role: "fleet_manager" | "platform_admin" | "connector";
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthIdentity;
    }
  }
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (config.demoMode) {
    if (!authHeader) {
      const xFleetId = req.headers["x-fleet-id"];
      if (typeof xFleetId === "string" && xFleetId.trim().length > 0) {
        req.auth = {
          userId: `demo_${xFleetId}_fleet_manager`,
          fleetId: xFleetId.trim(),
          role: "fleet_manager",
        };
        return next();
      }

      req.auth = {
        userId: "demo_user",
        fleetId: config.defaultFleetId,
        role: "fleet_manager",
      };
      return next();
    }
  }

  if (!authHeader) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new AppError(401, "UNAUTHORIZED", "Invalid authorization header");
  }

  const token = parts[1];

  if (token.startsWith("demo:")) {
    if (!config.demoMode) {
      throw new AppError(401, "UNAUTHORIZED", "Demo tokens are not accepted in production");
    }
    const segments = token.split(":");
    if (segments.length < 3) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid demo token format. Expected demo:<fleetId>:<role>");
    }
    const fleetId = segments[1];
    const role = segments[2] as AuthIdentity["role"];
    if (!["fleet_manager", "platform_admin", "connector"].includes(role)) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid role in demo token");
    }
    req.auth = {
      userId: `demo_${fleetId}_${role}`,
      fleetId,
      role,
    };
    return next();
  }

  throw new AppError(401, "UNAUTHORIZED", "Invalid token");
}

export function requireRole(...roles: AuthIdentity["role"][]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      throw new AppError(401, "UNAUTHORIZED", "Authentication required");
    }
    if (!roles.includes(req.auth.role)) {
      throw new AppError(403, "FORBIDDEN", "Insufficient permissions");
    }
    next();
  };
}

export function getFleetId(req: Request): string {
  if (!req.auth) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }
  return req.auth.fleetId;
}

export function fleetContext(req: Request, res: Response, next: NextFunction): void {
  authMiddleware(req, res, next);
}
