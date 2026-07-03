# İstem — kurulum

## 1) Supabase
1. `istem_sistemi_sema.sql` dosyasını Supabase SQL Editor'de çalıştırın.
2. Ardından `policies.sql` dosyasını çalıştırın (RLS + realtime yayını).
3. Ardından `setler_sema.sql` dosyasını çalıştırın (İstek Setleri + Cihazlar tabloları, eski "hazır setler"i otomatik taşır — idempotenttir, tekrar çalıştırmak güvenlidir).
4. Settings → API'den **Project URL** ve **anon public key**'i alıp [app/config.js](app/config.js) içine yazın.

## 2) Yerel önizleme
`app/` klasörünü herhangi bir statik sunucuyla açın (dosya:// ile açmayın, service worker ve modül gibi bazı özellikler çalışmaz):
```
npx serve app
```

## 3) Netlify deploy
Repo kökünde `netlify.toml` zaten `base/publish = app` olarak ayarlı. Netlify'a bağlayıp deploy etmeniz yeterli.

## Notlar
- Barkod okuma henüz eklenmedi (sıradaki adım).
- Auth basit "ad seç + PIN" — gerçek Supabase Auth değil, prototip amaçlıdır.
- `policies.sql` anon role tam okuma/yazma izni verir — hasta verisiyle gerçek kullanım öncesi sıkılaştırılmalı.
