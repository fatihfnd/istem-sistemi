-- ============================================================
-- performans_sema.sql — İş Kuyruğu yükünü azaltma
--
-- kons_eski_sema.sql'den SONRA çalıştırın. İDEMPOTENT'tir (tekrar
-- çalıştırmak güvenlidir); tek seferde ya da 3 parça hâlinde
-- çalıştırılabilir. Uygulama bu dosyadan ÖNCE de SONRA da yayınlansa
-- bozulmaz: görünüm / fonksiyon yoksa eski sorgulara ve tablo dinlemeye
-- düşer.
--
-- 1) İndeksler — aynı sütunla başlayan bir indeks zaten varsa atlanır.
-- 2) istem_liste_v — İş Kuyruğu listesi için İNCE görünüm: yalnız ekranda
--    gereken sütunlar; isimler yerine kişi kimlikleri (uygulama adları
--    oturum başında bir kez çektiği kullanıcı listesinden tamamlar); tüm
--    notlar yerine not sayısı + son not. Detay paneli, Excel ve yedek tam
--    görünümü (istem_kuyruk_v) kullanmaya devam eder — o değişmez.
--    kuyruk_getir(...) — listenin TEK isteklik yükü (sıkıştırılmış: sütun
--    adları bir kez); canlı güncellemede yalnız değişen kalemler; arama
--    kutusu için tarih sınırı olmadan tüm kayıtlarda arama.
-- 3) Canlı yayın — istem / kalem / not / yazdırma / duyuru / set / cihaz /
--    ayar / kullanıcı değişiklikleri tetikleyiciyle TEK özel kanala
--    ("istem-canli") gönderilir. Yükte YALNIZ tablo adı, olay türü ve
--    kimlik(ler) vardır — patoloji no, isim, not metni GÖNDERİLMEZ.
--    Dinleme izni (realtime.messages RLS): yalnız oturum açmış, aktif
--    kullanıcı, yalnız bu kanal. Sunucuda realtime.send yoksa bu kısım
--    atlanır; uygulama tablo dinlemeyle (yedek) çalışır.
--    Tabloları supabase_realtime yayınından çıkarmak AYRI dosyadadır:
--    realtime_yayin_kaldir_sema.sql (yayın kanalı bir hafta sorunsuz
--    çalıştıktan sonra).
-- ============================================================

do $on$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'istemler' and column_name = 'kons_no')
     or not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'istem_kalemleri' and column_name = 'tamamlandi_at') then
    raise exception 'Önce kons_eski_sema.sql çalıştırılmalı (istemler.kons_no / istem_kalemleri.tamamlandi_at yok)';
  end if;
end $on$;

begin;

-- ------------------------------------------------------------
-- 1) İndeksler (aynı sütunla başlayan indeks varsa yenisi açılmaz)
-- ------------------------------------------------------------
do $ix$
declare
  r record;
begin
  for r in select * from (values
      ('istemler', 'created_at', 'istemler_created_at_idx'),
      ('istemler', 'patoloji_no', 'istemler_patoloji_no_idx'),
      ('istem_kalemleri', 'istem_id', 'istem_kalemleri_istem_id_idx'),
      ('istem_kalemleri', 'durum', 'istem_kalemleri_durum_idx'),
      ('istem_kalemleri', 'created_at', 'istem_kalemleri_created_at_idx'),
      ('istem_kalemleri', 'tamamlandi_at', 'istem_kalemleri_tamamlandi_at_idx'),
      ('istem_kalemleri', 'teslim_at', 'istem_kalemleri_teslim_at_idx2'),
      ('istem_kalemleri', 'kesildi_at', 'istem_kalemleri_kesildi_at_idx'),
      ('istem_notlari', 'istem_id', 'istem_notlari_istem_id_idx'),
      ('yazdirma_kayitlari', 'kalem_id', 'yazdirma_kayitlari_kalem_id_idx'),
      ('istem_duzeltmeleri', 'istem_id', 'istem_duzeltmeleri_istem_id_idx')
    ) as t(tablo, kolon, ad)
  loop
    if to_regclass('public.' || r.tablo) is null then continue; end if;
    if not exists (
      select 1
      from pg_index x
      join pg_class c on c.oid = x.indrelid
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = x.indkey[0]
      where n.nspname = 'public' and c.relname = r.tablo and a.attname = r.kolon
    ) then
      execute format('create index if not exists %I on public.%I (%I)', r.ad, r.tablo, r.kolon);
      raise notice 'indeks eklendi: %(%)', r.tablo, r.kolon;
    end if;
  end loop;
