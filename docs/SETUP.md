# Patika kurulumu

Bu dosya kurulumu yürüten geliştirici veya AI içindir. Arda, Seyfi ve Berkan'ın kodlama eğitimi alması gerekmez.

## Mevcut durum

`mobile/` gerçek React Native/Expo uygulamasıdır. Android APK yerelde derlenebilir; iOS için aynı kaynak kodu ve EAS yapılandırması bulunur. Supabase bağlantısı yoksa uygulama demo etiketiyle, cihazdaki kayıtlarla çalışır. Canlı Supabase projesi henüz oluşturulmadı.

## Bilgisayarda çalıştırma

Node 22.18 veya Expo 57'nin desteklediği daha yeni bir Node sürümü:

```sh
cd mobile
npm ci
npm start
```

Tarayıcı: `npm run web`. Android geliştirme derlemesi: Android SDK/JDK 17 ile `npm run android`. iOS yerel derlemesi macOS ve Xcode ister. EAS alternatifi aşağıdadır.

## Supabase hesabı bağlandığında

1. Hesabın sahibi Supabase üzerinde bir proje oluşturur. Proje adresi yeterlidir; şifreleri veya yönetici anahtarını sohbetten paylaşmayın. Kurulum yapan AI, bağlı hesabın yetkili CLI oturumunu kullanır.
2. Depo kökünde `npx supabase login`, ardından `npx supabase link --project-ref PROJE_REFERANSI` çalıştırılır. Yerel deneme için Docker açıkken `npx supabase start` kullanılabilir.
3. `npx supabase db push` ile `supabase/migrations` uygulanır. Şema kullanıcılar, parklar, noktalar, beslemeler, gözlemler, takipler, engellemeler, şikâyetler, erişim politikaları ve özel fotoğraf bucket'ını oluşturur. Seed, gerçek besleme üretmez.
4. `npx supabase functions deploy delete-account --project-ref PROJE_REFERANSI` çalıştırılır. İşlev erişim token'ını Supabase Auth ile doğrular; kullanıcı kimliğini istek gövdesinden kabul etmez. Yönetici anahtarı yalnızca Supabase işlev ortamında kalır.
5. Park aktarımı için özel terminal ortamına `SUPABASE_URL` ve `SUPABASE_SERVICE_ROLE_KEY` tanımlanır; depo kökünde `node scripts/import-parks.mjs` çalıştırılır. Anahtar loglanmaz, dosyaya veya uygulama paketine yazılmaz. Aktarım 200'lük gruplarla tekrarlanabilir; yayınlanmış besleme eklemez.
6. `mobile/.env.example`, git tarafından yok sayılan `mobile/.env.local` içine kopyalanır. `EXPO_PUBLIC_SUPABASE_URL` ve `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` doldurulur. Bu iki değer uygulamada görünür; erişimi RLS ve doğrulanan oturum belirler. **Service role / secret key asla EXPO_PUBLIC\_ altında bulunmamalıdır.**
7. Auth URL Configuration içine mobil `patika://giris`, `patika://reset` ve yayımlanan web adresinin `/giris`, `/reset` yolları eklenir. Site URL gerçek web adresidir. Test adresleri üretimde gerekiyorsa ayrı geliştirme projesinde tutulur. E-posta doğrulaması açık tutulur; genel kullanımdan önce gönderici alan adı ve SMTP yapılandırılır. Parola alt sınırı 10 karakter yapılır.
8. Vercel'deki `patika-mobile` projesine iki public bağlantı değeri eklenir ve yeniden derlenir. EAS üretim ortamına da aynı değerler eklenir. Ortam değişiklikleri yeni uygulama paketi gerektirir.
9. Giriş, e-posta doğrulama, şifre yenileme, kamera izinleri, iki farklı cihazdan paylaşım, çevrimdışı kuyruk, moderasyon ve hesap silme akışları gerçek proje ve cihazlarla doğrulanır.

Üretim EAS profili `PATIKA_RELEASE=1` kullanır; Supabase değerleri olmadan derleme bilerek durur. Böylece demo paketi yanlışlıkla mağaza sürümü olamaz.

## Moderasyon

Moderatörlük yalnızca Supabase Auth yönetici API'sinden `app_metadata.role = moderator` atanmış hesaplara verilir. Kullanıcının düzenleyebildiği `user_metadata` yetki kaynağı değildir. Örnek `scripts/set-moderator.mjs` yalnızca özel terminalde yönetici anahtarıyla çalışır. Bildirimdeki içerik ve fotoğraf açıldıktan sonra gizleme yapılabilir. Parkı gizlemek o parkı genel görünümden kaldırır; beslemeler korunur.

`202609130002_park_names.sql` migration'ı park adı önerilerini ekler. Park ayrıntısı → Park adı öner / Ad düzeltmesi öner yolundan ad ve doğrulama açıklaması alınır. Öneri onaylanmadan park adı değişmez. Kullanıcı yalnızca kendi önerilerini görür; profilindeki Park adı önerilerini incele bağlantısı yetkili moderatöre görünür. Moderatör kaynak/konumu açıp gerekçe ekler; kendi önerisini onaylayamaz. Aynı kullanıcı/park için tek bekleyen öneri ve günlük 20 öneri sınırı vardır. Kabul edilen ad sonraki OSM aktarımında korunur; öneriden sonra adı değişen parka eski öneri uygulanmaz. Demo sürümünde öneriler yalnızca cihazda saklanır ve gerçek inceleme yapılmaz.

## Android / iOS paketleri

```sh
cd mobile
npx eas-cli login
npx eas-cli init
npx eas-cli build --platform android --profile preview
npx eas-cli build --platform ios --profile preview
```

