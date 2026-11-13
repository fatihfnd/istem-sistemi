-- ============================================================
-- katalog_stok_kromojen_sema.sql — yalnız katalog (serbest metin kalkar),
-- kataloğa ekleme talepleri, eşleşmemiş eski kayıtlar, kırmızı kromojen,
-- stokta yok / geldi, grup değiştirme + gruplar arası birleştirme, test silme
--
-- istatistik_teslim_sema.sql'den SONRA çalıştırın (yetki_katalog_sema.sql
-- kurulu olmalı). İDEMPOTENT'tir; tek seferde ya da 3 parça.
-- SIRA: önce uygulama (Netlify), sonra bu dosya, sonra push-gonder ve
-- daily-backup. Uygulama katalog_talepleri tablosunu görünce serbest metni
-- kapatır; SQL'den önce bugünkü gibi çalışır.
-- GERİ ALMA: katalog_stok_kromojen_geri_al.sql (aşağıdaki yedek tablolardan).
--
-- 0) YEDEK: değişecek tabloların şema içi kopyaları (varsa atlanır):
--    yedek_20261113_istem_kalemleri, _test_katalog, _sablon_kalemleri,
--    _istek_seti_kalemleri.
-- 1) Yeni kalemde test_id zorunlu, test katalogda aktif (eski kayıtlar
--    etkilenmez); set / şablona serbest metin eklenemez.
-- 2) katalog_talepleri: "Kataloğa eklenmesini iste"; katalog düzenleme
--    yetkilisi Ekle / Var: X (eş ad) / Reddet der; iki yönde bildirim.
-- 3) Eşleşmemiş eski kayıtlar: serbest metinli kalemler metne göre
--    gruplanır, bir katalog testine bağlanır (test_id dolar, ozel_test kalır,
--    kalemin grubu testin grubuna geçer).
-- 4) istem_kalemleri.kromojen 'dab' | 'kirmizi' — kırmızı YALNIZ İHK
--    (grup kodu 'ihc'); düzeltme izli (kalem_kromojen_duzelt).
-- 5) test_katalog.stok 'var' | 'yok' (+ başlangıç, açıklama): Tükendi →
--    kritik duyuru + bildirim; Geldi → duyuru çözülür, "tekrar mevcut"
--    duyurusu, bekleyen kalemi olan isteyenlere ek bildirim.
-- 6) Grup değişince o testin TÜM istem kalemleri yeni gruba geçer;
--    birleştirme farklı gruplar arasında (kalacak grup seçilir); "Diğer"
--    grubunda aktif test kalmayınca grup pasife alınır.
-- 7) Test silme: hiç kullanılmamışsa kalıcı (tüm alanları + geçmişi
--    test_katalog_silinen'e yazılır, geri yüklenebilir); kullanılmışsa silinmez.
-- SON SORGU: yedekler, eşleşmemiş eski kayıtlar, Diğer grubu, GMS eş adı.
-- ============================================================

do $on$
begin
  if to_regprocedure('public.yetki_var(text)') is null then
    raise exception 'Önce yetki_katalog_sema.sql çalıştırılmalı';
  end if;
  if to_regprocedure('public._ist_ozet(timestamptz,timestamptz)') is null then
    raise exception 'Önce istatistik_teslim_sema.sql çalıştırılmalı';
  end if;
end $on$;

-- ------------------------------------------------------------
-- 0) Yedekler — toplu güncellemelerden ÖNCE (varsa dokunulmaz)
-- ------------------------------------------------------------
do $yedek$
declare
  t text;
begin
  foreach t in array array['istem_kalemleri', 'test_katalog', 'sablon_kalemleri', 'istek_seti_kalemleri'] loop
    if to_regclass('public.yedek_20261113_' || t) is null then
      execute format('create table public.%I as select * from public.%I', 'yedek_20261113_' || t, t);
      execute format('alter table public.%I enable row level security', 'yedek_20261113_' || t);
      execute format('revoke all on public.%I from anon, authenticated', 'yedek_20261113_' || t);
      raise notice 'yedek alındı: yedek_20261113_%', t;
    end if;
  end loop;
end $yedek$;

begin;

-- ------------------------------------------------------------
-- 1) Yeni sütunlar
-- ------------------------------------------------------------
alter table test_katalog add column if not exists stok text not null default 'var';
alter table test_katalog add column if not exists stok_yok_baslangic timestamptz;
alter table test_katalog add column if not exists stok_aciklama text;
alter table test_katalog add column if not exists stok_duyuru_id uuid;
alter table test_katalog drop constraint if exists test_katalog_stok_chk;
alter table test_katalog add constraint test_katalog_stok_chk check (stok in ('var', 'yok'));

alter table istem_kalemleri add column if not exists kromojen text not null default 'dab';
alter table istem_kalemleri drop constraint if exists istem_kalemleri_kromojen_chk;
alter table istem_kalemleri add constraint istem_kalemleri_kromojen_chk check (kromojen in ('dab', 'kirmizi'));

alter table istem_duzeltmeleri drop constraint if exists istem_duzeltmeleri_alan_check;
alter table istem_duzeltmeleri drop constraint if exists istem_duzeltmeleri_alan_chk;
alter table istem_duzeltmeleri add constraint istem_duzeltmeleri_alan_chk
  check (alan in ('patoloji_no', 'blok_no', 'uzman', 'oncelik', 'test', 'kons_no', 'kromojen'));

-- ------------------------------------------------------------
-- 2) Yardımcılar: bildirim isteği, katalog yetkilileri, sessiz kip
--    istem.push_sessiz = 'on'  → duyuru tetikleyicisi bildirim göndermez
--    istem.canli_sessiz = 'on' → satır başına canlı yayın yok (toplu
--                                 işlemden sonra tek "tam senkron" olayı)
-- ------------------------------------------------------------
create or replace function public.push_istegi(p_govde jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  if to_regclass('public.push_abonelikleri') is null then return; end if;
  if not exists (select 1 from push_abonelikleri) then return; end if;
  perform net.http_post(
    url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/push-gonder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'istem_service_role_key')),
    body := p_govde,
    timeout_milliseconds := 30000);
