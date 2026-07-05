-- ============================================================
-- secure_rls_authenticated.sql
--
-- ⚠️ BU DOSYAYI, KULLANICILAR SAYFASINDAKİ "Auth hesabı olmayanları
-- taşı" İLE HERKESİ TAŞIYIP (Kullanıcılar listesinde "Auth hesabı
-- yok" ibaresi kalmadığını) DOĞRULAMADAN ÇALIŞTIRMAYIN. Aksi halde
-- henüz Auth'a taşınmamış kullanıcılar giriş yapamaz hale gelir.
--
-- Sıradaki (ve son) adım — auth_setup_sema.sql + kod değişikliklerinden
-- SONRA, migrasyon doğrulandıktan SONRA çalıştırın. İDEMPOTENT'tir.
--
-- Tüm tablolarda "anon_full_access" (herkese açık okuma/yazma) yerine
-- sadece giriş yapmış (authenticated) kullanıcılara açık politika
-- gelir — rol bazlı ayrım yok, sadece "giriş yapmış mı" kontrolü.
-- kullanicilar_login_v (anon'a özellikle açık kalan giriş-listesi
-- view'ı) ve auth şeması BU DOSYADAN ETKİLENMEZ.
-- ============================================================

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'kullanicilar', 'test_katalog', 'sablonlar', 'sablon_kalemleri',
    'istemler', 'istem_kalemleri', 'istem_log',
    'istek_setleri', 'istek_seti_kalemleri', 'cihazlar', 'test_gruplari'
  ]
  loop
    execute format('revoke all on %I from anon', tbl);
    -- Politika adı bir IDENTIFIER'dır (%I) — %L (string literal) DROP/CREATE
    -- POLICY söz diziminde geçersizdir, "syntax error at or near" verir.
    execute format('drop policy if exists %I on %I', 'anon_full_access', tbl);
    execute format(
      'create policy %I on %I for all to authenticated using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')',
      'authenticated_full_access', tbl
    );
  end loop;
end $$;

-- ------------------------------------------------------------
-- Görünümler (view) — grant'leri anon'dan authenticated'e daraltılır.
-- security_invoker=true olan görünümlerde (istem_kuyruk_v) bu yeterli:
-- sorgulayan rolün RLS'si zaten uygulanıyor, artık o rol anon olamaz.
-- kullanicilar_login_v'ye BİLEREK dokunulmuyor — amacı zaten anon'a
-- açık kalmak (giriş ekranındaki ad-seç dropdown'ı).
-- ------------------------------------------------------------
revoke select on istem_kuyruk_v from anon;
grant select on istem_kuyruk_v to authenticated;

-- ------------------------------------------------------------
-- Doğrulama — çalıştırdıktan sonra SQL Editor'de kontrol edebilirsiniz:
--
--   select tablename, policyname, roles
--   from pg_policies
--   where schemaname = 'public'
--   order by tablename;
--
-- Beklenen: her tabloda "authenticated_full_access", roles={authenticated}.
-- ============================================================
