-- ============================================================
-- duzeltme_sema.sql — istem düzeltme + değiştirilemez düzeltme kaydı
--
-- yaziyor_sema.sql'den SONRA, YENİ KOD DEPLOY EDİLMEDEN ÖNCE çalıştırın
-- (yeni kod istem_kuyruk_v.duzeltmeler / eski_patoloji_nolar kolonlarını
-- okur). İDEMPOTENT'tir. istem_kuyruk_v'nin SON HALİ bu dosyadadır;
-- daha eski dosyalar yeniden çalıştırılırsa görünümü geri almaz.
-- istem_duzelt'in son hali (test alanı) test_duzeltme_sema.sql'dedir.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Düzeltme kaydı. istemler / istem_kalemleri'ne yabancı anahtar YOK:
-- istem ya da kalem silinse de kayıt kalır.
-- alan: patoloji_no (istem) · blok_no (kalem) · uzman (istem, ad soyad
-- olarak) · oncelik (istem: rutin/acil/stat)
-- ------------------------------------------------------------
create table if not exists istem_duzeltmeleri (
  id          uuid primary key default gen_random_uuid(),
  istem_id    uuid not null,
  kalem_id    uuid,
  alan        text not null check (alan in ('patoloji_no', 'blok_no', 'uzman', 'oncelik')),
  eski_deger  text,
  yeni_deger  text,
  duzelten_id uuid,
  created_at  timestamptz not null default now()
);
create index if not exists istem_duzeltmeleri_istem_idx on istem_duzeltmeleri (istem_id, created_at);
create index if not exists istem_duzeltmeleri_kalem_idx on istem_duzeltmeleri (kalem_id) where kalem_id is not null;

-- RLS: oturum açmış herkes okur. Ekleme YALNIZ istem_duzelt() üzerinden
-- (her kayıt gerçek bir değişikliğe karşılık gelsin); güncelleme/silme
-- politikası yok, yetkisi de geri alınır.
alter table istem_duzeltmeleri enable row level security;
drop policy if exists istem_duzeltmeleri_okuma on istem_duzeltmeleri;
create policy istem_duzeltmeleri_okuma on istem_duzeltmeleri for select to authenticated using (true);
revoke all on istem_duzeltmeleri from anon;
revoke insert, update, delete, truncate on istem_duzeltmeleri from authenticated;
grant select on istem_duzeltmeleri to authenticated;

-- Değiştirilemez: yönetici, servis anahtarı ve SQL Editor dahil hiçbir
-- UPDATE / DELETE / TRUNCATE geçmez.
create or replace function public.istem_duzeltmeleri_degistirilemez() returns trigger
language plpgsql as $$
begin
  raise exception 'Düzeltme kayıtları değiştirilemez ve silinemez' using errcode = '42501';
end $$;

drop trigger if exists istem_duzeltmeleri_degistirilemez on istem_duzeltmeleri;
create trigger istem_duzeltmeleri_degistirilemez
  before update or delete on istem_duzeltmeleri
  for each row execute function public.istem_duzeltmeleri_degistirilemez();
drop trigger if exists istem_duzeltmeleri_truncate on istem_duzeltmeleri;
create trigger istem_duzeltmeleri_truncate
  before truncate on istem_duzeltmeleri
  for each statement execute function public.istem_duzeltmeleri_degistirilemez();

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 2) Düzeltme — tek transaction. Yetki: istemi giren kişi (istem_yapan_id)
-- ya da yönetici; kalemlerin durumu fark etmez. Kullanıcıların bu
-- kolonları doğrudan güncelleme yetkisi YOK (yalnız fatura/durum
-- kolonları) — düzeltmenin tek yolu bu fonksiyon.
-- p_degisiklik: { patoloji_no?, uzman_id? (boş = seçilmedi), oncelik?,
--                 bloklar?: [{ kalem_id, blok_no }] }  — test adı yok.
-- Değişen her alan → istem_duzeltmeleri satırı + istem_notlari notu.
-- ------------------------------------------------------------
-- test_duzeltme_sema.sql çalıştıysa fonksiyonun son hali (test alanıyla)
-- oradadır — o durumda burada YENİDEN TANIMLANMAZ.
do $fn$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public' and p.proname = 'istem_duzelt' and p.prosrc like '%testler%'
  ) then
    execute $sql$
