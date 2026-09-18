import {
  Map as VectorMap,
  Marker,
  NavigationControl,
  AttributionControl,
  setWorkerUrl,
  setWorkerCount,
  type GeoJSONSource,
} from 'maplibre-gl';
import { parkIndex, sameRegion, type MapState, type MapEvent } from './map-model';
import type { Region } from '../core/types';
import boundaryManifest from '../core/boundary-manifest.json';
import { BoundaryCache, boundaryKeys, emptyBoundaries, visibleBoundaries } from './map-boundaries';

const paw =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="5" cy="9" rx="2.5" ry="3.2" transform="rotate(-25 5 9)"/><ellipse cx="10" cy="5.5" rx="2.5" ry="3.2"/><ellipse cx="16" cy="6" rx="2.5" ry="3.2" transform="rotate(15 16 6)"/><ellipse cx="20" cy="11" rx="2.3" ry="3" transform="rotate(25 20 11)"/><path d="M5.5 18c0-2.8 3.8-7 6.5-7s6.5 4.2 6.5 7c0 4.4-4.1 2.3-6.5 2.3S5.5 22.4 5.5 18Z"/></svg>';

export function createMap(
  host: HTMLElement,
  initial: MapState,
  styleUrl: string,
  workerCode: string,
  emit: (event: MapEvent) => void,
  boundaryBase: string,
) {
  const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
  setWorkerUrl(workerUrl);
  setWorkerCount(2);
  const status = document.createElement('div');
  status.className = 'map-loading';
  status.setAttribute('role', 'status');
  status.textContent = 'Parkların haritası hazırlanıyor…';
  host.appendChild(status);
  let map: VectorMap;
  let destroyed = false;
  let state = initial;
  let lastRegion: Region | undefined;
  let index = parkIndex(state.parks, state.selected);
  const markers = new globalThis.Map<string, Marker>();
  // Never fed into `index`/Supercluster — rescue cases are rare, urgent
  // events, not a dense POI catalog to cluster. A separate, always-drawn
  // layer (same idea as locationMarker below) keeps park cluster counts and
  // selection behavior completely untouched.
  const rescueMarkers = new globalThis.Map<string, Marker>();
  // Same reasoning as rescueMarkers, kept as its own separate collection
  // rather than generalizing a shared helper — vets have no tap action (no
  // selectVet event) and no relation to rescue cases, so the two layers stay
  // independent rather than sharing code that would couple their behavior.
  const vetMarkers = new globalThis.Map<string, Marker>();
  let locationMarker: Marker | undefined;
  let areasVisible = true;
  let areasReady = false;
  try {
    map = new VectorMap({
      container: host,
      style: styleUrl,
      center: [initial.region.longitude, initial.region.latitude],
      zoom: 13,
      maxZoom: 19,
      minZoom: 5,
      maxBounds: [
        [24, 33],
        [47, 44],
      ],
      renderWorldCopies: false,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      canvasContextAttributes: { antialias: false },
      locale: {
        'NavigationControl.ZoomIn': 'Yakınlaştır',
        'NavigationControl.ZoomOut': 'Uzaklaştır',
        'AttributionControl.ToggleAttribution': 'Harita kaynakları',
        'Map.Title': 'Parkların bulunduğu etkileşimli harita',
      },
    });
  } catch {
    status.textContent =
      'Harita bu cihazda açılamadı. Parkları aşağıdaki listeden keşfedebilirsin.';
    return {
      update() {},
      destroy() {
        URL.revokeObjectURL(workerUrl);
      },
    };
  }
  map.touchZoomRotate.disableRotation();
  map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
  const areaControl = document.createElement('div');
  areaControl.className = 'park-area-control';
  const areaToggle = document.createElement('button');
  areaToggle.type = 'button';
  areaToggle.className = 'park-area-toggle';
  areaToggle.innerHTML = '<span class="park-area-swatch" aria-hidden="true"></span>Park alanları';
  areaToggle.setAttribute('aria-pressed', 'true');
  const areaNote = document.createElement('span');
  areaNote.className = 'park-area-note';
  areaNote.setAttribute('role', 'status');
  const retryAreas = document.createElement('button');
  retryAreas.type = 'button';
  retryAreas.className = 'park-area-retry';
  retryAreas.textContent = 'Alanları tekrar yükle';
  retryAreas.hidden = true;
  areaControl.append(areaToggle, areaNote, retryAreas);
  host.appendChild(areaControl);
  const boundaries = new BoundaryCache(boundaryManifest.tiles, boundaryBase, paintAreas);
  areaToggle.onclick = () => {
    areasVisible = !areasVisible;
    areaToggle.setAttribute('aria-pressed', String(areasVisible));
    syncAreas();
  };
  retryAreas.onclick = () => boundaries.retry();

  function paintAreas() {
    if (destroyed) return;
    const enabled = areasVisible && map.getZoom() >= 12;
    const snapshot = boundaries.snapshot;
    const data = enabled
      ? visibleBoundaries(snapshot.collections, state.parks, state.selected)
      : emptyBoundaries();
    if (areasReady)
      void (map.getSource('park-areas') as GeoJSONSource).setData(data).catch(() => {
        if (!destroyed) {
          areaNote.textContent = 'Sınırlar çizilemedi';
          retryAreas.hidden = false;
        }
      });
    areaNote.textContent = !areasVisible
      ? ''
      : map.getZoom() < 12
        ? 'Sınırlar için yakınlaştır'
        : snapshot.failed
          ? 'Bazı sınırlar yüklenemedi'
          : snapshot.loading
            ? 'Sınırlar yükleniyor…'
            : data.features.length
              ? `${data.features.length} parkın sınırı`
              : 'Bu görünümde sınır verisi yok';
    retryAreas.hidden = !enabled || !snapshot.failed;
  }
  function syncAreas() {
    const b = map.getBounds();
    boundaries.update(
      areasVisible && map.getZoom() >= 12
        ? boundaryKeys(
            state.parks,
            [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()],
            boundaryManifest.tiles,
            state.selected,
          )
        : [],
    );
    paintAreas();
  }
  function selectPark(id: string) {
    const park = state.parks.find((p) => p.id === id);
    if (!park) return;
    emit({ type: 'select', id });
    map.easeTo({
      center: [park.longitude, park.latitude],
      offset: [0, -host.clientHeight * 0.13],
      duration: 350,
    });
  }
  const regionBounds = (r: Region): [[number, number], [number, number]] => [
    [r.longitude - r.longitudeDelta / 2, r.latitude - r.latitudeDelta / 2],
    [r.longitude + r.longitudeDelta / 2, r.latitude + r.latitudeDelta / 2],
  ];

  function draw() {
    if (destroyed) return;
    const bounds = map.getBounds();
    const visible = index.getClusters(
      [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      Math.floor(map.getZoom()),
    );
    const selected = state.parks.find((p) => p.id === state.selected);
    if (selected)
      visible.push({
        type: 'Feature',
        properties: selected,
        geometry: { type: 'Point', coordinates: [selected.longitude, selected.latitude] },
      });
    const active = new Set<string>();
    for (const feature of visible) {
      const properties = feature.properties;
      const cluster = 'cluster' in properties && properties.cluster;
      const id = cluster ? `cluster-${properties.cluster_id}` : `park-${properties.id}`;
      active.add(id);
      if (markers.has(id)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = cluster
        ? 'park-cluster'
        : `park-pin${properties.id === state.selected ? ' is-selected' : ''}`;
      const coordinates = feature.geometry.coordinates as [number, number];
      if (cluster) {
        button.innerHTML = `<strong>${properties.point_count}</strong><span>park</span>`;
        button.setAttribute('aria-label', `${properties.point_count} parkı yakınlaştır`);
        button.title = `${properties.point_count} park · Keşfetmek için yakınlaştır`;
        button.onclick = (event) => {
          event.stopPropagation();
          const zoom = index.getClusterExpansionZoom(properties.cluster_id);
          map.easeTo({ center: coordinates, zoom: Math.min(19, zoom + 0.25), duration: 400 });
        };
      } else {
        button.style.setProperty('--pin-color', properties.color);
        button.innerHTML = `<span class="pin-shape">${paw}</span><span class="pin-tip"></span>`;
        button.title = properties.name;
        button.setAttribute('aria-label', `${properties.name}, ${properties.status}`);
        button.setAttribute('aria-pressed', String(properties.id === state.selected));
        button.onclick = (event) => {
          event.stopPropagation();
          selectPark(properties.id);
        };
      }
      markers.set(
        id,
        new Marker({ element: button, anchor: cluster ? 'center' : 'bottom' })
          .setLngLat(coordinates)
          .addTo(map),
      );
    }
    for (const [id, marker] of markers)
      if (!active.has(id)) {
        marker.remove();
        markers.delete(id);
      }
  }
  function drawRescue() {
    if (destroyed) return;
    const active = new Set<string>();
    for (const rescue of state.rescueCases) {
      const id = `rescue-${rescue.id}`;
      active.add(id);
      if (rescueMarkers.has(id)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rescue-pin';
      button.textContent = rescue.icon;
      const label =
        rescue.icon === '🚨' ? 'Yaralı hayvan bildirimi' : 'Bir gönüllü vakayı üstlendi';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.onclick = (event) => {
        event.stopPropagation();
        emit({ type: 'selectRescue', id: rescue.id });
      };
      rescueMarkers.set(
        id,
        new Marker({ element: button, anchor: 'bottom' })
          .setLngLat([rescue.longitude, rescue.latitude])
          .addTo(map),
      );
    }
    for (const [id, marker] of rescueMarkers)
      if (!active.has(id)) {
        marker.remove();
        rescueMarkers.delete(id);
      }
  }
  function drawVets() {
    if (destroyed) return;
    const active = new Set<string>();
    for (const vet of state.vets) {
      const id = `vet-${vet.id}`;
      active.add(id);
      if (vetMarkers.has(id)) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vet-pin';
      button.textContent = vet.icon;
      button.title = 'Patika anlaşmalı veteriner';
      button.setAttribute('aria-label', button.title);
      // No tap action by design (T2 scope): the list screen already carries
      // every field a tap could reveal, so no selectVet event/handler exists.
      // Not part of tab order either, since activating it would do nothing.
      button.tabIndex = -1;
      vetMarkers.set(
        id,
        new Marker({ element: button, anchor: 'bottom' })
          .setLngLat([vet.longitude, vet.latitude])
          .addTo(map),
      );
    }
    for (const [id, marker] of vetMarkers)
      if (!active.has(id)) {
        marker.remove();
        vetMarkers.delete(id);
      }
  }
  function rebuild() {
    index = parkIndex(state.parks, state.selected);
    for (const marker of markers.values()) marker.remove();
    markers.clear();
    draw();
    drawRescue();
    drawVets();
    syncAreas();
    locationMarker?.remove();
    if (state.userLocation) {
      const dot = document.createElement('div');
      dot.className = 'user-location';
      dot.setAttribute('role', 'img');
      dot.setAttribute('aria-label', 'Konumun');
      locationMarker = new Marker({ element: dot })
        .setLngLat([state.userLocation.longitude, state.userLocation.latitude])
        .addTo(map);
    }
  }
  map.on('moveend', () => {
    draw();
    syncAreas();
    const c = map.getCenter(),
      b = map.getBounds();
    lastRegion = {
      latitude: c.lat,
      longitude: c.lng,
      latitudeDelta: b.getNorth() - b.getSouth(),
      longitudeDelta: b.getEast() - b.getWest(),
    };
    emit({ type: 'move', region: lastRegion });
  });
  map.on('load', () => {
    status.remove();
    // Only restyle the default Positron map. Custom providers keep their own styling.
    if (styleUrl === 'https://tiles.openfreemap.org/styles/positron') {
      const fills: Record<string, string> = {
        park: '#d6e6ce',
        water: '#b9d9dd',
        landcover_wood: '#d1e2c8',
        landuse_residential: '#f3f1e9',
        building: '#e6e7df',
      };
      for (const [id, color] of Object.entries(fills))
        if (map.getLayer(id)) map.setPaintProperty(id, 'fill-color', color);
      if (map.getLayer('background'))
        map.setPaintProperty('background', 'background-color', '#f7f6ef');
      for (const layer of map.getStyle().layers) {
        if (layer.type === 'symbol' && layer.id.startsWith('highway-shield'))
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        if (layer.type === 'symbol' && layer.id.startsWith('highway-name'))
          map.setPaintProperty(layer.id, 'text-color', '#8a968b');
      }
    }
    map.addSource('park-areas', { type: 'geojson', data: emptyBoundaries(), tolerance: 0.3 });
    const before = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
    map.addLayer(
      {
        id: 'park-area-fill',
        type: 'fill',
        source: 'park-areas',
        minzoom: 12,
        paint: {
          'fill-color': '#3a8960',
          'fill-opacity': ['case', ['get', 'selected'], 0.3, 0.14],
        },
      },
      before,
    );
    map.addLayer(
      {
        id: 'park-area-halo',
        type: 'line',
        source: 'park-areas',
        minzoom: 12,
        paint: {
          'line-color': '#ffffff',
          'line-width': ['case', ['get', 'selected'], 6, 4],
          'line-opacity': 0.8,
        },
      },
      before,
    );
    map.addLayer(
      {
        id: 'park-area-outline',
        type: 'line',
        source: 'park-areas',
        minzoom: 12,
        paint: {
          'line-color': ['case', ['get', 'selected'], '#195637', '#4b8862'],
          'line-width': ['case', ['get', 'selected'], 3.5, 1.8],
        },
      },
      before,
    );
    map.on('click', 'park-area-fill', (event) => {
      const id = event.features?.[0]?.properties?.id;
      if (typeof id === 'string') selectPark(id);
    });
    map.on('mouseenter', 'park-area-fill', () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', 'park-area-fill', () => {
      map.getCanvas().style.cursor = '';
    });
    areasReady = true;
    rebuild();
    map.fire('moveend');
  });
  const warningTimer = window.setTimeout(() => {
    if (status.isConnected)
      status.textContent =
        'Harita yüklenemedi. İnternet bağlantını kontrol et; park listesi aşağıda.';
  }, 18000);
  const resize = new ResizeObserver(() => map.resize());
  resize.observe(host);
  rebuild();
  emit({ type: 'ready' });
  return {
    update(next: MapState) {
      const recenter =
        !sameRegion(next.region, state.region) &&
        (!lastRegion || !sameRegion(next.region, lastRegion));
      state = next;
      rebuild();
      if (recenter) map.fitBounds(regionBounds(next.region), { padding: 12, duration: 400 });
    },
    destroy() {
      destroyed = true;
      boundaries.destroy();
      areaControl.remove();
      clearTimeout(warningTimer);
      resize.disconnect();
      map.remove();
      URL.revokeObjectURL(workerUrl);
    },
  };
}
