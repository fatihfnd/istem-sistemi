# İstem — kurulum

## 1) Supabase
1. `istem_sistemi_sema.sql` dosyasını Supabase SQL Editor'de çalıştırın.
2. Ardından `policies.sql` dosyasını çalıştırın (RLS + realtime yayını).
3. Ardından `setler_sema.sql` dosyasını çalıştırın (İstek Setleri + Cihazlar tabloları, eski "hazır setler"i otomatik taşır — idempotenttir, tekrar çalıştırmak güvenlidir).
4. Ardından `hizmetler_sema.sql` dosyasını çalıştırın (faturalama alanları: `istemler.fatura_girildi/fatura_giren_id/fatura_zamani` — idempotenttir).
5. Ardından `yonetim_sema.sql` dosyasını çalıştırın (`test_gruplari` referans tablosu + `test_katalog`/`sablonlar`/`istem_kalemleri`/`istek_setleri`'ndeki sabit CHECK kısıtını FK'ya çevirir — idempotenttir, mevcut veriyi bozmaz).
6. Settings → API'den **Project URL** ve **anon public key**'i alıp [app/config.js](app/config.js) içine yazın.

## 1b) Supabase Auth'a geçiş (RLS'yi gerçekten kilitlemek için)
Prototipte RLS `anon` rolüne tam açıktı — bu, giriş ekranını hiç görmeden anon key ile doğrudan veriye erişimi engellemiyordu. Bunu kapatmak için sırasıyla:

1. `auth_setup_sema.sql`'i çalıştırın (katkısal — `kullanicilar.email`/`auth_user_id` kolonları + `kullanicilar_login_v` görünümü).
2. **Supabase Dashboard → Authentication → Sign In / Providers → Email → "Confirm email" kapatın.** Bu adım SQL ile yapılamaz. Kapatılmazsa `@istem.local` sahte adreslerine gerçek e-posta gitmediği için yeni hesaplar sonsuza dek onaylanmamış kalır, giriş yapamaz.
3. Bu kod deploy edildikten sonra (zaten deploy) mevcut kullanıcılarla eski yoldan (düz PIN karşılaştırma, geçici fallback) giriş yapılabilir. **Kullanıcılar** sayfasına gidip **"Auth hesabı olmayanları taşı"** butonuna basın — herkes için gerçek bir Supabase Auth hesabı oluşur, mevcut PIN'leri şifre olur.
4. Bir kullanıcıyla çıkış yapıp tekrar giriş yaparak artık gerçek Auth üzerinden girdiğini doğrulayın (liste "Auth hesabı yok" ibaresi göstermemeli).
5. **Ancak o zaman** `secure_rls_authenticated.sql`'i çalıştırın — bu, tüm tabloları `authenticated`-only yapar (anon erişimi tamamen keser). Migrasyon tamamlanmadan bu dosyayı çalıştırırsanız taşınmamış kullanıcılar kilitlenir.
6. (İsteğe bağlı, ileride) `api.js`'teki `login()` içindeki "GEÇİCİ fallback" bloğu kaldırılabilir, `kullanicilar.pin` kolonu düşürülebilir — artık kullanılmıyor.

## 1c) Rol bazlı yetkiler (`yetki_sema.sql`)
**Sıra önemli: önce SQL, sonra kod deploy.** Yeni kod girişte `kullanicilar.is_admin`'i okur; kolon yoksa giriş kırılır.

1. `secure_rls_authenticated.sql` çalışmış ve herkes Auth'a taşınmış olmalı (script bunu kendisi kontrol eder, değilse hiçbir şey yapmadan durur).
2. `yetki_sema.sql`'i SQL Editor'de çalıştırın (tek transaction, idempotent). İlk yönetici olarak **Öğr. Gör. Dr. Fatih Demir** hesabını id + birebir ad ile işaretler; birebir eşleşme tek değilse ya da benzer isimli başka bir hesap (pasifler dahil) varsa durur ve eşleşen satırları listeler — en yakın eşleşmeyi otomatik seçmez.
3. Kodu deploy edin.

