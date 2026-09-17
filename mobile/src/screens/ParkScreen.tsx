import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import type { Feeding, Park, Point } from '../core/types';
import { useApp } from '../state/AppProvider';
import { bowlNames, parkStatus, timeAgo } from '../core/domain';
import { Button, Card, Empty, Icon, IconButton, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { FeedingCard } from '../components/FeedingCard';
import * as api from '../services/repository';
import { parkPlace } from '../core/park-names';
export function ParkScreen() {
  const {
      params: { id },
    } = useRoute<RouteProp<RootStack, 'Park'>>(),
    app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const [park, setPark] = useState<Park | null>(null),
    [events, setEvents] = useState<Feeding[]>([]),
    [points, setPoints] = useState<Point[]>([]),
    [loading, setLoading] = useState(true),
    [hasMore, setHasMore] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [error, setError] = useState('');
  async function load() {
    setLoading(true);
    try {
      const [p, e, pts] = await Promise.all([
        app.getPark(id),
        app.getEvents(id),
        app.getPoints(id),
      ]);
      setPark(p);
      setEvents(e);
      setHasMore(e.length === 30);
      setPoints(pts);
      setError('');
    } catch {
      setError('Park geçmişi yüklenemedi. Yenilemek için aşağı çekin.');
    } finally {
      setLoading(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [id, app.viewer?.id]),
  );
  useEffect(() => {
    const p = app.parks.find((p) => p.id === id);
    if (p) setPark(p);
  }, [app.parks, id]);
  if (loading && !park)
    return (
      <View style={s.loading}>
        <ActivityIndicator color={C.green} />
        {error ? <Notice error text={error} /> : null}
      </View>
    );
  if (!park)
    return (
      <Empty
        title="Park bulunamadı"
        detail="Park kaldırılmış veya bağlantı geçici olarak kesilmiş olabilir."
      />
    );
  const status = parkStatus(park),
    fresh = !!park.observed_at && Date.now() - Date.parse(park.observed_at) < 86400000;
  async function follow() {
    try {
      if (!app.viewer) {
        nav.navigate('Auth');
        return;
      }
      await app.toggleFavorite(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Takip kaydedilemedi.');
    }
  }
  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void load()} />}
    >
      <View style={s.hero}>
        <View style={s.heroTop}>
          <View style={s.parkIcon}>
            <Icon name="leaf-outline" size={35} />
          </View>
          <IconButton
            name={app.favorites.includes(id) ? 'heart' : 'heart-outline'}
            active={app.favorites.includes(id)}
            label="Parkı takip et veya takibi bırak"
            onPress={() => void follow()}
          />
        </View>
        <Text style={t.eyebrow}>
          {[park.city, park.district].filter(Boolean).join(' / ').toLocaleUpperCase('tr')}
        </Text>
        <Text style={t.title}>{park.name}</Text>
        <View style={[s.badge, { backgroundColor: status.tint }]}>
          <View style={[s.dot, { backgroundColor: status.color }]} />
          <Text style={{ fontSize: 12, color: status.color, fontWeight: '500' }}>
            {status.label}
          </Text>
        </View>
      </View>
      {error ? <Notice text={error} error /> : null}
      <Card style={{ gap: 12 }}>
        <Text style={t.h2}>
          {park.name_status === 'missing' ? 'Bu parkın adını biliyor musun?' : 'Park bilgisi'}
        </Text>
        <Text style={t.body}>{parkPlace(park)}</Text>
        <Text style={t.body}>
          {park.name_status === 'missing'
            ? 'Kaynakta ad bilgisi yok. Kısa kod bu parkı diğerlerinden ayırt etmen içindir.'
            : `Ad kaynağı: ${park.name_source || 'OpenStreetMap'}`}
        </Text>
        {park.name_source_url && /^https:\/\//.test(park.name_source_url) ? (
          <Button
            secondary
            label="Kaynak kaydını aç"
            icon="open-outline"
            onPress={() => void Linking.openURL(park.name_source_url!)}
          />
        ) : null}
        <Button
          secondary
          label={park.name_status === 'missing' ? 'Park adı öner' : 'Ad düzeltmesi öner'}
          icon="create-outline"
          onPress={() => nav.navigate('SuggestName', { id })}
        />
      </Card>
      <View style={s.stats}>
        <Card style={{ flex: 1, gap: 9 }}>
          <Icon name="nutrition-outline" />
          <Text style={s.statLabel}>Son mama kaydı</Text>
          <Text style={s.statValue}>{timeAgo(park.last_fed_at)}</Text>
          <Text style={s.statNote}>
            {park.last_grams ? `Yaklaşık ${park.last_grams} gram` : 'Miktar bilgisi yok'}
          </Text>
        </Card>
        <Card style={{ flex: 1, gap: 9 }}>
          <Icon name="water-outline" color={C.blue} />
          <Text style={s.statLabel}>Son su kaydı</Text>
          <Text style={s.statValue}>{timeAgo(park.last_water_at)}</Text>
          <Text style={s.statNote}>Bırakılan suya ait kayıt</Text>
        </Card>
      </View>
      <Notice text="Son kayıt, mevcut mama ve su miktarını göstermez. Gittiğinizde kapları ve çevreyi kontrol edin." />
      <View style={{ gap: 10 }}>
        <Button
          label="Mama / su bıraktım"
          icon="add-circle-outline"
          onPress={() => (app.viewer ? nav.navigate('Record', { id }) : nav.navigate('Auth'))}
        />
        <View style={s.actions}>
          <View style={{ flex: 1 }}>
            <Button
              secondary
              label="Durumu bildir"
              icon="eye-outline"
              onPress={() => (app.viewer ? nav.navigate('Observe', { id }) : nav.navigate('Auth'))}
            />
          </View>
          <IconButton
            name="navigate-outline"
            label="Parka yol tarifi aç"
            onPress={() =>
              void Linking.openURL(
                `https://www.google.com/maps/dir/?api=1&destination=${park.latitude},${park.longitude}`,
              )
            }
          />
        </View>
      </View>
      <Card style={{ gap: 12 }}>
        <Text style={t.h2}>Son gözlem</Text>
        <Text style={t.body}>
          {park.observed_at
            ? `${timeAgo(park.observed_at)} bildirildi${fresh ? '' : ' · Güncelliğini kontrol edin'}`
            : 'Henüz durum gözlemi paylaşılmadı.'}
        </Text>
        <View style={s.actions}>
          <View style={s.bowl}>
            <Icon name="nutrition-outline" size={18} />
            <Text style={s.bowlText}>
              Mama: {fresh ? bowlNames[park.food_status] : 'Bilinmiyor'}
            </Text>
          </View>
          <View style={s.bowl}>
            <Icon name="water-outline" size={18} color={C.blue} />
            <Text style={s.bowlText}>
              Su: {fresh ? bowlNames[park.water_status] : 'Bilinmiyor'}
            </Text>
          </View>
        </View>
      </Card>
      {points.length ? (
        <View style={{ gap: 8 }}>
          <Text style={s.sectionEyebrow}>BESLEME NOKTALARI</Text>
          {points.map((p) => (
            <Text key={p.id} style={t.body}>
              ⌖ {p.name}
            </Text>
          ))}
        </View>
      ) : null}
      <Text style={t.h2}>İyilik geçmişi</Text>
      {events.length ? (
        events.map((event) => (
          <FeedingCard
            key={event.id}
            event={event}
            onReport={() =>
              app.viewer ? nav.navigate('Report', { feedingId: event.id }) : nav.navigate('Auth')
            }
            onBlock={
              app.viewer && event.user_id !== app.viewer.id
                ? () => {
                    if (app.demo)
                      setEvents((all) => all.filter((e) => e.user_id !== event.user_id));
                    else
                      void api
                        .blockUser(event.user_id)
                        .then(() => load())
                        .catch(() => setError('Kullanıcı gizlenemedi.'));
                  }
                : undefined
            }
          />
        ))
      ) : (
        <Empty
          title="İlk izi sen bırak"
          detail="Bu park için henüz besleme kaydı bulunmuyor. Burada besleme yaptıysan kaydını paylaşabilirsin."
        />
      )}
      {hasMore ? (
        <Button
          secondary
          label="Daha eski kayıtlar"
          loading={loadingMore}
          onPress={() => {
            setLoadingMore(true);
            void app
              .getEvents(
                id,
                false,
                [events[events.length - 1].occurred_at, events[events.length - 1].id].join('|'),
              )
              .then((more) => {
                setEvents((all) => [...all, ...more]);
                setHasMore(more.length === 30);
              })
              .catch(() => setError('Eski kayıtlar yüklenemedi.'))
              .finally(() => setLoadingMore(false));
          }}
        />
      ) : null}
      <Button
        secondary
        label="Park bilgisinde hata bildir"
        icon="flag-outline"
        onPress={() => (app.viewer ? nav.navigate('Report', { parkId: id }) : nav.navigate('Auth'))}
      />
      <Text style={s.source}>
        Park verisi: OpenStreetMap katkıcıları · ODbL. Türkiye genelindeki kapsam kaynak veriye
        bağlıdır.
      </Text>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 22,
    gap: 20,
    maxWidth: 760,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: 40,
  },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  hero: { gap: 14, paddingBottom: 4 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  parkIcon: {
    height: 75,
    width: 75,
    borderRadius: 27,
    backgroundColor: '#E8EFDE',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    alignSelf: 'flex-start',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 6,
    alignItems: 'center',
    padding: 8,
  },
  dot: { width: 5, height: 5, borderRadius: 5 },
  stats: { flexDirection: 'row', gap: 12 },
  statLabel: { fontSize: 11, color: C.muted },
  statValue: { fontWeight: '700', fontSize: 15, color: C.ink },
  statNote: { fontSize: 10, color: C.muted },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  bowl: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center' },
  bowlText: { fontSize: 12, color: C.ink },
  sectionEyebrow: { fontSize: 10, letterSpacing: 1.5, fontWeight: '700', color: C.muted },
  source: { fontSize: 11, lineHeight: 18, color: C.muted },
});
