-- ============================================================
-- kons_eski_sema.sql — Konsültasyon no + tamamlanma zamanı + eski açık iş eşiği
--
-- duyuru_sema.sql'den SONRA çalıştırın. İDEMPOTENT'tir (tekrar çalıştırmak
-- güvenlidir); tek seferde ya da 3 parça hâlinde çalıştırılabilir. Kod bu
-- dosyadan önce yayınlansa da bozulmaz: kons_no yoksa Konsültasyon alanı
-- görünmez; tamamlandi_at yoksa liste eski yöntemle yüklenir.
-- Son halleri bu dosyada olanlar (eski dosyalar yeniden çalıştırılırsa geri
-- almaz): istem_kuyruk_v, toplu_istem_olustur, istem_duzelt.
--
-- 1) istemler.kons_no  — dış merkez (konsültasyon) numarası, boş bırakılabilir.
--    Mevcut patoloji no değerlerine DOKUNULMAZ.
--    Tekrar İste: yeni kalem tekrar_kaynagi_id ile açılınca kaynak istemin
--    kons_no'su yeni isteme kopyalanır (tetikleyici — tekrar_iste fonksiyonları
--    değişmez). Toplu gönderim (toplu_istem_olustur) ve düzeltme (istem_duzelt,
--    iz: istem_duzeltmeleri alan = 'kons_no') kons_no'yu taşır.
-- 2) istem_kalemleri.tamamlandi_at — Tamamlandı'ya SON geçiş zamanı (tetikleyici;
--    geri alınınca boşalır). Mevcut tamamlanmışlar durum geçmişinden BİR KEZ
--    doldurulur. İş Kuyruğu "Tamamlanan: 7 / 30 / 90 gün" filtresi sunucuda bu
--    sütunla (indeksli) çalışır; açık kalemler (bekleyen, cihazda) her zaman gelir.
-- 3) sistem_ayarlari.eski_acik_gun = 14 — bundan eski açık kalemler İş
--    Kuyruğu'nda ayrı "Eski açık işler" şeridinde; yönetici değiştirir (1–365).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Konsültasyon no
-- ------------------------------------------------------------
alter table istemler add column if not exists kons_no text;
alter table istemler drop constraint if exists istemler_kons_no_chk;
alter table istemler add constraint istemler_kons_no_chk
  check (kons_no is null or length(btrim(kons_no)) between 1 and 60);

alter table istem_duzeltmeleri drop constraint if exists istem_duzeltmeleri_alan_chk;
alter table istem_duzeltmeleri add constraint istem_duzeltmeleri_alan_chk
  check (alan in ('patoloji_no', 'blok_no', 'uzman', 'oncelik', 'test', 'kons_no'));

-- Tekrar İste: kaynak istemin kons_no'su yeni isteme (yalnız boşsa).
create or replace function public.tekrar_kons_tasi() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tekrar_kaynagi_id is not null then
    update istemler y set kons_no = k.kons_no
    from istem_kalemleri kk
    join istemler k on k.id = kk.istem_id
    where kk.id = new.tekrar_kaynagi_id and y.id = new.istem_id
      and y.kons_no is null and k.kons_no is not null;
  end if;
  return null;
end $$;
drop trigger if exists istem_kalemleri_tekrar_kons on istem_kalemleri;
create trigger istem_kalemleri_tekrar_kons after insert on istem_kalemleri
  for each row execute function public.tekrar_kons_tasi();

-- ------------------------------------------------------------
-- 2) Tamamlanma zamanı (sütun + tetikleyici + bir kerelik doldurma + indeksler)
-- ------------------------------------------------------------
alter table istem_kalemleri add column if not exists tamamlandi_at timestamptz;

create or replace function public.istem_kalemleri_tamamlandi_zamani() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.durum = 'tamamlandi' then
    if tg_op = 'INSERT' or old.durum is distinct from 'tamamlandi' or new.tamamlandi_at is null then
      new.tamamlandi_at := coalesce(case when tg_op = 'UPDATE' and old.durum = 'tamamlandi' then old.tamamlandi_at end, now());
    end if;
  else
    new.tamamlandi_at := null;
  end if;
  return new;
end $$;
drop trigger if exists istem_kalemleri_tamamlandi_zamani on istem_kalemleri;
create trigger istem_kalemleri_tamamlandi_zamani before insert or update of durum on istem_kalemleri
  for each row execute function public.istem_kalemleri_tamamlandi_zamani();

