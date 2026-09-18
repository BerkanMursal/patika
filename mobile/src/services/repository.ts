import type {
  Feeding,
  FeedingDraft,
  LeaderboardRow,
  Observation,
  Park,
  Point,
  Region,
  Report,
  RescueCase,
  RescueCaseDraft,
} from '../core/types';
import { requireBackend } from './supabase';
import { photoBytes } from './photos';
import { presentPark, parkDisplayName } from '../core/park-names';

export async function loadParks(region: Region, query = ''): Promise<Park[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const { data, error } = await requireBackend()
      .rpc('get_parks', {
        p_south: region.latitude - region.latitudeDelta / 2,
        p_north: region.latitude + region.latitudeDelta / 2,
        p_west: region.longitude - region.longitudeDelta / 2,
        p_east: region.longitude + region.longitudeDelta / 2,
        p_query: query,
      })
      .abortSignal(controller.signal);
    if (error) throw error;
    return (data ?? []).map(presentPark);
  } finally {
    clearTimeout(timer);
  }
}
export async function loadPark(id: string): Promise<Park | null> {
  const { data, error } = await requireBackend().rpc('get_park', { p_id: id });
  if (error) throw error;
  return data?.[0] ? presentPark(data[0]) : null;
}
export async function loadPoints(parkId: string): Promise<Point[]> {
  const { data, error } = await requireBackend()
    .from('feeding_points')
    .select('id,park_id,name,latitude,longitude')
    .eq('park_id', parkId)
    .eq('active', true)
    .order('name');
  if (error) throw error;
  return data ?? [];
}
export async function loadEvents(
  parkId?: string,
  mine = false,
  before?: string,
): Promise<Feeding[]> {
  const [time, cursorId] = before?.split('|') ?? [];
  const client = requireBackend();
  const { data, error } = await client.rpc('list_feedings', {
    p_park_id: parkId ?? null,
    p_mine: mine,
    p_before: time ?? new Date(Date.now() + 301000).toISOString(),
    p_before_id: cursorId ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  });
  if (error) throw error;
  const events = ((data ?? []) as Feeding[]).map((e) => ({
    ...e,
    park_name: parkDisplayName(e.park_id, e.park_name),
  }));
  const { data: session } = await client.auth.getSession();
  if (!session.session) return events;
  const paths = events.filter((e) => e.photo_path).map((e) => e.photo_path);
  if (!paths.length) return events;
  const { data: signed } = await client.storage.from('feeding-photos').createSignedUrls(paths, 900);
  const urls = new Map((signed ?? []).map((s) => [s.path, s.signedUrl]));
  return events.map((e) => ({ ...e, photo_url: urls.get(e.photo_path) ?? undefined }));
}
export async function submitFeeding(draft: FeedingDraft) {
  const client = requireBackend();
  const path = `${draft.user_id}/${draft.id}.jpg`;
  const bytes = await photoBytes(draft.photo_uri);
  if (bytes.byteLength > 5 * 1024 * 1024)
    throw new Error('Fotoğraf 5 MB sınırını aşıyor. Daha küçük bir fotoğraf seçin.');
  const { error: upload } = await client.storage
    .from('feeding-photos')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  // A previous attempt may have uploaded the photo before connectivity was lost.
  if (upload && !/already exists|duplicate/i.test(upload.message)) throw upload;
  const { photo_uri, ...payload } = draft;
  const { data, error } = await client.rpc('submit_feeding', {
    p_payload: { ...payload, photo_path: path },
  });
  if (error) throw error;
  return data as string;
}
export async function reportRescueCase(userId: string, draft: RescueCaseDraft) {
  const client = requireBackend();
  const path = `${userId}/rescue-cases/${draft.id}.jpg`;
  const bytes = await photoBytes(draft.photo_uri);
  if (bytes.byteLength > 5 * 1024 * 1024)
    throw new Error('Fotoğraf 5 MB sınırını aşıyor. Daha küçük bir fotoğraf seçin.');
  const { error: upload } = await client.storage
    .from('feeding-photos')
    .upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
  // A previous attempt may have uploaded the photo before the RPC call failed/timed out;
  // retrying with the same draft.id reuses this same path, so submit_feeding's
  // "already exists" tolerance applies here too.
  if (upload && !/already exists|duplicate/i.test(upload.message)) throw upload;
  const { data, error } = await client.rpc('report_rescue_case', {
    p_id: draft.id,
    p_latitude: draft.latitude,
    p_longitude: draft.longitude,
    p_description: draft.description,
    p_animal_condition: draft.animal_condition,
    p_photo_path: path,
  });
  if (error) throw error;
  return data as string;
}
export async function claimRescueCase(id: string) {
  const { data, error } = await requireBackend().rpc('claim_rescue_case', { p_case_id: id });
  if (error) throw error;
  return data as string;
}
export async function getRescueCase(id: string): Promise<RescueCase | null> {
  const client = requireBackend();
  const { data, error } = await client
    .from('rescue_cases')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { data: signed } = await client.storage
    .from('feeding-photos')
    .createSignedUrl(data.photo_path, 900);
  return { ...data, photo_url: signed?.signedUrl } as RescueCase;
}
export async function submitObservation(input: Observation) {
  const { error } = await requireBackend().rpc('submit_observation', {
    p_point_id: input.point_id,
    p_food: input.food_status,
    p_water: input.water_status,
    p_note: input.note,
    p_latitude: input.reported_latitude,
    p_longitude: input.reported_longitude,
  });
  if (error) throw error;
}
export async function getMyPoints(): Promise<number> {
  const { data, error } = await requireBackend().rpc('get_my_points');
  if (error) throw error;
  return data as number;
}
export async function getLeaderboard(limit = 50): Promise<LeaderboardRow[]> {
  const { data, error } = await requireBackend().rpc('get_leaderboard', { p_limit: limit });
  if (error) throw error;
  return (data ?? []) as LeaderboardRow[];
}
export async function loadFavorites(): Promise<string[]> {
  const { data, error } = await requireBackend().from('favorites').select('park_id');
  if (error) throw error;
  return (data ?? []).map((x) => x.park_id);
}
export async function saveFavorite(userId: string, parkId: string, enabled: boolean) {
  const q = enabled
    ? requireBackend().from('favorites').upsert({ user_id: userId, park_id: parkId })
    : requireBackend().from('favorites').delete().eq('user_id', userId).eq('park_id', parkId);
  const { error } = await q;
  if (error) throw error;
}
export async function reportItem(
  reason: string,
  detail: string,
  parkId?: string,
  feedingId?: string,
) {
  const { error } = await requireBackend().rpc('report_item', {
    p_reason: reason,
    p_detail: detail,
    p_park_id: parkId ?? null,
    p_feeding_id: feedingId ?? null,
  });
  if (error) throw error;
}
export async function removeFeeding(id: string) {
  const { error } = await requireBackend().rpc('remove_feeding', { p_id: id });
  if (error) throw error;
}
export async function blockUser(id: string) {
  const { error } = await requireBackend().rpc('block_user', { p_id: id });
  if (error) throw error;
}
export async function loadReports(): Promise<Report[]> {
  const { data, error } = await requireBackend()
    .from('reports')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}
export async function resolveReport(id: string, hide: boolean) {
  const { error } = await requireBackend().rpc('resolve_report', { p_id: id, p_hide: hide });
  if (error) throw error;
}
export async function loadReportContext(
  id: string,
): Promise<import('../core/types').ReportContext> {
  const client = requireBackend();
  const { data, error } = await client.rpc('get_report_context', { p_id: id });
  if (error) throw error;
  if (!data) throw new Error('Bildirilen içerik bulunamadı.');
  if (data.feeding?.photo_path) {
    const signed = await client.storage
      .from('feeding-photos')
      .createSignedUrl(data.feeding.photo_path, 900);
    data.feeding.photo_url = signed.data?.signedUrl;
  }
  return data;
}
