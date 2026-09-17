# Patika

## 1. Projenin Amacı

**Patika**, sokak hayvanlarına yapılan yardımı daha düzenli, görünür, ölçülebilir ve sürdürülebilir hale getirmeyi amaçlayan mobil bir platformdur.

Patika'nın çözmek istediği temel problemler:

* İnsanlar yardım etmek istiyor ancak nerede ihtiyaç olduğunu bilmiyor.
* Bazı bölgelerde sürekli yardım yapılırken bazı bölgeler uzun süre unutulabiliyor.
* Yaralı veya yardıma muhtaç bir hayvan görüldüğünde kimin müdahale edeceği belirsiz olabiliyor.
* Gönüllüler birbirlerinden bağımsız çalışıyor.
* Yapılan yardımların etkisi çoğu zaman ölçülemiyor.
* Markaların ve kurumların yaptığı sosyal sorumluluk çalışmaları dağınık kalabiliyor.

Patika'nın temel amacı:

> **Sokak hayvanlarının nerede yardıma ihtiyaç duyduğunu gösteren canlı bir yardım ağı oluşturmak.**

Uzun vadede Patika;

* gönüllüleri,
* veterinerleri,
* üniversite topluluklarını,
* markaları,
* belediyeleri,
* bağışçıları

aynı platform üzerinde buluşturmayı hedefler.

### Kısa ürün tanımı

> **Patika, sokak hayvanlarının nerede yardıma ihtiyaç duyduğunu gösteren ve gönüllüleri gerçek zamanlı olarak harekete geçiren bir sosyal yardım ağıdır.**

### Startup perspektifinden tanım

> **Patika; sokak hayvanları için ihtiyaç, gönüllü, kurum ve finansmanı aynı teknoloji ağı üzerinde buluşturan bir platformdur.**

---

# 2. Ana Ürün: Canlı Yardım Haritası

Kullanıcı uygulamayı açtığında karşısına doğrudan bir harita çıkar.

Haritada:

* parklar,
* besleme noktaları,
* anlaşmalı veterinerler,
* acil yardım bildirimleri

gösterilir.

Her park veya yardım noktası için mevcut durum görülebilir.

Örneğin:

* 🟢 Bugün yardım edildi.
* 🟡 2 gündür yardım kaydı yok.
* 🔴 Uzun süredir yardım yapılmadı.
* 💧 Su ihtiyacı var.
* 🚨 Yaralı hayvan bildirimi var.
* 🙋 Bir gönüllü vakayı üstlendi.
* 🏥 Yakında Patika anlaşmalı veterineri bulunuyor.

Haritanın cevaplaması gereken temel soru:

> **"Şu anda benim yakınımda nerede gerçekten yardıma ihtiyaç var?"**

Patika'nın en önemli ürün farklılaşmalarından biri bu harita olacaktır.

---

# 3. Parklara Yardım Sistemi

Bir kullanıcı haritada bir park seçtiğinde o park hakkında şu bilgileri görebilir:

* son mama bırakılma zamanı,
* son su bırakılma zamanı,
* son kontrol zamanı,
* aktif yardım ihtiyacı,
* geçmiş yardım kayıtları.

Örneğin:

```text
Son mama: 3 gün önce
Son su: 1 gün önce
Son kontrol: bugün
```

Kullanıcı yardım yapmak istediğinde:

1. Parka gider.
2. Mama veya su bırakır.
3. Fotoğraf çeker.
4. Fotoğrafı Patika'ya yükler.
5. Sistem konum ve zaman bilgisini kontrol eder.
6. Parkın yardım durumu güncellenir.
7. Kullanıcı yaptığı yardım karşılığında puan ve ilerleme kazanır.

Bu sistem sayesinde hangi bölgelerin düzenli desteklendiği, hangi bölgelerin ise yardıma daha fazla ihtiyaç duyduğu zamanla anlaşılabilir.

---

# 4. Yardım Doğrulama Sistemi

Patika'nın çözmesi gereken önemli problemlerden biri sahte yardım kayıtlarıdır.

Örneğin bir kullanıcı:

* aynı fotoğrafı tekrar tekrar yükleyebilir,
* yardım yapmadan puan kazanmaya çalışabilir,
* farklı konumlardaki eski fotoğrafları kullanabilir.

Bunu engellemek için kullanılabilecek yöntemler:

* GPS kontrolü,
* zaman damgası,
* aynı fotoğrafın tekrar yüklenmesini engelleme,
* fotoğraf benzerliği kontrolü,
* aynı noktada kısa sürede yapılan tekrarların sınırlandırılması,
* günlük puan limitleri,
* topluluk doğrulaması,
* şüpheli kullanıcı davranışı analizi.

İlerleyen aşamalarda görüntü işleme ve yapay zekâ kullanılabilir.

