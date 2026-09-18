import type { FeedingDraft, Park, RescueCaseStatus } from './types';

export const foodNames = { dry: 'Kuru mama', wet: 'Yaş mama', other: 'Diğer mama' };
export const bowlNames = { full: 'Dolu', low: 'Az kalmış', empty: 'Boş', unknown: 'Bilinmiyor' };
export const rescueCaseStatusNames: Record<RescueCaseStatus, string> = {
  reported: 'Bildirildi',
  verifying: 'Doğrulanıyor',
  claimed: 'Gönüllü vakayı üstlendi',
  en_route: 'Gönüllü yolda',
  at_vet: 'Veterinere ulaştırıldı',
  treating: 'Tedavi altında',
  resolved: 'Çözüldü',
};
// Matches claim_rescue_case's own WHERE clause exactly: unassigned AND one of
// these statuses — reported/verifying is a fresh claim, claimed/en_route/
// at_vet/treating with no assigned_volunteer_id is an orphaned case (its
// volunteer deleted their account) being self-service re-adopted at its
// current progress. 'resolved' is deliberately excluded — it is terminal and
// can never be claimed, orphaned or not, regardless of assigned_volunteer_id.
const claimableRescueStatuses = new Set<import('./types').RescueCaseStatus>([
  'reported',
  'verifying',
  'claimed',
  'en_route',
  'at_vet',
  'treating',
]);
export function canClaimRescueCase(c: Pick<import('./types').RescueCase, 'status' | 'assigned_volunteer_id'>) {
  return claimableRescueStatuses.has(c.status) && !c.assigned_volunteer_id;
}
// Matches update_rescue_case_status's own `expected := case p_new_status ...`
// mapping, inverted (current status -> the one next step). Kept here so the
// UI can only ever offer a single, valid next action — never a skip.
export const nextRescueCaseStatus: Partial<Record<RescueCaseStatus, RescueCaseStatus>> = {
  claimed: 'en_route',
  en_route: 'at_vet',
  at_vet: 'treating',
  treating: 'resolved',
};
export const rescueCaseActionLabels: Record<string, string> = {
  en_route: 'Yola çıktım',
  at_vet: 'Veterinere ulaştırdım',
  treating: 'Tedavi başladı',
  resolved: 'Çözüldü olarak işaretle',
};
export function normalizeSearch(value: string) {
  return value
    .trim()
    .toLocaleLowerCase('tr')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/ı/g, 'i');
}
export function validateFeeding(d: FeedingDraft, now = Date.now()): string | null {
  if (!d.user_id || !d.point_id || !d.id) return 'Kullanıcı ve besleme noktası gerekli.';
  if (!Number.isInteger(d.food_grams) || d.food_grams < 0 || d.food_grams > 100000)
    return 'Mama miktarı 0–100.000 gram arasında tam sayı olmalı.';
  if (!Number.isInteger(d.water_ml) || d.water_ml < 0 || d.water_ml > 100000)
    return 'Su miktarı 0–100.000 ml arasında tam sayı olmalı.';
  if (d.food_grams === 0 && d.water_ml === 0) return 'Mama veya su miktarı ekleyin.';
  if (!(d.food_type in foodNames)) return 'Mama türünü seçin.';
  if (!d.photo_uri) return 'Bıraktığınız mama veya suyun fotoğrafını ekleyin.';
  if (d.note.length > 500) return 'Not en fazla 500 karakter olabilir.';
  const time = Date.parse(d.occurred_at);
  if (!Number.isFinite(time) || time > now + 300000 || time < now - 90 * 86400000)
    return 'Kayıt zamanı son 90 gün içinde olmalı.';
  return null;
}
export function timeAgo(value: string | null, now = Date.now()) {
  if (!value) return 'Henüz kayıt yok';
  const minutes = Math.max(0, Math.floor((now - Date.parse(value)) / 60000));
  if (minutes < 1) return 'Az önce';
  if (minutes < 60) return `${minutes} dk önce`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} saat önce`;
  return `${Math.floor(minutes / 1440)} gün önce`;
}
export function parkStatus(park: Park, now = Date.now()) {
  const observed = park.observed_at && now - Date.parse(park.observed_at) < 86400000;
  if (observed && (park.food_status === 'empty' || park.water_status === 'empty'))
    return { key: 'check', label: 'Boş kap bildirildi', color: '#C17840', tint: '#FBF0E6' };
  if (!park.last_fed_at)
    return { key: 'unknown', label: 'Kayıt bekliyor', color: '#7B8790', tint: '#EDF0F2' };
  if (now - Date.parse(park.last_fed_at) > 7 * 86400000)
    return { key: 'old', label: 'Kayıt güncel değil', color: '#B57B3A', tint: '#FBF2DF' };
  return { key: 'recent', label: 'Yakın zamanda kayıt var', color: '#2D7660', tint: '#E8F3ED' };
}
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
export function distanceLabel(km: number) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}
export function mergeFeeding(
  parks: Park[],
  event: { park_id: string; food_grams: number; water_ml: number; occurred_at: string },
) {
  return parks.map((p) => {
    if (p.id !== event.park_id) return p;
    const newer = !p.last_fed_at || Date.parse(event.occurred_at) > Date.parse(p.last_fed_at);
    return {
      ...p,
      total_records: p.total_records + 1,
      ...(event.food_grams > 0 && newer
        ? { last_fed_at: event.occurred_at, last_grams: event.food_grams }
        : {}),
      ...(event.water_ml > 0 && (!p.last_water_at || event.occurred_at > p.last_water_at)
        ? { last_water_at: event.occurred_at }
        : {}),
    };
  });
}
