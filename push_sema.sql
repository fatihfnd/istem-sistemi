-- ============================================================
-- push_sema.sql — Web Push bildirimleri
--
-- ekip_sema.sql'den SONRA çalıştırın; ÖNCE Supabase panelinde
-- "push-gonder" Edge Function'ını deploy edin (trigger onu çağırır;
-- fonksiyon yoksa çağrı yalnızca 404 olarak loglanır, istem kaydı ASLA
-- etkilenmez). İDEMPOTENT'tir.
--
-- Akış: istem_kalemleri INSERT → push_tetikle() trigger'ı → istem başına
-- TEK kez (push_gonderimleri) net.http_post → push-gonder → abonelere.
-- pg_net isteği işlem kesinleştikten SONRA gider; işlem geri alınırsa
-- hiç gitmez — fonksiyon istemin tüm kalemlerini görür.
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Abonelikler — bir tarayıcı/cihaz = bir endpoint. Herkes yalnız
-- kendi satırını görür/değiştirir. Ortak bilgisayarda aynı tarayıcıyı
-- başka biri açarsa abonelik ona DEVREDİLİR (push_abone_ol — RLS diğer
-- kişinin satırını gizlediği için düz INSERT benzersizlikte çakışırdı).
-- ------------------------------------------------------------
create table if not exists push_abonelikleri (
  id           uuid primary key default gen_random_uuid(),
  kullanici_id uuid not null references kullanicilar(id) on delete cascade,
  endpoint     text not null unique,
  keys         jsonb not null,
  created_at   timestamptz not null default now()
);
create index if not exists push_abonelikleri_kullanici_idx on push_abonelikleri (kullanici_id);

-- ------------------------------------------------------------
-- 2) Bildirim tercihleri — hangi grupların yeni isteklerinde bildirim.
-- Satır yoksa bildirim yok. Varsayılan (kendi ekibinin grupları),
-- kullanıcı "Bildirimleri aç"a ilk bastığında uygulama tarafından yazılır.
-- ------------------------------------------------------------
create table if not exists bildirim_tercihleri (
  kullanici_id uuid not null references kullanicilar(id) on delete cascade,
  grup_kod     text not null references test_gruplari(kod) on update cascade on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (kullanici_id, grup_kod)
);

-- ------------------------------------------------------------
-- 3) Gönderim kaydı — istem başına TEK bildirim + teşhis (kaç kişiye
-- gitti, kaç ölü abonelik silindi, hata). Uygulama kullanıcılarına kapalı.
-- ------------------------------------------------------------
create table if not exists push_gonderimleri (
  istem_id      uuid primary key references istemler(id) on delete cascade,
  created_at    timestamptz not null default now(),
  gonderildi_at timestamptz,
  gonderilen    int,
  silinen       int,
  hata          text
);

alter table push_abonelikleri  enable row level security;
alter table bildirim_tercihleri enable row level security;
alter table push_gonderimleri  enable row level security;
revoke all on push_abonelikleri, bildirim_tercihleri, push_gonderimleri from anon, authenticated;
grant select, insert, update, delete on push_abonelikleri, bildirim_tercihleri to authenticated;

do $$
declare pol record;
begin
  for pol in select tablename, policyname from pg_policies
             where schemaname = 'public' and tablename in ('push_abonelikleri', 'bildirim_tercihleri', 'push_gonderimleri')
  loop
    execute format('drop policy %I on %I', pol.policyname, pol.tablename);
  end loop;
end $$;

create policy push_abonelikleri_kendi on push_abonelikleri for all to authenticated
  using (kullanici_id = (select public.current_kullanici_id()))
  with check (kullanici_id = (select public.current_kullanici_id()));
create policy bildirim_tercihleri_kendi on bildirim_tercihleri for all to authenticated
  using (kullanici_id = (select public.current_kullanici_id()))
  with check (kullanici_id = (select public.current_kullanici_id()));
-- push_gonderimleri: politika YOK → authenticated hiçbir satırı göremez/yazamaz
-- (trigger security definer, Edge Function service_role ile yazar).

commit;

