import React, { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import type { LeaderboardRow } from '../core/types';
import { useApp } from '../state/AppProvider';
import { Button, Empty, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { getLeaderboard } from '../services/repository';
type State =
  | { status: 'unavailable' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'empty' }
  | { status: 'success'; rows: LeaderboardRow[] };
export function LeaderboardScreen() {
  const app = useApp(),
    [state, setState] = useState<State>({ status: 'loading' });
  const load = useCallback(() => {
    if (app.demo || !app.viewer) {
      setState({ status: 'unavailable' });
      return;
    }
    setState({ status: 'loading' });
    getLeaderboard()
      .then((rows) => setState(rows.length ? { status: 'success', rows } : { status: 'empty' }))
      .catch(() => setState({ status: 'error' }));
  }, [app.demo, app.viewer?.id]);
  useFocusEffect(useCallback(() => load(), [load]));
  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl refreshing={state.status === 'loading'} onRefresh={load} />
      }
    >
      <Text style={t.eyebrow}>EN ÇOK YARDIM YAPANLAR</Text>
      <Text style={t.title}>Sıralama</Text>
      {state.status === 'unavailable' ? (
        <Empty
          title="Sıralama için giriş yap"
          detail="Bu özellik demo modda kullanılamaz. Hesabınla giriş yaptığında güncel sıralamayı görebilirsin."
          icon="trophy-outline"
        />
      ) : state.status === 'error' ? (
        <>
          <Notice error text="Sıralama yüklenemedi." />
          <Button label="Tekrar dene" onPress={load} />
        </>
      ) : state.status === 'empty' ? (
        <Empty
          title="Henüz kimse puan kazanmadı"
          detail="Doğrulanmış bir besleme veya gözlem kaydı bıraktığında burada görünür."
          icon="trophy-outline"
        />
      ) : state.status === 'success' ? (
        <View style={s.list}>
          {state.rows.map((row, index) => {
            const mine = row.user_id === app.viewer?.id;
            return (
              <View key={row.user_id} style={[s.row, mine && s.rowMine]}>
                <Text style={s.rank}>{index + 1}</Text>
                <Text style={s.name} numberOfLines={1} ellipsizeMode="tail">
                  {row.display_name}
                </Text>
                <Text style={s.points}>{row.total_points}</Text>
              </View>
            );
          })}
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
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: 40,
  },
  list: {
    backgroundColor: C.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.line,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    padding: 16,
    borderBottomWidth: 1,
    borderColor: '#F1F4EE',
  },
  rowMine: { backgroundColor: C.soft },
  rank: { width: 26, fontSize: 14, fontWeight: '700', color: C.muted },
  name: { flex: 1, fontSize: 14, fontWeight: '600', color: C.ink },
  points: { fontSize: 14, fontWeight: '700', color: C.green },
});
