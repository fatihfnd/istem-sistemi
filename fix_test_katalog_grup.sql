-- ============================================================
-- fix_test_katalog_grup.sql
--
-- test_katalog.grup üzerinde hâlâ aktif olan ESKİ CHECK kısıtını
-- (sabit 7 değerli liste: ihc/hk/mol/kesit/hucre/yayma/diger) kaldırır
-- ve yerine test_gruplari(kod)'a gerçek bir foreign key ekler.
-- İDEMPOTENT'tir — güvenle yeniden çalıştırılabilir.
--
-- Teşhis (canlı DB'ye karşı doğrudan test edildi, anon anahtarla):
--   insert test_katalog (grup:'fish', ad:'__probe__')
--   → ERROR 23514: violates check constraint "test_katalog_grup_check"
-- test_gruplari tablosunda 'fish' kaydı VAR ve aktif=true, ama
-- test_katalog.grup üzerindeki ESKİ CHECK kısıtı hâlâ etkin — FK
-- eklenmiş olsa bile CHECK yanında durduğu sürece yeni gruplar
-- (fish gibi) reddedilmeye devam eder; ihc/hk/mol/diger gibi eski
-- sabit gruplar CHECK listesinde olduğu için sorunsuz çalışır
-- (raporunuzla birebir örtüşüyor).
--
-- Mevcut veri BOZULMAZ: sadece kısıt değişiyor, hiçbir satıra
-- dokunulmuyor. ER/PR/HER2 ve az önce eklediğiniz testler dahil
-- tüm satırlar olduğu gibi kalır.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Eski CHECK'i kaldır — kolon-bazlı introspection (pg_attribute +
-- conkey) ile. Kısıtın tanım METNİNE değil, gerçekten "grup" kolonuna
-- uygulanıp uygulanmadığına bakıyor — isimden/render biçiminden
-- bağımsız, güvenilir tespit.
-- ------------------------------------------------------------
do $$
declare
  r record;
  grup_attnum smallint;
begin
  select attnum into grup_attnum
  from pg_attribute
  where attrelid = 'test_katalog'::regclass and attname = 'grup' and not attisdropped;

  if grup_attnum is not null then
    for r in
      select conname from pg_constraint
      where contype = 'c' and conrelid = 'test_katalog'::regclass and grup_attnum = any(conkey)
    loop
      execute format('alter table test_katalog drop constraint %I', r.conname);
    end loop;
  end if;
end $$;

-- ------------------------------------------------------------
-- 2) Yerine test_gruplari(kod)'a FK ekle (idempotent — zaten varsa
-- tekrar eklemeyi denemez).
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'test_katalog_grup_fkey') then
    alter table test_katalog
      add constraint test_katalog_grup_fkey foreign key (grup) references test_gruplari(kod);
  end if;
end $$;

-- ------------------------------------------------------------
-- Doğrulama — bu dosyayı çalıştırdıktan sonra SQL Editor'de ayrıca
-- çalıştırıp test_katalog üzerindeki güncel kısıtları görebilirsiniz
-- (SQL Editor pg_catalog'a doğrudan erişebilir, anon anahtar erişemez):
--
--   select conname, contype, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'test_katalog'::regclass;
--
-- Beklenen sonuç: "test_katalog_grup_check" (contype='c') artık listede
-- OLMAMALI; "test_katalog_grup_fkey" (contype='f') listede OLMALI.
-- ============================================================
