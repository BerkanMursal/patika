import { mapRuntime, mapWorker, mapCss } from './map-bundle';
import { scriptJSON, type MapState } from './map-model';

export function mapDocument(initial: MapState) {
  const style =
    process.env.EXPO_PUBLIC_MAP_STYLE_URL || 'https://tiles.openfreemap.org/styles/positron';
  return `<!doctype html><html lang="tr"><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>${mapCss}</style></head><body><div id="map"></div><script>${mapRuntime.replace(/<\/script/gi, '<\\/script')}</script><script>
  var parentOrigin=new URL(document.baseURI).origin;
  var controller = PatikaMap.createMap(document.getElementById('map'),${scriptJSON(initial)},${scriptJSON(style)},${scriptJSON(mapWorker)},function(event){
    var message={channel:'patika-map',event:event};
    if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(message));
    else window.parent.postMessage(message,parentOrigin);
  },new URL('/data/park-boundaries/',document.baseURI).href);
  window.updatePatika=function(data){controller.update(data);};
  window.addEventListener('message',function(event){if(event.source===window.parent&&event.origin===parentOrigin&&event.data&&event.data.channel==='patika-map-update')window.updatePatika(event.data.state);});
  window.addEventListener('pagehide',function(){controller.destroy();});
  </script></body></html>`;
}