-- Mevcut tamamlanmışlar: durum geçmişindeki SON "tamamlandi" (yoksa updated_at).
update istem_kalemleri ik set tamamlandi_at = coalesce(
    (select max(l.created_at) from istem_log l where l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi'),
    ik.updated_at)
where ik.durum = 'tamamlandi' and ik.tamamlandi_at is null;

create index if not exists istem_kalemleri_tamamlandi_idx on istem_kalemleri (tamamlandi_at desc) where durum = 'tamamlandi';
create index if not exists istem_kalemleri_acik_idx on istem_kalemleri (created_at) where durum in ('bekleyen', 'cihazda');
create index if not exists istem_log_tamamlandi_idx on istem_log (istem_kalem_id, created_at) where yeni_durum = 'tamamlandi';

-- ------------------------------------------------------------
-- 3) Eski açık iş eşiği (gün) — sistem_ayarlari (teslim_sema.sql)
-- ------------------------------------------------------------
alter table sistem_ayarlari drop constraint if exists sistem_ayarlari_anahtar_chk;
alter table sistem_ayarlari add constraint sistem_ayarlari_anahtar_chk
  check (anahtar in ('teslim_gecikme_saat', 'teslim_takip_baslangic', 'eski_acik_gun'));

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
  end if;
  new.guncelleyen_id := public.current_kullanici_id();
  new.updated_at := now();
  return new;
end $$;

