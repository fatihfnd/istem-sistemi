-- ============================================================
-- yetki_sema.sql — Admin / rol bazlı yetkiler + boya tekrarı +
-- kalite notu + şablon paylaşımı
--
-- secure_rls_authenticated.sql'den SONRA, YENİ KOD DEPLOY EDİLMEDEN
-- ÖNCE Supabase SQL Editor'de çalıştırın (yeni kod girişte
-- kullanicilar.is_admin'i okur — kolon yoksa giriş kırılır).
-- İDEMPOTENT'tir, tek transaction'dır: herhangi bir kontrol başarısız
-- olursa HİÇBİR değişiklik uygulanmaz.
--
-- ÖN KONTROL (isteğe bağlı, önce bunu çalıştırıp bakabilirsiniz):
--   select id, ad_soyad, rol, aktif, auth_user_id is not null as auth_var
--   from kullanicilar
--   where lower(ad_soyad) like '%demir%' or lower(ad_soyad) like '%fatih%'
--   order by ad_soyad;
--
-- Özet:
--  - kullanicilar.is_admin            (ilk admin: Öğr. Gör. Dr. Fatih Demir)
--  - istem_kalemleri.tekrar_kaynagi_id (boya tekrarı → kaynak kalem)
--  - istem_kalemleri.kalite_notu       (boya kalite değerlendirmesi)
--  - sablonlar.herkese_acik            (kişisel / herkese açık şablon)
--  - tekrar_iste() RPC                 (tekrarı tek transaction'da açar)
--  - Rol bazlı RLS: kullanicilar, test_gruplari, test_katalog,
--    istek_setleri, istek_seti_kalemleri, istemler, istem_kalemleri,
--    sablonlar, sablon_kalemleri, storage "yedekler"
--  - Kolon bazlı UPDATE izinleri (istemler, istem_kalemleri)
--  - Durum geri alma (Tamamlandı→Cihazda, Cihazda→Bekleyen) sadece
--    admin + teknisyen — trigger ile (RLS politikası eski ve yeni
--    satırı aynı anda göremediği için geçiş kontrolü trigger'da)
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 0) Ön koşul: herkes Supabase Auth'a taşınmış olmalı. Rol/admin
-- kontrolleri auth.uid() → kullanicilar.auth_user_id eşlemesiyle
-- yapılıyor; Auth hesabı olmayan biri hiçbir şey yapamaz hale gelir.
-- ------------------------------------------------------------
do $$
declare
  n int;
begin
  select count(*) into n from kullanicilar where aktif and auth_user_id is null;
  if n > 0 then
    raise exception 'Auth hesabı olmayan % aktif kullanıcı var — önce Kullanıcılar sayfasında "Auth hesabı olmayanları taşı" çalıştırın.', n;
  end if;
end $$;

-- ------------------------------------------------------------
-- 1) Kolonlar
-- ------------------------------------------------------------
alter table kullanicilar    add column if not exists is_admin boolean not null default false;
-- Kaynak kalem silinirse tekrar satırı kalır, sadece bağ kopar.
alter table istem_kalemleri add column if not exists tekrar_kaynagi_id uuid references istem_kalemleri(id) on delete set null;
alter table istem_kalemleri add column if not exists kalite_notu text;
alter table sablonlar       add column if not exists herkese_acik boolean not null default false;

create index if not exists istem_kalemleri_tekrar_kaynagi_idx on istem_kalemleri (tekrar_kaynagi_id);
create index if not exists sablonlar_herkese_acik_idx on sablonlar (herkese_acik) where herkese_acik;

-- ------------------------------------------------------------
-- 2) İlk admin — SADECE henüz hiç admin yoksa çalışır (yeniden
-- çalıştırmada atlanır). id + birebir ad ile sabitlenmiştir; birebir
-- eşleşme tek değilse ya da benzer isimli BAŞKA bir satır (pasifler
-- dahil — ör. "Dr. F. Demir", "fatih demir") varsa hiçbir şey
-- yapmadan durur ve eşleşen satırları listeler. En yakın eşleşme
-- ASLA otomatik seçilmez.
-- ------------------------------------------------------------
do $$
declare
  hedef_ad constant text := 'Öğr. Gör. Dr. Fatih Demir';
  hedef_id constant uuid := 'c32accec-dba5-4904-b4fa-211fa495dd32';
  tam int;
  hedef_ok boolean;
  benzer text;
