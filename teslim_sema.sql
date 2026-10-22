-- ============================================================
-- teslim_sema.sql — "Teslim alındı" (lam hekime ulaştı) işareti
--
-- test_duzeltme_sema.sql'den SONRA çalıştırın. İDEMPOTENT'tir (tekrar
-- çalıştırmak güvenlidir; takip başlangıcı ve gecikme eşiği ezilmez).
-- Kod bu dosyadan önce de yayınlanabilir: teslim kolonları yoksa
-- uygulama eski sorguya düşer, teslim arayüzü gizli kalır.
--
-- Son halleri BU dosyadadır:
--   istem_kuyruk_v, istatistik(), blok_kesildi_geri_al()
-- duzeltme_sema.sql / ozet_yedek_sema.sql / ekip_sema.sql yeniden
-- çalıştırılırsa bunları geri almaz (son hali kuruluysa atlar).
--
-- Teslim YENİ BİR DURUM DEĞİLDİR: durum 'tamamlandi' kalır, teslim ayrı
-- işarettir (teslim_alan_id + teslim_at). Sayaçlar, sekmeler ve durum
-- kuralları değişmez; tek ek kural: teslim alınmış kalemin durumu, önce
-- teslim geri alınmadan değiştirilemez.
--
-- Veritabanındaki uygulama (istemciden atlanamaz):
--  1) Kolon bazlı izin: authenticated yalnız teslim_alan_id / teslim_at
--     kolonlarını EK olarak güncelleyebilir (mevcut kolon izinleri aynen).
--  2) Tetikleyici istem_kalemleri_teslim_kontrol (BEFORE UPDATE OF durum,
--     teslim_alan_id, teslim_at) — kim / hangi geçiş kuralları burada,
--     çünkü RLS UPDATE politikası eski ve yeni satırı aynı anda göremez
--     (USING eskiyi, WITH CHECK yeniyi görür) ve kolon ayıramaz:
--       teslim al   : yalnız Tamamlandı kalem; istemi giren (istem_yapan_id),
--                     adına istenen uzman (uzman_id) ya da yönetici —
--                     teknisyen (yönetici değilse) hiçbir zaman. Kim / ne
--                     zaman SUNUCUDA yazılır (current_kullanici_id(), now()):
--                     hangisi önce basarsa kayıt onun adına düşer.
--       tekrar teslim: reddedilir ("zaten teslim alındı")
--       geri al     : yalnız işaretleyen kişi ya da yönetici
--       durum değişikliği: kalem teslim alınmışsa reddedilir
--     Her teslim / geri alma istem_log'a yazılır:
--       tamamlandi → teslim_alindi · teslim_alindi → teslim_geri_alindi
--     ('tamamlandi' DEĞİL — tamamlanma süresi ve blok_kesildi_geri_al
--     "Tamamlandı'ya son geçiş"i arar, teslim olayı onu kaydırmasın.)
--  3) CHECK kısıtı: teslim_at doluysa durum = 'tamamlandi' (servis anahtarı
--     ve SQL Editor dahil HER yoldan).
-- auth.uid() boşsa (SQL Editor bakımı) yetki kontrolü yapılmaz, kayıt yine düşer.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Kolonlar. teslim_alan_id → kullanicilar (silme kuralı YOK: teslim
-- kaydı olan kullanıcı silinmez, pasifleştirilir — istem_yapan_id gibi).
-- ------------------------------------------------------------
alter table istem_kalemleri add column if not exists teslim_alan_id uuid;
alter table istem_kalemleri add column if not exists teslim_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'istem_kalemleri_teslim_alan_fkey') then
    alter table istem_kalemleri add constraint istem_kalemleri_teslim_alan_fkey
      foreign key (teslim_alan_id) references kullanicilar(id);
  end if;
end $$;

alter table istem_kalemleri drop constraint if exists istem_kalemleri_teslim_chk;
alter table istem_kalemleri add constraint istem_kalemleri_teslim_chk
  check ((teslim_at is null or durum = 'tamamlandi')
         and (teslim_alan_id is null or teslim_at is not null));