create or replace function public.istem_duzelt(p_istem_id uuid, p_degisiklik jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  i istemler%rowtype;
  d jsonb := coalesce(p_degisiklik, '{}'::jsonb);
  yeni text;
  yeni_uzman uuid;
  uzman_eski text;
  uzman_yeni text;
  k record;
  anahtar text;
  blok_ozet jsonb := '{}'::jsonb;
  notlar text[] := '{}';
  n int := 0;
  onc constant jsonb := '{"rutin":"Rutin","acil":"Acil","stat":"STAT"}';
begin
  if ben is null then
    raise exception 'Oturum bulunamadı' using errcode = '42501';
  end if;
  select * into i from istemler where id = p_istem_id for update;
  if not found then
    raise exception 'İstem bulunamadı' using errcode = 'P0002';
  end if;
  if not (public.is_admin() or i.istem_yapan_id = ben) then
    raise exception 'Bu istemi yalnız giren kişi ya da yönetici düzeltebilir' using errcode = '42501';
  end if;

  if d ? 'patoloji_no' then
    yeni := btrim(d->>'patoloji_no');
    if yeni is null or yeni = '' then
      raise exception 'Patoloji no boş olamaz' using errcode = '22023';
    end if;
    if yeni is distinct from i.patoloji_no then
      update istemler set patoloji_no = yeni where id = i.id;
      insert into istem_duzeltmeleri (istem_id, alan, eski_deger, yeni_deger, duzelten_id)
        values (i.id, 'patoloji_no', i.patoloji_no, yeni, ben);
      notlar := notlar || format('Patoloji no %s → %s olarak düzeltildi', i.patoloji_no, yeni);
      n := n + 1;
    end if;
  end if;

  if d ? 'uzman_id' then
    yeni_uzman := nullif(d->>'uzman_id', '')::uuid;
    if yeni_uzman is not null and not exists (select 1 from kullanicilar where id = yeni_uzman) then
      raise exception 'Uzman bulunamadı' using errcode = '22023';
    end if;
    if yeni_uzman is distinct from i.uzman_id then
      select ad_soyad into uzman_eski from kullanicilar where id = i.uzman_id;
      select ad_soyad into uzman_yeni from kullanicilar where id = yeni_uzman;
      update istemler set uzman_id = yeni_uzman where id = i.id;
      insert into istem_duzeltmeleri (istem_id, alan, eski_deger, yeni_deger, duzelten_id)
        values (i.id, 'uzman', coalesce(uzman_eski, '—'), coalesce(uzman_yeni, '—'), ben);
      notlar := notlar || format('Uzman adına %s → %s olarak düzeltildi', coalesce(uzman_eski, '—'), coalesce(uzman_yeni, '—'));
      n := n + 1;
    end if;
  end if;

  if d ? 'oncelik' then
    yeni := d->>'oncelik';
    if yeni is null or yeni not in ('rutin', 'acil', 'stat') then
      raise exception 'Geçersiz öncelik' using errcode = '22023';
    end if;
    if yeni is distinct from i.oncelik then
      update istemler set oncelik = yeni where id = i.id;
      insert into istem_duzeltmeleri (istem_id, alan, eski_deger, yeni_deger, duzelten_id)
        values (i.id, 'oncelik', i.oncelik, yeni, ben);
      notlar := notlar || format('Öncelik %s → %s olarak düzeltildi', coalesce(onc->>i.oncelik, i.oncelik), onc->>yeni);
      n := n + 1;
    end if;
  end if;

  if jsonb_typeof(d->'bloklar') = 'array' then
    for k in
      select ik.id, ik.blok_no as eski, btrim(coalesce(x.blok_no, '')) as yeni, coalesce(tk.ad, ik.ozel_test, '?') as test
      from jsonb_to_recordset(d->'bloklar') as x(kalem_id uuid, blok_no text)
      join istem_kalemleri ik on ik.id = x.kalem_id and ik.istem_id = i.id
      left join test_katalog tk on tk.id = ik.test_id
    loop
      if k.yeni is distinct from k.eski then
        update istem_kalemleri set blok_no = k.yeni where id = k.id;
        insert into istem_duzeltmeleri (istem_id, kalem_id, alan, eski_deger, yeni_deger, duzelten_id)
          values (i.id, k.id, 'blok_no', k.eski, k.yeni, ben);
        anahtar := coalesce(nullif(k.eski, ''), '—') || ' → ' || coalesce(nullif(k.yeni, ''), '—');
        blok_ozet := jsonb_set(blok_ozet, array[anahtar], coalesce(blok_ozet->anahtar, '[]'::jsonb) || to_jsonb(k.test));
        n := n + 1;
      end if;
    end loop;
    for anahtar in select jsonb_object_keys(blok_ozet) loop
      notlar := notlar || format('Blok %s olarak düzeltildi (%s)', anahtar,
        (select string_agg(t, ', ') from jsonb_array_elements_text(blok_ozet->anahtar) as t));
    end loop;
  end if;

  insert into istem_notlari (istem_id, yazan_id, metin)
    select i.id, ben, m from unnest(notlar) as m;

  return jsonb_build_object('duzeltilen', n);
end $$;
    $sql$;
  end if;
end $fn$;

revoke all on function public.istem_duzelt(uuid, jsonb) from public, anon;
grant execute on function public.istem_duzelt(uuid, jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 3) Kuyruk görünümü — SONA eklenir:
--   duzeltmeler: { alan: { eski (İLK girilen), yeni (güncel), kim, kisaltma,
--                  zaman (son düzeltme), adet } } — kalemin kendi blok
--                  düzeltmeleri + istemin istem düzeyindeki düzeltmeleri
--   eski_patoloji_nolar: istemin önceki tüm patoloji no'ları (arama için)
-- ------------------------------------------------------------
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
  tk.kontrol,
  (
    select coalesce(jsonb_object_agg(dz.alan, jsonb_build_object(
             'eski', dz.ilk_eski, 'yeni', dz.son_yeni, 'kim', dk.ad_soyad, 'kisaltma', dk.kisaltma,
             'zaman', dz.son_zaman, 'adet', dz.adet)), '{}'::jsonb)
    from (
      select x.alan,
             (array_agg(x.eski_deger order by x.created_at))[1]       as ilk_eski,
             (array_agg(x.yeni_deger order by x.created_at desc))[1]  as son_yeni,
             (array_agg(x.duzelten_id order by x.created_at desc))[1] as son_kim,
             max(x.created_at) as son_zaman,
             count(*)          as adet
      from istem_duzeltmeleri x
      where x.istem_id = ik.istem_id and (x.kalem_id is null or x.kalem_id = ik.id)
      group by x.alan
    ) dz
    left join kullanicilar dk on dk.id = dz.son_kim
  ) as duzeltmeler,
  (
    select coalesce(array_agg(distinct x.eski_deger), '{}'::text[])
    from istem_duzeltmeleri x
    where x.istem_id = ik.istem_id and x.alan = 'patoloji_no'
  ) as eski_patoloji_nolar
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join kullanicilar kesen   on kesen.id   = ik.kesen_id
left join kullanicilar cikaran on cikaran.id = ik.blok_cikaran_id
left join cihazlar c        on c.id = ik.cihaz_id;

grant select on istem_kuyruk_v to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name in ('duzeltmeler', 'eski_patoloji_nolar');  -- 2 satır
--   select tgname from pg_trigger where tgrelid = 'istem_duzeltmeleri'::regclass and not tgisinternal;  -- 2 satır
-- ============================================================
