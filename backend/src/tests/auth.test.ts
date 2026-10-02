import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer } from "http";
import request from "supertest";
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { closeDb } from '../db/pool.js';

process.env.NODE_ENV = "test";
process.env.DEMO_MODE = "true";
process.env.DEFAULT_FLEET_ID = "fleet_auth_test";
process.env.JWT_SECRET = "test-jwt-secret-auth-2026";
process.env.ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { config } from "../config.js";
import authRoutes from "../routes/auth.routes.js";
import { fleetContext } from "../middleware/fleet.js";
import { errorHandler } from "../middleware/error.js";
import { signAuthToken } from "../middleware/fleet.js";

const app = express();
app.use(express.json());
app.use("/api/auth", authRoutes);

const protectedRouter = express.Router();
protectedRouter.use(fleetContext);
protectedRouter.get("/ping", (req, res) => {
  res.json({ ok: true, fleetId: req.auth!.fleetId });
});
app.use("/api/protected", protectedRouter);
app.use(errorHandler);

describe("Auth routes – demo mode", () => {
  it("GET /api/auth/config returns demoMode:true", async () => {
    const res = await request(app).get("/api/auth/config");
    expect(res.status).toBe(200);
    expect(res.body.demoMode).toBe(true);
  });

  it("POST /api/auth/demo returns demo token and fleetId", async () => {
    const res = await request(app).post("/api/auth/demo").send({});
    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^demo:/);
    expect(res.body.demo).toBe(true);
    expect(res.body.fleetId).toBeTruthy();
  });

  it("POST /api/auth/demo with custom fleetId uses it", async () => {
    const res = await request(app).post("/api/auth/demo").send({ fleetId: "custom_fleet" });
    expect(res.status).toBe(200);
    expect(res.body.token).toContain("custom_fleet");
    expect(res.body.fleetId).toBe("custom_fleet");
  });

  it("POST /api/auth/login returns 400 in demo mode", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "admin", password: "pass" });
    expect(res.status).toBe(400);
  });

  it("demo token accepted by protected route", async () => {
    const tokenRes = await request(app).post("/api/auth/demo").send({});
    const token = tokenRes.body.token;
    const res = await request(app).get("/api/protected/ping").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("no token returns 401 from protected route when demo has no x-fleet-id header", async () => {
    const testApp = express();
    testApp.use(express.json());
    const strict = express.Router();
    strict.use((req, _res, next) => {
      const origDemoMode = config.demoMode;
      (config as any).demoMode = false;
      fleetContext(req, _res, (err) => {
        (config as any).demoMode = origDemoMode;
        next(err);
      });
    });
    strict.get("/ping", (_req, res) => res.json({ ok: true }));
    testApp.use("/protected", strict);
    testApp.use(errorHandler);

    const res = await request(testApp).get("/protected/ping");
    expect(res.status).toBe(401);
  });
});

describe("Auth routes – production mode (JWT)", () => {
  beforeAll(() => {
    (config as any).demoMode = false;
    process.env.FLEET_ACCOUNTS = JSON.stringify([
      { username: "testmanager", password: "secret123", fleetId: "fleet_prod_001", role: "fleet_manager" },
    ]);
    (authRoutes as any)._reloadAccounts?.();
  });

  afterAll(() => {
    (config as any).demoMode = true;
    delete process.env.FLEET_ACCOUNTS;
  });

  it("POST /api/auth/demo is forbidden in production mode", async () => {
    const res = await request(app).post("/api/auth/demo").send({});
    expect(res.status).toBe(403);
  });
});

