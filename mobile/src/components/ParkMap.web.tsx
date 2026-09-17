import React, { useEffect, useMemo, useRef } from 'react';
import type { ParkMapProps } from './Map.types';
import { mapDocument } from './map-document';
import { isMapEvent, mapParks, type MapState } from './map-model';

export default function ParkMap(props: ParkMapProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const state: MapState = {
    parks: mapParks(props.parks),
    region: props.region,
    selected: props.selected,
    userLocation: props.userLocation,
  };
  const html = useMemo(() => mapDocument(state), []);
  const send = () => {
    const p = latest.current;
    frame.current?.contentWindow?.postMessage(
      {
        channel: 'patika-map-update',
        state: {
          parks: mapParks(p.parks),
          region: p.region,
          selected: p.selected,
          userLocation: p.userLocation,
        },
      },
      window.location.origin,
    );
  };
  useEffect(() => {
    const receive = (message: MessageEvent) => {
      if (
        message.source !== frame.current?.contentWindow ||
        message.origin !== window.location.origin ||
        message.data?.channel !== 'patika-map'
      )
        return;
      const event = message.data.event;
      if (!isMapEvent(event)) return;
      if (event.type === 'ready') send();
      if (event.type === 'move') latest.current.onMove(event.region);
      if (event.type === 'select' && latest.current.parks.some((p) => p.id === event.id))
        latest.current.onSelect(event.id);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  useEffect(send, [props.parks, props.region, props.selected, props.userLocation]);
  return (
    <iframe
      ref={frame}
      title="Parkların bulunduğu etkileşimli harita"
      srcDoc={html}
      onLoad={send}
      style={{ display: 'block', border: 0, width: '100%', height: '100%', background: '#f3f2e9' }}
    />
  );
}
