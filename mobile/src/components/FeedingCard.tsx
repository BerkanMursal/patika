import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Feeding } from '../core/types';
import { foodNames, timeAgo } from '../core/domain';
import { C } from '../ui/theme';
import { Icon } from '../ui/common';
export function FeedingCard({
  event,
  onPark,
  onReport,
  onDelete,
  onBlock,
}: {
  event: Feeding;
  onPark?: () => void;
  onReport?: () => void;
  onDelete?: () => void;
  onBlock?: () => void;
}) {
  return (
    <View style={s.card}>
      <View style={s.header}>
        <View style={s.avatar}>
          <Text style={s.initial}>{event.author_name.slice(0, 1).toLocaleUpperCase('tr')}</Text>
        </View>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.name}>{event.author_name}</Text>
          <Text style={s.time}>{timeAgo(event.occurred_at)}</Text>
        </View>
        {onReport ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Kaydı bildir"
            onPress={onReport}
            style={{ padding: 10 }}
          >
            <Icon name="flag-outline" size={18} color={C.muted} />
          </Pressable>
        ) : null}
      </View>
      <Pressable disabled={!onPark} onPress={onPark}>
        <Text style={s.park}>
          {event.park_name} {onPark ? '↗' : ''}
        </Text>
      </Pressable>
      {event.photo_url ? (
        <Image
          source={{ uri: event.photo_url }}
          style={s.photo}
          accessibilityLabel="Kullanıcının eklediği besleme fotoğrafı"
          resizeMode="cover"
        />
      ) : null}
      <View style={s.amounts}>
        {event.food_grams > 0 ? (
          <View style={s.amount}>
            <Icon name="nutrition-outline" size={18} />
            <Text style={s.amountText}>
              {event.food_grams} g {foodNames[event.food_type].toLocaleLowerCase('tr')}
            </Text>
          </View>
        ) : null}
        {event.water_ml > 0 ? (
          <View style={s.amount}>
            <Icon name="water-outline" size={18} color={C.blue} />
            <Text style={s.amountText}>{event.water_ml} ml su</Text>
          </View>
        ) : null}
      </View>
      {event.note ? <Text style={s.note}>{event.note}</Text> : null}
      <View style={s.bottom}>
        <Text style={s.disclaimer}>Miktar, paylaşan kişinin beyanıdır.</Text>
        {onDelete ? (
          <Pressable onPress={onDelete} accessibilityRole="button">
            <Text style={s.action}>Kaydı kaldır</Text>
          </Pressable>
        ) : onBlock ? (
          <Pressable onPress={onBlock} accessibilityRole="button">
            <Text style={s.action}>Gizle</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  card: {
    backgroundColor: C.white,
    padding: 20,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.line,
    gap: 14,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 37,
    height: 37,
    borderRadius: 14,
    backgroundColor: C.soft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initial: { fontSize: 16, fontWeight: '600', color: C.green },
  name: { fontSize: 14, fontWeight: '600', color: C.ink },
  time: { fontSize: 11, color: C.muted },
  park: { fontWeight: '600', fontSize: 15, color: C.green },
  photo: { height: 200, width: '100%', borderRadius: 14, backgroundColor: C.soft },
  amounts: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  amount: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  amountText: { fontSize: 13, color: C.ink, fontWeight: '500' },
  note: { fontSize: 14, lineHeight: 22, color: C.muted },
  bottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  disclaimer: { fontSize: 10, color: '#A2ADA2', flex: 1 },
  action: { fontSize: 11, color: C.muted, paddingVertical: 5 },
});