Örneğin sistem fotoğraf üzerinde şunları kontrol edebilir:

* Mama kabı bulunuyor mu?
* Su kabı bulunuyor mu?
* Fotoğraf daha önce kullanılmış mı?
* Yardım yapılan alan park ile uyuşuyor mu?

Bu sistem Patika'nın teknik olarak önemli avantajlarından biri haline gelebilir.

---

# 5. Yaralı Hayvan Bildirim Sistemi

Kullanıcı yaralı veya yardıma muhtaç bir hayvan gördüğünde Patika üzerinden bildirim oluşturabilir.

Bildirim içerisinde:

* fotoğraf,
* konum,
* açıklama,
* hayvanın durumu,
* bildirim zamanı

bulunur.

Bildirim yakın gönüllülere ve uygun durumlarda ilgili veterinerlere gösterilebilir.

Ancak sistemde herkesin rastgele hayvana müdahale etmesi teşvik edilmemelidir.

Öncelikli müdahale grupları:

* doğrulanmış gönüllüler,
* anlaşmalı veterinerler,
* üniversite hayvansever toplulukları,
* ilgili kurum veya belediye ekipleri.

### Vaka durumları

Bir yardım vakası şu aşamalardan geçebilir:

```text
Bildirildi
↓
Doğrulanıyor
↓
Gönüllü Vakayı Üstlendi
↓
Gönüllü Yolda
↓
Veterinere Ulaştırıldı
↓
Tedavi Altında
↓
Çözüldü
```

Bir gönüllü vakayı üstlendiğinde sistem diğer kullanıcılara bunu gösterir.

Böylece aynı vakaya gereksiz yere birden fazla kişinin gitmesi engellenebilir.

---

# 6. Veteriner Ağı

Patika ile anlaşmalı veterinerler haritada gösterilebilir.

Kullanıcı:

* en yakın veterineri görebilir,
* Patika anlaşmalı veterinerlerini filtreleyebilir,
* Patika kullanıcılarına özel indirimlerden yararlanabilir.

Veterinerlerin Patika'ya katılma nedenleri:

* yeni müşterilere ulaşmak,
* sosyal sorumluluk projelerine katılmak,
* Patika topluluğunda görünür olmak,
* yaralı sokak hayvanlarının tedavisine destek olmak.

Patika ileride veterinerlerden:

* partner üyelik ücreti,
* öne çıkarma ücreti,
* kurumsal anlaşma bedeli

gibi gelirler elde edebilir.

Ancak acil hayvan vakalarında ticari teşvikler hayvanın çıkarının önüne geçmemelidir.

---

# 7. Üniversite Büyüme Modeli

Patika'nın ilk kullanıcılarını üniversitelerin hayvansever topluluklarından kazanması planlanmaktadır.

İlk aşamada kendi üniversitemizdeki hayvanseverler kulübü ile görüşülebilir.

Kulüp:

* uygulamayı test edebilir,
* parkları doğrulayabilir,
* ilk gönüllü grubunu oluşturabilir,
* QR kodlarının yerleştirilmesine yardımcı olabilir,
* uygulamanın kampüste tanıtımını yapabilir.

İlk pilot başarılı olduktan sonra diğer üniversitelerin hayvansever topluluklarına ulaşılabilir.

### Olası büyüme modeli

```text
Kendi Üniversitemiz
↓
İzmir'deki Üniversiteler
↓
İzmir
↓
İstanbul / Ankara
↓
Diğer Büyükşehirler
↓
Türkiye Geneli
```

Patika'nın büyümesi sadece şehir şehir değil, **üniversite üniversite hücresel büyüme** şeklinde tasarlanabilir.

---

# 8. Neden Küçük Bir Bölgede Başlamalıyız?

Patika'nın en büyük risklerinden biri boş görünen bir haritadır.

Türkiye genelinde 5.000 kullanıcı olsa fakat kullanıcılar çok dağınık olsa uygulama cansız görünebilir.

Ancak tek bir bölgede:

* 200 aktif kullanıcı,
* düzenli güncellenen 50 park,
* aktif yardım vakaları

olursa uygulama canlı görünür.

Bu nedenle:

> **10.000 pasif kullanıcı yerine 300 gerçekten aktif kullanıcı daha değerlidir.**

İlk hedef çok fazla indirme almak değil, belirli bir bölgede yüksek kullanıcı yoğunluğu oluşturmaktır.

---

# 9. MVP

İlk sürüm mümkün olduğunca küçük tutulmalıdır.

## İlk sürümde bulunması gerekenler

* kullanıcı kayıt sistemi,
* harita,
* parklar,
* parkların son yardım bilgileri,
* mama yardımı kaydı,
* su yardımı kaydı,
* fotoğraf yükleme,
* konum doğrulama,
* basit puan sistemi,
* yaralı hayvan bildirimi,
* veteriner noktaları,
* basit leaderboard.

