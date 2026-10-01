-- ============================================================
-- profil_sema.sql — kullanıcının KENDİ profili: avatar + PIN değişimi
--
-- yetki_sema.sql'den SONRA, YENİ KOD DEPLOY EDİLMEDEN ÖNCE Supabase SQL
-- Editor'de çalıştırın (yeni kod girişte kullanicilar.avatar_url'i okur).
-- İDEMPOTENT'tir, tek transaction'dır.
--
-- Neden RPC: kullanicilar tablosuna yazma (yetki_sema.sql) sadece admin'e
-- açık — aksi halde herkes kendi satırına is_admin=true yazabilirdi.
-- Kullanıcının kendi satırında değiştirebileceği TEK şey avatarı; bunu
-- dar, security definer bir fonksiyon yapar (başka kolona dokunamaz,
-- başkasının satırına dokunamaz).
--
-- PIN: Auth şifresini istemci doğrudan Supabase Auth'ta değiştirir
-- (auth.updateUser). kullanicilar.pin'e YENİ PIN YAZILMAZ: o kolonu giriş
-- yapan herkes okuyabiliyor ve Auth şifresi PIN'den türetildiği için
-- bu, hesabı herkese açmak olurdu; Auth hesabı olan kullanıcılar için
-- kolon hiçbir yerde kullanılmıyor. Sadece (varsa) eski kopya temizlenir.
-- ============================================================

begin;

alter table kullanicilar add column if not exists avatar_url text;  -- Storage yolu: "<auth_uid>/avatar-<zaman>.jpg"

-- ------------------------------------------------------------
-- Avatar bucket'ı — PRIVATE (dışarıdan imzasız URL ile erişilemez).
-- Okuma: giriş yapmış herkes (profil fotoğrafları panelde/listede görünür;
-- uygulama kısa ömürlü imzalı URL alır). Yazma: herkes SADECE kendi
-- klasörüne ("<auth_uid>/…"). 2 MB / jpg-png sınırı sunucuda da var.
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatarlar', 'avatarlar', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "avatarlar_okuma" on storage.objects;
drop policy if exists "avatarlar_kendi_ekle" on storage.objects;
drop policy if exists "avatarlar_kendi_guncelle" on storage.objects;
drop policy if exists "avatarlar_kendi_sil" on storage.objects;

create policy "avatarlar_okuma" on storage.objects for select to authenticated
  using (bucket_id = 'avatarlar');
create policy "avatarlar_kendi_ekle" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatarlar' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatarlar_kendi_guncelle" on storage.objects for update to authenticated
  using (bucket_id = 'avatarlar' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatarlar' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatarlar_kendi_sil" on storage.objects for delete to authenticated
  using (bucket_id = 'avatarlar' and (storage.foldername(name))[1] = auth.uid()::text);

-- ------------------------------------------------------------
-- Kendi avatarını ayarla / kaldır (p_yol null = kaldır). Yol mutlaka
-- çağıranın kendi klasöründe olmalı.
-- ------------------------------------------------------------
create or replace function public.profil_avatar_ayarla(p_yol text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Oturum bulunamadı';
  end if;
  if p_yol is not null and split_part(p_yol, '/', 1) <> auth.uid()::text then
    raise exception 'Sadece kendi avatarınızı ayarlayabilirsiniz' using errcode = '42501';
  end if;
  update kullanicilar set avatar_url = p_yol where auth_user_id = auth.uid();
end $$;

-- PIN (Auth şifresi) değiştikten sonra: kendi satırında eski düz-metin
-- PIN kopyası kaldıysa siler (yenisini yazmaz — bkz. dosya başı).
create or replace function public.profil_pin_degisti() returns void
language sql security definer set search_path = public as $$
  update kullanicilar set pin = null where auth_user_id = auth.uid() and pin is not null
$$;

revoke all on function public.profil_avatar_ayarla(text) from public, anon;
grant execute on function public.profil_avatar_ayarla(text) to authenticated;
revoke all on function public.profil_pin_degisti() from public, anon;
grant execute on function public.profil_pin_degisti() to authenticated;

commit;

notify pgrst, 'reload schema';

-- Doğrulama:
--   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'avatarlar';
--   select policyname, cmd from pg_policies where tablename = 'objects' and policyname like 'avatarlar%';
-- ============================================================
