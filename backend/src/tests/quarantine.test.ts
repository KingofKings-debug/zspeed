import { describe, it, expect, beforeEach } from "vitest";
import { categorizeFailure, isRetryable } from "../services/quarantine.service.js";

describe("categorizeFailure", () => {
  it("identifies SCHEMA_CHANGE for unknown format messages", () => {
    expect(categorizeFailure("Unknown format version: v3")).toBe("SCHEMA_CHANGE");
    expect(categorizeFailure("Unexpected structure in payload")).toBe("SCHEMA_CHANGE");
  });

  it("identifies INVALID_VALUE for out-of-range messages", () => {
    expect(categorizeFailure("Value 500 above maximum 300 for vehicle_speed (invalid value)")).toBe("INVALID_VALUE");
    expect(categorizeFailure("Invalid number value for signal odometer (type error)")).toBe("INVALID_VALUE");
    expect(categorizeFailure("Value -10 below min 0 for battery_soc")).toBe("INVALID_VALUE");
  });

  it("identifies MISSING_VEHICLE_MAPPING", () => {
    expect(categorizeFailure("Vehicle not mapped to any fleet vehicle")).toBe("MISSING_VEHICLE_MAPPING");
    expect(categorizeFailure("Vehicle ID not found in mappings")).toBe("MISSING_VEHICLE_MAPPING");
  });

  it("identifies EXPIRED_AUTH", () => {
    expect(categorizeFailure("OEM account authorisation has expired")).toBe("EXPIRED_AUTH");
    expect(categorizeFailure("Unauthorized access - token expired")).toBe("EXPIRED_AUTH");
  });

  it("identifies INFRA_ERROR for transient issues", () => {
    expect(categorizeFailure("Connection timeout")).toBe("INFRA_ERROR");
    expect(categorizeFailure("Service unavailable")).toBe("INFRA_ERROR");
  });

  it("defaults to SCHEMA_CHANGE for unknown messages", () => {
    expect(categorizeFailure("Some unexpected error")).toBe("SCHEMA_CHANGE");
  });
});

describe("isRetryable", () => {
  it("marks INFRA_ERROR as retryable", () => {
    expect(isRetryable("INFRA_ERROR")).toBe(true);
  });

  it("marks SCHEMA_CHANGE as not retryable", () => {
    expect(isRetryable("SCHEMA_CHANGE")).toBe(false);
  });

  it("marks INVALID_VALUE as not retryable", () => {
    expect(isRetryable("INVALID_VALUE")).toBe(false);
  });

  it("marks MISSING_VEHICLE_MAPPING as not retryable", () => {
    expect(isRetryable("MISSING_VEHICLE_MAPPING")).toBe(false);
  });

  it("marks EXPIRED_AUTH as not retryable", () => {
    expect(isRetryable("EXPIRED_AUTH")).toBe(false);
  });
});
