import type { FeedingDraft, Pending } from './types';
import { unavailableMessage, type ParkLookup } from './park-lifecycle';

// Per-item logic of the offline feeding queue (AppProvider.sync owns persistence,
// ordering and concurrency). A queued feeding may reference a park that was merged
// into another park after it was recorded, so right before submission its park id is
// resolved through the central park lifecycle:
//   live      -> submitted unchanged
//   merged    -> submitted against the surviving park; the park's GENERAL feeding point
//                (whose id equals the park id) becomes the survivor's general point, a
//                custom point keeps its id (the release re-parents custom points)
//   retired / unknown -> not submitted; the item stays queued with the normal
//                failed / retry / cancel state
// Only the OUTGOING payload is adapted; the stored item is never rewritten before the
// server accepted it.

export type QueueDeps = {
  resolvePark: (id: string) => Promise<ParkLookup>;
  submit: (draft: FeedingDraft) => Promise<unknown>;
};

export function prepareQueuedFeeding<T extends FeedingDraft>(
  item: T,
  lookup: ParkLookup,
): { type: 'submit'; draft: T } | { type: 'blocked'; error: string } {
  const { resolution, park } = lookup;
  if (resolution.kind === 'live' && park) return { type: 'submit', draft: item };
  if (resolution.kind === 'alias' && park) {
    const survivor = resolution.id;
    const generalPoint = item.point_id === item.park_id;
    return {
      type: 'submit',
      draft: { ...item, park_id: survivor, point_id: generalPoint ? survivor : item.point_id },
    };
  }
  const message = unavailableMessage(resolution);
  return {
    type: 'blocked',
    error: `${message.title} Kayıt gönderilmedi ve bu cihazda saklanıyor; iptal edebilir veya daha sonra tekrar deneyebilirsin.`,
  };
}

// Resolves and submits one queued feeding. Throws on any failure (lookup/network,
// blocked park, server rejection) so the caller's existing failure path applies.
export async function submitQueuedFeeding(item: FeedingDraft, deps: QueueDeps) {
  const prepared = prepareQueuedFeeding(item, await deps.resolvePark(item.park_id));
  if (prepared.type === 'blocked') throw new Error(prepared.error);
  return deps.submit(prepared.draft);
}

// The queue's two state transitions (unchanged semantics, shared with AppProvider.sync).
export const completeQueuedFeeding = (items: Pending[], id: string) =>
  items.filter((q) => q.id !== id);
export const failQueuedFeeding = (items: Pending[], id: string, e: unknown): Pending[] =>
  items.map((q) =>
    q.id === id
      ? {
          ...q,
          status: 'error' as const,
          attempts: q.attempts + 1,
          error:
            e instanceof Error
              ? e.message
              : 'Gönderilemedi. Bağlantıyı kontrol ederek tekrar deneyin.',
        }
      : q,
  );
