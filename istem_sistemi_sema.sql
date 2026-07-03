-- ============================================================
-- Özel Test İstem Sistemi — Veritabanı Şeması (PostgreSQL)
-- Supabase ve on-prem Postgres'te BİREBİR çalışır (taşınabilir).
-- Enum yerine text + CHECK kullanıldı: ileride yeni değer eklemek kolay.
--
-- Bu şema istem_app.html arayüzüyle birebir örtüşecek şekilde
-- kuruludur:
--  - Durum takibi KALEM bazlıdır (istem_kalemleri.durum) çünkü aynı
--    istemin farklı blok/testleri birbirinden bağımsız ilerler
--    (ör. ER cihazda iken PR aynı bloktan hâlâ bekleyen olabilir).
--  - Öncelik 3 seviyelidir: rutin / acil / stat.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- KULLANICILAR  (uzman / asistan / teknisyen)
-- ------------------------------------------------------------
create table kullanicilar (
  id          uuid primary key default gen_random_uuid(),
  ad_soyad    text not null,
  rol         text not null check (rol in ('uzman','asistan','teknisyen')),
  pin         text,                       -- hafif oturum için (4-6 hane)
  aktif       boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- TEST KATALOĞU  (gruplu açılır listelerin kaynağı)
-- grup değerleri arayüz sekmeleriyle birebir aynıdır.
-- ------------------------------------------------------------
create table test_katalog (
  id     uuid primary key default gen_random_uuid(),
  grup   text not null check (grup in ('ihc','hk','mol','kesit','hucre','yayma','diger')),
  ad     text not null,                   -- ör. "ER", "PR", "HER2", "Ki-67"
  klon   text,                            -- ör. "SP1" (IHC klon bilgisi, opsiyonel)
  sira   int  not null default 0,         -- listede gösterim sırası
  aktif  boolean not null default true
);

-- ------------------------------------------------------------
-- ŞABLONLAR  ("Hazır Setler" + kişiye özel şablonlar)
-- sahip_id NULL ise şablon herkese açık/paylaşılan bir "hazır set"tir.
-- ------------------------------------------------------------
create table sablonlar (
  id         uuid primary key default gen_random_uuid(),
  sahip_id   uuid references kullanicilar(id),   -- NULL = herkese açık hazır set
  grup       text not null check (grup in ('ihc','hk','mol','kesit','hucre','yayma','diger')),
  ad         text not null,               -- ör. "Meme IHC Temel", "fd meme 1"
  created_at timestamptz not null default now()
);

create table sablon_kalemleri (
  id        uuid primary key default gen_random_uuid(),
  sablon_id uuid not null references sablonlar(id) on delete cascade,
  test_id   uuid references test_katalog(id),
  ozel_test text                          -- katalogda olmayan serbest test
);

-- ------------------------------------------------------------
-- İSTEMLER  (üst bilgi: patoloji no, isteyen, uzman, öncelik, not)
-- ------------------------------------------------------------
create table istemler (
  id             uuid primary key default gen_random_uuid(),
  patoloji_no    text not null,
  istem_yapan_id uuid not null references kullanicilar(id),  -- girişi yapan kişi
  uzman_id       uuid references kullanicilar(id),           -- kimin adına
  oncelik        text not null default 'rutin' check (oncelik in ('rutin','acil','stat')),
  not_metni      text,
  created_at     timestamptz not null default now()
);

-- ------------------------------------------------------------
-- İSTEM KALEMLERİ  (blok + test; her satır bir blok-test eşleşmesi)
-- Durum takibi buradadır — iş kuyruğu ekranı bu tabloyu (view üzerinden) okur.
-- ------------------------------------------------------------
create table istem_kalemleri (
  id         uuid primary key default gen_random_uuid(),
  istem_id   uuid not null references istemler(id) on delete cascade,
  blok_no    text not null,
  test_id    uuid references test_katalog(id),
  ozel_test  text,                        -- "diğer" / serbest metin
  grup       text not null check (grup in ('ihc','hk','mol','kesit','hucre','yayma','diger')),
             -- test_id doluysa test_katalog.grup ile aynı olmalı; ozel_test
             -- (serbest metin) satırlarda grup bilgisini tek başına bu kolon taşır.
  durum      text not null default 'bekleyen'
               check (durum in ('bekleyen','cihazda','tamamlandi','iptal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- DURUM GEÇMİŞİ  (kim, ne zaman, hangi kalemi hangi duruma aldı)
-- ------------------------------------------------------------
create table istem_log (
  id             uuid primary key default gen_random_uuid(),
  istem_kalem_id uuid not null references istem_kalemleri(id) on delete cascade,
  eski_durum     text,
  yeni_durum     text not null,
  degistiren_id  uuid references kullanicilar(id),
  created_at     timestamptz not null default now()
);

-- ------------------------------------------------------------
-- İNDEKSLER
-- ------------------------------------------------------------
create index on istem_kalemleri (durum);
create index on istem_kalemleri (istem_id);
create index on istem_kalemleri (created_at desc);
create index on istem_log (istem_kalem_id);
create index on sablon_kalemleri (sablon_id);
create index on sablonlar (sahip_id);
create index on sablonlar (grup);

-- ------------------------------------------------------------
-- KUYRUK GÖRÜNÜMÜ — iş kuyruğu ekranının tek sorguda okuduğu view.
-- security_invoker: view'ı sorgulayan rolün (anon) RLS politikaları
-- geçerli olsun diye (aksi halde view sahibinin yetkisiyle çalışır).
-- ------------------------------------------------------------
create view istem_kuyruk_v
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
  uzman.ad_soyad    as uzman_adi
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id;

-- ------------------------------------------------------------
-- Örnek katalog verisi (silinebilir / genişletilebilir)
-- ------------------------------------------------------------
insert into test_katalog (grup, ad, klon, sira) values
  ('ihc','ER','SP1',10), ('ihc','PR','BSB-2',20), ('ihc','HER2','4B5',30),
  ('ihc','Ki-67','30-9',40), ('ihc','E-Cadherin','EP700Y',50), ('ihc','p120','EP66',60),
  ('ihc','CK5/6','D5/16B4',70), ('ihc','p63','4A4',80), ('ihc','CD20','L26',90),
  ('ihc','CD3','SP7',100), ('ihc','BCL2','EP36',110), ('ihc','BCL6','EP29',120),
  ('ihc','CD10','SP67',130), ('ihc','AMACR','13H4',140), ('ihc','TTF-1','8G7G3/1',150),
  ('ihc','p40','BC28',160), ('ihc','CK7','OV-TL',170), ('ihc','CK20','SP33',180),
  ('ihc','GATA3','L50-823',190),
  ('hk','PAS',null,10), ('hk','PAS-D',null,20), ('hk','Giemsa',null,30),
  ('hk','Retikülin',null,40), ('hk','Masson Trikrom',null,50), ('hk','Kongo Kırmızısı',null,60),
  ('mol','BRAF',null,10), ('mol','EGFR',null,20), ('mol','KRAS',null,30),
  ('mol','MSI',null,40), ('mol','ALK',null,50), ('mol','HER2 FISH',null,60),
  ('kesit','Yeni kesit (H&E)',null,10), ('kesit','Seri kesit',null,20), ('kesit','Derin kesit',null,30),
  ('hucre','Hücre bloğu hazırlama',null,10),
  ('yayma','Yeniden yayma',null,10);

insert into sablonlar (sahip_id, grup, ad) values
  (null,'ihc','Meme IHC Temel'),
  (null,'ihc','Meme · Lobüler'),
  (null,'ihc','Lenfoma · B Hücre'),
  (null,'ihc','Prostat · PIN/Ca'),
  (null,'ihc','Akciğer · Adeno');

-- Hazır set kalemleri (test_katalog.ad üzerinden eşle)
insert into sablon_kalemleri (sablon_id, test_id)
select s.id, tk.id from sablonlar s
join (values
  ('Meme IHC Temel','ER'),('Meme IHC Temel','PR'),('Meme IHC Temel','HER2'),('Meme IHC Temel','Ki-67'),
  ('Meme · Lobüler','E-Cadherin'),('Meme · Lobüler','p120'),('Meme · Lobüler','CK5/6'),
  ('Lenfoma · B Hücre','CD20'),('Lenfoma · B Hücre','CD3'),('Lenfoma · B Hücre','BCL2'),('Lenfoma · B Hücre','BCL6'),('Lenfoma · B Hücre','CD10'),
  ('Prostat · PIN/Ca','CK5/6'),('Prostat · PIN/Ca','p63'),('Prostat · PIN/Ca','AMACR'),
  ('Akciğer · Adeno','TTF-1'),('Akciğer · Adeno','CK7'),('Akciğer · Adeno','p40'),('Akciğer · Adeno','CK20')
) as v(sablon_ad, test_ad) on v.sablon_ad = s.ad
join test_katalog tk on tk.ad = v.test_ad;

-- Örnek kullanıcılar (PIN'ler prototip amaçlıdır — gerçek kullanımda değiştirin)
insert into kullanicilar (ad_soyad, rol, pin) values
  ('Dr. F. Demir','asistan','1234'),
  ('Dr. A. Yılmaz','uzman','1111'),
  ('Dr. B. Kaya','uzman','2222'),
  ('Dr. C. Demir','uzman','3333'),
  ('M. Urgancı','teknisyen','4444');
