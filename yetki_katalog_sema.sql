-- ============================================================
-- yetki_katalog_sema.sql — Test kataloğu (herkese açık, eş adlar, iz,
-- birleştirme, içe aktarma, yeni test duyurusu) + Yetkiler
--
-- performans_sema.sql'den SONRA çalıştırın. İDEMPOTENT'tir (tekrar
-- çalıştırmak güvenlidir); tek seferde ya da 4 parça hâlinde
-- çalıştırılabilir. SIRA: ÖNCE uygulama yayınlanır, SONRA bu dosya — ikisi
-- arasında uygulama bugünkü kurallarla çalışır (yetkilerim() yoksa eski
-- rol kurallarına düşer). Geri almak için: yetki_katalog_sema_geri_al.sql
--
-- 1) KATALOG
--    test_katalog.aciklama, es_adlar (text[]), birlesti_id.
--    test_anahtar(ad): Türkçe harfler sadeleşir, küçük harf; boşluk, tire,
--      nokta, parantez ve eğik çizgi atılır ("c-erb-B2" = "CERBB2").
--    Tekrar kontrolü (tetikleyici): aynı grupta adı ya da eş adı çakışan
--      test eklenemez / adlandırılamaz → "Bu test zaten var: X".
--    test_katalog_log: her değişikliğin izi (tetikleyici yazar).
--    Yeni test duyurusu (tetikleyici): test eklenince / pasiften aktife
--      alınınca "bilgi" duyurusu, 7 gün; tek komutta birden çok test → TEK
--      özet duyuru. katalog_ice_aktar(.., p_duyuru => false) sessizdir.
--    test_birlestir(kalan, giden, onizleme): tek işlemde tüm test_id
--      referanslarını taşır; giden pasif + birlesti_id.
--    Silme herkes için kapalı (pasife alınır) — geçmiş istemler bozulmaz.
-- 2) YETKİLER
--    rol_yetkileri (profil × yetki), kullanici_yetkileri (kişi istisnası:
--      ver / al, kaynak otomatik | elle), ekip_gruplari (Ekibim grupları).
--    yetki_var(kod): yönetici her zaman tam yetkili; sonra kişi istisnası,
--      sonra profil. İşlemler veritabanında buna bağlanır (RLS / RPC /
--      tetikleyici): istem verme, uzman adına, durum değiştirme, kesildi,
--      blok çıkarma, teslim, silme, düzeltme, katalog, duyuru, istatistik.
--    BAŞLANGIÇ VERİSİ = BUGÜNKÜ DAVRANIŞ: profil varsayılanları mevcut
--      kullanıcıların bugünkü haklarından hesaplanır; profilinden farklı
--      çıkan kullanıcıya otomatik kişi istisnası yazılır. Kimsenin yetkisi
--      kendiliğinden değişmez. İstisnalar (bilinçli): katalog düzenleme
--      (yönetici + immün ekibi + uzmanlar; formdan ekleme dahil) ve immün
--      ekibinin "Ekibim" grupları (İHK + HK + Yeni Kesit).
--    Son aktif yöneticinin yönetici yetkisi kaldırılamaz.
-- DOSYANIN SON SORGUSU otomatik yazılan kişi istisnalarını listeler.
-- ============================================================

do $on$
begin
  if to_regclass('public.duyurular') is null then
    raise exception 'Önce duyuru_sema.sql çalıştırılmalı (duyurular tablosu yok)';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'kullanicilar' and column_name = 'ekip') then
    raise exception 'Önce ekip_sema.sql çalıştırılmalı (kullanicilar.ekip yok)';
  end if;
end $on$;

begin;

-- ------------------------------------------------------------
-- 1) Katalog alanları + anahtar
-- ------------------------------------------------------------
alter table test_katalog add column if not exists aciklama text;
alter table test_katalog add column if not exists es_adlar text[] not null default '{}';
alter table test_katalog add column if not exists birlesti_id uuid references test_katalog(id) on delete set null;
alter table test_katalog drop constraint if exists test_katalog_aciklama_chk;
alter table test_katalog add constraint test_katalog_aciklama_chk
  check (aciklama is null or char_length(aciklama) <= 1000);

create or replace function public.test_anahtar(p text) returns text
language sql immutable as $$
  select regexp_replace(
           lower(translate(coalesce(p, ''), 'İIıŞşĞğÜüÖöÇçÂâÎîÛûÉé', 'iiissgguuooccaaiiuuee')),
           '[\s.()/\\‐-―-]', '', 'g')
$$;

-- Ad / eş ad düzeni + tekrar kontrolü. Yalnız ad, eş ad ya da grup
-- değişince bakılır (eski çift kayıtların başka alanları düzenlenebilsin).
-- Birleştirilip pasife alınmış testler (birlesti_id dolu) sayılmaz — adları
-- kalan testin eş adıdır.
create or replace function public.test_katalog_kontrol() returns trigger
language plpgsql set search_path = public as $$
declare
  anahtarlar text[];
  cakisan text;
