import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import type { NameSuggestion, Park } from '../core/types';
import { useApp } from '../state/AppProvider';
import { parkPlace, parkDisplayName } from '../core/park-names';
import { loadNameSuggestions, suggestName, reviewName } from '../services/park-names';
import { Button, Card, Empty, Field, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';

const content = {
  padding: 24,
  gap: 18,
  maxWidth: 680,
  width: '100%' as const,
  alignSelf: 'center' as const,
};
const statuses = {
  pending: 'İnceleme bekliyor',
  approved: 'Onaylandı',
  rejected: 'Uygun bulunmadı',
};
const errorText = (e: unknown) =>
  e && typeof e === 'object' && 'message' in e && typeof e.message === 'string'
    ? e.message
    : 'İşlem tamamlanamadı. Tekrar dene.';

export function NameSuggestionScreen() {
  const {
    params: { id },
  } = useRoute<RouteProp<RootStack, 'SuggestName'>>();
  const app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const [park, setPark] = useState<Park | null>(null),
    [suggestions, setSuggestions] = useState<NameSuggestion[]>([]),
    [name, setName] = useState(''),
    [evidence, setEvidence] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [done, setDone] = useState(false);
  const sending = useRef(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setLoading(true);
      setError('');
      setDone(false);
      setName('');
      setEvidence('');
      Promise.all([
        app.getPark(id),
        app.viewer ? loadNameSuggestions(app.viewer, id) : Promise.resolve([]),
      ])
        .then(([p, items]) => {
          if (active) {
            setPark(p);
            setSuggestions(items.filter((s) => s.user_id === app.viewer?.id));
          }
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
      return () => {
        active = false;
      };
    }, [id, app.viewer?.id]),
  );
  async function send() {
    if (!park || !app.viewer || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await suggestName(park, app.viewer, name, evidence);
      setDone(true);
      setSuggestions(
        (await loadNameSuggestions(app.viewer, id)).filter((s) => s.user_id === app.viewer?.id),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const pending = suggestions.some((s) => s.status === 'pending');
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={t.eyebrow}>BİRLİKTE TAMAMLAYALIM</Text>
      <Text style={t.title}>Bu parkın adı ne?</Text>
      <Text style={t.body}>
        Tabeladaki veya güvenilir bir kaynakta geçen adı paylaş. Öneri, inceleme sonrası park
        bilgisine eklenir.
      </Text>
      {loading ? <ActivityIndicator color={C.green} /> : null}
      {park ? (
        <Card style={{ gap: 8 }}>
          <Text style={t.h2}>{park.name}</Text>
          <Text style={t.body}>{parkPlace(park)}</Text>
        </Card>
      ) : !loading && !error ? (
        <Empty title="Park bulunamadı" detail="Haritadan bir park seçerek tekrar dene." />
      ) : null}
      {app.demo ? (
        <Notice text="Demo: Öneri yalnızca bu cihazda saklanır. Gerçek bir moderatöre gönderilmez ve park adı değiştirilmez." />
      ) : null}
      {error ? <Notice error text={error} /> : null}
      {!app.viewer ? (
        <Button label="Öneri için giriş yap" onPress={() => nav.navigate('Auth')} />
      ) : park && !loading && !pending && !done ? (
        <>
          <Field
            label="Önerdiğin park adı"
            value={name}
            onChangeText={setName}
            maxLength={120}
            placeholder="Örn. tabelada yazan park adı"
          />
          <Field
            label="Bu adı nereden doğrulayabiliriz?"
            value={evidence}
            onChangeText={setEvidence}
            multiline
            maxLength={600}
            placeholder="Tabela, belediye kaynağı veya kontrol edilebilir bir açıklama ekle."
          />
          <Text style={t.body}>
            Kişisel bilgi ekleme. Parka yeni bir ad vermek yerine mevcut adını paylaş.
          </Text>
          <Button
            label={app.demo ? 'Demo önerisini kaydet' : 'İncelemeye gönder'}
            icon="create-outline"
            loading={busy}
            onPress={() => void send()}
          />
        </>
      ) : null}
      {done ? (
        <Notice
          text={
            app.demo
              ? 'Önerin bu cihazda kaydedildi. Park adı inceleme yapılmadan değişmez.'
              : 'Önerin alındı. İnceleme sonucunu bu ekrandan görebilirsin.'
          }
        />
      ) : null}
      {pending && !done ? <Notice text="Bu park için inceleme bekleyen bir önerin var." /> : null}
      {suggestions.length ? <Text style={t.h2}>Önerilerin</Text> : null}
      {suggestions.map((s) => (
        <Card key={s.id} style={{ gap: 9 }}>
          <Text style={t.eyebrow}>{statuses[s.status]}</Text>
          <Text style={t.h2}>{s.proposed_name}</Text>
          <Text style={t.body}>{s.evidence}</Text>
          {s.review_note ? <Text style={t.body}>İnceleme notu: {s.review_note}</Text> : null}
        </Card>
      ))}
      <Button secondary label="Parka dön" onPress={() => nav.popTo('Park', { id })} />
    </ScrollView>
  );
}

function ReviewCard({
  suggestion,
  onDone,
}: {
  suggestion: NameSuggestion;
  onDone: () => Promise<void>;
}) {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>(),
    app = useApp();
  const [note, setNote] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [opened, setOpened] = useState(false);
  const sending = useRef(false);
  async function decide(accept: boolean) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setError('');
    try {
      await reviewName(suggestion.id, accept, note);
      await app.refresh();
      await onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  const own = suggestion.user_id === app.viewer?.id;
  return (
    <Card style={{ gap: 12 }}>
      <Text style={t.eyebrow}>ÖNERİLEN AD</Text>
      <Text style={t.h2}>{suggestion.proposed_name}</Text>
      <Text style={t.body}>
        Mevcut:{' '}
        {parkDisplayName(suggestion.park_id, suggestion.park_name ?? suggestion.original_name)}
      </Text>
      <Text style={t.body}>
        {[suggestion.district, suggestion.city].filter(Boolean).join(' · ')}
      </Text>
      <Text style={t.body}>{suggestion.evidence}</Text>
      <Button
        secondary
        label="Parkı ve kaynağını kontrol et"
        onPress={() => {
          setOpened(true);
          nav.navigate('Park', { id: suggestion.park_id });
        }}
      />
      {own ? (
        <Notice text="Kendi önerini inceleyemezsin. Başka bir moderatör karar vermeli." />
      ) : (
        <>
          <Field
            label="Doğrulama kaynağı ve karar gerekçesi"
            value={note}
            onChangeText={setNote}
            multiline
            maxLength={600}
          />
          <Button
            label="Adı onayla ve yayımla"
            disabled={!opened || note.trim().length < 10}
            loading={busy}
            onPress={() => void decide(true)}
          />
          <Button
            secondary
            label="Öneriyi reddet"
            disabled={busy || note.trim().length < 10}
            onPress={() => void decide(false)}
          />
        </>
      )}
      {error ? <Notice error text={error} /> : null}
    </Card>
  );
}
export function NameReviewScreen() {
  const app = useApp();
  const [suggestions, setSuggestions] = useState<NameSuggestion[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  async function load() {
    if (!app.viewer?.moderator || app.demo) return;
    setLoading(true);
    setError('');
    try {
      setSuggestions((await loadNameSuggestions(app.viewer)).filter((s) => s.status === 'pending'));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [app.viewer?.id, app.viewer?.moderator]),
  );
  if (!app.viewer?.moderator || app.demo)
    return (
      <Empty
        title="Yetkili hesap gerekli"
        detail="Gerçek önerileri incelemek için moderatör hesabıyla giriş yap."
      />
    );
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={content}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={t.title}>Park adı önerileri</Text>
      <Text style={t.body}>
        Konumu ve doğrulama kaynağını incele. Onaylanan ad parkta, aramada ve geçmiş kayıtlarda
        görünür.
      </Text>
      {loading ? <ActivityIndicator color={C.green} /> : null}
      {error ? <Notice error text={error} /> : null}
      <Button secondary label="Önerileri yenile" onPress={() => void load()} />
      {suggestions.map((s) => (
        <ReviewCard key={s.id} suggestion={s} onDone={load} />
      ))}
      {!loading && !error && !suggestions.length ? (
        <Empty title="Bekleyen ad önerisi yok" detail="Yeni öneriler bu listede görünür." />
      ) : null}
    </ScrollView>
  );
}
