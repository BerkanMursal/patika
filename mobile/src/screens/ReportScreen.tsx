import React, { useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { RootStack } from '../navigation';
import { useApp } from '../state/AppProvider';
import { Button, Card, Chip, Empty, Field, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import * as api from '../services/repository';
import type { Report, ReportContext } from '../core/types';
import { rescueCaseStatusNames } from '../core/domain';
import { FeedingCard } from '../components/FeedingCard';
const content = {
  padding: 24,
  gap: 18,
  maxWidth: 680,
  width: '100%' as const,
  alignSelf: 'center' as const,
};
export function ReportScreen() {
  const { params } = useRoute<RouteProp<RootStack, 'Report'>>(),
    app = useApp(),
    nav = useNavigation(),
    [reason, setReason] = useState('Yanlış bilgi'),
    [detail, setDetail] = useState(''),
    [busy, setBusy] = useState(false),
    [done, setDone] = useState(false),
    [error, setError] = useState('');
  async function send() {
    setBusy(true);
    try {
      if (!app.viewer) throw new Error('Bildirim için giriş yapın.');
      if (detail.trim().length < 10) throw new Error('En az 10 karakterlik bir açıklama ekleyin.');
      if (!app.demo)
        await api.reportItem(reason, detail, params.parkId, params.feedingId, params.rescueCaseId);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bildirim gönderilemedi.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={content}>
      <Text style={t.title}>Bir sorun mu gördün?</Text>
      <Text style={t.body}>Bildirimin inceleme için ekibe iletilir.</Text>
      {done ? (
        <>
          <Notice
            text={
              app.demo
                ? 'Demo bildirimi tamamlandı. Gerçek bir moderatöre iletilmedi.'
                : 'Bildirimin alındı. Teşekkürler.'
            }
          />
          <Button label="Geri dön" onPress={() => nav.goBack()} />
        </>
      ) : (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {['Yanlış bilgi', 'Uygunsuz fotoğraf', 'Spam', 'Park konumu hatalı', 'Diğer'].map(
              (label) => (
                <Chip
                  key={label}
                  label={label}
                  active={reason === label}
                  onPress={() => setReason(label)}
                />
              ),
            )}
          </View>
          <Field
            label="Açıklama"
            value={detail}
            onChangeText={setDetail}
            multiline
            maxLength={1000}
          />
          {error ? <Notice error text={error} /> : null}
          <Button label="İncelemeye gönder" loading={busy} onPress={() => void send()} />
        </>
      )}
    </ScrollView>
  );
}
export function ModerationScreen() {
  const app = useApp(),
    [reports, setReports] = useState<Report[]>([]),
    [contexts, setContexts] = useState<Record<string, ReportContext>>({}),
    [error, setError] = useState('');
  async function load() {
    try {
      setReports(await api.loadReports());
    } catch {
      setError('Bildirimler yüklenemedi.');
    }
  }
  useEffect(() => {
    if (app.viewer?.moderator) void load();
  }, [app.viewer]);
  if (!app.viewer?.moderator)
    return (
      <Empty title="Yetkili hesap gerekli" detail="Bu görünüm yalnızca moderatörlere açıktır." />
    );
  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={content}>
      <Text style={t.title}>İnceleme bekleyenler</Text>
      {error ? <Notice error text={error} /> : null}
      {reports.map((r) => (
        <Card key={r.id} style={{ gap: 12 }}>
          <Text style={t.h2}>{r.reason}</Text>
          <Text style={t.body}>{r.detail}</Text>
          {contexts[r.id] ? (
            contexts[r.id].rescue ? (
              <>
                <Text style={t.h2}>{rescueCaseStatusNames[contexts[r.id].rescue!.status]}</Text>
                <Text style={t.body}>{contexts[r.id].rescue!.animal_condition}</Text>
                {contexts[r.id].rescue!.description ? (
                  <Text style={t.body}>{contexts[r.id].rescue!.description}</Text>
                ) : null}
                {contexts[r.id].rescue!.photo_url ? (
                  <Image
                    accessibilityLabel="Vaka fotoğrafı"
                    source={{ uri: contexts[r.id].rescue!.photo_url }}
                    style={s.photo}
                  />
                ) : null}
                <Text style={t.body}>
                  {contexts[r.id].rescue!.latitude.toFixed(5)},{' '}
                  {contexts[r.id].rescue!.longitude.toFixed(5)}
                </Text>
              </>
            ) : (
              <>
                <Text style={t.h2}>{contexts[r.id].park!.name}</Text>
                <Text style={t.body}>
                  {contexts[r.id].park!.city} · {contexts[r.id].park!.latitude.toFixed(5)},{' '}
                  {contexts[r.id].park!.longitude.toFixed(5)}
                </Text>
                {contexts[r.id].feeding ? <FeedingCard event={contexts[r.id].feeding!} /> : null}
              </>
            )
          ) : (
            <Button
              secondary
              label="Bildirilen içeriği aç"
              onPress={() =>
                void api
                  .loadReportContext(r.id)
                  .then((context) => setContexts((all) => ({ ...all, [r.id]: context })))
                  .catch(() => setError('İçerik yüklenemedi.'))
              }
            />
          )}
          <Button
            disabled={!contexts[r.id]}
            label="İçeriği gizle, bildirimi kapat"
            onPress={() =>
              void api
                .resolveReport(r.id, true)
                .then(load)
                .catch(() => setError('İşlem yapılamadı.'))
            }
          />
          <Button
            secondary
            label="İşlem gerekmiyor"
            onPress={() =>
              void api
                .resolveReport(r.id, false)
                .then(load)
                .catch(() => setError('İşlem yapılamadı.'))
            }
          />
        </Card>
      ))}
      {!reports.length ? (
        <Empty title="Açık bildirim yok" detail="Yeni bildirimler burada görünür." />
      ) : null}
    </ScrollView>
  );
}
const s = StyleSheet.create({
  photo: { height: 200, width: '100%', borderRadius: 19, backgroundColor: C.soft },
});