create index if not exists istem_kalemleri_teslim_alan_idx on istem_kalemleri (teslim_alan_id) where teslim_alan_id is not null;
create index if not exists istem_kalemleri_teslim_at_idx on istem_kalemleri (teslim_at) where teslim_at is not null;
create index if not exists istem_log_kalem_durum_idx on istem_log (istem_kalem_id, yeni_durum, created_at);

-- ------------------------------------------------------------
-- 2) Sistem ayarları — okuma: oturum açmış herkes; yazma: yalnız yönetici.
-- Silme yok. Değerler YALNIZ ilk kurulumda yazılır (yeniden çalıştırmada
-- ezilmez):
--   teslim_gecikme_saat    : 24 (takvim saati; 1–720)
--   teslim_takip_baslangic : bu dosyanın çalıştırıldığı an — öncesinde
--                            tamamlananlar teslim takibi dışında kalır
-- ------------------------------------------------------------
create table if not exists sistem_ayarlari (
  anahtar        text primary key,
  deger          jsonb not null,
  guncelleyen_id uuid,
  updated_at     timestamptz not null default now()
);

alter table sistem_ayarlari drop constraint if exists sistem_ayarlari_anahtar_chk;
alter table sistem_ayarlari add constraint sistem_ayarlari_anahtar_chk
  check (anahtar in ('teslim_gecikme_saat', 'teslim_takip_baslangic'));

-- Değer doğrulaması + kim/ne zaman damgası.
create or replace function public.sistem_ayarlari_kontrol() returns trigger
language plpgsql set search_path = public as $$
declare
  saat numeric;
