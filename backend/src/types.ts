export type ConnectionStatus =
  | "NOT_CONFIGURED"
  | "AUTHORISING"
  | "VERIFYING"
  | "ACTIVE"
  | "DEGRADED"
  | "EXPIRED"
  | "DISCONNECTED";

export type VehicleDataStatus =
  | "AWAITING_DATA"
  | "RECEIVING"
  | "UNAUTHORISED_VEHICLE"
  | "STALE"
  | "NO_CONNECTION";

export interface Fleet {
  id: string;
  name: string;
  created_at: Date;
}

export interface SupportedOem {
  id: string;
  name: string;
  code: string;
  logo_url: string | null;
  supported_categories: string[];
  auth_type: string;
  is_active: boolean;
}

export interface Vehicle {
  id: string;
  fleet_id: string;
  vin: string;
  label: string | null;
  suggested_manufacturer: string | null;
  oem_id: string | null;
  connection_id: string | null;
  data_status: VehicleDataStatus;
  last_data_at: Date | null;
  import_batch_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OemConnection {
  id: string;
  fleet_id: string;
  oem_id: string;
  label: string;
  status: ConnectionStatus;
  account_identifier: string | null;
  authorized_at: Date | null;
  last_health_check: Date | null;
  last_data_received: Date | null;
  vehicle_count: number;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface VehicleSourceMapping {
  id: string;
  vehicle_id: string;
  connection_id: string;
  oem_vehicle_id: string;
  is_verified: boolean;
  data_categories: string[];
  created_at: Date;
}

export interface IntegrationRequest {
  id: string;
  fleet_id: string;
  manufacturer_name: string;
  fleet_size: number;
  desired_categories: string[];
  contact_notes: string | null;
  status: "SUBMITTED" | "REVIEWED" | "PLANNED";
  created_at: Date;
}

export interface ImportBatch {
  id: string;
  fleet_id: string;
  status: "PENDING" | "PREVIEWED" | "CONFIRMED" | "CANCELLED";
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  duplicate_rows: number;
  created_at: Date;
}

export interface ImportRow {
  id: string;
  batch_id: string;
  row_number: number;
  vin: string;
  label: string | null;
  suggested_manufacturer: string | null;
  oem_id: string | null;
  is_valid: boolean;
  is_duplicate: boolean;
  is_uncertain_match: boolean;
  error_message: string | null;
}

export interface VinDecodeResult {
  vin: string;
  manufacturer: string | null;
  oem_id: string | null;
  confidence: "HIGH" | "LOW" | "NONE";
}

export interface OemConnectorInterface {
  oemId: string;
  authorize(credentials: Record<string, string>): Promise<{ success: boolean; accountId: string; error?: string }>;
  discoverVehicles(accountId: string): Promise<OemDiscoveredVehicle[]>;
  getAvailableCategories(): string[];
  verifyAccess(accountId: string, vehicleIds: string[]): Promise<{ vehicleId: string; accessible: boolean }[]>;
  activate(connectionId: string): Promise<boolean>;
  checkHealth(connectionId: string): Promise<{ healthy: boolean; message: string }>;
  disconnect(connectionId: string): Promise<boolean>;
  reconnect(connectionId: string): Promise<boolean>;
}

export interface OemDiscoveredVehicle {
  oem_vehicle_id: string;
  vin: string;
  model: string;
  year: number;
  available_categories: string[];
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface CanonicalSignal {
  id: string;
  name: string;
  data_type: string;
  unit: string | null;
  description: string | null;
  valid_range_min: number | null;
  valid_range_max: number | null;
  missing_value_policy: string;
  created_at: Date;
}

export interface OemFormatVersion {
  id: string;
  oem_id: string;
  event_type: string;
  format_version: string;
  expected_structure: string | null;
  created_at: Date;
}

export interface MappingProfile {
  id: string;
  oem_format_version_id: string;
  mapping_version: string;
  canonical_schema_version: string;
  status: "DRAFT" | "ACTIVE" | "RETIRED";
  created_at: Date;
}

export interface MappingRule {
  id: string;
  mapping_profile_id: string;
  source_field_path: string;
  destination_signal_id: string;
  conversion_type: "DIRECT" | "MPH_TO_KMH" | "FRACTION_TO_PERCENT" | "MILES_TO_KM" | "ENUM_MAP";
  enum_mapping: Record<string, string> | null;
  validation_rule: string | null;
  created_at: Date;
}

export interface MappingTestCase {
  id: string;
  mapping_profile_id: string;
  raw_input: string;
  expected_output: string;
  created_at: Date;
}

export interface RawEvent {
  id: string;
  fleet_id: string;
  connection_id: string;
  source_event_id: string | null;
  source_vehicle_id: string;
  payload_hash: string;
  payload: string;
  processing_status: "PENDING" | "PROCESSED" | "QUARANTINED" | "DUPLICATE";
  recorded_at: Date;
}

export interface NormalizationAttempt {
  id: string;
  raw_event_id: string;
  mapping_profile_id: string | null;
  replay_job_id: string | null;
  status: "SUCCESS" | "FAILED";
  failure_reason: string | null;
  attempted_at: Date;
}

export interface NormalizedEvent {
  id: string;
  raw_event_id: string;
  vehicle_id: string;
  mapping_profile_id: string;
  canonical_values: Record<string, any>;
  quality_flags: string[];
  normalized_at: Date;
}

export interface VehicleCurrentState {
  vehicle_id: string;
  latest_values: Record<string, any>;
  updated_at: Date;
}

export interface ReplayJob {
  id: string;
  mapping_profile_id: string;
  selection_criteria: Record<string, any>;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
  total_events: number;
  processed_events: number;
  error_events: number;
  created_at: Date;
  completed_at: Date | null;
}
