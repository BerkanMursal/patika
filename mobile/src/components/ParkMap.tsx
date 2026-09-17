import React, { useEffect, useMemo, useRef } from 'react';
import { Linking } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ParkMapProps } from './Map.types';
import { mapDocument } from './map-document';
import { isMapEvent, mapParks, scriptJSON } from './map-model';

const sourceLinks = new Set([
  'https://openfreemap.org/',
  'https://www.openmaptiles.org/',
  'https://openmaptiles.org/',
  'https://www.openstreetmap.org/copyright',
  'https://maplibre.org/',
]);
export default function ParkMap({
  parks,
  region,
  selected,
  userLocation,
  onSelect,
  onMove,
}: ParkMapProps) {
  const web = useRef<WebView>(null);
  const state = { parks: mapParks(parks), region, selected, userLocation };
  const html = useMemo(() => mapDocument(state), []);
  const update = () =>
    web.current?.injectJavaScript(
      `window.updatePatika&&window.updatePatika(${scriptJSON(state)});true;`,
    );
  useEffect(update, [parks, region, selected, userLocation]);
  return (
    <WebView
      ref={web}
      source={{ html, baseUrl: 'https://patika-mobile.vercel.app' }}
      originWhitelist={['https://*', 'about:*']}
      javaScriptEnabled
      domStorageEnabled
      mixedContentMode="never"
      allowFileAccess={false}
      setSupportMultipleWindows={false}
      applicationNameForUserAgent="Patika/1.0"
      onLoadEnd={update}
      onShouldStartLoadWithRequest={(r) => {
        if (sourceLinks.has(r.url)) {
          void Linking.openURL(r.url);
          return false;
        }
        return (
          r.url === 'about:blank' ||
          r.url === 'https://patika-mobile.vercel.app/' ||
          r.url === 'https://patika-mobile.vercel.app'
        );
      }}
      onMessage={(event) => {
        try {
          const message = JSON.parse(event.nativeEvent.data);
          if (message.channel !== 'patika-map' || !isMapEvent(message.event)) return;
          const data = message.event;
          if (data.type === 'ready') update();
          if (data.type === 'select' && parks.some((p) => p.id === data.id)) onSelect(data.id);
          if (data.type === 'move') onMove(data.region);
        } catch {
          /* Ignore malformed bridge messages. */
        }
      }}
      style={{ flex: 1, backgroundColor: '#f3f2e9' }}
    />
  );
}
