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
- **Durum geri alma** (Tamamlandı→Cihazda, Cihazda→Bekleyen): yönetici + teknisyen her kalemi, uzman/asistan yalnız kendi açtığı istemin kalemlerini (veritabanında trigger ile; son hali `ek_ozellikler_sema.sql`'de).
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
- **İstatistikler** (`istatistik()`, yalnız yönetici): canlı veriden haftalık/aylık istem, kalem, tip dağılımı, kullanıcı bazında istem, ortalama/medyan tamamlanma süresi.
- İş Kuyruğu'nda 30 günden eski **Tamamlandı** kayıtlar varsayılan gizlidir ("Eski kayıtları göster"); vaka görünümü her zaman tüm geçmişi gösterir. Bu sunucu tarafında süzülür (şema değişikliği gerekmez).

## 1e) Günlük yedek (`daily-backup` Edge Function)
Her gece 02:00'de (pg_cron, `yedekler_sema.sql`) çalışır. Excel dosyasında önce okunabilir sayfalar (İstemler, İstem Kalemleri, Durum Geçmişi — ID yerine kullanıcı/test/cihaz adları), sonra geri yükleme için ham tablolar (`ham_*`, notlar dahil) bulunur. `ham_istem_log`'un sonundaki `patoloji_no` / `blok_no` / `test_adi` kolonları okuma kolaylığı içindir (geri yüklerken atılır). Dosya iki BAĞIMSIZ yere gider: `yedekler` bucket'ı ve Resend ile `patolojiselcuktip@gmail.com` (ek). Biri başarısız olursa diğeri yine tamamlanır; hata Edge Function loglarında görünür.

- `yedek_eposta_sema.sql`: Resend anahtarını Vault'tan (`istem_resend_key`) sadece fonksiyonun okuyabileceği `yedek_resend_anahtari()` + cron isteğinin zaman aşımını 60 sn'ye çıkarır.
- Fonksiyon kodu değişince: `npx supabase functions deploy daily-backup`
- Resend ücretsiz planda `onboarding@resend.dev` gönderen adresi sadece Resend hesabının sahibi olan e-postaya gönderebilir.

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
- `secure_rls_authenticated.sql` çalıştırıldıktan sonra RLS `authenticated`-only olur; `policies.sql`/`setler_sema.sql`/`hizmetler_sema.sql`/`yonetim_sema.sql`'deki `anon_full_access` politikaları bu dosyayla değiştirilir.