begin
  new.ad := btrim(regexp_replace(coalesce(new.ad, ''), '\s+', ' ', 'g'));
  if public.test_anahtar(new.ad) = '' then
    raise exception 'Test adı boş olamaz' using errcode = '22023';
  end if;
  new.klon := nullif(btrim(coalesce(new.klon, '')), '');
  new.aciklama := nullif(btrim(coalesce(new.aciklama, '')), '');
  -- Eş adlar: kırpılır; boşlar, testin kendi adı ve yinelenenler atılır.
  select coalesce(array_agg(e order by sira), '{}') into new.es_adlar
  from (
    select distinct on (public.test_anahtar(e)) btrim(regexp_replace(e, '\s+', ' ', 'g')) as e, sira
    from unnest(coalesce(new.es_adlar, '{}')) with ordinality as x(e, sira)
    where public.test_anahtar(e) <> '' and public.test_anahtar(e) <> public.test_anahtar(new.ad)
    order by public.test_anahtar(e), sira
  ) s;

  if tg_op = 'UPDATE' and new.birlesti_id is distinct from old.birlesti_id
     and coalesce(current_setting('istem.test_birlestirme', true), '') <> 'on' then
    raise exception 'Birleştirme yalnız test_birlestir ile yapılır' using errcode = '42501';
  end if;

  if new.birlesti_id is null
     and (tg_op = 'INSERT' or new.ad is distinct from old.ad or new.es_adlar is distinct from old.es_adlar
          or new.grup is distinct from old.grup) then
    anahtarlar := array[public.test_anahtar(new.ad)]
                  || coalesce((select array_agg(public.test_anahtar(e)) from unnest(new.es_adlar) e), '{}');
    select t.ad || case when t.aktif then '' else ' (pasif)' end into cakisan
    from test_katalog t
    where t.grup = new.grup and t.id <> new.id and t.birlesti_id is null
      and (public.test_anahtar(t.ad) = any (anahtarlar)
           or exists (select 1 from unnest(t.es_adlar) e where public.test_anahtar(e) = any (anahtarlar)))
    order by t.aktif desc, t.ad
    limit 1;
    if cakisan is not null then
      raise exception 'Bu test zaten var: %', cakisan using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists test_katalog_kontrol on test_katalog;
create trigger test_katalog_kontrol before insert or update on test_katalog
  for each row execute function public.test_katalog_kontrol();

-- ------------------------------------------------------------
-- 2) Değişiklik izi
-- ------------------------------------------------------------
create table if not exists test_katalog_log (
  id            bigint generated always as identity primary key,
  test_id       uuid not null references test_katalog(id) on delete cascade,
  alan          text not null,
  eski          text,
  yeni          text,
  degistiren_id uuid references kullanicilar(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists test_katalog_log_test_idx on test_katalog_log (test_id, created_at desc);
alter table test_katalog_log enable row level security;
revoke all on test_katalog_log from anon, authenticated;
grant select on test_katalog_log to authenticated;
drop policy if exists test_katalog_log_select on test_katalog_log;
create policy test_katalog_log_select on test_katalog_log for select to authenticated using (true);

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
    ('aktif', case when old.aktif then 'Aktif' else 'Pasif' end, case when new.aktif then 'Aktif' else 'Pasif' end),
    ('grup', old.grup, new.grup)
  ) as x(alan, eski, yeni)
  where x.eski is distinct from x.yeni;
  return null;
end $$;
drop trigger if exists test_katalog_iz on test_katalog;
create trigger test_katalog_iz after insert or update on test_katalog
  for each row execute function public.test_katalog_iz();

-- ------------------------------------------------------------
-- 3) Yeni test duyurusu (komut başına; istemciye bağlı değil)
--    istem.katalog_duyuru = 'kapali' → bu işlemde duyuru yok.
-- ------------------------------------------------------------
create or replace function public.duyuru_push_gonder(p_duyuru_id uuid, p_olay text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_duyuru_id is null or to_regclass('public.push_abonelikleri') is null then return; end if;
  if not exists (select 1 from push_abonelikleri) then return; end if;
  perform net.http_post(
    url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/push-gonder',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'istem_service_role_key'
      )
    ),
    body := jsonb_build_object('duyuru_id', p_duyuru_id, 'olay', p_olay),
    timeout_milliseconds := 30000
  );
exception when others then
  raise warning 'duyuru_push_gonder (duyuru %): %', p_duyuru_id, sqlerrm;
end $$;
revoke all on function public.duyuru_push_gonder(uuid, text) from public, anon, authenticated;

create or replace function public.test_katalog_duyuru() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  idler uuid[];
  n int;
  r record;
  v_id uuid;
  v_adlar text;
begin
  if coalesce(current_setting('istem.katalog_duyuru', true), '') = 'kapali' then return null; end if;
  if tg_op = 'INSERT' then
    select array_agg(y.id) into idler from yeni y where y.aktif and y.birlesti_id is null;
  else
    select array_agg(y.id) into idler
    from yeni y join eski e on e.id = y.id
    where y.aktif and not e.aktif and y.birlesti_id is null;
  end if;
  n := coalesce(array_length(idler, 1), 0);
  if n = 0 then return null; end if;

  if n = 1 then
    select t.id, t.ad, t.klon, t.kontrol, t.aciklama, coalesce(g.kisa_ad, g.ad, t.grup) as grup_ad into r
    from test_katalog t left join test_gruplari g on g.kod = t.grup
    where t.id = idler[1];
    insert into duyurular (baslik, metin, onem, test_id, yazan_id, bitis_at)
    values (
      left(format('Yeni %s: %s%s', r.grup_ad, r.ad, case when r.klon is not null then format(' (klon %s)', r.klon) else '' end), 200),
      left(concat_ws(' — ', case when r.aciklama is not null then 'Kullanım: ' || r.aciklama end,
                            case when nullif(btrim(coalesce(r.kontrol, '')), '') is not null then 'Kontrol: ' || r.kontrol end), 4000),
      'bilgi', r.id, ben, now() + interval '7 days')
    returning id into v_id;
  else
    select string_agg(x.etiket, ', ' order by x.grup_sira, x.ad) into v_adlar
    from (
      select t.ad, coalesce(g.sira, 999) as grup_sira,
             t.ad || case when count(*) over (partition by 1) > 0 and g.kod is not null
                               and (select count(distinct t2.grup) from test_katalog t2 where t2.id = any (idler)) > 1
                          then ' (' || coalesce(g.kisa_ad, g.ad) || ')' else '' end as etiket
      from test_katalog t left join test_gruplari g on g.kod = t.grup
      where t.id = any (idler)
      order by coalesce(g.sira, 999), t.ad
      limit 60
    ) x;
    insert into duyurular (baslik, metin, onem, test_id, yazan_id, bitis_at)
    values (format('Kataloğa %s yeni test eklendi', n),
            left(v_adlar || case when n > 60 then format(' … +%s test daha', n - 60) else '' end, 4000),
            'bilgi', null, ben, now() + interval '7 days')
    returning id into v_id;
  end if;
  perform public.duyuru_push_gonder(v_id, 'yeni_test');
  return null;
