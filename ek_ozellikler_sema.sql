-- ============================================================
-- ek_ozellikler_sema.sql — kısaltma, çoklu not, geri alma kuralı,
-- toplu tekrar, istatistikler
--
-- yetki_sema.sql ve profil_sema.sql'den SONRA, YENİ KOD DEPLOY
-- EDİLMEDEN ÖNCE Supabase SQL Editor'de çalıştırın (yeni kod
-- istem_kuyruk_v'nin notlar/kisaltma kolonlarını okur).
-- İDEMPOTENT'tir, tek transaction'dır.
--
-- yetki_sema.sql'i bir gün yeniden çalıştırırsanız, ardından bu dosyayı
-- da yeniden çalıştırın (görünüm ve fonksiyonların son hali burada).
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1) Kullanıcı kısaltması (İş Kuyruğu'nda İsteyen / Uzman Adına'da
-- gösterilir, tam ad ipucu olarak kalır). Boş olabilir; doluysa
-- büyük/küçük harf duyarsız BENZERSİZ — iki kişi aynı kısaltmayı alamaz.
-- Yazma, kullanicilar tablosunun mevcut kuralıyla yalnız admin.
-- ------------------------------------------------------------
alter table kullanicilar add column if not exists kisaltma text;
create unique index if not exists kullanicilar_kisaltma_uniq
  on kullanicilar (lower(kisaltma)) where kisaltma is not null and kisaltma <> '';

-- ------------------------------------------------------------
-- 2) Çoklu not — istem başına yazan + zaman damgalı liste.
-- Düzenleme YOK (iz kaydı bozulmasın); yazan kendi notunu, admin her
-- notu silebilir. istemler.not_metni kolonu SİLİNMEZ (eski veri
-- güvende kalsın), sadece yeni not oraya yazılmaz.
-- ------------------------------------------------------------
create table if not exists istem_notlari (
  id         uuid primary key default gen_random_uuid(),
  istem_id   uuid not null references istemler(id) on delete cascade,
  yazan_id   uuid references kullanicilar(id),
  metin      text not null check (length(btrim(metin)) > 0),
  created_at timestamptz not null default now()
);
create index if not exists istem_notlari_istem_idx on istem_notlari (istem_id, created_at desc);

alter table istem_notlari enable row level security;
revoke all on istem_notlari from anon, authenticated;
grant select, insert, delete on istem_notlari to authenticated;

do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'istem_notlari'
  loop
    execute format('drop policy %I on istem_notlari', pol.policyname);
  end loop;
end $$;

create policy istem_notlari_select on istem_notlari for select to authenticated using (true);
create policy istem_notlari_insert on istem_notlari for insert to authenticated
  with check (yazan_id = (select public.current_kullanici_id()));
create policy istem_notlari_delete on istem_notlari for delete to authenticated
  using (yazan_id = (select public.current_kullanici_id()) or (select public.is_admin()));

-- Taşıma: eski tekil not → not listesi (yazan = istemi açan, zaman = istem
-- zamanı). Tekrar çalıştırılırsa çift kayıt oluşmaz.
insert into istem_notlari (istem_id, yazan_id, metin, created_at)
select i.id, i.istem_yapan_id, i.not_metni, i.created_at
from istemler i
where nullif(btrim(i.not_metni), '') is not null
  and not exists (
    select 1 from istem_notlari n
    where n.istem_id = i.id and n.metin = i.not_metni and n.created_at = i.created_at
  );

-- Güvenlik ağı: önbellekte kalmış ESKİ uygulama sürümü yeni istemi hâlâ
-- not_metni ile açarsa not kaybolmasın — otomatik listeye kopyalanır.
-- (security definer: istemi açanın adına yazar; RLS'e takılmaz.)
create or replace function public.istemler_not_kopyala() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if nullif(btrim(new.not_metni), '') is not null then
    insert into istem_notlari (istem_id, yazan_id, metin, created_at)
    values (new.id, new.istem_yapan_id, new.not_metni, new.created_at);
  end if;
  return new;
end $$;
drop trigger if exists istemler_not_kopyala on istemler;
create trigger istemler_not_kopyala after insert on istemler
  for each row execute function public.istemler_not_kopyala();

-- Canlı güncelleme (yeni not tüm açık ekranlarda görünsün)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'istem_notlari'
  ) then
    alter publication supabase_realtime add table istem_notlari;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3) Kuyruk görünümü — yeni kolonlar SONA eklenir:
