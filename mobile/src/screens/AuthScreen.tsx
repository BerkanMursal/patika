import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Linking from 'expo-linking';
import type { RootStack } from '../navigation';
import { useApp } from '../state/AppProvider';
import { requireBackend } from '../services/supabase';
import { Button, Chip, Field, Icon, Notice, textStyles as t } from '../ui/common';
import { C } from '../ui/theme';
export function AuthScreen() {
  const app = useApp(),
    nav = useNavigation<NativeStackNavigationProp<RootStack>>();
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>('login'),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState(''),
    [consent, setConsent] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function submit() {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      if (app.demo) {
        await app.enterDemo(name || 'Hayvansever');
        nav.goBack();
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        throw new Error('Geçerli bir e-posta adresi yazın.');
      const client = requireBackend();
      if (mode === 'forgot') {
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: Linking.createURL('reset'),
        });
        if (error) throw error;
        setMessage('Bu adresle bir hesabınız varsa şifre yenileme bağlantısı gönderildi.');
        return;
      }
      if (mode === 'signup') {
        if (password.length < 10) throw new Error('Şifreniz en az 10 karakter olmalı.');
        if (!consent)
          throw new Error('Gizlilik metnini ve topluluk kurallarını okuyup kabul edin.');
        if (name.trim().length < 2 || name.trim().length > 40)
          throw new Error('Görünen adınız 2–40 karakter olmalı.');
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: {
            emailRedirectTo: Linking.createURL('giris'),
            data: { display_name: name.trim(), terms_version: '2026-09-13' },
          },
        });
        if (error) throw error;
        if (data.session) nav.goBack();
        else setMessage('Giriş yapmadan önce e-postanıza gelen doğrulama bağlantısını açın.');
      } else {
        const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error)
          throw new Error(
            'Giriş yapılamadı. E-posta, şifre ve e-posta doğrulamasını kontrol edin.',
          );
        nav.goBack();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'İşlem tamamlanamadı. Biraz sonra tekrar deneyin.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={s.page}
        contentContainerStyle={s.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={s.hero}>
          <View style={s.mark}>
            <Icon name="paw" size={41} color={C.lime} />
          </View>
          <Text style={t.eyebrow}>İYİLİĞE BİR İZ BIRAK</Text>
          <Text style={[t.title, { textAlign: 'center', fontSize: 31 }]}>
            Birlikte, daha çok patiye ulaşalım.
          </Text>
          <Text style={[t.body, { textAlign: 'center' }]}>
            Parkları keşfet, besleme paylaş, yakınındaki dostlarımızı takip et.
          </Text>
        </View>
        {app.demo ? (
          <>
            <Notice text="Demo modundasın. Gerçek hesap oluşturulmaz; paylaşımların yalnızca bu cihazda saklanır." />
            <Field
              label="Demo için görünen adın"
              value={name}
              onChangeText={setName}
              placeholder="Adın"
              maxLength={40}
            />
          </>
        ) : (
          <>
            {mode !== 'forgot' ? (
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Chip
                  label="Giriş yap"
                  active={mode === 'login'}
                  onPress={() => {
                    setMode('login');
                    setError('');
                  }}
                />
                <Chip
                  label="Hesap oluştur"
                  active={mode === 'signup'}
                  onPress={() => {
                    setMode('signup');
                    setError('');
                  }}
                />
              </View>
            ) : (
              <Text style={t.h2}>Şifreni yenile</Text>
            )}
            {mode === 'signup' ? (
              <Field
                label="Görünen adın"
                value={name}
                onChangeText={setName}
                maxLength={40}
                autoComplete="name"
              />
            ) : null}
            <Field
              label="E-posta adresin"
              value={email}
              onChangeText={setEmail}
              placeholder="ornek@eposta.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
            />
            {mode !== 'forgot' ? (
              <Field
                label="Şifren"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              />
            ) : null}
            {mode === 'signup' ? (
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: consent }}
                onPress={() => setConsent(!consent)}
                style={s.consent}
              >
                <Icon name={consent ? 'checkbox' : 'square-outline'} size={23} />
                <Text style={s.consentText}>
                  Gizlilik metnini ve topluluk kurallarını okudum, kabul ediyorum.
                </Text>
              </Pressable>
            ) : null}
          </>
        )}
        {error ? <Notice text={error} error /> : null}
        {message ? <Notice text={message} /> : null}
        <Button
          label={
            app.demo
              ? 'Demoyu dene'
              : mode === 'login'
                ? 'Giriş yap'
                : mode === 'signup'
                  ? 'Hesap oluştur'
                  : 'Yenileme bağlantısı gönder'
          }
          loading={loading}
          onPress={() => void submit()}
        />
        {!app.demo ? (
          <Pressable
            onPress={() => {
              setMode(mode === 'forgot' ? 'login' : 'forgot');
              setError('');
              setMessage('');
            }}
            style={s.link}
          >
            <Text style={s.linkText}>{mode === 'forgot' ? 'Girişe dön' : 'Şifremi unuttum'}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => nav.navigate('Privacy')} style={s.link}>
          <Text style={s.linkText}>Gizlilik ve topluluk kuralları</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
export function ResetScreen() {
  const nav = useNavigation<NativeStackNavigationProp<RootStack>>(),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  async function save() {
    setLoading(true);
    try {
      if (password.length < 10) throw new Error('Şifreniz en az 10 karakter olmalı.');
      const { error } = await requireBackend().auth.updateUser({ password });
      if (error) throw error;
      nav.replace('Main');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Şifre yenilenemedi.');
    } finally {
      setLoading(false);
    }
  }
  return (
    <ScrollView style={s.page} contentContainerStyle={s.content}>
      <Text style={t.title}>Yeni şifren</Text>
      <Text style={t.body}>Bu ekranı e-postandaki yenileme bağlantısından açmalısın.</Text>
      <Field
        label="Yeni şifre"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="new-password"
      />
      {error ? <Notice error text={error} /> : null}
      <Button label="Şifremi güncelle" loading={loading} onPress={() => void save()} />
    </ScrollView>
  );
}
const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: {
    padding: 27,
    paddingVertical: 30,
    gap: 18,
    maxWidth: 500,
    width: '100%',
    alignSelf: 'center',
  },
  hero: { alignItems: 'center', gap: 18, marginBottom: 16 },
  mark: {
    width: 87,
    height: 87,
    borderRadius: 31,
    backgroundColor: C.green,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  consent: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  consentText: { flex: 1, fontSize: 12, lineHeight: 20, color: C.muted },
  link: { alignItems: 'center', padding: 6 },
  linkText: { color: C.green, fontSize: 13 },
});
