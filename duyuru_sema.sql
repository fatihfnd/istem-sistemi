-- ============================================================
-- duyuru_sema.sql — Duyurular / uyarılar (istemden bağımsız)
--
-- toplu_sema.sql'den SONRA çalıştırın. İDEMPOTENT'tir (tekrar çalıştırmak
-- güvenlidir); tek seferde ya da 3 parça hâlinde çalıştırılabilir. Kod bu
-- dosyadan önce yayınlansa da bozulmaz: tablolar yoksa şerit, "Duyurular"
-- menüsü ve işaretler hiç görünmez.
-- istem_kuyruk_v'nin SON HALİ bu dosyadadır (sona test_id eklendi;
-- toplu_sema.sql / teslim_sema.sql yeniden çalıştırılırsa geri almaz).
--
-- Aktif duyuru: cozuldu_at boş VE (bitis_at boş YA DA gelecekte).
--   duyuru_v.aktif bunu veritabanı saatiyle (now()) hesaplar.
-- Yetki (RLS):
--   duyurular            okuma: giriş yapan herkes · ekleme: herkes (yazan =
--                        kendisi) · düzenleme / Çözüldü / yeniden açma: yazan
--                        kişi, teknisyen, yönetici · silme: yalnız yönetici
--   duyuru_guncellemeleri okuma: herkes · ekleme: herkes (yazan = kendisi) ·
--                        değiştirilemez · silme: yalnız yönetici
--   duyuru_gizleme       yalnız kendi satırları; yalnız BİLGİ duyurusu gizlenir
-- Kim / ne zaman SUNUCUDA yazılır (tetikleyici): yazan, açılış zamanı,
-- çözen ve çözülme zamanı istemciden gelse de yok sayılır.
-- Web Push: kritik duyuru açılınca (ya da kritiğe yükseltilince / yeniden
-- açılınca) herkese; teste bağlı duyuru çözülünce o testi son 7 günde
-- istemiş kişilere (push-gonder yeniden deploy edilmeli).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Tablolar
-- ------------------------------------------------------------
create table if not exists duyurular (
  id          uuid primary key default gen_random_uuid(),
  baslik      text not null,
  metin       text not null default '',
  onem        text not null default 'bilgi',
  test_id     uuid references test_katalog(id) on delete set null,
  cihaz_id    uuid references cihazlar(id) on delete set null,
  yazan_id    uuid references kullanicilar(id) on delete set null,
  created_at  timestamptz not null default now(),
  bitis_at    timestamptz,
  cozuldu_at  timestamptz,
  cozen_id    uuid references kullanicilar(id) on delete set null
);
alter table duyurular drop constraint if exists duyurular_onem_chk;
alter table duyurular add constraint duyurular_onem_chk check (onem in ('bilgi', 'uyari', 'kritik'));
alter table duyurular drop constraint if exists duyurular_baslik_chk;
alter table duyurular add constraint duyurular_baslik_chk check (length(btrim(baslik)) between 1 and 200);
alter table duyurular drop constraint if exists duyurular_metin_chk;
alter table duyurular add constraint duyurular_metin_chk check (length(metin) <= 4000);
alter table duyurular drop constraint if exists duyurular_cozen_chk;
alter table duyurular add constraint duyurular_cozen_chk check (cozen_id is null or cozuldu_at is not null);
create index if not exists duyurular_acik_idx on duyurular (created_at desc) where cozuldu_at is null;
create index if not exists duyurular_test_idx on duyurular (test_id) where test_id is not null;
create index if not exists duyurular_cihaz_idx on duyurular (cihaz_id) where cihaz_id is not null;

create table if not exists duyuru_guncellemeleri (
  id          uuid primary key default gen_random_uuid(),
  duyuru_id   uuid not null references duyurular(id) on delete cascade,
  yazan_id    uuid references kullanicilar(id) on delete set null,
  metin       text not null,
  created_at  timestamptz not null default now()
);
alter table duyuru_guncellemeleri drop constraint if exists duyuru_guncellemeleri_metin_chk;
alter table duyuru_guncellemeleri add constraint duyuru_guncellemeleri_metin_chk check (length(btrim(metin)) between 1 and 2000);
create index if not exists duyuru_guncellemeleri_duyuru_idx on duyuru_guncellemeleri (duyuru_id, created_at);

