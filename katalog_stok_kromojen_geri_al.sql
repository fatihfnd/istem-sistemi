-- ============================================================
-- katalog_stok_kromojen_geri_al.sql — katalog_stok_kromojen_sema.sql'in
-- toplu veri değişikliklerini yedeklerden geri alır
--
-- Kaynak: o dosyanın başında alınan yedek_20261113_* tabloları.
-- Ne yapar:
--  1) Yeni kuralları kapatır: yeni kalemde katalog zorunluluğu, set/şablon
--     serbest metin engeli, grup taşıma ve "Diğer"i pasife alma tetikleyicileri.
--     katalog_talepleri yeniden adlandırılır (silinmez) → uygulama serbest
--     metne geri döner (açık sekmeler bir kez yenilenmeli).
--  2) Veriyi yedekteki haline döndürür:
--     - test_katalog: yedekteki testlerin ad, grup, klon, kontrol, açıklama,
--       eş adlar, aktif, sıra, birleştirme; silinen testler geri eklenir.
--       Yedekten SONRA eklenen testlere dokunulmaz.
--     - istem_kalemleri: test_id ve grup (eşleştirme, birleştirme, grup
--       taşıma geri alınır). Yedekten sonra açılan kalemlere dokunulmaz.
--     - sablon_kalemleri / istek_seti_kalemleri: test_id; birleştirmede
--       silinen çift satırlar geri eklenir.
-- Dokunmaz: kromojen ve stok sütunları (veri kalır, zararsız), duyurular,
-- yeni fonksiyonlar. İDEMPOTENT'tir (ikinci çalıştırmada değişiklik 0).
-- ============================================================

do $on$
declare
  t text;
begin
  foreach t in array array['istem_kalemleri', 'test_katalog', 'sablon_kalemleri', 'istek_seti_kalemleri'] loop
    if to_regclass('public.yedek_20261113_' || t) is null then
      raise exception 'yedek_20261113_% yok — geri alınamaz', t;
    end if;
  end loop;
end $on$;

create temp table if not exists _geri_al (adim text primary key, n bigint);

begin;

-- 1) Yeni kurallar kapanır
drop trigger if exists istem_kalemleri_katalog_kontrol on istem_kalemleri;
drop trigger if exists sablon_kalemleri_katalog_kontrol on sablon_kalemleri;
drop trigger if exists istek_seti_kalemleri_katalog_kontrol on istek_seti_kalemleri;
drop trigger if exists test_katalog_grup_tasi on test_katalog;
drop trigger if exists test_katalog_diger_pasif on test_katalog;
do $tl$
begin
  if to_regclass('public.katalog_talepleri') is not null then
    alter table public.katalog_talepleri rename to yedek_20261113_katalog_talepleri_kapali;
  end if;
end $tl$;

-- 2) Veri dönüşü (birleştirme / grup kontrolleri ve satır başı canlı yayın kapalı)
do $ac$ begin
  perform set_config('istem.test_birlestirme', 'on', true);
  perform set_config('istem.canli_sessiz', 'on', true);
  perform set_config('istem.katalog_duyuru', 'kapali', true);
end $ac$;

with d as (
  update test_katalog t
     set ad = y.ad, grup = y.grup, klon = y.klon, kontrol = y.kontrol, aciklama = y.aciklama,
         es_adlar = y.es_adlar, aktif = y.aktif, sira = y.sira, birlesti_id = y.birlesti_id
    from yedek_20261113_test_katalog y
   where y.id = t.id
     and (t.ad, t.grup, t.klon, t.kontrol, t.aciklama, t.es_adlar, t.aktif, t.sira, t.birlesti_id)
         is distinct from (y.ad, y.grup, y.klon, y.kontrol, y.aciklama, y.es_adlar, y.aktif, y.sira, y.birlesti_id)
  returning 1)
insert into _geri_al select 'test_katalog güncellendi', count(*) from d
on conflict (adim) do update set n = excluded.n;

with d as (
  insert into test_katalog (id, grup, ad, klon, sira, aktif, kontrol, aciklama, es_adlar, birlesti_id)
  select y.id, y.grup, y.ad, y.klon, y.sira, y.aktif, y.kontrol, y.aciklama, y.es_adlar, null
    from yedek_20261113_test_katalog y
   where not exists (select 1 from test_katalog t where t.id = y.id)
  returning 1)
insert into _geri_al select 'test_katalog geri eklendi (silinmişti)', count(*) from d
on conflict (adim) do update set n = excluded.n;

with d as (
  update istem_kalemleri ik set test_id = y.test_id, grup = y.grup
    from yedek_20261113_istem_kalemleri y
   where y.id = ik.id and (ik.test_id, ik.grup) is distinct from (y.test_id, y.grup)
  returning 1)
insert into _geri_al select 'istem_kalemleri test/grup geri alındı', count(*) from d
on conflict (adim) do update set n = excluded.n;

with d as (
  update sablon_kalemleri s set test_id = y.test_id
    from yedek_20261113_sablon_kalemleri y
   where y.id = s.id and s.test_id is distinct from y.test_id
  returning 1)
insert into _geri_al select 'sablon_kalemleri geri alındı', count(*) from d
on conflict (adim) do update set n = excluded.n;
with d as (
  insert into sablon_kalemleri (id, sablon_id, test_id, ozel_test)
  select y.id, y.sablon_id, y.test_id, y.ozel_test from yedek_20261113_sablon_kalemleri y
   where not exists (select 1 from sablon_kalemleri s where s.id = y.id)
     and exists (select 1 from sablonlar p where p.id = y.sablon_id)
  returning 1)
insert into _geri_al select 'sablon_kalemleri geri eklendi', count(*) from d
on conflict (adim) do update set n = excluded.n;

with d as (
  update istek_seti_kalemleri s set test_id = y.test_id
    from yedek_20261113_istek_seti_kalemleri y
   where y.id = s.id and s.test_id is distinct from y.test_id
  returning 1)
insert into _geri_al select 'istek_seti_kalemleri geri alındı', count(*) from d
on conflict (adim) do update set n = excluded.n;
with d as (
  insert into istek_seti_kalemleri (id, istek_seti_id, test_id, ozel_test)
  select y.id, y.istek_seti_id, y.test_id, y.ozel_test from yedek_20261113_istek_seti_kalemleri y
   where not exists (select 1 from istek_seti_kalemleri s where s.id = y.id)
     and exists (select 1 from istek_setleri p where p.id = y.istek_seti_id)
  returning 1)
insert into _geri_al select 'istek_seti_kalemleri geri eklendi', count(*) from d
on conflict (adim) do update set n = excluded.n;

-- "Diğer" grubu: yedekte aktif testi varsa yeniden aktif
update test_gruplari set aktif = true
 where kod = 'diger' and not aktif
   and exists (select 1 from yedek_20261113_test_katalog y where y.grup = 'diger' and y.aktif);

do $kp$ begin
  perform set_config('istem.test_birlestirme', '', true);
  perform set_config('istem.canli_sessiz', '', true);
end $kp$;
do $cs$ begin if to_regprocedure('public.canli_tam_senkron()') is not null then perform public.canli_tam_senkron(); end if; end $cs$;

commit;

notify pgrst, 'reload schema';

select adim as "geri alma adımı", n as "satır" from _geri_al order by adim;
