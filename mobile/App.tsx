import React, { useEffect } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  DefaultTheme,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as Linking from 'expo-linking';
import { StatusBar } from 'expo-status-bar';
import type { RootStack } from './src/navigation';
import { AppProvider, useApp } from './src/state/AppProvider';
import { supabase } from './src/services/supabase';
import { C } from './src/ui/theme';
import { Button, Icon, textStyles as t } from './src/ui/common';
import { ExploreScreen } from './src/screens/ExploreScreen';
import { ParkScreen } from './src/screens/ParkScreen';
import { RecordScreen, ObserveScreen } from './src/screens/RecordScreen';
import { AuthScreen, ResetScreen } from './src/screens/AuthScreen';
import {
  HistoryScreen,
  MyHistoryScreen,
  FavoritesScreen,
  OutboxScreen,
} from './src/screens/HistoryScreen';
import { ProfileScreen, AboutScreen, PrivacyScreen } from './src/screens/ProfileScreen';
import { ReportScreen, ModerationScreen } from './src/screens/ReportScreen';
import { NameSuggestionScreen, NameReviewScreen } from './src/screens/NameSuggestionScreen';
import { LeaderboardScreen } from './src/screens/LeaderboardScreen';
import { RescueReportScreen } from './src/screens/RescueReportScreen';
import { RescueCaseScreen } from './src/screens/RescueCaseScreen';
const Stack = createNativeStackNavigator<RootStack>(),
  Tabs = createBottomTabNavigator(),
  ref = createNavigationContainerRef<RootStack>();