begin
  if exists (select 1 from kullanicilar where is_admin) then
    return;
  end if;

  select count(*) into tam from kullanicilar where ad_soyad = hedef_ad;
  select exists (
    select 1 from kullanicilar
    where id = hedef_id and ad_soyad = hedef_ad and aktif and auth_user_id is not null
  ) into hedef_ok;
  select string_agg(format('%s | %s | rol=%s | aktif=%s', id, ad_soyad, rol, aktif), E'\n' order by ad_soyad)
    into benzer
  from kullanicilar
  where id <> hedef_id
    and (lower(ad_soyad) like '%fatih%'
         or (lower(ad_soyad) like '%demir%' and lower(ad_soyad) ~ '(^|[^[:alpha:]])f\.'));

  if tam <> 1 or not hedef_ok or benzer is not null then
    raise exception E'İlk admin belirlenemedi — elle seçim gerekli, hiçbir değişiklik uygulanmadı.\n"%" ile birebir eşleşen satır sayısı: % (beklenen id % aktif+Auth hesaplı mı: %)\nBenzer isimli diğer satırlar:\n%',
      hedef_ad, tam, hedef_id, hedef_ok, coalesce(benzer, '(yok)');
  end if;

  update kullanicilar set is_admin = true where id = hedef_id;
end $$;

-- ------------------------------------------------------------
-- 3) Yardımcı fonksiyonlar — oturumdaki kullanıcının kim olduğu.
-- security definer: RLS politikalarının İÇİNDE kullanicilar okunurken
-- (o tablonun kendi RLS'ine takılıp) özyineleme olmasın diye.
-- Pasif kullanıcı (aktif=false) geçerli bir JWT taşısa bile hiçbir
-- yetki kazanmaz.
-- ------------------------------------------------------------
create or replace function public.current_kullanici_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from kullanicilar where auth_user_id = auth.uid() and aktif limit 1
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from kullanicilar where auth_user_id = auth.uid() and aktif limit 1), false)
$$;

create or replace function public.current_rol() returns text
language sql stable security definer set search_path = public as $$
  select rol from kullanicilar where auth_user_id = auth.uid() and aktif limit 1
$$;

-- Teknisyen kuralı: rolü teknisyen olan (admin olmayan) kullanıcı.
create or replace function public.is_teknisyen() returns boolean
language sql stable security definer set search_path = public as $$
  select not public.is_admin() and coalesce(public.current_rol(), '') = 'teknisyen'
$$;

-- Bir tekrar satırı GERÇEKTEN kaynağının tekrarı mı: kaynak Cihazda/
-- Tamamlandı olmalı, aynı patoloji no / blok / test / grup taşımalı.
-- Bu olmadan teknisyen rastgele bir tekrar_kaynagi_id yazarak
-- istediği testi girebilirdi.
create or replace function public.tekrar_kaynagi_gecerli(
  p_kaynak uuid, p_istem uuid, p_blok text, p_test uuid, p_ozel text, p_grup text
) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from istem_kalemleri k
    join istemler ki on ki.id = k.istem_id
    join istemler hi on hi.id = p_istem
    where k.id = p_kaynak
      and k.durum in ('cihazda', 'tamamlandi')
      and ki.patoloji_no = hi.patoloji_no
      and k.blok_no = p_blok
      and k.test_id is not distinct from p_test
      and k.ozel_test is not distinct from p_ozel
      and k.grup = p_grup
  )
$$;

-- Şablon görme / düzenleme kuralı (sablonlar + sablon_kalemleri ortak).
-- Teknisyen şablonlara hiç erişemez; admin hepsini görür/düzenler.
create or replace function public.sablon_okunabilir(p_sahip uuid, p_herkese_acik boolean) returns boolean
language sql stable set search_path = public as $$
  select public.is_admin()
      or (not public.is_teknisyen() and (p_sahip = public.current_kullanici_id() or p_herkese_acik))
$$;

create or replace function public.sablon_duzenlenebilir(p_sahip uuid) returns boolean
language sql stable set search_path = public as $$
  select public.is_admin()
      or (not public.is_teknisyen() and p_sahip = public.current_kullanici_id())
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'current_kullanici_id()', 'is_admin()', 'current_rol()', 'is_teknisyen()',
    'tekrar_kaynagi_gecerli(uuid, uuid, text, uuid, text, text)',
    'sablon_okunabilir(uuid, boolean)', 'sablon_duzenlenebilir(uuid)'
  ]
  loop
    execute format('revoke all on function public.%s from public, anon', fn);
    execute format('grant execute on function public.%s to authenticated', fn);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4) Boya tekrarı — tek transaction'da yeni istem başlığı + yeni