end $ix$;

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 2) İnce liste görünümü + arama
-- ------------------------------------------------------------
create or replace view istem_liste_v
with (security_invoker = true) as
select
  ik.id              as kalem_id,
  ik.istem_id,
  ik.blok_no,
  coalesce(tk.ad, ik.ozel_test) as test_adi,
  tk.klon,
  tk.kontrol,
  ik.grup,
  ik.test_id,
  i.patoloji_no,
  i.kons_no,
  i.oncelik,
  ik.durum,
  ik.created_at,
  i.created_at       as istem_created_at,
  i.toplu_id,
  i.toplu_sira,
  i.istem_yapan_id,
  i.uzman_id,
  ik.cihaz_id,
  ik.tekrar_kaynagi_id,
  ik.kesildi_at,
  ik.kesen_id,
  ik.blok_cikarildi_at,
  ik.blok_cikaran_id,
  ik.teslim_at,
  ik.teslim_alan_id,
  ik.tamamlandi_at,
  coalesce(ik.tamamlandi_at >= tb.baslangic, false) as teslim_takipte,
  coalesce(ik.teslim_at is null and ik.tamamlandi_at >= tb.baslangic, false) as teslim_bekliyor,
  (select count(*)::int from istem_notlari n where n.istem_id = ik.istem_id) as not_sayisi,
  (select jsonb_build_object('metin', n.metin, 'yazan_id', n.yazan_id, 'zaman', n.created_at)
     from istem_notlari n where n.istem_id = ik.istem_id
     order by n.created_at desc limit 1) as son_not,
  (select jsonb_object_agg(s.baglam, jsonb_build_object('zaman', s.created_at, 'kim_id', s.yazdiran_id))
     from (
       select distinct on (yz.baglam) yz.baglam, yz.created_at, yz.yazdiran_id
       from yazdirma_kayitlari yz
       where yz.kalem_id = ik.id
       order by yz.baglam, yz.created_at desc
     ) s) as yazdirmalar,
  (select jsonb_object_agg(dz.alan, jsonb_build_object(
            'eski', dz.ilk_eski, 'kim_id', dz.son_kim, 'zaman', dz.son_zaman, 'adet', dz.adet))
     from (
       select x.alan,
              (array_agg(x.eski_deger order by x.created_at))[1]       as ilk_eski,
              (array_agg(x.duzelten_id order by x.created_at desc))[1] as son_kim,
              max(x.created_at) as son_zaman,
              count(*)          as adet
       from istem_duzeltmeleri x
       where x.istem_id = ik.istem_id and (x.kalem_id is null or x.kalem_id = ik.id)
       group by x.alan
     ) dz) as duzeltmeler,
  (select array_agg(distinct x.eski_deger)
     from istem_duzeltmeleri x
     where x.istem_id = ik.istem_id and x.alan = 'patoloji_no') as eski_patoloji_nolar
