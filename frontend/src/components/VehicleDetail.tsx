import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api";
import type { VehicleDetail, Trip, TripEvent, TripQuality, VehicleLiveState } from "../types";
import MapView, { type LivePosition } from "./MapView";
import { subscribeToFleetEvents, subscribeVehicleTracking, unsubscribeVehicleTracking } from "../socket";
import { useVehicleEntry, vehicleStore } from "../store/vehicleStore";
import ErrorBoundary from "./ErrorBoundary";
import { isMapCoordinate } from "../map-data";

function renderLiveBadge(movementState: string | null, freshness?: string | null) {
  if (freshness === "STALE") {
    return <span className="status-badge status-degraded" data-testid="freshness-badge"><span className="status-dot" />Data delayed</span>;
  }
  if (freshness === "OFFLINE") {
    return <span className="status-badge status-no-connection" data-testid="freshness-badge"><span className="status-dot" />Offline</span>;
  }
  if (!movementState) return null;
  switch (movementState) {
    case "MOVING":
      return <span className="status-badge status-active" data-testid="movement-badge"><span className="status-dot" />Live · moving</span>;
    case "IDLE":
      return <span className="status-badge status-receiving" data-testid="movement-badge"><span className="status-dot" />Live · stationary</span>;
    case "PARKED":
      return <span className="status-badge status-awaiting" data-testid="movement-badge"><span className="status-dot" />Parked</span>;
    case "CHARGING":
      return <span className="status-badge status-active" data-testid="movement-badge"><span className="status-dot" />Charging</span>;
    case "DATA_RECENT":
      return <span className="status-badge status-receiving" data-testid="movement-badge"><span className="status-dot" />Data recent</span>;
    case "STALE":
      return <span className="status-badge status-degraded" data-testid="freshness-badge"><span className="status-dot" />Data delayed</span>;
    case "OFFLINE":
      return <span className="status-badge status-no-connection" data-testid="freshness-badge"><span className="status-dot" />Offline</span>;
    case "CONNECTED":
      return <span className="status-badge status-awaiting" data-testid="movement-badge"><span className="status-dot" />Connected</span>;
    default:
      return null;
  }
}