begin
  if new.anahtar = 'teslim_gecikme_saat' then
    if jsonb_typeof(new.deger) <> 'number' then
      raise exception 'Gecikme eşiği sayı olmalı' using errcode = '22023';
    end if;
    saat := (new.deger #>> '{}')::numeric;
    if saat < 1 or saat > 720 or saat <> trunc(saat) then
      raise exception 'Gecikme eşiği 1–720 arası tam saat olmalı' using errcode = '22023';
    end if;
  elsif new.anahtar = 'teslim_takip_baslangic' then
    if jsonb_typeof(new.deger) <> 'string' then
      raise exception 'Takip başlangıcı tarih-saat olmalı' using errcode = '22023';
    end if;
    perform (new.deger #>> '{}')::timestamptz; -- geçersizse hata
  end if;
  new.guncelleyen_id := public.current_kullanici_id();
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists sistem_ayarlari_kontrol on sistem_ayarlari;
create trigger sistem_ayarlari_kontrol
  before insert or update on sistem_ayarlari
  for each row execute function public.sistem_ayarlari_kontrol();

insert into sistem_ayarlari (anahtar, deger) values
  ('teslim_gecikme_saat', '24'::jsonb),
  ('teslim_takip_baslangic', to_jsonb(now()))
on conflict (anahtar) do nothing;

alter table sistem_ayarlari enable row level security;
revoke all on sistem_ayarlari from anon;
revoke all on sistem_ayarlari from authenticated;
grant select, insert, update on sistem_ayarlari to authenticated;
grant select on sistem_ayarlari to service_role;  -- günlük yedek / özet (istem_kuyruk_v, istatistik)
drop policy if exists sistem_ayarlari_okuma on sistem_ayarlari;
drop policy if exists sistem_ayarlari_ekleme on sistem_ayarlari;
drop policy if exists sistem_ayarlari_guncelleme on sistem_ayarlari;
create policy sistem_ayarlari_okuma on sistem_ayarlari for select to authenticated using (true);
create policy sistem_ayarlari_ekleme on sistem_ayarlari for insert to authenticated
  with check ((select public.is_admin()));
create policy sistem_ayarlari_guncelleme on sistem_ayarlari for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 3) Kolon bazlı izin — mevcut izinlere EK (durum, updated_at, cihaz_id,
-- kalite_notu aynen kalır). UPDATE politikası değişmez; kural tetikleyicide.
-- ------------------------------------------------------------
grant update (teslim_alan_id, teslim_at) on istem_kalemleri to authenticated;

-- Teslim alma yetkisi: yönetici; ya da (teknisyen değilse) istemi giren
-- veya adına istenen uzman. Arayüz de bunu kullanır (aynı kural).
create or replace function public.teslim_yetkisi(p_istem_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (coalesce(public.current_rol(), '') <> 'teknisyen'
          and exists (
            select 1 from istemler i
            where i.id = p_istem_id
              and public.current_kullanici_id() in (i.istem_yapan_id, i.uzman_id)
          ))
$$;

revoke all on function public.teslim_yetkisi(uuid) from public, anon;
grant execute on function public.teslim_yetkisi(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4) Teslim kuralları + durum geri alma engeli + kayıt (bkz. başlık).
-- security definer: istem_log'a yazma çağıranın yetkisine bağlı olmasın.
-- ------------------------------------------------------------
create or replace function public.istem_kalemleri_teslim_kontrol() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  oturum constant boolean := auth.uid() is not null;
  ben uuid := public.current_kullanici_id();
  eski_teslim constant boolean := old.teslim_at is not null;
begin
  -- a) Teslim alınmış kalemin durumu değişmez (Tamamlandı → İşlemde dahil;
  --    yönetici dahil). Önce teslim geri alınmalı.
  if new.durum is distinct from old.durum and eski_teslim and new.teslim_at is not null then
    raise exception 'Teslim alınmış kalemin durumu geri alınamaz — önce teslimi geri alın' using errcode = '42501';
  end if;

  if not eski_teslim and (new.teslim_at is not null or new.teslim_alan_id is not null) then
    -- b) Teslim al
    if old.durum <> 'tamamlandi' or new.durum <> 'tamamlandi' then
      raise exception 'Yalnız Tamamlandı durumundaki kalem teslim alınabilir' using errcode = '22023';
    end if;
    if oturum then
      if ben is null or not public.teslim_yetkisi(new.istem_id) then
        raise exception 'Bu kalemi teslim alma yetkiniz yok (istemi giren, adına istenen uzman ya da yönetici)' using errcode = '42501';
      end if;
      new.teslim_alan_id := ben;
      new.teslim_at := now();
    else
      new.teslim_at := coalesce(new.teslim_at, now());
    end if;
    insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
      values (new.id, 'tamamlandi', 'teslim_alindi', new.teslim_alan_id);

  elsif eski_teslim and new.teslim_at is null then
    -- c) Teslimi geri al
    if oturum and not (public.is_admin() or (ben is not null and old.teslim_alan_id = ben)) then
      raise exception 'Teslimi yalnız işaretleyen kişi ya da yönetici geri alabilir' using errcode = '42501';
    end if;
    new.teslim_alan_id := null;
    insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
      values (new.id, 'teslim_alindi', 'teslim_geri_alindi', ben);

  elsif eski_teslim and oturum
        and (new.teslim_at is distinct from old.teslim_at or new.teslim_alan_id is distinct from old.teslim_alan_id) then
    -- d) Tekrar teslim / üzerine yazma
    raise exception 'Bu kalem zaten teslim alındı' using errcode = '42501';
  end if;

  return new;
end $$;

drop trigger if exists istem_kalemleri_teslim_kontrol on istem_kalemleri;
create trigger istem_kalemleri_teslim_kontrol
  before update of durum, teslim_alan_id, teslim_at on istem_kalemleri
  for each row execute function public.istem_kalemleri_teslim_kontrol();

