-- ============================================================
-- RLS Politikaları — Prototip (anon rolüne tam okuma + yazma)
--
-- Supabase SQL Editor'de, istem_sistemi_sema.sql çalıştırıldıktan
-- SONRA çalıştırın.
--
-- UYARI: Bu politikalar prototip içindir. Bu appte gerçek bir
-- Supabase Auth oturumu YOK (ad seç + PIN uygulama içinde kontrol
-- ediliyor) — yani her istek "anon" rolüyle gider ve anon key'e
-- sahip HERKES tüm satırları okuyup yazabilir. Üretime / hasta
-- verisiyle gerçek kullanıma geçmeden önce Supabase Auth + kullanıcı
-- bazlı politikalarla değiştirilmelidir.
-- ============================================================

grant usage on schema public to anon, authenticated;

-- Tablolar — okuma + yazma (insert/update/delete)
grant select, insert, update, delete on
  kullanicilar, test_katalog, sablonlar, sablon_kalemleri,
  istemler, istem_kalemleri, istem_log
to anon, authenticated;

-- İş kuyruğu görünümü — sadece okuma
grant select on istem_kuyruk_v to anon, authenticated;

alter table kullanicilar      enable row level security;
alter table test_katalog      enable row level security;
alter table sablonlar         enable row level security;
alter table sablon_kalemleri  enable row level security;
alter table istemler          enable row level security;
alter table istem_kalemleri   enable row level security;
alter table istem_log         enable row level security;

create policy "anon_full_access" on kullanicilar
  for all to anon, authenticated using (true) with check (true);

create policy "anon_full_access" on test_katalog
  for all to anon, authenticated using (true) with check (true);

create policy "anon_full_access" on sablonlar
  for all to anon, authenticated using (true) with check (true);

create policy "anon_full_access" on sablon_kalemleri
  for all to anon, authenticated using (true) with check (true);

create policy "anon_full_access" on istemler
  for all to anon, authenticated using (true) with check (true);

create policy "anon_full_access" on istem_kalemleri
  for all to anon, authenticated using (true) with check (true);

create policy "anon_full_access" on istem_log
  for all to anon, authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- Realtime yayını — iş kuyruğunun canlı güncellenmesi için bu
-- tabloların supabase_realtime publication'ına eklenmesi gerekir.
-- (Supabase projelerinde publication zaten mevcuttur.)
-- ------------------------------------------------------------
alter publication supabase_realtime add table istem_kalemleri;
alter publication supabase_realtime add table istem_log;