Getirdikleri:
- **Yönetici (`is_admin`)**: Yönetim sayfaları (İstatistikler, Kullanıcılar, Test Grupları, Test Kataloğu, Yedekler) sadece yöneticiye görünür; `kullanicilar`/`test_gruplari` yazma, `test_katalog` düzenleme/silme ve yedek indirme RLS'te de sadece yönetici.
- **İstek Setleri**: teknisyen dışında herkes ekler/düzenler/siler; teknisyen sadece görür. Yeni yöneticiyi Kullanıcılar formundaki "Yönetici" kutusuyla atayın.
- **Kalem silme**: yönetici her kalemi (Tamamlandı dahil); diğerleri sadece kendi açtığı istemdeki, Tamamlandı olmayan kalemleri.
- **Durum değiştirme** (İşleme Al / Tamamla / Geri Al): yalnız yönetici ve teknisyen; uzman/asistan (admin değilse) kendi Bekleyen kalemini yalnız "İptal Et" (silme kuralı) ile geri çeker (veritabanında trigger ile; son hali `ekip_sema.sql`'de). Arayüzde "Cihazda" durumu "İşlemde" olarak görünür; veritabanındaki değer `cihazda` kalır.
- **Teknisyen**: sıfırdan istem giremez, Şablonlar'a erişemez, İstek Setleri'ni düzenleyemez; tek istem yolu detay panelindeki "Tekrar İste".
- **Tekrar İste**: aynı test/blok için yeni bir istem kaydı + Bekleyen kalem (`istem_kalemleri.tekrar_kaynagi_id` kaynağa bağlı). Hizmetler'de "Tekrar" rozetiyle görünür.
- **Kalite notu** (`istem_kalemleri.kalite_notu`) ve **herkese açık şablon** (`sablonlar.herkese_acik`).
- `istemler` ve `istem_kalemleri`'nde UPDATE kolon bazlıdır (sadece fatura / durum-cihaz-kalite notu kolonları).

⚠️ Bu dosyadan SONRA `policies.sql`, `setler_sema.sql`, `yonetim_sema.sql` ya da `secure_rls_authenticated.sql`'i yeniden çalıştırmayın — eski "herkese açık" politikaları geri ekler. Çalıştırırsanız ardından `yetki_sema.sql`'i ve `ek_ozellikler_sema.sql`'i tekrar çalıştırın.

## 1d) Kendi profilim: PIN + fotoğraf (`profil_sema.sql`)
`yetki_sema.sql`'den sonra, **kod deploy edilmeden önce** çalıştırın (idempotent). Yeni kod girişte `kullanicilar.avatar_url`'i okur.

- Herkes (rol farkı yok) sol alttaki kullanıcı alanından **kendi** PIN'ini değiştirir: eski PIN, girişle aynı yoldan doğrulanır, yeni PIN doğrudan Supabase Auth şifresi olur. `kullanicilar.pin`'e yeni PIN **yazılmaz** (o kolonu giriş yapan herkes okuyabilir; Auth hesabı olanlar için hiçbir yerde kullanılmıyor) — sadece varsa eski kopya temizlenir.
- Profil fotoğrafı: private `avatarlar` bucket'ı, herkes yalnızca kendi klasörüne (`<auth_uid>/…`) yazar, giriş yapan herkes okur (uygulama imzalı URL kullanır). Tarayıcıda 256×256 kare JPEG'e küçültülür; JPG/PNG, en fazla 2 MB.
- Tema / mod / tablo yoğunluğu tercihleri veritabanında değil, tarayıcının localStorage'ında kullanıcı başına tutulur (`app/tema.js`).

**Yeni kullanıcı eklerken / oluştururken:** Auth hesabı oturum saklamayan ayrı bir Supabase client ile açılır — yöneticinin kendi oturumu hiç değişmez.

## 1d2) Kısaltma, çoklu not, toplu tekrar, istatistikler (`ek_ozellikler_sema.sql`)
`yetki_sema.sql` ve `profil_sema.sql`'den sonra, **kod deploy edilmeden önce** çalıştırın (tek transaction, idempotent). Yeni kod `istem_kuyruk_v`'nin `notlar` / `isteyen_kisaltma` / `uzman_kisaltma` kolonlarını ve `kullanicilar.kisaltma`'yı okur.

- **Kısaltma** (`kullanicilar.kisaltma`): Kullanıcılar formundan yönetici girer; İş Kuyruğu ve Hizmetler'de İsteyen / Uzman Adına'da kısaltma görünür (tam ad ipucu olarak; kısaltma yoksa tam ad). Büyük/küçük harf duyarsız benzersiz.
- **Çoklu not** (`istem_notlari`): istem başına yazan + zaman damgalı liste; düzenleme yok, yazan kendi notunu / yönetici her notu siler. Eski `istemler.not_metni` silinmez, içeriği listeye taşınır (tekrar çalıştırmak çift kayıt üretmez). Önbellekte kalmış eski sürüm hâlâ `not_metni` yazarsa trigger listeye kopyalar.
- **Toplu Tekrar İste** (`tekrar_iste_toplu`): seçili Cihazda/Tamamlandı kalemler; aynı kaynak istemden gelenler tek yeni istemde toplanır.
- **İstatistikler** (`istatistik()`, yalnız yönetici): canlı veriden haftalık/aylık istem, kalem, tip dağılımı, kullanıcı bazında istem, uzman adına dağılım, ortalama/medyan tamamlanma süresi. Son hali `ozet_yedek_sema.sql`'de.
- İş Kuyruğu'nda 30 günden eski **Tamamlandı** kayıtlar varsayılan gizlidir ("Eski kayıtları göster" + "N eski kayıt gizli" sayacı); vaka görünümü her zaman tüm geçmişi gösterir. Bu gizleme **yalnız İş Kuyruğu ekranı** içindir: İstatistikler, Excel'e Aktar (tıklandığı anda sunucudan tam liste çekilir; "Filtreye uyanlar" sütun filtrelerini eskiler dahil tam listeye uygular), Hizmetler ve otomatik yedekler her zaman tüm kayıtları kapsar.

## 1e) Günlük yedek (`daily-backup` Edge Function)
Her gece 02:00'de (pg_cron, `yedekler_sema.sql`) çalışır. Excel dosyasında önce okunabilir sayfalar (İstemler, İstem Kalemleri, Durum Geçmişi — ID yerine kullanıcı/test/cihaz adları), sonra geri yükleme için ham tablolar (`ham_*`, notlar dahil) bulunur. `ham_istem_log`'un sonundaki `patoloji_no` / `blok_no` / `test_adi` kolonları okuma kolaylığı içindir (geri yüklerken atılır). Dosya iki BAĞIMSIZ yere gider: `yedekler` bucket'ı ve Resend ile `patolojiselcuktip@gmail.com` (ek). Biri başarısız olursa diğeri yine tamamlanır; hata Edge Function loglarında görünür.

- `yedek_eposta_sema.sql`: Resend anahtarını Vault'tan (`istem_resend_key`) sadece fonksiyonun okuyabileceği `yedek_resend_anahtari()` + cron isteğinin zaman aşımını 60 sn'ye çıkarır.
- Fonksiyon kodu değişince: `npx supabase functions deploy daily-backup`
- Resend ücretsiz planda `onboarding@resend.dev` gönderen adresi sadece Resend hesabının sahibi olan e-postaya gönderebilir.

## 1f) Haftalık / aylık özet (`ozet-yedek` Edge Function, `ozet_yedek_sema.sql`)
Günlük ham veri yedeğinden ayrı ve ek. Aynı altyapı: Vault'taki service_role ve Resend anahtarları, `yedekler` bucket'ı, aynı alıcı. Hesap İstatistikler sayfasıyla **aynı** `istatistik()` fonksiyonundan gelir.

| İş (pg_cron, UTC) | Türkiye saati | Kapsam | Dosya |
|---|---|---|---|
| `haftalik-istem-ozet` `0 2 * * 1` | Pazartesi 05:00 | önceki hafta (Pzt–Paz) | `istem_haftalik_ozet_2026-W40.xlsx` (ISO hafta) |
| `aylik-istem-ozet` `0 2 1 * *` | ayın 1'i 05:00 | önceki ay | `istem_aylik_ozet_2026-09.xlsx` |

- Sayfalar: Özet, Günlük Döküm (haftalık) / Haftalık Döküm (aylık), Tip Dağılımı, Kullanıcı Bazında, Uzman Adına.
- Kurulum sırası: panelde `ozet-yedek` fonksiyonunu oluşturup `supabase/functions/ozet-yedek/index.ts`'yi yapıştırın, deploy edin → `ozet_yedek_sema.sql`'i çalıştırın.
- Elle / geçmişe dönük: gövde `{"periyot":"hafta"}` (önceki hafta) ya da `{"periyot":"ay","bas":"2026-09-01"}` (o tarihi içeren dönem) — sorgu `ozet_yedek_sema.sql`'in sonunda.
- Yedekler sayfası dosyaları adından Günlük / Haftalık / Aylık olarak etiketler ve süzer.

## 1g) Ekipler, kapsam, kesit iş listesi (`ekip_sema.sql`)
`ek_ozellikler_sema.sql` ve `ozet_yedek_sema.sql`'den sonra, **kod deploy edilmeden önce** çalıştırın (idempotent; teslimde 4 parça).

| Grup | Ekip | Kesit gerektirir | Kısa ad |
|---|---|---|---|
| ihc | immun | ✓ | İHK |
| hk, mol, fish | histomol | ✓ | HK, MOL, FISH |
| diger | histomol | — | Diğer |
| hucre, yayma | sito | — | Hücre, Yayma |
| kesit | kesit | — | Kesit |

- Varsayılanlar yalnız kolon ilk eklendiğinde yazılır; sonra **Test Grupları** sayfasından düzenlenir (ekip, kesit gerektirir, kısa ad). Kullanıcının ekibi (`immun / histomol / sito / kesit / arsiv / sekreter`) **Kullanıcılar** sayfasından atanır; sekreter girişte Hizmetler'de açılır.
- **İş Kuyruğu:** üstte kapsam çipleri (Benim İsteklerim · Ekibim · Tümü · her aktif grup), altında durum sekmeleri (Bekleyen / İşlemde / Tamamlandı / Hepsi; sayaçlar kapsama göre). Varsayılan: uzman/asistan → Benim İsteklerim, teknisyen → Ekibim, yönetici → Tümü.
- **Kesit ekranı** (kesit grubunun çipi / kesit ekibinin "Ekibim"i): satır = patoloji no + blok; kesilecek = (kesit gerektiren grupta Bekleyen ve `kesildi_at` boş) veya (kesit grubunda Tamamlandı değil). **Kesildi** (`blok_kesildi`, yönetici + teknisyen) yalnız satırda görünen kalemlere uygulanır: kesit gerektirenlere `kesildi_at/kesen_id` (durum Bekleyen kalır → diğer ekranlarda "Kesit hazır"), kesit grubundakiler Tamamlandı. `blok_kesildi_geri_al` son işlemi geri alır (işleme alınmış kalemlere dokunmaz).
- Aynı patoloji no + blokta başka gruptan tamamlanmamış istek varsa satırda "+HK" gibi çapraz uyarı rozeti çıkar.
- Teknisyende "Benim İsteklerim" çipi yok, "Ekibim" ilk sırada ve varsayılan; ekibi atanmamışsa Tümü açılır ve "Ekibiniz atanmamış" uyarısı çıkar.
- Grup çipi ya da "Ekibim" seçiliyken, aynı vaka + bloktaki diğer grupların tamamlanmamış kalemleri ana kalemin altında "ilişkili" satırlar olarak görünür (eşleştirme kuralı ve "İlişkilileri dahil et" için bkz. 1k). Kapsam satırındaki "İlişkilileri göster" anahtarı tarayıcıda hatırlanır (`istem_iliskili`). Yazdır ve Excel'e Aktar ilişkilileri işaretli olarak içerir; Kesit ekranında blok satırının altında gösterilir.
- İHK altındaki "Yeni kesit" katalog girdisi silinmez, pasifleştirilir (isim tahmin edilmez: tek eşleşme yoksa hiçbir şey değişmez, 4. parçanın sonucu eşleşenleri listeler).

## 1h) Web Push bildirimleri (`push-gonder` Edge Function, `push_sema.sql`)
Uygulama kapalıyken de yeni istekler telefona/bilgisayara sistem bildirimi olarak gelir; ekran içi banner + ses aynen sürer.

**Akış:** `istem_kalemleri` INSERT → `push_tetikle()` trigger'ı → istem başına **tek** kez (`push_gonderimleri`) `net.http_post` → `push-gonder` → alıcıların her cihazına. pg_net isteği işlem kesinleştikten sonra gider (geri alınırsa hiç gitmez); hiç abonelik yoksa çağrı yapılmaz; hata istem kaydını asla engellemez.

- Alıcılar: `bildirim_tercihleri`nde istemin gruplarından birini seçmiş, aktif ve istemi açan kişi olmayan kullanıcılar. Metin alıcının kendi gruplarına göre: `17730/26 · 3 İHK (Acil)`. 404/410 dönen abonelik silinir.
- Şifreleme (RFC 8291, aes128gcm) ve VAPID imzası (RFC 8292, ES256) dış paket olmadan WebCrypto ile; RFC 8291 Ek A test vektörüyle birebir doğrulandı.
- VAPID anahtarını fonksiyon kendisi üretip Vault'a yazar (`istem_vapid_private`, `istem_vapid_public`) — özel anahtar kimseye görünmez; yalnız ilk kurulumda üretilir.
- Kullanıcı: Ayarlar → Bildirimler → **Bildirimleri aç** (izin yalnız bu butonla istenir), grup seçimi (ilk açılışta kendi ekibinin grupları), **Deneme bildirimi**, **Bu cihazda kapat**. Çıkışta o cihazın aboneliği silinir (ortak bilgisayar). iPhone/iPad: iOS 16.4+, önce Ana Ekrana Ekle.
- Uygulama açık ve öndeyken sistem bildirimi gösterilmez (iOS hariç — Apple her push'ta bildirim ister).

**Kurulum (panelden, CLI yok):**
1. Edge Functions → yeni fonksiyon `push-gonder` → `supabase/functions/push-gonder/index.ts`'yi yapıştır → Deploy ("Verify JWT" açık).
2. SQL Editor: `push_sema.sql` (3 parça).
3. SQL Editor: dosyanın sonundaki "KURULUM" sorgusu (anahtar üretimi) + iki kontrol sorgusu.
4. Teşhis: `select * from push_gonderimleri order by created_at desc limit 10;`

## 1i) Arşiv ekibi, yazdırma kayıtları, Hizmetler gruplama (`arsiv_yazdirma_sema.sql`)
`ekip_sema.sql`'den sonra, **kod deploy edilmeden önce** çalıştırın (idempotent; teslimde 3 parça). `ekip_sema.sql` ya da bu dosya yeniden çalıştırılırsa kuyruk görünümünü (`istem_kuyruk_v`) geri almaz — son hali `kontrol_sema.sql`'dedir.

- **Arşiv ekibi** (`kullanicilar.ekip = 'arsiv'`, Kullanıcılar sayfasından): "Ekibim" arşiv ekranıdır ve rolü ne olursa olsun varsayılan açılır. Satır = patoloji no + blok; kapsam = kesit gerektiren gruplar + kesit grubu, tamamlanmamış tüm kalemler. Sütunlar: İHK için (ekibi `immun` olan gruplar) · YK/HK için (geri kalanı: YK, HK, MOL, FISH) · Acil · İstem tarihi. Boya adı gösterilmez.
- Sekmeler Hepsi (varsayılan) / Çıkarılacak / Çıkarıldı; çıkarılmışlar altta ve soluk. **Çıkarıldı** (`blok_cikarildi`: yönetici, teknisyen ya da arşiv ekibi) satırda görünen damgasız kalemlere `blok_cikarildi_at/blok_cikaran_id` yazar; ↺ son çıkarmayı geri alır. Kesit ve diğer ekranlarda aşama: Kesit bekleniyor → **Blok çıkarıldı** → Kesit hazır.
- **Yazdırma kaydı** (`yazdirma_kayitlari`): her baskıda basılan kalemler bağlamıyla kaydedilir — `calisma` (İş Kuyruğu ve Kesit ekranı), `arsiv`, `hizmetler`. Yazdır menüsü: **Yazdırılmamışları yazdır** (o bağlamda hiç kaydı olmayanlar), Seçilileri, Görünenleri. Bir satırın tüm kalemleri yazdırılmışsa yazıcı ikonu çıkar (üzerinde / dokununca kim, ne zaman). Tarayıcı yazdırma penceresinde "İptal"i bildirmediği için kayıt baskı başlarken düşer; 15 sn "Yazdırılmadı — geri al" bandı çıkar (kişi yalnız kendi, 15 dakikadan yeni kayıtlarını silebilir). İlişkili satırlar basılır ama kaydedilmez.
- Arşiv çıktısı: Patoloji No | Blok | İHK | YK/HK | Acil, patoloji no ve bloğa göre sıralı.
- **Hizmetler:** "Uzmana göre grupla" (varsayılan açık, tarayıcıda hatırlanır; başlığa tıklayınca kapanır). Yazdır (bağlam `hizmetler`): uzmana göre gruplu Patoloji No | Uzman | Özet ("3 İHK, 1 HK") | Tarih. Girilmiş satırdaki ↺ girişi geri alır — yalnız işaretleyen kişi ya da yönetici (veritabanında trigger ile zorunlu); her giriş ve geri alma `fatura_gecmisi`'ne kim/ne zaman olarak yazılır.

## 1j) Antikor kontrol listesi (`kontrol_sema.sql`)
`arsiv_yazdirma_sema.sql`'den sonra, **kod deploy edilmeden önce** çalıştırın (idempotent; teslimde 2 parça). Yeniden çalıştırılırsa kuyruk görünümünü geri almaz — son hali `duzeltme_sema.sql`'dedir.

- `test_katalog.kontrol` (opsiyonel, ≤ 200 karakter): Test Kataloğu formunda tek tek düzenlenir; kuyruğa katalogdan **canlı** gelir (değişince eski istemlerde de güncel).
- Görünüm: ayrı sütun yok — test adının altında, klonla aynı satırda "L26 · *K: Tonsil*" (küçük + italik, renge dayanmaz). İş Kuyruğu, detay paneli ve Çalışma Listesi çıktısı (çıktıda klon basılmaz, yalnız "K: …"). Excel'e Aktar'da ayrı "Kontrol" sütunu. Boşsa hiç görünmez.
- **Kontrol listesi yükle** (Test Kataloğu, yönetici): Excel'den yapıştırılan "Antikor ⇥ Kontrol" satırları. İlk satırda "antikor"/"kontrol" geçiyorsa başlık sayılır; kontrol "X" ise boş; TAB'sız satır okunamayan sayılıp atlanır.
- Eşleştirme anahtarı: Türkçe harfler sadeleşir (İ/I/ı→i, ş→s …), aksanlar atılır, küçük harf; boşluk, tire, nokta, parantez yok sayılır ("Bcl-2" = "BCL2", "/" korunur). İmmün ekibinin gruplarındaki testlerle eşleşir; aynı ada birden çok test düşerse aktif olan, yine birden çoksa "birden çok aday". Tam eşleşme yoksa parantez içi atılarak tekrar denenir ("Ki-67 (MIB-1)" → "Ki-67", işaretli).
- Önizleme: eşleşen / değişecek / aynı kalacak / eşleşmeyen sayıları; eşleşmeyen, belirsiz ve parantez dışı eşleşenler açılır menüden elle bağlanır ya da atlanır (kataloğa otomatik eklenmez — "Katalogda olmayanları kopyala" ile Toplu Ekle'ye yapıştırılabilir). Aynı teste iki satır düşerse **çakışma**: hangisinin kullanılacağı seçilmeden ("Bunu kullan" diğerlerini atlar) ya da biri atlanmadan kaydedilmez. Sayaç satırı ve "N kontrolü kaydet" / İptal kaydırırken üstte yapışık kalır (telefonda düğmeler ekranın altında). Onaylanan değişiklikler `katalog_kontrol_yukle` ile tek işlemde yazılır.

## 1k) "Yazıyor…" göstergesi, ilişkililer işleme dahil, çıktı sıralaması (`yaziyor_sema.sql`)
`kontrol_sema.sql`'den sonra, **kod deploy edilmeden önce** çalıştırın (idempotent, tek parça). Tablo oluşturmaz.

- **Yazıyor… (Realtime Presence):** private kanal `istem-yaziyor` — yalnız oturum açmış kullanıcılar (`realtime.messages` üzerinde 2 politika; herkese açık kanalda sitenin açık anahtarını bilen herkes patoloji numaralarını görebilirdi). Anahtar: sekme kimliği; yük: `{ kullanici_id, kisaltma, ad_soyad, patoloji_no, gruplar, zaman }`. İstek Ver formunda patoloji no doluyken yayınlanır (değişiklikler 400 ms sonra) ve formdaki her etkileşimde (tuş, tıklama, seçim, odak — yakalama aşamasında, alt düğmeler dahil) en fazla 15 sn'de bir tazelenir; kanal yeniden bağlanınca ve sekme tekrar görünür olunca yeniden yayınlanır. YALNIZ istem gönderilince, form kapanınca, SON etkileşimden 2 dk sonra ve çıkışta kalkar; sekme kapanınca sunucu düşürür. Realtime canlı tutma sinyali Web Worker'da (`realtime.worker`) — arka plan sekmesinde bağlantı kopmasın. Geçici debug: konsolda `[yazıyor]` önekli kanal / track / untrack / sync / bağlantı sinyali olayları (`YAZIYOR_DEBUG`). İş Kuyruğu'nun üstünde şerit ("FD · 17730/26 için istem yazıyor… (İHK)"), aynı vakanın satırlarında "✎ yazılıyor"; kişinin kendisi listelenmez. Yazdırılacak listede yazılan bir vaka varsa önce sorulur. Kanal açılamazsa (SQL çalışmamışsa) gösterge sessizce kapalı kalır.
- **İlişkili eşleştirme:** anahtar = patoloji no (boşluksuz) + blok (boşluklar — tire çevresindekiler dahil — ve büyük/küçük harf yok sayılır: "1 - 2" = "1-2", "a1" = "A1"). İstem kaydından bağımsız (farklı zamanda girilmiş istemler de); blok boşsa aynı vakanın bloksuz kalemleri birbirine ilişkili. Aynı anahtar çapraz uyarı rozetlerinde, Kesit/Arşiv blok satırlarında ve blok detayında da kullanılır (ekranda ilk görülen yazılış).
- **İlişkilileri dahil et** (kapsam satırı, varsayılan açık, `istem_iliskili_dahil`): ilişkili satırlar seçilebilir ve kendi İşleme Al / Tamamla / ↺ düğmeleri vardır; başlıktaki tümünü seç, vaka kısayolu, Shift aralığı ve toplu işlemler onları da kapsar; seçim çubuğunda "N seçili (K ilişkili)". Kapalıyken eski davranış (yalnız bilgi). Sayaçlar her zaman yalnız ana grubu sayar.
- **Çıktı sıralaması** (Yazdır menüsü → Sıralama, tek tercih, `istem_yazdir_sira`; Çalışma, Kesit, Arşiv, Hizmetler): **Giriş sırası** (varsayılan — istemin zamanı, aynı istemin kalemleri giriliş sırasıyla; blok çıktılarında bloğun en eski kalemi) ya da **Patoloji no / blok**. İlişkili satırlar ana kalemin hemen altında, kendi içinde de aynı sırayla. Seçilerek basılan ilişkililer işaretli kalır ve kayda girer. Giriş sırası için kalem `created_at` artık `clock_timestamp()` (satır satır); eski kayıtlarda aynı istemin içi blok, sonra test adına göre (doğal sıra: CD3, CD20).

## 1l) İstem düzeltme (`duzeltme_sema.sql`, `daily-backup` yeniden deploy)
`yaziyor_sema.sql`'den sonra, **kod deploy edilmeden önce** çalıştırın (idempotent; teslimde 3 parça). `istem_kuyruk_v`'nin son hali bu dosyadadır.

- **Düzeltilebilir:** patoloji no (istem → tüm kalemleri), blok (kalem; "aynı bloktaki diğer kalemlere de uygula" varsayılan işaretli), uzman adına, öncelik. Test adı düzeltilemez (yanlış test: kalemi sil + yeni istek).
- **Yetki:** istemi giren kişi (`istem_yapan_id`) ve yönetici; kalemin durumu fark etmez. Kullanıcıların bu kolonları doğrudan güncelleme yetkisi yoktur (yalnız fatura/durum kolonları) — tek yol `istem_duzelt(p_istem_id, p_degisiklik)` (security definer, tek transaction; yetkisizse 42501).
- **Kayıt:** `istem_duzeltmeleri(id, istem_id, kalem_id, alan, eski_deger, yeni_deger, duzelten_id, created_at)` — oturum açmış herkes okur; ekleme yalnız `istem_duzelt` üzerinden; UPDATE/DELETE/TRUNCATE tetikleyiciyle engelli (yönetici, servis anahtarı, SQL Editor dahil). Yabancı anahtar yok: istem/kalem silinse de kayıt kalır. Her düzeltmede istemin notlarına otomatik not ("Patoloji no 17730/26 → 17703/26 olarak düzeltildi", yazan = düzelten).
- **Görünüm:** düzeltilmiş hücrede "düzeltildi" rozeti (üzerinde kim/ne zaman), altında İLK girilen değer üstü çizili. Detay panelinde ✎ (yalnız yetkiliye) → alanlar düzenlenir, Kaydet'te değişiklik listesiyle onay; "Düzeltme geçmişi" bölümü. Arama, Patoloji No filtresi, Kesit/Arşiv araması ve Hizmetler filtresi eski numaraları da tarar.
- **Yazdırılmış kalemler:** bağlamdaki (çalışma / arşiv / hizmetler) son çıktıdan SONRA düzeltildiyse satırda "⚠ Çıktı eski numarayla basıldı" (patoloji no / blok) ya da "…eski bilgiyle…" (uzman / öncelik), yazıcı ikonu gizlenir, "Yazdırılmamışları yazdır"a yeniden girer; yeniden yazdırılınca kalkar. Çıktıda yeni değer + "(düzeltildi: eski 17730/26)".
- **Excel'e Aktar ve günlük yedek:** "Düzeltildi" sütunu ("Patoloji no: 17730/26 → 17703/26; Blok: A1 → A2"); yedekte ayrıca "Düzeltmeler" ve `ham_istem_duzeltmeleri` sayfaları (tablo okunamazsa yedek yine alınır). `daily-backup` panelden yeniden deploy edilir (tek dosyalık sürüm).

## 2) Yerel önizleme
`app/` klasörünü herhangi bir statik sunucuyla açın (dosya:// ile açmayın, service worker ve modül gibi bazı özellikler çalışmaz):
```
npx serve app
```

## 3) Netlify deploy
Repo kökünde `netlify.toml` zaten `base/publish = app` olarak ayarlı. Netlify'a bağlayıp deploy etmeniz yeterli.

## Notlar
- Patoloji No tarama (`app/ocr.js`): Yeni İstek formundaki tara butonu kamerayı açar (yakınlaştırılmış: Android'de kameranın kendi zoom'u, diğerlerinde ekran büyütme); kullanıcı etiketin tamamını etiket boyutundaki çerçeveye alır. Okuma tarayıcıda Tesseract.js ile yapılır (görüntü sunucuya gitmez): birkaç kare × 3 görüntü varyantı, çok satırlı blok olarak okunur, her satır ayrı ayrı `/^\d+\/\d{2,3}$/` kalıbına bakılır. Bir numara ancak en az 2 okumada aynı çıkar ve okumaların çoğunluğu olursa önerilir; kırpma kenarına değen satır sayılmaz; bulanık kare OCR'a gönderilmez. Öneri kullanıcı onaylayınca alana yazılır, form asla kendiliğinden gönderilmez; uzlaşma yoksa hiçbir şey doldurulmaz ("Elle Gir"). Kamera ekranındaki "Tanı" düğmesi ham OCR çıktılarını gösterir (teşhis için). Kamera HTTPS ister; Tesseract ilk kullanımda CDN'den (~birkaç MB) yüklenir.
- Auth: "ad seç + PIN" görünümü aynı kalır ama artık arka planda gerçek Supabase Auth (`signInWithPassword`) çalışır — bkz. "1b) Supabase Auth'a geçiş".
- Başka bir kullanıcının PIN'ini admin ekrandan sıfırlama şu an desteklenmiyor (service_role/Edge Function gerektirir) — PIN sadece hesap oluşturulurken belirlenir.
- Ekran düzeni (styles.css): sağ panel her genişlikte varsayılan kapalı (içinde detay/form varken açık — `.acik` sınıfını `railIzle` yönetir, CSS `:has()` kullanılmaz). ≤ 900 px telefon (panel tam ekran); 901–1599 px panel sağdan kayar, tabloyu itmez + sol menü varsayılan ikon modunda; ≥ 1600 px panel açılınca tablonun yanında durur, kapalıyken tablo tam genişlik. Menü daraltma tercihi tarayıcıda (`istem_nav_dar`), yeni istem sesi tercihi kullanıcı başına (`istem_ses:<kullanici_id>`) — ikisi de localStorage.
- Çalışma Listesi (seçim çubuğu → Yazdır): aynı sayfadaki `#yazdirAlani`'na yazılır, yazdırırken (`body.yazdiriliyor`) uygulamanın geri kalanı gizlenir. Normal Ctrl+P davranışı değişmez.
- Yeni istem bildirimi şema gerektirmez: canlı güncellemedeki her yeniden yüklemede, daha önce görülmemiş Bekleyen kalemler (kişinin kendi açtıkları hariç) sayılır.
- `secure_rls_authenticated.sql` çalıştırıldıktan sonra RLS `authenticated`-only olur; `policies.sql`/`setler_sema.sql`/`hizmetler_sema.sql`/`yonetim_sema.sql`'deki `anon_full_access` politikaları bu dosyayla değiştirilir.
