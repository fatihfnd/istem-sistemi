-- ============================================================
-- auth_setup_sema.sql — Gerçek Supabase Auth'a geçişin 1. adımı
--
-- Bu dosya KATKISALDIR (mevcut hiçbir şeyi kırmaz, RLS'yi henüz
-- kilitlemez). İDEMPOTENT'tir — yeniden çalıştırılabilir.
--
-- Sıradaki adımlar (bkz. README.md "Supabase Auth'a geçiş" bölümü):
--   2. Yeni kod deploy edilir (dual-mode login).
--   3. Kullanıcılar sayfasında "Auth hesabı olmayanları taşı" ile
--      mevcut kullanıcılar Auth'a taşınır.
--   4. Taşımanın bittiği doğrulanır.
--   5. secure_rls_authenticated.sql çalıştırılır (asıl kilitleme).
--
-- ÖNEMLİ (dashboard ayarı, SQL ile yapılamaz): Authentication →
-- Sign In / Providers → Email → "Confirm email" KAPATILMALI.
-- Aksi halde @istem.local sahte adreslerine gerçek e-posta gitmediği
-- için yeni hesaplar sonsuza dek "unconfirmed" kalır, giriş yapamaz.
-- ============================================================

alter table kullanicilar add column if not exists email text unique;
alter table kullanicilar add column if not exists auth_user_id uuid unique references auth.users(id);

-- ------------------------------------------------------------
-- kullanicilar_login_v — herkese açık, GÜVENLİ "giriş listesi".
-- kullanicilar tablosu authenticated-only olduktan SONRA bile giriş
-- ekranındaki ad-seç dropdown'ı çalışsın diye SADECE id/ad_soyad/email
-- döner (pin/rol/aktif-olmayanlar YOK).
--
-- BİLEREK security_invoker KULLANMIYOR — projedeki diğer view'ların
-- (ör. istem_kuyruk_v) tam tersi. Onlarda amaç sorgulayan rolün (o an
-- authenticated) RLS'sinin uygulanmasıydı; burada amaç TERSİ: zaten
-- kilitli kullanicilar tablosunu view SAHİBİNİN (postgres — RLS'yi
-- bypass eder) yetkisiyle okuyup anon'a dar, güvenli bir dilim sunmak.
-- Bu yüzden bu view'da security_invoker=true KULLANILMAMALI.
-- ------------------------------------------------------------
create or replace view kullanicilar_login_v as
select id, ad_soyad, email from kullanicilar where aktif = true;

grant select on kullanicilar_login_v to anon, authenticated;
