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
- **Yönetici (`is_admin`)**: Yönetim sayfaları (Kullanıcılar, Test Grupları, Test Kataloğu, Yedekler) sadece yöneticiye görünür; `kullanicilar`/`test_gruplari` yazma, `test_katalog` düzenleme/silme, `istek_setleri` yazma ve yedek indirme RLS'te de sadece yönetici. Yeni yöneticiyi Kullanıcılar formundaki "Yönetici" kutusuyla atayın.
- **Kalem silme**: yönetici her kalemi (Tamamlandı dahil); diğerleri sadece kendi açtığı istemdeki, Tamamlandı olmayan kalemleri.
- **Durum geri alma** (Tamamlandı→Cihazda, Cihazda→Bekleyen): sadece yönetici + teknisyen (veritabanında trigger ile).
- **Teknisyen**: sıfırdan istem giremez, Şablonlar'a erişemez; tek istem yolu detay panelindeki "Tekrar İste".
- **Tekrar İste**: aynı test/blok için yeni bir istem kaydı + Bekleyen kalem (`istem_kalemleri.tekrar_kaynagi_id` kaynağa bağlı). Hizmetler'de "Tekrar" rozetiyle görünür.
- **Kalite notu** (`istem_kalemleri.kalite_notu`) ve **herkese açık şablon** (`sablonlar.herkese_acik`).
- `istemler` ve `istem_kalemleri`'nde UPDATE kolon bazlıdır (sadece fatura / durum-cihaz-kalite notu kolonları).

⚠️ Bu dosyadan SONRA `policies.sql`, `setler_sema.sql`, `yonetim_sema.sql` ya da `secure_rls_authenticated.sql`'i yeniden çalıştırmayın — eski "herkese açık" politikaları geri ekler. Çalıştırırsanız ardından `yetki_sema.sql`'i tekrar çalıştırın.

**Yeni kullanıcı eklerken / oluştururken:** Auth hesabı oturum saklamayan ayrı bir Supabase client ile açılır — yöneticinin kendi oturumu hiç değişmez.

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
