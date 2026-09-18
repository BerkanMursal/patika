import React, { useCallback, useState } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { Vet } from '../core/types';
import { useApp } from '../state/AppProvider';
import { Button, Card, Empty, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { getVets } from '../services/repository';
type State =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'success'; vets: Vet[] };
export function VetListScreen() {
  const app = useApp(),
    [state, setState] = useState<State>({ status: 'loading' });
  // Anon sees the real list too (get_vets() grants execute to anon,
  // authenticated alike) — unlike LeaderboardScreen, there is no
  // `|| !app.viewer` gate here. Demo mode has no backend at all, so it's the
  // only case that stays unavailable.
  const load = useCallback(() => {
    if (app.demo) {
      setState({ status: 'unavailable' });
      return;
    }
    setState({ status: 'loading' });
    getVets()
      .then((vets) => setState(vets.length ? { status: 'success', vets } : { status: 'empty' }))
      .catch(() => setState({ status: 'error' }));
  }, [app.demo]);
  useFocusEffect(useCallback(() => load(), [load]));
  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.content}
      refreshControl={<RefreshControl refreshing={state.status === 'loading'} onRefresh={load} />}
    >
      <Text style={t.eyebrow}>PATİKA ANLAŞMALI</Text>
      <Text style={t.title}>Veterinerler</Text>
      {state.status === 'unavailable' ? (
        <Empty
          title="Veteriner listesi demo modda yok"
          detail="Gerçek bir hesapla veya çıkış yaparak devam ettiğinde anlaşmalı veterinerleri görebilirsin."
          icon="medkit-outline"
        />
      ) : state.status === 'error' ? (
        <>
          <Notice error text="Veteriner listesi yüklenemedi." />
          <Button label="Tekrar dene" onPress={load} />
        </>
      ) : state.status === 'empty' ? (
        <Empty
          title="Henüz anlaşmalı veteriner yok"
          detail="Yeni eklendiğinde burada görünecek."
          icon="medkit-outline"
        />
      ) : state.status === 'success' ? (
        <View style={{ gap: 12 }}>
          {state.vets.map((vet) => (
            <Card key={vet.id} style={{ gap: 6 }}>
              <Text style={t.h2}>{vet.name}</Text>
              {vet.address ? <Text style={t.body}>{vet.address}</Text> : null}
              <Text style={t.body}>
                {[vet.district, vet.city].filter(Boolean).join(' · ') || '—'}
              </Text>
              {vet.phone ? (
                <Text style={s.link} onPress={() => void Linking.openURL(`tel:${vet.phone}`)}>
                  {vet.phone}
                </Text>
              ) : null}
              {vet.is_partner ? (
                <Text style={s.badge}>{vet.discount_info || 'Patika kullanıcılarına indirim'}</Text>
              ) : null}
            </Card>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 24,
    gap: 18,
    maxWidth: 680,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: 40,
  },
  link: { fontSize: 13, fontWeight: '600', color: C.green },
  badge: { fontSize: 12, color: C.muted },
});