## İlk sürümde olmaması gerekenler

* karmaşık bağış sistemi,
* Patika Mama,
* gelişmiş yapay zekâ,
* belediye yönetim paneli,
* büyük e-ticaret sistemi,
* karmaşık sosyal medya özellikleri,
* onlarca rozet,
* gereksiz mikroservis mimarisi.

İlk MVP'nin cevaplaması gereken ana soru:

> **"İnsanlar Patika'yı bir kere kullandıktan sonra tekrar kullanıyor mu?"**

---

# 10. Ana Başarı Metrikleri

Patika için indirme sayısı tek başına önemli değildir.

Takip edilmesi gereken temel metrikler:

* günlük aktif kullanıcı,
* haftalık aktif kullanıcı,
* aylık aktif kullanıcı,
* aktif gönüllü sayısı,
* kullanıcı başına yapılan yardım,
* toplam doğrulanmış yardım,
* 7 günlük retention,
* 30 günlük retention,
* ikinci kez yardım yapan kullanıcı oranı,
* üçüncü kez yardım yapan kullanıcı oranı.

Örneğin:

```text
10.000 indirme
250 aktif gönüllü
```

zayıf olabilir.

Ancak:

```text
2.000 kullanıcı
700 aylık aktif gönüllü
```

çok daha değerli olabilir.

---

# 11. Kullanıcıların Uygulamayı Bırakmasını Engellemek

Patika'nın başarısındaki en kritik problem kullanıcıların uygulamayı birkaç kez kullanıp bırakmasıdır.

Bu nedenle yardım davranışı bir alışkanlığa dönüştürülmelidir.

Temel kullanıcı döngüsü:

```text
İhtiyacı Gör
↓
Küçük Bir Aksiyon Al
↓
Sonucunu Gör
↓
Etkini Gör
↓
İlerleme Hisset
↓
Tekrar Gel
```

Uygulama yalnızca:

```text
+50 Puan
```

göstermemelidir.

Bunun yerine:

```text
Bu ay 7 yardım yaptın.
4 farklı parkın bakımına katkı sağladın.
18 günlük bakım zincirinin parçası oldun.
1 acil vakaya destek verdin.
```

gibi gerçek etki gösterilmelidir.

---

# 12. Favori Parklar

Kullanıcı bazı parkları takip edebilir.

Örneğin:

* evinin yakınındaki park,
* üniversitesinin parkı,
* her gün yürüdüğü park.

Kullanıcıya şu tarz bildirimler gönderilebilir:

> "Takip ettiğin Atatürk Parkı'nda 2 gündür su kaydı bulunmuyor."

Bu sistem kullanıcıda bir çeşit sahiplenme hissi yaratabilir.

Amaç kullanıcının:

> **"Türkiye'deki bütün sokak hayvanlarından sorumluyum."**

gibi büyük bir yük hissetmesi değil,

> **"Benim takip ettiğim birkaç park var."**

duygusunu oluşturmasıdır.

---

# 13. Oyunlaştırma

Patika içerisinde kullanıcıların yaptığı yardımlar puanlandırılabilir.

Puanın adı örneğin:

**Pati Puanı**

olabilir.

### Örnek seviyeler

```text
Destekçi
↓
Gönüllü
↓
Koruyucu
↓
Patika Elçisi
```

Ancak oyunlaştırma sisteminin amacı kullanıcıları anlamsız şekilde puan kasmaya yönlendirmek olmamalıdır.

Asıl gösterilmesi gereken kullanıcının yaptığı gerçek etkidir.

---

# 14. Farklı Leaderboard Sistemleri

Para bağışlayan kullanıcılarla fiziksel olarak yardım yapan kullanıcılar aynı tabloda değerlendirilmemelidir.

Farklı kategoriler oluşturulabilir:

* En Aktif Gönüllüler
* En Çok Yardım Yapanlar
* En Çok Kurtarma Vakası Çözenler
* En Aktif Üniversiteler
* En Aktif Topluluklar
* En Fazla Maddi Destek Sağlayanlar

Bu şekilde gönüllü emeği ile maddi destek birbirinden ayrılmış olur.

---

# 15. Üniversiteler Arası Rekabet

Üniversitelerin kendi Patika ekipleri olabilir.

Örneğin:

```text
Ege Üniversitesi
Yaşar Üniversitesi
Dokuz Eylül Üniversitesi
İYTE
```

Her ekip için:

* toplam yardım,
* aktif gönüllü,
* desteklenen park,
* çözülen yardım vakası

gösterilebilir.

Bu sayede üniversiteler arasında pozitif bir rekabet oluşturulabilir.

---

