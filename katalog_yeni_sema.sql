-- ============================================================
-- katalog_yeni_sema.sql — test kataloğunda eklenme tarihi ve "YENİ" etiketi
--
-- Ön koşul: yetki_katalog_sema.sql + katalog_stok_kromojen_sema.sql.
-- İDEMPOTENT: tekrar çalıştırmak zararsızdır.
--
--  1) test_katalog.created_at (timestamptz, varsayılan now()). Mevcut testler:
--     test_katalog_log'da "eklendi" kaydı varsa o tarih, yoksa 2026-01-01 —
--     mevcut testler "yeni" görünmez.
--  2) sistem_ayarlari.katalog_yeni_gun = 30 (YENİ etiketinin süresi, gün).
--  3) katalog_ice_aktar(p_islemler, p_duyuru, p_yeni default false): p_yeni
--     kapalıysa içe aktarılan yeni testlerin tarihi 2026-01-01 (YENİ olmaz).
--  4) test_geri_yukle: silinmeden önceki tarih korunur (yoksa 2026-01-01);
--     geri yüklenen test YENİ olmaz.
--  Gizlenenden geri alma, birleştirme ve stok "Geldi" created_at'e dokunmaz.
-- ============================================================

begin;

do $on$
begin
  if to_regclass('public.test_katalog') is null or to_regclass('public.test_katalog_log') is null then
    raise exception 'test_katalog / test_katalog_log yok — önce yetki_katalog_sema.sql';
  end if;
end $on$;

-- 1) Eklenme tarihi -----------------------------------------------------------
do $c$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'test_katalog' and column_name = 'created_at') then
    alter table public.test_katalog add column created_at timestamptz;
    -- Doldurma sırasında satır başı canlı yayın ve katalog izi/duyurusu yok.
    perform set_config('istem.canli_sessiz', 'on', true);
    perform set_config('istem.katalog_duyuru', 'kapali', true);
    update public.test_katalog t
       set created_at = coalesce(
             (select min(l.created_at) from public.test_katalog_log l where l.test_id = t.id and l.alan = 'eklendi'),
             timestamptz '2026-01-01 00:00:00+03');
    perform set_config('istem.canli_sessiz', '', true);
    perform set_config('istem.katalog_duyuru', '', true);
    alter table public.test_katalog alter column created_at set default now();
    alter table public.test_katalog alter column created_at set not null;
  end if;
end $c$;
create index if not exists test_katalog_created_at_idx on public.test_katalog (created_at desc);

-- 2) Ayar ------------------------------------------------------------------------
-- İzin verilen anahtarlara katalog_yeni_gun eklenir (mevcut liste korunur).
do $k$
declare
  liste text[];
begin
  select coalesce(array_agg(m[1]), '{}') into liste
    from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') m
   where c.conname = 'sistem_ayarlari_anahtar_chk' and c.conrelid = 'public.sistem_ayarlari'::regclass;
  if 'katalog_yeni_gun' = any (liste) then return; end if;
  liste := liste || array['teslim_gecikme_saat', 'teslim_takip_baslangic', 'eski_acik_gun', 'teslim_kayit_yok_gun', 'katalog_yeni_gun'];
  select array_agg(distinct x order by x) into liste from unnest(liste) x;
  alter table public.sistem_ayarlari drop constraint if exists sistem_ayarlari_anahtar_chk;
  execute format('alter table public.sistem_ayarlari add constraint sistem_ayarlari_anahtar_chk check (anahtar = any (%L::text[]))', liste);
end $k$;
-- Değer doğrulaması: 1–365 tam gün.
do $v$
declare
  f regprocedure := to_regprocedure('public.sistem_ayarlari_kontrol()');
  src text;
