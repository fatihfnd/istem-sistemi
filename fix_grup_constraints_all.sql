-- ============================================================
-- fix_grup_constraints_all.sql
--
-- "grup" sütunu bulunan HER tabloda (test_katalog, sablonlar,
-- istem_kalemleri, istek_setleri) hâlâ aktif olabilecek ESKİ CHECK
-- kısıtını (sabit 7 değerli liste) kaldırır ve yerine test_gruplari
-- (kod)'a gerçek bir foreign key ekler. İDEMPOTENT'tir — güvenle
-- yeniden çalıştırılabilir, zaten düzeltilmiş bir tabloda no-op olur.
--
-- Kapsam nasıl belirlendi: repodaki tüm .sql dosyaları "grup text"
-- sütun tanımı için tarandı — TAM OLARAK bu 4 tabloda var:
--   istem_sistemi_sema.sql → test_katalog, sablonlar, istem_kalemleri
--   setler_sema.sql        → istek_setleri
-- sablon_kalemleri ve istek_seti_kalemleri'nde grup sütunu YOK (grup
-- bilgisi bu tablolarda değil, sahip oldukları üst tabloda tutuluyor).
--
-- Teşhis (canlı DB'ye karşı doğrudan test edildi, anon anahtarla):
--   test_katalog     → düzeltilmişti (fix_test_katalog_grup.sql sonrası OK)
--   istem_kalemleri  → ERROR 23514: "istem_kalemleri_grup_check"
--   sablonlar        → ERROR 23514: "sablonlar_grup_check"
--   istek_setleri    → ERROR 23514: "istek_setleri_grup_check"
-- Üçü de hâlâ eski CHECK kısıtını taşıyor; FK eklenmiş olsa bile CHECK
-- yanında durduğu sürece yeni gruplar (fish gibi) reddedilmeye devam
-- eder — bu yüzden test kataloğuna FISH testi eklenebiliyor ama o
-- testle istem oluşturmak istem_kalemleri'nde patlıyordu.
--
-- Mevcut veri BOZULMAZ: sadece kısıt değişiyor, hiçbir satıra
-- dokunulmuyor.
-- ============================================================

do $$
declare
  tbl text;
  r record;
  grup_attnum smallint;
begin
  foreach tbl in array array['test_katalog','sablonlar','istem_kalemleri','istek_setleri']
  loop
    -- 1) Eski CHECK'i kaldır — kolon-bazlı introspection (pg_attribute +
    -- conkey) ile. Kısıtın tanım METNİNE değil, gerçekten "grup" kolonuna
    -- uygulanıp uygulanmadığına bakıyor — isimden/render biçiminden
    -- bağımsız, güvenilir tespit.
    select attnum into grup_attnum
    from pg_attribute
    where attrelid = tbl::regclass and attname = 'grup' and not attisdropped;

    if grup_attnum is not null then
      for r in
        select conname from pg_constraint
        where contype = 'c' and conrelid = tbl::regclass and grup_attnum = any(conkey)
      loop
        execute format('alter table %I drop constraint %I', tbl, r.conname);
      end loop;
    end if;

    -- 2) Yerine test_gruplari(kod)'a FK ekle (idempotent — zaten varsa
    -- tekrar eklemeyi denemez).
    if not exists (
      select 1 from pg_constraint where conname = tbl || '_grup_fkey'
    ) then
      execute format(
        'alter table %I add constraint %I foreign key (grup) references test_gruplari(kod)',
        tbl, tbl || '_grup_fkey'
      );
    end if;
  end loop;
end $$;

-- ------------------------------------------------------------
-- Doğrulama — bu dosyayı çalıştırdıktan sonra SQL Editor'de ayrıca
-- çalıştırıp 4 tablonun tümünde güncel kısıtları görebilirsiniz:
--
--   select conrelid::regclass as tablo, conname, contype
--   from pg_constraint
--   where conrelid = any (array['test_katalog','sablonlar','istem_kalemleri','istek_setleri']::regclass[])
--     and contype in ('c','f')
--   order by tablo, contype;
--
-- Beklenen sonuç: her 4 tabloda "*_grup_check" (contype='c') ARTIK
-- YOK; her 4 tabloda "*_grup_fkey" (contype='f') VAR.
-- ============================================================
