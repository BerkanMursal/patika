import type { Park } from './types';

export function parkCode(park: Pick<Park, 'id' | 'osm_id'>) {
  return park.id.replace(/-/g, '').slice(0, 10).toUpperCase();
}
export function parkDisplayName(id: string, name: string) {
  return !name?.trim() || name === 'İsimsiz park' ? `Park alanı · ${parkCode({ id })}` : name;
}
export function presentPark(park: Park): Park {
  const missing =
    park.name_status === 'missing' || !park.name?.trim() || park.name === 'İsimsiz park';
  return {
    ...park,
    name: missing ? `Park alanı · ${parkCode(park)}` : park.name,
    name_status: missing ? 'missing' : (park.name_status ?? 'source'),
    name_source: park.name_source || 'OpenStreetMap',
    name_source_url:
      park.name_status === 'community'
        ? ''
        : park.name_source_url ||
          (park.osm_id ? `https://www.openstreetmap.org/${park.osm_id}` : ''),
  };
}
export function parkPlace(park: Park) {
  return [park.address_label, park.district, park.city].filter(Boolean).join(' · ') || 'Türkiye';
}
export function validateNameSuggestion(name: string, evidence: string) {
  const cleaned = name.trim().replace(/\s+/g, ' ');
  if (
    cleaned.length < 3 ||
    cleaned.length > 120 ||
    !/\p{L}/u.test(cleaned) ||
    /[<>\u0000-\u001f\u007f]|https?:\/\/|www\./iu.test(name)
  )
    return 'Park adı 3–120 karakter olmalı; bağlantı veya özel kontrol karakteri içermemeli.';
  if (
    /^(isimsiz park|park alani|park)$/i.test(
      cleaned
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i'),
    )
  )
    return 'Parkın bilinen adını yaz; genel bir park etiketi kullanma.';
  if (evidence.trim().length < 10 || evidence.trim().length > 600)
    return 'Adı nereden doğrulayabileceğimizi 10–600 karakterle açıkla.';
  return null;
}

// Persisted demo records contain changing feeding state, never authoritative park
// identity. Old cached names must not undo a newer municipality/catalog update.
export function restoreParkActivity(park: Park, saved?: Park): Park {
  if (!saved) return park;
  return {
    ...park,
    last_fed_at: saved.last_fed_at,
    last_grams: saved.last_grams,
    last_water_at: saved.last_water_at,
    total_records: saved.total_records,
    food_status: saved.food_status,
    water_status: saved.water_status,
    observed_at: saved.observed_at,
  };
}
