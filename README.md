# Patika — Bir kap, bir umut

Parklardaki sokak hayvanları için fotoğraflı mama ve su paylaşım uygulaması. Ekip: Arda, Seyfi, Berkan.

- **Mobil uygulama:** `mobile/` — React Native + Expo 57; Android, iOS ve web kaynak kodu.
- **Web deneme sürümü:** https://patika-mobile.vercel.app — ortak backend bağlanana kadar demo.
- **Mimari atlası:** depo kökündeki Next.js uygulaması; https://patika-project.vercel.app
- **Backend:** `supabase/` — PostgreSQL/PostGIS şeması, RLS, doğrulanan RPC'ler, özel fotoğraf depolama ve hesap silme işlevi.
- **Gerçek park kataloğu:** OpenStreetMap'ten 13 Eylül 2026 tarihli 24.669 kaynak kaydı. Türkiye'deki bütün fiziksel parkların eksiksiz veya tekil listesi olduğu iddia edilmez.

Harita ve arama, park geçmişi, fotoğraflı gram/ml kaydı, kap gözlemi, takipler, profil, giriş/kayıt/şifre yenileme, cihazda bekleyen gönderimler, bildirim/moderasyon ve hesap silme akışları kodlandı. Miktarlar beyana dayanır; fotoğraf otomatik doğrulanmaz. Push bildirimleri bu sürüme dahil değildir.

**Supabase hesabı henüz bağlı değil.** Deneme sürümü açık bir DEMO etiketi taşır; besleme örnekleri ve sizin denemeleriniz yalnızca cihazda tutulur. Canlı servis, mağaza yayını ve fiziksel telefon doğrulaması tamamlanmış değildir. EAS üretim derlemesi bağlantı değerleri yoksa durur.

## Çalıştırma

```sh
cd mobile
npm ci
npm run web
```

Mobil geliştirme: `npm start` veya Android SDK ile `npm run android`. Mimari atlası için depo kökünde `npm ci` ve `npm run dev`.

## Doğrulama

```sh
cd mobile
npm run typecheck
npm test
npm run format:check
npm run export:web
npm run export:native -- --max-workers 2
```

SQL erişim kuralları ve iş kuralları PGlite üzerinde çalıştırılır; bu testler gerçek Supabase Auth/Storage HTTP servisini veya PostGIS uzantısını doğrulamaz. Tarayıcıdaki fotoğraflı kayıt ve kalıcılık akışı ayrıca kontrol edildi. Android ARM64 test APK'sı yerelde derlendi. Ayrıntılar [doğrulama raporunda](docs/VERIFICATION.md).

- [Kurulum ve canlıya geçiş](docs/SETUP.md)
- [Uygulama mimarisi ve veri ilişkileri](docs/ARCHITECTURE.md)
- [Veri kaynakları ve lisanslar](docs/THIRD_PARTY.md)

İki bağımsız npm paketi aynı özel depoda bulunur. `.env*`, yönetici anahtarları, yerel SDK çıktıları ve APK dosyaları Git'e eklenmez. `mobile/.env.example` yalnızca boş public bağlantı alanlarını içerir. GitHub Actions tip kontrolü, testler ve paket dışa aktarımlarını çalıştıracak şekilde hazırdır.