# 16. Küçük Görev Sistemi

Her kullanıcının büyük yardım yapması beklenmemelidir.

Patika içerisinde küçük görevler oluşturulabilir.

Örneğin:

* Su kabını doldur.
* Parkın durumunu kontrol et.
* Bir yardım kaydını doğrula.
* Veteriner bilgisini güncelle.
* Bir yaralı hayvan ihbarını kontrol et.
* Mama bırak.
* Bir kurtarma vakasına destek ver.

Bu sayede kullanıcı:

> "Bugün büyük bir yardım yapamıyorum."

diyerek uygulamadan tamamen kopmaz.

---

# 17. Bildirim Sistemi

Patika bildirimleri spam şeklinde olmamalıdır.

Bildirimler mümkün olduğunca kişiselleştirilmelidir.

Örnek bildirimler:

> "Takip ettiğin parkta 3 gündür mama kaydı bulunmuyor."

> "Sana 600 metre uzaklıkta su ihtiyacı olan bir nokta var."

> "Geçen hafta yardım ettiğin park tekrar desteğe ihtiyaç duyuyor."

İleride sistem kullanıcı davranışlarını öğrenebilir.

Örneğin:

> "Genellikle pazar günleri yardım yapıyorsun. Sana yakın iki parkta bu hafta yardım kaydı bulunmuyor."

---

# 18. Sosyal Medya Stratejisi

Patika güçlü bir sosyal medya markası haline gelebilir.

Kullanılabilecek platformlar:

* Instagram
* TikTok
* YouTube Shorts
* Facebook
* X

Markanın bütün kimliği öfke ve tartışma üzerine kurulmayacaktır.

Hayvanlara kötü davranan durumlarda tepki gösterilebilir ancak ana marka dili:

* yardım,
* umut,
* dayanışma,
* çözüm,
* gerçek sonuç

üzerinden oluşturulmalıdır.

### Güçlü içerik formatı

```text
13:42 — Yaralı kedi bildirildi.
13:49 — Bir Patika gönüllüsü vakayı üstlendi.
14:25 — Veterinere ulaştırıldı.
Ertesi gün — Tedavisi tamamlandı.
```

Bu tür gerçek hikâyeler Reels ve TikTok içerikleri için oldukça güçlü olabilir.

---

# 19. Ünlüler ve Yayıncılar

Proje henüz başlangıç aşamasındayken:

> "Uygulamamızı paylaşır mısınız?"

şeklindeki mesajların dönüş oranı düşük olabilir.

Ancak Patika'nın elinde somut veriler olduğunda durum değişir.

Örneğin:

```text
5.000 kullanıcı
20.000 yardım
80 tedavi
10 üniversite
```

gibi sonuçlarla içerik üreticilerine ulaşılabilir.

Bu durumda:

> "Bize yardım edin."

yerine:

> **"Büyüyen bir sosyal harekete katılmak ister misiniz?"**

denilebilir.

### Yayıncı kampanyası örneği

> "X yayıncısının topluluğu bu hafta 50 parkı besliyor."

Bu kampanyalar yayıncıların kendi topluluklarını harekete geçirmesine de olanak sağlar.

---

# 20. Marka İş Birlikleri

Patika'nın önemli gelir kaynaklarından biri markalar olabilir.

Potansiyel marka kategorileri:

* mama markaları,
* pet şirketleri,
* perakende zincirleri,
* bankalar,
* telekom şirketleri,
* veteriner şirketleri,
* büyük kurumsal firmalar.

### Sponsorlu görev örneği

> **X Markası ile 10.000 Kap Mama Kampanyası**

Marka kampanyayı finanse eder.

Patika kullanıcıları görevleri gerçekleştirir.

Yardımlar doğrulanır.

Markaya kampanya sonunda rapor sunulur.

Örneğin:

```text
12.318 yardım
417 park
2.674 gönüllü
8.2 ton mama
24 şehir
```

Patika böylece markalara yalnızca reklam değil:

> **ölçülebilir sosyal etki altyapısı**

sunabilir.

---

# 21. B2B Gelir Modeli

Patika'nın ana şirket gelirinin kullanıcı bağışlarından değil B2B taraftan gelmesi daha sağlıklı olabilir.

Potansiyel gelir kaynakları:

1. Sponsorlu kampanyalar
2. Kurumsal sosyal sorumluluk kampanyaları
3. Sosyal etki raporlama
4. Veteriner partnerlikleri
5. Pet shop satış ortaklıkları
6. Mama satış ortaklıkları
7. Belediye yazılımları
8. Kurumsal yönetim panelleri
9. Patika'nın kendi ürünleri

---

# 22. Belediyeler

Belediyeler uzun vadede Patika'nın önemli ortaklarından veya müşterilerinden biri olabilir.

