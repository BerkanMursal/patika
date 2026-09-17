import type { ExpoConfig } from 'expo/config';
if (
  process.env.PATIKA_RELEASE === '1' &&
  (!process.env.EXPO_PUBLIC_SUPABASE_URL || !process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
)
  throw new Error(
    'Üretim derlemesi için Supabase bağlantısı gerekli. Demo için preview profilini kullanın.',
  );
const config: ExpoConfig = {
  name: 'Patika',
  slug: 'patika',
  scheme: 'patika',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.ardaonur.patika',
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: {
    package: 'com.ardaonur.patika',
    adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#2C6953' },
    permissions: ['ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION', 'CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO'],
  },
  plugins: [
    [
      'expo-image-picker',
      {
        photosPermission:
          'Besleme kaydına fotoğraf eklemek için seçtiğiniz fotoğraflara erişim gerekir.',
        cameraPermission:
          'Bıraktığınız mama veya suyun fotoğrafını çekmek için kamera erişimi gerekir.',
        microphonePermission: false,
      },
    ],
    [
      'expo-location',
      {
        locationWhenInUsePermission: 'Yakınınızdaki parkları göstermek için konumunuzu kullanırız.',
      },
    ],
    'expo-secure-store',
    'expo-font',
  ],
  web: {
    bundler: 'metro',
    output: 'single',
    favicon: './assets/favicon.png',
    name: 'Patika — Bir kap, bir umut',
  },
  extra: { eas: { projectId: process.env.EXPO_PUBLIC_EAS_PROJECT_ID } },
};
export default config;