-- isteyen_kisaltma, uzman_kisaltma, notlar (en yeniden eskiye JSON).
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
  ik.kalite_notu,
  isteyen.kisaltma  as isteyen_kisaltma,
  uzman.kisaltma    as uzman_kisaltma,
  (
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', n.id, 'yazan_id', n.yazan_id, 'yazan', y.ad_soyad, 'kisaltma', y.kisaltma,
             'zaman', n.created_at, 'metin', n.metin
           ) order by n.created_at desc), '[]'::jsonb)
    from istem_notlari n
    left join kullanicilar y on y.id = n.yazan_id
    where n.istem_id = i.id
  ) as notlar
from istem_kalemleri ik
join istemler i             on i.id = ik.istem_id
left join test_katalog tk   on tk.id = ik.test_id
left join kullanicilar isteyen on isteyen.id = i.istem_yapan_id
left join kullanicilar uzman   on uzman.id   = i.uzman_id
left join cihazlar c        on c.id = ik.cihaz_id;

grant select on istem_kuyruk_v to authenticated;

-- ------------------------------------------------------------
-- 4) Durum geri alma kuralı (Tamamlandı→Cihazda, Cihazda→Bekleyen):
-- admin ve teknisyen HER kalemi; uzman/asistan yalnız KENDİ açtığı
-- istemin kalemlerini geri alabilir. RLS eski ve yeni satırı aynı anda
-- göremediği için trigger'da.
-- ------------------------------------------------------------
create or replace function public.istem_kalemleri_geri_alma_kontrol() returns trigger
language plpgsql set search_path = public as $$
declare
  eski int := case old.durum when 'bekleyen' then 0 when 'cihazda' then 1 when 'tamamlandi' then 2 end;
  yeni int := case new.durum when 'bekleyen' then 0 when 'cihazda' then 1 when 'tamamlandi' then 2 end;
begin
  if auth.uid() is not null
     and eski is not null and yeni is not null and yeni < eski
     and not (
       public.is_admin()
       or coalesce(public.current_rol(), '') = 'teknisyen'
       or exists (select 1 from istemler i where i.id = new.istem_id and i.istem_yapan_id = public.current_kullanici_id())
     )
  then
    raise exception 'Bu kalemin durumunu geri alma yetkiniz yok (yalnız kendi istemleriniz; teknisyen/yönetici hepsini)' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists istem_kalemleri_geri_alma_kontrol on istem_kalemleri;
create trigger istem_kalemleri_geri_alma_kontrol
  before update of durum on istem_kalemleri
  for each row execute function public.istem_kalemleri_geri_alma_kontrol();

-- ------------------------------------------------------------
-- 5) Tekrar İste — sebep artık not listesine yazılır.
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

  insert into istemler (patoloji_no, istem_yapan_id, uzman_id, oncelik)
  values (i.patoloji_no, ben, i.uzman_id, i.oncelik)
  returning id into yeni_istem;

  if nullif(btrim(p_not), '') is not null then
    insert into istem_notlari (istem_id, yazan_id, metin) values (yeni_istem, ben, btrim(p_not));
  end if;

  insert into istem_kalemleri (istem_id, blok_no, test_id, ozel_test, grup, tekrar_kaynagi_id)
  values (yeni_istem, k.blok_no, k.test_id, k.ozel_test, k.grup, k.id)
  returning id into yeni_kalem;

  insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
  values (yeni_kalem, null, 'bekleyen', ben);

  return yeni_kalem;
end $$;