-- ------------------------------------------------------------
-- 5) Kesildi geri al (ekip_sema.sql'deki sürüm + teslim alınmış kalemler
-- ATLANIR — aksi halde tetikleyici tüm işlemi reddederdi).
-- ------------------------------------------------------------
create or replace function public.blok_kesildi_geri_al(p_kalem_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  ids uuid[] := array(select distinct x from unnest(coalesce(p_kalem_ids, '{}'::uuid[])) as x);
  k record;
  onceki text;
  n_geri int := 0;
  n_damga int := 0;
begin
  if ben is null or not (public.is_admin() or coalesce(public.current_rol(), '') = 'teknisyen') then
    raise exception 'Kesildi geri alma yetkiniz yok (yalnız teknisyen veya yönetici)' using errcode = '42501';
  end if;

  for k in
    select ik.id
    from istem_kalemleri ik
    join test_gruplari g on g.kod = ik.grup
    where ik.id = any(ids) and g.ekip = 'kesit' and ik.durum = 'tamamlandi' and ik.kesildi_at is not null
      and ik.teslim_at is null
    for update of ik
  loop
    select l.eski_durum into onceki
      from istem_log l
      where l.istem_kalem_id = k.id and l.yeni_durum = 'tamamlandi'
      order by l.created_at desc limit 1;
    if onceki is null or onceki not in ('bekleyen', 'cihazda') then onceki := 'bekleyen'; end if;
    update istem_kalemleri
      set durum = onceki, updated_at = now(), kesildi_at = null, kesen_id = null
      where id = k.id;
    insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
      values (k.id, 'tamamlandi', onceki, ben);
    n_geri := n_geri + 1;
  end loop;

  update istem_kalemleri ik
    set kesildi_at = null, kesen_id = null
    where ik.id = any(ids) and ik.durum = 'bekleyen' and ik.kesildi_at is not null
      and exists (select 1 from test_gruplari g where g.kod = ik.grup and g.kesit_gerektirir);
  get diagnostics n_damga = row_count;

  return jsonb_build_object('geri', n_geri, 'damga', n_damga,
                            'atlanan', coalesce(array_length(ids, 1), 0) - n_geri - n_damga);
end $$;

revoke all on function public.blok_kesildi_geri_al(uuid[]) from public, anon;
grant execute on function public.blok_kesildi_geri_al(uuid[]) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 6) Kuyruk görünümü — duzeltme_sema.sql'deki son hal + SONA eklenenler:
--   teslim_alan_id, teslim_at, teslim_alan_adi, teslim_alan_kisaltma
--   tamamlandi_at   : Tamamlandı'ya SON geçiş (durum geçmişinden; Tamamlandı
--                     değilse boş)
--   teslim_takipte  : Tamamlandı ve takip başlangıcından sonra tamamlanmış
--                     (öncekiler teslim takibi dışında: buton çıkmaz, sayılmaz)
--   teslim_bekliyor : teslim_takipte ve henüz teslim alınmamış
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
  ) as eski_patoloji_nolar,
  ik.teslim_alan_id,
  ik.teslim_at,
  teslimci.ad_soyad as teslim_alan_adi,
  teslimci.kisaltma as teslim_alan_kisaltma,
  tm.tamamlandi_at,
  coalesce(tm.tamamlandi_at >= tb.baslangic, false) as teslim_takipte,
  coalesce(ik.teslim_at is null and tm.tamamlandi_at >= tb.baslangic, false) as teslim_bekliyor
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
) tb;

grant select on istem_kuyruk_v to authenticated;

-- ------------------------------------------------------------
-- 7) istatistik() — ozet_yedek_sema.sql'deki son hal + "tamamlanma → teslim":
--   teslim            : teslim zamanı aralıkta olan (şu an teslimli) kalem sayısı
--   teslim_ort_saat / teslim_medyan_saat :
--                       teslim_at − teslimden önceki SON "Tamamlandı" geçişi;
--                       teslim zamanının dönemine sayılır
--   teslim_bekleyen   : (yalnız özet) şu an teslim bekleyen kalem sayısı
-- Diğer her şey aynen (bkz. ozet_yedek_sema.sql).
-- ------------------------------------------------------------
create or replace function public.istatistik(p_bas date, p_bit date, p_periyot text default 'week') returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  tz constant text := 'Europe/Istanbul';
  per text := case p_periyot when 'month' then 'month' when 'day' then 'day' else 'week' end;
  bas_ts timestamptz;
  bit_ts timestamptz;
  takip timestamptz;
  sonuc jsonb;