interface Props {
  vehicleId: string;
  onBack: () => void;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "–";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDist(km: number): string {
  return km >= 1 ? `${km.toFixed(1)} km` : `${(km * 1000).toFixed(0)} m`;
}

function formatDate(d: string | null): string {
  if (!d) return "–";
  return new Date(d).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function formatTime(d: string | null): string {
  if (!d) return "–";
  return new Date(d).toLocaleTimeString(undefined, { timeStyle: "short" });
}

function SignalCard({ label, value, ts, testId }: { label: string; value: any; ts?: string; testId?: string }) {
  return (
    <div className="signal-card" data-testid={testId}>
      <div className="signal-card-label">{label}</div>
      <div className="signal-card-value">{value ?? "–"}</div>
      {ts && <div className="signal-card-ts">as of {formatTime(ts)}</div>}
    </div>
  );
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  TRIP_START: "var(--color-success)",
  TRIP_END: "var(--color-primary)",
  HARSH_BRAKE: "var(--color-error)",
  FAULT: "#8b0000",
  EXTENDED_IDLE: "var(--color-warning)",
  CHARGING: "var(--color-success)",
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  TRIP_START: "Trip started",
  TRIP_END: "Trip ended",
  HARSH_BRAKE: "Harsh braking",
  FAULT: "Diagnostic fault",
  EXTENDED_IDLE: "Extended idle",
  CHARGING: "Charging",
  SPEED_VIOLATION: "Speed violation",
};

function DataQualityBanner({ quality }: { quality: TripQuality | null }) {
  if (!quality || quality.issues.length === 0) return null;

  const issueMessages: Record<string, string> = {
    MISSING_GPS_SEGMENTS: "Route has GPS gaps — map shows an approximation.",
    QUARANTINED_EVENTS: `${quality.quarantinedEvents} event(s) during this trip could not be processed.`,
    PROJECTION_REBUILDING: "Trip data is being rebuilt — values may update shortly.",
    PROJECTION_STALE: "Trip data is outdated and scheduled for a rebuild.",
  };

  return (
    <div className="data-quality-banner">
      <span className="data-quality-icon">⚠</span>
      <div>
        {quality.issues.map((issue) => (
          <div key={issue} className="data-quality-issue">
            {issueMessages[issue] || issue}
          </div>
        ))}
        {quality.completeness < 100 && (
          <div className="data-quality-completeness">
            Data completeness: {quality.completeness}%
          </div>
        )}
      </div>
    </div>
  );
}

function TripRow({
  trip,
  selected,
  onClick,
}: {
  trip: Trip;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <tr
      className={`trip-row ${selected ? "trip-row-selected" : ""}`}
      onClick={onClick}
      style={{ cursor: "pointer" }}
    >
      <td className="mono">{new Date(trip.started_at).toLocaleDateString()}</td>
      <td>{formatDuration(trip.duration_seconds)}</td>
      <td>{formatDist(trip.distance_km)}</td>
      <td>
        <div className="completeness-bar-wrap">
          <div
            className="completeness-bar"
            style={{ width: `${trip.completeness_pct}%` }}
          />
          <span>{Math.round(trip.completeness_pct)}%</span>
        </div>
      </td>
      <td>
        {trip.projection_status === "REBUILDING" && (
          <span className="status-badge status-verifying"><span className="status-dot" />Rebuilding</span>
        )}
        {trip.projection_status === "STALE" && (
          <span className="status-badge status-degraded"><span className="status-dot" />Stale</span>
        )}
        {trip.has_gaps ? <span className="trip-gap-tag">GPS gaps</span> : null}
      </td>
    </tr>
  );
}

function EventTimelineItem({
  event,
  selected,
  onClick,
}: {
  event: TripEvent;
  selected: boolean;
  onClick: () => void;
}) {
  const color = EVENT_TYPE_COLORS[event.event_type] || "var(--color-primary)";
  let metadata = event.metadata;
  if (typeof metadata === "string") {
    try { metadata = JSON.parse(metadata); } catch { metadata = {}; }
  }
  return (
    <div
      className={`timeline-item ${selected ? "timeline-item-selected" : ""}`}
      onClick={onClick}
    >
      <div className="timeline-dot" style={{ background: color }} />
      <div className="timeline-content">
        <div className="timeline-type">{EVENT_TYPE_LABELS[event.event_type] || event.event_type}</div>
        <div className="timeline-time">{formatTime(event.event_time)}</div>
        {metadata?.fault_code && (
          <div className="timeline-meta">Code: {metadata.fault_code}</div>
        )}
        {metadata?.duration_seconds && (
          <div className="timeline-meta">{formatDuration(metadata.duration_seconds)}</div>
        )}
        {metadata?.distance_km && (
          <div className="timeline-meta">{formatDist(metadata.distance_km)}</div>
        )}
      </div>
      <div
        className="timeline-severity"
        style={{
          color:
            event.severity === "CRITICAL" ? "var(--color-error)" :
            event.severity === "WARNING" ? "var(--color-warning)" :
            "var(--color-text-secondary)",
        }}
      >
        {event.severity}
      </div>
    </div>
  );
}

export default function VehicleDetailView({ vehicleId, onBack }: Props) {
  const liveEntry = useVehicleEntry(vehicleId);
  const [detail, setDetail] = useState<VehicleDetail | null>(null);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null);
  const [tripEvents, setTripEvents] = useState<TripEvent[]>([]);
  const [routeGeoJson, setRouteGeoJson] = useState<any>(null);
  const [quality, setQuality] = useState<TripQuality | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripLoading, setTripLoading] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [tripsError, setTripsError] = useState<string | null>(null);
  const [tripErrors, setTripErrors] = useState<string[]>([]);
  const tripRequest = useRef(0);