function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.green,
        tabBarInactiveTintColor: '#A0ADA0',
        tabBarStyle: {
          backgroundColor: C.white,
          borderTopColor: C.line,
          height: 74,
          paddingBottom: 12,
          paddingTop: 9,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="Explore"
        component={ExploreScreen}
        options={{
          title: 'Keşfet',
          tabBarIcon: ({ color }) => <Icon name="map-outline" color={color} size={23} />,
        }}
      />
      <Tabs.Screen
        name="Activity"
        component={HistoryScreen}
        options={{
          title: 'İyilik akışı',
          tabBarIcon: ({ color }) => <Icon name="heart-outline" color={color} size={23} />,
        }}
      />
      <Tabs.Screen
        name="Profile"
        component={ProfileScreen}
        options={{
          title: 'Benim Patikam',
          tabBarIcon: ({ color }) => <Icon name="person-outline" color={color} size={23} />,
        }}
      />
    </Tabs.Navigator>
  );
}
function AppNavigation() {
  const app = useApp();
  useEffect(() => {
    async function handle(url: string) {
      if (Platform.OS === 'web' || !supabase) return;
      const parsed = Linking.parse(url);
      const code = parsed.queryParams?.code;
      if (typeof code === 'string') {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error && url.includes('reset') && ref.isReady()) ref.navigate('Reset');
      }
    }
    void Linking.getInitialURL().then((url) => {
      if (url) void handle(url);
    });
    const subscription = Linking.addEventListener('url', ({ url }) => void handle(url));
    const auth = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' && ref.isReady()) ref.navigate('Reset');
    });
    return () => {
      subscription.remove();
      auth?.data.subscription.unsubscribe();
    };
  }, []);
  if (!app.ready)
    return (
      <View
        style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: C.bg }}
      >
        <ActivityIndicator color={C.green} />
      </View>
    );
  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: C.bg }}
      edges={['top', 'left', 'right', 'bottom']}
    >
      <StatusBar style="dark" />
      {app.demo ? (
        <View
          style={{
            backgroundColor: '#EEF1E5',
            paddingVertical: 6,
            paddingHorizontal: 12,
            alignItems: 'center',
          }}
        >
          <Text style={{ fontSize: 10, color: '#7D8D65' }}>
            DEMO · Örnek kayıtlar · Gerçek saha verisi değildir
          </Text>
        </View>
      ) : null}
      {!app.online ? (
        <View style={{ backgroundColor: '#FFF1DF', padding: 7 }}>
          <Text style={{ fontSize: 11, color: C.amber, textAlign: 'center' }}>
            Çevrimdışısın · Son yüklenen veriler gösteriliyor
          </Text>
        </View>
      ) : null}
      <NavigationContainer
        ref={ref}
        theme={{
          ...DefaultTheme,
          colors: {
            ...DefaultTheme.colors,
            background: C.bg,
            primary: C.green,
            card: C.white,
            text: C.ink,
            border: C.line,
          },
        }}
        linking={{
          prefixes: [Linking.createURL('/'), 'patika://'],
          config: {
            initialRouteName: 'Main',
            screens: {
              Main: { path: '', screens: { Explore: '', Activity: 'akis', Profile: 'profil' } },
              Park: 'park/:id',
              Record: 'kayit/:id',
              Observe: 'gozlem/:id',
              Auth: 'giris',
              Reset: 'reset',
              Outbox: 'bekleyenler',
              MyHistory: 'gecmisim',
              Favorites: 'takipler',
              About: 'hakkinda',
              Privacy: 'gizlilik',
              Report: 'bildir',
              Moderation: 'inceleme',
              SuggestName: 'park-adi/:id',
              NameReview: 'park-adi-inceleme',
              Leaderboard: 'siralama',
              RescueReport: 'yarali-hayvan',
              RescueCase: 'vaka/:id',
            },
          },
        }}
      >
        <Stack.Navigator
          screenOptions={{
            headerShadowVisible: false,
            headerStyle: { backgroundColor: C.bg },
            headerTintColor: C.green,
            headerTitleStyle: { fontSize: 15, fontWeight: '600' },
            headerBackTitle: 'Geri',
            contentStyle: { backgroundColor: C.bg },
          }}
        >
          <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
          <Stack.Screen
            name="SuggestName"
            component={NameSuggestionScreen}
            options={{ title: 'Park adı öner' }}
          />
          <Stack.Screen
            name="NameReview"
            component={NameReviewScreen}
            options={{ title: 'Park adı inceleme' }}
          />
          <Stack.Screen name="Park" component={ParkScreen} options={{ title: 'Park ayrıntısı' }} />
          <Stack.Screen
            name="Record"
            component={RecordScreen}
            options={{ title: 'Besleme kaydı' }}
          />
          <Stack.Screen
            name="Observe"
            component={ObserveScreen}
            options={{ title: 'Durum gözlemi' }}
          />
          <Stack.Screen name="Auth" component={AuthScreen} options={{ title: 'Patika’ya katıl' }} />
          <Stack.Screen name="Reset" component={ResetScreen} options={{ title: 'Şifre yenile' }} />
          <Stack.Screen
            name="Outbox"
            component={OutboxScreen}
            options={{ title: 'Kayıt durumu' }}
          />
          <Stack.Screen
            name="MyHistory"
            component={MyHistoryScreen}
            options={{ title: 'Paylaşımlarım' }}
          />
          <Stack.Screen
            name="Favorites"
            component={FavoritesScreen}
            options={{ title: 'Takiplerim' }}
          />
          <Stack.Screen name="About" component={AboutScreen} options={{ title: 'Patika' }} />
          <Stack.Screen name="Privacy" component={PrivacyScreen} options={{ title: 'Gizlilik' }} />
          <Stack.Screen
            name="Report"
            component={ReportScreen}
            options={{ title: 'Sorun bildir' }}
          />
          <Stack.Screen
            name="Moderation"
            component={ModerationScreen}
            options={{ title: 'İnceleme' }}
          />
          <Stack.Screen
            name="Leaderboard"
            component={LeaderboardScreen}
            options={{ title: 'Sıralama' }}
          />
          <Stack.Screen
            name="RescueReport"
            component={RescueReportScreen}
            options={{ title: 'Yaralı hayvan bildir' }}
          />
          <Stack.Screen
            name="RescueCase"
            component={RescueCaseScreen}
            options={{ title: 'Vaka durumu' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaView>
  );
}
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <View
        style={{ flex: 1, padding: 30, justifyContent: 'center', gap: 20, backgroundColor: C.bg }}
      >
        <Text style={t.title}>Bir şeyler ters gitti.</Text>
        <Text style={t.body}>
          Ekranı tekrar açabilirsiniz. Cihazda saklanan bekleyen kayıtlar korunur.
        </Text>
        <Button label="Tekrar dene" onPress={() => this.setState({ failed: false })} />
      </View>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AppProvider>
          <AppNavigation />
        </AppProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
