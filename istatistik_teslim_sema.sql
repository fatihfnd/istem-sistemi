-- ============================================================
-- istatistik_teslim_sema.sql — kalem odaklı İstatistikler + teslim takibi
--
-- yetki_katalog_sema.sql'den SONRA çalıştırın (yetki sistemi kurulu
-- değilse de çalışır: istatistik o zaman yalnız yöneticide). İDEMPOTENT'tir.
-- SIRA: ÖNCE uygulama yayınlanır, SONRA bu dosya — arada İstatistikler
-- sayfası eski görünümüyle çalışır, toplu teslim tek tek isteğe düşer.
--
-- 1) sistem_ayarlari.teslim_kayit_yok_gun = 7: bundan eski, teslim
--    alınmamış tamamlananlar "Teslim kaydı yok (7+ gün)" — "Teslim
--    bekliyor"a sayılmaz.
-- 2) Tamamlanma zamanı yalnız tamamlandi_at / istem_log'dan — HİÇBİR
--    hesap updated_at'e dayanmaz:
--    - tamamlandi_at boş olan tamamlanmışlar istem_log'daki SON
--      "tamamlandi" kaydından doldurulur; log da yoksa NULL kalır.
--    - Süre ve dönem hesaplarına yalnız istem_log'da "tamamlandi" kaydı
--      olan kalemler girer (eski doldurmada log yoksa updated_at
--      kullanılmıştı — o kalemler süreleri bozmasın).
--    - Teslim sayıları "Teslim al" düğmesinin kuralıyla birebir:
--      Tamamlandı, tamamlandi_at ≥ teslim_takip_baslangic, teslim alınmamış.
-- 3) istatistik() (özet e-postası da kullanır): imza aynı; teslim_bekleyen
--    yukarıdaki kurala döner (< 7 gün), teslim_kayit_yok eklenir.
-- 4) istatistik_v2(): İstatistikler sayfasının tüm bölümleri tek çağrıda,
--    sunucuda toplanmış; istatistik_detay(): test / kişi ayrıntısı.
--    Yetki: "İstatistik" sayfa yetkisi (yetki_var('s_istatistik')); yetki
--    sistemi kurulu değilse yönetici.
-- 5) teslim_al_toplu(): seçili kalemleri tek istekte teslim alır;
--    uygun olmayanlar atlanır ve sayılır.
-- SON SORGU: bu haftanın kartları — eski kural / yeni kural yan yana —
-- ve tamamlandi_at doldurma sonucu.
-- ============================================================

do $on$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'istem_kalemleri' and column_name = 'tamamlandi_at') then
    raise exception 'Önce kons_eski_sema.sql çalıştırılmalı (istem_kalemleri.tamamlandi_at yok)';
  end if;
  if to_regclass('public.sistem_ayarlari') is null then
    raise exception 'Önce teslim_sema.sql çalıştırılmalı (sistem_ayarlari yok)';
  end if;
end $on$;

-- Doldurma sonucu son sorguda gösterilir (oturum sonunda kendiliğinden silinir).
create temp table if not exists _ist_kurulum (anahtar text primary key, deger bigint);

begin;

-- ------------------------------------------------------------
-- 1) Ayar: teslim_kayit_yok_gun
-- ------------------------------------------------------------
alter table sistem_ayarlari drop constraint if exists sistem_ayarlari_anahtar_chk;
alter table sistem_ayarlari add constraint sistem_ayarlari_anahtar_chk
  check (anahtar in ('teslim_gecikme_saat', 'teslim_takip_baslangic', 'eski_acik_gun', 'teslim_kayit_yok_gun'));

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
  elsif new.anahtar = 'eski_acik_gun' then
    if jsonb_typeof(new.deger) <> 'number' then
      raise exception 'Eski açık iş eşiği sayı olmalı' using errcode = '22023';
    end if;
    saat := (new.deger #>> '{}')::numeric;
    if saat < 1 or saat > 365 or saat <> trunc(saat) then
      raise exception 'Eski açık iş eşiği 1–365 arası tam gün olmalı' using errcode = '22023';
    end if;
  elsif new.anahtar = 'teslim_kayit_yok_gun' then
    if jsonb_typeof(new.deger) <> 'number' then
      raise exception 'Teslim kaydı yok eşiği sayı olmalı' using errcode = '22023';
    end if;
    saat := (new.deger #>> '{}')::numeric;
    if saat < 1 or saat > 365 or saat <> trunc(saat) then
      raise exception 'Teslim kaydı yok eşiği 1–365 arası tam gün olmalı' using errcode = '22023';
    end if;
  end if;
  new.guncelleyen_id := public.current_kullanici_id();
  new.updated_at := now();
  return new;
end $$;

insert into sistem_ayarlari (anahtar, deger) values ('teslim_kayit_yok_gun', '7'::jsonb)
on conflict (anahtar) do nothing;

-- ------------------------------------------------------------
-- 2) tamamlandi_at: boş olanlar istem_log'dan (log yoksa NULL kalır)
-- ------------------------------------------------------------
with son as (
  select l.istem_kalem_id, max(l.created_at) as t
  from istem_log l where l.yeni_durum = 'tamamlandi'
  group by l.istem_kalem_id
), d as (
  update istem_kalemleri ik set tamamlandi_at = son.t
  from son
  where son.istem_kalem_id = ik.id and ik.durum = 'tamamlandi' and ik.tamamlandi_at is null
  returning ik.id
)
insert into _ist_kurulum (anahtar, deger) select 'dolduruldu', count(*) from d
on conflict (anahtar) do update set deger = _ist_kurulum.deger + excluded.deger;

create index if not exists istem_log_durum_zaman_idx on istem_log (yeni_durum, created_at);
create index if not exists istem_log_cihazda_idx on istem_log (istem_kalem_id, created_at) where yeni_durum = 'cihazda';
create index if not exists istem_kalemleri_teslim_at_idx on istem_kalemleri (teslim_at) where teslim_at is not null;

-- ------------------------------------------------------------
-- 3) İstatistik yetkisi: yetki sistemi açıksa (yetkilerim() var)
--    "İstatistik" sayfa yetkisi; değilse yönetici. Sunucu (service_role:
--    özet e-postası) ve SQL Editor (postgres) her zaman.
--    SECURITY INVOKER: current_user çağıranın rolüdür.
-- ------------------------------------------------------------
create or replace function public.istatistik_yetkili() returns boolean
language plpgsql stable security invoker set search_path = public as $$
declare
  v boolean;
