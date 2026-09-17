# Kaynaklar ve lisanslar

## Parklar

© OpenStreetMap contributors. ODbL 1.0.

- https://www.openstreetmap.org/copyright
- https://opendatacommons.org/licenses/odbl/1-0/
- Sorgu: Türkiye idari alanında `leisure=park` etiketli node/way/relation öğeleri; https://overpass-api.de/api/interpreter
- Snapshot: `2026-09-13T18:38:36Z`; indirme zamanı ham JSON içinde.
- `data/parks-turkey.json` kaynak etiketler ve merkez koordinatlarıdır. `mobile/src/core/parks.json` yayımlanan türetilmiş katalogdur. Web dışa aktarımı bu kataloğu `/data/parks.json`, açıklamasını `/data/README.txt` altında sunar.
- Tuple alanları: `id, osm_id, name, city, district, latitude, longitude`.

Kaynak öğelerinin merkezleri kullanılır; park sınırları çizilmez. İsim, ilçe ve kapsam eksik olabilir. Kaynakta aynı fiziksel yer birden fazla öğeyle bulunabilir. Ham katalogda eksik isim “İsimsiz park” olarak kalır; uygulama bu kayıtları `Park alanı · kısa kod` ve mevcut adres/ilçe bilgisiyle sunar. Kodlar resmi park adı değildir.

## Park adı ve adres zenginleştirmesi

14 Eylül 2026 sürümünde 10 eksik isim tamamlandı; 23.888 kayda ilçe eşleştirildi, toplam 853 kayıtta adres açıklaması var. Belediye eşleşmelerinin 62'sinde mahalle/adres bilgisi sağlandı. 16.808 kaydın adı hâlâ bilinmiyor. Kaynak snapshot dosyaları `data/park-enrichment/`, URL, lisans, indirme zamanı ve SHA-256 kayıtları `sources.json`, sonuçlar `summary.json` içindedir.

- **Kadıköy Belediyesi / Park ve Bahçeler Müdürlüğü**, [Kadıköy Yeşil Alan](https://acikveri.kadikoy.bel.tr/dataset/kadikoy-yesil-alan), 90 nokta / 74 poligon. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). İsimler ve mahalleler boşlukları düzenlenerek kullanıldı. Mevcut OSM isimleri ezilmedi. Otomatik ad eşleştirmesi için tek park içeren tek belediye poligonu veya her iki yönde de tek aday bulunan en fazla 25 metre uzaklıktaki nokta gerekir. Çelişen nokta/poligon adları ve belirsiz eşleşmeler atlanır.
- **İzmir Büyükşehir Belediyesi**, [Kuzey ve Güney Alanları park listeleri](https://acikveri.bizizmir.com/tr/dataset/kuzey-guney-alani-park-sayilari), [CC BY 4.0 / kurum lisansı](https://acikveri.bizizmir.com/tr/license). Koordinat içermeyen bu CSV'lerden yalnızca ilçe ve normalize edilmiş adı iki tarafta da tekil olan parklara adres eklenir; bunlardan konum veya eksik park adı tahmin edilmez.
- **OpenStreetMap / OSM Boundaries, geoBoundaries aracılığıyla**, [TUR ADM2](https://www.geoboundaries.org/api/current/gbOpen/TUR/ADM2/), `TUR-ADM2-54988432`, 2021 sınırları, 973 geometri. [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Basitleştirilmiş poligon içinde tekil eşleşmeyle ilçe eklenir; güncel resmi idari sınır garantisi değildir.

UI'da her isim kaynağı park ayrıntısında; bütün kaynaklar Hakkında ekranında gösterilir. Web paketindeki `/data/park-details.json` ek alanları, `/data/enrichment-sources.json` kaynak/lisans manifestini ve `/data/README.txt` dönüşüm notlarını sunar. OSM'den türetilen katalog ODbL ile paylaşılır; ek kaynakların atıfları ve lisansları korunur. Bu bir belediye onayı/işbirliği iddiası değildir.

Bu oturumda İBB'nin eski `parklar-ve-yesil-alanlar` API adresi 404, Bursa park servisi 502 döndürdü; İzmir toplanma alanları API/CSV kaynağına erişilemedi. Bu kaynaklardan isim uydurulmadı veya eksik veri aktarılmadı.

## İl eşleştirmesi

geoBoundaries gbOpen TUR ADM1; `TUR-ADM1-25984515`, temsil yılı 2021, 81 il. Basitleştirilmiş geometriler kullanıldı. Kaynak metadata'sı OpenStreetMap ve CC BY-SA 2.0 olarak belirtir; metadata `data/provinces-source.json` dosyasında aynen saklanır.

- https://www.geoboundaries.org/api/current/gbOpen/TUR/ADM1/
- https://www.geoboundaries.org/
- https://creativecommons.org/licenses/by-sa/2.0/

24.593 park il poligonuyla eşleşti. Eşleşmeyen kayıtlar yanlış bir ile zorla atanmadı. Bu eşleştirme güncel resmi idari sınır garantisi değildir.

## Harita

MapLibre GL JS 6.9.0 (BSD-3-Clause) ve Supercluster 8.0.1 (ISC) kullanılır. JavaScript, worker ve CSS npm paketlerinden `mobile/scripts/build-map.cjs` ile tek ortak harita paketine derlenir. Web iframe ve native WebView aynı kodu çalıştırır. Lisans metinleri `mobile/licenses/` içinde korunur.

Varsayılan zemin OpenFreeMap Positron'dur; Patika için park, su, bina ve yazı renkleri uygulama içinde özelleştirilir. Kaynaklar haritanın sağ altındaki bilgi düğmesindedir: OpenFreeMap, © OpenMapTiles ve OpenStreetMap. Park işaretleri uygulamanın kataloğundan gelir; altlık sağlayıcısının yer etiketleri besleme kaydı değildir. Toplu/çevrimdışı döşeme indirme yoktur.

- https://openfreemap.org/ — ticari kullanıma da açık, hesap/API anahtarı gerektirmeyen genel servis; SLA garantisi yoktur.
- https://openfreemap.org/quick_start/
- https://www.openstreetmap.org/copyright
- https://maplibre.org/
- https://github.com/mapbox/supercluster

## Diğer paketler

Expo starter lisansı `mobile/LICENSE` içinde korunur. React, React Native, Expo, Supabase JS, React Navigation, Ionicons ve diğer bağımlılıkların sürümleri lockfile'da, kendi lisansları npm paketlerinde bulunur. Patika marka SVG'si ve simgeleri bu proje için kodla üretildi.

## Park alan geometrisi

`data/park-boundaries-osm.json` OpenStreetMap katkıcılarının ODbL 1.0 lisanslı sınır verisidir. [Kaynak ve atıf](https://www.openstreetmap.org/copyright), [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).

`mobile/public/data/park-boundaries/manifest.json` kaynak sorgularını, zaman aralığını, SHA-256 değerini, dönüşümleri ve bölge dosyalarını içerir. Türev alanlar aynı lisans altında `/data/park-boundaries/` adresinde sunulur. OSM kimliğiyle eşleştirme yapılır; kapalı Polygon/MultiPolygon geometrileri ve iç boşluklar korunur, koordinatlar altı ondalığa yuvarlanır. Sınır bulunmayan noktalardan tahmini şekil üretilmez.

Geometri dönüşümü geliştirme sırasında [osmtogeojson](https://github.com/tyrasd/osmtogeojson) (MIT) ile yapılır; dönüştürücü uygulama çalışma paketine dahil edilmez.