select 'Parça 1/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 4) Sunucu fonksiyonları
-- ------------------------------------------------------------
-- Abone ol / aboneliği devral (ortak bilgisayar) — oturumdaki kullanıcı adına.
create or replace function public.push_abone_ol(p_endpoint text, p_keys jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
begin
  if ben is null then
    raise exception 'Oturum kullanıcısı bulunamadı' using errcode = '42501';
  end if;
  if coalesce(p_endpoint, '') !~ '^https://' or p_keys ->> 'p256dh' is null or p_keys ->> 'auth' is null then
    raise exception 'Geçersiz abonelik';
  end if;
  insert into push_abonelikleri (kullanici_id, endpoint, keys)
  values (ben, p_endpoint, jsonb_build_object('p256dh', p_keys ->> 'p256dh', 'auth', p_keys ->> 'auth'))
  on conflict (endpoint) do update
    set kullanici_id = excluded.kullanici_id, keys = excluded.keys, created_at = now();
end $$;

-- Uygulama abone olurken açık anahtarı buradan alır (gizli değil).
create or replace function public.vapid_acik_anahtar() returns text
language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'istem_vapid_public' limit 1
$$;

-- YALNIZ service_role (push-gonder): anahtar çifti.
create or replace function public.push_anahtarlari() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'public',  (select decrypted_secret from vault.decrypted_secrets where name = 'istem_vapid_public' limit 1),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'istem_vapid_private' limit 1)
  )
$$;

-- YALNIZ service_role (push-gonder kurulumu): anahtar yoksa Vault'a yazar,
-- varsa DOKUNMAZ (mevcut abonelikler geçersiz kalmasın). Dönen: yazıldı mı.
create or replace function public.vapid_anahtar_kaydet(p_public text, p_private text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from vault.secrets where name = 'istem_vapid_private') then
    return false;
  end if;
  perform vault.create_secret(p_private, 'istem_vapid_private', 'Web Push VAPID özel anahtarı (JWK) — push-gonder');
  if exists (select 1 from vault.secrets where name = 'istem_vapid_public') then
    -- yarım kalmış eski kurulum: açık anahtarı yeni çiftle eşle
    perform vault.update_secret((select id from vault.secrets where name = 'istem_vapid_public' limit 1), p_public);
  else
    perform vault.create_secret(p_public, 'istem_vapid_public', 'Web Push VAPID açık anahtarı');
  end if;
  return true;
end $$;

revoke all on function public.push_abone_ol(text, jsonb) from public, anon;
grant execute on function public.push_abone_ol(text, jsonb) to authenticated;
revoke all on function public.vapid_acik_anahtar() from public, anon;
grant execute on function public.vapid_acik_anahtar() to authenticated;
revoke all on function public.push_anahtarlari() from public, anon, authenticated;
grant execute on function public.push_anahtarlari() to service_role;
revoke all on function public.vapid_anahtar_kaydet(text, text) from public, anon, authenticated;
grant execute on function public.vapid_anahtar_kaydet(text, text) to service_role;

commit;

notify pgrst, 'reload schema';

select 'Parça 2/3 tamam' as sonuc;
-- ======================= PARÇA SINIRI =======================

begin;

-- ------------------------------------------------------------
-- 5) Tetikleyici — yeni kalem → istem başına TEK çağrı.
-- Hiç abonelik yoksa çağırmaz. Hata olursa yalnız uyarı yazar; istem
-- kaydını ASLA engellemez. Servis anahtarı Vault'tan (cron işleriyle aynı).
-- ------------------------------------------------------------
create or replace function public.push_tetikle() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from push_abonelikleri) then
    return null;
  end if;
  insert into push_gonderimleri (istem_id) values (new.istem_id) on conflict (istem_id) do nothing;
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
      body := jsonb_build_object('istem_id', new.istem_id),
      timeout_milliseconds := 30000
    );
  end if;
  return null;
exception when others then
  raise warning 'push_tetikle (istem %): %', new.istem_id, sqlerrm;
  return null;
end $$;

drop trigger if exists push_tetikle on istem_kalemleri;
create trigger push_tetikle
  after insert on istem_kalemleri
  for each row execute function public.push_tetikle();

commit;

select 'Parça 3/3 tamam' as sonuc;

-- ------------------------------------------------------------
-- KURULUM (bu dosyadan sonra, bir kez) — VAPID anahtarını fonksiyon üretip
-- Vault'a yazar; özel anahtar kimseye görünmez:
--   select net.http_post(
--     url := 'https://mwuvfvjyurokhzttbxyi.supabase.co/functions/v1/push-gonder',
--     headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' ||
--       (select decrypted_secret from vault.decrypted_secrets where name = 'istem_service_role_key')),
--     body := '{"islem":"anahtar"}'::jsonb, timeout_milliseconds := 30000);
--   -- 10-20 sn sonra (beklenen: 200, {"ok":true,"anahtar":"olusturuldu"}):
--   select status_code, content from net._http_response order by created desc limit 1;
--   select name from vault.secrets where name like 'istem_vapid%';   -- 2 satır
--
-- Teşhis:
--   select * from push_gonderimleri order by created_at desc limit 10;
-- ============================================================
