-- ============================================================
-- kontrol_sema.sql — antikor kontrol listesi (test_katalog.kontrol)
--
-- arsiv_yazdirma_sema.sql'den SONRA, YENİ KOD DEPLOY EDİLMEDEN ÖNCE
-- çalıştırın (yeni kod test_katalog.kontrol ve istem_kuyruk_v.kontrol
-- kolonlarını okur). İDEMPOTENT'tir.
-- istem_kuyruk_v'nin son hali duzeltme_sema.sql'dedir; bu dosya yeniden
-- çalıştırılırsa görünümü geri almaz (duzeltmeler kolonu varsa dokunmaz).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Kontrol dokusu — test başına, opsiyonel ("Tonsil", "Meme Ca" …).
-- Kuyrukta katalogdan CANLI okunur: değişince eski istemlerde de güncel.
-- ------------------------------------------------------------
alter table test_katalog add column if not exists kontrol text;
alter table test_katalog drop constraint if exists test_katalog_kontrol_chk;
alter table test_katalog add constraint test_katalog_kontrol_chk
  check (kontrol is null or char_length(kontrol) <= 200);

-- ------------------------------------------------------------
-- 2) "Kontrol listesi yükle" — eşleştirme ve önizleme uygulamada yapılır;
-- burası onaylanan listeyi TEK İŞLEMDE yazar. Yalnız yönetici (katalog
-- düzenleme yetkisiyle aynı; RLS de ayrıca uygulanır).
-- p_liste: [{"id": "<test_katalog.id>", "kontrol": "Tonsil" | null}, …]
-- Boş metin → null. Dönen: {"guncellenen": n} (değeri zaten aynı olanlar sayılmaz).
-- ------------------------------------------------------------
create or replace function public.katalog_kontrol_yukle(p_liste jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  n int;
begin
  if not public.is_admin() then
    raise exception 'Kontrol listesini yalnız yönetici yükleyebilir' using errcode = '42501';
  end if;
  if jsonb_typeof(p_liste) is distinct from 'array' then
    raise exception 'Liste bir dizi olmalı' using errcode = '22023';
  end if;
  update test_katalog t
     set kontrol = nullif(btrim(x.kontrol), '')
    from jsonb_to_recordset(p_liste) as x(id uuid, kontrol text)
   where t.id = x.id
     and t.kontrol is distinct from nullif(btrim(x.kontrol), '');
  get diagnostics n = row_count;
  return jsonb_build_object('guncellenen', n);
end $$;

revoke all on function public.katalog_kontrol_yukle(jsonb) from public, anon;
grant execute on function public.katalog_kontrol_yukle(jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 1/2 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 3) Kuyruk görünümü — kontrol SONA eklenir (önceki kolonlar aynen).
-- ------------------------------------------------------------
-- duzeltme_sema.sql çalıştıysa görünüm daha fazla kolonludur (duzeltmeler…)
-- — o durumda burada YENİDEN TANIMLANMAZ.
do $vw$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'istem_kuyruk_v' and column_name = 'duzeltmeler'
  ) then
    execute $sql$
create or replace view istem_kuyruk_v
with (security_invoker = true) as
select
  ik.id             as kalem_id,
  ik.istem_id,
  ik.blok_no,
  coalesce(tk.ad, ik.ozel_test)  as test_adi,
  tk.klon,
  ik.grup,
  i.patoloji_no,
  i.oncelik,
  i.not_metni,
  ik.durum,
  ik.created_at,
  ik.updated_at,
  isteyen.ad_soyad  as isteyen_adi,
  uzman.ad_soyad    as uzman_adi,
  ik.cihaz_id,
  c.ad              as cihaz_adi,
  i.istem_yapan_id,
  ik.tekrar_kaynagi_id,
  ik.kalite_notu,
  isteyen.kisaltma  as isteyen_kisaltma,
  uzman.kisaltma    as uzman_kisaltma,
  (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', n.id, 'yazan_id', n.yazan_id, 'yazan', y.ad_soyad, 'kisaltma', y.kisaltma,
             'zaman', n.created_at, 'metin', n.metin
           ) order by n.created_at desc), '[]'::jsonb)
    from istem_notlari n
    left join kullanicilar y on y.id = n.yazan_id
    where n.istem_id = i.id
  ) as notlar,
  i.uzman_id,
  ik.kesildi_at,
  ik.kesen_id,
  kesen.ad_soyad    as kesen_adi,
  kesen.kisaltma    as kesen_kisaltma,
  ik.blok_cikarildi_at,
  ik.blok_cikaran_id,
  cikaran.ad_soyad  as cikaran_adi,
  cikaran.kisaltma  as cikaran_kisaltma,
  (
    select coalesce(jsonb_object_agg(s.baglam, jsonb_build_object('zaman', s.created_at, 'kim', yk.ad_soyad, 'kisaltma', yk.kisaltma)), '{}'::jsonb)
    from (
      select distinct on (yz.baglam) yz.baglam, yz.created_at, yz.yazdiran_id
      from yazdirma_kayitlari yz
      where yz.kalem_id = ik.id
      order by yz.baglam, yz.created_at desc
    ) s
    left join kullanicilar yk on yk.id = s.yazdiran_id
  ) as yazdirmalar,
  tk.kontrol
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join kullanicilar kesen   on kesen.id   = ik.kesen_id
left join kullanicilar cikaran on cikaran.id = ik.blok_cikaran_id
left join cihazlar c        on c.id = ik.cihaz_id
    $sql$;
  end if;
end $vw$;

grant select on istem_kuyruk_v to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 2/2 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name = 'kontrol';   -- 1 satır
--   select count(*) filter (where kontrol is not null) as kontrollu, count(*) as toplam
--     from test_katalog;
-- ============================================================