create table if not exists duyuru_gizleme (
  kullanici_id uuid not null references kullanicilar(id) on delete cascade,
  duyuru_id    uuid not null references duyurular(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (kullanici_id, duyuru_id)
);

-- ------------------------------------------------------------
-- 2) Sunucuda yazılan alanlar (tetikleyici — RLS'in WITH CHECK'inden ÖNCE
-- çalışır). Ekleme: yazan = oturumdaki kişi, zaman = now(), çözülmüş
-- olarak açılamaz. Güncelleme: yazan ve açılış zamanı değişmez; Çözüldü
-- işaretlenince zaman = now(), çözen = işaretleyen; yeniden açılınca ikisi
-- boşalır; çözülmüş duyurunun çözülme bilgisi değiştirilemez.
-- (SQL Editor'de oturum yoktur: verilen değerler korunur.)
-- ------------------------------------------------------------
create or replace function public.duyurular_koru() returns trigger
language plpgsql set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
begin
  new.baslik := btrim(coalesce(new.baslik, ''));
  new.metin := btrim(coalesce(new.metin, ''));
  if tg_op = 'INSERT' then
    new.yazan_id := coalesce(ben, new.yazan_id);
    new.created_at := now();
    new.cozuldu_at := null;
    new.cozen_id := null;
    return new;
  end if;
  new.id := old.id;
  new.yazan_id := old.yazan_id;
  new.created_at := old.created_at;
  if old.cozuldu_at is null and new.cozuldu_at is not null then
    new.cozuldu_at := now();
    new.cozen_id := coalesce(ben, new.cozen_id);
  elsif new.cozuldu_at is null then
    new.cozen_id := null;
  else
    new.cozuldu_at := old.cozuldu_at;
    new.cozen_id := old.cozen_id;
  end if;
  return new;
end $$;
drop trigger if exists duyurular_koru on duyurular;
create trigger duyurular_koru before insert or update on duyurular
  for each row execute function public.duyurular_koru();

create or replace function public.duyuru_guncellemeleri_koru() returns trigger
language plpgsql set search_path = public as $$
begin
  new.yazan_id := coalesce(public.current_kullanici_id(), new.yazan_id);
  new.created_at := now();
  new.metin := btrim(coalesce(new.metin, ''));
  return new;
end $$;
drop trigger if exists duyuru_guncellemeleri_koru on duyuru_guncellemeleri;
create trigger duyuru_guncellemeleri_koru before insert on duyuru_guncellemeleri
  for each row execute function public.duyuru_guncellemeleri_koru();

-- ------------------------------------------------------------
-- 3) RLS. Pasif kullanıcı (current_kullanici_id() boş) hiçbir şey
-- yazamaz; anon hiçbir şeye erişemez.
-- ------------------------------------------------------------
alter table duyurular enable row level security;
alter table duyuru_guncellemeleri enable row level security;
alter table duyuru_gizleme enable row level security;

revoke all on duyurular, duyuru_guncellemeleri, duyuru_gizleme from anon, authenticated;
grant select, insert, update, delete on duyurular to authenticated;
grant select, insert, delete on duyuru_guncellemeleri to authenticated;
grant select, insert, delete on duyuru_gizleme to authenticated;

drop policy if exists duyurular_select on duyurular;
drop policy if exists duyurular_insert on duyurular;
drop policy if exists duyurular_update on duyurular;
drop policy if exists duyurular_delete on duyurular;
create policy duyurular_select on duyurular for select to authenticated using (true);
create policy duyurular_insert on duyurular for insert to authenticated
  with check (yazan_id = (select public.current_kullanici_id()));
create policy duyurular_update on duyurular for update to authenticated
  using (yazan_id = (select public.current_kullanici_id())
         or (select public.current_rol()) = 'teknisyen'
         or (select public.is_admin()))
  with check (yazan_id = (select public.current_kullanici_id())
         or (select public.current_rol()) = 'teknisyen'
         or (select public.is_admin()));
create policy duyurular_delete on duyurular for delete to authenticated
  using ((select public.is_admin()));

drop policy if exists duyuru_guncellemeleri_select on duyuru_guncellemeleri;
drop policy if exists duyuru_guncellemeleri_insert on duyuru_guncellemeleri;
drop policy if exists duyuru_guncellemeleri_delete on duyuru_guncellemeleri;
create policy duyuru_guncellemeleri_select on duyuru_guncellemeleri for select to authenticated using (true);
create policy duyuru_guncellemeleri_insert on duyuru_guncellemeleri for insert to authenticated
  with check (yazan_id = (select public.current_kullanici_id()));
