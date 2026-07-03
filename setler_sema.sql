-- ============================================================
-- İstek Setleri (kurumsal/ortak) + Cihazlar — EK şema
--
-- istem_sistemi_sema.sql ve policies.sql çalıştırıldıktan SONRA
-- Supabase SQL Editor'de çalıştırın. Bu dosya İDEMPOTENT'tir:
-- (create table if not exists / drop policy if exists ile) güvenle
-- yeniden çalıştırılabilir.
--
-- Kavramsal ayrım:
--  - sablonlar/sablon_kalemleri  = KİŞİYE ÖZEL şablonlar (sahip_id dolu).
--  - istek_setleri/istek_seti_kalemleri = HERKESE AÇIK, kurumsal
--    "hazır setler" (sahibi yok). Önceden sablonlar(sahip_id is null)
--    içinde tutulan 5 örnek set buraya taşınır (aşağıdaki migrasyon).
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- İSTEK SETLERİ  (kurumsal, ortak — owner yok)
-- ------------------------------------------------------------
create table if not exists istek_setleri (
  id         uuid primary key default gen_random_uuid(),
  grup       text not null check (grup in ('ihc','hk','mol','kesit','hucre','yayma','diger')),
  ad         text not null,
  uzmanlik   text,                 -- ör. "Meme", "Lenfoma", "Prostat" — sayfadaki sol filtre
  sira       int  not null default 0,
  aktif      boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists istek_seti_kalemleri (
  id            uuid primary key default gen_random_uuid(),
  istek_seti_id uuid not null references istek_setleri(id) on delete cascade,
  test_id       uuid references test_katalog(id),
  ozel_test     text
);

create index if not exists istek_seti_kalemleri_seti_idx on istek_seti_kalemleri (istek_seti_id);
create index if not exists istek_setleri_grup_idx on istek_setleri (grup);

-- ------------------------------------------------------------
-- CİHAZLAR
-- ------------------------------------------------------------
create table if not exists cihazlar (
  id         uuid primary key default gen_random_uuid(),
  ad         text not null,
  tip        text,
  aktif      boolean not null default true,
  created_at timestamptz not null default now()
);

-- İstem kalemine cihaz ataması (teknisyen panelinden, nullable)
alter table istem_kalemleri add column if not exists cihaz_id uuid references cihazlar(id);
create index if not exists istem_kalemleri_cihaz_idx on istem_kalemleri (cihaz_id);

-- ------------------------------------------------------------
-- MİGRASYON — eski "hazır setler" (sablonlar, sahip_id is null)
-- istek_setleri'ne bir kerelik taşınır. istek_setleri zaten doluysa
-- (bu script daha önce çalıştırıldıysa) tekrar çalışmaz.
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from istek_setleri) then
    insert into istek_setleri (grup, ad, sira)
    select grup, ad, row_number() over (order by ad)::int
    from sablonlar where sahip_id is null;

    insert into istek_seti_kalemleri (istek_seti_id, test_id, ozel_test)
    select ns.id, sk.test_id, sk.ozel_test
    from sablon_kalemleri sk
    join sablonlar s on s.id = sk.sablon_id and s.sahip_id is null
    join istek_setleri ns on ns.ad = s.ad;

    delete from sablon_kalemleri where sablon_id in (select id from sablonlar where sahip_id is null);
    delete from sablonlar where sahip_id is null;
  end if;
end $$;

-- Uzmanlık alanı — bilinen örnek setler için bir kerelik doldurulur
-- (yalnızca henüz boş olanlar; elle girilmiş değerlerin üzerine yazmaz).
update istek_setleri set uzmanlik = case
  when ad like 'Meme%'    then 'Meme'
  when ad like 'Lenfoma%' then 'Lenfoma'
  when ad like 'Prostat%' then 'Prostat'
  when ad like 'Akciğer%' then 'Akciğer'
  else uzmanlik
end
where uzmanlik is null;

-- ------------------------------------------------------------
-- KUYRUK GÖRÜNÜMÜ — cihaz bilgisi eklenerek yeniden tanımlanır.
-- Yeni kolonlar (cihaz_id, cihaz_adi) MEVCUT kolonların SONUNA
-- eklenir (CREATE OR REPLACE VIEW kısıtı: var olan kolon sırası
-- değişemez).
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
  c.ad              as cihaz_adi
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join cihazlar c        on c.id = ik.cihaz_id;

-- ------------------------------------------------------------
-- RLS — prototip: anon role tam okuma+yazma (bkz. policies.sql'deki
-- aynı uyarı — üretime geçmeden sıkılaştırılmalı).
-- ------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  istek_setleri, istek_seti_kalemleri, cihazlar
to anon, authenticated;
grant select on istem_kuyruk_v to anon, authenticated;

alter table istek_setleri        enable row level security;
alter table istek_seti_kalemleri enable row level security;
alter table cihazlar             enable row level security;

drop policy if exists "anon_full_access" on istek_setleri;
create policy "anon_full_access" on istek_setleri
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "anon_full_access" on istek_seti_kalemleri;
create policy "anon_full_access" on istek_seti_kalemleri
  for all to anon, authenticated using (true) with check (true);

drop policy if exists "anon_full_access" on cihazlar;
create policy "anon_full_access" on cihazlar
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- Realtime yayını — idempotent (zaten ekliyse tekrar eklemeyi
-- dener ve hataya düşmez).
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'istek_setleri'
  ) then
    alter publication supabase_realtime add table istek_setleri;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cihazlar'
  ) then
    alter publication supabase_realtime add table cihazlar;
  end if;
end $$;
