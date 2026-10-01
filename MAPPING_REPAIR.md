# Repairing OEM data without losing history

Open **Data Issues**, select an issue, and choose **Repair mapping & recover events**. The same workbench is available under **Data Pipeline → Mapping Profiles**.

1. **Understand:** inspect redacted original examples from the oldest and newest quarantined events. Choose the type of OEM change for practical guidance.
2. **Map:** select source fields and existing platform measurements. Clone existing rules as a starting point, choose conversions, and add fallback fields for mixed versions. Missing optional measurements stay unknown.
3. **Test:** save a draft and run a dry run on up to 60 historical examples. Review original and converted values, precise failures, and optional omissions. Tests never normalize events or change vehicle state.
4. **Apply and recover:** review the scope and publish an immutable version. Start recovery separately; it uses the durable queue, validates every selected event, restores valid history and rebuilds projections. Bad events remain quarantined with reasons and accurate remaining counts.

Drafts survive closing the screen. Editing a draft invalidates its prior test, and concurrent edits require reopening the latest revision. Published rules cannot be edited: create a new version instead. Recovery results can be reopened, and repeated requests do not duplicate a running recovery job. Disabling a published repair stops its future use without deleting recovered data; an active recovery must finish first.

## Changes and supported solutions

| OEM change | Workbench solution | What still needs investigation |
|---|---|---|
| Renamed field, moved wrapper or new nesting | Choose the new source path; add the old path as a fallback | A field's meaning cannot be inferred reliably from its name alone |
| Added fields | Map supported measurements, or leave fields unused in the original payload | A genuinely new measurement requires adding a supported canonical signal and its product behavior |
| Removed or occasionally null field | Mark the measurement optional or remove its rule; preserve unknown values | Missing source values cannot be reconstructed or replaced with fabricated sensor data |
| Numbers became strings | Numeric text is validated and converted | Empty strings, booleans, non-finite values and malformed numbers are blocked |
| Different distance, speed or percentage units | Select miles/km, mph/kmh, metres/km, fraction/percent, or explicit scale and offset | Plausible but incorrect units need human review of OEM documentation |
| Different temperature units | Fahrenheit/Celsius or explicit scale/offset, where a temperature measurement is supported | Adding a temperature signal not already in the canonical catalog is an adapter/product change |
| GPS order or scale changed | Select correct latitude/longitude sources; convert microdegrees | Out-of-range coordinates stay blocked. Both coordinates must be mapped or both omitted |
| Timestamps changed | Explicit Unix seconds, Unix milliseconds or timezone-qualified ISO | Missing times, ambiguous local times and OEM clock errors need an upstream correction; received time is not substituted |
| New boolean/status representations | Translate each observed OEM value to a platform value | Unknown codes are blocked instead of guessed |
| Old and new versions coexist | Fallback source paths and an optional exact format/version filter | The same path with different units needs a discriminator or separate OEM connection/version handling |
| Nested objects and fixed array positions | Select paths such as `telemetry.speed` or `sensors.0.reading` | Variable multi-record arrays need an ingestion adapter; fixed positions cannot safely identify changing sensor order |
| Unknown vehicle identifier | Follow guidance to map the OEM vehicle in Connections before recovery | The repair cannot invent a vehicle identity |
| Expired credentials or transport outage | Reconnect the OEM account or restore connectivity, then recover | A mapping cannot repair network or authentication failures |
| Conflicting reused event ID | Keep quarantined and request an OEM correction | Renaming fields does not resolve conflicting event identities |
| Broken JSON or irrecoverably corrupt measurement | Keep the original and failure reason; investigate upstream | A field mapping cannot recover bytes or measurements that were never supplied |

## Scope and compatibility

Connection-specific repairs are available to fleet managers and platform administrators for their authenticated fleet. Connector accounts cannot use the workbench. Shared OEM mappings remain under their existing administrator controls. Samples, drafts and replay requests are scoped to the current fleet and connection.

The default is **rejected formats on this connection**: recognized formats continue using their existing mappings. **Historical recovery only** does not change live ingestion. **All matching formats** deliberately replaces recognized live mapping on that connection; the test step checks up to 20 recent processed examples and shows changed output values for review. It does not rewrite already processed history.

Preview counts are samples, not a prediction for the entire backlog. Publishing requires at least one recoverable example, a current test revision, and no failed recognized-format regression examples. Successful tests validate structure, types and ranges; they cannot establish the semantic truth of OEM units, sensor calibration, or event timestamps. Recovery may still end in partial success.

Original raw events and payload hashes are preserved. Replay remains idempotent, records normalization attempts and mapping versions, and leaves genuinely bad records unresolved. No migration deletes existing data. Docker and cloud deployments use the same APIs and run the additive database migration on backend startup.

## Industry references behind the workflow

Versioned drafts and testing old examples follow the compatibility approach described by [Confluent's schema evolution documentation](https://docs.confluent.io/platform/7.7/schema-registry/fundamentals/schema-evolution.html). Its optional/default-field guidance informs handling missing fields; measured vehicle values here are explicitly left unknown rather than assigned defaults.

[AWS Glue Schema Registry](https://docs.aws.amazon.com/glue/latest/dg/schema-registry-works.html) checks schema compatibility before registering new versions. This project uses its own SQLite-backed version history and sample-based validation; it does not claim to implement Glue or exhaustive Avro/JSON Schema compatibility.

[OpenTelemetry telemetry schemas](https://opentelemetry.io/docs/specs/otel/schemas/) describe versioned transformations when attribute names change. Explicit source paths, fallbacks and immutable mapping versions apply that general principle to OEM events while keeping the original payload for traceability.