Ancak başlangıç aşamasında belediyelerle büyümek yavaş olabilir.

Önce:

* üniversiteler,
* gönüllüler,
* veterinerler,
* markalar

üzerinden kullanım kanıtlanmalıdır.

Daha sonra belediyelere şu bilgiler sunulabilir:

* hangi bölgelerde yardım eksik,
* hangi bölgelerde yaralı hayvan ihbarı yoğun,
* aktif gönüllüler,
* desteklenen parklar,
* yardım yoğunluk haritası.

İleride Patika belediyelere özel yönetim paneli sunabilir.

---

# 23. Bağış Sistemi

Patika içerisinde ilerleyen aşamalarda bağış sistemi bulunabilir.

Örneğin varlıklı bir kullanıcı:

> "100.000 TL yardım etmek istiyorum ancak tek tek park gezemem."

diyebilir.

Bu para:

* mama,
* veteriner,
* tedavi,
* su sistemi,
* barınak,
* besleme noktaları,
* altyapı

gibi ihtiyaçlara aktarılabilir.

Ancak bağış sistemi Patika'nın hukuken ve güven açısından en hassas bölümlerinden biridir.

Bu nedenle:

* yardım fonu,
* şirket gelirleri,
* operasyon gelirleri

birbirinden açık şekilde ayrılmalıdır.

---

# 24. Bağışların %10'u Konusu

İlk fikirlerden biri:

> Bağışların %10'unun geliştiricilere veya Patika operasyonuna ayrılması.

Ancak kullanıcı açısından şu algı oluşabilir:

> "Ben hayvanlar için 100 TL verdim ama 10 TL kuruculara gitti."

Bu nedenle daha temiz modeller değerlendirilebilir.

Örneğin:

```text
Hayvanlara Yardım: 1.000 TL
Patika Platform Desteği: +100 TL (isteğe bağlı)
```

Alternatif yapılarda operasyon payı açıkça gösterilebilir.

Ancak hiçbir şekilde gizli kesinti yapılmamalıdır.

Patika'nın ana ilkelerinden biri:

> **Radikal şeffaflık**

olmalıdır.

Bağış sistemi hayata geçirilmeden önce hukuki ve mali yapı profesyonel olarak değerlendirilmelidir.

---

# 25. Şeffaflık Sistemi

Patika içerisinde bir **Şeffaflık** ekranı oluşturulabilir.

Örneğin:

```text
Bu Ay Toplanan Yardım:
2.840.000 TL

Mama:
1.730.000 TL

Veteriner:
640.000 TL

Altyapı:
310.000 TL

Kalan Fon:
160.000 TL
```

Şirket gelirleri ayrı gösterilebilir:

```text
Sponsor Gelirleri
Kurumsal Anlaşmalar
Ürün Satışları
Veteriner Partnerlikleri
```

Bu sistem kullanıcıların:

> **"Param nereye gitti?"**

sorusuna cevap verir.

---

# 26. Patika'nın Para Kazanma Modeli

Patika'nın temel ekonomik yaklaşımı:

> **Bağıştan değil, ekosistemden para kazanmak.**

Uzun vadeli gelir kaynakları:

* sponsorlu görevler,
* kurumsal sosyal sorumluluk projeleri,
* veteriner partnerlikleri,
* ürün satış ortaklıkları,
* belediye yazılımı,
* kurumsal platformlar,
* Patika Mama,
* diğer Patika ürünleri.

---

# 27. Patika Mama

Patika yeterince büyüdüğünde kendi mama markasını oluşturabilir.

Başlangıç aşamasında fabrika kurmak yerine private-label üretim yapılabilir.

Bir mama üreticisi ürünü üretir ve Patika markasıyla paketler.

İlk ürünün premium mama olması şart değildir.

Patika'nın doğal kitlesi sokak hayvanlarını besleyen insanlardan oluşacağı için ilk ürün:

* kaliteli,
* ekonomik,
* büyük paketli

olabilir.

Örnek ürün:

> **Patika Sokak Dostları Kedi Maması**

İlerleyen dönemlerde:

* Patika Premium
* Patika Kitten
* Patika Dog
* Patika Sterilised

gibi ürünler eklenebilir.

---

# 28. Mama Üretimi İçin Tahmini Başlangıç Sermayesi

Fabrika kurmak yerine mevcut üreticiye üretim yaptırıldığı senaryoda konuşulan yaklaşık bütçeler:

| Model                          |         Yaklaşık Sermaye |
| ------------------------------ | -----------------------: |
| Küçük test üretimi             |     250.000 - 400.000 TL |
| Düzgün ticari başlangıç        |   500.000 - 1.000.000 TL |
| Birkaç ürün + stok + pazarlama | 1.000.000 - 2.000.000 TL |
| Büyük lansman / özel reçete    |            2.000.000 TL+ |