-- kalem (Bekleyen, tekrar_kaynagi_id dolu) + durum logu. security
-- INVOKER: çağıranın RLS'i aynen uygulanır (teknisyen kuralı dahil).
-- Yeni istem kaynağın patoloji no / uzman / önceliğini alır;
-- istem_yapan = tıklayan kişi, not = (varsa) tekrar nedeni.
-- ------------------------------------------------------------
create or replace function public.tekrar_iste(p_kalem_id uuid, p_not text default null) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  k istem_kalemleri%rowtype;
  i istemler%rowtype;
  yeni_istem uuid;
  yeni_kalem uuid;
begin
  if ben is null then
    raise exception 'Oturum kullanıcısı bulunamadı';
  end if;
  select * into k from istem_kalemleri where id = p_kalem_id;
  if not found then
    raise exception 'Kalem bulunamadı';
  end if;
  if k.durum not in ('cihazda', 'tamamlandi') then
    raise exception 'Sadece Cihazda/Tamamlandı kalemler tekrar istenebilir';
  end if;
  select * into i from istemler where id = k.istem_id;

  insert into istemler (patoloji_no, istem_yapan_id, uzman_id, oncelik, not_metni)
  values (i.patoloji_no, ben, i.uzman_id, i.oncelik, nullif(btrim(p_not), ''))
  returning id into yeni_istem;

  insert into istem_kalemleri (istem_id, blok_no, test_id, ozel_test, grup, tekrar_kaynagi_id)
  values (yeni_istem, k.blok_no, k.test_id, k.ozel_test, k.grup, k.id)
  returning id into yeni_kalem;

  insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
  values (yeni_kalem, null, 'bekleyen', ben);

  return yeni_kalem;
end $$;

revoke all on function public.tekrar_iste(uuid, text) from public, anon;
grant execute on function public.tekrar_iste(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 5) Durum geri alma — sadece admin ve teknisyen. RLS politikası
-- UPDATE'te eski ve yeni satırı aynı anda göremez (USING eskiyi,
-- WITH CHECK yeniyi görür), bu yüzden "tamamlandi → cihazda" gibi bir
-- GEÇİŞ kuralı ancak trigger'da yazılabilir. Trigger da veritabanında
-- çalışır, istemciden atlanamaz. auth.uid() boşsa (SQL Editor,
-- service_role — ör. bakım/yedek) kural uygulanmaz.
-- ------------------------------------------------------------
create or replace function public.istem_kalemleri_geri_alma_kontrol() returns trigger
language plpgsql set search_path = public as $$
declare
  eski int := case old.durum when 'bekleyen' then 0 when 'cihazda' then 1 when 'tamamlandi' then 2 end;
  yeni int := case new.durum when 'bekleyen' then 0 when 'cihazda' then 1 when 'tamamlandi' then 2 end;
begin
  if auth.uid() is not null
     and eski is not null and yeni is not null and yeni < eski
     and not (public.is_admin() or coalesce(public.current_rol(), '') = 'teknisyen')
  then
    raise exception 'Durumu geri alma yetkiniz yok (sadece teknisyen veya yönetici)' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists istem_kalemleri_geri_alma_kontrol on istem_kalemleri;
create trigger istem_kalemleri_geri_alma_kontrol
  before update of durum on istem_kalemleri
  for each row execute function public.istem_kalemleri_geri_alma_kontrol();

-- ------------------------------------------------------------
-- 6) Kuyruk görünümü — yeni kolonlar SONA eklenir (CREATE OR REPLACE
-- VIEW mevcut kolon sırasını değiştiremez).
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
  ik.kalite_notu
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join cihazlar c        on c.id = ik.cihaz_id;

grant select on istem_kuyruk_v to authenticated;

-- ------------------------------------------------------------
-- 7) RLS — aşağıdaki tablolarda MEVCUT TÜM politikalar (anon_full_access /
-- authenticated_full_access) kaldırılıp rol bazlı politikalar kurulur.
-- anon bu tablolara hiç erişemez. Dokunulmayanlar: istem_log, cihazlar
-- (authenticated_full_access olarak kalır).
-- ------------------------------------------------------------
do $$
declare
  tbl text;
  pol record;
begin
  foreach tbl in array array[
    'kullanicilar', 'test_gruplari', 'test_katalog', 'istek_setleri', 'istek_seti_kalemleri',
    'istemler', 'istem_kalemleri', 'sablonlar', 'sablon_kalemleri'
  ]
  loop
    execute format('alter table %I enable row level security', tbl);
    execute format('revoke all on %I from anon', tbl);
    execute format('grant select, insert, update, delete on %I to authenticated', tbl);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = tbl
    loop
      execute format('drop policy %I on %I', pol.policyname, tbl);
    end loop;
  end loop;
