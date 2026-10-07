-- ============================================================
-- arsiv_yazdirma_sema.sql — arşiv ekibi + blok çıkarma, yazdırma kaydı,
-- fatura girişi geri alma kaydı
--
-- ekip_sema.sql ve push_sema.sql'den SONRA, YENİ KOD DEPLOY EDİLMEDEN
-- ÖNCE çalıştırın (yeni kod istem_kuyruk_v'nin blok_cikarildi_at /
-- yazdirmalar kolonlarını okur). İDEMPOTENT'tir.
-- istem_kuyruk_v'nin SON HALİ bu dosyadadır — ekip_sema.sql ya da daha
-- eski dosyaları yeniden çalıştırırsanız ardından bunu da çalıştırın.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Arşiv ekibi — kendi test grubu yoktur; "Ekibim" ekranı blok bazlı
-- arşiv listesidir (kesit gerektiren + kesit grubundaki tamamlanmamış kalemler).
-- ------------------------------------------------------------
alter table kullanicilar drop constraint if exists kullanicilar_ekip_chk;
alter table kullanicilar add constraint kullanicilar_ekip_chk
  check (ekip is null or ekip in ('immun', 'histomol', 'sito', 'kesit', 'sekreter', 'arsiv'));

-- Blok çıkarma damgası — doğrudan UPDATE'e AÇILMAZ (kolon bazlı izinlerde
-- yok); yalnız blok_cikarildi() / blok_cikarildi_geri_al().
alter table istem_kalemleri add column if not exists blok_cikarildi_at timestamptz;
alter table istem_kalemleri add column if not exists blok_cikaran_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'istem_kalemleri_cikaran_fkey') then
    alter table istem_kalemleri add constraint istem_kalemleri_cikaran_fkey
      foreign key (blok_cikaran_id) references kullanicilar(id) on delete set null;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2) Yazdırma kayıtları — her yazdırmada basılan kalemler, bağlamıyla:
--   calisma   İş Kuyruğu (Tümü / grup / Ekibim / Benim) ve Kesit ekranı
--   arsiv     Arşiv ekranı
--   hizmetler Hizmetler (istemin tüm kalemleri)
-- Herkes okur (yazıcı ikonu: kim, ne zaman); yalnız kendi adına ekler;
-- yalnız KENDİ ve SON 15 DAKİKALIK kaydını siler ("Yazdırılmadı — geri al").
-- ------------------------------------------------------------
create table if not exists yazdirma_kayitlari (
  id          uuid primary key default gen_random_uuid(),
  kalem_id    uuid not null references istem_kalemleri(id) on delete cascade,
  baglam      text not null check (baglam in ('arsiv', 'calisma', 'hizmetler')),
  yazdiran_id uuid references kullanicilar(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists yazdirma_kayitlari_kalem_idx on yazdirma_kayitlari (kalem_id, baglam, created_at desc);

-- ------------------------------------------------------------
-- 3) Fatura geçmişi — "Gir" ve geri alması, kim/ne zaman (trigger yazar).
-- ------------------------------------------------------------
create table if not exists fatura_gecmisi (
  id           uuid primary key default gen_random_uuid(),
  istem_id     uuid not null references istemler(id) on delete cascade,
  islem        text not null check (islem in ('girildi', 'geri_alindi')),
  kullanici_id uuid references kullanicilar(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists fatura_gecmisi_istem_idx on fatura_gecmisi (istem_id, created_at desc);

alter table yazdirma_kayitlari enable row level security;
alter table fatura_gecmisi enable row level security;
revoke all on yazdirma_kayitlari, fatura_gecmisi from anon, authenticated;
grant select, insert, delete on yazdirma_kayitlari to authenticated;
grant select on fatura_gecmisi to authenticated;

do $$
declare pol record;
begin
  for pol in select tablename, policyname from pg_policies
             where schemaname = 'public' and tablename in ('yazdirma_kayitlari', 'fatura_gecmisi')
  loop
    execute format('drop policy %I on %I', pol.policyname, pol.tablename);
  end loop;
end $$;

create policy yazdirma_kayitlari_select on yazdirma_kayitlari for select to authenticated using (true);
create policy yazdirma_kayitlari_insert on yazdirma_kayitlari for insert to authenticated
  with check (yazdiran_id = (select public.current_kullanici_id()));
create policy yazdirma_kayitlari_delete on yazdirma_kayitlari for delete to authenticated
  using (yazdiran_id = (select public.current_kullanici_id()) and created_at > now() - interval '15 minutes');
create policy fatura_gecmisi_select on fatura_gecmisi for select to authenticated using (true);
-- fatura_gecmisi'ne yazma politikası YOK: yalnız trigger (security definer) yazar.

-- Yazıcı ikonları diğer ekranlarda da canlı güncellensin.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'yazdirma_kayitlari') then
    alter publication supabase_realtime add table yazdirma_kayitlari;
  end if;
end $$;

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 4) Kuyruk görünümü — yeni kolonlar SONA eklenir: blok çıkarma + bağlam
-- başına son yazdırma ({ "calisma": {zaman, kim, kisaltma}, ... }).
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
  ) as yazdirmalar
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

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 5) Blok çıkarıldı — YALNIZ verilen kalem id'leri (ekranda o arşiv
-- satırında görünenler): kesit gerektiren ya da kesit grubundaki,
-- tamamlanmamış ve henüz damgasız kalemlere damga. Geri al: verilenlerin
-- damgası silinir. Yetki: yönetici, teknisyen, arşiv ekibi.
-- ------------------------------------------------------------
create or replace function public.blok_cikarma_yetkisi() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or coalesce(public.current_rol(), '') = 'teknisyen'
      or exists (select 1 from kullanicilar where id = public.current_kullanici_id() and ekip = 'arsiv')
