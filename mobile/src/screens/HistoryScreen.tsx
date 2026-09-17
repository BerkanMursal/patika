import React, { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import type { Feeding, Park } from '../core/types';
import { useApp } from '../state/AppProvider';
import { Button, Empty, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { FeedingCard } from '../components/FeedingCard';
import { ParkCard } from '../components/ParkCard';
import * as api from '../services/repository';
export function HistoryScreen({ mine = false }: { mine?: boolean }) {
  const app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const [events, setEvents] = useState<Feeding[]>([]),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState<string>(),
    [hasMore, setHasMore] = useState(true);
  async function load(more = false) {
    setLoading(true);
    setError('');
    try {
      const data = await app.getEvents(
        undefined,
        mine,
        more
          ? [events[events.length - 1]?.occurred_at, events[events.length - 1]?.id].join('|')
          : undefined,
      );
      setEvents((all) => (more ? [...all, ...data] : data));
      setHasMore(data.length >= 30);
    } catch {
      setError('Kayıtlar yüklenemedi. Tekrar deneyin.');
    } finally {
      setLoading(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [app.viewer?.id, mine]),
  );
  async function remove(id: string) {
    try {
      if (app.demo) await app.deleteDemoEvent(id);
      else await api.removeFeeding(id);
      setConfirm(undefined);
      await load();
    } catch {
      setError('Kayıt kaldırılamadı.');
    }
  }
  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
    >
      <Text style={t.eyebrow}>PAYLAŞILAN HER KAP DEĞERLİ</Text>
      <Text style={t.title}>{mine ? 'Bıraktığım izler' : 'İyilik akışı'}</Text>
      <Text style={t.body}>
        {mine
          ? 'Paylaştığın mama ve su kayıtları burada.'
          : 'Parklarda paylaşılan son mama ve su kayıtları.'}
      </Text>
      {error ? <Notice error text={error} /> : null}
      {!app.viewer && mine ? (
        <Button label="Giriş yap" onPress={() => nav.navigate('Auth')} />
      ) : null}
      {events.length ? (
        events.map((event) => (
          <View key={event.id} style={{ gap: 9 }}>
            <FeedingCard
              event={event}
              onPark={() => nav.navigate('Park', { id: event.park_id })}
              onReport={() =>
                app.viewer ? nav.navigate('Report', { feedingId: event.id }) : nav.navigate('Auth')
              }
              onDelete={mine ? () => setConfirm(event.id) : undefined}
            />
            {confirm === event.id ? (
              <>
                <Notice text="Bu kaydı ortak geçmişten kaldırmak istiyor musun?" />
                <Button
                  label="Evet, kaydı kaldır"
                  destructive
                  onPress={() => void remove(event.id)}
                />
                <Button label="Vazgeç" secondary onPress={() => setConfirm(undefined)} />
              </>
            ) : null}
          </View>
        ))
      ) : (
        <Empty
          title={loading ? 'Kayıtlar yükleniyor' : 'Henüz bir iz yok'}
          detail="Bir parkta mama veya su bıraktığında paylaşımını buradan görebilirsin."
        />
      )}
      {hasMore && events.length ? (
        <Button
          label="Daha eski kayıtlar"
          secondary
          loading={loading}
          onPress={() => void load(true)}
        />
      ) : null}
    </ScrollView>
  );
}
export function MyHistoryScreen() {
  return <HistoryScreen mine />;
}
export function FavoritesScreen() {
  const app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>(),
    [parks, setParks] = useState<Park[]>([]),
    [error, setError] = useState('');
  useFocusEffect(
    useCallback(() => {
      void Promise.all(app.favorites.map(app.getPark))
        .then((ps) => setParks(ps.filter((p): p is Park => p !== null)))
        .catch(() => setError('Takip edilen parklar yüklenemedi.'));
    }, [app.favorites]),
  );
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={t.title}>Takip ettiğim parklar</Text>
      <Text style={t.body}>Tekrar uğramak istediğin parklar bir arada.</Text>
      {error ? <Notice error text={error} /> : null}
      {parks.length ? (
        parks.map((p) => (
          <ParkCard key={p.id} park={p} onPress={() => nav.navigate('Park', { id: p.id })} />
        ))
      ) : (
        <Empty
          title="Kalbine yakın parklar"
          detail="Park ayrıntısındaki kalbe dokunarak buraya ekleyebilirsin."
          icon="heart-outline"
        />
      )}
    </ScrollView>
  );
}
export function OutboxScreen() {
  const app = useApp(),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState<string>();
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={t.title}>Bekleyen kayıtlar</Text>
      <Text style={t.body}>
        Bu cihazdaki kayıtlar, ait oldukları hesabın oturumu açıkken gönderilir.
      </Text>
      {!app.online ? <Notice text="Çevrimdışısın. Kayıtların bu cihazda güvende." /> : null}
      {error ? <Notice error text={error} /> : null}
      {app.queue.length ? (
        <>
          <Button
            label="Gönderimi tekrar dene"
            loading={app.syncing}
            disabled={!app.online}
            onPress={() => void app.sync()}
          />
          {app.queue.map((item) => (
            <View key={item.id} style={s.pending}>
              <Text style={t.h2}>{item.park_name}</Text>
              <Text style={t.body}>
                {item.food_grams} g mama · {item.water_ml} ml su
              </Text>
              <Text style={s.pendingState}>
                {item.status === 'error' ? 'Gönderilemedi' : 'Gönderilmeyi bekliyor'}
              </Text>
              {item.error ? <Notice text={item.error} error /> : null}
              {confirm === item.id ? (
                <>
                  <Notice text="Henüz gönderilmemiş bu kayıt ve cihazdaki fotoğrafı silinecek." />
                  <Button
                    label="Kaydı sil"
                    destructive
                    disabled={app.syncing}
                    onPress={() =>
                      void app.discard(item.id).catch(() => setError('Kayıt silinemedi.'))
                    }
                  />
                  <Button secondary label="Vazgeç" onPress={() => setConfirm(undefined)} />
                </>
              ) : (
                <Button
                  secondary
                  label="Kaydı iptal et"
                  disabled={app.syncing}
                  onPress={() => setConfirm(item.id)}
                />
              )}
            </View>
          ))}
        </>
      ) : (
        <Empty
          title="Her şey güncel"
          detail="Bu hesap için gönderilmeyi bekleyen besleme kaydı yok."
          icon="checkmark-circle-outline"
        />
      )}
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 24,
    gap: 18,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: 40,
  },
  pending: {
    padding: 20,
    backgroundColor: C.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.line,
    gap: 12,
  },
  pendingState: { fontSize: 12, fontWeight: '600', color: C.amber },
});