begin
  if not (public.is_admin() or current_user in ('service_role', 'postgres')) then
    raise exception 'İstatistikler yalnızca yönetici içindir' using errcode = '42501';
  end if;
  if p_bas is null or p_bit is null or p_bit < p_bas then
    raise exception 'Geçersiz tarih aralığı';
  end if;
  bas_ts := p_bas::timestamp at time zone tz;
  bit_ts := (p_bit + 1)::timestamp at time zone tz;
  takip := coalesce(
    (select (s.deger #>> '{}')::timestamptz from sistem_ayarlari s where s.anahtar = 'teslim_takip_baslangic'),
    '-infinity'::timestamptz);

  with
  i as (
    select date_trunc(per, x.created_at at time zone tz)::date as d, x.istem_yapan_id, x.uzman_id
    from istemler x where x.created_at >= bas_ts and x.created_at < bit_ts
  ),
  k as (
    select date_trunc(per, x.created_at at time zone tz)::date as d, x.grup, (x.tekrar_kaynagi_id is not null) as tekrar
    from istem_kalemleri x where x.created_at >= bas_ts and x.created_at < bit_ts
  ),
  b as (
    select ik.created_at, max(l.created_at) as bitti
    from istem_kalemleri ik
    join istem_log l on l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi'
    where ik.durum = 'tamamlandi'
    group by ik.id, ik.created_at
  ),
  t as (
    select date_trunc(per, b.bitti at time zone tz)::date as d,
           (extract(epoch from (b.bitti - b.created_at)) / 3600.0)::double precision as saat
    from b where b.bitti >= bas_ts and b.bitti < bit_ts
  ),
  tsl as (
    select ik.teslim_at,
           (select max(l.created_at) from istem_log l
            where l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi' and l.created_at <= ik.teslim_at) as bitti
    from istem_kalemleri ik
    where ik.teslim_at >= bas_ts and ik.teslim_at < bit_ts
  ),
  ts as (
    select date_trunc(per, tsl.teslim_at at time zone tz)::date as d,
           (extract(epoch from (tsl.teslim_at - tsl.bitti)) / 3600.0)::double precision as saat
    from tsl where tsl.bitti is not null
  ),
  dn as (
    select generate_series(
             date_trunc(per, bas_ts at time zone tz),
             date_trunc(per, (bit_ts - interval '1 second') at time zone tz),
             ('1 ' || per)::interval
           )::date as d
  )
  select jsonb_build_object(
    'aralik', jsonb_build_object('bas', p_bas, 'bit', p_bit, 'periyot', per),
    'ozet', jsonb_build_object(
      'istem', (select count(*) from i),
      'kalem', (select count(*) from k),
      'tekrar', (select count(*) from k where k.tekrar),
      'tamamlanan', (select count(*) from t),
      'ort_saat', (select round(avg(t.saat)::numeric, 1) from t),
      'medyan_saat', (select round((percentile_cont(0.5) within group (order by t.saat))::numeric, 1) from t),
      'acik', (select count(*) from istem_kalemleri where durum in ('bekleyen', 'cihazda')),
      'teslim', (select count(*) from ts),
      'teslim_ort_saat', (select round(avg(ts.saat)::numeric, 1) from ts),
      'teslim_medyan_saat', (select round((percentile_cont(0.5) within group (order by ts.saat))::numeric, 1) from ts),
      'teslim_bekleyen', (
        select count(*) from istem_kalemleri x
        where x.durum = 'tamamlandi' and x.teslim_at is null
          and coalesce((select max(l.created_at) from istem_log l
                        where l.istem_kalem_id = x.id and l.yeni_durum = 'tamamlandi'), x.updated_at) >= takip
      )
    ),
    'donemler', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'd', dn.d,
        'istem', (select count(*) from i where i.d = dn.d),
        'kalem', (select count(*) from k where k.d = dn.d),
        'tekrar', (select count(*) from k where k.d = dn.d and k.tekrar),
        'tipler', (select coalesce(jsonb_object_agg(z.grup, z.n), '{}'::jsonb)
                   from (select k.grup, count(*) as n from k where k.d = dn.d group by k.grup) z),
        'tamamlanan', (select count(*) from t where t.d = dn.d),
        'ort_saat', (select round(avg(t.saat)::numeric, 1) from t where t.d = dn.d),
        'medyan_saat', (select round((percentile_cont(0.5) within group (order by t.saat))::numeric, 1) from t where t.d = dn.d),
        'teslim', (select count(*) from ts where ts.d = dn.d),
        'teslim_ort_saat', (select round(avg(ts.saat)::numeric, 1) from ts where ts.d = dn.d),
        'teslim_medyan_saat', (select round((percentile_cont(0.5) within group (order by ts.saat))::numeric, 1) from ts where ts.d = dn.d)
      ) order by dn.d), '[]'::jsonb)
      from dn
    ),
    'tipler', (
      select coalesce(jsonb_agg(jsonb_build_object('kod', z.grup, 'ad', coalesce(tg.ad, z.grup), 'n', z.n) order by z.n desc), '[]'::jsonb)
      from (select k.grup, count(*) as n from k group by k.grup) z
      left join test_gruplari tg on tg.kod = z.grup
    ),
    'kullanicilar', (
      select coalesce(jsonb_agg(jsonb_build_object('id', z.uid, 'ad', coalesce(u.ad_soyad, '(silinmiş kullanıcı)'), 'kisaltma', u.kisaltma, 'istem', z.n) order by z.n desc), '[]'::jsonb)
      from (select i.istem_yapan_id as uid, count(*) as n from i group by i.istem_yapan_id) z
      left join kullanicilar u on u.id = z.uid
    ),
    'uzmanlar', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', z.uid,
               'ad', case when z.uid is null then '(uzman seçilmedi)' else coalesce(u.ad_soyad, '(silinmiş kullanıcı)') end,
               'kisaltma', u.kisaltma, 'istem', z.n
             ) order by z.n desc), '[]'::jsonb)
      from (select i.uzman_id as uid, count(*) as n from i group by i.uzman_id) z
      left join kullanicilar u on u.id = z.uid
    )
  ) into sonuc;

  return sonuc;
