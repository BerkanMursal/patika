import React, { useEffect, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Crypto from 'expo-crypto';
import type { RootStack } from '../navigation';
import type { BowlStatus, FoodType, Park, Point } from '../core/types';
import { useApp } from '../state/AppProvider';
import { Button, Chip, Field, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { foodNames, bowlNames } from '../core/domain';
import { pickPhoto } from '../services/photos';
import { submitObservation } from '../services/repository';
import { getDeviceLocation } from '../services/location';
import { locationFailureMessage } from '../services/location-common';
export function RecordScreen() {
  const {
      params: { id },
    } = useRoute<RouteProp<RootStack, 'Record'>>(),
    app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const operation = useRef(Crypto.randomUUID()),
    busy = useRef(false);
  const [park, setPark] = useState<Park | null>(null),
    [points, setPoints] = useState<Point[]>([]),
    [point, setPoint] = useState(''),
    [photo, setPhoto] = useState(''),
    [food, setFood] = useState<FoodType>('dry'),
    [grams, setGrams] = useState(''),
    [water, setWater] = useState(''),
    [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [picking, setPicking] = useState(false),
    [saved, setSaved] = useState(false);
  useEffect(() => {
    void Promise.all([app.getPark(id), app.getPoints(id)])
      .then(([p, pts]) => {
        setPark(p);
        setPoints(pts);
        setPoint(pts[0]?.id ?? '');
      })
      .catch(() => setError('Besleme noktası yüklenemedi. Geri dönüp tekrar deneyin.'));
  }, [id]);
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
      if (!app.viewer) throw new Error('Besleme paylaşmak için giriş yapın.');
      // Demo drafts never reach submit_feeding, so demo mode never prompts for location.
      let coords: { latitude: number; longitude: number } | undefined;
      if (!app.demo) {
        try {
          coords = await getDeviceLocation();
        } catch (e) {
          setError(locationFailureMessage(e, Platform.OS === 'web'));
          return;
        }
      }
      await app.enqueue({
        id: operation.current,
        user_id: app.viewer.id,
        park_id: id,
        point_id: point,
        park_name: park?.name ?? '',
        food_type: food,
        food_grams: grams.trim() ? Number(grams) : 0,
        water_ml: water.trim() ? Number(water) : 0,
        note: note.trim(),
        occurred_at: new Date().toISOString(),
        photo_uri: photo,
        reported_latitude: coords?.latitude,
        reported_longitude: coords?.longitude,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kayıt kaydedilemedi. Lütfen tekrar deneyin.');
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }
  if (saved)
    return (
      <View
        style={[
          s.page,
          {
            padding: 25,
            justifyContent: 'center',
            gap: 20,
            maxWidth: 580,
            alignSelf: 'center',
            width: '100%',
          },
        ]}
      >
        <Text style={t.title}>İyiliğin kaybolmasın.</Text>
        <Notice
          text={
            app.queue.some((q) => q.id === operation.current)
              ? 'Kaydın cihazda saklandı. Sunucuya gönderim durumunu bekleyen kayıtlar ekranından görebilirsin.'
              : 'Besleme kaydın paylaşıldı. Teşekkürler!'
          }
        />
        <Button label="Kayıt durumunu gör" onPress={() => nav.replace('Outbox')} />
        <Button secondary label="Parka dön" onPress={() => nav.goBack()} />
      </View>
    );
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={s.page}
        contentContainerStyle={s.content}
      >
        <Text style={t.eyebrow}>BİR KAP DA SENDEN</Text>
        <Text style={t.title}>Mama / su bıraktım</Text>
        <Text style={t.body}>{park?.name ?? 'Park yükleniyor…'}</Text>
        {!app.online ? (
          <Notice text="Çevrimdışısın. Kaydın ve fotoğrafın cihazda tutulacak, bağlantı geldiğinde gönderilecek." />
        ) : null}
        {points.length > 1 ? (
          <View style={s.section}>
            <Text style={s.label}>Besleme noktası</Text>
            <View style={s.wrap}>
              {points.map((p) => (
                <Chip
                  key={p.id}
                  label={p.name}
                  active={point === p.id}
                  onPress={() => {
                    if (!loading) setPoint(p.id);
                  }}
                />
              ))}
            </View>
          </View>
        ) : null}
        <View style={s.section}>
          <Text style={s.label}>Beslemenin fotoğrafı</Text>
          {photo ? (
            <Image
              accessibilityLabel="Seçilen besleme fotoğrafı"
              source={{ uri: photo }}
              style={s.photo}
            />
          ) : (
            <View style={s.photoEmpty}>
              <Text style={{ fontSize: 30 }}>⌑</Text>
              <Text style={t.body}>Bıraktığın mama veya su görünsün</Text>
              <Text style={s.hint}>Yüzleri ve kişisel bilgileri kadraja alma.</Text>
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
        <View style={s.section}>
          <Text style={s.label}>Mama türü</Text>
          <View style={s.wrap}>
            {Object.entries(foodNames).map(([id, label]) => (
              <Chip
                key={id}
                label={label}
                active={food === id}
                onPress={() => {
                  if (!loading) setFood(id as FoodType);
                }}
              />
            ))}
          </View>
        </View>
        <Field
          label="Yaklaşık mama miktarı (gram)"
          placeholder="Örn. 250"
          value={grams}
          onChangeText={setGrams}
          keyboardType="number-pad"
          maxLength={6}
          editable={!loading}
        />
        <View style={s.wrap}>
          {[100, 250, 500, 1000].map((value) => (
            <Chip
              key={value}
              label={`${value} g`}
              active={grams === String(value)}
              onPress={() => {
                if (!loading) setGrams(String(value));
              }}
            />
          ))}
        </View>
        <Field
          label="Bıraktığın su (ml)"
          placeholder="Örn. 500 · bırakmadıysan boş bırak"
          value={water}
          onChangeText={setWater}
          keyboardType="number-pad"
          maxLength={6}
          editable={!loading}
        />
        <View style={s.wrap}>
          {[250, 500, 1000].map((value) => (
            <Chip
              key={value}
              label={`${value} ml`}
              active={water === String(value)}
              onPress={() => {
                if (!loading) setWater(String(value));
              }}
            />
          ))}
        </View>
        <Field
          label="Notun (isteğe bağlı)"
          placeholder="Beslemenin yeri veya kaplarla ilgili kısa bir not…"
          value={note}
          onChangeText={setNote}
          multiline
          maxLength={500}
          editable={!loading}
        />
        <Text style={s.hint}>
          Miktarlar tahminidir. Paylaşım, şu anda bırakılan mama/suya ait olmalıdır.
        </Text>
        {error ? <Notice text={error} error /> : null}
        <Button
          label="Beslemeyi kaydet"
          icon="checkmark-circle-outline"
          loading={loading}
          disabled={!point || !app.viewer}
          onPress={() => void save()}
        />
        <Text style={s.hint}>
          Gönderim sırasında bağlantı kesilirse aynı kaydı yeniden oluşturman gerekmez.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
export function ObserveScreen() {
  const {
      params: { id },
    } = useRoute<RouteProp<RootStack, 'Observe'>>(),
    app = useApp(),
    nav = useNavigation();
  const [point, setPoint] = useState(''),
    [points, setPoints] = useState<Point[]>([]),
    [food, setFood] = useState<BowlStatus>('unknown'),
    [water, setWater] = useState<BowlStatus>('unknown'),
    [note, setNote] = useState(''),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [done, setDone] = useState(false);
  const busy = useRef(false);
  useEffect(() => {
    void app
      .getPoints(id)
      .then((pts) => {
        setPoints(pts);
        setPoint(pts[0]?.id ?? '');
      })
      .catch(() => setError('Nokta yüklenemedi.'));
  }, [id]);
  async function save() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setError('');
    try {
      if (!app.online) throw new Error('Gözlem paylaşmak için internet bağlantısı gerekiyor.');
      if (food === 'unknown' && water === 'unknown')
        throw new Error('Gördüğünüz mama veya su durumunu seçin.');
      if (app.demo) app.observeDemo(id, food, water);
      else {
        let coords;
        try {
          coords = await getDeviceLocation();
        } catch (e) {
          setError(locationFailureMessage(e, Platform.OS === 'web'));
          return;
        }
        await submitObservation({
          point_id: point,
          food_status: food,
          water_status: water,
          note,
          reported_latitude: coords.latitude,
          reported_longitude: coords.longitude,
        });
      }
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Gözlem gönderilemedi.');
    } finally {
      setLoading(false);
      busy.current = false;
    }
  }
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={t.title}>Şu an ne görüyorsun?</Text>
      <Text style={t.body}>
        Mama bırakmadan da kapların durumunu paylaşabilirsin. Gözlemler zaman damgasıyla görünür.
      </Text>
      {done ? (
        <>
          <Notice
            text={
              app.demo
                ? 'Demo gözlemin bu cihazda kaydedildi.'
                : 'Gözlemin paylaşıldı. Diğer hayvanseverler güncel durumu görebilecek.'
            }
          />
          <Button label="Parka dön" onPress={() => nav.goBack()} />
        </>
      ) : (
        <>
          {points.length > 1 ? (
            <View style={s.wrap}>
              {points.map((p) => (
                <Chip
                  key={p.id}
                  label={p.name}
                  active={point === p.id}
                  onPress={() => setPoint(p.id)}
                />
              ))}
            </View>
          ) : null}
          <Text style={s.label}>Mama kabı</Text>
          <View style={s.wrap}>
            {Object.entries(bowlNames).map(([key, label]) => (
              <Chip
                key={key}
                label={label}
                active={food === key}
                onPress={() => setFood(key as BowlStatus)}
              />
            ))}
          </View>
          <Text style={s.label}>Su kabı</Text>
          <View style={s.wrap}>
            {Object.entries(bowlNames).map(([key, label]) => (
              <Chip
                key={key}
                label={label}
                active={water === key}
                onPress={() => setWater(key as BowlStatus)}
              />
            ))}
          </View>
          <Field
            label="Kısa not (isteğe bağlı)"
            value={note}
            onChangeText={setNote}
            maxLength={500}
            multiline
          />
          {error ? <Notice error text={error} /> : null}
          <Button
            label="Gözlemi paylaş"
            loading={loading}
            disabled={!point || !app.viewer}
            onPress={() => void save()}
          />
        </>
      )}
    </ScrollView>
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
