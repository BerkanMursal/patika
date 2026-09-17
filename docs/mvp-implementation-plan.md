# MVP Implementasyon Planı

> Bu belge `docs/target-mvp-architecture.md`'de tanımlanan hedef mimariyi küçük, bağımsız test edilebilir görevlere böler. Kapsam yalnızca `docs/requirements.md` madde 9'daki MVP listesidir. Mevcut çalışan kod (auth, harita altyapısı, besleme/gözlem akışı, fotoğraf/storage, favoriler, raporlama, park isim önerisi) **yeniden yazılmaz veya refactor edilmez** — sadece üzerine ekleme yapılır. Bu belge implementasyon içermez, yalnızca görev tanımlarıdır.

## Ürün Kararları (kesinleşti)

Bu bölümdeki kararlar netleştirilmiştir; aşağıdaki görev tanımları bu kararlara göre güncellenmiştir.

1. **Konum doğrulama:** Maksimum mesafe 200 metre. Eşik aşılırsa kayıt **reddedilir** (kaydedilmez). MVP'de `flagged`/moderasyon kuyruğu **yok**. Kullanıcıya "konumunu kontrol edip tekrar dene" anlamında bir hata gösterilir.
2. **Puan sistemi:** Sabit puan. Doğrulanmış mama/su yardımı = **10 puan**, doğrulanmış observation/kontrol = **2 puan**. Yalnızca konum doğrulamasından geçen (yani reddedilmeyen) aktiviteler puan üretir.
3. **Rescue-case görünürlüğü:** MVP'de tüm kullanıcılara açık. "Doğrulanmış gönüllü" rolü bu aşamada eklenmiyor.
4. **Rescue-case fotoğrafları:** Yeni bucket açılmıyor; mevcut storage bucket, `rescue-cases/` path prefix'i ile kullanılıyor.
5. **Vaka durum geçişleri:** Yalnızca tanımlanan sıralı geçişlere izin verilir, durum atlama yapılmaz.
6. **Veteriner ataması:** Opsiyonel; `at_vet` durumuna geçişte veteriner seçimi zorunlu değildir.

**Kararların yarattığı bir çelişki tespit edildi ve çözüldü:** Karar 2 ("yalnızca konum doğrulamasından geçen aktiviteler puan üretir") ile eski T13 ("çözülen rescue-case'e puan verilir") çelişiyor — rescue-case akışında (T9) bir hedef nokta/parka karşı `ST_DWithin` tipi bir konum doğrulaması **yok**, yalnızca serbest konum bildirimi var. Bu nedenle rescue-case çözümü karar 2 kapsamına girmiyor ve **T13 MVP kapsamından çıkarılmıştır** (bkz. T13 bölümü). Bu değişiklik görev sıralamasını da etkiler (aşağıda).

## Bağımlılık Zinciri (özet)

```
Veteriner sistemi ──────────────┐
                                 ▼
Konum doğrulama → Doğrulanmış yardım → Puan sistemi → Leaderboard

Veteriner sistemi → Rescue-case (bağımsız, puan sistemine bağımlı DEĞİL)
```

