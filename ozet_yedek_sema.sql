-- ============================================================
-- ozet_yedek_sema.sql — haftalık / aylık özet dosyaları +
-- İstatistikler'de "Uzman Adına" dağılımı
--
-- ek_ozellikler_sema.sql'den SONRA çalıştırın. İDEMPOTENT'tir.
-- Önce Supabase panelinde "ozet-yedek" Edge Function'ını oluşturup
-- deploy edin (cron işi o fonksiyonu çağırır; fonksiyon yoksa çağrı
-- yalnızca 404 olarak loglanır, başka bir şey bozulmaz).
--
-- Zamanlama (pg_cron saatleri UTC):
--   gunluk-istem-yedek  0 23 * * *   her gece 02:00 TR   (DEĞİŞMEDİ)
--   haftalik-istem-ozet 0 2 * * 1    Pazartesi 05:00 TR  → önceki hafta (Pzt–Paz)
--   aylik-istem-ozet    0 2 1 * *    ayın 1'i 05:00 TR   → önceki ay
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) istatistik() — İstatistikler sayfası VE ozet-yedek Edge Function'ı
-- AYNI fonksiyonu kullanır (mantık tek yerde).
-- Değişenler (ek_ozellikler_sema.sql'deki sürüme göre):
--  - yetki: yönetici (uygulama) VEYA sunucu — service_role (ozet-yedek)
--    ya da postgres (SQL Editor'den elle deneme)
--  - p_periyot: 'day' de kabul edilir (haftalık özet dosyasının günlük dökümü)
--  - 'uzmanlar': uzman_id (kimin ADINA istendiği) bazında istem sayısı
-- p_bas / p_bit: Türkiye yerel TARİHLERİ (ikisi de dahil).
--  - istem / kalem / tip / kullanıcı / uzman: created_at'i aralıktaysa,
--    created_at'in dönemine sayılır
--  - tamamlanma süresi: ŞU AN Tamamlandı olan kalemlerde, Tamamlandı'ya
--    SON geçiş − kalemin created_at'i; TAMAMLANMA zamanı aralıktaysa
--    sayılır ve tamamlanma dönemine yazılır
--  - silinmiş kalemler (durum geçmişiyle birlikte silindikleri için) sayılmaz
-- ------------------------------------------------------------
create or replace function public.istatistik(p_bas date, p_bit date, p_periyot text default 'week') returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  tz constant text := 'Europe/Istanbul';
  per text := case p_periyot when 'month' then 'month' when 'day' then 'day' else 'week' end;
  bas_ts timestamptz;
  bit_ts timestamptz;
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
      'acik', (select count(*) from istem_kalemleri where durum in ('bekleyen', 'cihazda'))
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
        'medyan_saat', (select round((percentile_cont(0.5) within group (order by t.saat))::numeric, 1) from t where t.d = dn.d)
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

-- ------------------------------------------------------------
-- 2) Zamanlanmış işler — gunluk-istem-yedek ile aynı kalıp (service_role
-- anahtarı Vault'tan). Aynı adla cron.schedule mevcut işi günceller.
-- ------------------------------------------------------------
begin;

select cron.schedule(
  'haftalik-istem-ozet',
  '0 2 * * 1',
  $$
  select net.http_post(
    url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/ozet-yedek',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'istem_service_role_key'
      )
    ),
    body := '{"periyot":"hafta"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule(
  'aylik-istem-ozet',
  '0 2 1 * *',
  $$
  select net.http_post(
    url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/ozet-yedek',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'istem_service_role_key'
      )
    ),
    body := '{"periyot":"ay"}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

commit;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Elle deneme (fonksiyon deploy edildikten sonra — Pazartesi'yi beklemeden):
--   select net.http_post(
--     url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/ozet-yedek',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
--       (select decrypted_secret from vault.decrypted_secrets where name = 'istem_service_role_key')),
--     body := '{"periyot":"hafta"}'::jsonb, timeout_milliseconds := 60000);
--   -- belirli bir dönem: body := '{"periyot":"ay","bas":"2026-09-01"}'::jsonb
--   -- 10-20 sn sonra sonuç (200 = ikisi de tamam, 207 = biri başarısız):
--   select status_code, content from net._http_response order by created desc limit 1;
--
-- Doğrulama:
--   select jobname, schedule from cron.job order by jobname;   -- 3 iş
--   select public.istatistik(current_date - 7, current_date, 'day') -> 'uzmanlar';  -- SQL Editor'de artık çalışır
-- ============================================================
