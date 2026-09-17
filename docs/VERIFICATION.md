# Doğrulama kaydı

13 Eylül 2026 geliştirme oturumunda, Windows / Node 22.18 üzerinde yapılan kontroller.

| Kontrol                                                | Sonuç                                             |
| ------------------------------------------------------ | ------------------------------------------------- |
| Mobil TypeScript                                       | Geçti                                             |
| İş kuralları, PostgreSQL erişim, harita, sınırlar, konum, park adı ve bağımlılık testleri | 52/52 geçti                                       |
| Expo Doctor                                            | 21/21 geçti                                       |
| Hesap silme Edge Function / Deno tip kontrolü          | Geçti; canlı yürütme yapılmadı                    |
| npm bağımlılık taraması                                | 0 bilinen açık                                    |
| Web üretim dışa aktarımı / Vercel                      | Geçti; https://patika-mobile.vercel.app           |
| Android Hermes paketi                                  | Geçti                                             |
| iOS Hermes paketi                                      | Geçti; bu, Xcode/IPA derlemesi değildir           |
| Next.js mimari atlası tip kontrolü ve üretim derlemesi | Geçti                                             |
| Android ARM64 APK                                      | Yerel Gradle release derlemesi geçti; test imzası |

## Tarayıcıda doğrulanan akış

390 × 844 telefon görünümünde gerçek OSM haritası, park adı arama, park ayrıntısı, demo kullanıcı girişi ve takip işlemi kontrol edildi. Eksik miktarlı form gönderimi engellendi. Projenin kendi simgesiyle **açıkça demo olarak belirtilen** bir test fotoğrafı seçildi; 250 g mama, 500 ml su ve test notu kaydedildi. Parka dönüp sayfa yenilendiğinde fotoğraf, miktarlar, kullanıcı adı ve takip korundu. Mama/su kabı gözlemi de yenileme sonrasında korundu. Doğrudan park bağlantısından açılışta ana ekrana geri dönüş bulunur.

Yayımlanan sürümde `yogurtcu` araması Yoğurtçu Parkı'nı buldu. `/data/parks.json` HTTP 200 ve JSON içerik türüyle 24.669 kayıt döndürdü; `/data/README.txt` kaynak ve lisans bilgilerini sunuyor. Vercel projesi, GitHub deposunun `mobile` kök dizinine bağlıdır.

## Harita tasarımı güncellemesi

MapLibre 6.9.0 / OpenFreeMap Positron ile ortak web ve WebView haritasına geçildi. 390 × 844 ve 1280 × 900 boyutlarında zemin, kümelenen parklar, gruba dokunarak yakınlaştırma, Yoğurtçu aramasıyla merkeze gitme, seçilen pati işareti, son mama/su kartı, park ayrıntısına geçiş ve haritaya dönüş tarayıcıda doğrulandı. Kaynak bağlantıları görünür ve açılabilir. İlk iframe worker adresi/iletişim sorunu giderildi; son doğrulamada tarayıcı hata logu yoktu.

Beş yeni test: yakın parkların gruplanması ve zoom ile ayrılması; seçili parkın gruptan ayrılması ve görünüm sınırları; kaynak sırasının değişmemesi; geçersiz WebView koordinatlarının reddi; park adlarının script içinden çıkamaması. TypeScript, Prettier, web export ve Android/iOS Hermes export geçti. `npm audit --omit=dev`: 0 açık. Fiziksel telefonda yeni WebGL haritası henüz denenmedi.

## Konum isteği düzeltmesi

Web üzerinde ayrı ve süresiz Expo izin sorgusu yerine tek tarayıcı konum isteği kullanılır. Tarayıcı isteğinde 12 saniye timeout ve en fazla 60 saniyelik önbellek; izin penceresi dahil yanıtsız durumlar için uygulamada 15 saniye üst sınır vardır. Native konum akışı cihazın konum hizmetlerini ve iznini kontrol eder, 20 saniyede sonlanır. Geç yanıtlar başarısız bir isteğin ardından haritayı taşımaz; düğme beklerken tekrar istek açılmaz. Başarıda arama, filtre ve seçili park temizlenir. Arama alanı odaktayken de konum düğmesi ilk dokunuşta işler.

Dokuz yeni otomatik test; başarılı tek istek, tarayıcı hata kodları 1/2/3, destek ve HTTPS denetimi, yanıtsız sağlayıcıda süre sınırı ve tekrar deneme, geç sonuçların yok sayılması, geçersiz koordinatlar ve doğru hata metnini kapsar. Yerel tarayıcıda gerçek konum sağlayıcısı yanıt vermedi; süre sonunda uyarı görünmesi, düğmenin yeniden kullanılabilmesi ve park aramasının korunması kontrol edildi. Bu ortamda gerçek GPS koordinatı elde edildiği iddia edilmez; başarı yolu kontrollü sağlayıcıyla test edilmiştir. Fiziksel cihaz konum testi bekliyor.

## Park adı güncellemesi — 14 Eylül 2026

24.669 OSM kimliği korunur; kısa park kodlarının tamamı tekildir. 10 belediye adı, 23.888 yeni ilçe eşleştirmesi ve 853 adres açıklaması eklendi. Belirsiz veya çakışan nokta/poligon eşleştirmeleri, poligon boşlukları, CSV tırnak/satır sonu işleme, eski demo önbelleğinin yeni isim/konum bilgisini geri almaması test edildi.