end $$;
drop trigger if exists test_katalog_duyuru_ekle on test_katalog;
create trigger test_katalog_duyuru_ekle after insert on test_katalog
  referencing new table as yeni
  for each statement execute function public.test_katalog_duyuru();
drop trigger if exists test_katalog_duyuru_guncelle on test_katalog;
create trigger test_katalog_duyuru_guncelle after update on test_katalog
  referencing old table as eski new table as yeni
  for each statement execute function public.test_katalog_duyuru();

commit;

select 'Parça 1/4 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 4) Yetki tabloları
--    Profil: ekibi sekreter / arşiv / kesit olan o profil (rolü ne olursa);
--    teknisyen + immün / histomol / sito / ekipsiz → teknisyen-…; diğerleri
--    rolüne göre (uzman, asistan).
--    Yetki kodları — sayfalar: s_kuyruk, s_hizmetler, s_kesit, s_arsiv,
--    s_katalog, s_duyurular, s_istatistik · işlemler: istem_ver (İstek Ver
--    sayfası + istem verme), uzman_adina, durum_degistir, teslim_al, sil,
--    duzeltme, katalog_duzenle, duyuru_yayinla, duyuru_yonet, yazdir.
-- ------------------------------------------------------------
create table if not exists rol_yetkileri (
  profil text not null,
  yetki  text not null,
  primary key (profil, yetki)
);
create table if not exists kullanici_yetkileri (
  kullanici_id uuid not null references kullanicilar(id) on delete cascade,
  yetki        text not null,
  izin         boolean not null,
  kaynak       text not null default 'elle',
  sebep        text,
  created_at   timestamptz not null default now(),
  primary key (kullanici_id, yetki)
);
create table if not exists ekip_gruplari (
  ekip     text not null,
  grup_kod text not null references test_gruplari(kod) on update cascade on delete cascade,
  primary key (ekip, grup_kod)
);
create table if not exists yetki_kurulum (
  anahtar text primary key,
  zaman   timestamptz not null default now()
);

do $kisit$
declare
  kodlar constant text := $k$('s_kuyruk','s_hizmetler','s_kesit','s_arsiv','s_katalog','s_duyurular','s_istatistik','istem_ver','uzman_adina','durum_degistir','teslim_al','sil','duzeltme','katalog_duzenle','duyuru_yayinla','duyuru_yonet','yazdir')$k$;
begin
  execute 'alter table rol_yetkileri drop constraint if exists rol_yetkileri_yetki_chk';
  execute 'alter table rol_yetkileri add constraint rol_yetkileri_yetki_chk check (yetki in ' || kodlar || ')';
  execute 'alter table rol_yetkileri drop constraint if exists rol_yetkileri_profil_chk';
  execute $p$alter table rol_yetkileri add constraint rol_yetkileri_profil_chk check (profil in
    ('uzman','asistan','teknisyen-immun','teknisyen-histomol','teknisyen-sito','teknisyen-ekipsiz','kesit','arsiv','sekreter'))$p$;
  execute 'alter table kullanici_yetkileri drop constraint if exists kullanici_yetkileri_yetki_chk';
  execute 'alter table kullanici_yetkileri add constraint kullanici_yetkileri_yetki_chk check (yetki in ' || kodlar || ')';
  execute 'alter table kullanici_yetkileri drop constraint if exists kullanici_yetkileri_kaynak_chk';
  execute $p$alter table kullanici_yetkileri add constraint kullanici_yetkileri_kaynak_chk check (kaynak in ('otomatik', 'elle'))$p$;
  execute 'alter table ekip_gruplari drop constraint if exists ekip_gruplari_ekip_chk';
  execute $p$alter table ekip_gruplari add constraint ekip_gruplari_ekip_chk check (ekip in ('immun', 'histomol', 'sito', 'kesit'))$p$;
end $kisit$;

alter table rol_yetkileri enable row level security;
alter table kullanici_yetkileri enable row level security;
alter table ekip_gruplari enable row level security;
alter table yetki_kurulum enable row level security;
revoke all on rol_yetkileri, kullanici_yetkileri, ekip_gruplari, yetki_kurulum from anon, authenticated;
grant select, insert, update, delete on rol_yetkileri, kullanici_yetkileri, ekip_gruplari to authenticated;

do $pol$
declare
  t text;
