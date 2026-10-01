-- ============================================================
-- yedek_eposta_sema.sql — günlük yedeğin e-posta adımı için
--
-- daily-backup Edge Function'ı Resend API anahtarını Vault'tan okur:
-- cron işinin service_role anahtarını okuduğu sorgunun AYNISI
-- (vault.decrypted_secrets), sadece fonksiyonun çağırabileceği bir RPC
-- içinde. Anahtar ağ üzerinden hiçbir yere taşınmaz; cron işi değişmez.
--
-- Ön koşul: Vault'ta 'istem_resend_key' adlı secret (zaten kayıtlı).
-- daily-backup'ın YENİ sürümü deploy edilmeden önce ya da sonra
-- çalıştırılabilir (yoksa e-posta adımı loglanıp atlanır, Storage'a
-- yazma etkilenmez). İDEMPOTENT'tir.
-- ============================================================

create or replace function public.yedek_resend_anahtari() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'istem_resend_key' limit 1
$$;

-- Supabase public şemadaki yeni fonksiyonlara anon/authenticated'a
-- varsayılan EXECUTE verir — burada açıkça geri alınır: SADECE service_role
-- (Edge Function) çağırabilir; uygulamadaki kullanıcılar anahtarı göremez.
revoke all on function public.yedek_resend_anahtari() from public, anon, authenticated;
grant execute on function public.yedek_resend_anahtari() to service_role;

-- ------------------------------------------------------------
-- Cron işi — yedekler_sema.sql'deki tanımın AYNISI, tek fark istek zaman
-- aşımı: pg_net varsayılanı 5 sn. Fonksiyon artık 6 kaynağı sayfa sayfa
-- okuyup bir de e-posta gönderiyor; veri büyüdükçe 5 sn'yi aşarsa
-- net._http_response'ta sonuç yerine "timeout" görünür. 60 sn yeterli pay.
-- Aynı adla cron.schedule mevcut işi günceller (yeni iş açmaz).
-- ------------------------------------------------------------
select cron.schedule(
  'gunluk-istem-yedek',
  '0 23 * * *',
  $$
  select net.http_post(
    url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/daily-backup',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'istem_service_role_key'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

notify pgrst, 'reload schema';

-- Elle deneme (deploy'dan sonra — gece 02:00'yi beklemeden):
--   select net.http_post(
--     url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/daily-backup',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
--       (select decrypted_secret from vault.decrypted_secrets where name = 'istem_service_role_key')),
--     body := '{}'::jsonb, timeout_milliseconds := 60000);
--   -- 10-20 sn sonra sonuç (200 = ikisi de tamam, 207 = biri başarısız; "content"te ayrıntı):
--   select status_code, content from net._http_response order by created desc limit 1;
--
-- Doğrulama:
--   select name from vault.secrets where name = 'istem_resend_key';      -- 1 satır
--   select has_function_privilege('authenticated', 'public.yedek_resend_anahtari()', 'execute');  -- false
-- ============================================================