-- Toplu Tekrar İste: yalnız Cihazda/Tamamlandı kalemlere uygulanır;
-- AYNI kaynak istemden gelen kalemler TEK yeni istemde toplanır (5 kalemlik
-- tekrar Hizmetler'de 5 ayrı satır olmasın). security invoker → RLS aynen
-- (teknisyen kuralı dahil). Dönen: { istem, kalem, atlanan }.
create or replace function public.tekrar_iste_toplu(p_kalem_ids uuid[], p_not text default null) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  ben uuid := public.current_kullanici_id();
  ids uuid[] := array(select distinct x from unnest(coalesce(p_kalem_ids, '{}'::uuid[])) as x);
  sebep text := nullif(btrim(p_not), '');
  g record;
  k record;
  yeni_istem uuid;
  yeni_kalem uuid;
  n_istem int := 0;
  n_kalem int := 0;
  uygun int;
begin
  if ben is null then
    raise exception 'Oturum kullanıcısı bulunamadı';
  end if;
  select count(*) into uygun from istem_kalemleri where id = any(ids) and durum in ('cihazda', 'tamamlandi');

  for g in
    select distinct ik.istem_id from istem_kalemleri ik
    where ik.id = any(ids) and ik.durum in ('cihazda', 'tamamlandi')
  loop
    insert into istemler (patoloji_no, istem_yapan_id, uzman_id, oncelik)
    select patoloji_no, ben, uzman_id, oncelik from istemler where id = g.istem_id
    returning id into yeni_istem;
    n_istem := n_istem + 1;

    if sebep is not null then
      insert into istem_notlari (istem_id, yazan_id, metin) values (yeni_istem, ben, sebep);
    end if;

    for k in
      select * from istem_kalemleri
      where istem_id = g.istem_id and id = any(ids) and durum in ('cihazda', 'tamamlandi')
      order by created_at, id
    loop
      insert into istem_kalemleri (istem_id, blok_no, test_id, ozel_test, grup, tekrar_kaynagi_id)
      values (yeni_istem, k.blok_no, k.test_id, k.ozel_test, k.grup, k.id)
      returning id into yeni_kalem;
      insert into istem_log (istem_kalem_id, eski_durum, yeni_durum, degistiren_id)
      values (yeni_kalem, null, 'bekleyen', ben);
      n_kalem := n_kalem + 1;
    end loop;
  end loop;

  return jsonb_build_object('istem', n_istem, 'kalem', n_kalem, 'atlanan', coalesce(array_length(ids, 1), 0) - uygun);
end $$;

revoke all on function public.tekrar_iste(uuid, text) from public, anon;
grant execute on function public.tekrar_iste(uuid, text) to authenticated;
revoke all on function public.tekrar_iste_toplu(uuid[], text) from public, anon;
grant execute on function public.tekrar_iste_toplu(uuid[], text) to authenticated;

-- ------------------------------------------------------------
-- 6) İstatistikler — canlı veriden, yalnız admin.
-- p_bas / p_bit: Türkiye yerel TARİHLERİ (ikisi de dahil);
-- p_periyot: 'week' (Pazartesi başlar) | 'month'.
--  - istem / kalem / tip / kullanıcı: kaydın created_at'i aralıktaysa,
--    created_at'in dönemine sayılır
--  - tamamlanma süresi: ŞU AN Tamamlandı olan kalemlerde, Tamamlandı'ya
--    SON geçiş (geri alınıp yeniden tamamlananda son tamamlama) − kalemin
--    created_at'i; TAMAMLANMA zamanı aralıktaysa sayılır ve tamamlanma
--    dönemine yazılır (istenme dönemine göre gruplamak son haftalarda
--    hâlâ açık kalemleri dışarıda bırakıp süreyi olduğundan kısa gösterir)
--  - silinmiş kalemler (durum geçmişiyle birlikte silindikleri için) sayılmaz
-- ------------------------------------------------------------
create or replace function public.istatistik(p_bas date, p_bit date, p_periyot text default 'week') returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  tz constant text := 'Europe/Istanbul';
  per text := case when p_periyot = 'month' then 'month' else 'week' end;
  bas_ts timestamptz;
  bit_ts timestamptz;
  sonuc jsonb;
