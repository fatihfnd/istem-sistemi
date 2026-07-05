// api.js — TEK veri erişim katmanı.
// Ekranlar (app.js) Supabase'i asla doğrudan çağırmaz, sadece burada
// export edilen Api.* fonksiyonlarını kullanır. Yarın on-prem bir
// backend'e geçilirse değişmesi gereken tek dosya budur.

(function () {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG || {};
  const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

  // config.js doldurulmadan gerçek bir Supabase client oluşturmayı deneme
  // (boş URL ile createClient senkron olarak fırlatır ve tüm script çöker).
  // Bunun yerine, ilk kullanımda net bir hata veren bir stub koy.
  const client = configured
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : new Proxy(
        {},
        {
          get() {
            throw new Error("Supabase yapılandırılmadı: config.js dosyasına SUPABASE_URL ve SUPABASE_ANON_KEY girin.");
          },
        }
      );

  function must(data, error) {
    if (error) throw error;
    return data;
  }

  // Yönetim ekranlarındaki "Sil" aksiyonlarının ortak yolu. Hiçbir tabloda
  // ON DELETE CASCADE yok (istek_seti_kalemleri hariç — o da bir setin
  // kendi alt kalemleri, başka bir yerdeki gerçek veri değil), bu yüzden
  // kayıt başka bir tabloda referans veriliyorsa Postgres kendisi
  // foreign_key_violation (23503) ile reddeder — burada bunu yakalayıp
  // anlamlı bir hataya çeviriyoruz. Ayrı "kullanılıyor mu" ön-kontrol
  // sorgusu YAZILMIYOR; veritabanının kendi referans bütünlüğüne güveniliyor.
  async function deleteRow(table, id) {
    const { error } = await client.from(table).delete().eq("id", id);
    if (error) {
      if (error.code === "23503") {
        const e = new Error("Bu kayıt kullanımda, önce pasifleştirin");
        e.isReferenced = true;
        throw e;
      }
      throw error;
    }
  }

  // Yöneticinin email+PIN'i — YALNIZCA bellekte (localStorage'a yazılmaz).
  // signUp() çağrıldığı an tarayıcının aktif Supabase Auth oturumunu YENİ
  // oluşturulan kullanıcıya çevirir; bunu hemen sonra bu bilgiyle
  // signInWithPassword ile yöneticinin kendi hesabına geri dönmek için
  // kullanılır. Sayfa yenilenince kaybolur.
  let _adminEmail = null;
  let _adminPin = null;

  async function restoreAdminSession() {
    if (!_adminEmail || !_adminPin) return;
    try {
      await client.auth.signInWithPassword({ email: _adminEmail, password: toAuthPassword(_adminPin) });
    } catch (e) {
      // sessizce geç — olursa kullanıcı oturumunu kaybettiğini görüp
      // yeniden giriş yapar, uygulamayı çökertmeye değmez.
    }
  }

  // Yönetilen Supabase'de şifre minimum uzunluğu sabit 6 (dashboard'dan
  // 4'e düşürülemiyor — cloud kısıtlaması), ama PIN'ler 4 hane. Kullanıcı
  // hâlâ 4 haneli PIN görür/girer; Auth'a giden gerçek şifre burada sabit
  // bir ek ile 6+ karaktere tamamlanır. TÜM signUp/signInWithPassword
  // çağrıları MUTLAKA bunun üzerinden geçmeli — aksi halde 422 alınır.
  function toAuthPassword(pin) {
    return String(pin ?? "") + "_pl";
  }

  const TR_MAP = { ı: "i", İ: "i", ğ: "g", Ğ: "g", ü: "u", Ü: "u", ş: "s", Ş: "s", ö: "o", Ö: "o", ç: "c", Ç: "c" };
  function slugifyEmail(adSoyad) {
    let s = String(adSoyad ?? "").replace(/^Dr\.?\s*/i, "").trim();
    s = s.split("").map((ch) => TR_MAP[ch] || ch).join("");
    s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    s = s.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
    return s || "kullanici";
  }
  async function uniqueEmailFor(adSoyad) {
    const base = slugifyEmail(adSoyad);
    let candidate = `${base}@istem.local`;
    let n = 2;
    while (true) {
      const { data } = await client.from("kullanicilar").select("id").eq("email", candidate).maybeSingle();
      if (!data) return candidate;
      candidate = `${base}.${n}@istem.local`;
      n++;
    }
  }

  const Api = {
    // ---------------- Auth (ad seç + PIN) ----------------
    // kullanicilar_login_v — authenticated-only kilitlemeden SONRA bile
    // anon'un okuyabildiği dar, güvenli dilim (id/ad_soyad — pin/rol yok).
    async listActiveUsers() {
      const { data, error } = await client
        .from("kullanicilar_login_v")
        .select("id,ad_soyad")
        .order("ad_soyad");
      return must(data, error);
    },

    async login(kullaniciId, pin) {
      const { data: row, error: e1 } = await client
        .from("kullanicilar_login_v")
        .select("id,ad_soyad,email")
        .eq("id", kullaniciId)
        .maybeSingle();
      if (e1 || !row) return null;

      // 1) Asıl yol: gerçek Supabase Auth.
      if (row.email) {
        const { error: e2 } = await client.auth.signInWithPassword({ email: row.email, password: toAuthPassword(pin) });
        if (!e2) {
          _adminEmail = row.email;
          _adminPin = String(pin ?? "");
          const { data: profile, error: e3 } = await client
            .from("kullanicilar")
            .select("id,ad_soyad,rol")
            .eq("id", kullaniciId)
            .maybeSingle();
          if (e3 || !profile) return null;
          return { id: profile.id, ad_soyad: profile.ad_soyad, rol: profile.rol };
        }
      }

      // 2) GEÇİCİ fallback — henüz Auth'a taşınmamış kullanıcılar için.
      // secure_rls_authenticated.sql çalıştıktan sonra kullanicilar
      // authenticated-only olacağı için bu yol zaten çalışmaz hale gelir
      // (RLS reddeder) — migrasyon tamamlanınca bu blok kaldırılabilir.
      try {
        const { data, error } = await client
          .from("kullanicilar")
          .select("id,ad_soyad,rol,pin")
          .eq("id", kullaniciId)
          .eq("aktif", true)
          .maybeSingle();
        if (error || !data || String(data.pin ?? "") !== String(pin ?? "")) return null;
        return { id: data.id, ad_soyad: data.ad_soyad, rol: data.rol };
      } catch (e) {
        return null;
      }
    },

    async signOut() {
      try { await client.auth.signOut(); } catch (e) { /* zaten çıkışta, önemli değil */ }
      _adminEmail = null;
      _adminPin = null;
    },

    // Boot'ta gerçek Supabase Auth oturumu var mı diye bakar (localStorage'a
    // körü körüne güvenmek yerine) — varsa app-level profile'ı döner.
    async getCurrentAuthSession() {
      const { data } = await client.auth.getSession();
      const session = data?.session;
      if (!session) return null;
      const { data: profile, error } = await client
        .from("kullanicilar")
        .select("id,ad_soyad,rol")
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      if (error || !profile) return null;
      return { id: profile.id, ad_soyad: profile.ad_soyad, rol: profile.rol };
    },

    // ---------------- Kullanıcılar (yönetim) ----------------
    // Aktif filtresi yok — yönetim listesi pasif kullanıcıları da
    // gösterip yeniden aktifleştirebilsin.
    async getAllKullanicilar() {
      const { data, error } = await client
        .from("kullanicilar")
        .select("id,ad_soyad,rol,pin,email,auth_user_id,aktif")
        .order("ad_soyad");
      return must(data, error);
    },

    // PIN burada artık kullanicilar.pin'e YAZILMIYOR — parola kaynağı
    // sadece Supabase Auth. signUp() geçici olarak tarayıcının Auth
    // oturumunu bu yeni kullanıcıya çevirir; hemen ardından yöneticinin
    // kendi oturumu geri yüklenir (restoreAdminSession).
    async createKullanici({ ad_soyad, rol, pin }) {
      const email = await uniqueEmailFor(ad_soyad);
      const { data: signUpData, error: e1 } = await client.auth.signUp({ email, password: toAuthPassword(pin) });
      if (e1) throw e1;
      const authUserId = signUpData?.user?.id || null;
      const { data, error: e2 } = await client
        .from("kullanicilar")
        .insert({ ad_soyad, rol, email, auth_user_id: authUserId })
        .select()
        .single();
      if (e2) throw e2;
      await restoreAdminSession();
      return data;
    },

    // PIN artık düzenlenemiyor (başka birinin şifresini service_role
    // olmadan değiştiremeyiz) — sadece ad/rol.
    async updateKullanici(id, { ad_soyad, rol }) {
      const { error } = await client
        .from("kullanicilar")
        .update({ ad_soyad, rol })
        .eq("id", id);
      if (error) throw error;
    },

    async setKullaniciAktif(id, aktif) {
      const { error } = await client.from("kullanicilar").update({ aktif }).eq("id", id);
      if (error) throw error;
    },

    // Bir Auth hesabı varsa kalıcı silme reddedilir — service_role olmadan
    // eşleşen auth.users kaydını silemeyiz; kullanicilar satırını silmek
    // o hesabı "sahipsiz" ama hâlâ giriş yapılabilir bırakır (RLS
    // authenticated-only olduğu için bu bir güvenlik açığı olurdu).
    // Auth hesabı olsa bile silme engellenmiyor: service_role olmadan
    // eşleşen auth.users kaydını zaten silemiyoruz (bilinen kısıt), ama
    // giriş akışı auth doğrulamasından SONRA mutlaka kullanicilar'dan
    // profil arıyor — bu satır silinince o hesap uygulama üzerinden
    // kullanılamaz hale gelir. Referans kontrolü (geçmiş istemler vb.)
    // hâlâ geçerli — deleteRow FK ihlalini yakalar.
    async deleteKullanici(id) {
      return deleteRow("kullanicilar", id);
    },

    // Kullanıcılar sayfasındaki "Auth hesabı olmayanları taşı" — legacy
    // bir satırı (mevcut düz-metin pin'ini şifre olarak kullanarak) gerçek
    // bir Supabase Auth hesabına bağlar. İdempotent: auth_user_id zaten
    // doluysa no-op.
    async migrateKullaniciToAuth(row) {
      if (row.auth_user_id) return { skipped: true };
      const email = row.email || (await uniqueEmailFor(row.ad_soyad));
      const { data: signUpData, error: e1 } = await client.auth.signUp({ email, password: toAuthPassword(row.pin) });
      if (e1) throw e1;
      const authUserId = signUpData?.user?.id || null;
      const { error: e2 } = await client
        .from("kullanicilar")
        .update({ email, auth_user_id: authUserId })
        .eq("id", row.id);
      if (e2) throw e2;
      await restoreAdminSession();
      return { skipped: false };
    },

    // ---------------- Test kataloğu / hazır setler ----------------
    async getTestKatalog() {
      const { data, error } = await client
        .from("test_katalog")
        .select("id,grup,ad,klon")
        .eq("aktif", true)
        .order("sira");
      must(data, error);
      const out = {};
      data.forEach((r) => {
        (out[r.grup] ??= []).push({ id: r.id, ad: r.ad, klon: r.klon || "", grup: r.grup });
      });
      return out;
    },

    // ---------------- Test grupları (yönetim) ----------------
    async getTestGruplari() {
      const { data, error } = await client
        .from("test_gruplari")
        .select("id,kod,ad,sira,aktif")
        .eq("aktif", true)
        .order("sira");
      return must(data, error);
    },

    async createTestGrubu({ kod, ad, sira }) {
      const { data, error } = await client
        .from("test_gruplari")
        .insert({ kod, ad, sira: sira ?? 0 })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    // Yönetim sayfası — aktif+pasif hepsi (pasifleri geri açabilmek için).
    async getAllTestGruplari() {
      const { data, error } = await client
        .from("test_gruplari")
        .select("id,kod,ad,sira,aktif")
        .order("sira");
      return must(data, error);
    },

    async updateTestGrubu(id, { ad, sira }) {
      const { error } = await client.from("test_gruplari").update({ ad, sira: sira ?? 0 }).eq("id", id);
      if (error) throw error;
    },

    async setTestGrubuAktif(id, aktif) {
      const { error } = await client.from("test_gruplari").update({ aktif }).eq("id", id);
      if (error) throw error;
    },

    async deleteTestGrubu(id) {
      return deleteRow("test_gruplari", id);
    },

    // Yeni İstek formundaki "Tek Tek Seç" arama kutusundan hızlı ekleme —
    // sıra otomatik en sona (grup içindeki mevcut en yüksek sira + 10).
    async addTestKatalogQuick(grup, ad) {
      const { data: maxRows, error: e0 } = await client
        .from("test_katalog")
        .select("sira")
        .eq("grup", grup)
        .order("sira", { ascending: false })
        .limit(1);
      if (e0) throw e0;
      const nextSira = (maxRows && maxRows[0] ? maxRows[0].sira : 0) + 10;
      const { data, error } = await client
        .from("test_katalog")
        .insert({ grup, ad, klon: null, sira: nextSira })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    async createTestKatalogEntry({ grup, ad, klon, sira }) {
      const { data, error } = await client
        .from("test_katalog")
        .insert({ grup, ad, klon: klon || null, sira: sira ?? 0 })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    // Test Kataloğu yönetim ekranındaki "Toplu Ekle" — dublicate ayıklama
    // (aynı isim+grup) app.js'te yapılır; burası sadece toplu insert eder.
    // items: [{ad, klon}]
    async bulkCreateTestKatalogEntries(grup, items) {
      if (!items.length) return [];
      const { data: maxRows, error: e0 } = await client
        .from("test_katalog")
        .select("sira")
        .eq("grup", grup)
        .order("sira", { ascending: false })
        .limit(1);
      if (e0) throw e0;
      let sira = maxRows && maxRows[0] ? maxRows[0].sira : 0;
      const rows = items.map((it) => {
        sira += 10;
        return { grup, ad: it.ad, klon: it.klon || null, sira };
      });
      const { data, error } = await client.from("test_katalog").insert(rows).select();
      if (error) throw error;
      return data;
    },

    async updateTestKatalogEntry(id, { ad, klon, sira }) {
      const { error } = await client.from("test_katalog").update({ ad, klon: klon || null, sira: sira ?? 0 }).eq("id", id);
      if (error) throw error;
    },

    async setTestKatalogAktif(id, aktif) {
      const { error } = await client.from("test_katalog").update({ aktif }).eq("id", id);
      if (error) throw error;
    },

    async deleteTestKatalogEntry(id) {
      return deleteRow("test_katalog", id);
    },

    // Yönetim sayfası — tek bir grubun TÜM kalemleri (aktif+pasif).
    async getTestKatalogByGrup(grup) {
      const { data, error } = await client
        .from("test_katalog")
        .select("id,grup,ad,klon,sira,aktif")
        .eq("grup", grup)
        .order("sira");
      return must(data, error);
    },

    // Kurumsal, herkese açık "hazır setler" (owner yok).
    // Aktif filtresi yok — yönetim ekranı pasif setleri de görüp geri
    // aktifleştirebilsin; hızlı-doldurma tarafında (app.js) aktif=true
    // olanlar client-side ayrıştırılıyor.
    async getIstekSetleri() {
      const { data, error } = await client
        .from("istek_setleri")
        .select("id,grup,ad,uzmanlik,sira,aktif,istek_seti_kalemleri(test_id,ozel_test,test_katalog(id,ad,klon))")
        .order("sira");
      must(data, error);
      return data.map((s) => ({
        id: s.id, grup: s.grup, ad: s.ad, uzmanlik: s.uzmanlik, aktif: s.aktif,
        testler: (s.istek_seti_kalemleri || [])
          .map((k) =>
            k.test_katalog
              ? { id: k.test_katalog.id, ad: k.test_katalog.ad, klon: k.test_katalog.klon || "", grup: s.grup, custom: false }
              : { ad: k.ozel_test, grup: s.grup, custom: true }
          )
          .filter((t) => t.ad),
      }));
    },

    async createIstekSeti({ grup, ad, uzmanlik, testler }) {
      const { data: s, error: e1 } = await client
        .from("istek_setleri")
        .insert({ grup, ad, uzmanlik: uzmanlik || null })
        .select()
        .single();
      if (e1) throw e1;
      if (testler.length) {
        const kalemler = testler.map((t) => ({ istek_seti_id: s.id, test_id: t.test_id || null, ozel_test: t.ozel_test || null }));
        const { error: e2 } = await client.from("istek_seti_kalemleri").insert(kalemler);
        if (e2) throw e2;
      }
      return s;
    },

    async updateIstekSeti(id, { ad, grup, uzmanlik, testler }) {
      const { error: e1 } = await client.from("istek_setleri").update({ ad, grup, uzmanlik: uzmanlik || null }).eq("id", id);
      if (e1) throw e1;
      const { error: e2 } = await client.from("istek_seti_kalemleri").delete().eq("istek_seti_id", id);
      if (e2) throw e2;
      if (testler.length) {
        const kalemler = testler.map((t) => ({ istek_seti_id: id, test_id: t.test_id || null, ozel_test: t.ozel_test || null }));
        const { error: e3 } = await client.from("istek_seti_kalemleri").insert(kalemler);
        if (e3) throw e3;
      }
    },

    async setIstekSetiAktif(id, aktif) {
      const { error } = await client.from("istek_setleri").update({ aktif }).eq("id", id);
      if (error) throw error;
    },

    // İstek Setleri'nin kendi kalemleri (istek_seti_kalemleri) ON DELETE
    // CASCADE ile tanımlı — bunlar başka yerde referans veren veri değil,
    // setin kendi alt satırları, o yüzden bu silme bloklanmaz.
    async deleteIstekSeti(id) {
      return deleteRow("istek_setleri", id);
    },

    // Kişiye özel şablonlar (sahip_id = giriş yapan kullanıcı).
    async getMySablonlar(userId) {
      const { data, error } = await client
        .from("sablonlar")
        .select("id,grup,ad,sablon_kalemleri(test_id,ozel_test,test_katalog(id,ad,klon))")
        .eq("sahip_id", userId)
        .order("ad");
      must(data, error);
      return data.map((s) => ({
        id: s.id, grup: s.grup, ad: s.ad,
        testler: (s.sablon_kalemleri || [])
          .map((k) =>
            k.test_katalog
              ? { id: k.test_katalog.id, ad: k.test_katalog.ad, klon: k.test_katalog.klon || "", grup: s.grup, custom: false }
              : { ad: k.ozel_test, grup: s.grup, custom: true }
          )
          .filter((t) => t.ad),
      }));
    },

    async createSablon({ sahip_id, grup, ad, testler }) {
      const { data: s, error: e1 } = await client
        .from("sablonlar")
        .insert({ sahip_id, grup, ad })
        .select()
        .single();
      if (e1) throw e1;
      if (testler.length) {
        const kalemler = testler.map((t) => ({ sablon_id: s.id, test_id: t.test_id || null, ozel_test: t.ozel_test || null }));
        const { error: e2 } = await client.from("sablon_kalemleri").insert(kalemler);
        if (e2) throw e2;
      }
      return s;
    },

    async updateSablon(id, { ad, grup, testler }) {
      const { error: e1 } = await client.from("sablonlar").update({ ad, grup }).eq("id", id);
      if (e1) throw e1;
      const { error: e2 } = await client.from("sablon_kalemleri").delete().eq("sablon_id", id);
      if (e2) throw e2;
      if (testler.length) {
        const kalemler = testler.map((t) => ({ sablon_id: id, test_id: t.test_id || null, ozel_test: t.ozel_test || null }));
        const { error: e3 } = await client.from("sablon_kalemleri").insert(kalemler);
        if (e3) throw e3;
      }
    },

    async deleteSablon(id) {
      const { error } = await client.from("sablonlar").delete().eq("id", id);
      if (error) throw error;
    },

    // ---------------- Cihazlar ----------------
    async getCihazlar(onlyActive) {
      let q = client.from("cihazlar").select("id,ad,tip,aktif").order("ad");
      if (onlyActive) q = q.eq("aktif", true);
      const { data, error } = await q;
      return must(data, error);
    },

    async createCihaz({ ad, tip }) {
      const { data, error } = await client.from("cihazlar").insert({ ad, tip: tip || null }).select().single();
      if (error) throw error;
      return data;
    },

    async updateCihaz(id, { ad, tip }) {
      const { error } = await client.from("cihazlar").update({ ad, tip: tip || null }).eq("id", id);
      if (error) throw error;
    },

    async setCihazAktif(id, aktif) {
      const { error } = await client.from("cihazlar").update({ aktif }).eq("id", id);
      if (error) throw error;
    },

    async deleteCihaz(id) {
      return deleteRow("cihazlar", id);
    },

    async assignCihaz(kalemId, cihazId) {
      const { error } = await client
        .from("istem_kalemleri")
        .update({ cihaz_id: cihazId || null, updated_at: new Date().toISOString() })
        .eq("id", kalemId);
      if (error) throw error;
    },

    // ---------------- Son kullanılanlar (test seçici + Hazır Setler önceliklendirme) ----------------
    // son_kullanilanlar_sema.sql ile kurulur (bkz. proje kökü). Tablo/view
    // henüz yoksa (sql çalıştırılmadıysa) çağıran taraf (initApp) bunu
    // Promise.allSettled ile tolere edip eski (tam liste) davranışa düşer.
    async getSonKullanilanTestler(kullaniciId) {
      const { data, error } = await client
        .from("istem_test_kullanim_v")
        .select("test_id,grup,son_kullanim")
        .eq("kullanici_id", kullaniciId)
        .order("son_kullanim", { ascending: false });
      return must(data, error);
    },

    async getSonKullanilanSetler(kullaniciId) {
      const { data, error } = await client
        .from("set_kullanim_v")
        .select("istek_seti_id,son_kullanim,kullanim_sayisi")
        .eq("kullanici_id", kullaniciId)
        .order("son_kullanim", { ascending: false });
      return must(data, error);
    },

    // Best-effort telemetri — bir Hazır Set quick-fill ile forma dolduğunda
    // çağrılır. Çağıran taraf .catch ile yutar, forma engel olmaz.
    async logSetKullanimi(kullaniciId, istekSetiId) {
      const { error } = await client
        .from("set_kullanim_log")
        .insert({ kullanici_id: kullaniciId, istek_seti_id: istekSetiId });
      if (error) throw error;
    },

    // ---------------- Yedekler (otomatik günlük yedek — Storage) ----------------
    // "yedekler" private bucket'ı ve daily-backup Edge Function'ı
    // yedekler_sema.sql ile kurulur (bkz. proje kökü).
    async listYedekler() {
      const { data, error } = await client.storage
        .from("yedekler")
        .list("", { sortBy: { column: "created_at", order: "desc" } });
      return must(data, error);
    },

    // Bucket private olduğu için doğrudan link çalışmaz — kısa ömürlü
    // (60sn) imzalı bir indirme URL'i alınır.
    async getYedekIndirLink(path) {
      const { data, error } = await client.storage
        .from("yedekler")
        .createSignedUrl(path, 60);
      return must(data, error).signedUrl;
    },

    // ---------------- Hizmetler (faturalama) ----------------
    // Tüm kullanıcılar (aktif filtresi yok — geçmişte pasif olmuş
    // kullanıcının adı da eski kayıtlarda görünmeye devam etsin).
    async getKullaniciMap() {
      const { data, error } = await client.from("kullanicilar").select("id,ad_soyad");
      must(data, error);
      const map = {};
      data.forEach((u) => { map[u.id] = u.ad_soyad; });
      return map;
    },

    // istemler.istem_yapan_id VE fatura_giren_id ikisi de kullanicilar'a
    // referans veriyor — PostgREST nested embed bu durumda belirsiz olur,
    // bu yüzden isimler burada client-side çözülüyor (getKullaniciMap ile).
    async getHizmetler() {
      const [istemRes, kullaniciMap] = await Promise.all([
        client
          .from("istemler")
          .select("id,patoloji_no,istem_yapan_id,uzman_id,created_at,fatura_girildi,fatura_giren_id,fatura_zamani,istem_kalemleri(grup)")
          .order("created_at", { ascending: false }),
        this.getKullaniciMap(),
      ]);
      must(istemRes.data, istemRes.error);

      const grupSira = Object.fromEntries(["ihc", "hk", "mol", "kesit", "hucre", "yayma", "diger"].map((g, i) => [g, i]));
      return istemRes.data.map((i) => {
        const counts = {};
        (i.istem_kalemleri || []).forEach((k) => { counts[k.grup] = (counts[k.grup] || 0) + 1; });
        const ozet = Object.entries(counts)
          .sort((a, b) => (grupSira[a[0]] ?? 99) - (grupSira[b[0]] ?? 99))
          .map(([grup, count]) => ({ grup, count }));
        return {
          istem_id: i.id,
          patoloji_no: i.patoloji_no,
          isteyen_adi: kullaniciMap[i.istem_yapan_id] || "—",
          uzman_adi: i.uzman_id ? kullaniciMap[i.uzman_id] || "—" : "—",
          created_at: i.created_at,
          ozet,
          fatura_girildi: i.fatura_girildi,
          fatura_giren_adi: i.fatura_giren_id ? kullaniciMap[i.fatura_giren_id] || "—" : null,
          fatura_zamani: i.fatura_zamani,
        };
      });
    },

    async markFaturaGirildi(istemId, kullaniciId) {
      const { error } = await client
        .from("istemler")
        .update({ fatura_girildi: true, fatura_giren_id: kullaniciId, fatura_zamani: new Date().toISOString() })
        .eq("id", istemId);
      if (error) throw error;
    },

    subscribeHizmetler(onChange) {
      const channel = client
        .channel("hizmetler-realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "istemler" }, onChange)
        .subscribe();
      return () => client.removeChannel(channel);
    },

    async getUzmanlar() {
      const { data, error } = await client
        .from("kullanicilar")
        .select("id,ad_soyad")
        .eq("aktif", true)
        .eq("rol", "uzman")
        .order("ad_soyad");
      return must(data, error);
    },

    // ---------------- İş kuyruğu ----------------
    // "Tümü" sekmesinde durum değişince satır sıçramasın diye ikincil,
    // sabit bir sıralama anahtarı (kalem_id) şart: aynı istemden gelen
    // kalemler genelde aynı created_at'e sahip (tek INSERT), bu yüzden
    // sadece created_at'e göre sıralamak eşit değerlerde Postgres'in
    // fiziksel satır sırasına bağlı kalır — bir UPDATE (durum değişimi)
    // o satırın fiziksel konumunu değiştirip sırayı bozabilir.
    async listQueue() {
      const { data, error } = await client
        .from("istem_kuyruk_v")
        .select("*")
        .order("created_at", { ascending: false })
        .order("kalem_id", { ascending: true });
      return must(data, error);
    },

    async getTimeline(kalemId) {
      const { data, error } = await client
        .from("istem_log")
        .select("eski_durum,yeni_durum,created_at,kullanicilar(ad_soyad)")
        .eq("istem_kalem_id", kalemId)
        .order("created_at");
      return must(data, error);
    },

    async advanceDurum(kalemId, yeniDurum, degistirenId) {
      const { data: cur, error: e1 } = await client
        .from("istem_kalemleri")
        .select("durum")
        .eq("id", kalemId)
        .single();
      must(cur, e1);

      const { error: e2 } = await client
        .from("istem_kalemleri")
        .update({ durum: yeniDurum, updated_at: new Date().toISOString() })
        .eq("id", kalemId);
      if (e2) throw e2;

      const { error: e3 } = await client.from("istem_log").insert({
        istem_kalem_id: kalemId,
        eski_durum: cur.durum,
        yeni_durum: yeniDurum,
        degistiren_id: degistirenId,
      });
      if (e3) throw e3;
    },

    // items: [{test_id}|{ozel_test}], bloklar: ["1","2",...]
    // -> her blok x her test için ayrı bir istem_kalemi satırı
    async createIstem({ patoloji_no, istem_yapan_id, uzman_id, oncelik, not_metni, bloklar, testler }) {
      const { data: istem, error: e1 } = await client
        .from("istemler")
        .insert({ patoloji_no, istem_yapan_id, uzman_id, oncelik, not_metni })
        .select()
        .single();
      if (e1) throw e1;

      const kalemler = [];
      bloklar.forEach((blok_no) => {
        testler.forEach((t) => {
          kalemler.push({
            istem_id: istem.id,
            blok_no,
            test_id: t.test_id || null,
            ozel_test: t.ozel_test || null,
            grup: t.grup,
          });
        });
      });

      const { data: ikList, error: e2 } = await client
        .from("istem_kalemleri")
        .insert(kalemler)
        .select();
      if (e2) throw e2;

      const logs = ikList.map((ik) => ({
        istem_kalem_id: ik.id,
        eski_durum: null,
        yeni_durum: "bekleyen",
        degistiren_id: istem_yapan_id,
      }));
      const { error: e3 } = await client.from("istem_log").insert(logs);
      if (e3) throw e3;

      return istem;
    },

    // İstem detay panelindeki "Sil" — yanlış girilen tek bir kalemi düzeltmek
    // için. Sadece o istem_kalemleri satırı (ve ON DELETE CASCADE ile onun
    // istem_log kayıtları) silinir; kardeş kalemlere ve istemler üst kaydına
    // dokunulmaz. İstemin son kalemi silinmişse (artık boş kaldığı için)
    // üst istemler kaydı da ayrıca silinir.
    async deleteIstemKalem(kalemId) {
      const { data: kalem, error: e0 } = await client
        .from("istem_kalemleri")
        .select("istem_id")
        .eq("id", kalemId)
        .maybeSingle();
      if (e0) throw e0;
      if (!kalem) return;

      const { error: e1 } = await client.from("istem_kalemleri").delete().eq("id", kalemId);
      if (e1) throw e1;

      const { count, error: e2 } = await client
        .from("istem_kalemleri")
        .select("id", { count: "exact", head: true })
        .eq("istem_id", kalem.istem_id);
      if (e2) throw e2;

      if (!count) {
        const { error: e3 } = await client.from("istemler").delete().eq("id", kalem.istem_id);
        if (e3) throw e3;
      }
    },

    // ---------------- Realtime ----------------
    // İş kuyruğunu etkileyen herhangi bir değişiklikte onChange() çağrılır.
    // Dönen fonksiyon çağrılınca abonelik iptal edilir.
    subscribeQueue(onChange) {
      const channel = client
        .channel("istem-kuyruk-realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "istem_kalemleri" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "istem_log" }, onChange)
        .subscribe();
      return () => client.removeChannel(channel);
    },

    // İstek Setleri sayfası — kurumsal setler başka biri tarafından
    // eklenince/düzenlenince açık ekranlar canlı güncellensin.
    subscribeIstekSetleri(onChange) {
      const channel = client
        .channel("istek-setleri-realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "istek_setleri" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "istek_seti_kalemleri" }, onChange)
        .subscribe();
      return () => client.removeChannel(channel);
    },

    // Cihazlar sayfası — canlı güncelleme.
    subscribeCihazlar(onChange) {
      const channel = client
        .channel("cihazlar-realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "cihazlar" }, onChange)
        .subscribe();
      return () => client.removeChannel(channel);
    },
  };

  window.Api = Api;
})();