exception when others then
  raise warning 'push_istegi (%): %', p_govde, sqlerrm;
end $$;
revoke all on function public.push_istegi(jsonb) from public, anon, authenticated;

-- Katalog düzenleme yetkisi olan aktif kullanıcılar (bildirim alıcıları).
create or replace function public.katalog_duzenleyenler() returns setof uuid
language sql stable security definer set search_path = public as $$
  select u.id from kullanicilar u
  where u.aktif and (u.is_admin or coalesce(
          (select ky.izin from kullanici_yetkileri ky where ky.kullanici_id = u.id and ky.yetki = 'katalog_duzenle'),
          exists (select 1 from rol_yetkileri ry where ry.profil = public.yetki_profili(u.rol, u.ekip) and ry.yetki = 'katalog_duzenle')))
$$;
revoke all on function public.katalog_duzenleyenler() from public, anon, authenticated;
grant execute on function public.katalog_duzenleyenler() to service_role;

create or replace function public.duyuru_push_tetikle() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_olay text;
begin
  if coalesce(current_setting('istem.push_sessiz', true), '') = 'on' then return null; end if;
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

do $cy$
begin
  if to_regprocedure('public.canli_yayin_tetik()') is null then return; end if;
  execute $f$
create or replace function public.canli_yayin_tetik() returns trigger
language plpgsql security definer set search_path = public as $b$
declare
  v jsonb;
  yuk jsonb;
begin
  if coalesce(current_setting('istem.canli_sessiz', true), '') = 'on' then return null; end if;
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
  raise warning 'canli_yayin_tetik (%): %', tg_table_name, sqlerrm;
  return null;
end $b$;
$f$;
end $cy$;

-- Toplu kalem değişikliğinden sonra tek olay (istemci tam senkron yapar).
create or replace function public.canli_tam_senkron() returns void
language plpgsql security definer set search_path = public as $$
begin
  if to_regprocedure('public.canli_yayin_tetik()') is null then return; end if;
  perform realtime.send(jsonb_build_object('t', 'istem_kalemleri', 'o', 'UPDATE'), 'degisiklik', 'istem-canli', true);
exception when others then
  raise warning 'canli_tam_senkron: %', sqlerrm;
end $$;
revoke all on function public.canli_tam_senkron() from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3) Kalem kuralları: yeni kalemde katalog testi zorunlu; kırmızı
--    kromojen yalnız İHK; tekrar istemde kromojen kaynaktan gelir.
--    Oturumsuz (SQL Editor, servis) işlemler serbest.
-- ------------------------------------------------------------
create or replace function public.istem_kalemleri_katalog_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' and new.tekrar_kaynagi_id is not null and new.kromojen = 'dab' then
    select coalesce(k.kromojen, 'dab') into new.kromojen from istem_kalemleri k where k.id = new.tekrar_kaynagi_id;
    new.kromojen := coalesce(new.kromojen, 'dab');
  end if;
  if new.kromojen = 'kirmizi' and new.grup is distinct from 'ihc' then
    raise exception 'Kırmızı kromojen yalnız İHK testlerinde seçilebilir' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' and auth.uid() is not null then
    if new.test_id is null then
      raise exception 'Yalnız katalogdaki testler istenebilir — eski serbest metinli kalem önce Katalog > Eşleşmemiş eski kayıtlar''dan bir teste bağlanmalı'
        using errcode = '22023';
    end if;
    if not exists (select 1 from test_katalog t where t.id = new.test_id and t.aktif and t.birlesti_id is null) then
      raise exception 'Bu test katalogda gizli ya da birleştirilmiş — istenemez' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists istem_kalemleri_katalog_kontrol on istem_kalemleri;
create trigger istem_kalemleri_katalog_kontrol before insert or update of kromojen, grup on istem_kalemleri
  for each row execute function public.istem_kalemleri_katalog_kontrol();

create or replace function public.set_sablon_katalog_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null and new.test_id is null then
    raise exception 'Setlere ve şablonlara yalnız katalog testleri eklenebilir — eski serbest metinli kalemi önce Katalog > Eşleşmemiş eski kayıtlar''dan bir teste bağlayın'
      using errcode = '22023';
  end if;
  return new;
end $$;
drop trigger if exists sablon_kalemleri_katalog_kontrol on sablon_kalemleri;
create trigger sablon_kalemleri_katalog_kontrol before insert on sablon_kalemleri
  for each row execute function public.set_sablon_katalog_kontrol();
drop trigger if exists istek_seti_kalemleri_katalog_kontrol on istek_seti_kalemleri;
create trigger istek_seti_kalemleri_katalog_kontrol before insert on istek_seti_kalemleri
  for each row execute function public.set_sablon_katalog_kontrol();

-- ------------------------------------------------------------
-- 4) Katalog izi: stok değişiklikleri de yazılır
-- ------------------------------------------------------------
create or replace function public.test_katalog_iz() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
begin
  if tg_op = 'INSERT' then
    insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id) values (new.id, 'eklendi', null, new.ad, ben);
    return null;
  end if;
  insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id)
  select new.id, x.alan, x.eski, x.yeni, ben
  from (values
    ('ad', old.ad, new.ad),
    ('klon', old.klon, new.klon),
    ('kontrol', old.kontrol, new.kontrol),
    ('aciklama', old.aciklama, new.aciklama),
    ('es_adlar', nullif(array_to_string(old.es_adlar, ', '), ''), nullif(array_to_string(new.es_adlar, ', '), '')),
    ('aktif', case when old.aktif then 'Aktif' else 'Gizli' end, case when new.aktif then 'Aktif' else 'Gizli' end),
    ('grup', old.grup, new.grup),
    ('stok', case when old.stok = 'yok' then 'Stokta yok' else 'Var' end || coalesce(' — ' || old.stok_aciklama, ''),
             case when new.stok = 'yok' then 'Stokta yok' else 'Var' end || coalesce(' — ' || new.stok_aciklama, ''))
  ) as x(alan, eski, yeni)
  where x.eski is distinct from x.yeni;
  return null;
