-- ============================================================
-- toplu_sema.sql — Toplu istem (sepet): tek işlemde çok vaka
--
-- teslim_sema.sql'den SONRA çalıştırın. İDEMPOTENT'tir (tekrar çalıştırmak
-- güvenlidir). Kod bu dosyadan önce de yayınlanabilir: kolonlar / fonksiyon
-- yoksa "Sepete ekle" görünmez, kuyruk ve Hizmetler eski sıralamaya düşer.
-- istem_kuyruk_v'nin son hali artık duyuru_sema.sql'dedir (bu dosya yeniden
-- çalıştırılırsa onu geri almaz); teslim_sema.sql bunu geri almaz.
--
-- Toplu gönderim = toplu_istem_olustur(p_vakalar jsonb) — TEK RPC, TEK
-- işlem: ya bütün vakalar (istem + not + kalemler + durum kaydı) kaydedilir
-- ya hiçbiri. security INVOKER: mevcut RLS ekleme kuralları aynen uygulanır
-- (istem yalnız kendi adına; kalem yalnız kendi istemine; teknisyen —
-- yönetici değilse — yalnız tekrar girebilir, toplu gönderimi reddedilir).
-- Aynı gönderimin tüm istemleri aynı toplu_id'yi, aynı created_at'i ve
-- sepetteki sırayla 1, 2, 3… toplu_sira'yı alır — sıralama
-- (created_at, toplu_sira) olduğundan gönderim listede bölünmez.
-- Web Push: gönderim başına TEK bildirim (push_tetikle, aşağıda).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Kolonlar — ikisi birlikte dolu ya da birlikte boş.
-- Kullanıcıların istemler'de UPDATE izni yalnız fatura kolonlarında
-- (yetki_sema.sql) — bunlar sonradan değiştirilemez.
-- ------------------------------------------------------------
alter table istemler add column if not exists toplu_id uuid;
alter table istemler add column if not exists toplu_sira int;
alter table istemler drop constraint if exists istemler_toplu_chk;
alter table istemler add constraint istemler_toplu_chk
  check ((toplu_id is null) = (toplu_sira is null) and (toplu_sira is null or toplu_sira > 0));
create index if not exists istemler_toplu_idx on istemler (toplu_id, toplu_sira) where toplu_id is not null;

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 2) Toplu gönderim. p_vakalar: sepetteki sırayla
--   [{ patoloji_no, uzman_id, oncelik, not_metni?,
--      bloklar: ["A1", ...]  (boş dizi = tek, bloksuz),
--      testler: [{ test_id? , ozel_test?, grup }] }, ...]
-- Her vaka: istem (created_at = T, toplu_id, toplu_sira) → not (varsa) →
-- blok × test kalemleri (blok, sonra test sırasıyla; katalog testinde grup
-- katalogdan) → her kaleme "bekleyen" durum kaydı. Herhangi bir hata
-- (boş patoloji no, testsiz vaka, geçersiz öncelik, RLS reddi…) işlemin
-- TAMAMINI geri alır. Dönen: { toplu_id, istem, kalem }.
-- ------------------------------------------------------------
-- kons_eski_sema.sql çalıştıysa son hali (kons_no ile) oradadır — YENİDEN TANIMLANMAZ.
do $tf$
begin
  if exists (select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
             where ns.nspname = 'public' and p.proname = 'toplu_istem_olustur' and p.prosrc like '%kons_no%') then
    raise notice 'toplu_istem_olustur: daha yeni sürüm (kons_eski_sema.sql) kurulu — atlandı';
    return;
  end if;
  execute $sql$