from istem_kalemleri ik
join istemler i           on i.id = ik.istem_id
left join test_katalog tk on tk.id = ik.test_id
cross join (
  select coalesce(
           (select (s.deger #>> '{}')::timestamptz from sistem_ayarlari s where s.anahtar = 'teslim_takip_baslangic'),
           '-infinity'::timestamptz) as baslangic
) tb;

revoke all on istem_liste_v from anon;
grant select on istem_liste_v to authenticated;

-- kuyruk_getir — İş Kuyruğu'nun TEK isteklik yükü. Satırlar sıkıştırılmış
-- döner: sütun adları bir kez ("k"), her satır bir dizi ("s"). Üç kip:
--  * Normal: açık kalemler (bekleyen, cihazda) tarih sınırı OLMADAN hepsi +
--    tamamlananlar: tamamlanma zamanı son p_tamamlanan_gun günde olanlar
--    (0 = tümü), en yeniden, en fazla p_limit (0 = sınırsız; fazlası varsa
--    "daha": true) + pencere dışında da olsa teslim bekleyenler ve son
--    p_kesildi_gun günde kesilenler. "eski": pencere dışında kalan
--    (yüklenmeyen) tamamlanan sayısı.
--  * Kimlikle (p_kalem_ids / p_istem_ids): yalnız o kalemler / istemlerin
--    kalemleri — canlı güncellemede değişen satırlar.
--  * Arama (p_ara): tarih sınırı YOK; patoloji no (boşluklar yok sayılır),
--    düzeltme öncesi patoloji no, konsültasyon no ya da blokta geçenler,
--    en yeni p_limit (en fazla 1000).
-- Sıra: istemin zamanı ↓ → toplu gönderim → istem → kalem zamanı ↓.
-- Yetki: çağıranın RLS'i (security invoker; görünüm de security_invoker).
create or replace function public.kuyruk_getir(
  p_tamamlanan_gun int default 7,
  p_limit int default 200,
  p_kesildi_gun int default 7,
  p_kalem_ids uuid[] default null,
  p_istem_ids uuid[] default null,
  p_ara text default null
) returns jsonb
language sql stable security invoker set search_path = public as $$
  with ayar as (
    select case when coalesce(p_tamamlanan_gun, 0) > 0 then now() - make_interval(days => p_tamamlanan_gun) end as sinir,
           now() - make_interval(days => greatest(coalesce(p_kesildi_gun, 7), 0)) as kesildi_sinir,
           nullif(btrim(coalesce(p_ara, '')), '') as ara,
           (p_kalem_ids is not null or p_istem_ids is not null) as kimlikle
  ), q as (
    select '%' || replace(replace(replace(ara, '\', '\\'), '%', '\%'), '_', '\_') || '%' as d,
           '%' || replace(replace(replace(regexp_replace(ara, '\s', '', 'g'), '\', '\\'), '%', '\%'), '_', '\_') || '%' as b
    from ayar where ara is not null
  ), eslesen as (
    select ik.id
    from istem_kalemleri ik join istemler i on i.id = ik.istem_id, q
    where i.patoloji_no ilike q.d or regexp_replace(i.patoloji_no, '\s', '', 'g') ilike q.b
       or i.kons_no ilike q.d or ik.blok_no ilike q.d
    union
    select ik.id
    from istem_duzeltmeleri x join istem_kalemleri ik on ik.istem_id = x.istem_id, q
    where x.alan = 'patoloji_no' and regexp_replace(x.eski_deger, '\s', '', 'g') ilike q.b
  ), tamam as (
    select v.kalem_id
    from istem_liste_v v, ayar
    where not ayar.kimlikle and ayar.ara is null and v.durum = 'tamamlandi'
      and (ayar.sinir is null or v.tamamlandi_at >= ayar.sinir)
    order by v.tamamlandi_at desc nulls last, v.kalem_id
    limit case when coalesce(p_limit, 0) > 0 then p_limit + 1 end
  ), secilen as (
    select v.kalem_id from istem_liste_v v, ayar
    where ayar.kimlikle and (v.kalem_id = any (coalesce(p_kalem_ids, '{}')) or v.istem_id = any (coalesce(p_istem_ids, '{}')))
    union
    select v.kalem_id from istem_liste_v v, ayar
    where not ayar.kimlikle and ayar.ara is null
      and (v.durum in ('bekleyen', 'cihazda')
           or (v.durum = 'tamamlandi' and (v.teslim_bekliyor or v.kesildi_at >= ayar.kesildi_sinir)))
    union
    select t.kalem_id from (select kalem_id from tamam limit case when coalesce(p_limit, 0) > 0 then p_limit end) t
    union
    select e.id from (
      select v.kalem_id as id from istem_liste_v v
      where v.kalem_id in (select id from eslesen)
      order by v.created_at desc, v.kalem_id
      limit least(greatest(coalesce(nullif(p_limit, 0), 300), 1), 1000)
    ) e
  ), satir as (
    select v.* from istem_liste_v v where v.kalem_id in (select kalem_id from secilen)
  )
  select jsonb_build_object(
    'k', array['kalem_id', 'istem_id', 'blok_no', 'test_adi', 'klon', 'kontrol', 'grup', 'test_id', 'patoloji_no', 'kons_no',
               'oncelik', 'durum', 'created_at', 'istem_created_at', 'toplu_id', 'toplu_sira', 'istem_yapan_id', 'uzman_id',
               'cihaz_id', 'tekrar_kaynagi_id', 'kesildi_at', 'kesen_id', 'blok_cikarildi_at', 'blok_cikaran_id', 'teslim_at',
               'teslim_alan_id', 'tamamlandi_at', 'teslim_takipte', 'teslim_bekliyor', 'not_sayisi', 'son_not', 'yazdirmalar',
               'duzeltmeler', 'eski_patoloji_nolar'],
    's', coalesce((
      select jsonb_agg(jsonb_build_array(
               r.kalem_id, r.istem_id, r.blok_no, r.test_adi, r.klon, r.kontrol, r.grup, r.test_id, r.patoloji_no, r.kons_no,
               r.oncelik, r.durum, r.created_at, r.istem_created_at, r.toplu_id, r.toplu_sira, r.istem_yapan_id, r.uzman_id,
               r.cihaz_id, r.tekrar_kaynagi_id, r.kesildi_at, r.kesen_id, r.blok_cikarildi_at, r.blok_cikaran_id, r.teslim_at,
               r.teslim_alan_id, r.tamamlandi_at, r.teslim_takipte, r.teslim_bekliyor, r.not_sayisi, r.son_not, r.yazdirmalar,
               r.duzeltmeler, r.eski_patoloji_nolar)
             order by r.istem_created_at desc, r.toplu_id nulls last, r.toplu_sira nulls last, r.istem_id, r.created_at desc, r.kalem_id)
      from satir r), '[]'::jsonb),
    'daha', coalesce(p_limit, 0) > 0 and (select count(*) from tamam) > p_limit,
    'eski', case when not ayar.kimlikle and ayar.ara is null and ayar.sinir is not null then (
              select count(*) from istem_kalemleri ik
              where ik.durum = 'tamamlandi' and ik.tamamlandi_at < ayar.sinir
                and not (ik.teslim_at is null and ik.tamamlandi_at >= (
                  select coalesce((select (s.deger #>> '{}')::timestamptz from sistem_ayarlari s where s.anahtar = 'teslim_takip_baslangic'),
                                  '-infinity'::timestamptz))))
            end
  )
  from ayar
$$;

revoke all on function public.kuyruk_getir(int, int, int, uuid[], uuid[], text) from public, anon;
grant execute on function public.kuyruk_getir(int, int, int, uuid[], uuid[], text) to authenticated;
drop function if exists public.kuyruk_ara(text, int);

commit;

notify pgrst, 'reload schema';

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 3) Canlı yayın: tetikleyici → realtime.send → özel kanal "istem-canli"
--    Yük örnekleri (yalnız kimlik + olay türü):
--      {"t":"istem_kalemleri","o":"UPDATE","k":"<kalem id>","i":"<istem id>"}
--      {"t":"istem_notlari","o":"INSERT","i":"<istem id>"}
--      {"t":"duyurular","o":"UPDATE","id":"<duyuru id>"}
-- ------------------------------------------------------------
do $cy$
declare
  tablo text;
begin
  if to_regclass('realtime.messages') is null
     or to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    raise notice 'realtime.send bulunamadı — canlı yayın kurulmadı; uygulama tablo dinlemeyle (yedek) çalışır';
    return;
  end if;

  execute $fn$
create or replace function public.canli_yayin_tetik() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
  yuk jsonb;
begin
  if tg_op = 'DELETE' then v := to_jsonb(old); else v := to_jsonb(new); end if;
  yuk := jsonb_build_object('t', tg_table_name, 'o', tg_op);
  if tg_table_name = 'istem_kalemleri' then
    yuk := yuk || jsonb_build_object('k', v->'id', 'i', v->'istem_id');
  elsif tg_table_name = 'istem_notlari' then
    yuk := yuk || jsonb_build_object('i', v->'istem_id');
  elsif tg_table_name = 'yazdirma_kayitlari' then
    yuk := yuk || jsonb_build_object('k', v->'kalem_id');
  elsif tg_table_name = 'duyuru_guncellemeleri' then
    yuk := yuk || jsonb_build_object('id', v->'duyuru_id');
  elsif tg_table_name = 'istek_seti_kalemleri' then
    yuk := yuk || jsonb_build_object('id', v->'istek_seti_id');
  elsif tg_table_name = 'sistem_ayarlari' then
    yuk := yuk || jsonb_build_object('id', v->'anahtar');
  else
    yuk := yuk || jsonb_build_object('id', v->'id');
  end if;
  perform realtime.send(yuk, 'degisiklik', 'istem-canli', true);
  return null;
exception when others then
  -- Yayın hatası asıl işlemi ASLA bozmaz (ekranlar 5 dk'lık senkronla düzelir).
  raise warning 'canli_yayin_tetik (%): %', tg_table_name, sqlerrm;
  return null;
end $$;
  $fn$;
  execute 'revoke all on function public.canli_yayin_tetik() from public, anon, authenticated';

  foreach tablo in array array['istem_kalemleri', 'istemler', 'istem_notlari', 'yazdirma_kayitlari',
                               'duyurular', 'duyuru_guncellemeleri', 'istek_setleri', 'istek_seti_kalemleri',
                               'cihazlar', 'sistem_ayarlari', 'kullanicilar']
  loop
    if to_regclass('public.' || tablo) is null then continue; end if;
    execute format('drop trigger if exists %I on public.%I', tablo || '_canli_yayin', tablo);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.canli_yayin_tetik()',
                   tablo || '_canli_yayin', tablo);
  end loop;

  -- Dinleme izni: oturum açmış, aktif kullanıcı; yalnız bu kanal, yalnız yayın.
  execute 'drop policy if exists istem_canli_dinle on realtime.messages';
  execute $pol$
create policy istem_canli_dinle on realtime.messages
  for select to authenticated
  using (realtime.topic() = 'istem-canli'
         and realtime.messages.extension in ('broadcast')
         and (select public.current_kullanici_id()) is not null)
  $pol$;
end $cy$;

-- Uygulamanın açılışta okuduğu özellik bilgisi (hangi parçalar kurulu).
create or replace function public.istem_ozellikler() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'surum', 1,
    'liste_v', to_regclass('public.istem_liste_v') is not null,
    'getir', to_regprocedure('public.kuyruk_getir(integer,integer,integer,uuid[],uuid[],text)') is not null,
    'canli_yayin', exists (select 1 from pg_trigger
                           where tgname = 'istem_kalemleri_canli_yayin' and not tgisinternal)
  )
$$;
revoke all on function public.istem_ozellikler() from public, anon;
grant execute on function public.istem_ozellikler() to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select public.istem_ozellikler();
--     -- {"getir": true, "surum": 1, "liste_v": true, "canli_yayin": true}
--   select jsonb_array_length(public.kuyruk_getir() -> 's');              -- açık + son 7 gün
--   select count(*) from istem_liste_v;                                   -- kalem sayısı
--   select tgname from pg_trigger where tgname like '%_canli_yayin';       -- 11 satır
--   select policyname from pg_policies where tablename = 'messages';       -- istem_canli_dinle + istem_yaziyor_*
-- ============================================================