Bu rakamlar kesin üretici teklifleri değil, yaklaşık planlama değerleridir.

---

# 29. Patika Mama İçin Doğru Zaman

Mama markası uygulamanın ilk döneminde çıkarılmamalıdır.

Örneğin aşağıdaki seviyelere ulaşıldığında değerlendirilebilir:

```text
20.000 kayıtlı kullanıcı
3.000 aylık aktif gönüllü
20 üniversite
50.000 doğrulanmış yardım
```

Daha sonra kullanıcılarla talep testi yapılabilir.

Örneğin:

> "Patika kendi mamasını çıkarsa satın alır mıydın?"

Yeterli talep oluştuğunda üreticiyle görüşmeye başlanabilir.

---

# 30. Mama ve Uygulamanın Birleşmesi

Patika Mama paketlerinde QR kod bulunabilir.

QR okutulduğunda kullanıcı şunları görebilir:

```text
Bu ay Patika Mama sayesinde:

12.840 yardım
316 park
17 şehir
```

Uygulamada mama satın alırken iki seçenek sunulabilir:

```text
Kendim kullanacağım
```

veya:

```text
Bir Patika gönüllüsüne gönder
```

Örneğin Ankara'daki bir kullanıcı İzmir'deki bir gönüllüye mama satın alabilir.

Gönüllü mamayı dağıttığında fotoğraf yükler.

Mama gönderen kişiye şu bildirim gider:

> **"Gönderdiğin mama bugün 4 farklı noktada kullanıldı."**

Bu sistem yardımın etkisini görünür hale getirir.

---

# 31. Patika'nın Growth Loop'u

İdeal büyüme döngüsü:

```text
Kullanıcı Patika'ya Gelir
↓
Yardım Yapar
↓
Yardım Sistemde Görünür
↓
İçerik Oluşur
↓
Sosyal Medyada Paylaşılır
↓
Yeni Kullanıcılar Gelir
↓
Daha Fazla Yardım Yapılır
↓
Markaların İlgisi Artar
↓
Sponsorlar Gelir
↓
Daha Büyük Kampanyalar Yapılır
↓
Daha Fazla Kullanıcı Gelir
```

Uzun vadede buna ürün satışları da eklenebilir.

---

# 32. Patika'nın Rekabet Avantajı

Patika'nın en büyük avantajı kod olmayacaktır.

Çünkü yazılım özellikleri rakipler tarafından kopyalanabilir.

Asıl avantaj:

* gönüllü ağı,
* üniversite ağı,
* veteriner ağı,
* marka ilişkileri,
* belediye ilişkileri,
* park verileri,
* yardım geçmişi,
* kullanıcı güveni,
* topluluk kültürü

olacaktır.

Bir rakip birkaç ay içerisinde benzer bir uygulama geliştirebilir.

Ancak:

```text
20.000 aktif gönüllü
200 veteriner
50 üniversite
1.000.000 yardım kaydı
```

gibi bir ağı kısa sürede kopyalayamaz.

Bu nedenle Patika bir **network business** olarak görülmelidir.

---

# 33. Startup Yaklaşımı

Patika'ya:

> "Bir uygulama geliştiriyoruz."

şeklinde değil,

> **"Bir yardım ağı ve ekosistem kuruyoruz."**

şeklinde bakılmalıdır.

İlk amaç yatırım almak değildir.

İlk amaç:

* gerçek problemi çözmek,
* gerçek kullanıcı kazanmak,
* tekrar kullanım yaratmak,
* sistemi küçük ölçekte kanıtlamak.

İlk kritik hedef:

> **100 aktif gönüllü**

Sonrasında:

```text
100
↓
1.000
↓
10.000
↓
100.000
```

şeklinde büyüme düşünülebilir.

---

# 34. Yatırımcıya Patika'yı Anlatmak

Zayıf anlatım:

> "Sokak hayvanlarına yardımcı olan bir uygulamamız var."

Güçlü anlatım:

> "8 üniversitede 4.300 kullanıcımız bulunuyor. Kullanıcılarımız ayda 11.000 doğrulanmış yardım gerçekleştiriyor. Kullanıcıların %X'i 30 gün sonra hâlâ aktif. 20 anlaşmalı veterinerimiz ve iki ücretli marka pilotumuz bulunuyor."

Yatırımcıların görmek istediği:

* traction,
* retention,
* büyüme,
* network,
* gelir,
* aktif kullanıcı,
* güçlü kullanıcı davranışı.

---

# 35. Kurucu Rolleri

Başlangıç aşamasında tüm işleri iki kurucunun birlikte yapması mümkündür.

Ancak zamanla sorumlulukların ayrılması gerekir.

Örnek yapı:

### Kurucu 1