begin
  foreach t in array array['rol_yetkileri', 'kullanici_yetkileri', 'ekip_gruplari'] loop
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_yaz', t);
    execute format('create policy %I on %I for select to authenticated using (true)', t || '_select', t);
    execute format('create policy %I on %I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t || '_yaz', t);
  end loop;
end $pol$;

create or replace function public.yetki_profili(p_rol text, p_ekip text) returns text
language sql immutable as $$
  select case
    when p_ekip in ('sekreter', 'arsiv', 'kesit') then p_ekip
    when p_rol = 'teknisyen' then 'teknisyen-' || case when p_ekip in ('immun', 'histomol', 'sito') then p_ekip else 'ekipsiz' end
    when p_rol = 'uzman' then 'uzman'
    else 'asistan'
  end
$$;

-- Asıl kontrol. Oturum yoksa (SQL Editor, service_role) false döner —
-- tetikleyiciler oturumsuz çağrıları ayrıca serbest bırakır (auth.uid() boş).
create or replace function public.yetki_var(p_kod text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select u.is_admin
        or coalesce(
             (select ky.izin from kullanici_yetkileri ky where ky.kullanici_id = u.id and ky.yetki = p_kod),
             exists (select 1 from rol_yetkileri ry
                     where ry.profil = public.yetki_profili(u.rol, u.ekip) and ry.yetki = p_kod))
    from kullanicilar u
    where u.auth_user_id = auth.uid() and u.aktif
    limit 1), false)
$$;
revoke all on function public.yetki_var(text) from public, anon;
grant execute on function public.yetki_var(text) to authenticated;

-- Uygulamanın oturum başında (ve yetki değişince) okuduğu özet.
create or replace function public.yetkilerim() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'surum', 1,
    'profil', public.yetki_profili(u.rol, u.ekip),
    'yonetici', u.is_admin,
    'yetkiler', coalesce((
      select jsonb_agg(k.kod order by k.kod)
      from unnest(array['s_kuyruk','s_hizmetler','s_kesit','s_arsiv','s_katalog','s_duyurular','s_istatistik','istem_ver',
                        'uzman_adina','durum_degistir','teslim_al','sil','duzeltme','katalog_duzenle','duyuru_yayinla',
                        'duyuru_yonet','yazdir']) as k(kod)
      where u.is_admin
         or coalesce((select ky.izin from kullanici_yetkileri ky where ky.kullanici_id = u.id and ky.yetki = k.kod),
                     exists (select 1 from rol_yetkileri ry
                             where ry.profil = public.yetki_profili(u.rol, u.ekip) and ry.yetki = k.kod))
    ), '[]'::jsonb),
    'ana_gruplar', coalesce((select jsonb_agg(eg.grup_kod) from ekip_gruplari eg where eg.ekip = u.ekip), '[]'::jsonb)
  )
  from kullanicilar u
  where u.auth_user_id = auth.uid() and u.aktif
  limit 1
$$;
revoke all on function public.yetkilerim() from public, anon;
grant execute on function public.yetkilerim() to authenticated;

-- ------------------------------------------------------------
-- 5) Başlangıç verisi (BİR KEZ): bugünkü davranış
-- ------------------------------------------------------------
do $tohum$
declare
  kodlar constant text[] := array['s_kuyruk','s_hizmetler','s_kesit','s_arsiv','s_katalog','s_duyurular','s_istatistik','istem_ver',
                                  'uzman_adina','durum_degistir','teslim_al','sil','duzeltme','katalog_duzenle','duyuru_yayinla',
                                  'duyuru_yonet','yazdir'];
  p record;
  k text;
  n int;
  nt int;
  varsayilan boolean;
