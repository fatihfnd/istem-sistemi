-- ============================================================
-- ekip_sema.sql — ekip altyapısı, kesit iş listesi, durum yetkisi
--
-- ek_ozellikler_sema.sql ve ozet_yedek_sema.sql'den SONRA, YENİ KOD
-- DEPLOY EDİLMEDEN ÖNCE çalıştırın (yeni kod test_gruplari.ekip /
-- kesit_gerektirir / kisa_ad, kullanicilar.ekip ve istem_kuyruk_v'nin
-- yeni kolonlarını okur). İDEMPOTENT'tir.
--
-- Bu dosyanın SON HALİ geçerlidir: istem_kuyruk_v, durum değişikliği
-- kuralı (istem_kalemleri_geri_alma_kontrol). yetki_sema.sql ya da
-- ek_ozellikler_sema.sql'i yeniden çalıştırırsanız ardından bunu da çalıştırın.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) test_gruplari: ekip, kesit_gerektirir, kisa_ad
-- Varsayılanlar YALNIZ kolon ilk eklendiğinde yazılır — sonradan Test
-- Grupları sayfasında yapılan değişiklikler, dosya yeniden çalışınca ezilmez.
--   ihc → immun · hk, mol, fish, diger → histomol · hucre, yayma → sito
--   kesit → kesit · kesit_gerektirir: ihc, hk, mol, fish
--   Listede olmayan (sonradan eklenmiş) gruplar: ekip boş, kesit gerektirmez.
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'test_gruplari' and column_name = 'ekip') then
    alter table test_gruplari add column ekip text;
    update test_gruplari set ekip = case kod
      when 'ihc' then 'immun'
      when 'hk' then 'histomol' when 'mol' then 'histomol' when 'fish' then 'histomol' when 'diger' then 'histomol'
      when 'hucre' then 'sito' when 'yayma' then 'sito'
      when 'kesit' then 'kesit'
    end;
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'test_gruplari' and column_name = 'kesit_gerektirir') then
    alter table test_gruplari add column kesit_gerektirir boolean not null default false;
    update test_gruplari set kesit_gerektirir = true where kod in ('ihc', 'hk', 'mol', 'fish');
  end if;

  -- Kısa ad: çapraz uyarı rozeti ("+HK") ve kesit özeti ("2 boş lam İHK").
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'test_gruplari' and column_name = 'kisa_ad') then
    alter table test_gruplari add column kisa_ad text;
    update test_gruplari set kisa_ad = case kod
      when 'ihc' then 'İHK' when 'hk' then 'HK' when 'mol' then 'MOL' when 'fish' then 'FISH'
      when 'kesit' then 'Kesit' when 'hucre' then 'Hücre' when 'yayma' then 'Yayma' when 'diger' then 'Diğer'
    end;
  end if;
end $$;

alter table test_gruplari drop constraint if exists test_gruplari_ekip_chk;
alter table test_gruplari add constraint test_gruplari_ekip_chk
  check (ekip is null or ekip in ('immun', 'histomol', 'sito', 'kesit'));

-- ------------------------------------------------------------
-- 2) kullanicilar.ekip — Kullanıcılar sayfasından admin atar.
-- 'sekreter': girişte Hizmetler sayfası açılır (ayrı rol değil).
-- ------------------------------------------------------------
alter table kullanicilar add column if not exists ekip text;
alter table kullanicilar drop constraint if exists kullanicilar_ekip_chk;
alter table kullanicilar add constraint kullanicilar_ekip_chk
  check (ekip is null or ekip in ('immun', 'histomol', 'sito', 'kesit', 'sekreter'));

-- ------------------------------------------------------------
-- 3) istem_kalemleri: kesim damgası. Doğrudan UPDATE'e AÇILMAZ (kolon
-- bazlı izinlerde yok) — yalnız blok_kesildi() / blok_kesildi_geri_al().
-- ------------------------------------------------------------
alter table istem_kalemleri add column if not exists kesildi_at timestamptz;
alter table istem_kalemleri add column if not exists kesen_id uuid;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'istem_kalemleri_kesen_fkey') then
    alter table istem_kalemleri add constraint istem_kalemleri_kesen_fkey
      foreign key (kesen_id) references kullanicilar(id) on delete set null;
  end if;
end $$;

commit;

select 'Parça 1/4 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 4) Kuyruk görünümü — yeni kolonlar SONA eklenir:
-- uzman_id ("Benim İsteklerim"), kesildi_at, kesen_id, kesen_adi, kesen_kisaltma
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
  kesen.kisaltma    as kesen_kisaltma
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join kullanicilar kesen   on kesen.id   = ik.kesen_id
left join cihazlar c        on c.id = ik.cihaz_id;

grant select on istem_kuyruk_v to authenticated;

-- ------------------------------------------------------------
-- 5) Durum değişikliği kuralı (İşleme Al / Tamamla / Geri Al):
-- YALNIZ yönetici ve teknisyen. Uzman/asistan (admin değilse) durum
-- değiştiremez — ileri de geri de. ("Kendi kalemini geri alır" kuralı
-- kaldırıldı.) Kendi Bekleyen kalemini İPTAL (silme) kuralı aynen geçerli.
-- auth.uid() boşsa (SQL Editor, service_role) kontrol yapılmaz.
-- ------------------------------------------------------------
create or replace function public.istem_kalemleri_geri_alma_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null
     and new.durum is distinct from old.durum
     and not (public.is_admin() or coalesce(public.current_rol(), '') = 'teknisyen')
  then
    raise exception 'Durum değiştirme yetkiniz yok (yalnız teknisyen veya yönetici)' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists istem_kalemleri_geri_alma_kontrol on istem_kalemleri;