`EXPO_PUBLIC_EAS_PROJECT_ID` hesabın gerçek proje kimliğidir. EAS işleri servis kotasına bağlıdır. iOS cihaz dağıtımı Apple hesabı, sertifika ve cihaz kaydı gerektirebilir. Mağaza için `--profile production` kullanılır; `eas submit` ancak mağaza hesapları ve yayın bilgileri tamamlandığında çalıştırılır. Burada mağazaya gönderim yapılmadı.

Yerel Android APK, Expo prebuild ile üretilen Gradle projesinden `assembleRelease -PreactNativeArchitectures=arm64-v8a` komutuyla derlendi. Bu paket **test imzası** kullanır, mağaza imzası değildir. Android 7+ ARM64 içindir. Diğer işlemci mimarileri ayrı derlenir.

## Park verisini güncelleme

### Haritada park alanları

Park sınırları OSM kimliğiyle katalog kayıtlarına bağlanır. Geçerli kapalı alanlar, çok parçalı parklar ve iç boşluklar korunur. Nokta olarak kayıtlı veya eksik geometrili parklara tahmini sınır çizilmez. Haritada 12. yakınlaştırma seviyesinden itibaren yeşil dolgu ve sınır çizgisi görünür; alana dokunmak parkı seçer. **Park alanları** düğmesi katmanı açar/kapatır.

```sh
node scripts/download-park-boundaries.mjs
node scripts/build-park-boundaries.mjs
cd mobile
npm run build:map
```

İndirme yarıda kalırsa `.local/boundary-download/` içindeki tamamlanan gruplarla devam eder. Yeni bir kaynak güncellemesi için `node scripts/download-park-boundaries.mjs --fresh` kullanılır. Başarısız sorgu yayımlanan snapshot'ı değiştirmez.

`mobile/public/data/park-boundaries/manifest.json` kapsam, kaynak tarihleri ve dosya listesini içerir. Veriler Expo web çıktısında statik dosya olarak yayımlanır; Android/iOS aynı dosyaları HTTPS üzerinden alır. Harita yalnızca görünür parkların bölge dosyalarını ister, en fazla üç eşzamanlı istek ve sınırlı bellek önbelleği kullanır. Bu katman internet bağlantısı gerektirir. Supabase kurulumu gerektirmez.

Mevcut 13 Eylül 2026 snapshot'ı doğrudan aktarılabilir. Kaynağı yenilemek gerekirse:

```sh
node scripts/import-parks.mjs --download --download-only
node scripts/build-catalog.mjs
node scripts/import-parks.mjs
```

Belediye snapshot'ları ve ilçe eşleştirmesi katalog derlemesine dahildir. Mevcut, sürümlenen dosyalarla `node scripts/build-catalog.mjs` ağ kullanmadan tekrarlanabilir. Kaynakları yenilemek için `node scripts/refresh-park-enrichment.mjs`, ardından katalog komutu çalıştırılır; diff, kaynak adları, koordinat eşleşmeleri ve `data/park-enrichment/summary.json` incelenir. İndirme başarısızsa eski snapshot'lar korunur. Yeni sağlayıcı eklerken kaynak ve lisans manifesti de eklenir; yakınlık tek başına yeterli eşleşme sayılmaz. Supabase aktarımı öncesi yeni migration uygulanmalıdır.

Tekrar eden, isimsiz veya yanlış sınıflandırılmış OSM öğeleri bulunabilir. 24.669 kaynak kaydı bütün fiziksel parkların eksiksiz veya tekil sayısı değildir. İl eşleştirmesi basitleştirilmiş 2021 sınırlarıyla yapılır; 76 kayıt eşleşmedi. Hata bildirimleri moderatörce incelenir. İçe aktarma gizlenmiş parkı yeniden açmaz; kaynaktan silinen parkı otomatik silmez.

## Canlı kullanıma geçişte kalanlar

Supabase projesi ve gerçek cihazlarla uçtan uca doğrulama; hizmeti işleten kişi/kurumun iletişimi ve gerçek gizlilik metni; SMTP, yedekleme/geri yükleme doğrulaması, hata gözlemi ve kullanım yüküne uygun harita servisi; Apple/Google mağaza hesapları ve yayın incelemesi. Bunlar hesabı olmayan servislerde tamamlanmış gösterilmez. Push bildirimleri bu sürüme dahil değildir; takip edilen parklar uygulama içinden izlenir.

Harita OpenFreeMap Positron vektör zeminini ve MapLibre kullanır. Hesap veya API anahtarı gerekmez. Toplu veya çevrimdışı harita indirme yoktur. Sağlayıcı değiştirmek için `EXPO_PUBLIC_MAP_STYLE_URL` içine MapLibre stil adresi yazılır; stilin kaynakları doğru attribution bilgisi içermelidir. Önceki `EXPO_PUBLIC_MAP_TILE_URL` / `EXPO_PUBLIC_MAP_ATTRIBUTION` değişkenleri artık kullanılmaz. Genel OpenFreeMap servisi SLA sunmaz; büyüyen kullanımda sağlayıcı seçimi yeniden değerlendirilir. Harita WebGL destekli güncel tarayıcı/WebView gerektirir. Destek yoksa park listesi kullanılabilir.

Harita kaynakları veya bağımlılıkları değiştiğinde `cd mobile && npm run build:map` çalıştırılır. Web/native export bunu otomatik yapar. Yerel Gradle APK derlemesinden önce bu komut çalıştırılmalıdır; `src/components/map-bundle.ts` üretilen ve sürümlenen dosyadır.
