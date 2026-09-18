import React, { useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import * as Crypto from 'expo-crypto';
import { useApp } from '../state/AppProvider';
import { Button, Field, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { pickPhoto } from '../services/photos';
import { reportRescueCase } from '../services/repository';
import { getDeviceLocation } from '../services/location';
import { locationFailureMessage } from '../services/location-common';
export function RescueReportScreen() {
  const app = useApp(),
    nav = useNavigation();
  // Deterministic per-attempt id (RecordScreen's pattern): retrying after a
  // failed submit reuses the same id/photo path, so report_rescue_case's own
  // idempotency guard turns the retry into a no-op instead of a duplicate case.
  const operation = useRef(Crypto.randomUUID()),
    busy = useRef(false);
  const [photo, setPhoto] = useState(''),
    [picking, setPicking] = useState(false),
    [animalCondition, setAnimalCondition] = useState(''),
    [description, setDescription] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [saved, setSaved] = useState(false);
  async function image(source: 'camera' | 'library') {
    setPicking(true);
    setError('');
    try {
      const uri = await pickPhoto(source);
      if (uri) setPhoto(uri);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fotoğraf alınamadı.');
    } finally {
      setPicking(false);
    }
  }
  async function save() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      if (!app.viewer) throw new Error('Bildirim göndermek için giriş yapın.');
      if (!photo) throw new Error('Yaralı hayvanın fotoğrafını ekleyin.');
      if (!animalCondition.trim()) throw new Error('Hayvanın durumunu kısaca yazın.');
      let coords: { latitude: number; longitude: number } | undefined;
      if (!app.demo) {
        try {
          coords = await getDeviceLocation();
        } catch (e) {
          setError(locationFailureMessage(e, Platform.OS === 'web'));
          return;
        }
      }
      if (!app.demo) {
        await reportRescueCase(app.viewer.id, {
          id: operation.current,
          latitude: coords!.latitude,
          longitude: coords!.longitude,
          description: description.trim(),
          animal_condition: animalCondition.trim(),
          photo_uri: photo,
        });
      }
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bildirim gönderilemedi. Lütfen tekrar deneyin.');
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }
  if (saved)
    return (
      <View style={[s.page, s.content, { justifyContent: 'center' }]}>
        <Text style={t.title}>Bildirimin alındı.</Text>
        <Notice
          text={
            app.demo
              ? 'Demo bildirimi tamamlandı. Gerçek bir gönüllüye iletilmedi.'
              : 'Yakındaki gönüllülere ve anlaşmalı veterinerlere görünür olacak.'
          }
        />
        <Button label="Geri dön" onPress={() => nav.goBack()} />
      </View>
    );
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" style={s.page} contentContainerStyle={s.content}>
        <Text style={t.eyebrow}>YARDIM ÇAĞRISI</Text>
        <Text style={t.title}>Yaralı hayvan bildir</Text>
        <Text style={t.body}>
          Fotoğraf ve konum, yakındaki gönüllülerin ve anlaşmalı veterinerlerin durumu
          değerlendirmesini sağlar.
        </Text>
        <View style={s.section}>
          <Text style={s.label}>Fotoğraf</Text>
          {photo ? (
            <Image accessibilityLabel="Yaralı hayvan fotoğrafı" source={{ uri: photo }} style={s.photo} />
          ) : (
            <View style={s.photoEmpty}>
              <Text style={{ fontSize: 30 }}>⌑</Text>
              <Text style={t.body}>Hayvanın durumu net görünsün</Text>
            </View>
          )}
          <View style={s.wrap}>
            <View style={{ flex: 1 }}>
              <Button
                secondary
                icon="camera-outline"
                label="Fotoğraf çek"
                loading={picking}
                disabled={loading}
                onPress={() => void image('camera')}
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                secondary
                icon="images-outline"
                label="Galeriden seç"
                disabled={picking || loading}
                onPress={() => void image('library')}
              />
            </View>
          </View>
        </View>
        <Field
          label="Hayvanın durumu"
          placeholder="Örn. arka bacağını sürüyor"
          value={animalCondition}
          onChangeText={setAnimalCondition}
          maxLength={200}
          editable={!loading}
        />
        <Field
          label="Açıklama (isteğe bağlı)"
          placeholder="Konum tarifi, davranışı veya dikkat edilmesi gereken bir şey…"
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={500}
          editable={!loading}
        />
        {error ? <Notice text={error} error /> : null}
        <Button
          label="Bildirimi gönder"
          icon="alert-circle-outline"
          loading={loading}
          disabled={!photo || !animalCondition.trim() || !app.viewer}
          onPress={() => void save()}
        />
        <Text style={s.hint}>
          Patika acil veteriner hizmeti veya ihbar hattı değildir. Hayvana yaklaşırken kendi
          güvenliğini önceliklendir.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 24,
    gap: 18,
    width: '100%',
    maxWidth: 680,
    alignSelf: 'center',
    paddingBottom: 45,
  },
  section: { gap: 12 },
  label: { fontSize: 14, fontWeight: '600', color: C.ink },
  wrap: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  photo: { height: 235, width: '100%', borderRadius: 19, backgroundColor: C.soft },
  photoEmpty: {
    borderWidth: 1,
    borderColor: '#CCD9C6',
    borderStyle: 'dashed',
    borderRadius: 20,
    backgroundColor: C.soft,
    padding: 27,
    minHeight: 185,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 11,
  },
  hint: { fontSize: 12, color: C.muted, lineHeight: 19 },
});
