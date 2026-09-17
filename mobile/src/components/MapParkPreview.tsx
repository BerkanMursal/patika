import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { parkStatus, timeAgo } from '../core/domain';
import type { Park } from '../core/types';
import { Icon } from '../ui/common';
import { C, shadow } from '../ui/theme';
import { parkPlace } from '../core/park-names';

export function MapParkPreview({
  park,
  onOpen,
  onClose,
}: {
  park: Park;
  onOpen: () => void;
  onClose: () => void;
}) {
  const status = parkStatus(park);
  return (
    <View style={s.card}>
      <View style={s.header}>
        <View style={[s.symbol, { backgroundColor: status.tint }]}>
          <Icon name="leaf-outline" size={22} color={status.color} />
        </View>
        <View style={s.heading}>
          <Text numberOfLines={1} style={s.name}>
            {park.name}
          </Text>
          <Text numberOfLines={1} style={s.place}>
            {parkPlace(park)}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Park seçimini kapat"
          onPress={onClose}
          style={s.close}
        >
          <Icon name="close" size={19} color={C.muted} />
        </Pressable>
      </View>
      <View style={s.stats}>
        <View style={s.stat}>
          <View style={s.captionRow}>
            <Icon name="restaurant-outline" size={13} />
            <Text style={s.caption}>SON MAMA KAYDI</Text>
          </View>
          <Text style={s.value}>
            {timeAgo(park.last_fed_at)}
            {park.last_grams ? ` · ${park.last_grams} g` : ''}
          </Text>
        </View>
        <View style={[s.stat, s.water]}>
          <View style={s.captionRow}>
            <Icon name="water-outline" size={13} color={C.blue} />
            <Text style={s.caption}>SON SU KAYDI</Text>
          </View>
          <Text style={s.value}>{timeAgo(park.last_water_at)}</Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${park.name} parkını incele`}
        onPress={onOpen}
        style={({ pressed }) => [s.open, pressed && { opacity: 0.85 }]}
      >
        <Text style={s.openText}>Parkı incele</Text>
        <Icon name="arrow-forward" size={17} color={C.white} />
      </Pressable>
    </View>
  );
}
const s = StyleSheet.create({
  card: {
    position: 'absolute',
    bottom: 30,
    left: 14,
    right: 14,
    maxWidth: 390,
    borderRadius: 21,
    padding: 14,
    gap: 12,
    backgroundColor: C.white,
    borderWidth: 1,
    borderColor: '#e3e9dc',
    ...shadow,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  symbol: {
    width: 41,
    height: 41,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heading: { flex: 1, minWidth: 0, gap: 4 },
  name: { fontSize: 15, fontWeight: '700', color: C.ink },
  place: { fontSize: 11, color: C.muted },
  close: { width: 36, height: 40, alignItems: 'center', justifyContent: 'center' },
  stats: {
    flexDirection: 'row',
    backgroundColor: '#f5f7f1',
    borderRadius: 12,
    padding: 12,
    gap: 10,
  },
  stat: { flex: 1, gap: 6 },
  water: { paddingLeft: 12, borderLeftWidth: 1, borderLeftColor: '#e0e6d9' },
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  caption: { fontSize: 8, fontWeight: '600', letterSpacing: 0.7, color: '#718273' },
  value: { fontSize: 11, fontWeight: '600', color: C.ink },
  open: {
    minHeight: 42,
    borderRadius: 12,
    backgroundColor: C.green,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
  },
  openText: { fontSize: 12, fontWeight: '600', color: C.white },
});
