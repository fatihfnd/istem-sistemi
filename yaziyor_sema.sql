-- ============================================================
-- yaziyor_sema.sql — "Yazıyor…" göstergesi (Realtime Presence) + giriş sırası
--
-- kontrol_sema.sql'den SONRA, YENİ KOD DEPLOY EDİLMEDEN ÖNCE çalıştırın.
-- İDEMPOTENT'tir. Tablo oluşturmaz.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Presence: private kanal "istem-yaziyor". Herkese açık kanalda sitenin
-- (zaten açıkta olan) anahtarını bilen herkes yazılan patoloji numaralarını
-- görebilirdi; bu iki kural kanalı yalnız oturum açmış kullanıcılara açar.
-- Yalnız bu kanal ve yalnız presence (dinleme + yayın).
-- ------------------------------------------------------------
drop policy if exists istem_yaziyor_dinle on realtime.messages;
create policy istem_yaziyor_dinle on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'istem-yaziyor' and realtime.messages.extension in ('presence'));

drop policy if exists istem_yaziyor_yayinla on realtime.messages;
create policy istem_yaziyor_yayinla on realtime.messages
  for insert to authenticated
  with check (realtime.topic() = 'istem-yaziyor' and realtime.messages.extension in ('presence'));

-- ------------------------------------------------------------
-- 2) Çıktıda "Giriş sırası": bir istemin kalemleri tek INSERT ile girilir ve
-- now() hepsine AYNI zamanı verir — giriliş sırası kaybolur. clock_timestamp()
-- satır satır alınır; yeni kalemlerde sıra birebir korunur. Eski kayıtlara
-- dokunulmaz.
-- ------------------------------------------------------------
alter table istem_kalemleri alter column created_at set default clock_timestamp();

commit;

select 'yaziyor_sema tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select policyname from pg_policies
--     where schemaname = 'realtime' and tablename = 'messages' and policyname like 'istem_yaziyor%';  -- 2 satır
--   select column_default from information_schema.columns
--     where table_name = 'istem_kalemleri' and column_name = 'created_at';  -- clock_timestamp()
-- ============================================================