end $$;

-- KULLANICILAR — okuma herkese (isim listeleri, uzman seçimi, oturum
-- profili); yazma SADECE admin (aksi halde herkes kendine is_admin
-- yazabilirdi).
create policy kullanicilar_select on kullanicilar for select to authenticated using (true);
create policy kullanicilar_insert on kullanicilar for insert to authenticated with check ((select public.is_admin()));
create policy kullanicilar_update on kullanicilar for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy kullanicilar_delete on kullanicilar for delete to authenticated using ((select public.is_admin()));

-- TEST GRUPLARI — yönetim verisi, yazma sadece admin.
create policy test_gruplari_select on test_gruplari for select to authenticated using (true);
create policy test_gruplari_insert on test_gruplari for insert to authenticated with check ((select public.is_admin()));
create policy test_gruplari_update on test_gruplari for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy test_gruplari_delete on test_gruplari for delete to authenticated using ((select public.is_admin()));

-- TEST KATALOĞU — ekleme herkese açık (Yeni İstek formundaki "+ ekle" /
-- "Toplu Seç" kataloğa kayıt açıyor), düzenleme/silme sadece admin.
create policy test_katalog_select on test_katalog for select to authenticated using (true);
create policy test_katalog_insert on test_katalog for insert to authenticated with check (true);
create policy test_katalog_update on test_katalog for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy test_katalog_delete on test_katalog for delete to authenticated using ((select public.is_admin()));

-- İSTEK SETLERİ (kurumsal) — okuma herkese, yazma sadece admin.
create policy istek_setleri_select on istek_setleri for select to authenticated using (true);
create policy istek_setleri_insert on istek_setleri for insert to authenticated with check ((select public.is_admin()));
create policy istek_setleri_update on istek_setleri for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy istek_setleri_delete on istek_setleri for delete to authenticated using ((select public.is_admin()));

create policy istek_seti_kalemleri_select on istek_seti_kalemleri for select to authenticated using (true);
create policy istek_seti_kalemleri_insert on istek_seti_kalemleri for insert to authenticated with check ((select public.is_admin()));
create policy istek_seti_kalemleri_update on istek_seti_kalemleri for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));
create policy istek_seti_kalemleri_delete on istek_seti_kalemleri for delete to authenticated using ((select public.is_admin()));

-- İSTEMLER — herkes yalnızca KENDİ adına istem açar. Güncelleme sadece
-- fatura kolonlarına açık (kolon bazlı izin, aşağıda) — aksi halde biri
-- başkasının istemine istem_yapan_id = kendisi yazıp kalemlerini
-- silebilirdi. Silme: admin; ya da kendi istemi ve içinde kalem
-- kalmamışsa (son kalem silinince boş başlığın temizlenmesi).
create policy istemler_select on istemler for select to authenticated using (true);
create policy istemler_insert on istemler for insert to authenticated
  with check (istem_yapan_id = (select public.current_kullanici_id()));
create policy istemler_update on istemler for update to authenticated using (true) with check (true);
create policy istemler_delete on istemler for delete to authenticated
  using (
    (select public.is_admin())
    or (istem_yapan_id = (select public.current_kullanici_id())
        and not exists (select 1 from istem_kalemleri k where k.istem_id = istemler.id))
  );

-- İSTEM KALEMLERİ
--  INSERT: kalem sadece kendi istemine eklenir (admin her istemine).
--          tekrar_kaynagi_id doluysa gerçek bir tekrar olmalı (herkes için).
--          Teknisyen (admin değilse) SADECE tekrar ekleyebilir.
--  UPDATE: herkese açık ama yalnızca durum/cihaz/kalite notu kolonları
--          (kolon bazlı izin, aşağıda) + geri alma trigger'ı (bkz. 5).
--  DELETE: admin her şeyi (Tamamlandı dahil); diğerleri sadece kendi
--          istemindeki ve Tamamlandı OLMAYAN kalemleri.
create policy istem_kalemleri_select on istem_kalemleri for select to authenticated using (true);
create policy istem_kalemleri_insert on istem_kalemleri for insert to authenticated
  with check (
    exists (
      select 1 from istemler i
      where i.id = istem_kalemleri.istem_id
        and (i.istem_yapan_id = (select public.current_kullanici_id()) or (select public.is_admin()))
    )
    and (tekrar_kaynagi_id is null
         or public.tekrar_kaynagi_gecerli(tekrar_kaynagi_id, istem_id, blok_no, test_id, ozel_test, grup))
    and (tekrar_kaynagi_id is not null or not (select public.is_teknisyen()))
  );