begin
  if f is null then return; end if;
  src := pg_get_functiondef(f);
  if position('katalog_yeni_gun' in src) > 0 then return; end if;
  src := regexp_replace(src, '(\s*)end if;(\s*)new\.guncelleyen_id',
    E'\n  elsif new.anahtar = ''katalog_yeni_gun'' then\n'
    || E'    if jsonb_typeof(new.deger) <> ''number'' or (new.deger #>> ''{}'')::numeric < 1 or (new.deger #>> ''{}'')::numeric > 365\n'
    || E'       or (new.deger #>> ''{}'')::numeric <> trunc((new.deger #>> ''{}'')::numeric) then\n'
    || E'      raise exception ''YENİ etiketi süresi 1–365 arası tam gün olmalı'' using errcode = ''22023'';\n'
    || E'    end if;\\1end if;\\2new.guncelleyen_id');
  if position('katalog_yeni_gun' in src) = 0 then
    raise exception 'sistem_ayarlari_kontrol beklenen biçimde değil — katalog_yeni_gun doğrulaması eklenemedi';
  end if;
  execute src;
end $v$;
insert into public.sistem_ayarlari (anahtar, deger)
values ('katalog_yeni_gun', '30'::jsonb)
on conflict (anahtar) do nothing;

-- 3) İçe aktarma: "YENİ olarak işaretle" (varsayılan kapalı) --------------------
drop function if exists public.katalog_ice_aktar(jsonb, boolean);
create or replace function public.katalog_ice_aktar(p_islemler jsonb, p_duyuru boolean default false, p_yeni boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  n_ekle int := 0;
  n_gunc int := 0;
  n_es int := 0;
  n int;
  x record;
begin
  if public.current_kullanici_id() is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  if jsonb_typeof(p_islemler) is distinct from 'array' then
    raise exception 'İşlem listesi bir dizi olmalı' using errcode = '22023';
  end if;
  if jsonb_array_length(p_islemler) > 2000 then
    raise exception 'Bir seferde en fazla 2000 satır içe aktarılabilir' using errcode = '22023';
  end if;
  perform set_config('istem.katalog_duyuru', case when coalesce(p_duyuru, false) then 'acik' else 'kapali' end, true);

  for x in select t.id, btrim(t.es_ad) as es_ad
           from jsonb_to_recordset(p_islemler) as t(islem text, id uuid, es_ad text)
           where t.islem = 'es_ad' and t.id is not null and btrim(coalesce(t.es_ad, '')) <> ''
  loop
    update test_katalog k set es_adlar = k.es_adlar || x.es_ad
    where k.id = x.id
      and public.test_anahtar(k.ad) <> public.test_anahtar(x.es_ad)
      and not exists (select 1 from unnest(k.es_adlar) e where public.test_anahtar(e) = public.test_anahtar(x.es_ad));
    get diagnostics n = row_count;
    n_es := n_es + n;
  end loop;

  update test_katalog k
     set klon = case when gu.j ? 'klon' then nullif(btrim(coalesce(gu.j->>'klon', '')), '') else k.klon end,
         kontrol = case when gu.j ? 'kontrol' then nullif(btrim(coalesce(gu.j->>'kontrol', '')), '') else k.kontrol end,
         aciklama = case when gu.j ? 'aciklama' then nullif(btrim(coalesce(gu.j->>'aciklama', '')), '') else k.aciklama end
    from (select e.j, (e.j->>'id')::uuid as id from jsonb_array_elements(p_islemler) as e(j) where e.j->>'islem' = 'guncelle') gu
   where k.id = gu.id
     and ((gu.j ? 'klon' and k.klon is distinct from nullif(btrim(coalesce(gu.j->>'klon', '')), ''))
       or (gu.j ? 'kontrol' and k.kontrol is distinct from nullif(btrim(coalesce(gu.j->>'kontrol', '')), ''))
       or (gu.j ? 'aciklama' and k.aciklama is distinct from nullif(btrim(coalesce(gu.j->>'aciklama', '')), '')));
  get diagnostics n_gunc = row_count;

  insert into test_katalog (grup, ad, klon, kontrol, aciklama, es_adlar, sira, created_at)
  select y.grup, y.ad, nullif(btrim(coalesce(y.klon, '')), ''), nullif(btrim(coalesce(y.kontrol, '')), ''),
         nullif(btrim(coalesce(y.aciklama, '')), ''), coalesce(y.es_adlar, '{}'),
         coalesce((select max(k.sira) from test_katalog k where k.grup = y.grup), 0) + 10 * row_number() over (partition by y.grup order by y.sira),
         case when coalesce(p_yeni, false) then now() else timestamptz '2026-01-01 00:00:00+03' end
  from (
    select e.j->>'grup' as grup, e.j->>'ad' as ad, e.j->>'klon' as klon, e.j->>'kontrol' as kontrol, e.j->>'aciklama' as aciklama,
           case when jsonb_typeof(e.j->'es_adlar') = 'array' then array(select jsonb_array_elements_text(e.j->'es_adlar')) end as es_adlar,
           e.sira
    from jsonb_array_elements(p_islemler) with ordinality as e(j, sira)
    where e.j->>'islem' = 'ekle'
  ) y
  order by y.sira;
  get diagnostics n_ekle = row_count;

  return jsonb_build_object('eklenen', n_ekle, 'guncellenen', n_gunc, 'es_ad', n_es);
end $$;
revoke all on function public.katalog_ice_aktar(jsonb, boolean, boolean) from public, anon;
grant execute on function public.katalog_ice_aktar(jsonb, boolean, boolean) to authenticated;

-- 4) Geri yükleme: eski tarih korunur ------------------------------------------------
do $g$
begin
  if to_regclass('public.test_katalog_silinen') is null then return; end if;
  execute $f$
