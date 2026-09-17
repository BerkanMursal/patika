import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';
import { cacheNamespace, configured, supabase } from '../services/supabase';
import * as api from '../services/repository';
import { demoData } from '../core/demo';
import { mergeFeeding, validateFeeding } from '../core/domain';
import { presentPark, restoreParkActivity } from '../core/park-names';
import { persistPhoto, removeLocalPhoto } from '../services/photos';
import type { Feeding, FeedingDraft, Park, Pending, Point, Region, Viewer } from '../core/types';

type Store = {
  demo: boolean;
  ready: boolean;
  viewer: Viewer | null;
  online: boolean;
  parks: Park[];
  loading: boolean;
  error: string;
  region: Region;
  setRegion: (r: Region) => void;
  refresh: (query?: string) => Promise<void>;
  getPark: (id: string) => Promise<Park | null>;
  getPoints: (id: string) => Promise<Point[]>;
  getEvents: (parkId?: string, mine?: boolean, before?: string) => Promise<Feeding[]>;
  favorites: string[];
  toggleFavorite: (id: string) => Promise<void>;
  queue: Pending[];
  syncing: boolean;
  enqueue: (d: FeedingDraft) => Promise<void>;
  sync: () => Promise<void>;
  discard: (id: string) => Promise<void>;
  enterDemo: (name?: string) => Promise<void>;
  logout: () => Promise<void>;
  rename: (name: string) => Promise<void>;
  deleteDemoEvent: (id: string) => Promise<void>;
  observeDemo: (id: string, food: Park['food_status'], water: Park['water_status']) => void;
};
const Context = createContext<Store | null>(null);
const initialRegion: Region = {
  latitude: 40.991,
  longitude: 29.04,
  latitudeDelta: 0.08,
  longitudeDelta: 0.13,
};
const demoSeed = demoData();
const initialParks = new Map(demoSeed.parks.map((p) => [p.id, p]));
export function AppProvider({ children }: { children: React.ReactNode }) {
  const [viewer, setViewer] = useState<Viewer | null>(null),
    [ready, setReady] = useState(false),
    [online, setOnline] = useState(true),
    [parks, setParks] = useState<Park[]>(configured ? [] : demoSeed.parks),
    [events, setEvents] = useState<Feeding[]>(demoSeed.events),
    [favorites, setFavorites] = useState<string[]>([]),
    [queue, setQueue] = useState<Pending[]>([]),
    [queueReady, setQueueReady] = useState(false),
    [syncing, setSyncing] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [region, setRegion] = useState(initialRegion);
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const parksRef = useRef(parks);
  parksRef.current = parks;
  const queueRef = useRef(queue);
  const syncingRef = useRef(false);
  const generation = useRef(0);
  const writeChain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((s) =>
      setOnline(s.isConnected !== false && s.isInternetReachable !== false),
    );
    const lifecycle = AppState.addEventListener('change', (s) => {
      if (s === 'active') supabase?.auth.startAutoRefresh();
      else supabase?.auth.stopAutoRefresh();
    });
    if (supabase) {
      const update = (session: any) =>
        setViewer(
          session
            ? {
                id: session.user.id,
                name: session.user.user_metadata?.display_name ?? 'Hayvansever',
                email: session.user.email,
                moderator: session.user.app_metadata?.role === 'moderator',
              }
            : null,
        );
      supabase.auth.getSession().then(({ data, error }) => {
        if (error) setError('Oturum yüklenemedi. Yeniden giriş yapabilirsiniz.');
        update(data.session);
        setReady(true);
      });
      const { data: auth } = supabase.auth.onAuthStateChange((_, session) => {
        update(session);
        setReady(true);
      });
      return () => {
        unsubscribe();
        lifecycle.remove();
        auth.subscription.unsubscribe();
      };
    }
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('patika.demo.v2');
        if (raw) {
          const d = JSON.parse(raw);
          const changes = new Map<string, Park>((d.updates ?? []).map((p: Park) => [p.id, p]));
          setParks(demoSeed.parks.map((p) => restoreParkActivity(p, changes.get(p.id))));
          setEvents([
            ...demoSeed.events,
            ...(d.events ?? []).map((e: Feeding) => ({
              ...e,
              park_name: initialParks.get(e.park_id)?.name ?? e.park_name,
            })),
          ]);
          setViewer(d.viewer ?? null);
        }
      } catch {
        setError('Demo kaydı okunamadı; başlangıç verileri açıldı.');
      } finally {
        setReady(true);
      }
    })();
    return () => {
      unsubscribe();
      lifecycle.remove();
    };
  }, []);
  useEffect(() => {
    if (!configured && ready)
      void AsyncStorage.setItem(
        'patika.demo.v2',
        JSON.stringify({
          updates: parks.filter((p) => p !== initialParks.get(p.id)),
          events: events.filter((e) => e.user_id === 'demo-self'),
          viewer,
        }),
      ).catch(() => setError('Cihaz depolaması dolu. Demo değişikliği kalıcı kaydedilemedi.'));
  }, [parks, events, viewer, ready]);
  useEffect(() => {
    let cancelled = false;
    setQueueReady(false);
    setFavorites([]);
    setQueue([]);
    queueRef.current = [];
    if (!viewer) return;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(`patika.queue.${cacheNamespace}.${viewer.id}`);
        const pending = raw ? JSON.parse(raw) : [];
        if (cancelled) return;
        queueRef.current = pending;
        setQueue(pending);
        setQueueReady(true);
        const saved = configured
          ? await api.loadFavorites()
          : JSON.parse((await AsyncStorage.getItem(`patika.favorites.${viewer.id}`)) ?? '[]');
        if (!cancelled) setFavorites(saved);
      } catch {
        if (!cancelled) setError('Cihazdaki bekleyen kayıtlar veya takipler yüklenemedi.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [viewer?.id]);
  const refresh = useCallback(
    async (query = '') => {
      if (!configured) return;
      const id = ++generation.current;
      setLoading(true);
      setError('');
      try {
        const result = await api.loadParks(region, query);
        if (id !== generation.current) return;
        setParks(result);
        await AsyncStorage.setItem(`patika.parks.${cacheNamespace}`, JSON.stringify(result));
      } catch {
        if (id !== generation.current) return;
        setError('Parklar yenilenemedi. Son yüklenen kayıtları görüyorsunuz.');
        try {
          const cached = await AsyncStorage.getItem(`patika.parks.${cacheNamespace}`);
          if (cached) setParks(JSON.parse(cached).map(presentPark));
        } catch {
          /* Keep the currently visible data. */
        }
      } finally {
        if (id === generation.current) setLoading(false);
      }
    },
    [region],
  );
  async function writeQueue(update: (items: Pending[]) => Pending[], owner: string) {
    const write = writeChain.current
      .catch(() => {})
      .then(async () => {
        if (viewerRef.current?.id !== owner) return;
        const next = update(queueRef.current);
        await AsyncStorage.setItem(`patika.queue.${cacheNamespace}.${owner}`, JSON.stringify(next));
        queueRef.current = next;
        setQueue(next);
      });
    writeChain.current = write;
    await write;
  }
  async function sync() {
    const user = viewerRef.current;
    if (!user || !online || syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      for (const item of [...queueRef.current]) {
        if (viewerRef.current?.id !== user.id) break;
        if (item.user_id !== user.id) continue;
        try {
          if (configured) await api.submitFeeding(item);
          else if (!eventsRef.current.some((e) => e.id === item.id)) {
            const next = [
              { ...item, author_name: user.name, photo_path: '', photo_url: item.photo_uri },
              ...eventsRef.current,
            ];
            eventsRef.current = next;
            setEvents(next);
            setParks((all) => mergeFeeding(all, item));
          }
          await writeQueue((items) => items.filter((q) => q.id !== item.id), user.id);
          if (configured) removeLocalPhoto(item.photo_uri);
        } catch (e) {
          await writeQueue(
            (items) =>
              items.map((q) =>
                q.id === item.id
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
              ),
            user.id,
          );
        }
      }
      if (configured) await refresh();
    } catch {
      setError('Kayıt durumu cihazda güncellenemedi. Gönderimi tekrar deneyebilirsiniz.');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }
  useEffect(() => {
    if (online && viewer?.id && queue.length) void sync();
  }, [online, viewer?.id, queueReady]);
  async function enqueue(draft: FeedingDraft) {
    if (!viewer || viewer.id !== draft.user_id) throw new Error('Kayıt için giriş yapın.');
    if (!queueReady) throw new Error('Cihazdaki kayıtlar yükleniyor. Birazdan tekrar deneyin.');
    const problem = validateFeeding(draft);
    if (problem) throw new Error(problem);
    if (queueRef.current.some((q) => q.id === draft.id)) return;
    const photo_uri = await persistPhoto(draft.photo_uri, draft.id);
    await writeQueue(
      (items) => [...items, { ...draft, photo_uri, status: 'pending', attempts: 0 }],
      viewer.id,
    );
    void sync();
  }
  async function toggleFavorite(id: string) {
    if (!viewer) throw new Error('Parkı takip etmek için giriş yapın.');
    const next = favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id];
    if (configured) await api.saveFavorite(viewer.id, id, next.includes(id));
    else await AsyncStorage.setItem(`patika.favorites.${viewer.id}`, JSON.stringify(next));
    setFavorites(next);
  }
  async function getPark(id: string) {
    return configured ? api.loadPark(id) : (parksRef.current.find((p) => p.id === id) ?? null);
  }
  async function getPoints(id: string) {
    return configured ? api.loadPoints(id) : demoSeed.points.filter((p) => p.park_id === id);
  }
  async function getEvents(parkId?: string, mine = false, before?: string) {
    const [time, cursorId] = before?.split('|') ?? [];
    return configured
      ? api.loadEvents(parkId, mine, before)
      : eventsRef.current
          .filter(
            (e) =>
              (!parkId || e.park_id === parkId) &&
              (!mine || e.user_id === viewer?.id) &&
              (!time || e.occurred_at < time || (e.occurred_at === time && e.id < cursorId)),
          )
          .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at) || b.id.localeCompare(a.id))
          .slice(0, 30);
  }
  async function deleteDemoEvent(id: string) {
    const removed = eventsRef.current.find((e) => e.id === id);
    if (!removed || removed.user_id !== viewerRef.current?.id) return;
    const remaining = eventsRef.current.filter((e) => e.id !== id);
    eventsRef.current = remaining;
    setEvents(remaining);
    setParks((all) => {
      const cleared = all.map((p) =>
        p.id === removed.park_id
          ? { ...p, last_fed_at: null, last_grams: null, last_water_at: null, total_records: 0 }
          : p,
      );
      return remaining
        .filter((e) => e.park_id === removed.park_id)
        .reduce((ps, e) => mergeFeeding(ps, e), cleared);
    });
    removeLocalPhoto(removed.photo_url ?? '');
  }
  async function logout() {
    if (syncingRef.current) throw new Error('Devam eden gönderim bitince çıkış yapabilirsiniz.');
    if (supabase) {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } else setViewer(null);
  }
  async function rename(name: string) {
    if (!name.trim() || name.trim().length > 40) throw new Error('Adınız 1–40 karakter olmalı.');
    if (supabase) {
      const { error } = await supabase.auth.updateUser({ data: { display_name: name.trim() } });
      if (error) throw error;
    } else if (viewer) setViewer({ ...viewer, name: name.trim() });
  }
  async function discard(id: string) {
    if (syncingRef.current) throw new Error('Gönderim sürerken kaydı silemezsiniz.');
    const item = queueRef.current.find((q) => q.id === id);
    if (item && viewer) {
      await writeQueue((items) => items.filter((q) => q.id !== id), viewer.id);
      removeLocalPhoto(item.photo_uri);
    }
  }
  return (
    <Context.Provider
      value={{
        demo: !configured,
        ready,
        viewer,
        online,
        parks,
        loading,
        error,
        region,
        setRegion,
        refresh,
        getPark,
        getPoints,
        getEvents,
        favorites,
        toggleFavorite,
        queue,
        syncing,
        enqueue,
        sync,
        discard,
        enterDemo: async (name = 'Arda') => {
          setViewer({ id: 'demo-self', name: name.trim() || 'Hayvansever' });
        },
        logout,
        rename,
        deleteDemoEvent,
        observeDemo: (id, food, water) =>
          setParks((all) =>
            all.map((p) =>
              p.id === id
                ? {
                    ...p,
                    food_status: food,
                    water_status: water,
                    observed_at: new Date().toISOString(),
                  }
                : p,
            ),
          ),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useApp() {
  const value = useContext(Context);
  if (!value) throw new Error('AppProvider missing');
  return value;
}
