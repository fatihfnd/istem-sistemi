-- ============================================================
-- realtime_yayin_geri_al_sema.sql — realtime_yayin_kaldir_sema.sql'i geri alır
--
-- Tabloları supabase_realtime yayınına yeniden ekler; "Tablo dinleme (yedek)"
-- kipi yeniden olay alır. Yalnız var olan ve yayında olmayan tablolar
-- eklenir. İDEMPOTENT'tir.
-- ============================================================

do $yg$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime yayını yok — Supabase panelinde Database > Publications bölümüne bakın';
    return;
  end if;
  foreach t in array array['istem_kalemleri', 'istem_log', 'istem_notlari', 'yazdirma_kayitlari', 'istemler',
                           'duyurular', 'duyuru_guncellemeleri', 'istek_setleri', 'istek_seti_kalemleri', 'cihazlar']
  loop
    if to_regclass('public.' || t) is not null
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'yayına eklendi: %', t;
    end if;
  end loop;
end $yg$;

-- Doğrulama:
--   select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1;
