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

**Yeni kullanıcı eklerken / oluştururken:** `signUp()` çağrısı anlık olarak tarayıcının Auth oturumunu yeni kullanıcıya çevirir; hemen ardından uygulama yöneticinin oturumunu (o oturumda bellekte tutulan email+PIN ile) otomatik geri yükler — bu esnada başka bir sekmede aynı hesapla işlem yapmayın.

## 2) Yerel önizleme
`app/` klasörünü herhangi bir statik sunucuyla açın (dosya:// ile açmayın, service worker ve modül gibi bazı özellikler çalışmaz):
```
npx serve app
```

## 3) Netlify deploy
Repo kökünde `netlify.toml` zaten `base/publish = app` olarak ayarlı. Netlify'a bağlayıp deploy etmeniz yeterli.

## Notlar
- Barkod okuma henüz eklenmedi (sıradaki adım).
- Auth: "ad seç + PIN" görünümü aynı kalır ama artık arka planda gerçek Supabase Auth (`signInWithPassword`) çalışır — bkz. "1b) Supabase Auth'a geçiş".
- Başka bir kullanıcının PIN'ini admin ekrandan sıfırlama şu an desteklenmiyor (service_role/Edge Function gerektirir) — PIN sadece hesap oluşturulurken belirlenir.
- `secure_rls_authenticated.sql` çalıştırıldıktan sonra RLS `authenticated`-only olur; `policies.sql`/`setler_sema.sql`/`hizmetler_sema.sql`/`yonetim_sema.sql`'deki `anon_full_access` politikaları bu dosyayla değiştirilir.

## Rapor editörü ucu (salt okunur)
`supabase/functions/rapor-istem` — rapor editörü (https://rapor-editoru.pages.dev) bir patoloji no için istenen
İHK / histokimya / genetik testleri buradan okur ve "İmmünohistokimyasal / Histokimyasal Bulgular" modülünü doldurur.

- `GET …/functions/v1/rapor-istem?protokol=11240/26` → `[{ ad, tur: 'ihk'|'histokimya'|'genetik', klon, durum }]`
  (editördeki `11240/2026` biçimi de eşleşir). `?katalog=1` → aktif test kataloğu `[{ ad, tur, klon }]`.
- **Hasta adı, kimlik, istem notu, isteyen/uzman adı dönmez**; yalnızca test listesi. Kesit / hücre bloğu / yayma dönmez.
- CORS yalnızca `https://rapor-editoru.pages.dev` kökenine açık; başka kökenden gelen tarayıcı isteği 403 alır.
- Yetki: `x-okuma-anahtari` başlığı. Anahtar kodda değil, Supabase ortam değişkeninde (`RAPOR_OKUMA_ANAHTARI`);
  tanımlı değilse uç kapalıdır (503). Editör tarafında anahtar Ayarlar → "İstem bağlantısı"na girilir (yalnızca o tarayıcıda saklanır).

Kurulum (bir kez):
```
supabase secrets set RAPOR_OKUMA_ANAHTARI=<en az 16 karakter, rastgele>
supabase functions deploy rapor-istem --no-verify-jwt
```
`--no-verify-jwt` gerekir: editör Supabase oturumu taşımaz, yetkiyi okuma anahtarı sağlar.
Test (sahte veriyle): `node --test supabase/functions/rapor-istem/cekirdek.test.ts`
