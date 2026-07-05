-- ============================================================
-- Hizmetler (faturalama) — EK şema
--
-- istem_sistemi_sema.sql, policies.sql ve (varsa) setler_sema.sql
-- çalıştırıldıktan SONRA Supabase SQL Editor'de çalıştırın.
-- İDEMPOTENT'tir: (add column if not exists / DO-guard) güvenle
-- yeniden çalıştırılabilir.
--
-- Laboratuvar iş akışından (istem_kalemleri.durum) tamamen bağımsız:
-- burada tek bir istemler satırı (bir "İstek Ver" işlemiyle gönderilen
-- tüm kalemler) için faturalamanın girilip girilmediği tutulur.
--
-- Not: istemler tablosunda zaten policies.sql'deki "anon_full_access"
-- politikası var (tüm kolon/işlemleri kapsar) — yeni RLS politikası
-- gerekmiyor, sadece kolon ekleniyor.
-- ============================================================

alter table istemler add column if not exists fatura_girildi boolean not null default false;
alter table istemler add column if not exists fatura_giren_id uuid references kullanicilar(id);
alter table istemler add column if not exists fatura_zamani timestamptz;

create index if not exists istemler_fatura_girildi_idx on istemler (fatura_girildi);

-- ------------------------------------------------------------
-- Realtime yayını — Hizmetler ekranı açık kullanıcılarda canlı
-- güncellensin diye istemler tablosu publication'a eklenir.
-- İdempotent: zaten ekliyse tekrar eklemeyi denemez.
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'istemler'
  ) then
    alter publication supabase_realtime add table istemler;
  end if;
end $$;