$$;

create or replace function public.blok_cikarildi(p_kalem_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  ids uuid[] := array(select distinct x from unnest(coalesce(p_kalem_ids, '{}'::uuid[])) as x);
  n int;
begin
  if ben is null or not public.blok_cikarma_yetkisi() then
    raise exception 'Blok çıkarma yetkiniz yok (arşiv ekibi, teknisyen ya da yönetici)' using errcode = '42501';
  end if;
  update istem_kalemleri ik
    set blok_cikarildi_at = now(), blok_cikaran_id = ben
    where ik.id = any(ids) and ik.durum <> 'tamamlandi' and ik.blok_cikarildi_at is null
      and exists (select 1 from test_gruplari g where g.kod = ik.grup and (g.kesit_gerektirir or g.ekip = 'kesit'));
  get diagnostics n = row_count;
  return jsonb_build_object('damga', n, 'atlanan', coalesce(array_length(ids, 1), 0) - n);
end $$;

create or replace function public.blok_cikarildi_geri_al(p_kalem_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  ids uuid[] := array(select distinct x from unnest(coalesce(p_kalem_ids, '{}'::uuid[])) as x);
  n int;
begin
  if ben is null or not public.blok_cikarma_yetkisi() then
    raise exception 'Blok çıkarma geri alma yetkiniz yok (arşiv ekibi, teknisyen ya da yönetici)' using errcode = '42501';
  end if;
  update istem_kalemleri ik
    set blok_cikarildi_at = null, blok_cikaran_id = null
    where ik.id = any(ids) and ik.blok_cikarildi_at is not null;
  get diagnostics n = row_count;
  return jsonb_build_object('geri', n, 'atlanan', coalesce(array_length(ids, 1), 0) - n);
end $$;

revoke all on function public.blok_cikarma_yetkisi() from public, anon;
grant execute on function public.blok_cikarma_yetkisi() to authenticated;
revoke all on function public.blok_cikarildi(uuid[]) from public, anon;
grant execute on function public.blok_cikarildi(uuid[]) to authenticated;
revoke all on function public.blok_cikarildi_geri_al(uuid[]) from public, anon;
grant execute on function public.blok_cikarildi_geri_al(uuid[]) to authenticated;

-- ------------------------------------------------------------
-- 6) Fatura girişi: geri alma YALNIZ işaretleyen kişi ve yönetici; her
-- giriş ve geri alma fatura_gecmisi'ne (kim, ne zaman) yazılır.
-- auth.uid() boşsa (SQL Editor) yetki kontrolü yapılmaz, kayıt yine düşer.
-- ------------------------------------------------------------
create or replace function public.istemler_fatura_kaydi() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
begin
  if new.fatura_girildi is not distinct from old.fatura_girildi then
    return new;
  end if;
  if old.fatura_girildi and not coalesce(new.fatura_girildi, false) and auth.uid() is not null
     and not (public.is_admin() or old.fatura_giren_id = ben) then
    raise exception 'Bu fatura girişini yalnız işaretleyen kişi ya da yönetici geri alabilir' using errcode = '42501';
  end if;
  insert into fatura_gecmisi (istem_id, islem, kullanici_id)
  values (new.id, case when coalesce(new.fatura_girildi, false) then 'girildi' else 'geri_alindi' end, ben);
  return new;
end $$;

drop trigger if exists istemler_fatura_kaydi on istemler;
create trigger istemler_fatura_kaydi
  before update of fatura_girildi on istemler
  for each row execute function public.istemler_fatura_kaydi();

commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name in ('blok_cikarildi_at','yazdirmalar');  -- 2 satır
--   select * from fatura_gecmisi order by created_at desc limit 10;
-- ============================================================
