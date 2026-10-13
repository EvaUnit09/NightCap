"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { loadStopCoords } from "../src/client/load-stop-coords";
import { markersFromStops, type MapCoord, type MapMarker, type MapStop } from "../src/client/map-markers";

interface GoogleMapsMarker {
  setMap(map: GoogleMapsMap | null): void;
}

interface GoogleMapsMap {
  fitBounds(bounds: GoogleMapsBounds): void;
  setCenter(position: { lat: number; lng: number }): void;
  setZoom(zoom: number): void;
}

interface GoogleMapsBounds {
  extend(position: { lat: number; lng: number }): void;
}

interface GoogleMapsNamespace {
  maps: {
    Map: new (
      element: HTMLElement,
      options: {
        center: { lat: number; lng: number };
        zoom: number;
        mapTypeControl: boolean;
        streetViewControl: boolean;
        fullscreenControl: boolean;
      },
    ) => GoogleMapsMap;
    Marker: new (options: {
      map: GoogleMapsMap;
      position: { lat: number; lng: number };
      label: string;
      title: string;
    }) => GoogleMapsMarker;
    LatLngBounds: new () => GoogleMapsBounds;
  };
}

const NYC = { lat: 40.73, lng: -73.99 };

let mapsPromise: Promise<GoogleMapsNamespace> | null = null;

function mapsBrowserKey(): string | undefined {
  const value = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim();
  return value ? value : undefined;
}

function readMaps(host: Window): GoogleMapsNamespace | undefined {
  const google = (host as Window & { google?: GoogleMapsNamespace }).google;
  if (!google?.maps?.Map || !google.maps.Marker || !google.maps.LatLngBounds) return undefined;
  return google;
}

function loadMapsScript(key: string): Promise<GoogleMapsNamespace> {
  if (typeof window === "undefined") return Promise.reject(new Error("maps_unavailable"));
  const ready = readMaps(window);
  if (ready) return Promise.resolve(ready);
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    script.async = true;
    script.dataset.nightcapMaps = "browser";
    script.onload = () => {
      const maps = readMaps(window);
      if (maps) resolve(maps);
      else reject(new Error("maps_unavailable"));
    };
    script.onerror = () => reject(new Error("maps_unavailable"));
    document.head.appendChild(script);
  });
  mapsPromise.catch(() => {
    mapsPromise = null;
  });
  return mapsPromise;
}

function paintMarkers(maps: GoogleMapsNamespace, map: GoogleMapsMap, markers: readonly MapMarker[]): GoogleMapsMarker[] {
  const drawn = markers.map(
    (marker) =>
      new maps.maps.Marker({
        map,
        position: { lat: marker.lat, lng: marker.lng },
        label: String(marker.order),
        title: marker.label,
      }),
  );
  const first = markers[0];
  if (markers.length === 1 && first) {
    map.setCenter({ lat: first.lat, lng: first.lng });
    map.setZoom(15);
    return drawn;
  }
  if (markers.length > 1) {
    const bounds = new maps.maps.LatLngBounds();
    for (const marker of markers) bounds.extend({ lat: marker.lat, lng: marker.lng });
    map.fitBounds(bounds);
  }
  return drawn;
}

export function RouteMap({ stops }: { readonly stops: readonly MapStop[] }) {
  const browserKey = mapsBrowserKey();
  const canvasRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMapsMap | null>(null);
  const drawnRef = useRef<GoogleMapsMarker[]>([]);
  const stopKey = stops.map((stop) => stop.placeId).join("\n");
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly coords: readonly MapCoord[] }>({
    key: "",
    coords: [],
  });
  const [mapsApi, setMapsApi] = useState<GoogleMapsNamespace | null>(null);
  const [scriptFailed, setScriptFailed] = useState(false);
  const markers = useMemo(
    () => markersFromStops(stops, loaded.key === stopKey ? loaded.coords : []),
    [stops, loaded, stopKey],
  );

  useEffect(() => {
    if (!browserKey) return;
    let cancelled = false;
    void loadMapsScript(browserKey).then(
      (maps) => {
        if (!cancelled) setMapsApi(maps);
      },
      () => {
        if (!cancelled) setScriptFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [browserKey]);

  useEffect(() => {
    if (!browserKey) return;
    const controller = new AbortController();
    const key = stopKey;
    void loadStopCoords(
      stops.map((stop) => stop.placeId),
      { signal: controller.signal },
    ).then((next) => {
      if (controller.signal.aborted) return;
      setLoaded({ key, coords: next });
    });
    return () => controller.abort();
  }, [browserKey, stopKey, stops]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mapsApi) return;
    const map =
      mapRef.current ??
      new mapsApi.maps.Map(canvas, {
        center: NYC,
        zoom: 12,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
    mapRef.current = map;
    for (const marker of drawnRef.current) marker.setMap(null);
    drawnRef.current = paintMarkers(mapsApi, map, markers);
  }, [mapsApi, markers]);

  const painted = mapsApi ? markers.length : 0;
  const status = mapStatus({ browserKey, scriptFailed, markerCount: markers.length, stopCount: stops.length });

  return (
    <section className="route-map" aria-label="Route map" tabIndex={0} data-marker-count={painted}>
      <p role="status">{status}</p>
      {browserKey && !scriptFailed ? <div ref={canvasRef} className="route-map-canvas" /> : null}
    </section>
  );
}

function mapStatus(input: {
  readonly browserKey: string | undefined;
  readonly scriptFailed: boolean;
  readonly markerCount: number;
  readonly stopCount: number;
}): string {
  if (!input.browserKey) return "Map is off.";
  if (input.scriptFailed) return "Map could not load.";
  if (input.markerCount === 0) return "No stops have coordinates yet.";
  return `${input.markerCount} of ${input.stopCount} stops on the map.`;
}
