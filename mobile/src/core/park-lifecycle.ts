import type { Park } from './types';

// Client side of the park lifecycle (docs/CANONICAL_PARK_LIFECYCLE.md §5). A park id the
// app once saw (deep link, favourite, feeding history, cached list) may since have been
// merged into another park or retired. Resolution is live-first: the normal get_park
// lookup answers every live id exactly as before; only when it finds nothing is
// resolve_park_id consulted, and an alias is followed at most ONE hop (the server keeps
// aliases flattened), so no lookup or navigation can loop.

export type RetiredReason = 'taxonomy_review' | 'non_park' | 'source_withdrawn' | 'other';
export type ParkResolution =
  | { kind: 'live'; id: string }
  | { kind: 'alias'; id: string; from: string }
  | { kind: 'retired'; reason: RetiredReason }
  | { kind: 'not_found' };
// Shape of one resolve_park_id() row.
export type ResolveRow = {
  status: string;
  resolved_park_id: string | null;
  tombstone_status: string | null;
} | null;
export type ParkLookup = { resolution: ParkResolution; park: Park | null };
export type ParkLookupDeps = {
  loadPark: (id: string) => Promise<Park | null>;
  resolve: (id: string) => Promise<ResolveRow>;
};

const RETIRED: Record<string, RetiredReason> = {
  taxonomy_review: 'taxonomy_review',
  non_park: 'non_park',
  source_withdrawn: 'source_withdrawn',
};

export function parseResolution(input: string, row: ResolveRow): ParkResolution {
  if (!row) return { kind: 'not_found' };
  if (row.status === 'live' && row.resolved_park_id)
    return { kind: 'live', id: row.resolved_park_id };
  if (row.status === 'alias' && row.resolved_park_id && row.resolved_park_id !== input)
    return { kind: 'alias', id: row.resolved_park_id, from: input };
  if (row.status === 'tombstone')
    return { kind: 'retired', reason: RETIRED[row.tombstone_status ?? ''] ?? 'other' };
  // 'inactive' (hidden by moderation) and anything unknown keep the existing
  // "park not found" behaviour; moderation state is never surfaced.
  return { kind: 'not_found' };
}

export async function lookupPark(id: string, deps: ParkLookupDeps): Promise<ParkLookup> {
  const park = await deps.loadPark(id);
  if (park) return { resolution: { kind: 'live', id }, park };
  const resolution = parseResolution(id, await deps.resolve(id));
  if (resolution.kind === 'alias' || resolution.kind === 'live') {
    // exactly one follow-up lookup of the target, never another resolve call
    const target = resolution.id === id ? null : await deps.loadPark(resolution.id);
    if (!target) return { resolution: { kind: 'not_found' }, park: null };
    return { resolution: { kind: 'alias', id: resolution.id, from: id }, park: target };
  }
  return { resolution, park: null };
}

export type ParkMessage = { title: string; detail: string };
// User-facing copy. Deliberately free of internal registry vocabulary.
export const parkMessages = {
  updated: {
    title: 'Bu park kaydı güncellendi.',
    detail: 'Açtığın bağlantı artık bu parkı gösteriyor.',
  },
  taxonomy_review: {
    title: 'Bu konum şu anda doğrulanıyor.',
    detail:
      'Bu kaydın park olarak listelenip listelenmeyeceği inceleniyor. İnceleme tamamlanana kadar haritada gösterilmiyor.',
  },
  non_park: {
    title: 'Bu kayıt artık park olarak listelenmiyor.',
    detail: 'Kaynak bilgiler bu konumun bir park olmadığını gösteriyor.',
  },
  source_withdrawn: {
    title: 'Bu park artık güncel park listesinde yer almıyor.',
    detail:
      'Kaynak verilerde artık bulunmadığı için haritada gösterilmiyor. Daha önce paylaşılan kayıtlar silinmedi.',
  },
  other: {
    title: 'Bu park şu anda listelenmiyor.',
    detail: 'Kayıt güncellendi ve artık haritada gösterilmiyor.',
  },
  not_found: {
    title: 'Park bulunamadı',
    detail: 'Park kaldırılmış veya bağlantı geçici olarak kesilmiş olabilir.',
  },
} satisfies Record<string, ParkMessage>;

export function unavailableMessage(resolution: ParkResolution): ParkMessage {
  return resolution.kind === 'retired' ? parkMessages[resolution.reason] : parkMessages.not_found;
}

export type ParkRouteAction =
  | { type: 'show'; park: Park }
  | { type: 'redirect'; id: string }
  | { type: 'unavailable'; message: ParkMessage };

// What a screen opened with a park id should do. A screen that was itself reached
// through a redirect never redirects again (loop guard).
export function parkRouteAction(lookup: ParkLookup, redirectedFrom?: string): ParkRouteAction {
  const { resolution, park } = lookup;
  if (resolution.kind === 'live' && park) return { type: 'show', park };
  if (resolution.kind === 'alias' && park)
    return redirectedFrom
      ? { type: 'unavailable', message: parkMessages.not_found }
      : { type: 'redirect', id: resolution.id };
  return { type: 'unavailable', message: unavailableMessage(resolution) };
}

// Followed parks: merged ids show their surviving park (once), retired / unknown ids stay
// visible with a plain explanation - a follow is never dropped silently.
export function favoriteView(entries: { id: string; lookup: ParkLookup }[]) {
  const parks: Park[] = [],
    seen = new Set<string>(),
    unavailable: { id: string; message: ParkMessage }[] = [];
  for (const { id, lookup } of entries) {
    const { resolution, park } = lookup;
    if (park && (resolution.kind === 'live' || resolution.kind === 'alias')) {
      if (!seen.has(park.id)) {
        seen.add(park.id);
        parks.push(park);
      }
    } else unavailable.push({ id, message: unavailableMessage(resolution) });
  }
  return { parks, unavailable };
}
