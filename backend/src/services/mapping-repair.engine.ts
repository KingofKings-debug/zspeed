import { getNestedValue } from "./format-contract.service.js";

export const REPAIR_CONVERSIONS = ["DIRECT", "MPH_TO_KMH", "MILES_TO_KM", "FRACTION_TO_PERCENT", "METRES_TO_KM", "CELSIUS_FROM_FAHRENHEIT", "MICRODEGREES_TO_DEGREES", "UNIX_SECONDS", "UNIX_MILLISECONDS", "ISO_TIME", "ENUM_MAP", "SCALE_OFFSET"] as const;
export interface RepairRule {
  signal_id: string;
  sources: string[];
  conversion: typeof REPAIR_CONVERSIONS[number];
  required: boolean;
  enum_map?: Record<string, string>;
  scale?: number;
  offset?: number;
}
export interface RepairConfiguration {
  name: string;
  rules: RepairRule[];
  live_mode: "invalid_only" | "matching" | "replay_only";
  discriminator?: { path: string; value: string };
  field_decisions?: Record<string, 'IGNORE' | 'REMOVED'>;
}
export interface CanonicalSignal { id: string; name: string; data_type: string; unit: string | null; description: string; valid_range_min: number | null; valid_range_max: number | null }
export interface RepairResult { success: boolean; normalized: Record<string, any>; errors: string[]; warnings: string[]; fields: { signal: string; source: string | null; raw: any; value: any; status: string }[] }

export function inspectFields(payload: any, prefix = "", result: { path: string; type: string; example: any }[] = [], depth = 0) {
  if (depth > 12 || result.length >= 200) return result;
  if (payload && typeof payload === "object") {
    for (const [key, value] of Object.entries(payload).slice(0, 200)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      inspectFields(value, prefix ? `${prefix}.${key}` : key, result, depth + 1);
    }
  } else if (prefix) result.push({ path: prefix, type: payload === null ? "null" : typeof payload, example: payload });
  return result;
}

export function matchesRepairPayload(configuration: RepairConfiguration, payload: any): boolean {
  const discriminator = configuration.discriminator;
  if (discriminator && String(getNestedValue(payload, discriminator.path)) !== discriminator.value) return false;
  return configuration.rules.filter(rule => rule.required).every(rule => rule.sources.some(path => getNestedValue(payload, path) !== undefined));
}

function asNumber(value: any): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) throw new Error("Expected a number or numeric text");
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Value is not a finite number");
  return number;
}

export function evaluateRepair(configuration: RepairConfiguration, payload: any, signals: CanonicalSignal[]): RepairResult {
  const normalized: Record<string, any> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  const fields: RepairResult["fields"] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { success: false, normalized, errors: ["The event must contain a JSON object"], warnings, fields };
  if (configuration.discriminator && !matchesRepairPayload({ ...configuration, rules: [] }, payload)) errors.push("The format/version filter does not match this event");
  for (const rule of configuration.rules) {
    const signal = signals.find(item => item.id === rule.signal_id);
    if (!signal) { errors.push("Unknown destination signal"); continue; }
    const source = rule.sources.find(path => { const value = getNestedValue(payload, path); return value !== undefined && value !== null; });
    const raw = source ? getNestedValue(payload, source) : undefined;
    if (!source) {
      if (rule.required) errors.push(`${signal.name}: required field is missing or null`);
      else warnings.push(`${signal.name}: unavailable; left unknown`);
      fields.push({ signal: signal.name, source: null, raw: null, value: null, status: rule.required ? "blocked" : "missing" });
      continue;
    }
    try {
      let value = raw;
      switch (rule.conversion) {
        case "MPH_TO_KMH": case "MILES_TO_KM": value = asNumber(raw) * 1.60934; break;
        case "FRACTION_TO_PERCENT": value = asNumber(raw) * 100; break;
        case "METRES_TO_KM": value = asNumber(raw) / 1000; break;
        case "CELSIUS_FROM_FAHRENHEIT": value = (asNumber(raw) - 32) * 5 / 9; break;
        case "MICRODEGREES_TO_DEGREES": value = asNumber(raw) / 1e6; break;
        case "SCALE_OFFSET": value = asNumber(raw) * (rule.scale ?? 1) + (rule.offset ?? 0); break;
        case "UNIX_SECONDS": case "UNIX_MILLISECONDS": {
          const timestamp = asNumber(raw) * (rule.conversion === "UNIX_SECONDS" ? 1000 : 1);
          if (timestamp <= 0 || !Number.isFinite(timestamp)) throw new Error("Invalid Unix timestamp");
          value = new Date(timestamp).toISOString(); break;
        }
        case "ISO_TIME":
          if (typeof raw !== "string" || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(raw) || Number.isNaN(Date.parse(raw))) throw new Error("Use an ISO timestamp with an explicit timezone");
          value = new Date(raw).toISOString(); break;
        case "ENUM_MAP": {
          if (!rule.enum_map || !Object.hasOwn(rule.enum_map, String(raw))) throw new Error(`No value mapping for '${String(raw)}'`);
          value = rule.enum_map[String(raw)]; break;
        }
      }
      if (signal.data_type === "NUMBER") {
        value = asNumber(value);
        if (signal.valid_range_min !== null && value < signal.valid_range_min) throw new Error(`Below minimum ${signal.valid_range_min} ${signal.unit || ""}`);
        if (signal.valid_range_max !== null && value > signal.valid_range_max) throw new Error(`Above maximum ${signal.valid_range_max} ${signal.unit || ""}`);
      } else if (typeof value !== "string") throw new Error("Expected text; use a value mapping for flags or codes");
      if (signal.name === "event_time") {
        if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || Number.isNaN(Date.parse(value))) throw new Error("A valid event timestamp and timezone are required");
        value = new Date(value).toISOString();
      }
      const allowedEnums: Record<string, string[]> = { ignition_status: ["ON", "OFF"], harsh_brake: ["YES", "NO"], charging_state: ["CHARGING", "NOT_CHARGING"], idle_state: ["IDLE", "MOVING"] };
      if (allowedEnums[signal.name] && !allowedEnums[signal.name].includes(value)) throw new Error(`Choose one of ${allowedEnums[signal.name].join(", ")}`);
      normalized[signal.name] = value;
      fields.push({ signal: signal.name, source, raw, value, status: "mapped" });
    } catch (error: any) {
      errors.push(`${signal.name}: ${error.message}`);
      fields.push({ signal: signal.name, source, raw, value: null, status: "blocked" });
    }
  }
  if (!normalized.event_time) errors.push("Event time must be mapped; received time is not a substitute");
  if ((normalized.latitude === undefined) !== (normalized.longitude === undefined)) errors.push("Map both latitude and longitude, or leave both unknown");
  if (Object.keys(normalized).filter(key => key !== "event_time").length === 0) errors.push("At least one genuine vehicle measurement is required");
  return { success: errors.length === 0, normalized, errors, warnings, fields };
}
