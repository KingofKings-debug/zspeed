import { execRaw, queryOne } from "./pool.js";

export function runMigrations(): void {
  console.log("Running database migrations...");

  execRaw(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    )
  `);

  const existing = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["001_initial"]
  );

  if (!existing) {
    execRaw(`
      CREATE TABLE fleets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE supported_oems (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        logo_url TEXT,
        supported_categories TEXT NOT NULL DEFAULT '[]',
        auth_type TEXT NOT NULL DEFAULT 'oauth_simulated',
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);

    execRaw(`
      CREATE TABLE vehicles (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        vin TEXT NOT NULL,
        label TEXT,
        suggested_manufacturer TEXT,
        oem_id TEXT REFERENCES supported_oems(id),
        connection_id TEXT,
        data_status TEXT NOT NULL DEFAULT 'NO_CONNECTION',
        last_data_at TEXT,
        import_batch_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(fleet_id, vin)
      )
    `);

    execRaw(`CREATE INDEX idx_vehicles_fleet ON vehicles(fleet_id)`);
    execRaw(`CREATE INDEX idx_vehicles_vin ON vehicles(vin)`);

    execRaw(`
      CREATE TABLE oem_connections (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        oem_id TEXT NOT NULL REFERENCES supported_oems(id),
        label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
        account_identifier TEXT,
        authorized_at TEXT,
        last_health_check TEXT,
        last_data_received TEXT,
        vehicle_count INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`CREATE INDEX idx_connections_fleet ON oem_connections(fleet_id)`);

    execRaw(`
      CREATE TABLE vehicle_source_mappings (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        connection_id TEXT NOT NULL REFERENCES oem_connections(id),
        oem_vehicle_id TEXT NOT NULL,
        is_verified INTEGER NOT NULL DEFAULT 0,
        data_categories TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE import_batches (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        status TEXT NOT NULL DEFAULT 'PENDING',
        total_rows INTEGER NOT NULL DEFAULT 0,
        valid_rows INTEGER NOT NULL DEFAULT 0,
        error_rows INTEGER NOT NULL DEFAULT 0,
        duplicate_rows INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE import_rows (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES import_batches(id),
        row_number INTEGER NOT NULL,
        vin TEXT NOT NULL,
        label TEXT,
        suggested_manufacturer TEXT,
        oem_id TEXT,
        is_valid INTEGER NOT NULL DEFAULT 1,
        is_duplicate INTEGER NOT NULL DEFAULT 0,
        is_uncertain_match INTEGER NOT NULL DEFAULT 0,
        error_message TEXT
      )
    `);

    execRaw(`
      CREATE TABLE integration_requests (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        manufacturer_name TEXT NOT NULL,
        fleet_size INTEGER NOT NULL DEFAULT 0,
        desired_categories TEXT NOT NULL DEFAULT '[]',
        contact_notes TEXT,
        status TEXT NOT NULL DEFAULT 'SUBMITTED',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`INSERT INTO _migrations (name) VALUES ('001_initial')`);
    console.log("Migration 001_initial applied.");
  }

  const pipelineExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["002_data_pipeline"]
  );

  if (!pipelineExisting) {
    execRaw(`
      CREATE TABLE canonical_signals (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        data_type TEXT NOT NULL,
        unit TEXT,
        description TEXT,
        valid_range_min REAL,
        valid_range_max REAL,
        missing_value_policy TEXT NOT NULL DEFAULT 'IGNORE',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE oem_format_versions (
        id TEXT PRIMARY KEY,
        oem_id TEXT NOT NULL REFERENCES supported_oems(id),
        event_type TEXT NOT NULL,
        format_version TEXT NOT NULL,
        expected_structure TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(oem_id, event_type, format_version)
      )
    `);

    execRaw(`
      CREATE TABLE mapping_profiles (
        id TEXT PRIMARY KEY,
        oem_format_version_id TEXT NOT NULL REFERENCES oem_format_versions(id),
        mapping_version TEXT NOT NULL,
        canonical_schema_version TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(oem_format_version_id, mapping_version)
      )
    `);

    execRaw(`
      CREATE TABLE mapping_rules (
        id TEXT PRIMARY KEY,
        mapping_profile_id TEXT NOT NULL REFERENCES mapping_profiles(id),
        source_field_path TEXT NOT NULL,
        destination_signal_id TEXT NOT NULL REFERENCES canonical_signals(id),
        conversion_type TEXT NOT NULL DEFAULT 'DIRECT',
        enum_mapping TEXT,
        validation_rule TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(mapping_profile_id, source_field_path)
      )
    `);

    execRaw(`
      CREATE TABLE mapping_test_cases (
        id TEXT PRIMARY KEY,
        mapping_profile_id TEXT NOT NULL REFERENCES mapping_profiles(id),
        raw_input TEXT NOT NULL,
        expected_output TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE raw_events (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        connection_id TEXT NOT NULL REFERENCES oem_connections(id),
        source_event_id TEXT,
        source_vehicle_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload TEXT NOT NULL,
        processing_status TEXT NOT NULL DEFAULT 'PENDING',
        recorded_at TEXT DEFAULT (datetime('now')),
        UNIQUE(fleet_id, connection_id, source_event_id, payload_hash)
      )
    `);

    execRaw(`CREATE INDEX idx_raw_events_fleet_conn ON raw_events(fleet_id, connection_id)`);
    execRaw(`CREATE INDEX idx_raw_events_status ON raw_events(processing_status)`);

    execRaw(`
      CREATE TABLE normalization_attempts (
        id TEXT PRIMARY KEY,
        raw_event_id TEXT NOT NULL REFERENCES raw_events(id),
        mapping_profile_id TEXT REFERENCES mapping_profiles(id),
        replay_job_id TEXT,
        status TEXT NOT NULL,
        failure_reason TEXT,
        attempted_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE normalized_events (
        id TEXT PRIMARY KEY,
        raw_event_id TEXT NOT NULL REFERENCES raw_events(id),
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        mapping_profile_id TEXT NOT NULL REFERENCES mapping_profiles(id),
        canonical_values TEXT NOT NULL,
        quality_flags TEXT NOT NULL DEFAULT '[]',
        event_time TEXT,
        latitude REAL,
        longitude REAL,
        altitude REAL,
        normalized_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`CREATE INDEX idx_normalized_events_vehicle ON normalized_events(vehicle_id)`);
    execRaw(`CREATE INDEX idx_normalized_events_time ON normalized_events(vehicle_id, event_time)`);

    execRaw(`
      CREATE TABLE vehicle_current_state (
        vehicle_id TEXT PRIMARY KEY REFERENCES vehicles(id),
        latest_values TEXT NOT NULL,
        signal_timestamps TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE replay_jobs (
        id TEXT PRIMARY KEY,
        mapping_profile_id TEXT NOT NULL REFERENCES mapping_profiles(id),
        selection_criteria TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        total_events INTEGER NOT NULL DEFAULT 0,
        processed_events INTEGER NOT NULL DEFAULT 0,
        error_events INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )
    `);

    execRaw(`INSERT INTO _migrations (name) VALUES ('002_data_pipeline')`);
    console.log("Migration 002_data_pipeline applied.");
  }

  const tripsExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["003_trips_quarantine"]
  );

  if (!tripsExisting) {
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN event_time TEXT`); } catch {}
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN latitude REAL`); } catch {}
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN longitude REAL`); } catch {}
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN altitude REAL`); } catch {}
    try { execRaw(`CREATE INDEX IF NOT EXISTS idx_normalized_events_time ON normalized_events(vehicle_id, event_time)`); } catch {}
    try { execRaw(`ALTER TABLE vehicle_current_state ADD COLUMN signal_timestamps TEXT NOT NULL DEFAULT '{}'`); } catch {}

    execRaw(`
      CREATE TABLE quarantine_incidents (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        oem_id TEXT,
        connection_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        failure_category TEXT NOT NULL,
        affected_vehicle_count INTEGER NOT NULL DEFAULT 0,
        unresolved_event_count INTEGER NOT NULL DEFAULT 0,
        first_failure_at TEXT NOT NULL,
        latest_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'UNRESOLVED',
        stale_projections TEXT NOT NULL DEFAULT '[]',
        last_valid_data_at TEXT,
        acknowledged_by TEXT,
        acknowledged_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`CREATE INDEX idx_quarantine_incidents_fleet ON quarantine_incidents(fleet_id)`);
    execRaw(`CREATE INDEX idx_quarantine_incidents_status ON quarantine_incidents(status)`);

    execRaw(`
      CREATE TABLE quarantine_records (
        id TEXT PRIMARY KEY,
        raw_event_id TEXT NOT NULL REFERENCES raw_events(id),
        incident_id TEXT REFERENCES quarantine_incidents(id),
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        connection_id TEXT NOT NULL REFERENCES oem_connections(id),
        oem_id TEXT NOT NULL,
        vehicle_id TEXT,
        failure_category TEXT NOT NULL,
        expected_format TEXT,
        observed_format TEXT,
        failure_detail TEXT,
        first_failure_at TEXT NOT NULL,
        latest_attempt_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'UNRESOLVED',
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`CREATE INDEX idx_quarantine_records_fleet ON quarantine_records(fleet_id)`);
    execRaw(`CREATE INDEX idx_quarantine_records_incident ON quarantine_records(incident_id)`);
    execRaw(`CREATE INDEX idx_quarantine_records_status ON quarantine_records(status)`);

    execRaw(`
      CREATE TABLE trips (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        trip_number INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        duration_seconds INTEGER,
        distance_km REAL NOT NULL DEFAULT 0,
        completeness_pct REAL NOT NULL DEFAULT 100,
        processing_version TEXT NOT NULL DEFAULT '1',
        projection_status TEXT NOT NULL DEFAULT 'CURRENT',
        quality_notes TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`CREATE INDEX idx_trips_vehicle ON trips(vehicle_id)`);
    execRaw(`CREATE INDEX idx_trips_started ON trips(vehicle_id, started_at)`);

    execRaw(`
      CREATE TABLE trip_routes (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL UNIQUE REFERENCES trips(id),
        ordered_points TEXT NOT NULL DEFAULT '[]',
        simplified_points TEXT NOT NULL DEFAULT '[]',
        bounding_box TEXT,
        point_count INTEGER NOT NULL DEFAULT 0,
        has_gaps INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`
      CREATE TABLE trip_events (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL REFERENCES trips(id),
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        event_type TEXT NOT NULL,
        event_time TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        severity TEXT NOT NULL DEFAULT 'INFO',
        source_normalized_event_id TEXT REFERENCES normalized_events(id),
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`CREATE INDEX idx_trip_events_trip ON trip_events(trip_id)`);
    execRaw(`CREATE INDEX idx_trip_events_vehicle ON trip_events(vehicle_id)`);

    execRaw(`
      CREATE TABLE vehicle_daily_summary (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        fleet_id TEXT NOT NULL REFERENCES fleets(id),
        date TEXT NOT NULL,
        total_distance_km REAL NOT NULL DEFAULT 0,
        trip_count INTEGER NOT NULL DEFAULT 0,
        idle_duration_seconds INTEGER NOT NULL DEFAULT 0,
        event_counts TEXT NOT NULL DEFAULT '{}',
        projection_status TEXT NOT NULL DEFAULT 'CURRENT',
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(vehicle_id, date)
      )
    `);

    execRaw(`CREATE INDEX idx_daily_summary_vehicle ON vehicle_daily_summary(vehicle_id)`);

    execRaw(`
      CREATE TABLE projection_rebuild_jobs (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        fleet_id TEXT NOT NULL,
        from_time TEXT,
        to_time TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        progress_pct INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )
    `);

    execRaw(`CREATE INDEX idx_rebuild_jobs_vehicle ON projection_rebuild_jobs(vehicle_id)`);
    execRaw(`CREATE INDEX idx_rebuild_jobs_status ON projection_rebuild_jobs(status)`);

    execRaw(`
      CREATE TABLE job_queue (
        id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'PENDING',
        priority INTEGER NOT NULL DEFAULT 5,
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      )
    `);

    execRaw(`CREATE INDEX idx_job_queue_status ON job_queue(status, priority, created_at)`);

    execRaw(`INSERT INTO _migrations (name) VALUES ('003_trips_quarantine')`);
    console.log("Migration 003_trips_quarantine applied.");
  }

  const alterExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["004_alter_normalized_events"]
  );

  if (!alterExisting) {
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN event_time TEXT`); } catch {}
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN latitude REAL`); } catch {}
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN longitude REAL`); } catch {}
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN altitude REAL`); } catch {}
    try { execRaw(`CREATE INDEX IF NOT EXISTS idx_normalized_events_time ON normalized_events(vehicle_id, event_time)`); } catch {}
    try { execRaw(`ALTER TABLE vehicle_current_state ADD COLUMN signal_timestamps TEXT NOT NULL DEFAULT '{}'`); } catch {}
    execRaw(`INSERT INTO _migrations (name) VALUES ('004_alter_normalized_events')`);
    console.log("Migration 004_alter_normalized_events applied.");
  }

  const schemaVerExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["005_canonical_schema_version"]
  );

  if (!schemaVerExisting) {
    try { execRaw(`ALTER TABLE normalized_events ADD COLUMN canonical_schema_version TEXT DEFAULT '1.0'`); } catch {}
    execRaw(`INSERT INTO _migrations (name) VALUES ('005_canonical_schema_version')`);
    console.log("Migration 005_canonical_schema_version applied.");
  }

  const durableQueueExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["006_durable_queue_and_replay"]
  );

  if (!durableQueueExisting) {
    try { execRaw(`ALTER TABLE job_queue ADD COLUMN worker_id TEXT`); } catch {}
    try { execRaw(`ALTER TABLE job_queue ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`); } catch {}
    try { execRaw(`ALTER TABLE job_queue ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3`); } catch {}
    try { execRaw(`ALTER TABLE job_queue ADD COLUMN run_after TEXT`); } catch {}
    try { execRaw(`CREATE INDEX IF NOT EXISTS idx_job_queue_claim ON job_queue(status, run_after, priority, created_at)`); } catch {}

    try { execRaw(`ALTER TABLE raw_events ADD COLUMN idempotency_key TEXT`); } catch {}
    try { execRaw(`CREATE INDEX IF NOT EXISTS idx_raw_events_idempotency ON raw_events(connection_id, source_event_id, payload_hash)`); } catch {}

    try { execRaw(`ALTER TABLE replay_jobs ADD COLUMN fleet_id TEXT`); } catch {}
    try { execRaw(`ALTER TABLE replay_jobs ADD COLUMN incident_id TEXT`); } catch {}
    try { execRaw(`ALTER TABLE replay_jobs ADD COLUMN started_at TEXT`); } catch {}
    try { execRaw(`ALTER TABLE replay_jobs ADD COLUMN progress_pct INTEGER NOT NULL DEFAULT 0`); } catch {}
    try { execRaw(`ALTER TABLE replay_jobs ADD COLUMN final_outcome TEXT`); } catch {}
    try { execRaw(`ALTER TABLE replay_jobs ADD COLUMN error_message TEXT`); } catch {}

    try { execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_normalized_events_raw_event_id ON normalized_events(raw_event_id)`); } catch {}

    execRaw(`INSERT INTO _migrations (name) VALUES ('006_durable_queue_and_replay')`);
    console.log("Migration 006_durable_queue_and_replay applied.");
  }

  const socketEventsExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["007_fleet_socket_events"]
  );

  if (!socketEventsExisting) {
    execRaw(`
      CREATE TABLE IF NOT EXISTS fleet_socket_events (
        id TEXT PRIMARY KEY,
        fleet_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_id TEXT,
        vehicle_id TEXT,
        source_event_time TEXT,
        server_received_time TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    execRaw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fleet_socket_events_seq ON fleet_socket_events(fleet_id, sequence)`);
    execRaw(`CREATE INDEX IF NOT EXISTS idx_fleet_socket_events_cursor ON fleet_socket_events(fleet_id, sequence)`);
    execRaw(`CREATE INDEX IF NOT EXISTS idx_fleet_socket_events_veh ON fleet_socket_events(vehicle_id)`);

    execRaw(`
      CREATE TABLE IF NOT EXISTS fleet_event_cursors (
        fleet_id TEXT PRIMARY KEY,
        last_sequence INTEGER NOT NULL DEFAULT 0
      )
    `);

    try { execRaw(`ALTER TABLE vehicles ADD COLUMN live_state TEXT NOT NULL DEFAULT 'OFFLINE'`); } catch {}
    try { execRaw(`ALTER TABLE vehicles ADD COLUMN last_telemetry_time TEXT`); } catch {}

    execRaw(`INSERT INTO _migrations (name) VALUES ('007_fleet_socket_events')`);
    console.log("Migration 007_fleet_socket_events applied.");
  }

  const connectorExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["008_connector_cursors_and_webhooks"]
  );

  if (!connectorExisting) {
    execRaw(`
      CREATE TABLE IF NOT EXISTS connector_cursors (
        connection_id TEXT NOT NULL,
        vehicle_id TEXT NOT NULL,
        cursor TEXT,
        last_polled_at TEXT,
        PRIMARY KEY(connection_id, vehicle_id)
      )
    `);

    execRaw(`
      CREATE TABLE IF NOT EXISTS connector_webhook_subscriptions (
        connection_id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        oem_id TEXT NOT NULL,
        secret TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    execRaw(`INSERT INTO _migrations (name) VALUES ('008_connector_cursors_and_webhooks')`);
    console.log("Migration 008_connector_cursors_and_webhooks applied.");
  }

  const vaultExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["009_durable_vault_and_insights"]
  );

  if (!vaultExisting) {
    execRaw(`
      CREATE TABLE IF NOT EXISTS encrypted_credentials (
        secret_ref TEXT PRIMARY KEY,
        iv TEXT NOT NULL,
        tag TEXT NOT NULL,
        encrypted_data TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    try {
      execRaw(`ALTER TABLE oem_connections ADD COLUMN credentials_vault_id TEXT`);
    } catch {}

    execRaw(`
      CREATE TABLE IF NOT EXISTS fleet_insights (
        fleet_id TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        affected_count INTEGER NOT NULL DEFAULT 0,
        affected_vehicles TEXT NOT NULL DEFAULT '[]',
        details TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(fleet_id, metric_key)
      )
    `);

    execRaw(`INSERT INTO _migrations (name) VALUES ('009_durable_vault_and_insights')`);
    console.log("Migration 009_durable_vault_and_insights applied.");
  }

  const insightIndexesExisting = queryOne<{ name: string }>(
    "SELECT name FROM _migrations WHERE name = ?",
    ["010_insight_lookup_indexes"]
  );
  if (!insightIndexesExisting) {
    execRaw("CREATE INDEX IF NOT EXISTS idx_quarantine_records_vehicle_status ON quarantine_records(vehicle_id, status)");
    execRaw("CREATE INDEX IF NOT EXISTS idx_quarantine_incidents_fleet_status ON quarantine_incidents(fleet_id, status)");
    execRaw("INSERT INTO _migrations (name) VALUES ('010_insight_lookup_indexes')");
    console.log("Migration 010_insight_lookup_indexes applied.");
  }

  if (!queryOne("SELECT name FROM _migrations WHERE name = '011_mapping_repairs'")) {
    execRaw(`CREATE TABLE mapping_repairs (
      profile_id TEXT PRIMARY KEY REFERENCES mapping_profiles(id),
      fleet_id TEXT NOT NULL REFERENCES fleets(id),
      connection_id TEXT NOT NULL REFERENCES oem_connections(id),
      incident_id TEXT NOT NULL REFERENCES quarantine_incidents(id),
      configuration TEXT NOT NULL,
      created_by TEXT NOT NULL,
      published_by TEXT,
      published_at TEXT,
      validation_report TEXT,
      revision INTEGER NOT NULL DEFAULT 1
    )`);
    execRaw("CREATE INDEX idx_mapping_repairs_connection ON mapping_repairs(fleet_id, connection_id, published_at)");
    execRaw(`UPDATE quarantine_records SET vehicle_id = (
      SELECT vsm.vehicle_id FROM vehicle_source_mappings vsm JOIN vehicles v ON v.id = vsm.vehicle_id
      WHERE vsm.connection_id = quarantine_records.connection_id AND vsm.oem_vehicle_id = (
        SELECT source_vehicle_id FROM raw_events WHERE id = quarantine_records.raw_event_id
      ) AND v.fleet_id = quarantine_records.fleet_id LIMIT 1
    ) WHERE vehicle_id IS NULL`);
    execRaw(`UPDATE quarantine_incidents SET
      unresolved_event_count = (SELECT COUNT(DISTINCT raw_event_id) FROM quarantine_records WHERE incident_id = quarantine_incidents.id AND status != 'RESOLVED'),
      affected_vehicle_count = (SELECT COUNT(DISTINCT vehicle_id) FROM quarantine_records WHERE incident_id = quarantine_incidents.id AND status != 'RESOLVED')`);
    execRaw("INSERT INTO _migrations(name) VALUES ('011_mapping_repairs')");
  }

  console.log("Migrations complete.");
}

if (process.argv[1]?.endsWith("migrate.ts") || process.argv[1]?.endsWith("migrate.js")) {
  runMigrations();
}