* teknoloji,
* mobil uygulama,
* backend,
* veri,
* ürün geliştirme.

### Kurucu 2

* growth,
* üniversiteler,
* veterinerler,
* markalar,
* sosyal medya,
* operasyon.

Büyük kararlar birlikte alınmalıdır.

Ayrıca başlangıç aşamasında şu konular yazılı hale getirilmelidir:

* hisse oranları,
* görevler,
* karar alma sistemi,
* zaman taahhüdü,
* şirketten ayrılma durumları.

---

# 36. Teknik Mimari

İlk aşamada mümkün olduğunca basit ve hızlı bir mimari kullanılabilir.

### Mobil

* Flutter
* React Native

### Backend

* Supabase
* Node.js
* benzeri backend çözümleri

### Veritabanı

* PostgreSQL
* PostGIS

### Harita

* Google Maps
* Mapbox
* OpenStreetMap

### Dosya / Fotoğraf

* Object Storage

### Bildirim

* Firebase Cloud Messaging

### Ana Veri Modelleri

```text
User
Park
Location
Assistance
Photo
Report
RescueCase
Veterinarian
University
Team
Points
Campaign
Donation
Sponsor
```

İlk aşamada karmaşık mikroservis mimarisi gereksizdir.

---

# 37. QR Kod Sistemi

Parklara Patika QR kodları yerleştirilebilir.

Kullanıcı QR kodu okuttuğunda doğrudan ilgili parkın sayfasına ulaşabilir.

QR üzerinden:

* park bilgisi,
* son yardım,
* yardım yap,
* su durumu,
* mama durumu

görülebilir.

Üniversite kulüpleri QR kodların yayılmasına yardımcı olabilir.

İleride belediyelerle resmi entegrasyon yapılabilir.

---

# 38. Ödül Sistemi

Patika markalarla iş birliği yaparak kullanıcılara ödüller sağlayabilir.

Örneğin:

* kahve indirimi,
* pet shop indirimi,
* Patika tişörtü,
* özel rozet,
* etkinlik daveti.

Ancak ödül yardım davranışının ana sebebi olmamalıdır.

Ödül yalnızca davranışın bonusu olmalıdır.

---

# 39. Rakipler ve Farklılaşma

Türkiye'de sokak hayvanlarıyla ilgili çeşitli uygulamalar ve belediye çözümleri bulunmaktadır.

Bu durum problemin gerçek olduğunu gösterir.

Patika'nın farklılaşabileceği noktalar:

* canlı yardım haritası,
* park bazlı güncel durum,
* doğrulanmış yardımlar,
* aktif gönüllü sistemi,
* üniversite ağı,
* oyunlaştırma,
* kurumsal kampanyalar,
* sosyal etki ölçümü,
* güçlü topluluk,
* yardım geçmişi.

Patika'nın konumlandırması:

> **Türkiye'nin canlı sokak hayvanı yardım ağı**

olabilir.

---

# 40. Patika'nın Güçlü Tarafları

* Gerçek bir problemi çözüyor.
* İnsanlarda güçlü duygusal karşılığı var.
* Fikir kolay anlatılıyor.
* Mobil uygulamaya doğal şekilde uyuyor.
* Harita çözümü probleme uygun.
* Üniversiteler güçlü bir dağıtım kanalı oluşturabilir.
* Sosyal medya için doğal içerik üretebilir.
* Influencer kampanyalarına uygun.
* Markaların sosyal sorumluluk bütçelerine uygun.
* Veteriner ağı oluşturulabilir.
* Belediye entegrasyonuna açık.
* Kendi ürün markasına dönüşebilir.
* Network effect oluşturabilir.

---

# 41. Patika'nın Riskleri

* Kullanıcıların ilk heyecandan sonra uygulamayı bırakması.
* Sahte yardım kayıtları.
* Boş harita problemi.
* Çok erken Türkiye geneline açılmak.
* Gereksiz özellik geliştirmek.
* Bağış konusunda güven kaybı.
* Hukuki problemler.
* Yanlış hayvan müdahaleleri.
* Sahte acil yardım bildirimleri.
* Marka kimliğinin aşırı tartışmacı hale gelmesi.
* Kurucu rol çatışmaları.
* Operasyon maliyetlerinin kontrolden çıkması.
* Rakiplerin özellikleri kopyalaması.
* Gönüllü yoğunluğunun yeterli seviyeye ulaşmaması.

---

# 42. Patika'nın Tutması Ne Demek?

Başarı yalnızca indirme sayısı değildir.

Patika gerçekten başarılı olduğunda insanlar:

> "Sokak hayvanına yardım etmek istiyorum."

dediklerinde:

> **"Patika'yı açayım."**

diye düşünmelidir.

Daha ileri aşamada hedef:

> Kullanıcının marketten çıkarken "Mama da alayım, Patika'da bir yere bırakırım." demesi.

Yardım davranışı günlük hayatın doğal bir parçası haline geldiğinde Patika gerçekten başarılı olmuş olacaktır.

---

# 43. İlk 90 Günlük Plan

## Aşama 1 — Kullanıcı Araştırması

* 20-30 hayvanseverle görüş.
* Üniversite topluluğuyla görüş.
* İnsanların mevcut yardım alışkanlıklarını öğren.
* En büyük problemleri belirle.

## Aşama 2 — Prototype

* Figma tasarımı oluştur.
* Harita ekranı hazırla.
* Yardım akışını oluştur.
* Yaralı hayvan bildirimi prototipi hazırla.
* Kullanıcılara test ettir.

## Aşama 3 — MVP

* Mobil uygulama.
* Harita.
* Yardım kayıt sistemi.
* Fotoğraf.
* Konum.
* Basit puanlama.
* Yaralı hayvan ihbarı.

## Aşama 4 — Pilot

* Tek üniversite.
* Küçük bir bölge.
* İlk 100 aktif gönüllü.

## Aşama 5 — Ölçüm

Takip edilecek:

* kaç kişi kayıt oldu,
* kaç kişi yardım yaptı,
* kaç kişi ikinci kez geldi,
* kaç kişi 30 gün sonra aktif kaldı.

---

# 44. Şimdilik Yapılmaması Gerekenler

* Türkiye genelinde aynı anda açılmak.
* İlk günden mama üretmek.
* İlk günden bağış toplamaya başlamak.
* Belediye bürokrasisine erken gömülmek.
* Çok erken yatırımcı aramak.
* 50 farklı özellik geliştirmek.
* Büyük ve pahalı sunucu altyapısı kurmak.
* Büyük reklam bütçesi harcamak.
* İlk günden gelir maksimizasyonu yapmak.

İlk amaç:

> **Product-Market Fit sinyallerini bulmak.**

---

# 45. Uzun Vadeli Yol Haritası

## Aşama 1

Gönüllü yardım haritası.

## Aşama 2

Üniversite ve topluluk ağı.

## Aşama 3

Veteriner ağı.

## Aşama 4

Marka kampanyaları.

## Aşama 5

Belediye ve kurum yazılımları.

## Aşama 6

Bağış ve yardım altyapısı.

## Aşama 7

Patika Mama.

## Aşama 8

Diğer Patika ürünleri.

Uzun vadeli vizyon:

> **Patika'nın yalnızca bir mobil uygulama değil, Türkiye'de sokak hayvanları konusunda dijital altyapı, yardım ağı ve güçlü bir topluluk markası haline gelmesi.**

---

# 46. İş Modeli Özeti

### Kullanıcı

* uygulamayı ücretsiz kullanır,
* yardım yapar,
* topluluğa katılır.

### Veteriner

* partner olur,
* Patika kullanıcılarına hizmet verir.

### Marka

* sponsorlu kampanya satın alır.

### Şirketler

* sosyal etki kampanyaları yürütür.

### Belediyeler

* veri ve operasyon yazılımını kullanabilir.

### Pet Şirketleri

* ürün ortaklığı yapabilir.

### Patika

* kendi ürünlerini satabilir.

### Yardım Fonları

* ayrı ve şeffaf şekilde yönetilir.

Sonuç olarak Patika:

> **Sosyal etki + ticari sürdürülebilirlik**

üreten bir yapıya dönüşebilir.

---

# 47. Şu Anki En Önemli Hedef

Şu anda hedef:

> **Türkiye'nin en büyük hayvan uygulamasını yapmak değildir.**

İlk hedef:

> **Küçük bir bölgede insanların gerçekten tekrar tekrar kullandığı bir yardım ağı kurmaktır.**

Bunu kanıtladığımızda:

* markalarla görüşmek kolaylaşır,
* veteriner ağı büyür,
* üniversiteler katılır,
* yatırımcı ilgisi artar,
* belediyelerle görüşmek anlamlı hale gelir,
* Patika Mama gibi ürünler mümkün olur.

Patika'nın ilk kritik başarısı:

> **İlk 100 gerçek aktif gönüllü.**

---

# 48. Patika'nın Temel Vizyonu

Patika'nın uzun vadede değerli olan tarafı yalnızca yazılım olmayacaktır.

Asıl değer:

```text
Gönüllüler
+
Üniversiteler
+
Veterinerler
+
Markalar
+
Belediyeler
+
Veri
+
Topluluk
+
Güven
```

olacaktır.

Bu nedenle Patika'nın temel vizyonu:

> **"Bir uygulama geliştirmek değil, sokak hayvanları için çalışan büyük ve sürdürülebilir bir yardım ağı kurmak."**
