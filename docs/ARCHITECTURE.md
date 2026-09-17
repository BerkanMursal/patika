# Uygulama mimarisi

```mermaid
flowchart TD
  Phone[React Native / Expo 57 — Android, iOS, web] --> UI[Harita · Park · Fotoğraflı kayıt · Gözlem · Profil]
  UI --> Store[AppProvider — oturum, takip, kuyruk]
  Store --> Local[AsyncStorage + cihazda fotoğraf]
  Store --> Auth[Supabase Auth — PKCE]
  Auth --> Secure[Native SecureStore]
  Store --> RPC[Doğrulanan RPC işlevleri]
  Store --> Storage[Özel JPEG bucket — süreli okuma bağlantısı]
  RPC --> DB[PostgreSQL + PostGIS + RLS]
  Catalog[OSM snapshot + il sınırları] --> Import[Sunucudan park aktarımı]
  Import --> DB
  UI --> Map[MapLibre + Supercluster — web iframe / native WebView]
  Map --> Tiles[OpenStreetMap döşemeleri]
  Store --> Account[Hesap silme Edge Function]
  Account --> Auth
  Account --> Storage
```

Ekranlar `src/screens`, ortak arayüz `src/ui`, iş kuralları `src/core`, dış servis erişimi `src/services`, uygulama durumu `src/state` içindedir. Root Next.js uygulaması mimari atlasıdır; mobil uygulama bağımsız `mobile/package.json` kullanır.

Fotoğraf JPEG'e dönüştürülür, en fazla 1280 piksel genişliğe indirilir; miktar, park/nokta ve fotoğraf birlikte doğrulanır. UUID işlem kimliği oluşturulur. Fotoğraf ve kayıt önce cihazdaki kullanıcıya ait kuyruğa yazılır; sonra özel Storage'a ve RPC'ye gönderilir. Yeniden deneme aynı kimliği kullanır. PostgreSQL sahiplik, miktar, nokta, zaman, fotoğraf yolu ve günlük sınır kontrolü yapar. Eski bir çevrimdışı kaydın gelmesi yeni “son besleme” bilgisini ezmez.

```mermaid
erDiagram
  AUTH_USERS ||--|| PROFILES : profil
  PARKS ||--o{ FEEDING_POINTS : nokta
  PARKS ||--o{ FEEDING_EVENTS : gecmis
  FEEDING_POINTS ||--o{ FEEDING_EVENTS : besleme
  FEEDING_POINTS ||--o{ OBSERVATIONS : gozlem
  AUTH_USERS ||--o{ FEEDING_EVENTS : paylasan
  AUTH_USERS ||--o{ OBSERVATIONS : gozlemleyen
  AUTH_USERS ||--o{ FAVORITES : takip
  PARKS ||--o{ FAVORITES : izlenen
  AUTH_USERS ||--o{ REPORTS : bildiren
  FEEDING_EVENTS ||--o{ REPORTS : bildirilen
  PARKS ||--o{ REPORTS : bildirilen
  AUTH_USERS ||--o{ BLOCKED_USERS : gizleme
```

Kayıt gramajı kullanıcının beyanıdır. Fotoğraf otomatik doğrulanmaz; hayvanların açlık durumu veya kalan mama miktarı çıkarılmaz. “Son mama” ve “son su” ayrı olaylardan hesaplanır; 24 saati geçen kap gözlemi güncel kabul edilmez. Harita sorgusu en fazla 200 park, geçmiş sorgusu 30 kayıt döndürür. Sayfalama zaman + UUID kullanır. Park özetleri yalnızca seçilen en yakın 200 aday için hesaplanır.

API kullanan herkes parkları ve yayınlanmış beslemeleri okuyabilir. Fotoğrafı görmek ve paylaşmak için oturum gerekir. Kullanıcı kendi kaydını kaldırır; moderatör yetkisi sunucunun imzaladığı `app_metadata` üzerinden kontrol edilir. Hesap silme önce fotoğrafları, sonra hesabı ve bağlı kişisel kayıtları kaldırır. Hesap silme için sunucudaki yönetici anahtarı telefona ulaşmaz.

Demo modu aynı ekranları kullanır, gerçek parklar üzerindeki örnek kayıtları cihazda tutar. Demo ve canlı kuyrukları ayrı ad alanlarındadır. Supabase kurulunca canlı veriye örnek besleme aktarılmaz.