end $$;

-- ------------------------------------------------------------
-- 5) Grup değişince: o testin TÜM istem kalemleri yeni gruba (kırmızı
--    kromojen İHK dışına çıkınca DAB'a döner). "Diğer" grubunda aktif test
--    kalmayınca grup pasife alınır.
-- ------------------------------------------------------------
create or replace function public.test_katalog_grup_tasi() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if new.grup is distinct from old.grup then
    perform set_config('istem.test_birlestirme', 'on', true);
    perform set_config('istem.canli_sessiz', 'on', true);
    update istem_kalemleri set grup = new.grup,
                               kromojen = case when new.grup = 'ihc' then kromojen else 'dab' end
     where test_id = new.id and grup is distinct from new.grup;
    get diagnostics n = row_count;
    perform set_config('istem.canli_sessiz', '', true);
    perform set_config('istem.test_birlestirme', '', true);
    if n > 0 then perform public.canli_tam_senkron(); end if;
    insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id)
    values (new.id, 'grup_kalem', null, n || ' istem kalemi yeni gruba taşındı', public.current_kullanici_id());
  end if;
  return null;
end $$;
drop trigger if exists test_katalog_grup_tasi on test_katalog;
create trigger test_katalog_grup_tasi after update of grup on test_katalog
  for each row execute function public.test_katalog_grup_tasi();

create or replace function public.diger_grubu_pasif() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update test_gruplari set aktif = false
   where kod = 'diger' and aktif
     and not exists (select 1 from test_katalog t where t.grup = 'diger' and t.aktif and t.birlesti_id is null);
  return null;
end $$;
drop trigger if exists test_katalog_diger_pasif on test_katalog;
create trigger test_katalog_diger_pasif after update or delete on test_katalog
  for each statement execute function public.diger_grubu_pasif();

-- ------------------------------------------------------------
-- 6) Kataloğa ekleme talepleri
-- ------------------------------------------------------------
create table if not exists katalog_talepleri (
  id             uuid primary key default gen_random_uuid(),
  ad             text not null check (char_length(btrim(ad)) between 1 and 200),
  notu           text check (notu is null or char_length(notu) <= 1000),
  grup           text,
  talep_eden_id  uuid references kullanicilar(id) on delete set null,
  durum          text not null default 'bekliyor' check (durum in ('bekliyor', 'eklendi', 'var', 'reddedildi')),
  sonuc_test_id  uuid references test_katalog(id) on delete set null,
  cevap          text,
  karar_veren_id uuid references kullanicilar(id) on delete set null,
  created_at     timestamptz not null default now(),
  karar_at       timestamptz
);
create index if not exists katalog_talepleri_durum_idx on katalog_talepleri (durum, created_at desc);
alter table katalog_talepleri enable row level security;
revoke all on katalog_talepleri from anon, authenticated;
grant select, insert on katalog_talepleri to authenticated;
drop policy if exists katalog_talepleri_select on katalog_talepleri;
create policy katalog_talepleri_select on katalog_talepleri for select to authenticated
  using (talep_eden_id = (select public.current_kullanici_id()) or (select public.yetki_var('katalog_duzenle')));
drop policy if exists katalog_talepleri_insert on katalog_talepleri;
create policy katalog_talepleri_insert on katalog_talepleri for insert to authenticated
  with check (talep_eden_id = (select public.current_kullanici_id()) and durum = 'bekliyor');

create or replace function public.katalog_talep_bildir() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.push_istegi(jsonb_build_object('talep_id', new.id, 'olay', 'katalog_talep'));
  elsif old.durum = 'bekliyor' and new.durum <> 'bekliyor' then
    perform public.push_istegi(jsonb_build_object('talep_id', new.id, 'olay', 'katalog_talep_sonuc'));
  end if;
  return null;
end $$;
drop trigger if exists katalog_talepleri_bildir on katalog_talepleri;
create trigger katalog_talepleri_bildir after insert or update of durum on katalog_talepleri
  for each row execute function public.katalog_talep_bildir();