describe("Token verification", () => {
  it("valid JWT token is accepted by protected route", async () => {
    (config as any).demoMode = false;
    const token = signAuthToken({ userId: "u1", fleetId: "fleet_jwt_001", role: "fleet_manager", expiresInSeconds: 3600 });
    const testApp = express();
    testApp.use(express.json());
    const r = express.Router();
    r.use(fleetContext);
    r.get("/ping", (req, res) => res.json({ fleetId: req.auth!.fleetId }));
    testApp.use("/protected", r);
    testApp.use(errorHandler);

    const res = await request(testApp).get("/protected/ping").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.fleetId).toBe("fleet_jwt_001");
    (config as any).demoMode = true;
  });

  it("expired JWT token returns 401", async () => {
    (config as any).demoMode = false;
    const token = signAuthToken({ userId: "u1", fleetId: "fleet_exp", role: "fleet_manager", expiresInSeconds: -1 });
    const testApp = express();
    testApp.use(express.json());
    const r = express.Router();
    r.use(fleetContext);
    r.get("/ping", (_req, res) => res.json({ ok: true }));
    testApp.use("/protected", r);
    testApp.use(errorHandler);

    const res = await request(testApp).get("/protected/ping").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    (config as any).demoMode = true;
  });

  it("tampered JWT token returns 401", async () => {
    (config as any).demoMode = false;
    const token = signAuthToken({ userId: "u1", fleetId: "fleet_ok", role: "fleet_manager" });
    const parts = token.split(".");
    const tamperedPayload = Buffer.from(JSON.stringify({ fleetId: "fleet_evil", role: "platform_admin" })).toString("base64url");
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const testApp = express();
    testApp.use(express.json());
    const r = express.Router();
    r.use(fleetContext);
    r.get("/ping", (_req, res) => res.json({ ok: true }));
    testApp.use("/protected", r);
    testApp.use(errorHandler);

    const res = await request(testApp).get("/protected/ping").set("Authorization", `Bearer ${tampered}`);
    expect(res.status).toBe(401);
    (config as any).demoMode = true;
  });

  it("403 permission denied for wrong role", async () => {
    (config as any).demoMode = false;
    const token = signAuthToken({ userId: "u1", fleetId: "fleet_ok", role: "fleet_manager" });
    const testApp = express();
    testApp.use(express.json());
    import("../middleware/fleet.js").then(({ requireRole }) => {});
    const { requireRole } = await import("../middleware/fleet.js");
    const r = express.Router();
    r.use(fleetContext);
    r.get("/admin", requireRole("platform_admin"), (_req, res) => res.json({ ok: true }));
    testApp.use("/protected", r);
    testApp.use(errorHandler);

    const res = await request(testApp).get("/protected/admin").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
    (config as any).demoMode = true;
  });
});

describe("API error handling – vehicles endpoint", () => {
  let isolatedDirectory:string;
  beforeAll(()=>{
    isolatedDirectory=fs.mkdtempSync(path.join(os.tmpdir(),'zspeed-auth-test-'));
    process.env.OVERRIDE_DB_PATH=path.join(isolatedDirectory,'auth.db');
  });
  afterAll(()=>{closeDb();delete process.env.OVERRIDE_DB_PATH;fs.rmSync(isolatedDirectory,{recursive:true,force:true});});
  it("GET /api/vehicles with demo token returns vehicles array", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use(fleetContext);

    const { runMigrations } = await import("../db/migrate.js");
    const { seedDatabase } = await import("../db/seed.js");
    runMigrations();
    seedDatabase();

    const { default: vehicleRoutes } = await import("../routes/vehicle.routes.js");
    testApp.use("/api/vehicles", vehicleRoutes);
    testApp.use(errorHandler);

    const tokenRes = await request(app).post("/api/auth/demo").send({});
    const token = tokenRes.body.token;

    const res = await request(testApp).get("/api/vehicles").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.vehicles)).toBe(true);
  });

  it("GET /api/vehicles without token returns 401 in non-demo mode", async () => {
    (config as any).demoMode = false;
    const testApp = express();
    testApp.use(express.json());
    testApp.use(fleetContext);
    const { default: vehicleRoutes } = await import("../routes/vehicle.routes.js");
    testApp.use("/api/vehicles", vehicleRoutes);
    testApp.use(errorHandler);

    const res = await request(testApp).get("/api/vehicles");
    expect(res.status).toBe(401);
    (config as any).demoMode = true;
  });
});
