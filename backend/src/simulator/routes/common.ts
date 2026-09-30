import { Request, Response, NextFunction } from "express";
import { v4 as uuid } from "uuid";
import { getSimulatorScenario, recordSimulatorMetric } from "../db.js";

export function simulatorCommonMiddleware(req: Request, res: Response, next: NextFunction): void {
  const reqId = (req.headers["x-request-id"] as string) || uuid();
  res.setHeader("X-Request-Id", reqId);
  res.setHeader("X-RateLimit-Limit", "60");
  res.setHeader("X-RateLimit-Remaining", "59");
  res.setHeader("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 60));

  recordSimulatorMetric("requests_total");

  const oem = req.baseUrl.split("/")[2] || "general";
  recordSimulatorMetric(`requests_${oem}`);

  const outageScenario = getSimulatorScenario("delivery_outage");
  if (outageScenario.enabled) {
    recordSimulatorMetric("errors_returned");
    res.status(503).json({
      error: "service_unavailable",
      message: "OEM API delivery outage in progress",
    });
    return;
  }

  const errScenario = getSimulatorScenario("transient_5xx");
  if (errScenario.enabled) {
    recordSimulatorMetric("errors_returned");
    res.status(503).json({
      error: "oem_temporary_failure",
      message: "OEM API returned transient 503 error",
    });
    return;
  }

  const rateLimitScenario = getSimulatorScenario("rate_limit");
  if (rateLimitScenario.enabled) {
    recordSimulatorMetric("rate_limits_hit");
    res.setHeader("Retry-After", "5");
    res.setHeader("X-RateLimit-Remaining", "0");
    res.status(429).json({
      error: "rate_limit_exceeded",
      message: "Too Many Requests. Rate limit exceeded.",
      retry_after_seconds: 5,
    });
    return;
  }

  next();
}
