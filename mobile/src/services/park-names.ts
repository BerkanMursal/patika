import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { configured, requireBackend } from './supabase';
import { validateNameSuggestion } from '../core/park-names';
import type { NameSuggestion, Park, Viewer } from '../core/types';

const demoKey = 'patika.demo.name-suggestions.v1';
let writeChain: Promise<unknown> = Promise.resolve();
export async function loadNameSuggestions(
  viewer: Viewer,
  parkId?: string,
): Promise<NameSuggestion[]> {
  if (configured) {
    const { data, error } = await requireBackend().rpc('list_park_name_suggestions', {
      p_park_id: parkId ?? null,
    });
    if (error) throw error;
    return data ?? [];
  }
  const stored: NameSuggestion[] = JSON.parse((await AsyncStorage.getItem(demoKey)) ?? '[]');
  return stored.filter((s) => s.user_id === viewer.id && (!parkId || s.park_id === parkId));
}
export async function suggestName(park: Park, viewer: Viewer, name: string, evidence: string) {
  const problem = validateNameSuggestion(name, evidence);
  if (problem) throw new Error(problem);
  const proposed = name.trim().replace(/\s+/g, ' '),
    detail = evidence.trim();
  if (proposed.toLocaleLowerCase('tr') === park.name.toLocaleLowerCase('tr'))
    throw new Error('Önerilen ad mevcut adla aynı.');
  if (configured) {
    const { data, error } = await requireBackend().rpc('suggest_park_name', {
      p_park_id: park.id,
      p_name: proposed,
      p_evidence: detail,
    });
    if (error) throw error;
    return data as string;
  }
  const operation = writeChain
    .catch(() => {})
    .then(async () => {
      const stored: NameSuggestion[] = JSON.parse((await AsyncStorage.getItem(demoKey)) ?? '[]');
      const pending = stored.find(
        (s) => s.user_id === viewer.id && s.park_id === park.id && s.status === 'pending',
      );
      if (pending) {
        if (pending.proposed_name === proposed && pending.evidence === detail) return pending.id;
        throw new Error('Bu park için zaten inceleme bekleyen bir önerin var.');
      }
      if (
        stored.filter(
          (s) => s.user_id === viewer.id && Date.now() - Date.parse(s.created_at) < 86400000,
        ).length >= 20
      )
        throw new Error('Günlük öneri sınırına ulaşıldı.');
      const suggestion: NameSuggestion = {
        id: Crypto.randomUUID(),
        user_id: viewer.id,
        park_id: park.id,
        original_name: park.name,
        proposed_name: proposed,
        evidence: detail,
        status: 'pending',
        review_note: '',
        created_at: new Date().toISOString(),
        reviewed_at: null,
        park_name: park.name,
        city: park.city,
        district: park.district,
        latitude: park.latitude,
        longitude: park.longitude,
      };
      await AsyncStorage.setItem(demoKey, JSON.stringify([suggestion, ...stored]));
      return suggestion.id;
    });
  writeChain = operation;
  return operation;
}
export async function reviewName(id: string, accept: boolean, note: string) {
  if (!configured) throw new Error('Demo önerileri gerçek moderasyona iletilmez.');
  if (note.trim().length < 10 || note.trim().length > 600)
    throw new Error('İnceleme notu 10–600 karakter olmalı.');
  const { error } = await requireBackend().rpc('review_park_name', {
    p_id: id,
    p_accept: accept,
    p_note: note.trim(),
  });
  if (error) throw error;
}
