-- ============================================================
-- Yönetim — EK şema
--
-- istem_sistemi_sema.sql, policies.sql, setler_sema.sql ve
-- hizmetler_sema.sql çalıştırıldıktan SONRA Supabase SQL Editor'de
-- çalıştırın. İDEMPOTENT'tir: yeniden çalıştırılabilir.
--
-- Bu dosya test_katalog.grup (ve aynı CHECK'i tekrarlayan
-- sablonlar.grup, istem_kalemleri.grup, istek_setleri.grup) sabit
-- 7 değerli CHECK kısıtını bir referans tabloya (test_gruplari)
-- çevirir — böylece arayüzden yeni bir üst grup (ör. "fish"/"FISH")
-- tanımlanabilir. Mevcut veri BOZULMAZ: grup kolonları zaten bu
-- kodları (ihc, hk, mol, ...) metin olarak tutuyor; test_gruplari
-- aynı kodlarla seed edildiği için hiçbir satır dönüştürülmez.
--
-- Not: mevcut "fish"e ait test varsa (ör. mol grubunda duran FISH
-- testleri) bu script onları TAŞIMAZ — kullanıcı istemedikçe otomatik
-- taşıma yapılmaz, sadece grup tanımı eklenir.
-- ============================================================

create extension if not exists pgcrypto;

-- ------------------------------------------------------------
-- TEST GRUPLARI  (id: uygulamanın uuid-PK konvansiyonu;
-- kod: FK hedefi — mevcut grup kolonları zaten bu değerleri tutuyor)
-- ------------------------------------------------------------
create table if not exists test_gruplari (
  id     uuid primary key default gen_random_uuid(),
  kod    text not null unique,
  ad     text not null,
  sira   int  not null default 0,
  aktif  boolean not null default true
);

insert into test_gruplari (kod, ad, sira) values
  ('ihc','IHC',10), ('hk','Histokimya',20), ('mol','Moleküler',30),
  ('kesit','Yeni Kesit',40), ('hucre','Hücre Bloğu',50), ('yayma','Yeniden Yayma',60), ('diger','Diğer',70)
on conflict (kod) do nothing;

-- ------------------------------------------------------------
-- Eski CHECK kısıtlarını kaldır — kolon-bazlı introspection ile
-- (pg_attribute + conkey). Önceki sürüm pg_get_constraintdef(oid)
-- metnini '%grup%in%' ile arıyordu; ama PostgreSQL "grup in (...)"
-- ifadesini içeride "(grup)::text = ANY (ARRAY[...])" olarak
-- normalize edip öyle saklıyor/gösteriyor — metinde literal "in"
-- geçmediği için o sorgu HİÇBİR ZAMAN eşleşmedi ve eski CHECK'ler
-- silinmeden kaldı (FK yanına eklendi, "fish" FK'yi geçip CHECK'e
-- takıldı). Bu sürüm kısıtın tanım metnine değil, gerçekten hangi
-- kolona uygulandığına (conkey) bakıyor — render biçiminden bağımsız.
-- ------------------------------------------------------------
do $$
declare
  tbl text;
  r record;
  grup_attnum smallint;
begin
  foreach tbl in array array['test_katalog','sablonlar','istem_kalemleri','istek_setleri']
  loop
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
  end loop;
end $$;

-- ------------------------------------------------------------
-- Yerine FK ekle (idempotent).
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'test_katalog_grup_fkey') then
    alter table test_katalog add constraint test_katalog_grup_fkey foreign key (grup) references test_gruplari(kod);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sablonlar_grup_fkey') then
    alter table sablonlar add constraint sablonlar_grup_fkey foreign key (grup) references test_gruplari(kod);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'istem_kalemleri_grup_fkey') then
    alter table istem_kalemleri add constraint istem_kalemleri_grup_fkey foreign key (grup) references test_gruplari(kod);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'istek_setleri_grup_fkey') then
    alter table istek_setleri add constraint istek_setleri_grup_fkey foreign key (grup) references test_gruplari(kod);
  end if;
end $$;

-- ------------------------------------------------------------
-- RLS — prototip: anon role tam okuma+yazma (bkz. policies.sql'deki
-- aynı uyarı). Realtime EKLENMİYOR — grup taksonomisi nadiren
-- değişen, düşük eşzamanlılıklı bir yönetim verisi.
-- ------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on test_gruplari to anon, authenticated;

alter table test_gruplari enable row level security;

drop policy if exists "anon_full_access" on test_gruplari;
create policy "anon_full_access" on test_gruplari
  for all to anon, authenticated using (true) with check (true);
