export type DeviceLocation = { latitude: number; longitude: number; accuracy: number | null };
export type LocationFailureKind =
  'denied' | 'unavailable' | 'timeout' | 'disabled' | 'unsupported' | 'insecure';

export class LocationFailure extends Error {
  constructor(public readonly kind: LocationFailureKind) {
    super(kind);
    this.name = 'LocationFailure';
  }
}

export function locationCoordinates(coords: {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}): DeviceLocation {
  if (
    !Number.isFinite(coords.latitude) ||
    !Number.isFinite(coords.longitude) ||
    Math.abs(coords.latitude) > 90 ||
    Math.abs(coords.longitude) > 180
  )
    throw new LocationFailure('unavailable');
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy! : null,
  };
}

export function locationDeadline<T>(operation: () => Promise<T>, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocationFailure('timeout')), timeoutMs);
    // A late result only settles this promise once; it cannot move the map after failure.
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

export function locationFailureMessage(error: unknown, web: boolean) {
  const kind = error instanceof LocationFailure ? error.kind : 'unavailable';
  switch (kind) {
    case 'denied':
      return web
        ? 'Konum izni engellenmiş. Tarayıcının bu siteye ait izinlerinden konumu açıp tekrar dene.'
        : 'Konum izni kapalı. Telefon ayarlarında Patika için konum iznini açıp tekrar dene.';
    case 'disabled':
      return 'Cihazının konum hizmetleri kapalı. Konumu açıp tekrar dene.';
    case 'unsupported':
      return 'Bu tarayıcı konum özelliğini sunmuyor. Bağlantıyı Chrome, Edge veya Safari’de açabilir ya da park/şehir arayabilirsin.';
    case 'insecure':
      return 'Konum için uygulamayı güvenli HTTPS adresinden açmalısın.';
    case 'timeout':
      return web
        ? 'Tarayıcı konumu zamanında iletemedi. Cihazının konum hizmetlerini kontrol et. Uygulama içi tarayıcıdaysan bağlantıyı Chrome, Edge veya Safari’de açıp tekrar dene.'
        : 'Konum zamanında alınamadı. Telefonunun konum hizmetlerini kontrol edip tekrar dene.';
    default:
      return web
        ? 'Tarayıcı konumunu belirleyemedi. Konum hizmetlerini ve bağlantını kontrol et; uygulama içi tarayıcıdaysan Chrome, Edge veya Safari’de tekrar dene.'
        : 'Cihaz konumunu belirleyemedi. Konum hizmetlerini ve bağlantını kontrol edip tekrar dene.';
  }
}