begin
  if exists (select 1 from yetki_kurulum where anahtar = 'ilk') then
    raise notice 'Yetki başlangıç verisi daha önce yazılmış — atlandı';
    return;
  end if;

  -- Bugünkü kural (rol / ekip): yönetici olmayan kullanıcının hakkı.
  create temp table _bugun on commit drop as
  select u.id, u.rol, u.ekip, public.yetki_profili(u.rol, u.ekip) as profil, kk.kod,
         case kk.kod
           when 's_arsiv' then coalesce(u.ekip = 'arsiv', false)
           when 's_istatistik' then false
           when 'istem_ver' then u.rol <> 'teknisyen'
           when 'uzman_adina' then u.rol <> 'teknisyen'
           when 'teslim_al' then u.rol <> 'teknisyen'
           when 'durum_degistir' then u.rol = 'teknisyen'
           when 'duyuru_yonet' then u.rol = 'teknisyen'
           when 'katalog_duzenle' then u.rol = 'uzman' or coalesce(u.ekip = 'immun', false)
           else true
         end as hak
  from kullanicilar u cross join unnest(kodlar) as kk(kod)
  where not u.is_admin;

  -- Profil varsayılanı: o profildeki kullanıcıların çoğunluğu; kullanıcı
  -- yoksa (ya da eşitlikte) profilin tipik üyesi.
  for p in select * from (values
      ('uzman', 'uzman', null), ('asistan', 'asistan', null),
      ('teknisyen-immun', 'teknisyen', 'immun'), ('teknisyen-histomol', 'teknisyen', 'histomol'),
      ('teknisyen-sito', 'teknisyen', 'sito'), ('teknisyen-ekipsiz', 'teknisyen', null),
      ('kesit', 'teknisyen', 'kesit'), ('arsiv', 'teknisyen', 'arsiv'), ('sekreter', 'asistan', 'sekreter')
    ) as t(profil, rol, ekip)
  loop
    foreach k in array kodlar loop
      select count(*), count(*) filter (where hak) into n, nt from _bugun b where b.profil = p.profil and b.kod = k;
      if n > 0 and nt * 2 <> n then
        varsayilan := nt * 2 > n;
      else
        varsayilan := case k
          when 's_arsiv' then p.ekip is not distinct from 'arsiv'
          when 's_istatistik' then false
          when 'istem_ver' then p.rol <> 'teknisyen'
          when 'uzman_adina' then p.rol <> 'teknisyen'
          when 'teslim_al' then p.rol <> 'teknisyen'
          when 'durum_degistir' then p.rol = 'teknisyen'
          when 'duyuru_yonet' then p.rol = 'teknisyen'
          when 'katalog_duzenle' then p.rol = 'uzman' or p.ekip is not distinct from 'immun'
          else true
        end;
      end if;
      if varsayilan then
        insert into rol_yetkileri (profil, yetki) values (p.profil, k) on conflict do nothing;
      end if;
    end loop;
  end loop;

  -- Profilinden farklı çıkan kullanıcıya otomatik kişi istisnası.
  insert into kullanici_yetkileri (kullanici_id, yetki, izin, kaynak, sebep)
  select b.id, b.kod, b.hak, 'otomatik',
         case when b.kod = 'katalog_duzenle'
              then case when b.hak then 'katalog düzenleme varsayılanı: ' || case when b.rol = 'uzman' then 'uzman' else 'immün ekibi' end
                        else 'katalog düzenleme varsayılanı: uzman ya da immün ekibi değil' end
              else concat_ws(' ', case b.ekip when 'immun' then 'immün ekibinde' when 'histomol' then 'histokimya-moleküler ekibinde'
                                              when 'sito' then 'sitoloji ekibinde' when 'kesit' then 'kesit ekibinde'
                                              when 'arsiv' then 'arşiv ekibinde' when 'sekreter' then 'sekreter ekibinde' end,
                             case b.rol when 'uzman' then 'uzman' when 'asistan' then 'asistan' else 'teknisyen' end)
                   || case when b.hak then '; bugünkü hakkı korundu' else '; bugünkü kısıtı korundu' end
         end
  from _bugun b
  where b.hak is distinct from exists (select 1 from rol_yetkileri ry where ry.profil = b.profil and ry.yetki = b.kod)
  on conflict do nothing;

  -- "Ekibim" grupları: ekibin kendi grupları; immün = kendi grupları + HK + Yeni Kesit.
  insert into ekip_gruplari (ekip, grup_kod)
  select g.ekip, g.kod from test_gruplari g where g.ekip in ('immun', 'histomol', 'sito', 'kesit')
  on conflict do nothing;
  insert into ekip_gruplari (ekip, grup_kod)
  select 'immun', g.kod from test_gruplari g where g.kod in ('hk', 'kesit')
  on conflict do nothing;

  insert into yetki_kurulum (anahtar) values ('ilk');
end $tohum$;

-- ------------------------------------------------------------
-- 6) Son aktif yönetici korunur (kimse sistemi yöneticisiz bırakamaz).
-- ------------------------------------------------------------
create or replace function public.kullanicilar_son_yonetici() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.is_admin and old.aktif
     and (tg_op = 'DELETE' or not new.is_admin or not new.aktif)
     and not exists (select 1 from kullanicilar where is_admin and aktif and id <> old.id) then
    raise exception 'Son aktif yöneticinin yönetici yetkisi kaldırılamaz' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
drop trigger if exists kullanicilar_son_yonetici on kullanicilar;
create trigger kullanicilar_son_yonetici before update or delete on kullanicilar
  for each row execute function public.kullanicilar_son_yonetici();

commit;

select 'Parça 2/4 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 7) İşlemleri yetki_var'a bağlama (RLS / tetikleyici / RPC)
--    Uzun fonksiyonlarda yalnız yetki satırı değiştirilir (kaynağın geri
--    kalanı aynen kalır). Geri alma: yetki_katalog_sema_geri_al.sql
-- ------------------------------------------------------------
create or replace function public._yetki_yama(p_fn text, p_eski text, p_yeni text) returns text
language plpgsql as $$
declare
  f regprocedure := to_regprocedure(p_fn);
  src text;
begin
  if f is null then return p_fn || ': fonksiyon yok (atlandı)'; end if;
  src := pg_get_functiondef(f);
  if position(p_yeni in src) > 0 then return p_fn || ': zaten bağlı'; end if;
  if position(p_eski in src) = 0 then return p_fn || ': BEKLENEN SATIR BULUNAMADI — bağlanamadı'; end if;
  execute replace(src, p_eski, p_yeni);
  return p_fn || ': bağlandı';
end $$;

do $bagla$
declare
  s text;
