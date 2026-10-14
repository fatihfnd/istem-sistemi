-- ============================================================
-- test_duzeltme_sema.sql — düzeltmeye "test" alanı
--
-- duzeltme_sema.sql'den SONRA, YENİ KOD DEPLOY EDİLMEDEN ÖNCE çalıştırın.
-- İDEMPOTENT'tir. istem_duzelt'in ve fatura tetikleyicisinin son hali
-- buradadır; duzeltme_sema.sql yeniden çalıştırılırsa istem_duzelt'i geri
-- almaz (son hali kuruluysa atlar), arsiv_yazdirma_sema.sql'deki fatura
-- tetikleyicisi de bununla aynıdır.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) istem_duzeltmeleri.alan'a 'test' — kısıt adı TAHMİN EDİLMEZ: alan
-- üzerindeki CHECK kısıt(lar)ı katalogdan bulunup kaldırılır, adlı kısıt
-- yeniden eklenir. (Satır güncellemez; değiştirilemezlik tetikleyicisi
-- etkilenmez.)
-- ------------------------------------------------------------
do $c$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.istem_duzeltmeleri'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%alan%'
  loop
    execute format('alter table public.istem_duzeltmeleri drop constraint %I', r.conname);
  end loop;
end $c$;
alter table istem_duzeltmeleri add constraint istem_duzeltmeleri_alan_chk
  check (alan in ('patoloji_no', 'blok_no', 'uzman', 'oncelik', 'test'));

-- ------------------------------------------------------------
-- 2) Test YALNIZ Bekleyen kalemde değişir — fonksiyondan bağımsız olarak
-- veritabanında: test_id / ozel_test / grup değişen her güncellemede kalem
-- Bekleyen değilse hata (uygulama kullanıcıları, yönetici dahil; SQL
-- Editor bakımı — auth.uid() boş — muaf).
-- ------------------------------------------------------------
create or replace function public.istem_kalemleri_test_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null
     and (new.test_id is distinct from old.test_id
          or new.ozel_test is distinct from old.ozel_test
          or new.grup is distinct from old.grup)
     and old.durum <> 'bekleyen'
  then
    raise exception 'Test yalnız Bekleyen kalemde düzeltilebilir — önce Bekleyen''e geri alın' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists istem_kalemleri_test_kontrol on istem_kalemleri;
create trigger istem_kalemleri_test_kontrol
  before update of test_id, ozel_test, grup on istem_kalemleri
  for each row execute function public.istem_kalemleri_test_kontrol();

-- ------------------------------------------------------------
-- 3) Fatura girişi: geri alma YALNIZ işaretleyen kişi ve yönetici — İSTİSNA:
-- test düzeltmesi (istem_duzelt içinde, yalnız o işlem süresince açılan
-- istem.test_duzeltme bayrağıyla) işareti kim girmiş olursa olsun kaldırır.
-- Her giriş ve geri alma fatura_gecmisi'ne yazılır. auth.uid() boşsa (SQL
-- Editor) yetki kontrolü yapılmaz, kayıt yine düşer.
-- ------------------------------------------------------------
create or replace function public.istemler_fatura_kaydi() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
begin
  if new.fatura_girildi is not distinct from old.fatura_girildi then
    return new;
  end if;
  if old.fatura_girildi and not coalesce(new.fatura_girildi, false) and auth.uid() is not null
     and coalesce(current_setting('istem.test_duzeltme', true), '') <> 'on'
     and not (public.is_admin() or old.fatura_giren_id = ben) then
    raise exception 'Bu fatura girişini yalnız işaretleyen kişi ya da yönetici geri alabilir' using errcode = '42501';
  end if;
  insert into fatura_gecmisi (istem_id, islem, kullanici_id)
  values (new.id, case when coalesce(new.fatura_girildi, false) then 'girildi' else 'geri_alindi' end, ben);
  return new;
end $$;

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 4) Düzeltme — tek transaction; yetki: istemi giren kişi ya da yönetici.
-- p_degisiklik: { patoloji_no?, uzman_id?, oncelik?, bloklar?: [{kalem_id,
-- blok_no}], testler?: [{kalem_id, test_id}] } — test yalnız Bekleyen kalemde.
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
  onc constant jsonb := '{"rutin":"Rutin","acil":"Acil","stat":"STAT"}';
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

commit;

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;
revoke all on function public.istem_duzelt(uuid, jsonb) from public, anon;
grant execute on function public.istem_duzelt(uuid, jsonb) to authenticated;
commit;

notify pgrst, 'reload schema';

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- Doğrulama:
--   select pg_get_constraintdef(oid) from pg_constraint
--     where conrelid = 'public.istem_duzeltmeleri'::regclass and conname = 'istem_duzeltmeleri_alan_chk';  -- ... 'test'
--   select tgname from pg_trigger where tgname = 'istem_kalemleri_test_kontrol';  -- 1 satır
-- ============================================================
