import { useEffect, useRef, useMemo } from "react";
import Map, { Source, Layer, Marker, MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import type { TripEvent } from "../types";

const MAP_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const EVENT_COLORS: Record<string, string> = {
  TRIP_START: "#2a9d8f",
  TRIP_END: "#4a6fa5",
  HARSH_BRAKE: "#c44536",
  FAULT: "#8b0000",
  EXTENDED_IDLE: "#d4a053",
  CHARGING: "#2a9d8f",
  SPEED_VIOLATION: "#c44536",
};

const EVENT_ICONS: Record<string, string> = {
  TRIP_START: "▶",
  TRIP_END: "■",
  HARSH_BRAKE: "⚠",
  FAULT: "✖",
  EXTENDED_IDLE: "⏸",
  CHARGING: "⚡",
  SPEED_VIOLATION: "⚠",
};

export interface LivePosition {
  latitude: number;
  longitude: number;
  speed?: number | null;
  state?: string;
  sourceEventTime?: string;
}

interface Props {
  routeGeoJson: any | null;
  tripEvents: TripEvent[];
  selectedEventId: string | null;
  onEventSelect: (eventId: string) => void;
  hasGaps: boolean;
  noDataReason?: string;
  livePosition?: LivePosition | null;
  liveBreadcrumbs?: [number, number][];
}

export default function MapView({
  routeGeoJson,
  tripEvents,
  selectedEventId,
  onEventSelect,
  hasGaps,
  noDataReason,
  livePosition,
  liveBreadcrumbs,
}: Props) {
  const mapRef = useRef<MapRef>(null);
  const hasCenteredLiveRef = useRef(false);

  const bounds = useMemo(() => {
    if (!routeGeoJson || !routeGeoJson.features || routeGeoJson.features.length === 0) return null;
    const allCoords: [number, number][] = [];
    routeGeoJson.features.forEach((f: any) => {
      if (f.geometry?.coordinates) {
        f.geometry.coordinates.forEach((c: [number, number]) => allCoords.push(c));
      }
    });
    if (allCoords.length === 0) return null;
    
    const initialBounds = new maplibregl.LngLatBounds(allCoords[0], allCoords[0]);
    return allCoords.reduce((b, c) => b.extend(c), initialBounds);
  }, [routeGeoJson]);

  useEffect(() => {
    if (bounds && mapRef.current) {
      mapRef.current.fitBounds(bounds.toArray() as [[number, number], [number, number]], { padding: 60, maxZoom: 15, duration: 800 });
    }
  }, [bounds]);

  useEffect(() => {
    if (selectedEventId && mapRef.current) {
      const evt = tripEvents.find((e) => e.id === selectedEventId);
      if (evt?.latitude && evt?.longitude) {
        mapRef.current.flyTo({ center: [evt.longitude, evt.latitude], zoom: 15, duration: 800 });
      }
    }
  }, [selectedEventId, tripEvents]);

  useEffect(() => {
    if (!bounds && livePosition && mapRef.current) {
      if (!hasCenteredLiveRef.current) {
        hasCenteredLiveRef.current = true;
        mapRef.current.flyTo({
          center: [livePosition.longitude, livePosition.latitude],
          zoom: 14,
          duration: 800,
        });
      } else {
        mapRef.current.easeTo({
          center: [livePosition.longitude, livePosition.latitude],
          duration: 400,
        });
      }
    }
  }, [livePosition?.latitude, livePosition?.longitude, bounds]);

  if (noDataReason) {
    return (
      <div className="map-unavailable">
        <div className="map-unavailable-icon">🗺</div>
        <div className="map-unavailable-title">Route unavailable</div>
        <div className="map-unavailable-reason">{noDataReason}</div>
      </div>
    );
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 400 }}>
      <Map
        ref={mapRef}
        initialViewState={{
          longitude: livePosition?.longitude ?? -0.1278,
          latitude: livePosition?.latitude ?? 51.5074,
          zoom: 13
        }}
        mapStyle={{
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: [MAP_TILE_URL],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [{ id: "osm", type: "raster", source: "osm" }],
        }}
      >
        {routeGeoJson && (
          <Source id="route" type="geojson" data={routeGeoJson}>
            <Layer
              id="route-line"
              type="line"
              layout={{ "line-join": "round", "line-cap": "round" }}
              paint={{
                "line-color": "#4a6fa5",
                "line-width": 4,
                "line-opacity": 0.85,
              }}
            />
          </Source>
        )}

        {tripEvents.map(evt => {
          if (!evt.latitude || !evt.longitude) return null;
          const color = EVENT_COLORS[evt.event_type] || "#4a6fa5";
          const icon = EVENT_ICONS[evt.event_type] || "•";
          const isSelected = selectedEventId === evt.id;

          return (
            <Marker
              key={evt.id}
              longitude={evt.longitude}
              latitude={evt.latitude}
              anchor="center"
              onClick={e => {
                e.originalEvent.stopPropagation();
                onEventSelect(evt.id);
              }}
              style={{ cursor: "pointer", zIndex: isSelected ? 10 : undefined }}
            >
              <div
                className="map-marker"
                title={evt.event_type.replace(/_/g, " ")}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: "50%",
                  background: color,
                  color: "white",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 12,
                  border: "2px solid white",
                  boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                  transition: "transform 0.15s",
                  transform: isSelected ? "scale(1.4)" : "scale(1)"
                }}
              >
                {icon}
              </div>
            </Marker>
          );
        })}

        {liveBreadcrumbs && liveBreadcrumbs.length > 1 && (
          <Source
            id="live-breadcrumbs"
            type="geojson"
            data={{
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: liveBreadcrumbs,
              },
              properties: {},
            }}
          >
            <Layer
              id="live-breadcrumbs-line"
              type="line"
              layout={{ "line-join": "round", "line-cap": "round" }}
              paint={{
                "line-color": "#2a9d8f",
                "line-width": 3,
                "line-dasharray": [2, 2],
              }}
            />
          </Source>
        )}

        {livePosition && (
          <Marker
            longitude={livePosition.longitude}
            latitude={livePosition.latitude}
            anchor="center"
            style={{ zIndex: 25 }}
          >
            <div
              className={`live-vehicle-marker state-${(livePosition.state || "MOVING").toLowerCase()}`}
              title={`Live: ${livePosition.state || "Active"}${livePosition.speed !== null && livePosition.speed !== undefined ? ` (${livePosition.speed} km/h)` : ""}`}
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: livePosition.state === "IDLE" ? "#d4a053" : livePosition.state === "STALE" ? "#888888" : "#2a9d8f",
                color: "white",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 16,
                border: "3px solid white",
                boxShadow: "0 0 12px rgba(42, 157, 143, 0.8)",
                transition: "all 0.3s ease",
              }}
            >
              🚗
            </div>
          </Marker>
        )}
      </Map>

      {hasGaps && (
        <div className="map-gap-notice">
          ⚠ GPS data has gaps — route is an approximation
        </div>
      )}
    </div>
  );
}