-- Karar: 'eklendi' (p_test = yeni eklenen test) | 'var' (p_test = mevcut test;
-- talep edilen ad o testin eş adı olur) | 'reddedildi'.
create or replace function public.katalog_talep_karar(p_talep uuid, p_karar text, p_test uuid default null, p_cevap text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  t katalog_talepleri%rowtype;
  k test_katalog%rowtype;
begin
  if ben is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  select * into t from katalog_talepleri where id = p_talep for update;
  if t.id is null then raise exception 'Talep bulunamadı' using errcode = 'P0002'; end if;
  if t.durum <> 'bekliyor' then raise exception 'Bu talep zaten sonuçlandı' using errcode = '22023'; end if;
  if p_karar not in ('eklendi', 'var', 'reddedildi') then raise exception 'Geçersiz karar' using errcode = '22023'; end if;
  if p_karar in ('eklendi', 'var') then
    select * into k from test_katalog where id = p_test;
    if k.id is null then raise exception 'Test seçilmedi' using errcode = '22023'; end if;
    if p_karar = 'var' and public.test_anahtar(k.ad) <> public.test_anahtar(t.ad)
       and not exists (select 1 from unnest(k.es_adlar) e where public.test_anahtar(e) = public.test_anahtar(t.ad)) then
      update test_katalog set es_adlar = es_adlar || btrim(t.ad) where id = k.id;
    end if;
  end if;
  update katalog_talepleri
     set durum = p_karar, sonuc_test_id = case when p_karar = 'reddedildi' then null else p_test end,
         cevap = nullif(btrim(coalesce(p_cevap, '')), ''), karar_veren_id = ben, karar_at = now()
   where id = p_talep;
  return jsonb_build_object('durum', p_karar, 'test_id', p_test);
end $$;
revoke all on function public.katalog_talep_karar(uuid, text, uuid, text) from public, anon;
grant execute on function public.katalog_talep_karar(uuid, text, uuid, text) to authenticated;

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 7) Eşleşmemiş eski kayıtlar (serbest metin): liste + bağlama
--    Anahtar: Türkçe harfler sade (I/ı/İ → i …), küçük harf, kırpılmış,
--    iç boşluklar tek — "Grocot boyası" = " GROCOT  BOYASI ".
-- ------------------------------------------------------------
create or replace function public.serbest_anahtar(p text) returns text
language sql immutable as $$
  select lower(btrim(regexp_replace(translate(coalesce(p, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu'), '\s+', ' ', 'g')))
$$;

create or replace function public.eski_serbest_listesi() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.yetki_var('katalog_duzenle') and current_user not in ('postgres', 'service_role') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  return (
    with x as (
      select public.serbest_anahtar(ik.ozel_test) as anahtar, btrim(ik.ozel_test) as metin, 'istem' as kaynak, ik.grup, ik.created_at
      from istem_kalemleri ik where ik.test_id is null and btrim(coalesce(ik.ozel_test, '')) <> ''
      union all
      select public.serbest_anahtar(s.ozel_test), btrim(s.ozel_test), 'sablon', null, null
      from sablon_kalemleri s where s.test_id is null and btrim(coalesce(s.ozel_test, '')) <> ''
      union all
      select public.serbest_anahtar(s.ozel_test), btrim(s.ozel_test), 'set', null, null
      from istek_seti_kalemleri s where s.test_id is null and btrim(coalesce(s.ozel_test, '')) <> ''
    )
    select coalesce(jsonb_agg(z.j order by z.toplam desc, z.anahtar), '[]'::jsonb)
    from (
      select x.anahtar, count(*) as toplam, jsonb_build_object(
               'anahtar', x.anahtar,
               'metin', mode() within group (order by x.metin),
               'istem', count(*) filter (where x.kaynak = 'istem'),
               'sablon', count(*) filter (where x.kaynak = 'sablon'),
               'set', count(*) filter (where x.kaynak = 'set'),
               'gruplar', coalesce(jsonb_agg(distinct x.grup) filter (where x.grup is not null), '[]'::jsonb),
               'son', max(x.created_at)) as j
      from x group by x.anahtar) z);
end $$;
revoke all on function public.eski_serbest_listesi() from public, anon;
grant execute on function public.eski_serbest_listesi() to authenticated;

-- p_eslesmeler: [{"anahtar": "...", "test_id": "..."}] — tek işlem.
create or replace function public.eski_serbest_bagla(p_eslesmeler jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  x record;
  k test_katalog%rowtype;
  n_istem int := 0; n_sablon int := 0; n_set int := 0; n int;
begin
  if ben is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  if jsonb_typeof(p_eslesmeler) is distinct from 'array' then
    raise exception 'Eşleşme listesi bir dizi olmalı' using errcode = '22023';
  end if;
  perform set_config('istem.test_birlestirme', 'on', true);
  perform set_config('istem.canli_sessiz', 'on', true);
  for x in select e->>'anahtar' as anahtar, (e->>'test_id')::uuid as test_id from jsonb_array_elements(p_eslesmeler) e loop
    select * into k from test_katalog where id = x.test_id;
    if k.id is null then raise exception 'Test bulunamadı' using errcode = 'P0002'; end if;
    update istem_kalemleri set test_id = k.id, grup = k.grup,
                               kromojen = case when k.grup = 'ihc' then kromojen else 'dab' end
     where test_id is null and public.serbest_anahtar(ozel_test) = x.anahtar;
    get diagnostics n = row_count; n_istem := n_istem + n;
    insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id)
      select k.id, 'eslestirme', x.anahtar, n || ' eski serbest metinli kalem bağlandı', ben where n > 0;
    update sablon_kalemleri set test_id = k.id where test_id is null and public.serbest_anahtar(ozel_test) = x.anahtar;
    get diagnostics n = row_count; n_sablon := n_sablon + n;
    update istek_seti_kalemleri set test_id = k.id where test_id is null and public.serbest_anahtar(ozel_test) = x.anahtar;
    get diagnostics n = row_count; n_set := n_set + n;
  end loop;
  perform set_config('istem.canli_sessiz', '', true);
  perform set_config('istem.test_birlestirme', '', true);
  if n_istem > 0 then perform public.canli_tam_senkron(); end if;
  return jsonb_build_object('istem', n_istem, 'sablon', n_sablon, 'set', n_set);
end $$;
revoke all on function public.eski_serbest_bagla(jsonb) from public, anon;
grant execute on function public.eski_serbest_bagla(jsonb) to authenticated;

-- ------------------------------------------------------------
-- 8) Kırmızı kromojen düzeltmesi (izli: istem_duzeltmeleri + istem notu)
--    Yetki istem_duzelt ile aynı: yönetici ya da istemi giren + düzeltme.
-- ------------------------------------------------------------
create or replace function public.kalem_kromojen_duzelt(p_kalem uuid, p_kromojen text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  r record;
begin
  select ik.id, ik.istem_id, ik.kromojen, ik.grup, coalesce(tk.ad, ik.ozel_test) as ad, i.istem_yapan_id
    into r
    from istem_kalemleri ik join istemler i on i.id = ik.istem_id left join test_katalog tk on tk.id = ik.test_id
   where ik.id = p_kalem;
  if r.id is null then raise exception 'Kalem bulunamadı' using errcode = 'P0002'; end if;
  if ben is null or not (public.is_admin() or (r.istem_yapan_id = ben and public.yetki_var('duzeltme'))) then
    raise exception 'Bu kalemi düzeltme yetkiniz yok' using errcode = '42501';
  end if;
  if p_kromojen not in ('dab', 'kirmizi') then raise exception 'Geçersiz kromojen' using errcode = '22023'; end if;
  if r.kromojen = p_kromojen then return jsonb_build_object('duzeltilen', 0); end if;
  update istem_kalemleri set kromojen = p_kromojen where id = p_kalem;  -- İHK dışıysa tetikleyici reddeder
  insert into istem_duzeltmeleri (istem_id, kalem_id, alan, eski_deger, yeni_deger, duzelten_id)
  values (r.istem_id, p_kalem, 'kromojen', r.kromojen, p_kromojen, ben);
  insert into istem_notlari (istem_id, yazan_id, metin)
  values (r.istem_id, ben, format('%s: kromojen %s → %s olarak düzeltildi', r.ad,
          case r.kromojen when 'kirmizi' then 'Kırmızı' else 'DAB' end, case p_kromojen when 'kirmizi' then 'Kırmızı' else 'DAB' end));
  return jsonb_build_object('duzeltilen', 1);
end $$;
revoke all on function public.kalem_kromojen_duzelt(uuid, text) from public, anon;
grant execute on function public.kalem_kromojen_duzelt(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 9) Stok: Tükendi / Geldi (katalog düzenleme yetkisi)
-- ------------------------------------------------------------
create or replace function public.katalog_stok(p_test uuid, p_yok boolean, p_aciklama text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  k test_katalog%rowtype;
  v_aciklama text := nullif(btrim(coalesce(p_aciklama, '')), '');
  v_duyuru uuid;
begin
  if ben is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  select * into k from test_katalog where id = p_test for update;
  if k.id is null then raise exception 'Test bulunamadı' using errcode = 'P0002'; end if;
  if p_yok then
    if k.stok = 'yok' then raise exception 'Bu test zaten "stokta yok" olarak işaretli' using errcode = '22023'; end if;
    insert into duyurular (baslik, metin, onem, test_id, yazan_id)
    values (left(format('⚠ %s tükendi%s', k.ad, coalesce(' — ' || v_aciklama, '')), 200),
            coalesce(v_aciklama, 'Test geçici olarak temin edilemiyor.'), 'kritik', k.id, ben)
    returning id into v_duyuru;                       -- kritik duyuru → herkese bildirim (tetikleyici)
    update test_katalog set stok = 'yok', stok_yok_baslangic = now(), stok_aciklama = v_aciklama, stok_duyuru_id = v_duyuru
     where id = k.id;
  else
    if k.stok = 'var' then raise exception 'Bu test zaten stokta' using errcode = '22023'; end if;
    -- Kritik duyuru çözülür; "çözüldü" bildirimi yerine tek "tekrar mevcut" bildirimi gider.
    perform set_config('istem.push_sessiz', 'on', true);
    update duyurular set cozuldu_at = now(), cozen_id = ben
     where cozuldu_at is null and (id = k.stok_duyuru_id or (test_id = k.id and onem = 'kritik'));
    insert into duyurular (baslik, metin, onem, test_id, yazan_id, bitis_at)
    values (left(format('✓ %s tekrar mevcut', k.ad), 200), 'Test yeniden istenebilir.', 'bilgi', k.id, ben, now() + interval '7 days')
    returning id into v_duyuru;
    perform set_config('istem.push_sessiz', '', true);
    update test_katalog set stok = 'var', stok_yok_baslangic = null, stok_aciklama = null, stok_duyuru_id = null where id = k.id;
    perform public.push_istegi(jsonb_build_object('duyuru_id', v_duyuru, 'olay', 'stok_geldi'));
  end if;
  return jsonb_build_object('stok', case when p_yok then 'yok' else 'var' end, 'duyuru_id', v_duyuru);
end $$;
revoke all on function public.katalog_stok(uuid, boolean, text) from public, anon;
grant execute on function public.katalog_stok(uuid, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- 10) Birleştirme — gruplar arası: kalacak grup p_grup (boşsa kalanın
--     grubu). Önizleme eskisi gibi + grubu değişecek kalem sayısı.
-- ------------------------------------------------------------
drop function if exists public.test_birlestir(uuid, uuid, boolean);
create or replace function public.test_birlestir(p_kalan uuid, p_giden uuid, p_onizleme boolean default true, p_grup text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  k test_katalog%rowtype;
  g test_katalog%rowtype;
  fk record;
  n int;
  sayilar jsonb := '{}'::jsonb;
  yeni_es text[];
  ust text;
  v_grup text;
  n_grup int;
begin
  if ben is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  if p_kalan is null or p_giden is null or p_kalan = p_giden then
    raise exception 'Birleştirmek için iki farklı test seçin' using errcode = '22023';
  end if;
  select * into k from test_katalog where id = p_kalan for update;
  select * into g from test_katalog where id = p_giden for update;
  if k.id is null or g.id is null then raise exception 'Test bulunamadı' using errcode = 'P0002'; end if;
  if k.birlesti_id is not null or g.birlesti_id is not null then
    raise exception 'Bu testlerden biri zaten başka bir testle birleştirilmiş' using errcode = '22023';
  end if;
  v_grup := coalesce(nullif(btrim(coalesce(p_grup, '')), ''), k.grup);
  if not exists (select 1 from test_gruplari where kod = v_grup) then
    raise exception 'Grup bulunamadı: %', v_grup using errcode = '22023';
  end if;
  select count(*) into n_grup from istem_kalemleri where test_id in (p_kalan, p_giden) and grup is distinct from v_grup;

  for fk in
    select c.conrelid::regclass as tablo, c.conrelid::regclass::text as ad, a.attname as kolon
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.test_katalog'::regclass and array_length(c.conkey, 1) = 1
      and c.conrelid not in ('public.test_katalog'::regclass, 'public.test_katalog_log'::regclass)
      and c.conrelid::regclass::text not like 'yedek\_%'
    order by 2
  loop
    execute format('select count(*) from %s where %I = $1', fk.tablo, fk.kolon) into n using p_giden;
    sayilar := sayilar || jsonb_build_object(fk.ad, n);
    if not p_onizleme and n > 0 then
      perform set_config('istem.test_birlestirme', 'on', true);
      perform set_config('istem.canli_sessiz', 'on', true);
      ust := case fk.ad when 'sablon_kalemleri' then 'sablon_id' when 'istek_seti_kalemleri' then 'istek_seti_id' end;
      if ust is not null then
        execute format('delete from %1$s x where x.%2$I = $2 and exists (select 1 from %1$s y where y.%3$I = x.%3$I and y.%2$I = $1)',
                       fk.tablo, fk.kolon, ust) using p_kalan, p_giden;
      end if;
      execute format('update %s set %I = $1 where %I = $2', fk.tablo, fk.kolon, fk.kolon) using p_kalan, p_giden;
    end if;
  end loop;

  select coalesce(array_agg(e order by sira), '{}') into yeni_es
  from (
    select distinct on (public.test_anahtar(e)) e, sira
    from unnest(array[g.ad] || g.es_adlar) with ordinality as x(e, sira)
    where public.test_anahtar(e) <> public.test_anahtar(k.ad)
      and not exists (select 1 from unnest(k.es_adlar) m where public.test_anahtar(m) = public.test_anahtar(e))
    order by public.test_anahtar(e), sira
  ) s;

  if not p_onizleme then
    perform set_config('istem.test_birlestirme', 'on', true);
    perform set_config('istem.katalog_duyuru', 'kapali', true);
    perform set_config('istem.canli_sessiz', 'on', true);
    update test_katalog set aktif = false, birlesti_id = p_kalan where id = p_giden;
    update test_katalog
       set es_adlar = es_adlar || yeni_es,
           klon = coalesce(klon, g.klon),
           kontrol = coalesce(nullif(btrim(coalesce(kontrol, '')), ''), g.kontrol),
           aciklama = coalesce(aciklama, g.aciklama),
           grup = v_grup
     where id = p_kalan;
    -- Taşınan kalemler (gidenin eski grubunda kalmış olabilir) kalan grupta
    update istem_kalemleri set grup = v_grup, kromojen = case when v_grup = 'ihc' then kromojen else 'dab' end
     where test_id = p_kalan and grup is distinct from v_grup;
    insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id)
    values (p_kalan, 'birlestirme', g.ad, k.ad, ben), (p_giden, 'birlestirme', g.ad, k.ad, ben);
    perform set_config('istem.canli_sessiz', '', true);
    perform set_config('istem.test_birlestirme', '', true);
    perform public.canli_tam_senkron();
  end if;

  return jsonb_build_object(
    'onizleme', p_onizleme,
    'kalan', jsonb_build_object('id', k.id, 'ad', k.ad, 'grup', k.grup),
    'giden', jsonb_build_object('id', g.id, 'ad', g.ad, 'grup', g.grup),
    'grup', v_grup,
    'grup_degisecek', n_grup,
    'sayilar', sayilar,
    'eklenecek_es_adlar', to_jsonb(yeni_es),
    'doldurulacak', jsonb_strip_nulls(jsonb_build_object(
      'klon', case when k.klon is null then g.klon end,
      'kontrol', case when nullif(btrim(coalesce(k.kontrol, '')), '') is null then g.kontrol end,
      'aciklama', case when k.aciklama is null then g.aciklama end))
  );
end $$;
revoke all on function public.test_birlestir(uuid, uuid, boolean, text) from public, anon;
grant execute on function public.test_birlestir(uuid, uuid, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- 11) Test silme: yalnız hiç kullanılmamışsa. Tüm alanlar + geçmiş
--     test_katalog_silinen'e yazılır; test_geri_yukle ile geri gelir.
-- ------------------------------------------------------------
create table if not exists test_katalog_silinen (
  id               uuid primary key default gen_random_uuid(),
  test_id          uuid not null,
  ad               text not null,
  grup             text,
  klon             text,
  kontrol          text,
  aciklama         text,
  es_adlar         text[] not null default '{}',
  satir            jsonb not null,
  gecmis           jsonb not null default '[]'::jsonb,
  silen_id         uuid references kullanicilar(id) on delete set null,
  silindi_at       timestamptz not null default now(),
  geri_yuklendi_at timestamptz
);
alter table test_katalog_silinen enable row level security;
revoke all on test_katalog_silinen from anon, authenticated;
grant select on test_katalog_silinen to authenticated;
drop policy if exists test_katalog_silinen_select on test_katalog_silinen;
create policy test_katalog_silinen_select on test_katalog_silinen for select to authenticated
  using ((select public.yetki_var('katalog_duzenle')));

create or replace function public.test_kullanimi(p_test uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'istem_kalemleri', (select count(*) from istem_kalemleri where test_id = p_test),
    'sablon_kalemleri', (select count(*) from sablon_kalemleri where test_id = p_test),
    'istek_seti_kalemleri', (select count(*) from istek_seti_kalemleri where test_id = p_test),
    'duyurular', (select count(*) from duyurular where test_id = p_test))
$$;
revoke all on function public.test_kullanimi(uuid) from public, anon;
grant execute on function public.test_kullanimi(uuid) to authenticated;

create or replace function public.test_sil(p_test uuid, p_onizleme boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  k test_katalog%rowtype;
  kul jsonb;
  kullanilmis boolean;
begin
  if ben is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  select * into k from test_katalog where id = p_test for update;
  if k.id is null then raise exception 'Test bulunamadı' using errcode = 'P0002'; end if;
  kul := public.test_kullanimi(p_test);
  kullanilmis := (kul->>'istem_kalemleri')::int + (kul->>'sablon_kalemleri')::int + (kul->>'istek_seti_kalemleri')::int > 0;
  if p_onizleme then
    return jsonb_build_object('silinebilir', not kullanilmis, 'kullanim', kul);
  end if;
  if kullanilmis then
    raise exception 'Bu test kullanılmış — silinemez; birleştirin ya da gizleyin' using errcode = '22023';
  end if;
  insert into test_katalog_silinen (test_id, ad, grup, klon, kontrol, aciklama, es_adlar, satir, gecmis, silen_id)
  values (k.id, k.ad, k.grup, k.klon, k.kontrol, k.aciklama, k.es_adlar, to_jsonb(k),
          coalesce((select jsonb_agg(to_jsonb(l) order by l.created_at) from test_katalog_log l where l.test_id = k.id), '[]'::jsonb), ben);
  delete from test_katalog where id = k.id;
  return jsonb_build_object('silindi', true, 'kullanim', kul);
end $$;
revoke all on function public.test_sil(uuid, boolean) from public, anon;
grant execute on function public.test_sil(uuid, boolean) to authenticated;

create or replace function public.test_geri_yukle(p_silinen uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  s test_katalog_silinen%rowtype;
begin
  if ben is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  select * into s from test_katalog_silinen where id = p_silinen for update;
  if s.id is null then raise exception 'Kayıt bulunamadı' using errcode = 'P0002'; end if;
  if s.geri_yuklendi_at is not null or exists (select 1 from test_katalog where id = s.test_id) then
    raise exception 'Bu test zaten geri yüklenmiş' using errcode = '22023';
  end if;
  perform set_config('istem.katalog_duyuru', 'kapali', true);
  insert into test_katalog select * from jsonb_populate_record(null::test_katalog, s.satir);
  delete from test_katalog_log where test_id = s.test_id;  -- eklemenin kendi "eklendi" izi; eski geçmiş aşağıda
  insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id, created_at)
  select s.test_id, l->>'alan', l->>'eski', l->>'yeni', nullif(l->>'degistiren_id', '')::uuid, (l->>'created_at')::timestamptz
  from jsonb_array_elements(s.gecmis) l;
  insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id) values (s.test_id, 'geri_yuklendi', null, s.ad, ben);
  update test_katalog_silinen set geri_yuklendi_at = now() where id = s.id;
  return jsonb_build_object('test_id', s.test_id);
end $$;
revoke all on function public.test_geri_yukle(uuid) from public, anon;
grant execute on function public.test_geri_yukle(uuid) to authenticated;

commit;

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 12) Görünümler + kuyruk RPC'si + toplu istem: kromojen (sona eklenir;
--     mevcut sütunlar ve sıraları aynı kalır)
-- ------------------------------------------------------------
do $gor$
declare
  v text;
  tanim text;
begin
  foreach v in array array['istem_kuyruk_v', 'istem_liste_v'] loop
    if to_regclass('public.' || v) is null then continue; end if;
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = v and column_name = 'kromojen') then
      continue;
    end if;
    tanim := pg_get_viewdef(('public.' || v)::regclass);
    if (select count(*) from regexp_matches(tanim, E'\n   FROM ', 'g')) <> 1 then
      raise exception '% görünümünün tanımı beklenen biçimde değil — kromojen eklenemedi', v;
    end if;
    tanim := regexp_replace(tanim, E'\n   FROM ', E',\n    ik.kromojen\n   FROM ');
    execute format('create or replace view public.%I with (security_invoker = true) as %s', v, rtrim(tanim, ';'));
    raise notice '%: kromojen eklendi', v;
  end loop;
end $gor$;

do $yama$
declare
  f regprocedure;
  src text;
begin
  f := to_regprocedure('public.kuyruk_getir(integer,integer,integer,uuid[],uuid[],text)');
  if f is not null then
    src := pg_get_functiondef(f);
    if position('''kromojen''' in src) = 0 then
      src := replace(src, '''duzeltmeler'', ''eski_patoloji_nolar''],', '''duzeltmeler'', ''eski_patoloji_nolar'', ''kromojen''],');
      src := replace(src, 'r.duzeltmeler, r.eski_patoloji_nolar)', 'r.duzeltmeler, r.eski_patoloji_nolar, r.kromojen)');
      if position('''kromojen''' in src) = 0 or position('r.kromojen)' in src) = 0 then
        raise exception 'kuyruk_getir beklenen biçimde değil — kromojen eklenemedi';
      end if;
      execute src;
      raise notice 'kuyruk_getir: kromojen eklendi';
    end if;
  else
    raise notice 'kuyruk_getir bulunamadı (performans_sema.sql kurulu değil) — atlandı';
  end if;

  f := to_regprocedure('public.toplu_istem_olustur(jsonb)');
  if f is not null then
    src := pg_get_functiondef(f);
    if position('kromojen' in src) = 0 then
      src := replace(src, 'insert into istem_kalemleri (istem_id, blok_no, test_id, ozel_test, grup)',
                          'insert into istem_kalemleri (istem_id, blok_no, test_id, ozel_test, grup, kromojen)');
      src := replace(src, 'coalesce(tk.grup, t.value->>''grup'')',
                          'coalesce(tk.grup, t.value->>''grup''), coalesce(nullif(t.value->>''kromojen'', ''''), ''dab'')');
      if (select count(*) from regexp_matches(src, 'kromojen', 'g')) < 2 then
        raise exception 'toplu_istem_olustur beklenen biçimde değil — kromojen eklenemedi';
      end if;
      execute src;
      raise notice 'toplu_istem_olustur: kromojen eklendi';
    end if;
  end if;
end $yama$;

-- ------------------------------------------------------------
-- 13) İstatistik: kırmızı kromojen sayısı (kartlar + test bazında)
-- ------------------------------------------------------------
drop function if exists public._ist_kalem(timestamptz, timestamptz);
create function public._ist_kalem(p_bas timestamptz, p_bit timestamptz)
returns table (id uuid, istem_id uuid, grup text, test_key text, test_ad text, vaka text, oncelik text,
               istem_yapan_id uuid, uzman_id uuid, created_at timestamptz, tekrar boolean, kromojen text)
language sql stable security invoker set search_path = public as $$
  select ik.id, ik.istem_id, ik.grup,
         coalesce(ik.test_id::text, 'ozel:' || lower(btrim(coalesce(ik.ozel_test, '?')))),
         coalesce(tk.ad, nullif(btrim(ik.ozel_test), ''), '?'),
         upper(regexp_replace(i.patoloji_no, '\s+', '', 'g')),
         coalesce(i.oncelik, 'rutin'), i.istem_yapan_id, i.uzman_id, ik.created_at,
         ik.tekrar_kaynagi_id is not null, ik.kromojen
  from istem_kalemleri ik
  join istemler i on i.id = ik.istem_id
  left join test_katalog tk on tk.id = ik.test_id
  where ik.created_at >= p_bas and ik.created_at < p_bit
$$;

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
    'kirmizi', (select count(*) from k where k.kromojen = 'kirmizi'),
    'tamamlanan', (select count(*) from c),
    'ort_saat', (select round(avg(c.saat)::numeric, 1) from c),
    'medyan_saat', (select round((percentile_cont(0.5) within group (order by c.saat))::numeric, 1) from c))
$$;

do $ist$
declare
  f regprocedure := to_regprocedure('public.istatistik_v2(date,date,text)');
  src text;
begin
  if f is null then return; end if;
  src := pg_get_functiondef(f);
  if position('as kirmizi' in src) > 0 then return; end if;
  src := replace(src, 'count(*) filter (where k.tekrar) as tekrar
               from k group by k.test_key)',
                      'count(*) filter (where k.tekrar) as tekrar, count(*) filter (where k.kromojen = ''kirmizi'') as kirmizi
               from k group by k.test_key)');
  src := replace(src, '''tekrar'', g.tekrar,', '''tekrar'', g.tekrar, ''kirmizi'', g.kirmizi,');
  if position('as kirmizi' in src) = 0 or position('g.kirmizi' in src) = 0 then
    raise notice 'istatistik_v2 beklenen biçimde değil — test bazında kırmızı sayısı eklenmedi (kartta var)';
    return;
  end if;
  execute src;
end $ist$;

-- ------------------------------------------------------------
-- 14) GMS'e eş ad "Grocott"; "Diğer" grubunda aktif test yoksa pasif
-- ------------------------------------------------------------
update test_katalog t set es_adlar = t.es_adlar || array['Grocott']
 where t.birlesti_id is null and public.test_anahtar(t.ad) = 'gms'
   and not exists (select 1 from unnest(t.es_adlar) e where public.test_anahtar(e) = 'grocott')
   and not exists (select 1 from test_katalog x where x.grup = t.grup and x.id <> t.id and x.birlesti_id is null
                     and (public.test_anahtar(x.ad) = 'grocott' or exists (select 1 from unnest(x.es_adlar) e where public.test_anahtar(e) = 'grocott')));
update test_gruplari set aktif = false
 where kod = 'diger' and aktif
   and not exists (select 1 from test_katalog t where t.grup = 'diger' and t.aktif and t.birlesti_id is null);

-- ------------------------------------------------------------
-- 15) Canlı yayın: talepler (sayı rozeti) ve silinenler
-- ------------------------------------------------------------
do $cy2$
declare
  tablo text;
begin
  if to_regprocedure('public.canli_yayin_tetik()') is null then return; end if;
  foreach tablo in array array['katalog_talepleri'] loop
    execute format('drop trigger if exists %I on public.%I', tablo || '_canli_yayin', tablo);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.canli_yayin_tetik()',
                   tablo || '_canli_yayin', tablo);
  end loop;
end $cy2$;

commit;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- SONUÇ
-- ------------------------------------------------------------
select v.sira, v.bilgi, v.deger from (
  select 1 as sira, 'Yedek tabloları' as bilgi,
         (select string_agg(c.relname || ' (' || (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text || ' satır)', ', ' order by c.relname)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname like 'yedek\_20261113\_%' and c.relkind = 'r') as deger
  union all select 2, 'Eşleşmemiş eski serbest metin (farklı metin / kalem)',
         (select count(distinct public.serbest_anahtar(ozel_test)) || ' / ' || count(*)
            from istem_kalemleri where test_id is null and btrim(coalesce(ozel_test, '')) <> '')
  union all select 3, 'Set / şablondaki serbest metinli kalem',
         ((select count(*) from istek_seti_kalemleri where test_id is null) + (select count(*) from sablon_kalemleri where test_id is null))::text
  union all select 4, '"Diğer" grubu', coalesce((select case when aktif then 'aktif' else 'pasif' end from test_gruplari where kod = 'diger'), 'yok')
                     || ' · ' || (select count(*) from test_katalog where grup = 'diger' and aktif and birlesti_id is null) || ' aktif test'
  union all select 5, 'GMS eş adları', coalesce((select array_to_string(es_adlar, ', ') from test_katalog where public.test_anahtar(ad) = 'gms' and birlesti_id is null limit 1), '(GMS adlı test yok)')
  union all select 6, 'Liste görünümünde kromojen',
         (select string_agg(table_name, ', ') from information_schema.columns where table_schema = 'public' and column_name = 'kromojen' and table_name like 'istem_%_v')
) v order by v.sira;
