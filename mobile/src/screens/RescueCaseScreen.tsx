import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import type { RescueCase, RescueCaseStatus, Vet } from '../core/types';
import { useApp } from '../state/AppProvider';
import {
  canClaimRescueCase,
  isRescueCaseAuthError,
  nextRescueCaseStatus,
  rescueCaseAccessGate,
  rescueCaseActionLabels,
  rescueCaseStatusNames,
  timeAgo,
} from '../core/domain';
import { Button, Card, Chip, Empty, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import {
  claimRescueCase,
  getRescueCase,
  getVets,
  updateRescueCaseStatus,
} from '../services/repository';
type RescueCaseLoadState =
  'unavailable' | 'unauthenticated' | 'loading' | 'notFound' | 'authError' | 'error' | 'success';
export function RescueCaseScreen() {
  const {
      params: { id },
    } = useRoute<RouteProp<RootStack, 'RescueCase'>>(),
    app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const [rescueCase, setRescueCase] = useState<RescueCase | null>(null),
    [loadState, setLoadState] = useState<RescueCaseLoadState>('loading'),
    [claiming, setClaiming] = useState(false),
    [claimError, setClaimError] = useState(''),
    [advancing, setAdvancing] = useState(false),
    [advanceError, setAdvanceError] = useState(''),
    [vets, setVets] = useState<Vet[]>([]),
    [vetsError, setVetsError] = useState(false),
    [selectedVetId, setSelectedVetId] = useState<string>();
  // Pressable's own disabled-while-loading prop is async (a state update),
  // so a fast double-tap can still queue a second onPress before it commits.
  // This ref blocks synchronously, same pattern as RecordScreen/RescueReportScreen.
  const busy = useRef(false);
  const mine = !!app.viewer && rescueCase?.assigned_volunteer_id === app.viewer.id;
  // Only the assigned volunteer, only while the case sits at en_route (i.e.
  // the next step is at_vet), ever needs the vet picker — computed here
  // (not after the loading/not-found returns below) so the hooks that key
  // off it can run unconditionally on every render.
  const showVetPicker = mine && rescueCase?.status === 'en_route';
  // Guards against a stale async response (logout, viewer switch, blur or
  // unmount mid-request) writing success/notFound/authError/error after a
  // newer request has already superseded it — same generation-counter shape
  // as AppProvider's own refresh().
  const loadToken = useRef(0);
  async function load() {
    const token = ++loadToken.current;
    const commit = (apply: () => void) => {
      if (loadToken.current === token) apply();
    };
    // App-level session bootstrap not finished yet: app.viewer is not
    // trustworthy either way (still null even for an already-logged-in
    // viewer), so wait rather than guessing — the loading state already
    // shown covers this.
    if (!app.ready) return;
    const gate = rescueCaseAccessGate(app.demo, app.viewer?.id);
    if (gate === 'unavailable') return commit(() => setLoadState('unavailable'));
    if (gate === 'unauthenticated') return commit(() => setLoadState('unauthenticated'));
    commit(() => setLoadState('loading'));
    try {
      const result = await getRescueCase(id);
      commit(() => {
        if (result) {
          setRescueCase(result);
          setLoadState('success');
        } else {
          setLoadState('notFound');
        }
      });
    } catch (e) {
      commit(() => setLoadState(isRescueCaseAuthError(e) ? 'authError' : 'error'));
    }
  }
  useFocusEffect(
    useCallback(() => {
      void load();
      // Invalidates this run's token on blur/unmount so an in-flight
      // response (no follow-up call to naturally supersede it) can never
      // write a stale state afterward.
      return () => {
        loadToken.current++;
      };
    }, [id, app.demo, app.viewer?.id, app.ready]),
  );
  // Vet assignment is optional (product decision) — a failed fetch here must
  // never block the en_route->at_vet transition, so this is entirely
  // separate from `load`'s own loading/error state.
  useEffect(() => {
    if (!showVetPicker || app.demo) {
      setVets([]);
      setVetsError(false);
      return;
    }
    let cancelled = false;
    getVets()
      .then((rows) => {
        if (!cancelled) {
          setVets(rows);
          setVetsError(false);
        }
      })
      .catch(() => {
        if (!cancelled) setVetsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [showVetPicker, app.demo]);
  // Never leave a stale pick around: a different case, a status that moved
  // past en_route (including this volunteer's own successful at_vet
  // transition, via the load() that follows it), or losing "mine" status all
  // clear the selection.
  useEffect(() => {
    if (!showVetPicker) setSelectedVetId(undefined);
  }, [id, showVetPicker]);
  async function claim() {
    if (busy.current) return;
    busy.current = true;
    setClaiming(true);
    setClaimError('');
    try {
      await claimRescueCase(id);
      // Never guess the new state locally — re-fetch the canonical row so
      // the screen always reflects what the server actually committed.
      await load();
    } catch (e) {
      setClaimError(e instanceof Error ? e.message : 'Vaka üstlenilemedi. Lütfen tekrar deneyin.');
    } finally {
      setClaiming(false);
      busy.current = false;
    }
  }
  async function advance(next: RescueCaseStatus, vetId?: string) {
    if (busy.current) return;
    busy.current = true;
    setAdvancing(true);
    setAdvanceError('');
    try {
      await updateRescueCaseStatus(id, next, vetId);
      // Same rule as claim(): reload from the server instead of setting
      // rescueCase.status locally. On failure below, rescueCase is left
      // exactly as it was — only the error notice changes.
      await load();
    } catch (e) {
      setAdvanceError(e instanceof Error ? e.message : 'Durum güncellenemedi. Lütfen tekrar dene.');
    } finally {
      setAdvancing(false);
      busy.current = false;
    }
  }
  if (loadState === 'loading')
    return (
      <View style={[s.page, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color={C.green} />
      </View>
    );
  if (loadState === 'unavailable')
    return (
      <ScrollView style={s.page} contentContainerStyle={s.content}>
        <Notice text="Vaka bilgileri demo modda görüntülenemez." />
      </ScrollView>
    );
  if (loadState === 'unauthenticated' || loadState === 'authError')
    return (
      <ScrollView style={s.page} contentContainerStyle={s.content}>
        <Empty
          title="Giriş gerekli"
          detail="Bu vakayı görmek için giriş yapmalısın."
          icon="lock-closed-outline"
        />
        <Button label="Giriş yap" onPress={() => nav.navigate('Auth')} />
      </ScrollView>
    );
  if (loadState === 'notFound')
    return (
      <ScrollView style={s.page} contentContainerStyle={s.content}>
        <Empty
          title="Vaka bulunamadı"
          detail="Bu bildirim kaldırılmış olabilir veya hiç var olmamış olabilir."
          icon="alert-circle-outline"
        />
      </ScrollView>
    );
  if (loadState === 'error' || !rescueCase)
    return (
      <ScrollView style={s.page} contentContainerStyle={s.content}>
        <Notice error text="Vaka yüklenemedi. İnternet bağlantını kontrol edip tekrar dene." />
        <Button label="Tekrar dene" onPress={() => void load()} />
      </ScrollView>
    );
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
        {rescueCase.assigned_vet_name ? (
          <Text style={t.body}>Veteriner: {rescueCase.assigned_vet_name}</Text>
        ) : null}
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
      ) : mine && nextRescueCaseStatus[rescueCase.status] ? (
        <>
          {showVetPicker ? (
            <View style={{ gap: 10 }}>
              <Text style={s.label}>Hangi veterinere gidiliyor? (isteğe bağlı)</Text>
              {vetsError ? (
                <Notice text="Veteriner listesi yüklenemedi. Veterinersiz de devam edebilirsin." />
              ) : null}
              {vets.length ? (
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  {vets.map((vet) => (
                    <Chip
                      key={vet.id}
                      label={[vet.name, vet.district || vet.city].filter(Boolean).join(' · ')}
                      active={selectedVetId === vet.id}
                      onPress={() =>
                        setSelectedVetId((current) => (current === vet.id ? undefined : vet.id))
                      }
                    />
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}
          {advanceError ? <Notice error text={advanceError} /> : null}
          <Button
            label={rescueCaseActionLabels[nextRescueCaseStatus[rescueCase.status]!]}
            icon="arrow-forward-circle-outline"
            loading={advancing}
            disabled={!app.viewer}
            onPress={() => void advance(nextRescueCaseStatus[rescueCase.status]!, selectedVetId)}
          />
        </>
      ) : mine && rescueCase.status === 'resolved' ? (
        <Notice text="Bu vakayı çözdün. Teşekkürler!" />
      ) : rescueCase.assigned_volunteer_id ? (
        <Notice
          text={
            mine
              ? 'Bu vakayı sen üstlendin.'
              : 'Bir gönüllü bu vakayı üstlendi. Mükerrer müdahaleyi önlemek için başka bir vaka kontrol edebilirsin.'
          }
        />
      ) : null}
      <Button
        secondary
        label="Vakayı bildir"
        icon="flag-outline"
        onPress={() =>
          app.viewer ? nav.navigate('Report', { rescueCaseId: id }) : nav.navigate('Auth')
        }
      />
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
