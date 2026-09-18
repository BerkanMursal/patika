import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getDeviceLocation } from '../services/location';
import { locationFailureMessage } from '../services/location-common';
import { getRescueCases } from '../services/repository';
import type { RootStack } from '../navigation';
import type { RescueCaseStatus } from '../core/types';
import { useApp } from '../state/AppProvider';
import { C, shadow } from '../ui/theme';
import { Button, Chip, Empty, Icon, IconButton, Notice, textStyles as t } from '../ui/common';
import { distanceKm, normalizeSearch, parkStatus } from '../core/domain';
import { ParkCard } from '../components/ParkCard';
import ParkMap from '../components/ParkMap';
import { MapParkPreview } from '../components/MapParkPreview';
type RescueMarkerRow = { id: string; latitude: number; longitude: number; status: RescueCaseStatus };

export function ExploreScreen() {
  const app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>(),
    { width } = useWindowDimensions();
  const [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [locating, setLocating] = useState(false),
    [message, setMessage] = useState(''),
    [location, setLocation] = useState<{ latitude: number; longitude: number }>(),
    [selected, setSelected] = useState<string>();
  const [visibleCount, setVisibleCount] = useState(24);
  const [rescueCases, setRescueCases] = useState<RescueMarkerRow[]>([]);
  const locationRequest = useRef(0);
  const locationBusy = useRef(false);
  useEffect(
    () => () => {
      locationRequest.current += 1;
    },
    [],
  );
  useEffect(() => setSelected(undefined), [query, filter]);
  useEffect(() => setVisibleCount(24), [query, filter, app.region]);
  useFocusEffect(
    useCallback(() => {
      const timer = setTimeout(() => void app.refresh(query), 450);
      return () => clearTimeout(timer);
    }, [query, app.region]),
  );
  // Rescue markers are a best-effort overlay on top of the park map: an
  // unauthenticated/demo viewer must never keep stale markers from a prior
  // session, and this runs regardless of screen focus so a logout that
  // happens while Explore is the background tab still clears immediately.
  useEffect(() => {
    if (!app.viewer || app.demo) setRescueCases([]);
  }, [app.viewer?.id, app.demo]);
  // The actual fetch, separate from the clear above: re-runs on focus (e.g.
  // coming back from RescueCaseScreen after a claim/status change) so the
  // map reflects the latest server state without a full app restart.
  useFocusEffect(
    useCallback(() => {
      if (!app.viewer || app.demo) return;
      let cancelled = false;
      getRescueCases()
        .then((rows) => {
          if (!cancelled) setRescueCases(rows);
        })
        .catch(() => {
          // A failed fetch must never error out the park map/list — rescue
          // markers are supplementary. Whatever was last loaded is kept.
        });
      return () => {
        cancelled = true;
      };
    }, [app.viewer?.id, app.demo]),
  );
  const filtered = useMemo(
    () =>
      app.parks
        .filter(
          (p) =>
            (query.length >= 2 ||
              (Math.abs(p.latitude - app.region.latitude) <= app.region.latitudeDelta / 2 &&
                Math.abs(p.longitude - app.region.longitude) <= app.region.longitudeDelta / 2)) &&
            (!query ||
              normalizeSearch(
                `${p.name} ${p.city} ${p.district} ${p.address_label ?? ''}`,
              ).includes(normalizeSearch(query))) &&
            (filter === 'all' ||
              (filter === 'water' && (!p.last_water_at || p.water_status === 'empty')) ||
              (filter === 'favorites' && app.favorites.includes(p.id)) ||
              (filter === 'check' && ['old', 'unknown', 'check'].includes(parkStatus(p).key))),
        )
        .sort(
          (a, b) =>
            distanceKm(
              location?.latitude ?? app.region.latitude,
              location?.longitude ?? app.region.longitude,
              a.latitude,
              a.longitude,
            ) -
            distanceKm(
              location?.latitude ?? app.region.latitude,
              location?.longitude ?? app.region.longitude,
              b.latitude,
              b.longitude,
            ),
        )
        .slice(0, 200),
    [app.parks, query, filter, app.favorites, location, app.region],
  );
  async function locate() {
    if (locationBusy.current) return;
    locationBusy.current = true;
    const request = ++locationRequest.current;
    setLocating(true);
    setMessage('');
    try {
      const coords = await getDeviceLocation();
      if (request !== locationRequest.current) return;
      setQuery('');
      setFilter('all');
      setSelected(undefined);
      const point = { latitude: coords.latitude, longitude: coords.longitude };
      setLocation(point);
      app.setRegion({ ...point, latitudeDelta: 0.018, longitudeDelta: 0.028 });
    } catch (e) {
      if (request === locationRequest.current)
        setMessage(locationFailureMessage(e, Platform.OS === 'web'));
    } finally {
      if (request === locationRequest.current) {
        locationBusy.current = false;
        setLocating(false);
      }
    }
  }
  const chosen = filtered.find((p) => p.id === selected);
  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.content}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={app.loading}
          onRefresh={() => void app.refresh(query)}
          tintColor={C.green}
        />
      }
    >
      <View style={s.header}>
        <View style={s.brand}>
          <View style={s.brandMark}>
            <Icon name="paw" size={23} color={C.lime} />
          </View>
          <Text style={s.brandName}>
            patika<Text style={{ color: '#9BBB78' }}>.</Text>
          </Text>
        </View>
        <View style={s.headerRight}>
          <View style={s.local}>
            <View style={s.onlineDot} />
            <Text style={s.localText}>{app.demo ? 'Demo keşfi' : 'Birlikte daha iyi'}</Text>
          </View>
          <IconButton
            name="person-outline"
            label="Profilim"
            onPress={() => nav.navigate(app.viewer ? 'MyHistory' : 'Auth')}
          />
        </View>
      </View>
      <View style={s.heading}>
        <View style={{ gap: 8 }}>
          <Text style={t.eyebrow}>KÜÇÜK BİR İYİLİK, BÜYÜK BİR FARK</Text>
          <Text style={[t.title, width > 800 && { fontSize: 34 }]}>Bir kap, bir umut.</Text>
          <Text style={t.body}>Yakınındaki dostlarımız için bugün bir iz bırak.</Text>
        </View>
        {width > 800 ? (
          <View style={s.intro}>
            <Icon name="heart-outline" size={23} />
            <Text style={s.introText}>İyilik, paylaştıkça çoğalır.</Text>
          </View>
        ) : null}
      </View>
      {app.error || message ? <Notice text={message || app.error} error /> : null}
      <View style={s.mapBox}>
        <View style={[s.mapCanvas, { height: width > 800 ? 510 : 450 }]}>
          <ParkMap
            parks={filtered}
            rescueCases={rescueCases}
            region={app.region}
            selected={selected}
            userLocation={location}
            onMove={app.setRegion}
            onSelect={setSelected}
            onSelectRescue={(id) => nav.navigate('RescueCase', { id })}
          />
          <View style={s.searchOverlay}>
            <View style={s.search}>
              <Icon name="search-outline" size={20} color={C.muted} />
              <TextInput
                accessibilityLabel="Park veya şehir ara"
                value={query}
                onChangeText={setQuery}
                returnKeyType="search"
                onSubmitEditing={() => {
                  const p = filtered[0];
                  if (p)
                    app.setRegion({
                      latitude: p.latitude,
                      longitude: p.longitude,
                      latitudeDelta: 0.018,
                      longitudeDelta: 0.028,
                    });
                }}
                placeholder="Park, ilçe veya şehir ara"
                placeholderTextColor="#9CA79D"
                style={s.searchInput}
              />
              {query ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Aramayı temizle"
                  onPress={() => setQuery('')}
                >
                  <Icon name="close-circle" color={C.muted} size={18} />
                </Pressable>
              ) : null}
              {app.loading ? <ActivityIndicator size="small" color={C.green} /> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Konumumu bul"
              accessibilityState={{ disabled: locating, busy: locating }}
              disabled={locating}
              onPress={() => void locate()}
              style={s.locate}
            >
              {locating ? (
                <ActivityIndicator color={C.green} />
              ) : (
                <Icon name="locate-outline" size={23} />
              )}
            </Pressable>
          </View>
          {!chosen ? (
            <View pointerEvents="none" style={s.mapCount}>
              <View style={s.countDot} />
              <Text style={s.countText}>
                {filtered.length === 200 ? '200' : filtered.length} park
              </Text>
              <Text style={s.countCaption}>{query ? 'arama sonucunda' : 'bu görünümde'}</Text>
            </View>
          ) : null}
          {chosen ? (
            <MapParkPreview
              park={chosen}
              onOpen={() => nav.navigate('Park', { id: chosen.id })}
              onClose={() => setSelected(undefined)}
            />
          ) : (
            <View pointerEvents="none" style={s.mapHint}>
              <Icon name="paw-outline" size={15} color={C.green} />
              <Text style={s.hintText}>Bir parka dokun, bir iz bırak.</Text>
            </View>
          )}
        </View>
        <View style={s.mapLegend}>
          <View style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: '#2D7660' }]} />
            <Text style={s.legendText}>Yakın kayıt</Text>
          </View>
          <View style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: C.amber }]} />
            <Text style={s.legendText}>Kontrol edilebilir</Text>
          </View>
          <View style={s.legendItem}>
            <View style={[s.legendDot, { backgroundColor: '#7B8790' }]} />
            <Text style={s.legendText}>Kayıt yok</Text>
          </View>
        </View>
      </View>
      <View style={s.sectionHeader}>
        <View>
          <Text style={t.h2}>{query ? 'Arama sonuçları' : 'Parkları keşfet'}</Text>
          <Text style={s.sectionDetail}>
            {filtered.length === 200 ? 'İlk 200' : filtered.length} park ·{' '}
            {location ? 'Konumuna göre sıralandı' : 'Harita çevresine göre sıralandı'}
          </Text>
        </View>
        <Icon name="options-outline" color={C.muted} />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.filters}
      >
        <Chip
          label="Tüm parklar"
          active={filter === 'all'}
          onPress={() => setFilter('all')}
          icon="grid-outline"
        />
        <Chip
          label="Kontrol edilebilir"
          active={filter === 'check'}
          onPress={() => setFilter('check')}
          icon="time-outline"
        />
        <Chip
          label="Su durumuna bak"
          active={filter === 'water'}
          onPress={() => setFilter('water')}
          icon="water-outline"
        />
        <Chip
          label="Takip ettiklerim"
          active={filter === 'favorites'}
          onPress={() => setFilter('favorites')}
          icon="heart-outline"
        />
      </ScrollView>
      {!filtered.length ? (
        <Empty
          title={app.loading ? 'Parklar yükleniyor' : 'Bu aralıkta park bulunamadı'}
          detail="Başka bir park veya şehir arayın, haritayı kaydırın ya da filtreyi değiştirin."
        />
      ) : (
        <View style={s.grid}>
          {filtered.slice(0, visibleCount).map((park) => (
            <View
              key={park.id}
              style={{ width: width > 1000 ? '32.4%' : width > 660 ? '49.2%' : '100%' }}
            >
              <ParkCard
                park={park}
                location={location}
                onPress={() => nav.navigate('Park', { id: park.id })}
              />
            </View>
          ))}
        </View>
      )}
      {filtered.length > visibleCount ? (
        <Button
          secondary
          label="Daha fazla park göster"
          onPress={() => setVisibleCount((n) => n + 24)}
        />
      ) : null}
      <View style={s.note}>
        <Icon name="information-circle-outline" size={17} color={C.muted} />
        <Text style={s.noteText}>
          Kayıt tarihi, hayvanların en son beslendiği kesin tarih değildir. Sahadaki mama ve su
          durumunu kontrol edin.
        </Text>
      </View>
      <View style={s.footer}>
        <Icon name="paw-outline" size={16} color="#A5B294" />
        <Text style={s.footerText}>Her patinin bir hikâyesi, her iyiliğin bir izi var.</Text>
      </View>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 20,
    paddingTop: 14,
    gap: 20,
    maxWidth: 1260,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: 25,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 6,
  },
  brand: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  brandMark: {
    height: 37,
    width: 37,
    borderRadius: 13,
    backgroundColor: C.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandName: { fontSize: 29, fontWeight: '800', color: C.ink, letterSpacing: -1.7 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  local: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  onlineDot: { width: 5, height: 5, borderRadius: 4, backgroundColor: '#8DA579' },
  localText: { fontSize: 10, color: C.muted },
  heading: {
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 20,
  },
  intro: { flexDirection: 'row', gap: 9, alignItems: 'center' },
  introText: { color: C.green, fontSize: 13 },
  mapBox: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#DDE6D9',
    backgroundColor: '#E7EEDD',
  },
  mapCanvas: { position: 'relative', overflow: 'hidden' },
  searchOverlay: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    gap: 9,
    maxWidth: 560,
  },
  search: {
    minHeight: 49,
    flex: 1,
    borderRadius: 14,
    backgroundColor: C.white,
    alignItems: 'center',
    flexDirection: 'row',
    gap: 9,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e5eadd',
    ...shadow,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    color: C.ink,
    height: 49,
    outlineWidth: 0,
  } as any,
  locate: {
    width: 44,
    height: 49,
    borderRadius: 14,
    backgroundColor: C.white,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow,
  },
  mapLegend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
    backgroundColor: '#fbfcf7',
    paddingHorizontal: 17,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#e5ebdf',
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendText: { fontSize: 10, color: '#617364' },
  legendDot: { width: 7, height: 7, borderRadius: 5 },
  mapCount: {
    position: 'absolute',
    top: 77,
    left: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fffffff0',
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 11,
  },
  countDot: { width: 6, height: 6, borderRadius: 4, backgroundColor: '#6e9761' },
  countText: { fontSize: 11, fontWeight: '700', color: C.green },
  countCaption: { fontSize: 10, color: '#7e8b7e' },
  mapHint: {
    position: 'absolute',
    bottom: 30,
    left: 14,
    backgroundColor: '#fffffff0',
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  hintText: { fontSize: 10, color: '#536f58' },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 8,
  },
  sectionDetail: { fontSize: 12, color: C.muted, marginTop: 7 },
  filters: { gap: 8, paddingBottom: 2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 13 },
  note: { flexDirection: 'row', gap: 7, alignItems: 'flex-start', paddingHorizontal: 2 },
  noteText: { flex: 1, fontSize: 12, color: C.muted, lineHeight: 19 },
  footer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    flexDirection: 'row',
    padding: 15,
  },
  footerText: { fontSize: 10, color: '#9BA791' },
});
