import type { Request, Response, NextFunction } from "express";
import crypto from "crypto";
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

export function signAuthToken(payload: {
  userId: string;
  fleetId: string;
  role: AuthIdentity["role"];
  expiresInSeconds?: number;
}): string {
  if (!config.jwtSecret) {
    throw new Error("JWT secret is not configured");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (payload.expiresInSeconds || 86400);
  const body = Buffer.from(
    JSON.stringify({
      sub: payload.userId,
      fleetId: payload.fleetId,
      role: payload.role,
      iat: now,
      exp,
    })
  ).toString("base64url");
  const data = `${header}.${body}`;
  const signature = crypto.createHmac("sha256", config.jwtSecret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

export function verifyAuthToken(rawToken: string): AuthIdentity {
  const token = rawToken.startsWith("Bearer ") ? rawToken.slice(7).trim() : rawToken.trim();

  if (token.startsWith("demo:")) {
    if (!config.demoMode) {
      throw new AppError(401, "UNAUTHORIZED", "Demo tokens are not accepted outside demo mode");
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
    return {
      userId: `demo_${fleetId}_${role}`,
      fleetId,
      role,
    };
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token format");
  }

  const [headerB64, payloadB64, signature] = parts;
  if (!config.jwtSecret) {
    throw new AppError(500, "CONFIG_ERROR", "JWT secret is not configured");
  }

  const data = `${headerB64}.${payloadB64}`;
  const expectedSig = crypto.createHmac("sha256", config.jwtSecret).update(data).digest("base64url");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid token signature");
  }

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Malformed token payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && typeof payload.exp === "number" && payload.exp < now) {
    throw new AppError(401, "UNAUTHORIZED", "Token has expired");
  }

  if (!payload.fleetId || typeof payload.fleetId !== "string") {
    throw new AppError(401, "UNAUTHORIZED", "Invalid fleet in token");
  }

  const role = payload.role as AuthIdentity["role"];
  if (!["fleet_manager", "platform_admin", "connector"].includes(role)) {
    throw new AppError(401, "UNAUTHORIZED", "Invalid role in token");
  }

  return {
    userId: payload.sub || `user_${payload.fleetId}`,
    fleetId: payload.fleetId,
    role,
  };
}

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (config.demoMode && !authHeader) {
    const xFleetId = req.headers["x-fleet-id"];
    if (typeof xFleetId === "string" && xFleetId.trim().length > 0) {
      req.auth = {
        userId: `demo_${xFleetId.trim()}_fleet_manager`,
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

  if (!authHeader) {
    throw new AppError(401, "UNAUTHORIZED", "Authentication required");
  }

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") {
    throw new AppError(401, "UNAUTHORIZED", "Invalid authorization header format");
  }

  const identity = verifyAuthToken(parts[1]);
  req.auth = identity;
  next();
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
