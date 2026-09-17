import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
export const configured = !!url && !!key;
export const cacheNamespace = url ?? 'demo';
// A session can exceed SecureStore's per-value size. Publish the manifest last so
// a failed write cannot replace a working session with an incomplete one.
const secureStorage = {
  async getItem(key: string) {
    const manifest = await SecureStore.getItemAsync(`${key}.manifest`);
    if (!manifest) return null;
    const { generation, count } = JSON.parse(manifest);
    const parts = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        SecureStore.getItemAsync(`${key}.${generation}.${i}`),
      ),
    );
    return parts.every((p) => p !== null) ? parts.join('') : null;
  },
  async setItem(key: string, value: string) {
    const previous = await SecureStore.getItemAsync(`${key}.manifest`);
    const generation = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const chunks = value.match(/[\s\S]{1,1500}/g) ?? [''];
    await Promise.all(
      chunks.map((chunk, i) => SecureStore.setItemAsync(`${key}.${generation}.${i}`, chunk)),
    );
    await SecureStore.setItemAsync(
      `${key}.manifest`,
      JSON.stringify({ generation, count: chunks.length }),
    );
    if (previous) {
      const old = JSON.parse(previous);
      await Promise.all(
        Array.from({ length: old.count }, (_, i) =>
          SecureStore.deleteItemAsync(`${key}.${old.generation}.${i}`),
        ),
      );
    }
  },
  async removeItem(key: string) {
    const previous = await SecureStore.getItemAsync(`${key}.manifest`);
    await SecureStore.deleteItemAsync(`${key}.manifest`);
    if (previous) {
      const old = JSON.parse(previous);
      await Promise.all(
        Array.from({ length: old.count }, (_, i) =>
          SecureStore.deleteItemAsync(`${key}.${old.generation}.${i}`),
        ),
      );
    }
  },
};
export const supabase = configured
  ? createClient(url!, key!, {
      auth: {
        storage: Platform.OS === 'web' ? AsyncStorage : secureStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: Platform.OS === 'web',
        flowType: 'pkce',
      },
    })
  : null;
export function requireBackend() {
  if (!supabase)
    throw new Error('Ortak kayıt hizmeti henüz bağlanmadı. Şu anda demo modundasınız.');
  return supabase;
}