Tarayıcıda adsız parkın kısa kodu ve ilçesi, giriş sonrası öneri formuna dönüş, eksik formun reddi, açıkça demo olan önerinin kaydı, sayfa yenileme sonrası bekleyen durumun korunması ve önerinin park adını değiştirmemesi doğrulandı. Karanfil Sokak Parkı aramada bulundu; ayrıntıda Kadıköy Belediyesi kaynak etiketi ve bağlantısı görüldü. 390 × 844 telefon görünümünde park bilgisi kartı kontrol edildi.

Yeni migration gerçek PostgreSQL test motorunda çalıştırıldı: anonim yazma engeli, özel öneri okumaları, kullanıcı metadata'sıyla yetki taklidi, kendi önerisini inceleme yasağı, açıklama sınırları, tekrar teslimde aynı öneri, onay/red, yeniden içe aktarmada adı koruma ve eski önerinin güncel adı ezememesi geçti. Canlı Supabase projesi olmadığı için cihazlar arası gönderim/gerçek moderatör hesabıyla uçtan uca onay henüz sınanmadı.

PGlite gerçek PostgreSQL sorguları çalıştırır; `auth` ve `storage` şemaları test doubles ile sağlanır. Üretim migration dosyasındaki politikalar ve RPC'ler aynen çalıştırılır. PGlite PostGIS içermediği için yalnızca coğrafi sütun, PostGIS extension ve GIST index bu testte çıkarılır.

Anonim yazmanın engellenmesi, kullanıcı kimliği taklidi, başkasının fotoğraf yoluna yükleme, yüklenmemiş fotoğrafla kayıt, tekrar teslimde tek kayıt, başka kullanıcı kaydını silmenin engellenmesi, moderatör yetkisi, takip izolasyonu, engellenen kullanıcıların filtrelenmesi, zaman sırası ve eşit zamanlı kayıtların sayfalanması kapsanır.

## Bağımlılık düzeltmeleri

`xcode` altındaki UUID, CommonJS desteğini koruyan 11.1.1'e sabitlendi. `decode-uri-component` 0.5.0 güvenlik düzeltmesi kullanılıyor. React Navigation'ın kullandığı CommonJS `query-string` için varsayılan ESM export'unu açan dar kapsamlı postinstall uyarlaması var. Kaynak beklenmedik değişirse kurulum sessizce geçmez. UTF-8/Türkçe, tekrar eden parametreler, bozuk yüzde kodlaması ve Xcode UUID üretimi test edildi.

- https://github.com/advisories/GHSA-w5hq-g745-h8pq
- https://github.com/advisories/GHSA-vcc3-ghjq-m6fr

## Park alanları — 14 Eylül 2026

24.669 katalog kaydının 24.083'üne OSM kimliğiyle gerçek sınır geometrisi bağlandı: 24.029 Polygon, 54 MultiPolygon, 37 iç boşluk içeren park. 586 kayıt geçerli alan geometrisine sahip değil. 811 bölgesel dosya toplam yaklaşık 10,55 MB; uygulama bunları görünür parklar için gerektiğinde alır.

52 test geçti. Yeni kontroller: parçalı dış sınırları birleştirme, iç boşlukları koruma, açık/bozuk/koordinatı geçersiz halkaları reddetme, görünüm ve filtre eşleşmesi, üç istek sınırı, iptal, yeniden deneme, önbelleği tekrar kullanma ve tarayıcı fetch bağlamı. Yayımlanacak tüm geometriler, dosya hash'leri, tekil katalog kimlikleri ve manifest toplamı doğrulandı. Veri dönüştürücü yalnızca geliştirme bağımlılığıdır; XML alt bağımlılığı düzeltilmiş sürüme sabitlendi ve npm audit 0 bilinen açık döndürdü.

Yerel tarayıcıda 124 sınırın görünmesi, katmanı açıp kapatma, Yoğurtçu aramasıyla tek alanı gösterme, işaret dışındaki alan içine dokunarak doğru park kartını açma ve seçilen sınırı vurgulama doğrulandı. 390×844 görünümünde düğme ve kart yerleşimi kontrol edildi. İlk görsel kontrolde yakalanan fetch alıcısı hatası düzeltildi ve regresyon testi eklendi. Android ARM64 release APK derlemesi ve v2 imza doğrulaması geçti.

## Henüz doğrulanmayanlar

Supabase hesabı/projesi bulunmadığından gerçek Auth e-postaları, Storage HTTP yüklemeleri, PostGIS, hesap silme Edge Function'ın canlı yürütülmesi ve cihazlar arası eşzamanlı kullanım test edilmedi. Yerel Supabase için Docker servisi çalışır hale gelmedi. Fiziksel Android/iPhone kamera, konum izni ve bağlantı kesintisi testleri yapılmadı. iOS native derlemesi, Apple/Google imzalama ve mağaza gönderimi yapılmadı. Gönderim kuyruğunun gerçek ağ kesintisi altında iki cihazla doğrulanması canlıya geçiş kontrolüdür.

Bu kayıt, genel kullanıma hazır veya hatasız ürün sertifikası değildir; çalıştırılan kontrolleri ve sınırlarını ayırır. Canlıya geçiş adımları SETUP.md içindedir.
