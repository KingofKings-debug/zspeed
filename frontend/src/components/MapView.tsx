import { useEffect, useRef, useMemo } from "react";
import Map, { Source, Layer, Marker, MapRef } from "react-map-gl/maplibre";
import "maplibre-gl/dist/maplibre-gl.css";
import * as maplibregl from "maplibre-gl";
import mapWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { TripEvent } from "../types";
import { isMapCoordinate, routeMapData } from "../map-data";

const MAP_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
maplibregl.setWorkerUrl(mapWorkerUrl);

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
  const routeData = useMemo(() => routeMapData(routeGeoJson), [routeGeoJson]);
  const validLivePosition = livePosition && isMapCoordinate([livePosition.longitude, livePosition.latitude]) ? livePosition : null;
  const validBreadcrumbs = (liveBreadcrumbs || []).filter(isMapCoordinate);

  const bounds = useMemo(() => {
    const allCoords = routeData.coordinates;
    if (allCoords.length === 0) return null;
    
    const initialBounds = new maplibregl.LngLatBounds(allCoords[0], allCoords[0]);
    return allCoords.reduce((b, c) => b.extend(c), initialBounds);
  }, [routeData]);

  useEffect(() => {
    if (bounds && mapRef.current) {
      mapRef.current.fitBounds(bounds.toArray() as [[number, number], [number, number]], { padding: 60, maxZoom: 15, duration: 800 });
    }
  }, [bounds]);

  useEffect(() => {
    if (selectedEventId && mapRef.current) {
      const evt = tripEvents.find((e) => e.id === selectedEventId);
      if (evt && isMapCoordinate([evt.longitude, evt.latitude])) {
        mapRef.current.flyTo({ center: [evt.longitude!, evt.latitude!], zoom: 15, duration: 800 });
      }
    }
  }, [selectedEventId, tripEvents]);

  useEffect(() => {
    if (!bounds && validLivePosition && mapRef.current) {
      if (!hasCenteredLiveRef.current) {
        hasCenteredLiveRef.current = true;
        mapRef.current.flyTo({
          center: [validLivePosition.longitude, validLivePosition.latitude],
          zoom: 14,
          duration: 800,
        });
      } else {
        mapRef.current.easeTo({
          center: [validLivePosition.longitude, validLivePosition.latitude],
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
    <div style={{ position: "relative", width: "100%", height: "clamp(450px, 65vh, 650px)" }}>
      <Map
        ref={mapRef}
        onLoad={() => {
          if (bounds) mapRef.current?.fitBounds(bounds.toArray() as [[number, number], [number, number]], { padding: 60, maxZoom: 15, duration: 0 });
        }}
        initialViewState={{
          longitude: bounds?.getCenter().lng ?? validLivePosition?.longitude ?? -0.1278,
          latitude: bounds?.getCenter().lat ?? validLivePosition?.latitude ?? 51.5074,
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
        {routeData.geoJson.features.length > 0 && (
          <Source id="route" type="geojson" data={routeData.geoJson}>
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
          if (!isMapCoordinate([evt.longitude, evt.latitude])) return null;
          const color = EVENT_COLORS[evt.event_type] || "#4a6fa5";
          const icon = EVENT_ICONS[evt.event_type] || "•";
          const isSelected = selectedEventId === evt.id;

          return (
            <Marker
              key={evt.id}
              longitude={evt.longitude!}
              latitude={evt.latitude!}
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

        {validBreadcrumbs.length > 1 && (
          <Source
            id="live-breadcrumbs"
            type="geojson"
            data={{
              type: "Feature",
              geometry: {
                type: "LineString",
                coordinates: validBreadcrumbs,
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

        {validLivePosition && (
          <Marker
            longitude={validLivePosition.longitude}
            latitude={validLivePosition.latitude}
            anchor="center"
            style={{ zIndex: 25 }}
          >
            <div
              className={`live-vehicle-marker state-${(validLivePosition.state || "MOVING").toLowerCase()}`}
              title={`Live: ${validLivePosition.state || "Active"}${validLivePosition.speed !== null && validLivePosition.speed !== undefined ? ` (${validLivePosition.speed} km/h)` : ""}`}
              style={{
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: validLivePosition.state === "IDLE" ? "#d4a053" : validLivePosition.state === "STALE" ? "#888888" : "#2a9d8f",
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