  useEffect(() => {
    subscribeVehicleTracking(vehicleId);

    const unsubscribe = subscribeToFleetEvents((msg) => {
      if (msg.vehicleId === vehicleId && msg.eventType === "vehicle:trip") {
        api.getVehicleTrips(vehicleId).then((r) => { setTrips(r.trips || []); setTripsError(null); })
          .catch(() => setTripsError("Trip history is temporarily unavailable. Existing data remains visible."));
      }
    });

    return () => {
      unsubscribe();
      unsubscribeVehicleTracking(vehicleId);
    };
  }, [vehicleId]);

  useEffect(() => {
    setLoading(true);
    setTripsLoading(true);
    let active = true;
    setDetail(null);
    setTrips([]);
    setSelectedTrip(null);
    setRouteGeoJson(null);
    setTripEvents([]);
    setQuality(null);
    setTripErrors([]);
    setDetailError(null);
    setTripsError(null);
    tripRequest.current++;
    Promise.allSettled([
      api.getVehicleDetail(vehicleId),
      api.getVehicleTrips(vehicleId),
    ])
      .then(([detailResult, tripsResult]) => {
        if (!active) return;
        if (detailResult.status === "fulfilled") {
          const detailRes = detailResult.value;
          setDetail(detailRes);
          if (detailRes.vehicle) {
            vehicleStore.initSnapshot([
              {
                ...detailRes.vehicle,
                latest_values: detailRes.currentState?.latestValues || {},
                signal_timestamps: detailRes.currentState?.signalTimestamps || {},
                state_updated_at: detailRes.currentState?.updatedAt,
              },
            ]);
          }
        } else {
          setDetailError("Vehicle signals and data-quality counts are temporarily unavailable. Trip data is shown below.");
        }
        if (tripsResult.status === "rejected") {
          setTripsError("Trip history is temporarily unavailable. Vehicle signals remain visible.");
          return;
        }
        const sortedTrips = tripsResult.value.trips || [];
        setTrips(sortedTrips);
        if (sortedTrips.length > 0) {
          selectTrip(sortedTrips[0]);
        }
      })
      .finally(() => { if (active) { setLoading(false); setTripsLoading(false); } });
    return () => { active = false; tripRequest.current++; };
  }, [vehicleId]);

  const loadTrips = useCallback(() => {
    setTripsLoading(true);
    setTripsError(null);
    api.getVehicleTrips(vehicleId, fromDate || undefined, toDate || undefined)
      .then((r) => setTrips(r.trips || []))
      .catch(() => setTripsError("Could not update trip history. Previously loaded trips remain visible."))
      .finally(() => setTripsLoading(false));
  }, [vehicleId, fromDate, toDate]);

  const selectTrip = useCallback((trip: Trip) => {
    setSelectedTrip(trip);
    setTripLoading(true);
    setRouteGeoJson(null);
    setTripEvents([]);
    setSelectedEventId(null);
    setQuality(null);
    setTripErrors([]);
    const requestId = ++tripRequest.current;

    Promise.allSettled([
      api.getTripRoute(vehicleId, trip.id),
      api.getTripEvents(vehicleId, trip.id),
      api.getTripQuality(vehicleId, trip.id),
    ])
      .then(([routeRes, eventsRes, qualityRes]) => {
        if (requestId !== tripRequest.current) return;
        const errors: string[] = [];
        if (routeRes.status === "fulfilled") setRouteGeoJson(routeRes.value);
        else errors.push("This trip has no available route. Valid vehicle location and trip details remain visible.");
        if (eventsRes.status === "fulfilled") setTripEvents(eventsRes.value.events || []);
        else errors.push("Trip events are temporarily unavailable.");
        if (qualityRes.status === "fulfilled") setQuality(qualityRes.value);
        else errors.push("Trip quality details are temporarily unavailable.");
        setTripErrors(errors);
      })
      .finally(() => { if (requestId === tripRequest.current) setTripLoading(false); });
  }, [vehicleId]);

  if (loading && !detail && !liveEntry) {
    return (
      <div className="loading-state">
        <div className="spinner spinner-lg" />
        <div style={{ marginTop: 12 }}>Loading vehicle profile...</div>
      </div>
    );
  }

  const vehicle = liveEntry?.vehicle || detail?.vehicle;