create or replace function public.test_geri_yukle(p_silinen uuid) returns jsonb
language plpgsql security definer set search_path = public as $b$
declare
  ben uuid := public.current_kullanici_id();
  s test_katalog_silinen%rowtype;
begin
  if ben is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  select * into s from test_katalog_silinen where id = p_silinen for update;
  if s.id is null then raise exception 'Kayıt bulunamadı' using errcode = 'P0002'; end if;
  if s.geri_yuklendi_at is not null or exists (select 1 from test_katalog where id = s.test_id) then
    raise exception 'Bu test zaten geri yüklendi' using errcode = '22023';
  end if;
  perform set_config('istem.katalog_duyuru', 'kapali', true);
  -- Silinmeden önceki eklenme tarihi (kayıtta yoksa eski sabit tarih) — YENİ olmaz.
  insert into test_katalog
  select * from jsonb_populate_record(null::test_katalog,
    s.satir || jsonb_build_object('created_at', coalesce(s.satir->>'created_at', '2026-01-01T00:00:00+03:00')));
  delete from test_katalog_log where test_id = s.test_id;  -- eklemenin kendi "eklendi" izi; eski geçmiş aşağıda
  insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id, created_at)
  select s.test_id, l->>'alan', l->>'eski', l->>'yeni', nullif(l->>'degistiren_id', '')::uuid, (l->>'created_at')::timestamptz
  from jsonb_array_elements(s.gecmis) l;
  insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id) values (s.test_id, 'geri_yuklendi', null, s.ad, ben);
  update test_katalog_silinen set geri_yuklendi_at = now() where id = s.id;
  return jsonb_build_object('test_id', s.test_id);
end $b$;
$f$;
  execute 'revoke all on function public.test_geri_yukle(uuid) from public, anon';
  execute 'grant execute on function public.test_geri_yukle(uuid) to authenticated';
end $g$;

commit;

notify pgrst, 'reload schema';

select 'Eklenme tarihi olan test' as bilgi, count(*)::text as deger from public.test_katalog
union all
select 'Son ' || coalesce((select deger::text from public.sistem_ayarlari where anahtar = 'katalog_yeni_gun'), '30') || ' günde eklenen (YENİ)',
       count(*)::text from public.test_katalog
 where created_at > now() - make_interval(days => coalesce((select (deger #>> '{}')::int from public.sistem_ayarlari where anahtar = 'katalog_yeni_gun'), 30))
union all
select 'YENİ testler', coalesce(string_agg(ad, ', ' order by created_at), '—') from public.test_katalog
 where created_at > now() - make_interval(days => coalesce((select (deger #>> '{}')::int from public.sistem_ayarlari where anahtar = 'katalog_yeni_gun'), 30));
