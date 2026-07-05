-- yedekler_sema.sql — otomatik günlük yedek altyapısı.
-- Supabase Dashboard > SQL Editor'da, TAMAMINI tek seferde çalıştırın.
--
-- ÖNEMLİ: Adım 4'teki <SERVICE_ROLE_KEY> yerine gerçek service_role
-- anahtarınızı (Project Settings > API > service_role) yapıştırın,
-- çalıştırdıktan SONRA bu dosyayı o haliyle git'e COMMIT'LEMEYİN
-- (anahtarı yazdığınız satırı silip tekrar <SERVICE_ROLE_KEY> yapın).

-- 1) Yedeklerin yazılacağı private bucket (public=false — imzasız URL ile
-- kimse dışarıdan erişemez, indirme her zaman signed URL üzerinden olur).
insert into storage.buckets (id, name, public)
values ('yedekler', 'yedekler', false)
on conflict (id) do nothing;

-- 2) Sadece giriş yapmış (authenticated) kullanıcılar listeleyip
-- indirebilsin. Yazma politikası KASITLI OLARAK yok: Edge Function
-- service_role ile yazacağı için RLS'yi zaten atlar; authenticated
-- rolüne insert/update/delete açılmıyor.
create policy "yedekler_authenticated_read"
on storage.objects for select
to authenticated
using (bucket_id = 'yedekler');

-- 3) Zamanlama alt yapısı
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 4) Edge Function'ı çağırırken kullanılacak service_role anahtarını
-- Vault'a gizli olarak koy (SQL dosyasına asla düz metin anahtar
-- bırakmayın — aşağıdaki satırı çalıştırdıktan sonra anahtarı silin).
select vault.create_secret('<SERVICE_ROLE_KEY>', 'istem_service_role_key');

-- 5) Günlük 02:00 Türkiye saati (UTC+3) = 23:00 UTC.
-- pg_cron ifadesi Postgres'in kendi saat dilimine (Supabase'de varsayılan
-- UTC) göre çalışır, bu yüzden 23:00 UTC yazıyoruz.
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
    body := '{}'::jsonb
  );
  $$
);

-- Doğrulama:
--   select * from cron.job;                                          -- job kayıtlı mı
--   select * from cron.job_run_details order by start_time desc limit 5; -- çalışma geçmişi