begin
  -- Kesildi / geri al: durum değiştirme yetkisi
  foreach s in array array['public.blok_kesildi(uuid[])', 'public.blok_kesildi_geri_al(uuid[])'] loop
    raise notice '%', public._yetki_yama(s,
      $e$not (public.is_admin() or coalesce(public.current_rol(), '') = 'teknisyen')$e$,
      $y$not public.yetki_var('durum_degistir')$y$);
  end loop;
  -- Düzeltme: giren kişi + düzeltme yetkisi (yönetici her zaman)
  raise notice '%', public._yetki_yama('public.istem_duzelt(uuid,jsonb)',
    $e$if not (public.is_admin() or i.istem_yapan_id = ben) then$e$,
    $y$if not (public.is_admin() or (i.istem_yapan_id = ben and public.yetki_var('duzeltme'))) then$y$);
  -- İstatistik: ayrı yetki
  raise notice '%', public._yetki_yama('public.istatistik(date,date,text)',
    $e$if not (public.is_admin() or current_user in$e$,
    $y$if not (public.yetki_var('s_istatistik') or current_user in$y$);
end $bagla$;

-- Durum değiştirme (İşleme Al / Tamamla / Geri Al)
create or replace function public.istem_kalemleri_geri_alma_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null
     and new.durum is distinct from old.durum
     and not public.yetki_var('durum_degistir')
  then
    raise exception 'Durum değiştirme yetkiniz yok' using errcode = '42501';
  end if;
  return new;
end $$;

-- Blok çıkarma: Arşiv sayfası ya da durum değiştirme yetkisi
create or replace function public.blok_cikarma_yetkisi() returns boolean
language sql stable security definer set search_path = public as $$
  select public.yetki_var('s_arsiv') or public.yetki_var('durum_degistir')
$$;

-- Teslim alma: yönetici, ya da teslim yetkisi + kendi istemi / adına istenen
create or replace function public.teslim_yetkisi(p_istem_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (public.yetki_var('teslim_al')
          and exists (
            select 1 from istemler i
            where i.id = p_istem_id
              and public.current_kullanici_id() in (i.istem_yapan_id, i.uzman_id)
          ))
$$;

-- Test değişikliği yalnız Bekleyen kalemde — birleştirme (test_birlestir) hariç.
create or replace function public.istem_kalemleri_test_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null
     and coalesce(current_setting('istem.test_birlestirme', true), '') <> 'on'
     and (new.test_id is distinct from old.test_id
          or new.ozel_test is distinct from old.ozel_test
          or new.grup is distinct from old.grup)
     and old.durum <> 'bekleyen'
  then
    raise exception 'Test yalnız Bekleyen kalemde düzeltilebilir — önce Bekleyen''e geri alın' using errcode = '42501';
  end if;
  return new;
end $$;

-- Uzman adına istem: yetkisi olmayan (ama istem verebilen) yalnız kendi adına.
create or replace function public.istemler_uzman_adina_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null
     and new.uzman_id is not null
     and (tg_op = 'INSERT' or new.uzman_id is distinct from old.uzman_id)
     and new.uzman_id is distinct from public.current_kullanici_id()
     and public.yetki_var('istem_ver')
     and not public.yetki_var('uzman_adina')
  then
    raise exception 'Başka bir uzman adına istem verme yetkiniz yok' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists istemler_uzman_adina_kontrol on istemler;
create trigger istemler_uzman_adina_kontrol before insert or update of uzman_id on istemler
  for each row execute function public.istemler_uzman_adina_kontrol();

-- Kontrol listesi (eski RPC; içe aktarma katalog_ice_aktar'dır)
create or replace function public.katalog_kontrol_yukle(p_liste jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  n int;
begin
  if not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  if jsonb_typeof(p_liste) is distinct from 'array' then
    raise exception 'Liste bir dizi olmalı' using errcode = '22023';
  end if;
  update test_katalog t
     set kontrol = nullif(btrim(x.kontrol), '')
    from jsonb_to_recordset(p_liste) as x(id uuid, kontrol text)
   where t.id = x.id
     and t.kontrol is distinct from nullif(btrim(x.kontrol), '');
  get diagnostics n = row_count;
  return jsonb_build_object('guncellenen', n);
end $$;

-- RLS
drop policy if exists test_katalog_insert on test_katalog;
drop policy if exists test_katalog_update on test_katalog;
drop policy if exists test_katalog_delete on test_katalog;
create policy test_katalog_insert on test_katalog for insert to authenticated
  with check ((select public.yetki_var('katalog_duzenle')));
create policy test_katalog_update on test_katalog for update to authenticated
  using ((select public.yetki_var('katalog_duzenle'))) with check ((select public.yetki_var('katalog_duzenle')));
create policy test_katalog_delete on test_katalog for delete to authenticated using (false);

drop policy if exists istem_kalemleri_insert on istem_kalemleri;
create policy istem_kalemleri_insert on istem_kalemleri for insert to authenticated
  with check (
    exists (select 1 from istemler i
            where i.id = istem_kalemleri.istem_id
              and (i.istem_yapan_id = (select public.current_kullanici_id()) or (select public.is_admin())))
    and (tekrar_kaynagi_id is null
         or public.tekrar_kaynagi_gecerli(tekrar_kaynagi_id, istem_id, blok_no, test_id, ozel_test, grup))
    and (tekrar_kaynagi_id is not null or (select public.yetki_var('istem_ver')))
  );
drop policy if exists istem_kalemleri_delete on istem_kalemleri;
create policy istem_kalemleri_delete on istem_kalemleri for delete to authenticated
  using (
    (select public.is_admin())
    or ((select public.yetki_var('sil'))
        and durum <> 'tamamlandi'
        and exists (select 1 from istemler i
                    where i.id = istem_kalemleri.istem_id
                      and i.istem_yapan_id = (select public.current_kullanici_id())))
  );
drop policy if exists istemler_delete on istemler;
create policy istemler_delete on istemler for delete to authenticated
  using (
    (select public.is_admin())
    or ((select public.yetki_var('sil'))
        and istem_yapan_id = (select public.current_kullanici_id())
        and not exists (select 1 from istem_kalemleri k where k.istem_id = istemler.id))
  );

drop policy if exists duyurular_insert on duyurular;
create policy duyurular_insert on duyurular for insert to authenticated
  with check (yazan_id = (select public.current_kullanici_id()) and (select public.yetki_var('duyuru_yayinla')));
drop policy if exists duyurular_update on duyurular;
create policy duyurular_update on duyurular for update to authenticated
  using (yazan_id = (select public.current_kullanici_id()) or (select public.yetki_var('duyuru_yonet')))
  with check (yazan_id = (select public.current_kullanici_id()) or (select public.yetki_var('duyuru_yonet')));

commit;

notify pgrst, 'reload schema';

select 'Parça 3/4 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 8) Liste içe aktarma — tek işlem. p_islemler (önizlemede onaylananlar):
--      {"islem":"ekle","grup":"ihc","ad":"CD71","klon":"..","kontrol":"..","aciklama":"..","es_adlar":[".."]}
--      {"islem":"guncelle","id":"<test>","klon":"..","kontrol":"..","aciklama":".."}  (verilen alanlar)
--      {"islem":"es_ad","id":"<test>","es_ad":"HER2"}
--    p_duyuru false (varsayılan): yeni testler için duyuru / bildirim YOK.
--    p_duyuru true: tek test → kendi duyurusu; birden çok → TEK özet duyuru.
-- ------------------------------------------------------------
create or replace function public.katalog_ice_aktar(p_islemler jsonb, p_duyuru boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  n_ekle int := 0;
  n_gunc int := 0;
  n_es int := 0;
  n int;
  x record;
begin
  if public.current_kullanici_id() is null or not public.yetki_var('katalog_duzenle') then
    raise exception 'Katalog düzenleme yetkiniz yok' using errcode = '42501';
  end if;
  if jsonb_typeof(p_islemler) is distinct from 'array' then
    raise exception 'İşlem listesi bir dizi olmalı' using errcode = '22023';
  end if;
  if jsonb_array_length(p_islemler) > 2000 then
    raise exception 'Bir seferde en fazla 2000 satır içe aktarılabilir' using errcode = '22023';
  end if;
  perform set_config('istem.katalog_duyuru', case when coalesce(p_duyuru, false) then 'acik' else 'kapali' end, true);

  for x in select t.id, btrim(t.es_ad) as es_ad
           from jsonb_to_recordset(p_islemler) as t(islem text, id uuid, es_ad text)
           where t.islem = 'es_ad' and t.id is not null and btrim(coalesce(t.es_ad, '')) <> ''
  loop
    update test_katalog k set es_adlar = k.es_adlar || x.es_ad
    where k.id = x.id
      and public.test_anahtar(k.ad) <> public.test_anahtar(x.es_ad)
      and not exists (select 1 from unnest(k.es_adlar) e where public.test_anahtar(e) = public.test_anahtar(x.es_ad));
    get diagnostics n = row_count;
    n_es := n_es + n;
  end loop;

  update test_katalog k
     set klon = case when gu.j ? 'klon' then nullif(btrim(coalesce(gu.j->>'klon', '')), '') else k.klon end,
         kontrol = case when gu.j ? 'kontrol' then nullif(btrim(coalesce(gu.j->>'kontrol', '')), '') else k.kontrol end,
         aciklama = case when gu.j ? 'aciklama' then nullif(btrim(coalesce(gu.j->>'aciklama', '')), '') else k.aciklama end
    from (select e.j, (e.j->>'id')::uuid as id from jsonb_array_elements(p_islemler) as e(j) where e.j->>'islem' = 'guncelle') gu
   where k.id = gu.id
     and ((gu.j ? 'klon' and k.klon is distinct from nullif(btrim(coalesce(gu.j->>'klon', '')), ''))
       or (gu.j ? 'kontrol' and k.kontrol is distinct from nullif(btrim(coalesce(gu.j->>'kontrol', '')), ''))
       or (gu.j ? 'aciklama' and k.aciklama is distinct from nullif(btrim(coalesce(gu.j->>'aciklama', '')), '')));
  get diagnostics n_gunc = row_count;

  insert into test_katalog (grup, ad, klon, kontrol, aciklama, es_adlar, sira)
  select y.grup, y.ad, nullif(btrim(coalesce(y.klon, '')), ''), nullif(btrim(coalesce(y.kontrol, '')), ''),
         nullif(btrim(coalesce(y.aciklama, '')), ''), coalesce(y.es_adlar, '{}'),
         coalesce((select max(k.sira) from test_katalog k where k.grup = y.grup), 0) + 10 * row_number() over (partition by y.grup order by y.sira)
  from (
    select e.j->>'grup' as grup, e.j->>'ad' as ad, e.j->>'klon' as klon, e.j->>'kontrol' as kontrol, e.j->>'aciklama' as aciklama,
           case when jsonb_typeof(e.j->'es_adlar') = 'array' then array(select jsonb_array_elements_text(e.j->'es_adlar')) end as es_adlar,
           e.sira
    from jsonb_array_elements(p_islemler) with ordinality as e(j, sira)
    where e.j->>'islem' = 'ekle'
  ) y
  order by y.sira;
  get diagnostics n_ekle = row_count;

  return jsonb_build_object('eklenen', n_ekle, 'guncellenen', n_gunc, 'es_ad', n_es);
end $$;
revoke all on function public.katalog_ice_aktar(jsonb, boolean) from public, anon;
grant execute on function public.katalog_ice_aktar(jsonb, boolean) to authenticated;

-- ------------------------------------------------------------
-- 9) Birleştirme — tek işlem. p_onizleme true: yalnız sayılar.
--    test_katalog'a bağlı TÜM tablolar (yabancı anahtarlar) taşınır: istem
--    kalemleri, şablon ve set kalemleri, duyurular ve sonradan eklenenler.
--    Şablon / sette iki test de varsa giden satır silinir (çift kalmasın).
--    Giden: pasif + birlesti_id. Kalan: gidenin adı ve eş adları eş ad
--    olur; boş klon / kontrol / açıklama gidenden dolar.
-- ------------------------------------------------------------
create or replace function public.test_birlestir(p_kalan uuid, p_giden uuid, p_onizleme boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  k test_katalog%rowtype;
  g test_katalog%rowtype;
  fk record;
  n int;
  sayilar jsonb := '{}'::jsonb;
  yeni_es text[];
  ust text;
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
  if k.grup <> g.grup then raise exception 'Yalnız aynı gruptaki testler birleştirilebilir' using errcode = '22023'; end if;
  if k.birlesti_id is not null or g.birlesti_id is not null then
    raise exception 'Bu testlerden biri zaten başka bir testle birleştirilmiş' using errcode = '22023';
  end if;

  for fk in
    select c.conrelid::regclass as tablo, c.conrelid::regclass::text as ad, a.attname as kolon
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.test_katalog'::regclass and array_length(c.conkey, 1) = 1
      and c.conrelid not in ('public.test_katalog'::regclass, 'public.test_katalog_log'::regclass)
    order by 2
  loop
    execute format('select count(*) from %s where %I = $1', fk.tablo, fk.kolon) into n using p_giden;
    sayilar := sayilar || jsonb_build_object(fk.ad, n);
    if not p_onizleme and n > 0 then
      perform set_config('istem.test_birlestirme', 'on', true);
      -- Aynı şablon / sette kalan test zaten varsa giden satır çift olur → silinir.
      ust := case fk.ad when 'sablon_kalemleri' then 'sablon_id' when 'istek_seti_kalemleri' then 'istek_seti_id' end;
      if ust is not null then
        execute format('delete from %1$s x where x.%2$I = $2 and exists (select 1 from %1$s y where y.%3$I = x.%3$I and y.%2$I = $1)',
                       fk.tablo, fk.kolon, ust) using p_kalan, p_giden;
      end if;
      execute format('update %s set %I = $1 where %I = $2', fk.tablo, fk.kolon, fk.kolon) using p_kalan, p_giden;
    end if;
  end loop;

  -- Kalanın yeni eş adları: gidenin adı + eş adları (kalanda olmayanlar).
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
    update test_katalog set aktif = false, birlesti_id = p_kalan where id = p_giden;
    update test_katalog
       set es_adlar = es_adlar || yeni_es,
           klon = coalesce(klon, g.klon),
           kontrol = coalesce(nullif(btrim(coalesce(kontrol, '')), ''), g.kontrol),
           aciklama = coalesce(aciklama, g.aciklama)
     where id = p_kalan;
    insert into test_katalog_log (test_id, alan, eski, yeni, degistiren_id)
    values (p_kalan, 'birlestirme', g.ad, k.ad, ben), (p_giden, 'birlestirme', g.ad, k.ad, ben);
    perform set_config('istem.test_birlestirme', '', true);
  end if;

  return jsonb_build_object(
    'onizleme', p_onizleme,
    'kalan', jsonb_build_object('id', k.id, 'ad', k.ad),
    'giden', jsonb_build_object('id', g.id, 'ad', g.ad),
    'sayilar', sayilar,
    'eklenecek_es_adlar', to_jsonb(yeni_es),
    'doldurulacak', jsonb_strip_nulls(jsonb_build_object(
      'klon', case when k.klon is null then g.klon end,
      'kontrol', case when nullif(btrim(coalesce(k.kontrol, '')), '') is null then g.kontrol end,
      'aciklama', case when k.aciklama is null then g.aciklama end))
  );
end $$;
revoke all on function public.test_birlestir(uuid, uuid, boolean) from public, anon;
grant execute on function public.test_birlestir(uuid, uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 10) Canlı yayın (performans_sema.sql kuruluysa): katalog, gruplar ve
--     yetki tabloları değişince açık ekranlar tazelensin.
-- ------------------------------------------------------------
do $cy$
declare
  tablo text;
begin
  if to_regprocedure('public.canli_yayin_tetik()') is null then
    raise notice 'canli_yayin_tetik yok (performans_sema.sql kurulu değil) — canlı tazeleme eklenmedi';
    return;
  end if;
  foreach tablo in array array['test_katalog', 'test_gruplari', 'rol_yetkileri', 'kullanici_yetkileri', 'ekip_gruplari'] loop
    execute format('drop trigger if exists %I on public.%I', tablo || '_canli_yayin', tablo);
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function public.canli_yayin_tetik()',
                   tablo || '_canli_yayin', tablo);
  end loop;
end $cy$;

drop function if exists public._yetki_yama(text, text, text);

commit;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- SONUÇ: otomatik yazılan kişi istisnaları (yoksa tek satır bilgi).
-- Mevcut çift kayıtlar (aynı grupta aynı anahtar) için:
--   select grup, public.test_anahtar(ad), string_agg(ad, ' | ') from test_katalog
--   where birlesti_id is null group by 1, 2 having count(*) > 1;
-- ------------------------------------------------------------
select u.ad_soyad as kullanici,
       ky.yetki,
       case when ky.izin then 'VER' else 'AL' end as islem,
       ky.sebep
from kullanici_yetkileri ky
join kullanicilar u on u.id = ky.kullanici_id
where ky.kaynak = 'otomatik'
union all
select 'Parça 4/4 tamam — otomatik kişi istisnası yok', null, null, null
where not exists (select 1 from kullanici_yetkileri where kaynak = 'otomatik')
order by 1, 2;
