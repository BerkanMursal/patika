import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Park } from '../core/types';
import { distanceKm, distanceLabel, parkStatus, timeAgo } from '../core/domain';
import { C } from '../ui/theme';
import { Icon } from '../ui/common';
import { parkPlace } from '../core/park-names';
export function ParkCard({
  park,
  onPress,
  location,
  compact = false,
}: {
  park: Park;
  onPress: () => void;
  location?: { latitude: number; longitude: number };
  compact?: boolean;
}) {
  const status = parkStatus(park);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${park.name}, ${status.label}, ayrıntıları aç`}
      onPress={onPress}
      style={({ pressed }) => [s.card, compact && { padding: 17 }, pressed && { opacity: 0.8 }]}
    >
      <View style={s.top}>
        <View style={[s.parkIcon, { backgroundColor: status.tint }]}>
          <Icon name="leaf-outline" size={25} color={status.color} />
        </View>
        <View style={{ flex: 1, gap: 5 }}>
          <Text numberOfLines={1} style={s.name}>
            {park.name}
          </Text>
          <Text numberOfLines={2} style={s.place}>
            {parkPlace(park)}
          </Text>
        </View>
        <Icon name="chevron-forward" color="#B0BAB0" size={18} />
      </View>
      <View style={s.divider} />
      <View style={s.stats}>
        <View style={{ gap: 5, flex: 1 }}>
          <Text style={s.caption}>SON MAMA KAYDI</Text>
          <Text style={s.value}>
            {timeAgo(park.last_fed_at)}
            {park.last_grams ? ` · ${park.last_grams} g` : ''}
          </Text>
        </View>
        <View style={s.water}>
          <Icon name="water-outline" size={17} color={C.blue} />
          <Text style={s.waterText}>
            {park.last_water_at ? timeAgo(park.last_water_at) : 'Su kaydı yok'}
          </Text>
        </View>
      </View>
      <View style={s.bottom}>
        <View style={[s.badge, { backgroundColor: status.tint }]}>
          <View style={[s.dot, { backgroundColor: status.color }]} />
          <Text style={[s.badgeText, { color: status.color }]}>{status.label}</Text>
        </View>
        {location ? (
          <Text style={s.distance}>
            {distanceLabel(
              distanceKm(location.latitude, location.longitude, park.latitude, park.longitude),
            )}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
const s = StyleSheet.create({
  card: {
    padding: 21,
    backgroundColor: C.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.line,
    gap: 15,
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  parkIcon: {
    width: 47,
    height: 47,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { fontSize: 16, fontWeight: '700', letterSpacing: -0.3, color: C.ink },
  place: { fontSize: 12, color: C.muted },
  divider: { height: 1, backgroundColor: C.line },
  stats: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  caption: { fontSize: 9, letterSpacing: 1.3, fontWeight: '600', color: '#A0AAA2' },
  value: { fontSize: 12, fontWeight: '600', color: C.ink },
  water: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  waterText: { fontSize: 10, color: C.muted },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 5 },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 6,
  },
  badgeText: { fontSize: 10, fontWeight: '500' },
  dot: { width: 4, height: 4, borderRadius: 4 },
  distance: { fontSize: 11, color: C.muted },
});