create policy duyuru_guncellemeleri_delete on duyuru_guncellemeleri for delete to authenticated
  using ((select public.is_admin()));

drop policy if exists duyuru_gizleme_select on duyuru_gizleme;
drop policy if exists duyuru_gizleme_insert on duyuru_gizleme;
drop policy if exists duyuru_gizleme_delete on duyuru_gizleme;
create policy duyuru_gizleme_select on duyuru_gizleme for select to authenticated
  using (kullanici_id = (select public.current_kullanici_id()));
create policy duyuru_gizleme_insert on duyuru_gizleme for insert to authenticated
  with check (kullanici_id = (select public.current_kullanici_id())
              and exists (select 1 from duyurular d where d.id = duyuru_id and d.onem = 'bilgi'));
create policy duyuru_gizleme_delete on duyuru_gizleme for delete to authenticated
  using (kullanici_id = (select public.current_kullanici_id()));

-- ------------------------------------------------------------
-- 4) Canlı güncelleme (Realtime): değişiklik açık ekranlara anında düşer.
-- ------------------------------------------------------------
do $rt$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'duyurular') then
      alter publication supabase_realtime add table duyurular;
    end if;
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'duyuru_guncellemeleri') then
      alter publication supabase_realtime add table duyuru_guncellemeleri;
    end if;
  end if;
end $rt$;

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 5) duyuru_v — uygulamanın okuduğu görünüm (security_invoker: okuyanın
-- yetkileriyle). AKTİF DUYURU SORGUSU:
--   select * from duyuru_v where aktif order by onem_sira, created_at desc
-- Arşiv (çözülmüş + süresi dolmuş):
--   select * from duyuru_v where not aktif order by kapanis_at desc
-- gizledim: bu kişinin gizlediği BİLGİ duyurusu (uyarı / kritik gizlenmez —
-- sonradan önemi yükseltilen duyurunun gizlemesi geçersiz sayılır).
-- ------------------------------------------------------------
create or replace view duyuru_v
with (security_invoker = true) as
select
  d.id,
  d.baslik,
  d.metin,
  d.onem,
  d.test_id,
  d.cihaz_id,
  d.yazan_id,
  d.created_at,
  d.bitis_at,
  d.cozuldu_at,
  d.cozen_id,
  (d.cozuldu_at is null and (d.bitis_at is null or d.bitis_at > now())) as aktif,
  case d.onem when 'kritik' then 0 when 'uyari' then 1 else 2 end      as onem_sira,
  coalesce(d.cozuldu_at, case when d.bitis_at <= now() then d.bitis_at end) as kapanis_at,
  tk.ad             as test_adi,
  tk.grup           as test_grup,
  tk.klon           as test_klon,
  c.ad              as cihaz_adi,
  y.ad_soyad        as yazan_adi,
  y.kisaltma        as yazan_kisaltma,
  cz.ad_soyad       as cozen_adi,
  cz.kisaltma       as cozen_kisaltma,
  (d.onem = 'bilgi' and exists (
     select 1 from duyuru_gizleme g
     where g.duyuru_id = d.id and g.kullanici_id = public.current_kullanici_id()
  )) as gizledim,
  (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', u.id, 'yazan_id', u.yazan_id, 'yazan', uy.ad_soyad, 'kisaltma', uy.kisaltma,
             'zaman', u.created_at, 'metin', u.metin
           ) order by u.created_at), '[]'::jsonb)
    from duyuru_guncellemeleri u
    left join kullanicilar uy on uy.id = u.yazan_id
    where u.duyuru_id = d.id
  ) as guncellemeler
from duyurular d
left join test_katalog tk   on tk.id = d.test_id
left join cihazlar c        on c.id = d.cihaz_id
left join kullanicilar y    on y.id = d.yazan_id
left join kullanicilar cz   on cz.id = d.cozen_id;

grant select on duyuru_v to authenticated;

