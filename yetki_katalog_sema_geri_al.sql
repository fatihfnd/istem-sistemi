-- ============================================================
-- yetki_katalog_sema_geri_al.sql — yetki_var bağlantılarını geri alır
--
-- İşlem kontrollerini (RLS ilkeleri, tetikleyiciler, RPC'ler) eski ROL
-- tabanlı kurallara döndürür (yönetici / teknisyen / istemi giren).
-- VERİ SİLİNMEZ: yeni tablolar (rol_yetkileri, kullanici_yetkileri,
-- ekip_gruplari, test_katalog_log), eklenen sütunlar (aciklama, es_adlar,
-- birlesti_id) ve katalog tetikleyicileri (tekrar kontrolü, iz, yeni test
-- duyurusu) yerinde kalır. yetkilerim() kaldırılır → uygulama kendiliğinden
-- eski rol kurallarına düşer (açık sekmeler bir kez yenilenmeli).
-- Yeniden açmak için yetki_katalog_sema.sql'i tekrar çalıştırın (başlangıç
-- verisi yeniden yazılmaz; matristeki ayarlarınız korunur).
-- İDEMPOTENT'tir.
-- ============================================================

begin;

create or replace function public._yetki_yama(p_fn text, p_eski text, p_yeni text) returns text
language plpgsql as $$
declare
  f regprocedure := to_regprocedure(p_fn);
  src text;
begin
  if f is null then return p_fn || ': fonksiyon yok (atlandı)'; end if;
  src := pg_get_functiondef(f);
  if position(p_eski in src) = 0 then return p_fn || ': zaten eski halinde'; end if;
  execute replace(src, p_eski, p_yeni);
  return p_fn || ': eski kurala döndü';
end $$;

do $geri$
declare
  s text;
begin
  foreach s in array array['public.blok_kesildi(uuid[])', 'public.blok_kesildi_geri_al(uuid[])'] loop
    raise notice '%', public._yetki_yama(s,
      $y$not public.yetki_var('durum_degistir')$y$,
      $e$not (public.is_admin() or coalesce(public.current_rol(), '') = 'teknisyen')$e$);
  end loop;
  raise notice '%', public._yetki_yama('public.istem_duzelt(uuid,jsonb)',
    $y$if not (public.is_admin() or (i.istem_yapan_id = ben and public.yetki_var('duzeltme'))) then$y$,
    $e$if not (public.is_admin() or i.istem_yapan_id = ben) then$e$);
  raise notice '%', public._yetki_yama('public.istatistik(date,date,text)',
    $y$if not (public.yetki_var('s_istatistik') or current_user in$y$,
    $e$if not (public.is_admin() or current_user in$e$);
end $geri$;
drop function if exists public._yetki_yama(text, text, text);

create or replace function public.istem_kalemleri_geri_alma_kontrol() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is not null
     and new.durum is distinct from old.durum
     and not (public.is_admin() or coalesce(public.current_rol(), '') = 'teknisyen')
  then
    raise exception 'Durum değiştirme yetkiniz yok (yalnız teknisyen veya yönetici)' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.blok_cikarma_yetkisi() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or coalesce(public.current_rol(), '') = 'teknisyen'
      or exists (select 1 from kullanicilar where id = public.current_kullanici_id() and ekip = 'arsiv')
$$;

create or replace function public.teslim_yetkisi(p_istem_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin()
      or (coalesce(public.current_rol(), '') <> 'teknisyen'
          and exists (
            select 1 from istemler i
            where i.id = p_istem_id
              and public.current_kullanici_id() in (i.istem_yapan_id, i.uzman_id)
          ))
$$;

drop trigger if exists istemler_uzman_adina_kontrol on istemler;
drop function if exists public.istemler_uzman_adina_kontrol();

create or replace function public.katalog_kontrol_yukle(p_liste jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  n int;
begin
  if not public.is_admin() then
    raise exception 'Kontrol listesini yalnız yönetici yükleyebilir' using errcode = '42501';
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

-- RLS: eski ilkeler
drop policy if exists test_katalog_insert on test_katalog;
drop policy if exists test_katalog_update on test_katalog;
drop policy if exists test_katalog_delete on test_katalog;
create policy test_katalog_insert on test_katalog for insert to authenticated with check (true);
create policy test_katalog_update on test_katalog for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy test_katalog_delete on test_katalog for delete to authenticated using ((select public.is_admin()));

drop policy if exists istem_kalemleri_insert on istem_kalemleri;
create policy istem_kalemleri_insert on istem_kalemleri for insert to authenticated
  with check (
    exists (select 1 from istemler i
            where i.id = istem_kalemleri.istem_id
              and (i.istem_yapan_id = (select public.current_kullanici_id()) or (select public.is_admin())))
    and (tekrar_kaynagi_id is null
         or public.tekrar_kaynagi_gecerli(tekrar_kaynagi_id, istem_id, blok_no, test_id, ozel_test, grup))
    and (tekrar_kaynagi_id is not null or not (select public.is_teknisyen()))
  );
drop policy if exists istem_kalemleri_delete on istem_kalemleri;
create policy istem_kalemleri_delete on istem_kalemleri for delete to authenticated
  using (
    (select public.is_admin())
    or (durum <> 'tamamlandi'
        and exists (select 1 from istemler i
                    where i.id = istem_kalemleri.istem_id
                      and i.istem_yapan_id = (select public.current_kullanici_id())))
  );
drop policy if exists istemler_delete on istemler;
create policy istemler_delete on istemler for delete to authenticated
  using (
    (select public.is_admin())
    or (istem_yapan_id = (select public.current_kullanici_id())
        and not exists (select 1 from istem_kalemleri k where k.istem_id = istemler.id))
  );

drop policy if exists duyurular_insert on duyurular;
create policy duyurular_insert on duyurular for insert to authenticated
  with check (yazan_id = (select public.current_kullanici_id()));
drop policy if exists duyurular_update on duyurular;
create policy duyurular_update on duyurular for update to authenticated
  using (yazan_id = (select public.current_kullanici_id())
         or (select public.current_rol()) = 'teknisyen'
         or (select public.is_admin()))
  with check (yazan_id = (select public.current_kullanici_id())
         or (select public.current_rol()) = 'teknisyen'
         or (select public.is_admin()));

-- Birleştirme ve içe aktarma yetki_var'a bağlıdır: yalnız yöneticiye kalır.
do $rpc$
begin
  if to_regprocedure('public.katalog_ice_aktar(jsonb,boolean)') is not null then
    revoke execute on function public.katalog_ice_aktar(jsonb, boolean) from authenticated;
  end if;
  if to_regprocedure('public.test_birlestir(uuid,uuid,boolean)') is not null then
    revoke execute on function public.test_birlestir(uuid, uuid, boolean) from authenticated;
  end if;
end $rpc$;

-- Uygulama bunu bulamayınca eski rol kurallarına düşer.
drop function if exists public.yetkilerim();

commit;

notify pgrst, 'reload schema';

select 'Geri alındı: işlem kontrolleri eski rol kurallarında; veri silinmedi' as sonuc;