end $$;

revoke all on function public.istatistik(date, date, text) from public, anon;
grant execute on function public.istatistik(date, date, text) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc,
  (select deger #>> '{}' from sistem_ayarlari where anahtar = 'teslim_takip_baslangic') as teslim_takip_baslangic,
  (select deger #>> '{}' from sistem_ayarlari where anahtar = 'teslim_gecikme_saat') as teslim_gecikme_saat;

-- ------------------------------------------------------------
-- Doğrulama:
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name in ('teslim_at', 'teslim_bekliyor', 'tamamlandi_at');  -- 3 satır
--   select tgname from pg_trigger where tgname = 'istem_kalemleri_teslim_kontrol';  -- 1 satır
--   select * from sistem_ayarlari;  -- 2 satır
--   select column_name from information_schema.column_privileges
--     where table_name = 'istem_kalemleri' and grantee = 'authenticated' and privilege_type = 'UPDATE';
--     -- durum, updated_at, cihaz_id, kalite_notu, teslim_alan_id, teslim_at
-- Son teslim olayları:
--   select l.created_at, l.eski_durum, l.yeni_durum, u.ad_soyad from istem_log l
--     left join kullanicilar u on u.id = l.degistiren_id
--     where l.yeni_durum in ('teslim_alindi', 'teslim_geri_alindi') order by l.created_at desc limit 20;
-- ============================================================