-- ------------------------------------------------------------
-- 6) Web Push — push_sema.sql kuruluysa (push_abonelikleri varsa). İstek
-- işlem kesinleştikten SONRA gider (pg_net); geri alınırsa hiç gitmez.
--   kritik : kritik duyuru açıldı / kritiğe yükseltildi / yeniden açıldı
--            (aktifse) → {duyuru_id, olay: "kritik"}
--   cozuldu: teste bağlı duyuru çözüldü → {duyuru_id, olay: "cozuldu"}
-- ------------------------------------------------------------
do $push$
begin
  if to_regclass('public.push_abonelikleri') is null then
    raise notice 'push_abonelikleri yok — Web Push kısmı atlandı (push_sema.sql kurulu değil)';
    return;
  end if;

  execute $fn$
create or replace function public.duyuru_push_tetikle() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_olay text;
begin
  if new.onem = 'kritik' and new.cozuldu_at is null and (new.bitis_at is null or new.bitis_at > now())
     and (tg_op = 'INSERT' or old.onem <> 'kritik' or old.cozuldu_at is not null) then
    v_olay := 'kritik';
  elsif tg_op = 'UPDATE' and old.cozuldu_at is null and new.cozuldu_at is not null and new.test_id is not null then
    v_olay := 'cozuldu';
  end if;
  if v_olay is null or not exists (select 1 from push_abonelikleri) then
    return null;
  end if;
  perform net.http_post(
    url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/push-gonder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'istem_service_role_key'
      )
    ),
    body := jsonb_build_object('duyuru_id', new.id, 'olay', v_olay),
    timeout_milliseconds := 30000
  );
  return null;
exception when others then
  raise warning 'duyuru_push_tetikle (duyuru %): %', new.id, sqlerrm;
  return null;
end $$;
  $fn$;

  drop trigger if exists duyurular_push on duyurular;
  create trigger duyurular_push after insert or update on duyurular
    for each row execute function public.duyuru_push_tetikle();
end $push$;

commit;

notify pgrst, 'reload schema';

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 7) Kuyruk görünümü — toplu_sema.sql'deki son hal + SONA test_id
-- (İş Kuyruğu / detay / çalışma çıktısı duyurunun testiyle kalemi adla
-- değil kimlikle eşlesin diye).
-- ------------------------------------------------------------
-- kons_eski_sema.sql çalıştıysa görünümün son hali (kons_no ile) oradadır —
-- o durumda burada YENİDEN TANIMLANMAZ.
do $vw$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'istem_kuyruk_v' and column_name = 'kons_no'
  ) then
    raise notice 'istem_kuyruk_v: daha yeni sürüm (kons_eski_sema.sql) kurulu — atlandı';
    return;
  end if;
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
  ) as eski_patoloji_nolar,
  ik.teslim_alan_id,
  ik.teslim_at,
  teslimci.ad_soyad as teslim_alan_adi,
  teslimci.kisaltma as teslim_alan_kisaltma,
  tm.tamamlandi_at,
  coalesce(tm.tamamlandi_at >= tb.baslangic, false) as teslim_takipte,
  coalesce(ik.teslim_at is null and tm.tamamlandi_at >= tb.baslangic, false) as teslim_bekliyor,
  i.created_at      as istem_created_at,
  i.toplu_id,
  i.toplu_sira,
  ik.test_id
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join kullanicilar kesen   on kesen.id   = ik.kesen_id
left join kullanicilar cikaran on cikaran.id = ik.blok_cikaran_id
left join kullanicilar teslimci on teslimci.id = ik.teslim_alan_id
left join cihazlar c        on c.id = ik.cihaz_id
left join lateral (
  select case when ik.durum = 'tamamlandi' then coalesce(
           (select max(l.created_at) from istem_log l
            where l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi'),
           ik.updated_at)
         end as tamamlandi_at
) tm on true
cross join (
  select coalesce(
           (select (s.deger #>> '{}')::timestamptz from sistem_ayarlari s where s.anahtar = 'teslim_takip_baslangic'),
           '-infinity'::timestamptz) as baslangic
) tb
$sql$;
end $vw$;

grant select on istem_kuyruk_v to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select table_name from information_schema.tables
--     where table_name in ('duyurular', 'duyuru_guncellemeleri', 'duyuru_gizleme');      -- 3 satır
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name = 'test_id';                    -- 1 satır
--   select tablename, policyname, cmd from pg_policies
--     where tablename like 'duyuru%' order by 1, 3;                                     -- 10 politika
-- Aktif duyurular:
--   select onem, baslik, test_adi, cihaz_adi, yazan_kisaltma, created_at, bitis_at
--     from duyuru_v where aktif order by onem_sira, created_at desc;
-- ============================================================
