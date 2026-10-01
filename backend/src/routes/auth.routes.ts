import { Router } from "express";
import { config } from "../config.js";
import { signAuthToken, verifyAuthToken } from "../middleware/fleet.js";
import { AppError } from "../middleware/error.js";

const router = Router();

const FLEET_ACCOUNTS: Record<string, { passwordHash: string; fleetId: string; role: "fleet_manager" | "platform_admin" }> = {};

function loadFleetAccounts() {
  const raw = process.env.FLEET_ACCOUNTS;
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Array<{ username: string; password: string; fleetId: string; role?: string }>;
    for (const acct of parsed) {
      FLEET_ACCOUNTS[acct.username] = {
        passwordHash: acct.password,
        fleetId: acct.fleetId,
        role: (acct.role as "fleet_manager" | "platform_admin") || "fleet_manager",
      };
    }
  } catch {
    throw new Error("FLEET_ACCOUNTS must be valid JSON when set");
  }
}

loadFleetAccounts();

router.post("/login", (req, res, next) => {
  try {
    if (config.demoMode) {
      throw new AppError(400, "DEMO_MODE", "Use /api/auth/demo in demo mode");
    }
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password) {
      throw new AppError(400, "BAD_REQUEST", "username and password are required");
    }
    const account = FLEET_ACCOUNTS[username];
    if (!account || account.passwordHash !== password) {
      throw new AppError(401, "UNAUTHORIZED", "Invalid credentials");
    }
    const token = signAuthToken({
      userId: username,
      fleetId: account.fleetId,
      role: account.role,
      expiresInSeconds: 86400,
    });
    res.json({ token, fleetId: account.fleetId, role: account.role, expiresIn: 86400 });
  } catch (err) {
    next(err);
  }
});

router.post("/demo", (req, res, next) => {
  try {
    if (!config.demoMode) {
      throw new AppError(403, "FORBIDDEN", "Demo access is not enabled on this platform");
    }
    const fleetId = (req.body as any)?.fleetId || config.defaultFleetId;
    const token = `demo:${fleetId}:fleet_manager`;
    res.json({ token, fleetId, role: "fleet_manager", demo: true });
  } catch (err) {
    next(err);
  }
});

router.get("/config", (_req, res) => {
  res.json({ demoMode: config.demoMode });
});

router.post("/refresh", (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new AppError(401, "UNAUTHORIZED", "No token provided");
    }
    const identity = verifyAuthToken(authHeader);
    if (identity.userId.startsWith("demo_")) {
      const token = `demo:${identity.fleetId}:${identity.role}`;
      return res.json({ token, fleetId: identity.fleetId, role: identity.role, demo: true });
    }
    const token = signAuthToken({
      userId: identity.userId,
      fleetId: identity.fleetId,
      role: identity.role,
      expiresInSeconds: 86400,
    });
    res.json({ token, fleetId: identity.fleetId, role: identity.role, expiresIn: 86400 });
  } catch (err) {
    next(err);
  }
});

export default router;
