-- ============================================================
-- realtime_yayin_kaldir_sema.sql — Tabloları supabase_realtime yayınından çıkarır
--
-- ŞİMDİ ÇALIŞTIRMAYIN. performans_sema.sql çalıştıktan ve Yönetim > Sistem
-- sayfasında "Canlı güncelleme: Yayın kanalı" BİR HAFTA sorunsuz göründükten
-- sonra çalıştırın.
--
-- Ne yapar: uygulamanın eskiden dinlediği tabloları (postgres_changes)
-- yayından çıkarır; veritabanı bu tabloların değişikliklerini artık Realtime
-- için çözümlemez. Yayın kanalı (performans_sema.sql'deki tetikleyiciler) bu
-- yayından bağımsızdır, etkilenmez.
-- Sonrası: "Tablo dinleme (yedek)" kipi olay ALMAZ — yayın kanalı bir gün
-- kurulamazsa ekranlar yalnız 5 dakikalık sessiz senkronla ve "↻ Yenile" ile
-- güncellenir. Geri almak için: realtime_yayin_geri_al_sema.sql
-- İDEMPOTENT'tir (tekrar çalıştırmak güvenlidir).
-- ============================================================

do $yk$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime yayını yok — yapılacak bir şey yok';
    return;
  end if;
  foreach t in array array['istem_kalemleri', 'istem_log', 'istem_notlari', 'yazdirma_kayitlari', 'istemler',
                           'duyurular', 'duyuru_guncellemeleri', 'istek_setleri', 'istek_seti_kalemleri', 'cihazlar']
  loop
    if exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime drop table public.%I', t);
      raise notice 'yayından çıkarıldı: %', t;
    end if;
  end loop;
end $yk$;

-- Doğrulama (bu tabloların hiçbiri listede olmamalı):
--   select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
