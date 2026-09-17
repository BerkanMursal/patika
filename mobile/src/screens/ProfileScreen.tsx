import React, { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStack } from '../navigation';
import { useApp } from '../state/AppProvider';
import { Button, Card, Field, Icon, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
import { requireBackend } from '../services/supabase';
import { parkDataSources } from '../core/data-sources';
export function ProfileScreen() {
  const app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>(),
    [editing, setEditing] = useState(false),
    [name, setName] = useState(''),
    [deleting, setDeleting] = useState(false),
    [confirmation, setConfirmation] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function logout() {
    try {
      await app.logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Çıkış yapılamadı.');
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      if (confirmation !== 'SİL') throw new Error('Onay için SİL yazın.');
      if (app.queue.length) throw new Error('Önce bekleyen kayıtları gönderin veya iptal edin.');
      if (!app.demo) {
        const { error } = await requireBackend().functions.invoke('delete-account', {
          body: { confirm: 'DELETE' },
        });
        if (error) throw error;
      }
      await app.logout();
      setDeleting(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Hesap silinemedi.');
    } finally {
      setBusy(false);
    }
  }
  const rows = [
    {
      title: 'Bıraktığım izler',
      detail: 'Paylaştığım beslemeler',
      icon: 'paw-outline',
      route: 'MyHistory',
    },
    {
      title: 'Takip ettiğim parklar',
      detail: `${app.favorites.length} park`,
      icon: 'heart-outline',
      route: 'Favorites',
    },
    {
      title: 'Bekleyen kayıtlar',
      detail: `${app.queue.length} kayıt · ${app.online ? 'Çevrimiçi' : 'Çevrimdışı'}`,
      icon: 'cloud-upload-outline',
      route: 'Outbox',
    },
    { title: 'Patika hakkında', detail: 'Bir kap, bir umut', icon: 'leaf-outline', route: 'About' },
    {
      title: 'Gizlilik ve topluluk',
      detail: 'Verilerin ve paylaşım kuralları',
      icon: 'shield-checkmark-outline',
      route: 'Privacy',
    },
  ] as const;
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={t.eyebrow}>İYİLİK SENİNLE BAŞLAR</Text>
      <Text style={t.title}>Benim Patikam</Text>
      <Card style={{ alignItems: 'center', gap: 12, padding: 30 }}>
        <View style={s.avatar}>
          <Icon name="paw" size={35} color={C.lime} />
        </View>
        <Text style={t.h2}>{app.viewer?.name ?? 'Merhaba, hayvansever'}</Text>
        <Text style={[t.body, { textAlign: 'center' }]}>
          {app.viewer?.email ??
            (app.demo
              ? 'Örnek verilerle uygulamayı keşfet.'
              : 'Parkları görmek için hesap gerekmez.')}
        </Text>
        {app.viewer ? (
          <Pressable
            onPress={() => {
              setName(app.viewer?.name ?? '');
              setEditing(!editing);
            }}
          >
            <Text style={s.link}>Görünen adımı düzenle</Text>
          </Pressable>
        ) : (
          <Button
            label={app.demo ? 'Demoya katıl' : 'Giriş yap / hesap oluştur'}
            onPress={() => nav.navigate('Auth')}
          />
        )}
      </Card>
      {editing ? (
        <Card style={{ gap: 12 }}>
          <Field label="Görünen adın" value={name} onChangeText={setName} maxLength={40} />
          <Button
            label="Adımı kaydet"
            onPress={() =>
              void app
                .rename(name)
                .then(() => setEditing(false))
                .catch((e) => setError(e.message))
            }
          />
        </Card>
      ) : null}
      <Card style={{ padding: 6 }}>
        {rows.map((row) => (
          <Pressable
            key={row.route}
            accessibilityRole="button"
            onPress={() => nav.navigate(row.route)}
            style={s.row}
          >
            <View style={s.rowIcon}>
              <Icon name={row.icon} size={21} />
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={s.rowTitle}>{row.title}</Text>
              <Text style={s.rowDetail}>{row.detail}</Text>
            </View>
            <Icon name="chevron-forward" size={17} color={C.muted} />
          </Pressable>
        ))}
      </Card>
      {app.viewer?.moderator ? (
        <View style={{ gap: 10 }}>
          <Button
            secondary
            label="Bildirimleri incele"
            onPress={() => nav.navigate('Moderation')}
          />
          <Button
            secondary
            label="Park adı önerilerini incele"
            onPress={() => nav.navigate('NameReview')}
          />
        </View>
      ) : null}
      {error ? <Notice error text={error} /> : null}
      {app.viewer ? (
        <>
          <Button secondary label="Çıkış yap" onPress={() => void logout()} />
          <Pressable
            onPress={() => setDeleting(!deleting)}
            style={{ alignItems: 'center', padding: 12 }}
          >
            <Text style={{ color: C.red, fontSize: 12 }}>Hesabımı sil</Text>
          </Pressable>
          {deleting ? (
            <Card style={{ gap: 14 }}>
              <Notice
                error
                text={
                  app.demo
                    ? 'Demo oturumun kapatılacak.'
                    : 'Hesabın, yüklediğin fotoğraflar, beslemeler, gözlemler ve takiplerin kalıcı olarak silinecek.'
                }
              />
              <Field
                label="Onaylamak için SİL yaz"
                value={confirmation}
                onChangeText={setConfirmation}
              />
              <Button
                label="Hesabımı kalıcı sil"
                destructive
                disabled={confirmation !== 'SİL'}
                loading={busy}
                onPress={() => void remove()}
              />
            </Card>
          ) : null}
        </>
      ) : null}
      <Text style={s.version}>Patika 1.0.0 · Her pati için bir umut</Text>
    </ScrollView>
  );
}
export function AboutScreen() {
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      <View style={s.avatar}>
        <Icon name="paw" size={38} color={C.lime} />
      </View>
      <Text style={t.title}>Bir kap, bir umut.</Text>
      <Text style={t.body}>
        Patika, parklardaki sokak hayvanları için mama ve su bırakılmasını görünür kılar. Park seç,
        geçmişe bak, sahada besleme yap ve fotoğrafıyla paylaş.
      </Text>
      <Card style={{ gap: 14 }}>
        <Text style={t.h2}>Kayıtlar bize ne söyler?</Text>
        <Text style={t.body}>
          Bir kayıt, bir kişinin o saatte mama veya su bıraktığını beyan eder. Kalan miktarı, tüm
          beslemeleri veya hayvanların sağlık durumunu kanıtlamaz.
        </Text>
        <Text style={t.body}>
          Eski kayıtlar kontrol ihtiyacını gösterir. Bir parkta kayıt olmaması, orada hiç besleme
          yapılmadığı anlamına gelmez.
        </Text>
      </Card>
      <Card style={{ gap: 12 }}>
        <Text style={t.h2}>Harita ve parklar</Text>
        <Text style={t.body}>
          Harita © OpenStreetMap katkıcılarıdır (ODbL). Türkiye park kapsamı kaynak veriye bağlıdır;
          eksik veya hatalı park bilgilerini bildirebilirsin. Harita indirme veya çevrimdışı harita
          özelliği yoktur.
        </Text>
        <Text style={t.body}>
          Adı eksik parklar kısa bir kodla gösterilir. Belediye adları ve adresleri konum/ad
          eşleştirmesiyle eklenir; il ve ilçe bilgileri 2021 sınır verisinden türetilir. Kaynaklar
          eksik veya güncelliğini yitirmiş olabilir.
        </Text>
        {parkDataSources.map((source) => (
          <View key={source.url} style={{ gap: 4 }}>
            <Button
              secondary
              label={source.name}
              onPress={() => void Linking.openURL(source.url)}
            />
            <Text style={t.body}>{source.license}</Text>
          </View>
        ))}
      </Card>
      <Text style={t.body}>Arda · Seyfi · Berkan</Text>
    </ScrollView>
  );
}
export function PrivacyScreen() {
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={t.title}>Gizlilik ve topluluk</Text>
      <Notice text="Geliştirme sürümü. Canlı kullanıma açılmadan önce hizmeti işleten kişinin iletişim bilgileri ve geçerli gizlilik metni tamamlanmalıdır." />
      {[
        [
          'Hangi bilgiler kullanılır?',
          'Hesap için e-posta ve görünen ad; paylaşım için park/nokta, fotoğraf, yaklaşık miktar, not ve zaman bilgisi işlenir. Şifren kimlik hizmetince korunur. Konum izni yalnızca yakın parkları bulmak içindir; sürekli konum takibi yapılmaz.',
        ],
        [
          'Kimler görebilir?',
          'Park ve yayınlanmış besleme geçmişi görüntülenebilir. Fotoğraflara oturum açmış kullanıcılar süreli bağlantıyla erişir. E-postan diğer kullanıcılara gösterilmez.',
        ],
        [
          'Cihazda saklananlar',
          'Oturum ve son yüklenen parklar cihazda saklanır. Bekleyen besleme ve fotoğraflar gönderim tamamlanana kadar tutulur. Demo kayıtları yalnızca bu cihazda bulunur.',
        ],
        [
          'Hesap ve kayıt silme',
          'Kendi kayıtlarını geçmiş ekranından kaldırabilir, profilinden hesabını silebilirsin. Hesap silme, o hesaba bağlı fotoğrafları ve kişisel kayıtları kaldırır.',
        ],
        [
          'Saygılı ve doğru paylaşım',
          'Yalnızca kendi yaptığın beslemeyi paylaş. Fotoğraflarda yüz, plaka ve kişisel bilgi bulunmamasına dikkat et. Hayvanlara zarar veren, yanıltıcı veya taciz içeren içerik paylaşma. Uygunsuz kayıtları bayrak simgesinden bildirebilirsin.',
        ],
        [
          'Sahadaki davranış',
          'Çevreyi temiz bırak, kapları kontrol et ve hayvanları rahatsız etme. Patika acil veteriner hizmeti veya ihbar hattı değildir.',
        ],
      ].map(([title, body]) => (
        <Card key={title} style={{ gap: 12 }}>
          <Text style={t.h2}>{title}</Text>
          <Text style={t.body}>{body}</Text>
        </Card>
      ))}
      <Text style={s.version}>Metin sürümü: 13 Eylül 2026</Text>
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 24,
    gap: 19,
    maxWidth: 720,
    width: '100%',
    alignSelf: 'center',
    paddingBottom: 40,
  },
  avatar: {
    width: 79,
    height: 79,
    borderRadius: 29,
    backgroundColor: C.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  link: { fontSize: 12, color: C.green, padding: 7 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    padding: 17,
    borderBottomWidth: 1,
    borderColor: '#F1F4EE',
  },
  rowIcon: {
    height: 38,
    width: 38,
    borderRadius: 12,
    backgroundColor: C.soft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowTitle: { fontSize: 14, fontWeight: '600', color: C.ink },
  rowDetail: { fontSize: 11, color: C.muted },
  version: { textAlign: 'center', fontSize: 11, color: C.muted, padding: 10 },
});