  if (!vehicle) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">Vehicle not found</div>
        <button className="btn btn-secondary" onClick={onBack} style={{ marginTop: 12 }}>
          ← Back to fleet
        </button>
      </div>
    );
  }

  const latestValues = {
    ...(detail?.currentState?.latestValues || {}),
    ...(liveEntry?.latestValues || {}),
  };
  const signalTimestamps = {
    ...(detail?.currentState?.signalTimestamps || {}),
    ...(liveEntry?.signalTimestamps || {}),
  };

  const currentSpeed = liveEntry?.speed !== null && liveEntry?.speed !== undefined
    ? liveEntry.speed
    : (latestValues.vehicle_speed !== undefined && latestValues.vehicle_speed !== null ? Number(latestValues.vehicle_speed) : null);

  const speedFormatted = currentSpeed !== null
    ? `${currentSpeed.toFixed(1)} ${liveEntry?.speedUnit || "km/h"}`
    : undefined;

  const currentLat = liveEntry?.latitude ?? (latestValues.latitude !== undefined ? Number(latestValues.latitude) : null);
  const currentLon = liveEntry?.longitude ?? (latestValues.longitude !== undefined ? Number(latestValues.longitude) : null);

  const hasValidLocation = isMapCoordinate([currentLon, currentLat]);
  const livePositionData: LivePosition | null = hasValidLocation ? {
    latitude: currentLat!,
    longitude: currentLon!,
    speed: currentSpeed,
    state: liveEntry?.movementState || vehicle.live_state || "CONNECTED",
    sourceEventTime: liveEntry?.lastDataAt || detail?.currentState?.updatedAt,
  } : null;

  const breadcrumbsData = liveEntry?.breadcrumbs && liveEntry.breadcrumbs.length > 0
    ? liveEntry.breadcrumbs
    : (hasValidLocation ? [[currentLon!, currentLat!] as [number, number]] : []);

  const movementState = liveEntry?.movementState || vehicle.live_state || null;
  const dataFreshness = liveEntry?.dataFreshness || null;
  const unresolvedQuarantineCount = detail?.unresolvedQuarantineCount || 0;

  return (
    <div className="vehicle-detail-layout">
      <div className="vehicle-detail-header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 className="section-title" style={{ margin: 0 }}>{vehicle.label || vehicle.vin}</h1>
            {renderLiveBadge(movementState, dataFreshness)}
          </div>
          <div className="text-muted" style={{ fontSize: 13 }}>
            {vehicle.vin} · {(detail?.vehicle as any)?.oem_name || vehicle.suggested_manufacturer || "–"}
          </div>
        </div>
        {unresolvedQuarantineCount > 0 && (
          <div className="alert alert-warning" style={{ marginBottom: 0, flex: 1 }}>
            <span>⚠</span>
            <div>{unresolvedQuarantineCount} unresolved data issue{unresolvedQuarantineCount > 1 ? "s" : ""} affecting this vehicle.</div>
          </div>
        )}
      </div>

      {detailError && <div className="alert alert-warning">{detailError}</div>}
      {detail?.dataQuality && (
        <div className="vehicle-detail-signals" aria-label="Vehicle data quality">
          <SignalCard label="Valid telemetry records" value={detail.dataQuality.validEvents.toLocaleString()} />
          <SignalCard label="Records quarantined (all time)" value={detail.dataQuality.quarantinedEvents.toLocaleString()} />
          <SignalCard label="Unresolved data issues" value={detail.dataQuality.unresolvedEvents.toLocaleString()} />
        </div>
      )}

      <div className="vehicle-detail-signals">
        <div className="signal-card" data-testid="speed-card">
          <div className="signal-card-label">Speed</div>
          <div className="signal-card-value" data-testid="speed-value">{speedFormatted ?? "–"}</div>
          {signalTimestamps.vehicle_speed && (
            <div className="signal-card-ts">
              as of {formatTime(signalTimestamps.vehicle_speed)} ({liveEntry?.lastUpdatedAge || "live"})
            </div>
          )}
        </div>
        <SignalCard
          label="Battery SOC"
          value={latestValues.battery_soc !== undefined && latestValues.battery_soc !== null ? `${Number(latestValues.battery_soc).toFixed(1)}%` : undefined}
          ts={signalTimestamps.battery_soc}
        />
        <SignalCard
          label="Odometer"
          value={latestValues.odometer !== undefined && latestValues.odometer !== null ? `${Number(latestValues.odometer).toFixed(0)} km` : undefined}
          ts={signalTimestamps.odometer}
        />
        <SignalCard
          label="Ignition"
          value={latestValues.ignition_status || liveEntry?.ignition}
          ts={signalTimestamps.ignition_status}
        />
        <SignalCard
          label="Location"
          value={hasValidLocation ? `${currentLat!.toFixed(4)}, ${currentLon!.toFixed(4)}` : undefined}
          ts={signalTimestamps.latitude}
        />
        <SignalCard
          label="Last signal"
          value={liveEntry?.lastDataAt ? formatDate(liveEntry.lastDataAt) : (detail?.currentState?.updatedAt ? formatDate(detail.currentState.updatedAt) : undefined)}
        />
      </div>

      <div className="vehicle-detail-body">
        <div className="vehicle-detail-sidebar">
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-header">
              <span className="card-header-title">Trip history</span>
              <button className="btn btn-ghost btn-sm" onClick={loadTrips}>↻</button>
            </div>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--color-border-light)" }}>
              <div style={{ display: "flex", gap: 6 }}>
                <input type="date" className="input-field" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ flex: 1 }} placeholder="From" />
                <input type="date" className="input-field" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ flex: 1 }} placeholder="To" />
                <button className="btn btn-secondary btn-sm" onClick={loadTrips}>Filter</button>
              </div>
            </div>
            {tripsError && <div className="alert alert-warning" style={{ margin: 12 }}>{tripsError}</div>}
            {tripsLoading ? (
              <div className="loading-state" style={{ padding: 20 }}><div className="spinner" /></div>
            ) : trips.length === 0 ? (
              <div className="empty-state" style={{ padding: 20 }}>
                <div className="empty-state-text">{tripsError ? "Trip history is unavailable" : "No trips found"}</div>
              </div>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Duration</th>
                      <th>Distance</th>
                      <th>Completeness</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {trips.map((t) => (
                      <TripRow
                        key={t.id}
                        trip={t}
                        selected={selectedTrip?.id === t.id}
                        onClick={() => selectTrip(t)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {selectedTrip && (
            <div className="card">
              <div className="card-header">
                <span className="card-header-title">
                  Trip events ({tripEvents.length})
                </span>
              </div>
              <div style={{ padding: "12px 16px" }}>
                <DataQualityBanner quality={quality} />
                {tripErrors.map(message => <div key={message} className="alert alert-warning">{message}</div>)}
                {tripLoading ? (
                  <div className="loading-state" style={{ padding: 20 }}><div className="spinner" /></div>
                ) : tripEvents.length === 0 ? (
                  <div className="empty-state-text" style={{ padding: 12 }}>No notable events in this trip</div>
                ) : (
                  <div className="timeline">
                    {tripEvents.map((evt) => (
                      <EventTimelineItem
                        key={evt.id}
                        event={evt}
                        selected={selectedEventId === evt.id}
                        onClick={() => setSelectedEventId(evt.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="vehicle-detail-main">
          <div className="card" style={{ height: "100%", minHeight: 450 }}>
            <ErrorBoundary key={vehicleId} fallback={<div className="map-unavailable"><div className="map-unavailable-title">Map unavailable</div><div className="map-unavailable-reason">Your vehicle signals, trips, and data-quality counts remain visible.</div></div>}>
            <MapView
              routeGeoJson={routeGeoJson}
              tripEvents={tripEvents}
              selectedEventId={selectedEventId}
              onEventSelect={setSelectedEventId}
              hasGaps={Boolean(selectedTrip?.has_gaps)}
              livePosition={livePositionData}
              liveBreadcrumbs={breadcrumbsData}
            />
            </ErrorBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}
