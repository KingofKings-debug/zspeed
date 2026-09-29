import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import type { VehicleDetail, Trip, TripEvent, TripQuality } from "../types";
import MapView from "./MapView";

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

function SignalCard({ label, value, ts }: { label: string; value: any; ts?: string }) {
  return (
    <div className="signal-card">
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
  return (
    <div
      className={`timeline-item ${selected ? "timeline-item-selected" : ""}`}
      onClick={onClick}
    >
      <div className="timeline-dot" style={{ background: color }} />
      <div className="timeline-content">
        <div className="timeline-type">{EVENT_TYPE_LABELS[event.event_type] || event.event_type}</div>
        <div className="timeline-time">{formatTime(event.event_time)}</div>
        {event.metadata?.fault_code && (
          <div className="timeline-meta">Code: {event.metadata.fault_code}</div>
        )}
        {event.metadata?.duration_seconds && (
          <div className="timeline-meta">{formatDuration(event.metadata.duration_seconds)}</div>
        )}
        {event.metadata?.distance_km && (
          <div className="timeline-meta">{formatDist(event.metadata.distance_km)}</div>
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

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getVehicleDetail(vehicleId),
      api.getVehicleTrips(vehicleId),
    ]).then(([detailRes, tripsRes]) => {
      setDetail(detailRes);
      const sortedTrips = (tripsRes.trips || []);
      setTrips(sortedTrips);
      if (sortedTrips.length > 0) {
        selectTrip(sortedTrips[0]);
      }
    }).finally(() => setLoading(false));
  }, [vehicleId]);

  const loadTrips = useCallback(() => {
    setTripsLoading(true);
    api.getVehicleTrips(vehicleId, fromDate || undefined, toDate || undefined)
      .then((r) => setTrips(r.trips || []))
      .finally(() => setTripsLoading(false));
  }, [vehicleId, fromDate, toDate]);

  const selectTrip = useCallback((trip: Trip) => {
    setSelectedTrip(trip);
    setTripLoading(true);
    setRouteGeoJson(null);
    setTripEvents([]);
    setSelectedEventId(null);
    setQuality(null);

    Promise.all([
      api.getTripRoute(vehicleId, trip.id),
      api.getTripEvents(vehicleId, trip.id),
      api.getTripQuality(vehicleId, trip.id),
    ]).then(([routeRes, eventsRes, qualityRes]) => {
      setRouteGeoJson(routeRes);
      setTripEvents(eventsRes.events || []);
      setQuality(qualityRes);
    }).finally(() => setTripLoading(false));
  }, [vehicleId]);

  if (loading) {
    return <div className="loading-state"><div className="spinner spinner-lg" /><span>Loading vehicle…</span></div>;
  }

  if (!detail?.vehicle) {
    return (
      <div>
        <button className="btn btn-secondary" onClick={onBack}>← Back</button>
        <div className="alert alert-error" style={{ marginTop: 16 }}>Vehicle not found.</div>
      </div>
    );
  }

  const { vehicle, currentState, unresolvedQuarantineCount } = detail;
  const latestValues = currentState?.latestValues || {};
  const signalTimestamps = currentState?.signalTimestamps || {};

  const noRouteReason = selectedTrip && !tripLoading && (!routeGeoJson || !routeGeoJson.features || routeGeoJson.features.length === 0)
    ? "No GPS data recorded for this trip"
    : undefined;

  return (
    <div className="vehicle-detail-layout">
      <div className="vehicle-detail-header">
        <button className="btn btn-secondary btn-sm" onClick={onBack}>← Back</button>
        <div>
          <h1 className="section-title">{vehicle.label || vehicle.vin}</h1>
          <div className="text-muted" style={{ fontSize: 13 }}>
            {vehicle.vin} · {vehicle.oem_name || "–"}
          </div>
        </div>
        {unresolvedQuarantineCount > 0 && (
          <div className="alert alert-warning" style={{ marginBottom: 0, flex: 1 }}>
            <span>⚠</span>
            <div>{unresolvedQuarantineCount} unresolved data issue{unresolvedQuarantineCount > 1 ? "s" : ""} affecting this vehicle.</div>
          </div>
        )}
      </div>

      <div className="vehicle-detail-signals">
        <SignalCard label="Speed" value={latestValues.vehicle_speed !== undefined ? `${latestValues.vehicle_speed?.toFixed(1)} km/h` : undefined} ts={signalTimestamps.vehicle_speed} />
        <SignalCard label="Battery SOC" value={latestValues.battery_soc !== undefined ? `${latestValues.battery_soc?.toFixed(1)}%` : undefined} ts={signalTimestamps.battery_soc} />
        <SignalCard label="Odometer" value={latestValues.odometer !== undefined ? `${latestValues.odometer?.toFixed(0)} km` : undefined} ts={signalTimestamps.odometer} />
        <SignalCard label="Ignition" value={latestValues.ignition_status} ts={signalTimestamps.ignition_status} />
        <SignalCard label="Location" value={latestValues.latitude ? `${latestValues.latitude?.toFixed(4)}, ${latestValues.longitude?.toFixed(4)}` : undefined} ts={signalTimestamps.latitude} />
        <SignalCard label="Last signal" value={currentState?.updatedAt ? formatDate(currentState.updatedAt) : undefined} />
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
            {tripsLoading ? (
              <div className="loading-state" style={{ padding: 20 }}><div className="spinner" /></div>
            ) : trips.length === 0 ? (
              <div className="empty-state" style={{ padding: 20 }}>
                <div className="empty-state-text">No trips found</div>
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
                    {trips.map((trip) => (
                      <TripRow
                        key={trip.id}
                        trip={trip}
                        selected={selectedTrip?.id === trip.id}
                        onClick={() => selectTrip(trip)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="vehicle-detail-main">
          {selectedTrip && (
            <>
              <div className="selected-trip-header">
                <div>
                  <strong>
                    {new Date(selectedTrip.started_at).toLocaleDateString(undefined, { dateStyle: "medium" })}
                  </strong>
                  <span className="text-muted" style={{ marginLeft: 8, fontSize: 13 }}>
                    {formatTime(selectedTrip.started_at)} → {formatTime(selectedTrip.ended_at)}
                    {" · "}{formatDist(selectedTrip.distance_km)}
                    {" · "}{formatDuration(selectedTrip.duration_seconds)}
                  </span>
                </div>
              </div>

              <DataQualityBanner quality={quality} />

              {tripLoading ? (
                <div className="loading-state"><div className="spinner spinner-lg" /></div>
              ) : (
                <div className="trip-detail-grid">
                  <div className="trip-map-panel">
                    <MapView
                      routeGeoJson={routeGeoJson}
                      tripEvents={tripEvents}
                      selectedEventId={selectedEventId}
                      onEventSelect={setSelectedEventId}
                      hasGaps={quality?.hasGaps || false}
                      noDataReason={noRouteReason}
                    />
                  </div>
                  <div className="trip-timeline-panel">
                    <div className="timeline-header">Event timeline</div>
                    {tripEvents.length === 0 ? (
                      <div className="empty-state" style={{ padding: 20 }}>
                        <div className="empty-state-text">No events recorded</div>
                      </div>
                    ) : (
                      <div className="timeline-scroll">
                        {tripEvents.map((evt) => (
                          <EventTimelineItem
                            key={evt.id}
                            event={evt}
                            selected={selectedEventId === evt.id}
                            onClick={() => setSelectedEventId(selectedEventId === evt.id ? null : evt.id)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {!selectedTrip && trips.length === 0 && !tripsLoading && (
            <div className="empty-state">
              <div className="empty-state-title">No trips yet</div>
              <div className="empty-state-text">GPS events are needed to build trip history.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