create trigger istem_kalemleri_geri_alma_kontrol
  before update of durum on istem_kalemleri
  for each row execute function public.istem_kalemleri_geri_alma_kontrol();

commit;

notify pgrst, 'reload schema';

select 'Parça 2/4 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 6) Kesildi — YALNIZ verilen kalem id'leri (ekranda o blok satırında
-- görünenler) üzerinde çalışır; sonradan düşen istekler etkilenmez.
--  E) ekip = 'kesit' grubundaki, Tamamlandı olmayan kalemler (H&E, derin/
--     seri kesit…) → Tamamlandı + durum geçmişi + kesildi_at/kesen_id
--  K) kesit_gerektirir grubundaki, Bekleyen ve kesildi_at boş kalemler
--     (İHK/HK/MOL/FISH) → yalnız kesildi_at/kesen_id; durum DEĞİŞMEZ
--  Uymayanlar atlanır. Tek transaction, tek zaman damgası.
-- Yetki: yönetici ve teknisyen (her ekip).
-- ------------------------------------------------------------
create or replace function public.blok_kesildi(p_kalem_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  ids uuid[] := array(select distinct x from unnest(coalesce(p_kalem_ids, '{}'::uuid[])) as x);
  simdi timestamptz := now();
  k record;
  n_tamam int := 0;
  n_damga int := 0;
begin
  if ben is null or not (public.is_admin() or coalesce(public.current_rol(), '') = 'teknisyen') then
    raise exception 'Kesildi işaretleme yetkiniz yok (yalnız teknisyen veya yönetici)' using errcode = '42501';
  end if;

  for k in
    select ik.id, ik.durum
    from istem_kalemleri ik
    join test_gruplari g on g.kod = ik.grup
    where ik.id = any(ids) and g.ekip = 'kesit' and ik.durum <> 'tamamlandi'
    for update of ik
  loop
    update istem_kalemleri
      set durum = 'tamamlandi', updated_at = simdi, kesildi_at = simdi, kesen_id = ben
      where id = k.id;
    insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
      values (k.id, k.durum, 'tamamlandi', ben);
    n_tamam := n_tamam + 1;
  end loop;

  update istem_kalemleri ik
    set kesildi_at = simdi, kesen_id = ben
    where ik.id = any(ids) and ik.durum = 'bekleyen' and ik.kesildi_at is null
      and exists (select 1 from test_gruplari g where g.kod = ik.grup and g.kesit_gerektirir);
  get diagnostics n_damga = row_count;

  return jsonb_build_object('tamamlanan', n_tamam, 'damga', n_damga,
                            'atlanan', coalesce(array_length(ids, 1), 0) - n_tamam - n_damga);
end $$;

-- Geri al — verilen kalemler (bloğun son "Kesildi" işlemindekiler):
--  E) Tamamlandı ve kesildi_at dolu → kesimden ÖNCEKİ durum (durum
--     geçmişinden), kesildi_at/kesen_id temizlenir, geçmişe kayıt düşer
--  K) hâlâ Bekleyen ve kesildi_at dolu → kesildi_at/kesen_id temizlenir.
--     İşleme alınmışsa (kesim fiilen kullanılmış) DOKUNULMAZ → atlanır.
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
    for update of ik
  loop
    select l.eski_durum into onceki
      from istem_log l
      where l.istem_kalem_id = k.id and l.yeni_durum = 'tamamlandi'
      order by l.created_at desc limit 1;
    if onceki is null or onceki = 'tamamlandi' then onceki := 'bekleyen'; end if;
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

revoke all on function public.blok_kesildi(uuid[]) from public, anon;
grant execute on function public.blok_kesildi(uuid[]) to authenticated;
revoke all on function public.blok_kesildi_geri_al(uuid[]) from public, anon;
grant execute on function public.blok_kesildi_geri_al(uuid[]) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 3/4 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

-- ------------------------------------------------------------
-- 7) İHK altındaki "Yeni kesit" katalog girdisi → PASİF (silinmez;
-- geçmiş kalemler ve istatistikler aynen kalır). İsim tahmin edilmez:
-- İHK grubunda adı "yeni … kesit" kalıbına uyan TEK satır varsa
-- pasifleştirilir; hiç yoksa ya da birden fazlaysa HİÇBİR ŞEY değişmez
-- ve sonuçta eşleşen satırlar listelenir (Test Kataloğu sayfasından
-- elle pasifleştirilebilir).
-- ------------------------------------------------------------
with aday as (
  select id, ad, aktif from test_katalog
  where grup = 'ihc' and lower(btrim(ad)) like '%yeni%kesit%'
),
pasif as (
  update test_katalog t set aktif = false
  from aday
  where t.id = aday.id and (select count(*) from aday) = 1
  returning t.ad
)
select 'Parça 4/4 tamam' as sonuc,
  case
    when (select count(*) from aday) = 1
      then 'İHK "' || (select ad from aday) || '" pasifleştirildi (silinmedi)'
    when (select count(*) from aday) = 0
      then 'İHK altında "yeni kesit" adlı girdi bulunamadı — değişiklik yok'
    else 'Birden fazla eşleşme, DEĞİŞİKLİK YAPILMADI: '
      || (select string_agg(ad || case when aktif then ' (aktif)' else ' (pasif)' end, ', ') from aday)
  end as yeni_kesit;

-- ------------------------------------------------------------
-- Doğrulama:
--   select kod, ad, ekip, kesit_gerektirir, kisa_ad from test_gruplari order by sira;
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name in ('uzman_id','kesildi_at','kesen_kisaltma');  -- 3 satır
-- ============================================================
