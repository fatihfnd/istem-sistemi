-- ============================================================
-- duyuru_bildirim_sema.sql — tüm duyurular bildirim gönderir + kişi tercihi
--
-- Ön koşul: push_sema.sql, duyuru_sema.sql, yetki_katalog_sema.sql,
-- katalog_stok_kromojen_sema.sql (push_istegi). İDEMPOTENT.
--
--  1) duyuru_bildirim_tercihi (kullanici_id, secim 'tumu' | 'kritik' | 'kapali').
--     Kaydı olmayan "tumu" sayılır. Kritik duyurular "kapali"da da gider
--     (filtre push-gonder'de).
--  2) duyuru_push_tetikle: bilgi / uyarı duyurusu açılınca da bildirim
--     (olay 'yeni'). Kritik açılış ve teste bağlı çözülme bugünkü gibi.
--     istem.push_sessiz = 'on' → hiç bildirim yok (toplu işlemler).
--     istem.duyuru_otomatik = 'on' → otomatik katalog duyurusu; kendi
--     bildirimini ayrıca gönderir ('yeni_test'), çift gitmez.
--  3) test_katalog_duyuru: otomatik duyuruyu istem.duyuru_otomatik ile işaretler.
--  4) duyuru_guncellemeleri: AKTİF KRİTİK duyuruya güncelleme eklenince
--     bildirim (olay 'kritik_guncelleme'); uyarı / bilgi güncellemesinde yok.
--  5) push_abone_kullanicilar(): kimin kaç cihazı abone (yalnız yönetici).
-- ============================================================

begin;

do $on$
begin
  if to_regclass('public.duyurular') is null or to_regclass('public.push_abonelikleri') is null then
    raise exception 'duyurular / push_abonelikleri yok — önce duyuru_sema.sql ve push_sema.sql';
  end if;
  if to_regprocedure('public.push_istegi(jsonb)') is null then
    raise exception 'push_istegi(jsonb) yok — önce katalog_stok_kromojen_sema.sql';
  end if;
end $on$;

-- 1) Tercih ------------------------------------------------------------------
create table if not exists public.duyuru_bildirim_tercihi (
  kullanici_id uuid primary key references public.kullanicilar(id) on delete cascade,
  secim        text not null default 'tumu' check (secim in ('tumu', 'kritik', 'kapali')),
  updated_at   timestamptz not null default now()
);
alter table public.duyuru_bildirim_tercihi enable row level security;
revoke all on public.duyuru_bildirim_tercihi from anon, authenticated;
grant select, insert, update, delete on public.duyuru_bildirim_tercihi to authenticated;
drop policy if exists duyuru_bildirim_tercihi_kendi on public.duyuru_bildirim_tercihi;
create policy duyuru_bildirim_tercihi_kendi on public.duyuru_bildirim_tercihi for all to authenticated
  using (kullanici_id = (select public.current_kullanici_id()))
  with check (kullanici_id = (select public.current_kullanici_id()));

-- 2) Duyuru tetikleyicisi ---------------------------------------------------------
create or replace function public.duyuru_push_tetikle() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_olay text;
begin
  if coalesce(current_setting('istem.push_sessiz', true), '') = 'on' then return null; end if;
  if new.onem = 'kritik' and new.cozuldu_at is null and (new.bitis_at is null or new.bitis_at > now())
     and (tg_op = 'INSERT' or old.onem <> 'kritik' or old.cozuldu_at is not null) then
    v_olay := 'kritik';
  elsif tg_op = 'UPDATE' and old.cozuldu_at is null and new.cozuldu_at is not null and new.test_id is not null then
    v_olay := 'cozuldu';
  elsif tg_op = 'INSERT' and new.onem in ('bilgi', 'uyari') and new.cozuldu_at is null
        and (new.bitis_at is null or new.bitis_at > now())
        and coalesce(current_setting('istem.duyuru_otomatik', true), '') <> 'on' then
    v_olay := 'yeni';
  end if;
  if v_olay is null then return null; end if;
  perform public.push_istegi(jsonb_build_object('duyuru_id', new.id, 'olay', v_olay));
  return null;
