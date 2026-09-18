import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStack } from '../navigation';
import type { RescueCase } from '../core/types';
import { useApp } from '../state/AppProvider';
import { canClaimRescueCase, rescueCaseStatusNames, timeAgo } from '../core/domain';
import { Button, Card, Empty, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { claimRescueCase, getRescueCase } from '../services/repository';
export function RescueCaseScreen() {
  const {
      params: { id },
    } = useRoute<RouteProp<RootStack, 'RescueCase'>>(),
    app = useApp();
  const [rescueCase, setRescueCase] = useState<RescueCase | null>(null),
    [loading, setLoading] = useState(true),
    // Distinguishes "server error, retry" from "confirmed not found" — a
    // maybeSingle() null must never be shown as a generic load failure.
    [loadError, setLoadError] = useState(false),
    [claiming, setClaiming] = useState(false),
    [claimError, setClaimError] = useState('');
  async function load() {
    setLoading(true);
    setLoadError(false);
    try {
      setRescueCase(await getRescueCase(id));
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [id]),
  );
  async function claim() {
    setClaiming(true);
    setClaimError('');
    try {
      await claimRescueCase(id);
      await load();
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : 'Vaka üstlenilemedi. Lütfen tekrar deneyin.');
    } finally {
      setClaiming(false);
    }
  }
  if (loading)
    return (
      <View style={[s.page, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={C.green} />
      </View>
    );
  if (loadError)
    return (
      <ScrollView style={s.page} contentContainerStyle={s.content}>
        <Notice error text="Vaka yüklenemedi. İnternet bağlantını kontrol edip tekrar dene." />
        <Button label="Tekrar dene" onPress={() => void load()} />
      </ScrollView>
    );
  if (!rescueCase)
    return (
      <ScrollView style={s.page} contentContainerStyle={s.content}>
        <Empty
          title="Vaka bulunamadı"
          detail="Bu bildirim kaldırılmış olabilir veya hiç var olmamış olabilir."
          icon="alert-circle-outline"
        />
      </ScrollView>
    );
  const mine = !!app.viewer && rescueCase.assigned_volunteer_id === app.viewer.id;
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      {rescueCase.photo_url ? (
        <Image
          accessibilityLabel="Yaralı hayvan fotoğrafı"
          source={{ uri: rescueCase.photo_url }}
          style={s.photo}
        />
      ) : null}
      <Text style={t.title}>{rescueCase.animal_condition}</Text>
      <Text style={t.body}>{timeAgo(rescueCase.created_at)}</Text>
      {rescueCase.description ? <Text style={t.body}>{rescueCase.description}</Text> : null}
      <Card style={{ gap: 8 }}>
        <Text style={s.label}>Durum</Text>
        <Text style={t.h2}>{rescueCaseStatusNames[rescueCase.status]}</Text>
      </Card>
      {canClaimRescueCase(rescueCase) ? (
        <>
          {claimError ? <Notice error text={claimError} /> : null}
          <Button
            label="Vakayı Üstlen"
            icon="hand-left-outline"
            loading={claiming}
            disabled={!app.viewer}
            onPress={() => void claim()}
          />
        </>
      ) : rescueCase.assigned_volunteer_id ? (
        <Notice
          text={
            mine
              ? 'Bu vakayı sen üstlendin.'
              : 'Bir gönüllü bu vakayı üstlendi. Mükerrer müdahaleyi önlemek için başka bir vaka kontrol edebilirsin.'
          }
        />
      ) : null}
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 24,
    gap: 16,
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
    paddingBottom: 45,
  },
  photo: { height: 235, width: '100%', borderRadius: 19, backgroundColor: C.soft },
  label: { fontSize: 12, fontWeight: '600', color: C.muted },
});
