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

export interface Vehicle {
  id: string;
  fleet_id: string;
  vin: string;
  label: string | null;
  suggested_manufacturer: string | null;
  oem_id: string | null;
  connection_id: string | null;
  data_status: VehicleDataStatus;
  last_data_at: string | null;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupportedOem {
  id: string;
  name: string;
  code: string;
  supported_categories: string[];
  auth_type: string;
  is_active: boolean;
  vehicle_count: number;
  connections: OemConnectionSummary[];
  has_active_connection: boolean;
  needs_setup: boolean;
}

export interface OemConnectionSummary {
  id: string;
  label: string;
  status: ConnectionStatus;
  vehicle_count: number;
  last_data_received: string | null;
  error_message: string | null;
}

export interface OemConnection {
  id: string;
  fleet_id: string;
  oem_id: string;
  label: string;
  status: ConnectionStatus;
  account_identifier: string | null;
  authorized_at: string | null;
  last_health_check: string | null;
  last_data_received: string | null;
  vehicle_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface ImportBatch {
  id: string;
  fleet_id: string;
  status: string;
  total_rows: number;
  valid_rows: number;
  error_rows: number;
  duplicate_rows: number;
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

export interface DiscoveredVehicle {
  oem_vehicle_id: string;
  vin: string;
  model: string;
  year: number;
  available_categories: string[];
}

export interface VehicleStats {
  total: number;
  receiving: number;
  no_connection: number;
  attention: number;
}

export interface MappingProfile {
  id: string;
  oem_format_version_id: string;
  mapping_version: string;
  canonical_schema_version: string;
  status: string;
  created_at: string;
}

export interface RawEvent {
  id: string;
  fleet_id: string;
  connection_id: string;
  source_event_id: string | null;
  source_vehicle_id: string;
  payload_hash: string;
  payload: string;
  processing_status: string;
  recorded_at: string;
}

export interface PipelineHealth {
  total_events: number;
  processed: number;
  quarantined: number;
  duplicates: number;
  unresolved_incidents: number;
  pending_jobs: number;
}

export type QuarantineStatus = "UNRESOLVED" | "MAPPING_READY" | "REPLAYING" | "RESOLVED" | "REPLAY_FAILED";
export type FailureCategory = "SCHEMA_CHANGE" | "INVALID_VALUE" | "MISSING_VEHICLE_MAPPING" | "EXPIRED_AUTH" | "INFRA_ERROR" | "UNSUPPORTED_OEM" | "UNKNOWN_FORMAT";

export interface QuarantineIncident {
  id: string;
  fleet_id: string;
  oem_id: string | null;
  connection_id: string | null;
  oem_name: string | null;
  connection_label: string | null;
  title: string;
  description: string | null;
  failure_category: FailureCategory;
  affected_vehicle_count: number;
  unresolved_event_count: number;
  first_failure_at: string;
  latest_at: string;
  status: QuarantineStatus;
  stale_projections: string[];
  last_valid_data_at: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuarantineRecord {
  id: string;
  raw_event_id: string;
  incident_id: string | null;
  fleet_id: string;
  connection_id: string;
  oem_id: string;
  vehicle_id: string | null;
  failure_category: FailureCategory;
  expected_format: string | null;
  observed_format: string | null;
  failure_detail: string | null;
  first_failure_at: string;
  latest_attempt_at: string;
  status: QuarantineStatus;
  retry_count: number;
}

export interface Trip {
  id: string;
  vehicle_id: string;
  fleet_id: string;
  trip_number: number;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  distance_km: number;
  completeness_pct: number;
  projection_status: "CURRENT" | "REBUILDING" | "STALE";
  quality_notes: string[];
  has_gaps: 0 | 1 | null;
  point_count: number | null;
  event_count: number;
}

export interface TripEvent {
  id: string;
  trip_id: string;
  vehicle_id: string;
  event_type: "TRIP_START" | "TRIP_END" | "HARSH_BRAKE" | "EXTENDED_IDLE" | "CHARGING" | "FAULT" | "SPEED_VIOLATION";
  event_time: string;
  latitude: number | null;
  longitude: number | null;
  severity: "INFO" | "WARNING" | "CRITICAL";
  source_normalized_event_id: string | null;
  metadata: Record<string, any>;
}

export interface VehicleSignalState {
  latestValues: Record<string, any>;
  signalTimestamps: Record<string, string>;
  updatedAt: string;
}

export interface VehicleDetail {
  vehicle: Vehicle & { oem_name: string | null };
  currentState: VehicleSignalState | null;
  latestTrip: Trip | null;
  unresolvedQuarantineCount: number;
}

export interface TripQuality {
  tripId: string;
  projectionStatus: string;
  completeness: number;
  hasGaps: boolean;
  pointCount: number;
  quarantinedEvents: number;
  issues: string[];
}