create policy istem_kalemleri_update on istem_kalemleri for update to authenticated using (true) with check (true);
create policy istem_kalemleri_delete on istem_kalemleri for delete to authenticated
  using (
    (select public.is_admin())
    or (durum <> 'tamamlandi'
        and exists (
          select 1 from istemler i
          where i.id = istem_kalemleri.istem_id
            and i.istem_yapan_id = (select public.current_kullanici_id())
        ))
  );

-- ŞABLONLAR — kendi + herkese açık görünür; sadece sahibi (veya admin)
-- düzenler/siler; teknisyen hiç erişemez. sahip_id başkasına
-- devredilemez (admin hariç).
create policy sablonlar_select on sablonlar for select to authenticated
  using (public.sablon_okunabilir(sahip_id, herkese_acik));
create policy sablonlar_insert on sablonlar for insert to authenticated
  with check (sahip_id = (select public.current_kullanici_id()) and not (select public.is_teknisyen()));
create policy sablonlar_update on sablonlar for update to authenticated
  using (public.sablon_duzenlenebilir(sahip_id)) with check (public.sablon_duzenlenebilir(sahip_id));
create policy sablonlar_delete on sablonlar for delete to authenticated
  using (public.sablon_duzenlenebilir(sahip_id));

create policy sablon_kalemleri_select on sablon_kalemleri for select to authenticated
  using (exists (select 1 from sablonlar s where s.id = sablon_kalemleri.sablon_id and public.sablon_okunabilir(s.sahip_id, s.herkese_acik)));
create policy sablon_kalemleri_insert on sablon_kalemleri for insert to authenticated
  with check (exists (select 1 from sablonlar s where s.id = sablon_kalemleri.sablon_id and public.sablon_duzenlenebilir(s.sahip_id)));
create policy sablon_kalemleri_update on sablon_kalemleri for update to authenticated
  using (exists (select 1 from sablonlar s where s.id = sablon_kalemleri.sablon_id and public.sablon_duzenlenebilir(s.sahip_id)))
  with check (exists (select 1 from sablonlar s where s.id = sablon_kalemleri.sablon_id and public.sablon_duzenlenebilir(s.sahip_id)));
create policy sablon_kalemleri_delete on sablon_kalemleri for delete to authenticated
  using (exists (select 1 from sablonlar s where s.id = sablon_kalemleri.sablon_id and public.sablon_duzenlenebilir(s.sahip_id)));

-- ------------------------------------------------------------
-- 8) Kolon bazlı UPDATE izinleri. Uygulamanın gerçekten güncellediği
-- kolonlar dışında hiçbir şey değiştirilemez — ör. teknisyen bir
-- tekrar satırını sonradan başka bir teste/bloğa çeviremez, kimse
-- başkasının istemini "kendi istemi" yapamaz.
-- ------------------------------------------------------------
revoke update on istem_kalemleri from authenticated;
grant update (durum, updated_at, cihaz_id, kalite_notu) on istem_kalemleri to authenticated;

revoke update on istemler from authenticated;
grant update (fatura_girildi, fatura_giren_id, fatura_zamani) on istemler to authenticated;

-- ------------------------------------------------------------
-- 9) Yedekler (Storage) — indirme sadece admin.
-- ------------------------------------------------------------
drop policy if exists "yedekler_authenticated_read" on storage.objects;
drop policy if exists "yedekler_admin_read" on storage.objects;
create policy "yedekler_admin_read" on storage.objects for select to authenticated
  using (bucket_id = 'yedekler' and public.is_admin());

-- ------------------------------------------------------------
-- 10) Auth'a taşınmış kullanıcıların eski düz-metin PIN'leri silinir.
-- Auth şifresi PIN'den türetildiği için (pin + "_pl") bu kolonu okuyan
-- herkes o hesaba — admin dahil — giriş yapabiliyordu. Giriş artık
-- sadece Supabase Auth üzerinden.
-- ------------------------------------------------------------
update kullanicilar set pin = null where auth_user_id is not null and pin is not null;

commit;

-- PostgREST şema önbelleğini tazele (yeni RPC/kolonlar hemen görünsün).
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Doğrulama (çalıştırdıktan sonra):
--   select id, ad_soyad, rol, is_admin from kullanicilar where is_admin;
--   select tablename, policyname, cmd from pg_policies
--     where schemaname = 'public' order by tablename, cmd;
-- ============================================================