create or replace function public.toplu_istem_olustur(p_vakalar jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  v_toplu uuid := gen_random_uuid();
  v_zaman timestamptz := now();
  v jsonb;
  v_sira int;
  v_istem uuid;
  v_pat text;
  v_onc text;
  v_not text;
  v_bloklar jsonb;
  n_istem int := 0;
  n_kalem int := 0;
  n int;
begin
  if ben is null then
    raise exception 'Oturum bulunamadı' using errcode = '42501';
  end if;
  if jsonb_typeof(p_vakalar) <> 'array' or jsonb_array_length(p_vakalar) = 0 then
    raise exception 'Gönderilecek vaka yok' using errcode = '22023';
  end if;
  if jsonb_array_length(p_vakalar) > 300 then
    raise exception 'Bir toplu gönderimde en fazla 300 vaka olabilir' using errcode = '22023';
  end if;

  for v, v_sira in select x.value, x.ordinality::int from jsonb_array_elements(p_vakalar) with ordinality as x
  loop
    v_pat := btrim(coalesce(v->>'patoloji_no', ''));
    if v_pat = '' then
      raise exception '%. vakada patoloji no boş', v_sira using errcode = '22023';
    end if;
    v_onc := coalesce(nullif(v->>'oncelik', ''), 'rutin');
    if v_onc not in ('rutin', 'acil', 'stat') then
      raise exception '% için geçersiz öncelik', v_pat using errcode = '22023';
    end if;
    if jsonb_typeof(v->'testler') <> 'array' or jsonb_array_length(v->'testler') = 0 then
      raise exception '% için test seçilmemiş', v_pat using errcode = '22023';
    end if;
    v_bloklar := case when jsonb_typeof(v->'bloklar') = 'array' and jsonb_array_length(v->'bloklar') > 0
                      then v->'bloklar' else '[""]'::jsonb end;

    insert into istemler (patoloji_no, istem_yapan_id, uzman_id, oncelik, created_at, toplu_id, toplu_sira)
    values (v_pat, ben, nullif(v->>'uzman_id', '')::uuid, v_onc, v_zaman, v_toplu, v_sira)
    returning id into v_istem;
    n_istem := n_istem + 1;

    v_not := nullif(btrim(coalesce(v->>'not_metni', '')), '');
    if v_not is not null then
      insert into istem_notlari (istem_id, yazan_id, metin) values (v_istem, ben, v_not);
    end if;

    with yeni as (
      insert into istem_kalemleri (istem_id, blok_no, test_id, ozel_test, grup)
      select v_istem, btrim(coalesce(b.value #>> '{}', '')),
             nullif(t.value->>'test_id', '')::uuid,
             nullif(btrim(coalesce(t.value->>'ozel_test', '')), ''),
             coalesce(tk.grup, t.value->>'grup')
      from jsonb_array_elements(v_bloklar) with ordinality as b(value, bs)
      cross join jsonb_array_elements(v->'testler') with ordinality as t(value, ts)
      left join test_katalog tk on tk.id = nullif(t.value->>'test_id', '')::uuid
      order by b.bs, t.ts
      returning id
    ), kayit as (
      insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
      select id, null, 'bekleyen', ben from yeni
      returning 1
    )
    select count(*) into n from kayit;
    n_kalem := n_kalem + n;
  end loop;

  return jsonb_build_object('toplu_id', v_toplu, 'istem', n_istem, 'kalem', n_kalem);
end $$;
$sql$;
end $tf$;

revoke all on function public.toplu_istem_olustur(jsonb) from public, anon;
grant execute on function public.toplu_istem_olustur(jsonb) to authenticated;

-- ------------------------------------------------------------
-- 3) Web Push — gönderim başına TEK bildirim. push_sema.sql kuruluysa
-- (push_gonderimleri varsa) uygulanır, değilse atlanır.
-- push_gonderimleri.toplu_id benzersiz: toplu gönderimin İLK kalemi
-- satırı yazar ve push-gonder'e {istem_id, toplu_id} gider; aynı
-- gönderimin diğer kalemleri (aynı istem → istem_id, başka istem →
-- toplu_id çakışması) hiçbir şey yapmaz. Tek istemler eskisi gibi.
-- pg_net isteği işlem kesinleştikten SONRA gider; geri alınırsa hiç gitmez.
-- ------------------------------------------------------------
do $push$
begin
  if to_regclass('public.push_gonderimleri') is null then
    raise notice 'push_gonderimleri yok — Web Push kısmı atlandı (push_sema.sql kurulu değil)';
    return;
  end if;

  alter table push_gonderimleri add column if not exists toplu_id uuid;
  create unique index if not exists push_gonderimleri_toplu_uniq on push_gonderimleri (toplu_id) where toplu_id is not null;

  execute $fn$
create or replace function public.push_tetikle() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_toplu uuid;
begin
  if not exists (select 1 from push_abonelikleri) then
    return null;
  end if;
  select toplu_id into v_toplu from istemler where id = new.istem_id;
  insert into push_gonderimleri (istem_id, toplu_id) values (new.istem_id, v_toplu) on conflict do nothing;
  if found then
    perform net.http_post(
      url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/push-gonder',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'istem_service_role_key'
        )
      ),
      body := case when v_toplu is null then jsonb_build_object('istem_id', new.istem_id)
                   else jsonb_build_object('istem_id', new.istem_id, 'toplu_id', v_toplu) end,
      timeout_milliseconds := 30000
    );
  end if;
  return null;
exception when others then
  raise warning 'push_tetikle (istem %): %', new.istem_id, sqlerrm;
  return null;
end $$;
  $fn$;
end $push$;

commit;

notify pgrst, 'reload schema';

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 4) Kuyruk görünümü — teslim_sema.sql'deki son hal + SONA eklenenler:
--   istem_created_at (istemin zamanı — toplu gönderimde hepsinde aynı),
--   toplu_id, toplu_sira. İş Kuyruğu bu sırayla sıralar:
--   istem_created_at ↓ → toplu_id → toplu_sira ↑ → istem → kalem zamanı.
-- ------------------------------------------------------------
-- duyuru_sema.sql çalıştıysa görünümün son hali (test_id ile) oradadır —
-- o durumda burada YENİDEN TANIMLANMAZ.
do $vw$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'istem_kuyruk_v' and column_name = 'test_id'
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
  i.toplu_sira
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
  end if;
end $vw$;

grant select on istem_kuyruk_v to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select column_name from information_schema.columns
--     where table_name = 'istemler' and column_name in ('toplu_id', 'toplu_sira');           -- 2 satır
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name in ('istem_created_at', 'toplu_id', 'toplu_sira');  -- 3 satır
--   select proname, prosecdef from pg_proc where proname = 'toplu_istem_olustur';      -- prosecdef = false (invoker)
-- Son toplu gönderimler:
--   select toplu_id, min(created_at) as zaman, count(*) as vaka, string_agg(patoloji_no, ', ' order by toplu_sira)
--     from istemler where toplu_id is not null group by toplu_id order by zaman desc limit 10;
-- ============================================================