exception when others then
  raise warning 'duyuru_push_tetikle (duyuru %): %', new.id, sqlerrm;
  return null;
end $$;
drop trigger if exists duyurular_push on public.duyurular;
create trigger duyurular_push after insert or update on public.duyurular
  for each row execute function public.duyuru_push_tetikle();

-- 3) Otomatik katalog duyurusu işaretlenir (kendi 'yeni_test' bildirimi gider) ----
do $kd$
declare
  f regprocedure := to_regprocedure('public.test_katalog_duyuru()');
  src text;
begin
  if f is null then return; end if;
  src := pg_get_functiondef(f);
  if position('duyuru_otomatik' in src) > 0 then return; end if;
  src := replace(src, 'if n = 0 then return null; end if;',
                      'if n = 0 then return null; end if;' || chr(10) || '  perform set_config(''istem.duyuru_otomatik'', ''on'', true);');
  src := replace(src, 'perform public.duyuru_push_gonder(v_id, ''yeni_test'');',
                      'perform set_config(''istem.duyuru_otomatik'', '''', true);' || chr(10) || '  perform public.duyuru_push_gonder(v_id, ''yeni_test'');');
  if (select count(*) from regexp_matches(src, 'duyuru_otomatik', 'g')) <> 2 then
    raise exception 'test_katalog_duyuru beklenen biçimde değil — otomatik işaret eklenemedi';
  end if;
  execute src;
end $kd$;

-- 4) Kritik duyuruya güncelleme → bildirim -------------------------------------------
create or replace function public.duyuru_guncelleme_push() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d record;
begin
  if coalesce(current_setting('istem.push_sessiz', true), '') = 'on' then return null; end if;
  select id, onem, cozuldu_at, bitis_at into d from duyurular where id = new.duyuru_id;
  if d.id is null or d.onem <> 'kritik' or d.cozuldu_at is not null or (d.bitis_at is not null and d.bitis_at <= now()) then
    return null;
  end if;
  perform public.push_istegi(jsonb_build_object('duyuru_id', d.id, 'olay', 'kritik_guncelleme', 'guncelleme_id', new.id));
  return null;
exception when others then
  raise warning 'duyuru_guncelleme_push (güncelleme %): %', new.id, sqlerrm;
  return null;
end $$;
drop trigger if exists duyuru_guncellemeleri_push on public.duyuru_guncellemeleri;
create trigger duyuru_guncellemeleri_push after insert on public.duyuru_guncellemeleri
  for each row execute function public.duyuru_guncelleme_push();

-- 5) Abonelik özeti (Yönetim > Kullanıcılar) --------------------------------------------
create or replace function public.push_abone_kullanicilar() returns table (kullanici_id uuid, cihaz int)
language sql stable security definer set search_path = public as $$
  select a.kullanici_id, count(*)::int from push_abonelikleri a where public.is_admin() group by a.kullanici_id
$$;
revoke all on function public.push_abone_kullanicilar() from public, anon;
grant execute on function public.push_abone_kullanicilar() to authenticated;

revoke all on function public.duyuru_guncelleme_push() from public, anon, authenticated;

commit;

notify pgrst, 'reload schema';

select 'Push aboneliği olan kişi' as bilgi, count(distinct kullanici_id)::text as deger from public.push_abonelikleri
union all select 'Aktif kullanıcı', count(*)::text from public.kullanicilar where aktif
union all select 'Duyuru tercihi kaydı (yoksa Tümü)', count(*)::text from public.duyuru_bildirim_tercihi
union all select 'Tetikleyiciler', string_agg(tgname, ', ' order by tgname) from pg_trigger
  where not tgisinternal and tgname in ('duyurular_push', 'duyuru_guncellemeleri_push');