begin
  if current_user in ('service_role', 'postgres') then return true; end if;
  if to_regprocedure('public.yetkilerim()') is not null and to_regprocedure('public.yetki_var(text)') is not null then
    execute 'select public.yetki_var($1)' into v using 's_istatistik';
    return coalesce(v, false);
  end if;
  return coalesce(public.is_admin(), false);
end $$;
revoke all on function public.istatistik_yetkili() from public, anon;
grant execute on function public.istatistik_yetkili() to authenticated, service_role;

-- Dağılım özeti: n, ortalama, medyan, %90 (saat, 1 ondalık).
create or replace function public._ist_dagilim(p double precision[]) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'n', count(x),
    'ort', round(avg(x)::numeric, 1),
    'med', round((percentile_cont(0.5) within group (order by x))::numeric, 1),
    'p90', round((percentile_cont(0.9) within group (order by x))::numeric, 1))
  from unnest(coalesce(p, '{}')) as u(x) where x is not null
$$;

-- Teslim sayıları — "Teslim al" düğmesinin kuralı (istem_kuyruk_v.teslim_bekliyor):
-- Tamamlandı + tamamlandi_at ≥ takip başlangıcı + teslim alınmamış.
-- bekliyor: tamamlanalı < teslim_kayit_yok_gun; kayit_yok: ≥ o kadar gün.
create or replace function public._ist_teslim_sayilari() returns jsonb
language sql stable security invoker set search_path = public as $$
  with a as (
    select coalesce((select (s.deger #>> '{}')::timestamptz from sistem_ayarlari s where s.anahtar = 'teslim_takip_baslangic'), 'infinity'::timestamptz) as takip,
           coalesce((select (s.deger #>> '{}')::int from sistem_ayarlari s where s.anahtar = 'teslim_kayit_yok_gun'), 7) as gun,
           coalesce((select (s.deger #>> '{}')::numeric from sistem_ayarlari s where s.anahtar = 'teslim_gecikme_saat'), 24) as gec
  )
  select jsonb_build_object(
    'takip_baslangic', a.takip, 'kayit_yok_gun', a.gun, 'gecikme_saat', a.gec,
    'bekliyor', count(*) filter (where ik.tamamlandi_at >= now() - make_interval(days => a.gun)),
    'gecikmis', count(*) filter (where ik.tamamlandi_at >= now() - make_interval(days => a.gun)
                                    and ik.tamamlandi_at < now() - make_interval(secs => a.gec * 3600)),
    'kayit_yok', count(*) filter (where ik.tamamlandi_at < now() - make_interval(days => a.gun)))
  from a left join istem_kalemleri ik
    on ik.durum = 'tamamlandi' and ik.teslim_at is null and ik.tamamlandi_at >= a.takip
  group by a.takip, a.gun, a.gec
$$;

-- ------------------------------------------------------------
-- 4) istatistik() — imza aynı (özet e-postası). Değişen: yetki
--    (istatistik_yetkili) ve teslim_bekleyen (Teslim al kuralı, < N gün);
--    eklenen: teslim_kayit_yok. Diğer her şey teslim_sema.sql'deki gibi.
-- ------------------------------------------------------------
create or replace function public.istatistik(p_bas date, p_bit date, p_periyot text default 'week') returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  tz constant text := 'Europe/Istanbul';
  per text := case p_periyot when 'month' then 'month' when 'day' then 'day' else 'week' end;
  bas_ts timestamptz;
  bit_ts timestamptz;
  tsy jsonb;
  sonuc jsonb;
begin
  -- Yetki istatistik_yetkili()'de. (yetki_katalog_sema.sql'in eski bağlama
  -- satırı — "if not (public.yetki_var('s_istatistik') or current_user in" —
  -- bu yorumdadır; o dosya yeniden çalışınca "zaten bağlı" der.)
  if not public.istatistik_yetkili() then
    raise exception 'İstatistikleri görme yetkiniz yok' using errcode = '42501';
  end if;
  if p_bas is null or p_bit is null or p_bit < p_bas then
    raise exception 'Geçersiz tarih aralığı';
  end if;
  bas_ts := p_bas::timestamp at time zone tz;
  bit_ts := (p_bit + 1)::timestamp at time zone tz;
  tsy := public._ist_teslim_sayilari();

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
      'teslim_bekleyen', (tsy->>'bekliyor')::int,
      'teslim_kayit_yok', (tsy->>'kayit_yok')::int,
      'teslim_kayit_yok_gun', (tsy->>'kayit_yok_gun')::int
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

select 'Parça 1/2 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 5) Kalem kümeleri (iç yardımcılar, SECURITY INVOKER — RLS geçerli)
--    _ist_kalem: aralıkta İSTENEN kalemler (created_at)
--    _ist_tamam: aralıkta TAMAMLANAN kalemler — yalnız istem_log'da
--                "tamamlandi" kaydı olanlar (tamamlanma zamanı kesin)
-- ------------------------------------------------------------
create or replace function public._ist_kalem(p_bas timestamptz, p_bit timestamptz)
returns table (id uuid, istem_id uuid, grup text, test_key text, test_ad text, vaka text, oncelik text,
               istem_yapan_id uuid, uzman_id uuid, created_at timestamptz, tekrar boolean)
language sql stable security invoker set search_path = public as $$
  select ik.id, ik.istem_id, ik.grup,
         coalesce(ik.test_id::text, 'ozel:' || lower(btrim(coalesce(ik.ozel_test, '?')))),
         coalesce(tk.ad, nullif(btrim(ik.ozel_test), ''), '?'),
         upper(regexp_replace(i.patoloji_no, '\s+', '', 'g')),
         coalesce(i.oncelik, 'rutin'), i.istem_yapan_id, i.uzman_id, ik.created_at,
         ik.tekrar_kaynagi_id is not null
  from istem_kalemleri ik
  join istemler i on i.id = ik.istem_id
  left join test_katalog tk on tk.id = ik.test_id
  where ik.created_at >= p_bas and ik.created_at < p_bit
$$;

create or replace function public._ist_tamam(p_bas timestamptz, p_bit timestamptz)
returns table (id uuid, grup text, test_key text, oncelik text, created_at timestamptz, tamamlandi_at timestamptz,
               teslim_at timestamptz, ilk_isleme timestamptz, son_isleme timestamptz)
language sql stable security invoker set search_path = public as $$
  select ik.id, ik.grup, coalesce(ik.test_id::text, 'ozel:' || lower(btrim(coalesce(ik.ozel_test, '?')))),
         coalesce(i.oncelik, 'rutin'), ik.created_at, ik.tamamlandi_at, ik.teslim_at,
         (select min(l.created_at) from istem_log l where l.istem_kalem_id = ik.id and l.yeni_durum = 'cihazda'),
         (select max(l.created_at) from istem_log l where l.istem_kalem_id = ik.id and l.yeni_durum = 'cihazda'
            and l.created_at <= ik.tamamlandi_at)
  from istem_kalemleri ik
  join istemler i on i.id = ik.istem_id
  where ik.durum = 'tamamlandi' and ik.tamamlandi_at >= p_bas and ik.tamamlandi_at < p_bit
    and exists (select 1 from istem_log l where l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi')
$$;

-- Özet kartları (aralık ve önceki eşit dönem için aynı hesap)
create or replace function public._ist_ozet(p_bas timestamptz, p_bit timestamptz) returns jsonb
language sql stable security invoker set search_path = public as $$
  with k as (select * from public._ist_kalem(p_bas, p_bit)),
       c as (select (extract(epoch from (t.tamamlandi_at - t.created_at)) / 3600.0)::double precision as saat
             from public._ist_tamam(p_bas, p_bit) t)
  select jsonb_build_object(
    'kalem', (select count(*) from k),
    'istem', (select count(distinct k.istem_id) from k),
    'vaka', (select count(distinct k.vaka) from k),
    'vaka_basina', (select round(count(*)::numeric / nullif(count(distinct k.vaka), 0), 2) from k),
    'tekrar', (select count(*) from k where k.tekrar),
    'tamamlanan', (select count(*) from c),
    'ort_saat', (select round(avg(c.saat)::numeric, 1) from c),
    'medyan_saat', (select round((percentile_cont(0.5) within group (order by c.saat))::numeric, 1) from c))
$$;

-- ------------------------------------------------------------
-- 6) istatistik_v2 — İstatistikler sayfası (tek çağrı, toplanmış sonuç)
-- p_bas / p_bit: Türkiye yerel tarihleri (ikisi de dahil). Önceki dönem:
-- aralıktan hemen önceki eşit uzunluk.
-- ------------------------------------------------------------
create or replace function public.istatistik_v2(p_bas date, p_bit date, p_periyot text default 'week') returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  tz constant text := 'Europe/Istanbul';
  per text := case p_periyot when 'month' then 'month' when 'day' then 'day' else 'week' end;
  bas_ts timestamptz;
  bit_ts timestamptz;
  obas_ts timestamptz;
  takip timestamptz;
  kayit_gun int;
  s jsonb := '{}'::jsonb;
begin
  if not public.istatistik_yetkili() then
    raise exception 'İstatistikleri görme yetkiniz yok' using errcode = '42501';
  end if;
  if p_bas is null or p_bit is null or p_bit < p_bas or p_bit - p_bas > 3700 then
    raise exception 'Geçersiz tarih aralığı' using errcode = '22023';
  end if;
  bas_ts := p_bas::timestamp at time zone tz;
  bit_ts := (p_bit + 1)::timestamp at time zone tz;
  obas_ts := (p_bas - (p_bit - p_bas + 1))::timestamp at time zone tz;
  takip := coalesce((select (x.deger #>> '{}')::timestamptz from sistem_ayarlari x where x.anahtar = 'teslim_takip_baslangic'), 'infinity'::timestamptz);
  kayit_gun := coalesce((select (x.deger #>> '{}')::int from sistem_ayarlari x where x.anahtar = 'teslim_kayit_yok_gun'), 7);

  s := jsonb_build_object(
    'surum', 2,
    'aralik', jsonb_build_object('bas', p_bas, 'bit', p_bit, 'periyot', per,
                                 'onceki_bas', p_bas - (p_bit - p_bas + 1), 'onceki_bit', p_bas - 1),
    'ozet', public._ist_ozet(bas_ts, bit_ts) || jsonb_build_object(
              'acik', (select count(*) from istem_kalemleri where durum in ('bekleyen', 'cihazda'))),
    'onceki', public._ist_ozet(obas_ts, bas_ts),
    'gruplar', (select coalesce(jsonb_agg(jsonb_build_object('kod', g.kod, 'ad', g.ad, 'kisa_ad', g.kisa_ad, 'ekip', g.ekip,
                                                             'aktif', g.aktif, 'sira', g.sira) order by g.sira, g.kod), '[]'::jsonb)
                from test_gruplari g));

  -- Test bazında
  s := s || jsonb_build_object('testler', (
    with k as (select * from public._ist_kalem(bas_ts, bit_ts)),
         ko as (select test_key, count(*) as n from public._ist_kalem(obas_ts, bas_ts) group by test_key),
         c as (select test_key, array_agg((extract(epoch from (tamamlandi_at - created_at)) / 3600.0)::double precision) as saat
               from public._ist_tamam(bas_ts, bit_ts) group by test_key),
         g as (select k.test_key, min(k.test_ad) as ad, mode() within group (order by k.grup) as grup,
                      count(*) as kalem, count(distinct k.vaka) as vaka, count(*) filter (where k.tekrar) as tekrar
               from k group by k.test_key)
    select coalesce(jsonb_agg(jsonb_build_object(
             'key', g.test_key, 'ad', g.ad, 'grup', g.grup, 'kalem', g.kalem, 'vaka', g.vaka, 'tekrar', g.tekrar,
             'onceki', coalesce(ko.n, 0), 'sure', public._ist_dagilim(c.saat)) order by g.kalem desc, g.ad), '[]'::jsonb)
    from g left join ko on ko.test_key = g.test_key left join c on c.test_key = g.test_key));

  -- Kişi bazında: isteyen (girişi yapan) ve uzman (adına) ayrı ayrı; teslim
  -- alma oranı her görünümde yalnız o rolün kişisine sayılır.
  s := s || jsonb_build_object('kisiler', (
    with k as (select * from public._ist_kalem(bas_ts, bit_ts)),
         tsl as (select i.istem_yapan_id, i.uzman_id, (ik.teslim_at is not null) as alindi
                 from istem_kalemleri ik join istemler i on i.id = ik.istem_id
                 where ik.durum = 'tamamlandi' and ik.tamamlandi_at >= bas_ts and ik.tamamlandi_at < bit_ts
                   and ik.tamamlandi_at >= takip
                   and (ik.teslim_at is not null or ik.tamamlandi_at < now() - make_interval(days => kayit_gun))),
         r as (
           select 'isteyen' as rol, k.istem_yapan_id as uid, count(*) as kalem, count(distinct k.istem_id) as istem from k group by 2
           union all
           select 'uzman', k.uzman_id, count(*), count(distinct k.istem_id) from k group by 2),
         t as (
           select 'isteyen' as rol, istem_yapan_id as uid, count(*) filter (where alindi) as alinan, count(*) as taban from tsl group by 2
           union all
           select 'uzman', uzman_id, count(*) filter (where alindi), count(*) from tsl group by 2),
         h as (
           select coalesce(r.rol, t.rol) as rol, coalesce(r.uid, t.uid) as uid, coalesce(r.kalem, 0) as kalem,
                  coalesce(r.istem, 0) as istem, coalesce(t.alinan, 0) as alinan, coalesce(t.taban, 0) as taban
           from r full join t on t.rol = r.rol and t.uid is not distinct from r.uid)
    select jsonb_build_object(
      'isteyen', coalesce(jsonb_agg(x.j order by x.kalem desc) filter (where x.rol = 'isteyen'), '[]'::jsonb),
      'uzman', coalesce(jsonb_agg(x.j order by x.kalem desc) filter (where x.rol = 'uzman'), '[]'::jsonb))
    from (
      select h.rol, h.kalem, jsonb_build_object(
               'id', h.uid,
               'ad', case when h.uid is null then (case when h.rol = 'uzman' then '(uzman seçilmedi)' else '(bilinmiyor)' end)
                          else coalesce(u.ad_soyad, '(silinmiş kullanıcı)') end,
               'kisaltma', u.kisaltma, 'kalem', h.kalem, 'istem', h.istem,
               'teslim_alinan', h.alinan, 'teslim_taban', h.taban,
               'teslim_oran', case when h.taban > 0 then round(100.0 * h.alinan / h.taban, 0) end) as j
      from h left join kullanicilar u on u.id = h.uid) x));

  -- İş yükü: aralıktaki durum geçişleri (istem_log); kişi + ekip
  s := s || jsonb_build_object('is_yuku', (
    with l as (
      select l.degistiren_id as uid,
             count(distinct l.istem_kalem_id) filter (where l.yeni_durum = 'cihazda' and l.eski_durum is distinct from 'tamamlandi') as isleme,
             count(distinct l.istem_kalem_id) filter (where l.yeni_durum = 'tamamlandi') as tamamladi
      from istem_log l
      where l.created_at >= bas_ts and l.created_at < bit_ts and l.yeni_durum in ('cihazda', 'tamamlandi')
      group by l.degistiren_id),
    j as (select l.*, u.ad_soyad, u.kisaltma, u.rol, u.ekip from l left join kullanicilar u on u.id = l.uid)
    select jsonb_build_object(
      'kisiler', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', j.uid, 'ad', case when j.uid is null then '(sistem)' else coalesce(j.ad_soyad, '(silinmiş kullanıcı)') end,
                    'kisaltma', j.kisaltma, 'rol', j.rol, 'ekip', j.ekip, 'isleme', j.isleme, 'tamamladi', j.tamamladi)
                  order by j.tamamladi desc, j.isleme desc) from j), '[]'::jsonb),
      'ekipler', coalesce((select jsonb_agg(jsonb_build_object('ekip', e.ekip, 'kisi', e.kisi, 'isleme', e.isleme, 'tamamladi', e.tamamladi)
                  order by e.tamamladi desc) from (
                    select j.ekip, count(*) as kisi, sum(j.isleme) as isleme, sum(j.tamamladi) as tamamladi from j group by j.ekip) e), '[]'::jsonb))));

  -- Süreler (saat): aralıkta tamamlanan (kesin) kalemler
  --   bekleme: istem → İLK işleme alma; işlem: SON işleme alma → tamamlama;
  --   toplam: istem → tamamlama. Teslim: aralıkta teslim alınanlar,
  --   tamamlama → teslim (tamamlanma zamanı kesin olanlar).
  s := s || jsonb_build_object('sureler', (
    with c as (
      select t.grup, t.oncelik,
             (extract(epoch from (t.ilk_isleme - t.created_at)) / 3600.0)::double precision as bekleme,
             (extract(epoch from (t.tamamlandi_at - t.son_isleme)) / 3600.0)::double precision as islem,
             (extract(epoch from (t.tamamlandi_at - t.created_at)) / 3600.0)::double precision as toplam
      from public._ist_tamam(bas_ts, bit_ts) t),
    ts as (
      select ik.grup, coalesce(i.oncelik, 'rutin') as oncelik,
             (extract(epoch from (ik.teslim_at - ik.tamamlandi_at)) / 3600.0)::double precision as teslim
      from istem_kalemleri ik join istemler i on i.id = ik.istem_id
      where ik.teslim_at >= bas_ts and ik.teslim_at < bit_ts and ik.tamamlandi_at is not null and ik.teslim_at >= ik.tamamlandi_at
        and exists (select 1 from istem_log l where l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi')),
    satir as (
      select 'tumu'::text as boyut, ''::text as anahtar, array_agg(bekleme) as b, array_agg(islem) as i, array_agg(toplam) as t from c
      union all select 'grup', c.grup, array_agg(bekleme), array_agg(islem), array_agg(toplam) from c group by c.grup
      union all select 'oncelik', c.oncelik, array_agg(bekleme), array_agg(islem), array_agg(toplam) from c group by c.oncelik),
    tsl as (
      select 'tumu'::text as boyut, ''::text as anahtar, array_agg(teslim) as d from ts
      union all select 'grup', ts.grup, array_agg(teslim) from ts group by ts.grup
      union all select 'oncelik', ts.oncelik, array_agg(teslim) from ts group by ts.oncelik)
    select coalesce(jsonb_agg(jsonb_build_object(
             'boyut', coalesce(satir.boyut, tsl.boyut), 'anahtar', coalesce(satir.anahtar, tsl.anahtar),
             'bekleme', public._ist_dagilim(satir.b), 'islem', public._ist_dagilim(satir.i),
             'toplam', public._ist_dagilim(satir.t), 'teslim', public._ist_dagilim(tsl.d))), '[]'::jsonb)
    from satir full join tsl on tsl.boyut = satir.boyut and tsl.anahtar = satir.anahtar));

  -- Açık iş yaşlanması (şu an; aralıktan bağımsız)
  s := s || jsonb_build_object('yaslanma', (
    select coalesce(jsonb_agg(jsonb_build_object('grup', z.grup, 'd0', z.d0, 'd1', z.d1, 'd3', z.d3, 'd7', z.d7, 'd14', z.d14,
                                                 'toplam', z.toplam) order by z.toplam desc), '[]'::jsonb)
    from (
      select x.grup,
             count(*) filter (where x.g < 1) as d0, count(*) filter (where x.g >= 1 and x.g < 3) as d1,
             count(*) filter (where x.g >= 3 and x.g < 7) as d3, count(*) filter (where x.g >= 7 and x.g < 14) as d7,
             count(*) filter (where x.g >= 14) as d14, count(*) as toplam
      from (select ik.grup, extract(epoch from (now() - ik.created_at)) / 86400.0 as g
            from istem_kalemleri ik where ik.durum in ('bekleyen', 'cihazda')) x
      group by x.grup) z));

  -- Yoğunluk: haftanın günü (1 = Pzt) × saat — istenen kalem
  s := s || jsonb_build_object('yogunluk', (
    select coalesce(jsonb_agg(jsonb_build_object('g', z.g, 's', z.h, 'n', z.n)), '[]'::jsonb)
    from (select extract(isodow from k.created_at at time zone tz)::int as g,
                 extract(hour from k.created_at at time zone tz)::int as h, count(*) as n
          from public._ist_kalem(bas_ts, bit_ts) k group by 1, 2) z));

  -- Döküm (dönem başına)
  s := s || jsonb_build_object('donemler', (
    with k as (select date_trunc(per, x.created_at at time zone tz)::date as d, x.* from public._ist_kalem(bas_ts, bit_ts) x),
         c as (select date_trunc(per, x.tamamlandi_at at time zone tz)::date as d,
                      (extract(epoch from (x.tamamlandi_at - x.created_at)) / 3600.0)::double precision as saat
               from public._ist_tamam(bas_ts, bit_ts) x),
         ts as (select date_trunc(per, ik.teslim_at at time zone tz)::date as d,
                       (extract(epoch from (ik.teslim_at - ik.tamamlandi_at)) / 3600.0)::double precision as saat
                from istem_kalemleri ik
                where ik.teslim_at >= bas_ts and ik.teslim_at < bit_ts and ik.tamamlandi_at is not null and ik.teslim_at >= ik.tamamlandi_at
                  and exists (select 1 from istem_log l where l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi')),
         dn as (select generate_series(date_trunc(per, bas_ts at time zone tz), date_trunc(per, (bit_ts - interval '1 second') at time zone tz),
                                       ('1 ' || per)::interval)::date as d)
    select coalesce(jsonb_agg(jsonb_build_object(
      'd', dn.d,
      'kalem', (select count(*) from k where k.d = dn.d),
      'istem', (select count(distinct k.istem_id) from k where k.d = dn.d),
      'vaka', (select count(distinct k.vaka) from k where k.d = dn.d),
      'tekrar', (select count(*) from k where k.d = dn.d and k.tekrar),
      'tipler', (select coalesce(jsonb_object_agg(z.grup, z.n), '{}'::jsonb)
                 from (select k.grup, count(*) as n from k where k.d = dn.d group by k.grup) z),
      'tamamlanan', (select count(*) from c where c.d = dn.d),
      'ort_saat', (select round(avg(c.saat)::numeric, 1) from c where c.d = dn.d),
      'medyan_saat', (select round((percentile_cont(0.5) within group (order by c.saat))::numeric, 1) from c where c.d = dn.d),
      'teslim', (select count(*) from ts where ts.d = dn.d),
      'teslim_ort_saat', (select round(avg(ts.saat)::numeric, 1) from ts where ts.d = dn.d),
      'teslim_medyan_saat', (select round((percentile_cont(0.5) within group (order by ts.saat))::numeric, 1) from ts where ts.d = dn.d)
    ) order by dn.d), '[]'::jsonb) from dn));

  -- Teslim: şu anki sayılar (Teslim al kuralı) + aralıkta tamamlananların
  -- teslim alma oranı (sonucu belli olanlar: teslim alınan + kaydı olmayan)
  s := s || jsonb_build_object('teslim', public._ist_teslim_sayilari() || (
    select jsonb_build_object(
      'aralik_alinan', count(*) filter (where ik.teslim_at is not null),
      'aralik_kayit_yok', count(*) filter (where ik.teslim_at is null and ik.tamamlandi_at < now() - make_interval(days => kayit_gun)),
      'aralik_sonucsuz', count(*) filter (where ik.teslim_at is null and ik.tamamlandi_at >= now() - make_interval(days => kayit_gun)),
      'oran', round(100.0 * count(*) filter (where ik.teslim_at is not null)
                    / nullif(count(*) filter (where ik.teslim_at is not null or ik.tamamlandi_at < now() - make_interval(days => kayit_gun)), 0), 0))
    from istem_kalemleri ik
    where ik.durum = 'tamamlandi' and ik.tamamlandi_at >= bas_ts and ik.tamamlandi_at < bit_ts and ik.tamamlandi_at >= takip));

  return s;
end $$;
revoke all on function public.istatistik_v2(date, date, text) from public, anon;
grant execute on function public.istatistik_v2(date, date, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 7) istatistik_detay — bir teste ya da kişiye dokununca
--    p_tur 'test'    : p_anahtar = test anahtarı → dönem seyri + en çok isteyenler
--    p_tur 'isteyen' / 'uzman' : p_anahtar = kullanıcı id ('' = boş) → en çok istediği testler
-- ------------------------------------------------------------
create or replace function public.istatistik_detay(p_bas date, p_bit date, p_periyot text, p_tur text, p_anahtar text) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  tz constant text := 'Europe/Istanbul';
  per text := case p_periyot when 'month' then 'month' when 'day' then 'day' else 'week' end;
  bas_ts timestamptz;
  bit_ts timestamptz;
  kisi uuid := case when p_tur in ('isteyen', 'uzman') then nullif(p_anahtar, '')::uuid end;
begin
  if not public.istatistik_yetkili() then
    raise exception 'İstatistikleri görme yetkiniz yok' using errcode = '42501';
  end if;
  if p_bas is null or p_bit is null or p_bit < p_bas or p_bit - p_bas > 3700 then
    raise exception 'Geçersiz tarih aralığı' using errcode = '22023';
  end if;
  bas_ts := p_bas::timestamp at time zone tz;
  bit_ts := (p_bit + 1)::timestamp at time zone tz;

  if p_tur = 'test' then
    return (
      with k as (select * from public._ist_kalem(bas_ts, bit_ts) x where x.test_key = p_anahtar),
           dn as (select generate_series(date_trunc(per, bas_ts at time zone tz), date_trunc(per, (bit_ts - interval '1 second') at time zone tz),
                                         ('1 ' || per)::interval)::date as d)
      select jsonb_build_object(
        'seri', (select coalesce(jsonb_agg(jsonb_build_object('d', dn.d,
                    'kalem', (select count(*) from k where date_trunc(per, k.created_at at time zone tz)::date = dn.d)) order by dn.d), '[]'::jsonb) from dn),
        'isteyenler', (select coalesce(jsonb_agg(jsonb_build_object('id', z.uid, 'ad', coalesce(u.ad_soyad, '(bilinmiyor)'), 'kisaltma', u.kisaltma, 'kalem', z.n)
                                                 order by z.n desc), '[]'::jsonb)
                       from (select k.istem_yapan_id as uid, count(*) as n from k group by 1 order by 2 desc limit 10) z
                       left join kullanicilar u on u.id = z.uid),
        'uzmanlar', (select coalesce(jsonb_agg(jsonb_build_object('id', z.uid, 'ad', coalesce(u.ad_soyad, '(uzman seçilmedi)'), 'kisaltma', u.kisaltma, 'kalem', z.n)
                                               order by z.n desc), '[]'::jsonb)
                     from (select k.uzman_id as uid, count(*) as n from k group by 1 order by 2 desc limit 10) z
                     left join kullanicilar u on u.id = z.uid)));
  elsif p_tur in ('isteyen', 'uzman') then
    return (
      with k as (select * from public._ist_kalem(bas_ts, bit_ts) x
                 where (case when p_tur = 'isteyen' then x.istem_yapan_id else x.uzman_id end) is not distinct from kisi)
      select jsonb_build_object('testler', coalesce(jsonb_agg(jsonb_build_object('key', z.test_key, 'ad', z.ad, 'grup', z.grup, 'kalem', z.n)
                                                              order by z.n desc, z.ad), '[]'::jsonb))
      from (select k.test_key, min(k.test_ad) as ad, mode() within group (order by k.grup) as grup, count(*) as n
            from k group by k.test_key order by 4 desc limit 20) z);
  end if;
  raise exception 'Geçersiz ayrıntı türü' using errcode = '22023';
end $$;
revoke all on function public.istatistik_detay(date, date, text, text, text) from public, anon;
grant execute on function public.istatistik_detay(date, date, text, text, text) to authenticated, service_role;

-- ------------------------------------------------------------
-- 8) Toplu teslim — tek istek. Uygun olmayanlar (Tamamlandı değil, zaten
--    alınmış, takip öncesi, yetkisiz) atlanır; hata vermez.
-- ------------------------------------------------------------
create or replace function public.teslim_al_toplu(p_kalem_ids uuid[]) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  takip timestamptz;
  n_ok int;
  n_top int := coalesce(array_length(p_kalem_ids, 1), 0);
begin
  if auth.uid() is null or public.current_kullanici_id() is null then
    raise exception 'Oturum gerekli' using errcode = '42501';
  end if;
  if n_top > 500 then
    raise exception 'Bir seferde en fazla 500 kalem teslim alınabilir' using errcode = '22023';
  end if;
  takip := coalesce((select (x.deger #>> '{}')::timestamptz from sistem_ayarlari x where x.anahtar = 'teslim_takip_baslangic'), 'infinity'::timestamptz);
  with u as (
    update istem_kalemleri ik set teslim_at = now()
    where ik.id = any (p_kalem_ids) and ik.durum = 'tamamlandi' and ik.teslim_at is null
      and ik.tamamlandi_at >= takip and public.teslim_yetkisi(ik.istem_id)
    returning ik.id)
  select count(*) into n_ok from u;
  return jsonb_build_object('teslim', n_ok, 'atlanan', n_top - n_ok);
end $$;
revoke all on function public.teslim_al_toplu(uuid[]) from public, anon;
grant execute on function public.teslim_al_toplu(uuid[]) to authenticated;

commit;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- SONUÇ: bu haftanın kartları — eski kural / yeni kural — ve doldurma.
-- "Eski kural" = bu dosyadan önceki istatistik()'in hesabı (tamamlanma
-- zamanı log yoksa updated_at; teslim bekleyen yaş ayrımı yok).
-- ------------------------------------------------------------
with
a as (
  select date_trunc('week', now() at time zone 'Europe/Istanbul')::date as bas,
         (now() at time zone 'Europe/Istanbul')::date as bit,
         coalesce((select (s.deger #>> '{}')::timestamptz from sistem_ayarlari s where s.anahtar = 'teslim_takip_baslangic'), 'infinity'::timestamptz) as takip
),
yeni as (select public.istatistik_v2(a.bas, a.bit, 'week') as j from a),
eski_teslim as (
  select count(*) as n from istem_kalemleri x, a
  where x.durum = 'tamamlandi' and x.teslim_at is null
    and coalesce((select max(l.created_at) from istem_log l where l.istem_kalem_id = x.id and l.yeni_durum = 'tamamlandi'), x.updated_at) >= a.takip
),
eski_sure as (
  select count(*) as n, round(avg(s)::numeric, 1) as ort, round((percentile_cont(0.5) within group (order by s))::numeric, 1) as med
  from (select extract(epoch from (b.bitti - b.created_at)) / 3600.0 as s, b.bitti
        from (select ik.created_at, max(l.created_at) as bitti from istem_kalemleri ik
              join istem_log l on l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi'
              where ik.durum = 'tamamlandi' group by ik.id, ik.created_at) b, a
        where b.bitti >= a.bas::timestamp at time zone 'Europe/Istanbul'
          and b.bitti < (a.bit + 1)::timestamp at time zone 'Europe/Istanbul') z
),
logsuz as (
  select count(*) as n, count(*) filter (where x.tamamlandi_at >= a.takip and x.teslim_at is null) as teslimde
  from istem_kalemleri x, a
  where x.durum = 'tamamlandi'
    and not exists (select 1 from istem_log l where l.istem_kalem_id = x.id and l.yeni_durum = 'tamamlandi')
)
select v.sira, v.gosterge, v.eski_kural, v.yeni_kural from (
  select 1 as sira, 'Bu hafta' as gosterge, to_char(a.bas, 'DD.MM.YYYY') || ' – ' || to_char(a.bit, 'DD.MM.YYYY') as eski_kural, '' as yeni_kural from a
  union all select 2, 'Teslim bekliyor', (select n::text from eski_teslim),
                   (select y.j #>> '{teslim,bekliyor}' from yeni y) || ' (< ' || (select y.j #>> '{teslim,kayit_yok_gun}' from yeni y) || ' gün)'
  union all select 3, 'Teslim kaydı yok (7+ gün)', '— (ayrı sayılmıyordu)', (select y.j #>> '{teslim,kayit_yok}' from yeni y)
  union all select 4, 'Tamamlanan (bu hafta)', (select n::text from eski_sure), (select y.j #>> '{ozet,tamamlanan}' from yeni y)
  union all select 5, 'Ort. tamamlanma (saat)', (select coalesce(ort::text, '—') from eski_sure), coalesce((select y.j #>> '{ozet,ort_saat}' from yeni y), '—')
  union all select 6, 'Medyan tamamlanma (saat)', (select coalesce(med::text, '—') from eski_sure), coalesce((select y.j #>> '{ozet,medyan_saat}' from yeni y), '—')
  union all select 7, 'tamamlandi_at istem_log''dan dolduruldu', '', coalesce((select deger::text from _ist_kurulum where anahtar = 'dolduruldu'), '0')
  union all select 8, 'tamamlandi_at boş kalan (log da yok)', '',
                   (select count(*)::text from istem_kalemleri where durum = 'tamamlandi' and tamamlandi_at is null)
  union all select 9, 'Log kaydı olmayan tamamlanmış kalem (süre hesaplarına girmez)', '', (select n::text from logsuz)
  union all select 10, '  └ bunlardan Teslim al kuralına göre teslim bekleyen', '', (select teslimde::text from logsuz)
) v order by v.sira;