begin
  if not public.is_admin() then
    raise exception 'İstatistikler yalnızca yönetici içindir' using errcode = '42501';
  end if;
  if p_bas is null or p_bit is null or p_bit < p_bas then
    raise exception 'Geçersiz tarih aralığı';
  end if;
  bas_ts := p_bas::timestamp at time zone tz;
  bit_ts := (p_bit + 1)::timestamp at time zone tz;

  with
  i as (
    select date_trunc(per, x.created_at at time zone tz)::date as d, x.istem_yapan_id
    from istemler x where x.created_at >= bas_ts and x.created_at < bit_ts
  ),
  k as (
    select date_trunc(per, x.created_at at time zone tz)::date as d, x.grup, (x.tekrar_kaynagi_id is not null) as tekrar
    from istem_kalemleri x where x.created_at >= bas_ts and x.created_at < bit_ts
  ),
  b as (
    select ik.created_at, max(l.created_at) as bitti
    from istem_kalemleri ik
    join istem_log l on l.istem_kalem_id = ik.id and l.yeni_durum = 'tamamlandi'
    where ik.durum = 'tamamlandi'
    group by ik.id, ik.created_at
  ),
  t as (
    select date_trunc(per, b.bitti at time zone tz)::date as d,
           (extract(epoch from (b.bitti - b.created_at)) / 3600.0)::double precision as saat
    from b where b.bitti >= bas_ts and b.bitti < bit_ts
  ),
  dn as (
    select generate_series(
             date_trunc(per, bas_ts at time zone tz),
             date_trunc(per, (bit_ts - interval '1 second') at time zone tz),
             ('1 ' || per)::interval
           )::date as d
  )
  select jsonb_build_object(
    'aralik', jsonb_build_object('bas', p_bas, 'bit', p_bit, 'periyot', per),
    'ozet', jsonb_build_object(
      'istem', (select count(*) from i),
      'kalem', (select count(*) from k),
      'tekrar', (select count(*) from k where k.tekrar),
      'tamamlanan', (select count(*) from t),
      'ort_saat', (select round(avg(t.saat)::numeric, 1) from t),
      'medyan_saat', (select round((percentile_cont(0.5) within group (order by t.saat))::numeric, 1) from t),
      'acik', (select count(*) from istem_kalemleri where durum in ('bekleyen', 'cihazda'))
    ),
    'donemler', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'd', dn.d,
        'istem', (select count(*) from i where i.d = dn.d),
        'kalem', (select count(*) from k where k.d = dn.d),
        'tekrar', (select count(*) from k where k.d = dn.d and k.tekrar),
        'tipler', (select coalesce(jsonb_object_agg(z.grup, z.n), '{}'::jsonb)
                   from (select k.grup, count(*) as n from k where k.d = dn.d group by k.grup) z),
        'tamamlanan', (select count(*) from t where t.d = dn.d),
        'ort_saat', (select round(avg(t.saat)::numeric, 1) from t where t.d = dn.d),
        'medyan_saat', (select round((percentile_cont(0.5) within group (order by t.saat))::numeric, 1) from t where t.d = dn.d)
      ) order by dn.d), '[]'::jsonb)
      from dn
    ),
    'tipler', (
      select coalesce(jsonb_agg(jsonb_build_object('kod', z.grup, 'ad', coalesce(tg.ad, z.grup), 'n', z.n) order by z.n desc), '[]'::jsonb)
      from (select k.grup, count(*) as n from k group by k.grup) z
      left join test_gruplari tg on tg.kod = z.grup
    ),
    'kullanicilar', (
      select coalesce(jsonb_agg(jsonb_build_object('id', z.uid, 'ad', coalesce(u.ad_soyad, '(silinmiş kullanıcı)'), 'kisaltma', u.kisaltma, 'istem', z.n) order by z.n desc), '[]'::jsonb)
      from (select i.istem_yapan_id as uid, count(*) as n from i group by i.istem_yapan_id) z
      left join kullanicilar u on u.id = z.uid
    )
  ) into sonuc;

  return sonuc;
end $$;

revoke all on function public.istatistik(date, date, text) from public, anon;
grant execute on function public.istatistik(date, date, text) to authenticated;

commit;

notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Doğrulama:
--   select count(*) from istem_notlari;                                     -- taşınan notlar
--   select count(*) from istemler where nullif(btrim(not_metni), '') is not null;  -- yukarıdakine eşit olmalı
--   select public.istatistik(current_date - 30, current_date, 'week');      -- admin oturumunda (SQL Editor'de is_admin false döner → hata normal)
-- ============================================================