insert into sistem_ayarlari (anahtar, deger) values ('eski_acik_gun', '14'::jsonb)
on conflict (anahtar) do nothing;

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 4) Toplu gönderim — vaka başına kons_no (toplu_sema.sql'deki + kons_no)
-- ------------------------------------------------------------
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

    insert into istemler (patoloji_no, istem_yapan_id, uzman_id, oncelik, created_at, toplu_id, toplu_sira, kons_no)
    values (v_pat, ben, nullif(v->>'uzman_id', '')::uuid, v_onc, v_zaman, v_toplu, v_sira, nullif(btrim(coalesce(v->>'kons_no', '')), ''))
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

revoke all on function public.toplu_istem_olustur(jsonb) from public, anon;
grant execute on function public.toplu_istem_olustur(jsonb) to authenticated;

-- ------------------------------------------------------------
-- 5) Düzeltme — kons_no da (test_duzeltme_sema.sql'deki + kons_no; not
--    metninde öncelik adı "Çok Acil")
-- ------------------------------------------------------------
create or replace function public.istem_duzelt(p_istem_id uuid, p_degisiklik jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  i istemler%rowtype;
  d jsonb := coalesce(p_degisiklik, '{}'::jsonb);
  yeni text;
  yeni_uzman uuid;
  uzman_eski text;
  uzman_yeni text;
  k record;
  anahtar text;
  blok_ozet jsonb := '{}'::jsonb;
  notlar text[] := '{}';
  n int := 0;
  test_degisti boolean := false;
  onc constant jsonb := '{"rutin":"Rutin","acil":"Acil","stat":"Çok Acil"}';
begin
  if ben is null then raise exception 'Oturum bulunamadı' using errcode = '42501'; end if;
  select * into i from istemler where id = p_istem_id for update;
  if not found then raise exception 'İstem bulunamadı' using errcode = 'P0002'; end if;
  if not (public.is_admin() or i.istem_yapan_id = ben) then raise exception 'Bu istemi yalnız giren kişi ya da yönetici düzeltebilir' using errcode = '42501'; end if;

  if jsonb_typeof(d->'testler') = 'array' then
    for k in
      select x.kalem_id, ik.id, ik.durum, ik.test_id as eski_id, coalesce(etk.ad, ik.ozel_test, '?') as eski_ad,
             ik.grup as eski_grup, x.test_id as yeni_id, ytk.ad as yeni_ad, ytk.grup as yeni_grup, ytk.aktif as yeni_aktif,
             (select coalesce(g.kisa_ad, g.ad, g.kod) from test_gruplari g where g.kod = ik.grup) as eski_grup_ad,
             (select coalesce(g.kisa_ad, g.ad, g.kod) from test_gruplari g where g.kod = ytk.grup) as yeni_grup_ad
      from jsonb_to_recordset(d->'testler') as x(kalem_id uuid, test_id uuid)
      left join istem_kalemleri ik on ik.id = x.kalem_id and ik.istem_id = i.id
      left join test_katalog etk on etk.id = ik.test_id
      left join test_katalog ytk on ytk.id = x.test_id
    loop
      if k.id is null then raise exception 'Kalem bu isteme ait değil' using errcode = '22023'; end if;
      if k.yeni_id is distinct from k.eski_id then
        if k.durum <> 'bekleyen' then raise exception 'Test yalnız Bekleyen kalemde düzeltilebilir — önce Bekleyen''e geri alın' using errcode = '42501'; end if;
        if k.yeni_ad is null or not k.yeni_aktif then raise exception 'Seçilen test katalogda yok ya da pasif' using errcode = '22023'; end if;
        update istem_kalemleri set test_id = k.yeni_id, ozel_test = null, grup = k.yeni_grup where id = k.id;
        insert into istem_duzeltmeleri (istem_id, kalem_id, alan, eski_deger, yeni_deger, duzelten_id)
          values (i.id, k.id, 'test', k.eski_ad, k.yeni_ad, ben);
        notlar := notlar || format('Test %s → %s düzeltildi%s', k.eski_ad, k.yeni_ad,
          case when k.yeni_grup is distinct from k.eski_grup
               then format(' (%s → %s)', coalesce(k.eski_grup_ad, k.eski_grup), coalesce(k.yeni_grup_ad, k.yeni_grup)) else '' end);
        test_degisti := true;
        n := n + 1;
      end if;
    end loop;
  end if;

  if d ? 'patoloji_no' then
    yeni := btrim(d->>'patoloji_no');
    if yeni is null or yeni = '' then raise exception 'Patoloji no boş olamaz' using errcode = '22023'; end if;
    if yeni is distinct from i.patoloji_no then
      update istemler set patoloji_no = yeni where id = i.id;
      insert into istem_duzeltmeleri (istem_id, alan, eski_deger, yeni_deger, duzelten_id)
        values (i.id, 'patoloji_no', i.patoloji_no, yeni, ben);
      notlar := notlar || format('Patoloji no %s → %s olarak düzeltildi', i.patoloji_no, yeni);
      n := n + 1;
    end if;
  end if;

  if d ? 'kons_no' then
    yeni := nullif(btrim(coalesce(d->>'kons_no', '')), '');
    if yeni is distinct from i.kons_no then
      if length(yeni) > 60 then raise exception 'Konsültasyon no en fazla 60 karakter' using errcode = '22023'; end if;
      update istemler set kons_no = yeni where id = i.id;
      insert into istem_duzeltmeleri (istem_id, alan, eski_deger, yeni_deger, duzelten_id)
        values (i.id, 'kons_no', coalesce(i.kons_no, '—'), coalesce(yeni, '—'), ben);
      notlar := notlar || format('Konsültasyon no %s → %s olarak düzeltildi', coalesce(i.kons_no, '—'), coalesce(yeni, '—'));
      n := n + 1;
    end if;
  end if;

  if d ? 'uzman_id' then
    yeni_uzman := nullif(d->>'uzman_id', '')::uuid;
    if yeni_uzman is not null and not exists (select 1 from kullanicilar where id = yeni_uzman) then raise exception 'Uzman bulunamadı' using errcode = '22023'; end if;
    if yeni_uzman is distinct from i.uzman_id then
      select ad_soyad into uzman_eski from kullanicilar where id = i.uzman_id;
      select ad_soyad into uzman_yeni from kullanicilar where id = yeni_uzman;
      update istemler set uzman_id = yeni_uzman where id = i.id;
      insert into istem_duzeltmeleri (istem_id, alan, eski_deger, yeni_deger, duzelten_id)
        values (i.id, 'uzman', coalesce(uzman_eski, '—'), coalesce(uzman_yeni, '—'), ben);
      notlar := notlar || format('Uzman adına %s → %s olarak düzeltildi', coalesce(uzman_eski, '—'), coalesce(uzman_yeni, '—'));
      n := n + 1;
    end if;
  end if;

  if d ? 'oncelik' then
    yeni := d->>'oncelik';
    if yeni is null or yeni not in ('rutin', 'acil', 'stat') then raise exception 'Geçersiz öncelik' using errcode = '22023'; end if;
    if yeni is distinct from i.oncelik then
      update istemler set oncelik = yeni where id = i.id;
      insert into istem_duzeltmeleri (istem_id, alan, eski_deger, yeni_deger, duzelten_id)
        values (i.id, 'oncelik', i.oncelik, yeni, ben);
      notlar := notlar || format('Öncelik %s → %s olarak düzeltildi', coalesce(onc->>i.oncelik, i.oncelik), onc->>yeni);
      n := n + 1;
    end if;
  end if;

  if jsonb_typeof(d->'bloklar') = 'array' then
    for k in
      select ik.id, ik.blok_no as eski, btrim(coalesce(x.blok_no, '')) as yeni, coalesce(tk.ad, ik.ozel_test, '?') as test
      from jsonb_to_recordset(d->'bloklar') as x(kalem_id uuid, blok_no text)
      join istem_kalemleri ik on ik.id = x.kalem_id and ik.istem_id = i.id
      left join test_katalog tk on tk.id = ik.test_id
    loop
      if k.yeni is distinct from k.eski then
        update istem_kalemleri set blok_no = k.yeni where id = k.id;
        insert into istem_duzeltmeleri (istem_id, kalem_id, alan, eski_deger, yeni_deger, duzelten_id)
          values (i.id, k.id, 'blok_no', k.eski, k.yeni, ben);
        anahtar := coalesce(nullif(k.eski, ''), '—') || ' → ' || coalesce(nullif(k.yeni, ''), '—');
        blok_ozet := jsonb_set(blok_ozet, array[anahtar], coalesce(blok_ozet->anahtar, '[]'::jsonb) || to_jsonb(k.test));
        n := n + 1;
      end if;
    end loop;
    for anahtar in select jsonb_object_keys(blok_ozet) loop
      notlar := notlar || format('Blok %s olarak düzeltildi (%s)', anahtar,
        (select string_agg(t, ', ') from jsonb_array_elements_text(blok_ozet->anahtar) as t));
    end loop;
  end if;

  -- Test düzeltmesi fatura özetini değiştirir: işaret kaldırılır (sekreter
  -- Hizmetler'de yeniden görür). Bayrak yalnız bu işlem içinde açık.
  if test_degisti and i.fatura_girildi then
    perform set_config('istem.test_duzeltme', 'on', true);
    update istemler set fatura_girildi = false, fatura_giren_id = null, fatura_zamani = null where id = i.id;
    perform set_config('istem.test_duzeltme', '', true);
    notlar := notlar || 'Test düzeltmesi nedeniyle fatura işareti kaldırıldı'::text;
  end if;

  insert into istem_notlari (istem_id, yazan_id, metin)
    select i.id, ben, m from unnest(notlar) as m;

  return jsonb_build_object('duzeltilen', n, 'fatura_kaldirildi', test_degisti and i.fatura_girildi);
end $$;

revoke all on function public.istem_duzelt(uuid, jsonb) from public, anon;
grant execute on function public.istem_duzelt(uuid, jsonb) to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 6) Kuyruk görünümü — duyuru_sema.sql'deki son hal; tamamlanma zamanı artık
--    istem_kalemleri.tamamlandi_at sütunundan (alt sorgu yok) + SONA kons_no.
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
  ik.tamamlandi_at,
  coalesce(ik.tamamlandi_at >= tb.baslangic, false) as teslim_takipte,
  coalesce(ik.teslim_at is null and ik.tamamlandi_at >= tb.baslangic, false) as teslim_bekliyor,
  i.created_at      as istem_created_at,
  i.toplu_id,
  i.toplu_sira,
  ik.test_id,
  i.kons_no
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join kullanicilar kesen   on kesen.id   = ik.kesen_id
left join kullanicilar cikaran on cikaran.id = ik.blok_cikaran_id
left join kullanicilar teslimci on teslimci.id = ik.teslim_alan_id
left join cihazlar c        on c.id = ik.cihaz_id
cross join (
  select coalesce(
           (select (s.deger #>> '{}')::timestamptz from sistem_ayarlari s where s.anahtar = 'teslim_takip_baslangic'),
           '-infinity'::timestamptz) as baslangic
) tb;

grant select on istem_kuyruk_v to authenticated;

commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select column_name from information_schema.columns
--     where table_name = 'istem_kuyruk_v' and column_name in ('kons_no', 'tamamlandi_at');  -- 2 satır
--   select count(*) filter (where tamamlandi_at is null) as bos from istem_kalemleri where durum = 'tamamlandi';  -- 0
--   select deger from sistem_ayarlari where anahtar = 'eski_acik_gun';  -- 14
-- ============================================================