- **Konum doğrulama → doğrulanmış yardım:** Puan ve leaderboard yalnızca konum doğrulamasından geçmiş (reddedilmemiş) kayıtları saymalı; bu yüzden konum doğrulaması puan sisteminden önce gelmeli.
- **Doğrulanmış yardım → puan sistemi:** Puan yazma mantığı, kaydın konum doğrulamasından geçtiği bilgisine (T3'ün ürettiği sonuca) ihtiyaç duyar.
- **Puan sistemi → leaderboard:** Leaderboard, `point_transactions` verisi olmadan boş/anlamsızdır.
- **Veteriner sistemi → rescue-case entegrasyonu:** `rescue_cases.assigned_vet_id` alanı `veterinarians` tablosuna FK olduğu için, rescue-case tablosu şema seviyesinde veteriner tablosunun var olmasını gerektirir; ayrıca "yakında veteriner" gösterimi (requirements madde 2, 6) veteriner verisine bağımlıdır.
- **Rescue-case artık puan sistemine bağımlı değil:** Karar 2 gereği rescue-case çözümü puan üretmediği için Grup 5, Grup 3/4'ü beklemeden Grup 1 tamamlanır tamamlanmaz tümüyle ilerleyebilir.

Gruplar arası sıra: **Grup 1 (Veteriner) → Grup 2 (Konum Doğrulama) → Grup 3 (Puan) → Grup 4 (Leaderboard)**, ve bağımsız olarak **Grup 1 → Grup 5 (Rescue-case)**. Grup 5 artık yalnızca Grup 1'e bağımlı; Grup 3/4 ile paralel yürütülebilir.

---

## Grup 1 — Veteriner Sistemi

### T1 — Veteriner veri modeli ve backend

**Amacı:** Anlaşmalı veterinerlerin sunucuda tutulması ve okunabilmesi (requirements madde 6, 9).

**Bağımlılıkları:** Yok — ilk görev.

**Mevcut kodda etkilenecek alanlar:** Yeni migration dosyası (`supabase/migrations/`), mevcut migration'lara dokunulmaz.

**Database migration:**
- Yeni tablo `veterinarians`: `id, name, address, city, district, latitude, longitude, location (geography), phone, is_partner, discount_info, active, created_at`
- RLS: aktif veterinerler herkese (anon dahil) okunur; yazma yalnızca RPC üzerinden (ilk sürümde ekleme/güncelleme manuel/SQL ile yapılabilir, kullanıcıya açık bir yazma RPC'si MVP'de gerekmez)

**RPC/backend değişiklikleri:**
- `get_vets()` — aktif veterinerleri döner (opsiyonel `near_lat/near_lng/radius` parametresi ile filtre)

**Mobile/frontend değişiklikleri:** Yok (bu görev backend-only).

**Test edilmesi gereken durumlar:**
- `get_vets()` aktif kayıtları döner, `active=false` olanları dönmez
- Anon kullanıcı (giriş yapmamış) `get_vets()` çağırabilir
- Boş tabloda boş liste döner (hata fırlatmaz)

**Acceptance criteria:**
- Migration sorunsuz uygulanır, mevcut migration'lar etkilenmez
- `get_vets()` RPC'si dokümante edilen alanlarla veri döner
- RLS ile doğrudan `INSERT/UPDATE/DELETE` engellenir (yalnızca `service_role` veya RPC ile mümkün)

---

### T2 — Veteriner mobile entegrasyonu

**Amacı:** Kullanıcının haritada/listede anlaşmalı veterinerleri görebilmesi (requirements madde 2, 6).

**Bağımlılıkları:** T1

**Mevcut kodda etkilenecek alanlar:** `mobile/src/services/repository.ts` (yeni `getVets()` fonksiyonu), `mobile/src/components/ParkMap.tsx`/`.web.tsx` + `map-model.ts` (yeni marker tipi), yeni ekran dosyası, `mobile/src/navigation.ts`.

**Database migration:** Yok (T1'de yapıldı).

**RPC/backend değişiklikleri:** Yok (T1'de yapıldı).

**Mobile/frontend değişiklikleri:**
- `repository.ts`'e `getVets()` eklenir
- Yeni `VetListScreen` — basit liste (isim, adres, telefon, indirim bilgisi)
- Harita bileşenlerine veteriner marker tipi (🏥) eklenir — mevcut clustering mantığı değişmez, yeni veri katmanı eklenir
- `navigation.ts`'e `VetList` route'u eklenir

**Test edilmesi gereken durumlar:**
- Veteriner yokken liste/harita boş durumu düzgün gösterir
- Veteriner varken liste ve harita marker'ları eşleşir
- Demo modda (backend yokken) ekran çökmeden boş/placeholder durum gösterir

**Acceptance criteria:**
- Kullanıcı yeni ekrandan veteriner listesini görebilir
- Haritada park/besleme noktası marker'larıyla birlikte veteriner marker'ları görünür, mevcut park/nokta gösterimini bozmaz

---

## Grup 2 — Konum Doğrulama → Doğrulanmış Yardım

### T3 — Konum doğrulama: şema ve RPC mantığı

**Amacı:** Sunucunun, kullanıcının bildirdiği GPS konumunu ilgili besleme noktasıyla karşılaştırıp kaydı "doğrulanmış" veya "şüpheli" olarak işaretlemesi (requirements madde 3 adım 5, madde 4).

**Bağımlılıkları:** Yok (Grup 1'den bağımsız, paralel yürütülebilir).

**Mevcut kodda etkilenecek alanlar:** Yeni migration; **mevcut** `submit_feeding` ve `submit_observation` RPC fonksiyonları (yeni fonksiyon değil, var olanın gövdesi genişletilir).

**Database migration:**
- `feeding_events` tablosuna `reported_latitude`, `reported_longitude` kolonları
- `observations` tablosuna aynı iki kolon
- `flagged` durumu veya buna dair enum değeri **eklenmez** — MVP'de moderasyon kuyruğu yok, eşik dışı kayıt hiç oluşmaz

**RPC/backend değişiklikleri:**
- `submit_feeding(...)` parametrelerine `reported_latitude`, `reported_longitude` eklenir; fonksiyon içinde `ST_DWithin(feeding_points.location, ST_MakePoint(reported_longitude, reported_latitude), 200)` kontrolü yapılır (**karar: eşik = 200 metre**)
  - Eşik içindeyse: kayıt normal şekilde (mevcut davranış) işlenir → "doğrulanmış"
  - Eşik dışındaysa: **kayıt reddedilir** (RPC hata döner, satır oluşturulmaz) — `flagged` durum/moderasyon kuyruğu MVP'de yok
- `submit_observation(...)` için aynı mantık (eşik 200m, aşılırsa reddet)

**Karar (kesinleşti):** Eşik mesafe 200 metre. Eşik aşılırsa kayıt reddedilir, moderasyon kuyruğuna düşmez.

**Mobile/frontend değişiklikleri:** Yok (bu görev backend-only; hata mesajının gösterimi T4'te).

**Test edilmesi gereken durumlar:**
- 200m içinde konum → kayıt normal işlenir
- 200m dışında konum → RPC hata döner, hiçbir satır oluşmaz (`feeding_events`/`observations`'da kayıt yok)
- `reported_latitude/longitude` gönderilmezse (eski client / geriye dönük uyumluluk) davranış netleştirilmeli ve test edilmeli (öneri: parametre zorunlu hale getirilip eksikse hata döndürülsün, sessiz geçiş olmasın)
- Mevcut geçerli senaryolar (T3 öncesi davranışla aynı sonucu veren durumlar) regresyon testiyle doğrulanır

**Acceptance criteria:**
- Var olan `submit_feeding`/`submit_observation` çağıran testler (varsa `mobile/tests/*.test.ts`, PGlite tabanlı) kırılmadan geçer
- 200m eşiği için içeride/dışında senaryolar için yeni test eklenir ve geçer; dışındaki senaryoda kayıt oluşmadığı doğrulanır
- Mevcut RPC imzası geriye dönük olarak (parametre eklenmesi dışında) bozulmaz

---

### T4 — Mobile konum yakalama ve gönderimi

**Amacı:** Kullanıcı besleme/gözlem kaydı oluştururken cihaz GPS konumunun okunup RPC'ye iletilmesi.

**Bağımlılıkları:** T3

**Mevcut kodda etkilenecek alanlar:** `mobile/src/services/location.ts` / `.web.ts` (zaten var, RPC çağrısına bağlanacak), `mobile/src/services/repository.ts` (`submitFeeding`/`submitObservation` çağrılarına konum parametresi eklenmesi), `mobile/src/screens/RecordScreen.tsx`.

**Database migration:** Yok.

**RPC/backend değişiklikleri:** Yok (T3'te yapıldı).

**Mobile/frontend değişiklikleri:**
- `RecordScreen` kayıt oluşturma akışında cihaz konumu okunur (izin reddedilirse kullanıcıya bilgi verilir — mevcut hata gösterim deseni kullanılır)
- `repository.ts` içindeki `submitFeeding`/`submitObservation` çağrıları yeni konum parametrelerini RPC'ye iletir
- T3'ün 200m eşiği aşıldığında RPC'den dönen reddetme hatası yakalanıp kullanıcıya **"Konumunu kontrol et ve tekrar dene"** anlamında açık bir hata mesajı gösterilir (karar: flagged/moderasyon yok, kullanıcı doğrudan bilgilendirilip tekrar denemeye yönlendirilir)

**Test edilmesi gereken durumlar:**
- Konum izni verilmişse GPS koordinatı doğru şekilde RPC'ye gider
- Konum izni reddedilmişse kullanıcıya anlaşılır bir uyarı gösterilir, uygulama çökmez
- Web platformunda (`location.web.ts`) tarayıcı konum API'si ile aynı akış çalışır
- 200m eşiği aşıldığında RPC'nin reddetme hatası doğru yakalanır ve "konumunu kontrol et, tekrar dene" mesajı gösterilir

**Acceptance criteria:**
- Gerçek cihazda/simülatörde bir besleme kaydı oluşturulduğunda RPC'ye konum verisi gittiği doğrulanır (log veya DB'de kolon dolu görülür)
- Konum izni yokken kayıt akışı kullanıcıyı bilgilendirip mantıklı bir şekilde durur (silessizce başarısız olmaz)
- Eşik dışı konumda kullanıcı "konumunu kontrol et ve tekrar dene" mesajını görür, uygulama çökmez

---

## Grup 3 — Puan Sistemi (Doğrulanmış Yardıma Bağımlı)

### T5 — point_transactions tablosu ve puan yazma mantığı

**Amacı:** Doğrulanmış besleme/gözlem kayıtları için kullanıcıya puan verilmesi (requirements madde 3 adım 7, madde 9, 13).

**Bağımlılıkları:** T3 (yalnızca doğrulanmış kayıtlar puan almalı)

**Mevcut kodda etkilenecek alanlar:** Yeni migration; **mevcut** `submit_feeding`/`submit_observation` RPC'leri (T3'te değiştirilmiş haline ek mantık).

**Database migration:**
- Yeni tablo `point_transactions`: `id, user_id (FK→auth.users), source_type (feeding/observation), source_id (uuid), points (int), created_at`
- RLS: kullanıcı yalnızca kendi işlemlerini okuyabilir
- `source_type` enum'u MVP'de yalnızca `feeding` ve `observation` değerlerini içerir; `rescue_case` **eklenmez** (bkz. T13 — rescue-case puanlaması karar 2 gereği MVP kapsamı dışında)

**Karar (kesinleşti):** Sabit puan. Doğrulanmış (konum kontrolünden geçmiş) mama/su yardımı = **10 puan**, doğrulanmış observation/kontrol = **2 puan**. Yalnızca T3'te reddedilmeyen (yani konum doğrulamasından geçen) kayıtlar puan üretir.

**RPC/backend değişiklikleri:**
- `submit_feeding`: kayıt T3'teki konum kontrolünden geçip (reddedilmeyip) oluşturulduğunda `point_transactions`'a `points=10` ile bir satır eklenir
- `submit_observation`: aynı şekilde `points=2` ile satır eklenir
- Reddedilen (200m eşiği aşan) kayıtlar zaten `feeding_events`/`observations`'da hiç oluşmadığından puan mantığı hiç çalışmaz — ayrı bir "flagged kontrolü" gerekmez

**Mobile/frontend değişiklikleri:** Yok (bu görev backend-only; gösterim T6'da).

**Test edilmesi gereken durumlar:**
- Konum doğrulamasından geçen besleme kaydı → `point_transactions`'da `points=10` ile satır oluşur
- Konum doğrulamasından geçen observation kaydı → `point_transactions`'da `points=2` ile satır oluşur
- Reddedilen (T3'te hata dönen) girişim → `feeding_events`/`observations`'da satır oluşmadığı için `point_transactions`'da da satır oluşmaz
- Aynı kullanıcının birden fazla kaydı → puanlar doğru şekilde birikir (toplama hatası yok)

**Acceptance criteria:**
- Konum doğrulamasından geçen bir besleme/gözlem sonrası `point_transactions` tablosunda doğru `user_id`, `source_type`, `source_id` ve puan (10 veya 2) ile satır oluşur
- Reddedilen kayıtlar için hiçbir puan satırı oluşmadığı doğrulanır

---

### T6 — Mobile puan gösterimi

**Amacı:** Kullanıcının kendi toplam puanını görebilmesi (requirements madde 11 — ilerleme hissi).

**Bağımlılıkları:** T5

**Mevcut kodda etkilenecek alanlar:** `mobile/src/services/repository.ts` (kullanıcının toplam puanını okuyan fonksiyon), `mobile/src/screens/ProfileScreen.tsx`.

**Database migration:** Yok.

**RPC/backend değişiklikleri:** Kullanıcının kendi toplam puanını dönen basit bir RPC veya doğrudan `point_transactions` üzerinde `SUM` sorgusu (RLS zaten sahiplik bazlı okumaya izin verdiği için ayrı RPC şart değil, mevcut desenle tutarlı olması için RPC tercih edilebilir — ürün/ekip tercihi).

**Mobile/frontend değişiklikleri:**
- `ProfileScreen`'e toplam puan gösterimi eklenir (basit sayı, requirements madde 11'deki gibi "Bu ay X yardım yaptın" tarzı ayrıntılı anlatım MVP kapsamı dışıdır, madde 9 sadece "basit puan sistemi" istiyor)

**Test edilmesi gereken durumlar:**
- Hiç kaydı olmayan kullanıcı için puan 0 gösterilir (hata değil)
- Doğrulanmış kayıtları olan kullanıcı için toplam doğru gösterilir
- Demo modda backend yokken ekran çökmez

**Acceptance criteria:**
- `ProfileScreen` açıldığında kullanıcının güncel toplam puanı doğru gösterilir

---

## Grup 4 — Leaderboard (Puan Sistemine Bağımlı)

### T7 — leaderboard_summary view ve get_leaderboard RPC

**Amacı:** Basit sıralı yardım listesi altyapısı (requirements madde 9, madde 14 — tek kategori: "en çok yardım yapanlar").

**Bağımlılıkları:** T5

**Mevcut kodda etkilenecek alanlar:** Yeni migration.

**Database migration:**
- View `leaderboard_summary`: `point_transactions` üzerinden `user_id, display_name (profiles join), SUM(points) as total_points` — `GROUP BY user_id`

**RPC/backend değişiklikleri:**
- `get_leaderboard(limit)` — `leaderboard_summary`'den azalan sırada `limit` kayıt döner

**Mobile/frontend değişiklikleri:** Yok (T8'de).

**Test edilmesi gereken durumlar:**
- Puanı olmayan kullanıcılar listede görünmez (veya 0 ile görünür — ürün kararı, önerilen: görünmesin, liste sadece aktif katkı sağlayanları göstersin)
- Sıralama azalan puana göre doğru
- `limit` parametresi doğru çalışır

**Acceptance criteria:**
- `get_leaderboard(10)` çağrısı en yüksek puanlı 10 kullanıcıyı doğru sırada döner
- View, `point_transactions`'daki değişiklikleri anlık yansıtır (materialized view kullanılmaz, MVP'de gerek yok)

---

### T8 — LeaderboardScreen (mobile)

**Amacı:** Kullanıcının sıralamayı görebilmesi.

**Bağımlılıkları:** T7

**Mevcut kodda etkilenecek alanlar:** `mobile/src/services/repository.ts` (`getLeaderboard()`), yeni ekran, `mobile/src/navigation.ts`.

**Database migration:** Yok. **RPC/backend değişiklikleri:** Yok (T7'de yapıldı).

**Mobile/frontend değişiklikleri:**
- Yeni `LeaderboardScreen` — basit sıralı liste (sıra, isim, puan)
- Navigation'a route eklenir, mevcut tab/menü yapısına giriş noktası eklenir

**Test edilmesi gereken durumlar:**
- Boş leaderboard (hiç veri yok) düzgün boş durum gösterir
- Uzun isimlerle liste taşmadan render olur
- Demo modda backend yokken çökmez

**Acceptance criteria:**
- Kullanıcı yeni ekrandan güncel sıralamayı görebilir

---

## Grup 5 — Yaralı Hayvan Bildirimi (Rescue Case)

### T9 — rescue_cases tablosu ve bildirim oluşturma

**Amacı:** Kullanıcının yaralı/yardıma muhtaç hayvan bildirimi oluşturabilmesi (requirements madde 5, ilk durum: "Bildirildi").

**Bağımlılıkları:** T1 (`assigned_vet_id` kolonu `veterinarians` tablosuna FK verir; tablo şema seviyesinde T1'in var olmasını gerektirir)

**Mevcut kodda etkilenecek alanlar:** Yeni migration; `mobile/src/services/repository.ts`, yeni ekran, `navigation.ts`. Mevcut `ReportScreen`/`RecordScreen` ile aynı UI deseni (fotoğraf + konum + açıklama) referans alınır, o ekranlar değiştirilmez.

**Database migration:**
- Yeni tablo `rescue_cases`: `id, reporter_user_id (FK→auth.users), latitude, longitude, location (geography), description, animal_condition, photo_path, status (enum, ilk değer 'reported'), assigned_volunteer_id (FK→auth.users, nullable), assigned_vet_id (FK→veterinarians, nullable), created_at, updated_at`
- RLS: herkese okunur (**karar: kesinleşti** — MVP'de tüm kullanıcılara açık, "doğrulanmış gönüllü" rolü bu aşamada eklenmiyor)

**Karar (kesinleşti):** Rescue-case'ler MVP'de tüm kullanıcılara görünür. Requirements madde 5'teki "öncelikli müdahale grupları" (doğrulanmış gönüllü vb.) ayrımı bu aşamada uygulanmıyor; kapsam genişletmemek için bilinçli basitleştirme.

**RPC/backend değişiklikleri:**
- `report_rescue_case(latitude, longitude, description, animal_condition, photo_path)` — `security definer`, `status='reported'` ile satır oluşturur

**Mobile/frontend değişiklikleri:**
- Yeni `RescueReportScreen` — fotoğraf (mevcut `services/photos.ts` yeniden kullanılır), konum (mevcut `services/location.ts` yeniden kullanılır), açıklama + hayvan durumu alanları
- `repository.ts`'e `reportRescueCase()` eklenir
- `navigation.ts`'e route eklenir

**Karar (kesinleşti — storage):** Yeni bucket açılmıyor. Rescue fotoğrafları mevcut storage bucket'ında **`rescue-cases/`** path prefix'i altında tutulur (mevcut `{uid}/...` desenine benzer şekilde, örn. `rescue-cases/{uid}/...`). RLS kuralları mevcut bucket'ın sahiplik deseniyle tutarlı şekilde genişletilir.

**Test edilmesi gereken durumlar:**
- Fotoğrafsız/konumsuz gönderim engellenir (gerekli alan kontrolü)
- Başarılı bildirim sonrası `rescue_cases`'da `status='reported'` satır oluşur
- Fotoğraf, mevcut bucket'ta `rescue-cases/` prefix'i altına doğru şekilde yüklenir ve `feeding-photos` (besleme) verisiyle karışmaz

**Acceptance criteria:**
- Kullanıcı fotoğraflı bir yaralı hayvan bildirimi oluşturabilir ve bu `rescue_cases` tablosunda görünür
- Fotoğraf mevcut bucket içinde `rescue-cases/` altında saklanır, yeni bucket oluşturulmamıştır

---

### T10 — Vakayı üstlenme (claim)

**Amacı:** Bir gönüllünün vakayı üstlenmesi ve bunun diğer kullanıcılara görünür olması (requirements madde 5 — "Gönüllü Vakayı Üstlendi", mükerrer müdahaleyi önleme).

**Bağımlılıkları:** T9

**Mevcut kodda etkilenecek alanlar:** Yeni RPC, `repository.ts`, yeni ekran (`RescueCaseScreen`).

**Database migration:** Yok (T9'da yapıldı).

**RPC/backend değişiklikleri:**
- `claim_rescue_case(case_id)` — `security definer`; yalnızca `status='reported'` veya `'verifying'` olan vakalarda çalışır; `assigned_volunteer_id = auth.uid()`, `status='claimed'` yapar; zaten üstlenilmiş vakada hata döner (mükerrer üstlenmeyi engeller)

**Mobile/frontend değişiklikleri:**
- Yeni `RescueCaseScreen` — vaka detayı + "Vakayı Üstlen" butonu (zaten üstlenilmişse buton gizlenir/disabled, üstlenen kişi bilgisi gösterilir)

**Test edilmesi gereken durumlar:**
- İki kullanıcı aynı anda üstlenmeye çalışırsa yalnızca biri başarılı olur (race condition — RPC'de `WHERE status='reported'` gibi atomik güncelleme ile garanti edilmeli)
- Üstlenilmiş vaka başka kullanıcıya "üstlenildi" olarak görünür

**Acceptance criteria:**
- Bir gönüllü vakayı üstlendiğinde durum ve üstlenen bilgisi tüm kullanıcılara anında (sonraki veri çekiminde) doğru yansır
- Aynı vaka iki kez üstlenilemez

---

### T11 — Vaka durum akışı güncelleme

**Amacı:** requirements madde 5'teki tam durum zincirinin (Doğrulanıyor → Gönüllü Yolda → Veterinere Ulaştırıldı → Tedavi Altında → Çözüldü) uygulanması.

**Bağımlılıkları:** T10

**Mevcut kodda etkilenecek alanlar:** Yeni RPC, `RescueCaseScreen` genişletmesi.

**Database migration:** Yok (enum değerleri T9'da tanımlandı).

**RPC/backend değişiklikleri:**
- `update_rescue_case_status(case_id, new_status)` — yalnızca `assigned_volunteer_id = auth.uid()` veya moderatör çağırabilir; **karar (kesinleşti): yalnızca tanımlanan sıralı geçişlere izin verilir, durum atlama yapılmaz**. İzin verilen sıra: `claimed → en_route → at_vet → treating → resolved` (T10'daki `claimed`'a kadar olan kısım `claim_rescue_case` ile ayrı yönetiliyor). Sıradaki durum dışında bir hedef durum istenirse RPC hata döner.

**Mobile/frontend değişiklikleri:**
- `RescueCaseScreen`'de durum güncelleme butonları (yalnızca atanan gönüllüye görünür); UI yalnızca bir sonraki geçerli durumu buton olarak sunar, atlama seçeneği gösterilmez

**Test edilmesi gereken durumlar:**
- Atanmamış kullanıcı durum güncelleyemez (yetkisiz erişim reddedilir)
- Sıra dışı geçiş denemesi (örn. `claimed`'dan doğrudan `resolved`'a) RPC tarafından reddedilir
- Sıralı geçişler (claimed → en_route → at_vet → treating → resolved) tek tek, sırayla başarıyla çalışır

**Acceptance criteria:**
- Atanan gönüllü vakayı adım adım "Çözüldü" durumuna taşıyabilir
- Yetkisiz kullanıcı durum değiştiremez

---

### T12 — Haritada rescue-case gösterimi

**Amacı:** Aktif yaralı hayvan bildirimlerinin haritada görünmesi (requirements madde 2 — 🚨/🙋 ikonları).

**Bağımlılıkları:** T9

**Mevcut kodda etkilenecek alanlar:** `map-model.ts`, `ParkMap.tsx`/`.web.tsx`, `repository.ts` (`getRescueCases()`).

**Database migration:** Yok. **RPC/backend değişiklikleri:**
- `get_rescue_cases()` — aktif (çözülmemiş) vakaları döner

**Mobile/frontend değişiklikleri:**
- Harita bileşenine yeni marker tipi (durscreen'e göre 🚨 bildirildi / 🙋 üstlenildi ikon farkı)

**Test edilmesi gereken durumlar:**
- Çözülmüş vakalar haritada görünmez
- Durum değişince marker ikonu güncellenir (bir sonraki veri çekiminde)

**Acceptance criteria:**
- Aktif vakalar haritada doğru konumda ve doğru ikonla görünür, park/besleme noktası/veteriner marker'larını bozmaz

---

### T13 — Çözülen vakaya puan verilmesi — **MVP KAPSAMI DIŞINA ÇIKARILDI**

**Durum:** Bu görev iptal edilmiştir, uygulanmayacaktır.

**Gerekçe:** Ürün kararı 2 ("Sadece konum doğrulamasından geçen aktiviteler puan üretsin") ile çelişiyor. Rescue-case akışında (T9) bir hedef nokta/parka karşı konum doğrulaması (`ST_DWithin` kontrolü) yok — kullanıcı serbest bir konum bildiriyor. Bu nedenle rescue-case'in "konum doğrulamasından geçmiş" sayılması için bir temel yok; karar 2'nin kapsamına girmiyor.

**Sonuç:** `point_transactions.source_type` enum'u MVP'de yalnızca `feeding` ve `observation` içerir, `rescue_case` eklenmez. Çözülen rescue-case'ler MVP'de puan üretmez. Bu, requirements madde 9/13'teki "rescue-case'lerin puanlamaya dahil olması" beklentisiyle kısmen çelişir — **bu bilinçli bir MVP kapsam kararıdır**, gelecekte rescue-case için ayrı bir doğrulama/onay mekanizması tanımlanırsa yeniden değerlendirilebilir.

**Etki:** T13'ün kaldırılması Grup 5'i Grup 3'e (puan sistemi) olan bağımlılığından kurtarır — bkz. güncellenmiş "Görev Sırası" ve "Bağımlılık Zinciri" bölümleri.

---

### T14 — Vakaya veteriner atama (opsiyonel MVP genişletmesi)

**Amacı:** requirements madde 5 — "Veterinere Ulaştırıldı" adımında hangi veterinere gidildiğinin kaydedilmesi.

**Bağımlılıkları:** T1 (veteriner listesi), T10 (vaka üstlenme akışı)

**Mevcut kodda etkilenecek alanlar:** `update_rescue_case_status` RPC'sine opsiyonel parametre, `RescueCaseScreen`.

**Database migration:** Yok (`assigned_vet_id` T9'da tanımlandı).

**RPC/backend değişiklikleri:**
- `update_rescue_case_status(case_id, new_status, vet_id?)` — durum `at_vet` olduğunda `assigned_vet_id` set edilir

**Mobile/frontend değişiklikleri:**
- `RescueCaseScreen`'de "Veterinere Ulaştırıldı" durumuna geçerken T2'deki veteriner listesinden seçim yapılabilmesi

**Karar (kesinleşti):** Veteriner ataması opsiyoneldir. `at_vet` durumuna geçiş veteriner seçilmeden de yapılabilir, `assigned_vet_id` boş kalabilir.

**Test edilmesi gereken durumlar:**
- Veteriner seçilmeden `at_vet` durumuna geçiş başarılı olur, `assigned_vet_id` `null` kalır
- Veteriner seçilerek `at_vet` durumuna geçiş başarılı olur, `assigned_vet_id` doğru set edilir
- Geçersiz `vet_id` (aktif olmayan/var olmayan veteriner) reddedilir

**Acceptance criteria:**
- Kullanıcı vakayı bir veterinere atayabilir, bu bilgi vaka detayında görünür

---

## Görev Sırası (bağımlılığa göre)

1. T1 — Veteriner backend
2. T2 — Veteriner mobile *(bağımlı: T1)*
3. T3 — Konum doğrulama backend *(bağımsız, T1 ile paralel yürütülebilir)*
4. T4 — Konum doğrulama mobile *(bağımlı: T3)*
5. T5 — Puan sistemi backend *(bağımlı: T3)*
6. T6 — Puan gösterimi mobile *(bağımlı: T5)*
7. T7 — Leaderboard backend *(bağımlı: T5)*
8. T8 — Leaderboard mobile *(bağımlı: T7)*
9. T9 — Rescue-case oluşturma *(bağımlı: T1)*
10. T10 — Rescue-case üstlenme *(bağımlı: T9)*
11. T11 — Rescue-case durum akışı *(bağımlı: T10)*
12. T12 — Rescue-case harita gösterimi *(bağımlı: T9)*
13. ~~T13 — Rescue-case puan entegrasyonu~~ — **kaldırıldı** (karar 2 ile çelişiyor, bkz. T13)
14. T14 — Rescue-case veteriner atama *(bağımlı: T1, T10)*

Not: T3/T4 zinciri ile T1/T2 zinciri birbirinden bağımsızdır, paralel ilerletilebilir. T9-T12 ve T14, T5-T8'den tamamen bağımsızdır — T1 tamamlanır tamamlanmaz başlayıp Grup 3/4 ile paralel yürütülebilir (T13'ün kaldırılmasıyla artık Grup 5'in Grup 3'e hiçbir bağımlılığı kalmadı).

---

## Kapsam Dışı Hatırlatma

Bu plana **dahil edilmeyenler** (requirements madde 9 "İlk sürümde olmaması gerekenler" ve önceki analiz gereği): bağış sistemi, Patika Mama, görüntü işleme/AI tabanlı sahte kayıt tespiti, belediye yönetim paneli, e-ticaret, çoklu leaderboard kategorileri, rozet/seviye sistemi, QR kod sistemi, push notification, üniversite/topluluk ekip yapıları. Bunlar `docs/target-mvp-architecture.md`'de de kapsam dışı bırakılmıştı.

---

## Checklist

- [ ] T1 — Veteriner tablosu + `get_vets` RPC
- [ ] T2 — Veteriner listesi + harita marker (mobile)
- [ ] T3 — Konum doğrulama şeması + RPC mantığı (backend)
- [ ] T4 — Konum yakalama ve RPC'ye gönderim (mobile)
- [ ] T5 — `point_transactions` + puan yazma mantığı (backend)
- [ ] T6 — Kullanıcı puanı gösterimi (mobile)
- [ ] T7 — `leaderboard_summary` view + `get_leaderboard` RPC (backend)
- [ ] T8 — LeaderboardScreen (mobile)
- [ ] T9 — `rescue_cases` tablosu + bildirim oluşturma (backend + mobile)
- [ ] T10 — Vaka üstlenme (claim) (backend + mobile)
- [ ] T11 — Vaka durum akışı (backend + mobile)
- [ ] T12 — Haritada rescue-case gösterimi (mobile)
- [x] ~~T13 — Çözülen vakaya puan verilmesi~~ — MVP kapsamından çıkarıldı (karar 2 ile çelişki)
- [ ] T14 — Vakaya veteriner atama (backend + mobile, opsiyonel atama)

**Ürün kararları (kesinleşti, implementasyon öncesi netleştirme ihtiyacı kalmadı):**
- [x] Konum doğrulama eşiği: 200 metre, aşılırsa reddet (flagged/moderasyon yok)
- [x] Puan değerleri: doğrulanmış mama/su = 10, doğrulanmış observation = 2; yalnızca konum doğrulamasından geçenler puan üretir
- [x] Rescue-case görünürlüğü: MVP'de herkese açık, doğrulanmış gönüllü rolü yok
- [x] Rescue-case fotoğrafları: mevcut bucket, `rescue-cases/` path prefix, yeni bucket yok
- [x] Vaka durum geçişleri: yalnızca sıralı geçiş, atlama yok
- [x] Veterinere atama: opsiyonel

**Bu kararlardan doğan ek not:** Karar 2 nedeniyle T13 kapsam dışına çıkarıldı (yukarıda gerekçelendirildi). Bu, requirements madde 9/13'teki "rescue-case puanlaması" beklentisini MVP'de karşılamaz — bilinçli bir kapsam kararı olarak kayda geçirilmiştir.
