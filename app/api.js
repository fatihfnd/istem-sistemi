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
  // realtime.worker: canlı tutma sinyali (heartbeat) Web Worker'da — arka
  // plandaki sekmede tarayıcı zamanlayıcıları kısınca bağlantı kopmasın
  // (kopunca sunucu o sekmenin "yazıyor" kaydını siler, canlı güncellemeler
  // de gecikir). Desteklemeyen sürümde seçenek yok sayılır.
  const client = configured
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        realtime: {
          worker: true,
          heartbeatCallback: (durum) => {
            if (durum !== "sent" && durum !== "ok") console.info("[yazıyor]", new Date().toLocaleTimeString("tr-TR"), "bağlantı sinyali:", durum);
          },
        },
      })
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

  // RLS bir DELETE'i reddettiğinde PostgREST hata DÖNMEZ — sadece 0 satır
  // siler. Silme çağrıları bu yüzden .select("id") ile dönen satırları
  // kontrol eder; hiç satır dönmediyse bu hatayı fırlatır.
  // kullanicilar satırı → uygulamanın oturum nesnesi (bkz. login / getCurrentAuthSession).
  const PROFIL_KOLONLARI = "id,ad_soyad,kisaltma,ekip,rol,is_admin,avatar_url";
  function profilOturumu(p) {
    return {
      id: p.id,
      ad_soyad: p.ad_soyad,
      kisaltma: p.kisaltma || null,
      ekip: p.ekip || null,
      rol: p.rol,
      is_admin: Boolean(p.is_admin),
      avatar_url: p.avatar_url || null,
    };
  }

  function forbiddenError() {
    const e = new Error("Bu işlem için yetkiniz yok");
    e.isForbidden = true;
    return e;
  }

  // Yönetim ekranlarındaki "Sil" aksiyonlarının ortak yolu. Hiçbir tabloda
  // ON DELETE CASCADE yok (istek_seti_kalemleri hariç — o da bir setin
  // kendi alt kalemleri, başka bir yerdeki gerçek veri değil), bu yüzden
  // kayıt başka bir tabloda referans veriliyorsa Postgres kendisi
  // foreign_key_violation (23503) ile reddeder — burada bunu yakalayıp
  // anlamlı bir hataya çeviriyoruz. Ayrı "kullanılıyor mu" ön-kontrol
  // sorgusu YAZILMIYOR; veritabanının kendi referans bütünlüğüne güveniliyor.
  async function deleteRow(table, id) {
    const { data, error } = await client.from(table).delete().eq("id", id).select("id");
    if (error) {
      if (error.code === "23503") {
        const e = new Error("Bu kayıt kullanımda, önce pasifleştirin");
        e.isReferenced = true;
        throw e;
      }
      throw error;
    }
    if (!data || !data.length) throw forbiddenError();
  }

  // Yeni kullanıcının Auth hesabı AYRI, oturum saklamayan bir client ile
  // açılır: signUp() ana client'ta çağrılsaydı tarayıcının oturumu yeni
  // kullanıcıya geçerdi (ve kullanicilar insert'i — artık sadece admin'e
  // açık — yeni kullanıcının yetkisiyle yapılırdı). Böylece yöneticinin
  // oturumuna hiç dokunulmaz.
  function signupClient() {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: "istem-signup-tmp" },
    });
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

  // teslim_sema.sql / toplu_sema.sql çalışmadan önce görünümde ilgili kolonlar
  // yok — bir kez anlaşılınca sayfa yenilenene kadar eski sorgu kullanılır.
  let teslimKolonuYok = false, topluKolonuYok = false;
  const kolonYokHatasi = (e) => Boolean(e && (e.code === "42703" || /teslim_|toplu_|istem_created_at/.test(String(e.message || ""))));
  // kons_eski_sema.sql: istem_kalemleri.tamamlandi_at (görünümde) ve
  // istemler.kons_no. SQL çalışmadıysa tamamlanan penceresi created_at'e
  // göre (eski sorgu) uygulanır, konsültasyon alanı gizlenir.
  let tamamKolonuYok = false;
  let konsDurum = null; // null: henüz yoklanmadı · true/false
  const tamamKolonHatasi = (e) => Boolean(e && /tamamlandi_at|kons_no/.test(String(e.message || "")));

  // ---------------- Performans (performans_sema.sql) ----------------
  // istem_ozellikler(): hangi parçalar kurulu ({ getir, canli_yayin, ... }).
  // Oturumda bir kez okunur; fonksiyon yoksa {} (eski sorgular, tablo dinleme).
  let ozellik = null, ozellikIstegi = null;
  async function ozellikYokla() {
    if (ozellik) return ozellik;
    if (!ozellikIstegi) {
      ozellikIstegi = (async () => {
        try {
          const { data, error } = await client.rpc("istem_ozellikler");
          ozellik = !error && data && typeof data === "object" ? { ...data } : {};
        } catch (e) { ozellik = {}; }
        return ozellik;
      })();
    }
    return ozellikIstegi;
  }
  const fonksiyonYok = (e) => Boolean(e && (e.code === "PGRST202" || e.code === "42883" || /could not find the function|does not exist/i.test(String(e.message || ""))));

  // Kişi adları: ince liste isim yerine kimlik taşır; adlar oturum başında
  // bir kez çekilen kullanıcı listesinden tamamlanır. Bilinmeyen kimlik
  // görülünce (yeni kullanıcı) ya da kullanicilar değişince tazelenir.
  let kisiler = null, kisiZamani = 0, kisiIstegi = null;
  async function kisileriYukle(zorla = false) {
    if (kisiler && !zorla) return kisiler;
    if (kisiIstegi) return kisiIstegi;
    kisiIstegi = (async () => {
      const { data, error } = await client.from("kullanicilar").select("id,ad_soyad,kisaltma");
      must(data, error);
      const m = {};
      data.forEach((u) => { m[u.id] = { ad: u.ad_soyad, kisaltma: u.kisaltma || null }; });
      kisiler = m;
      kisiZamani = Date.now();
      return m;
    })();
    try { return await kisiIstegi; } finally { kisiIstegi = null; }
  }
  const KISI_KOLON = [["istem_yapan_id", "isteyen"], ["uzman_id", "uzman"], ["kesen_id", "kesen"], ["blok_cikaran_id", "cikaran"], ["teslim_alan_id", "teslim_alan"]];
  function bilinmeyenKisiVar(liste) {
    if (!kisiler) return true;
    return liste.some((r) => KISI_KOLON.some(([k]) => r[k] && !kisiler[r[k]]) || (r.son_not && r.son_not.yazan_id && !kisiler[r.son_not.yazan_id]));
  }
  const kisi = (id) => (id && kisiler && kisiler[id]) || null;
  // Tam görünümdeki (istem_kuyruk_v) ad alanları ince satıra eklenir —
  // ekranlar iki kaynaktan gelen satırı aynı biçimde kullanır.
  function adlariTamamla(r) {
    KISI_KOLON.forEach(([k, on]) => {
      const u = kisi(r[k]);
      r[on + "_adi"] = r[k] ? (u ? u.ad : null) : null;
      r[on + "_kisaltma"] = u ? u.kisaltma : null;
    });
    if (r.son_not) { const u = kisi(r.son_not.yazan_id); r.son_not = { ...r.son_not, yazan: u ? u.ad : null, kisaltma: u ? u.kisaltma : null }; }
    ["yazdirmalar", "duzeltmeler"].forEach((alan) => {
      if (!r[alan]) return;
      const yeni = {};
      Object.entries(r[alan]).forEach(([k, v]) => { const u = kisi(v && v.kim_id); yeni[k] = { ...v, kim: u ? u.ad : (v && v.kim) || null, kisaltma: u ? u.kisaltma : (v && v.kisaltma) || null }; });
      r[alan] = yeni;
    });
    return r;
  }
  // kuyruk_getir yanıtı (sütun adları bir kez + satır dizileri) → satır nesneleri.
  async function getirCoz(veri) {
    const k = (veri && veri.k) || [];
    const liste = ((veri && veri.s) || []).map((a) => { const r = {}; k.forEach((c, i) => { r[c] = a[i]; }); return r; });
    if (bilinmeyenKisiVar(liste) && Date.now() - kisiZamani > 30000) await kisileriYukle(true).catch(() => {});
    liste.forEach(adlariTamamla);
    return liste;
  }
  async function getir(args) {
    const oz = await ozellikYokla();
    if (!oz.getir) return null;
    if (!kisiler) await kisileriYukle().catch(() => {});
    const { data, error } = await client.rpc("kuyruk_getir", args);
    if (error) {
      if (fonksiyonYok(error)) { oz.getir = false; return null; }
      throw error;
    }
    const liste = await getirCoz(data);
    liste.dahaVar = Boolean(data && data.daha);
    liste.eskiSayisi = data && typeof data.eski === "number" ? data.eski : null;
    return liste;
  }

  // Canlı kanal olayı (yayın yükü ya da tablo dinleme) → tek biçim:
  // { t: tablo, o: INSERT|UPDATE|DELETE, k?: kalem id, i?: istem id, id?: kayıt id }
  const CANLI_TABLOLAR = ["istem_kalemleri", "istemler", "istem_notlari", "yazdirma_kayitlari", "duyurular",
    "duyuru_guncellemeleri", "istek_setleri", "istek_seti_kalemleri", "cihazlar"];
  function tabloOlayi(p) {
    const n = p.new || {}, o = p.old || {}, v = (k) => n[k] ?? o[k] ?? null;
    const olay = { t: p.table, o: p.eventType };
    if (p.table === "istem_kalemleri") { olay.k = v("id"); olay.i = v("istem_id"); }
    else if (p.table === "istem_notlari") olay.i = v("istem_id");
    else if (p.table === "yazdirma_kayitlari") olay.k = v("kalem_id");
    else if (p.table === "duyuru_guncellemeleri") olay.id = v("duyuru_id");
    else if (p.table === "istek_seti_kalemleri") olay.id = v("istek_seti_id");
    else olay.id = v("id");
    return olay;
  }

  // Sunucudaki kuyruk sırasının aynısı (aşağıda kuyrukOku) — birden çok
  // sorgunun sonucu birleştirilince yeniden sıralamak için.
  const azalan = (x, y) => (x < y ? 1 : x > y ? -1 : 0);
  const artanNullSon = (x, y) => (x == null ? (y == null ? 0 : 1) : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0);
  function kuyrukSirasi(a, b) {
    return azalan(a.istem_created_at || "", b.istem_created_at || "")
      || artanNullSon(a.toplu_id, b.toplu_id)
      || artanNullSon(a.toplu_sira, b.toplu_sira)
      || artanNullSon(a.istem_id, b.istem_id)
      || azalan(a.created_at || "", b.created_at || "")
      || artanNullSon(a.kalem_id, b.kalem_id);
  }
  // Görünümden süzgeçli + sıralı okuma, sayfa sayfa (PostgREST 1000 satır
  // sınırı). limit verilirse en fazla o kadar satır.
  async function kuyrukSuz(filtre, sira, limit) {
    const satirlar = [];
    for (;;) {
      const adet = limit ? Math.min(1000, limit - satirlar.length) : 1000;
      if (adet <= 0) return satirlar;
      const { data, error } = await sira(filtre(client.from("istem_kuyruk_v").select("*")))
        .range(satirlar.length, satirlar.length + adet - 1);
      must(data, error);
      if (!data.length) return satirlar;
      satirlar.push(...data);
    }
  }
  const kuyrukSiraSorgu = (q) => q.order("istem_created_at", { ascending: false })
    .order("toplu_id", { ascending: true, nullsFirst: false })
    .order("toplu_sira", { ascending: true, nullsFirst: false })
    .order("istem_id", { ascending: true })
    .order("created_at", { ascending: false })
    .order("kalem_id", { ascending: true });

  // Sıra (toplu_sema.sql): istemin zamanı ↓ → toplu_id → toplu_sira ↑ →
  // istem → kalem zamanı ↓. Toplu gönderimin tüm istemleri aynı zamanı
  // taşıdığından gönderim bölünmez, kendi içinde sepetteki sırayla durur.
  // Kolonlar yoksa eski sıra: kalem zamanı ↓. kalem_id: eşitlikte sabit sıra.
  async function kuyrukOku(eskiSinir, teslimli, toplu) {
    const satirlar = [];
    for (;;) {
      let q = client.from("istem_kuyruk_v").select("*");
      if (eskiSinir) {
        q = q.or(`durum.neq.tamamlandi,created_at.gte."${eskiSinir}"${teslimli ? ",teslim_bekliyor.is.true" : ""}`);
      }
      if (toplu) {
        q = q.order("istem_created_at", { ascending: false })
          .order("toplu_id", { ascending: true, nullsFirst: false })
          .order("toplu_sira", { ascending: true, nullsFirst: false })
          .order("istem_id", { ascending: true });
      }
      const { data, error } = await q
        .order("created_at", { ascending: false })
        .order("kalem_id", { ascending: true })
        .range(satirlar.length, satirlar.length + 999);
      must(data, error);
      if (!data.length) return satirlar;
      satirlar.push(...data);
    }
  }

  async function parcaParcaGuncelle(idler, guncelle) {
    const tamamlanan = [];
    for (let i = 0; i < idler.length; i += 150) {
      const { data, error } = await guncelle(client.from("istemler")).in("id", idler.slice(i, i + 150)).select("id");
      if (error) throw Object.assign(error, { tamamlanan });
      tamamlanan.push(...(data || []).map((r) => r.id));
    }
    return tamamlanan;
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

    // Oturum (uygulama profili) TEK yerden kurulur — giriş ve sayfa yüklemesi
    // aynı alanları döner. (Eskiden ekip/kisaltma sorgulanıp burada
    // atılıyordu → herkes "ekibiniz atanmamış" görüyordu.)
    // NOT: profil sorgularının select'i ile bu alanlar birlikte güncellenmeli.
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
          const { data: profile, error: e3 } = await client
            .from("kullanicilar")
            .select(PROFIL_KOLONLARI)
            .eq("id", kullaniciId)
            .maybeSingle();
          if (e3 || !profile) return null;
          return profilOturumu(profile);
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
        return { id: data.id, ad_soyad: data.ad_soyad, rol: data.rol, is_admin: false };
      } catch (e) {
        return null;
      }
    },

    async signOut() {
      try { await client.auth.signOut(); } catch (e) { /* zaten çıkışta, önemli değil */ }
    },

    // Boot'ta gerçek Supabase Auth oturumu var mı diye bakar (localStorage'a
    // körü körüne güvenmek yerine) — varsa app-level profile'ı döner.
    async getCurrentAuthSession() {
      const { data } = await client.auth.getSession();
      const session = data?.session;
      if (!session) return null;
      const { data: profile, error } = await client
        .from("kullanicilar")
        .select(PROFIL_KOLONLARI)
        .eq("auth_user_id", session.user.id)
        .maybeSingle();
      if (error || !profile) return null;
      return profilOturumu(profile);
    },

    // ---------------- Kendi profilim (herkes, sadece kendi hesabı) ----------------
    // PIN değiştir: eski PIN, giriş akışıyla AYNI yoldan doğrulanır (aynı
    // e-posta + toAuthPassword(eskiPin) ile signInWithPassword) — bu aynı
    // zamanda oturumu tazeler, Supabase'in "yakın zamanda giriş" şartı
    // açıksa updateUser reddedilmez. Yanlış PIN'de mevcut oturum değişmez.
    // kullanicilar.pin'e yeni PIN YAZILMAZ (bkz. profil_sema.sql başı).
    async changePin(eskiPin, yeniPin) {
      const { data: s0 } = await client.auth.getSession();
      const email = s0?.session?.user?.email;
      if (!email) throw new Error("Oturum bulunamadı — çıkış yapıp tekrar girin");
      const { error: e1 } = await client.auth.signInWithPassword({ email, password: toAuthPassword(eskiPin) });
      if (e1) {
        const e = new Error("Eski PIN hatalı");
        e.isWrongPin = true;
        throw e;
      }
      const { error: e2 } = await client.auth.updateUser({ password: toAuthPassword(yeniPin) });
      if (e2) throw e2;
      // Kendi satırında eski düz-metin PIN kopyası kaldıysa temizle (best-effort).
      await client.rpc("profil_pin_degisti").then(() => {}, () => {});
    },

    // Avatar: Storage "avatarlar" (private) bucket'ında "<auth_uid>/avatar-<zaman>.jpg".
    // Her yüklemede yeni dosya adı → tarayıcı önbelleği eski fotoğrafı
    // göstermez; eski dosya ardından silinir.
    async uploadAvatar(blob, eskiYol) {
      const { data: s0 } = await client.auth.getSession();
      const uid = s0?.session?.user?.id;
      if (!uid) throw new Error("Oturum bulunamadı — çıkış yapıp tekrar girin");
      const yol = `${uid}/avatar-${Date.now()}.jpg`;
      const { error: e1 } = await client.storage.from("avatarlar").upload(yol, blob, { contentType: "image/jpeg", upsert: false });
      if (e1) throw e1;
      const { error: e2 } = await client.rpc("profil_avatar_ayarla", { p_yol: yol });
      if (e2) {
        await client.storage.from("avatarlar").remove([yol]).then(() => {}, () => {});
        throw e2;
      }
      if (eskiYol) await client.storage.from("avatarlar").remove([eskiYol]).then(() => {}, () => {});
      return yol;
    },

    async removeAvatar(eskiYol) {
      const { error } = await client.rpc("profil_avatar_ayarla", { p_yol: null });
      if (error) throw error;
      if (eskiYol) await client.storage.from("avatarlar").remove([eskiYol]).then(() => {}, () => {});
    },

    // Fotoğrafı olan kullanıcılar → kısa ömürlü imzalı URL'ler (bucket private).
    // Tek istekte toplu imzalanır. Dönen: { byId: {id: url}, byName: {ad: url} }.
    async getAvatarlar(sureSn) {
      const { data, error } = await client.from("kullanicilar").select("id,ad_soyad,avatar_url").not("avatar_url", "is", null);
      must(data, error);
      const out = { byId: {}, byName: {} };
      if (!data.length) return out;
      const { data: imzali, error: e2 } = await client.storage.from("avatarlar").createSignedUrls(data.map((u) => u.avatar_url), sureSn);
      must(imzali, e2);
      const byPath = Object.fromEntries(imzali.filter((x) => x.signedUrl).map((x) => [x.path, x.signedUrl]));
      data.forEach((u) => {
        const url = byPath[u.avatar_url];
        if (url) { out.byId[u.id] = url; out.byName[u.ad_soyad] = url; }
      });
      return out;
    },

    // ---------------- Kullanıcılar (yönetim) ----------------
    // Aktif filtresi yok — yönetim listesi pasif kullanıcıları da
    // gösterip yeniden aktifleştirebilsin.
    async getAllKullanicilar() {
      const { data, error } = await client
        .from("kullanicilar")
        .select("id,ad_soyad,kisaltma,ekip,rol,is_admin,avatar_url,pin,email,auth_user_id,aktif")
        .order("ad_soyad");
      return must(data, error);
    },

    // PIN burada artık kullanicilar.pin'e YAZILMIYOR — parola kaynağı
    // sadece Supabase Auth. Auth hesabı ayrı bir client'ta açılır (bkz.
    // signupClient), kullanicilar satırı yöneticinin kendi oturumuyla yazılır.
    async createKullanici({ ad_soyad, kisaltma, ekip, rol, is_admin, pin }) {
      const email = await uniqueEmailFor(ad_soyad);
      const { data: signUpData, error: e1 } = await signupClient().auth.signUp({ email, password: toAuthPassword(pin) });
      if (e1) throw e1;
      const authUserId = signUpData?.user?.id || null;
      const { data, error: e2 } = await client
        .from("kullanicilar")
        .insert({ ad_soyad, kisaltma: kisaltma || null, ekip: ekip || null, rol, is_admin: Boolean(is_admin), email, auth_user_id: authUserId })
        .select()
        .single();
      if (e2) throw e2;
      return data;
    },

    // PIN artık düzenlenemiyor (başka birinin şifresini service_role
    // olmadan değiştiremeyiz) — sadece ad/rol/yönetici.
    async updateKullanici(id, { ad_soyad, kisaltma, ekip, rol, is_admin }) {
      const { data, error } = await client
        .from("kullanicilar")
        .update({ ad_soyad, kisaltma: kisaltma || null, ekip: ekip || null, rol, is_admin: Boolean(is_admin) })
        .eq("id", id)
        .select("id");
      if (error) throw error;
      if (!data || !data.length) throw forbiddenError();
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
      const { data: signUpData, error: e1 } = await signupClient().auth.signUp({ email, password: toAuthPassword(row.pin) });
      if (e1) throw e1;
      const authUserId = signUpData?.user?.id || null;
      const { error: e2 } = await client
        .from("kullanicilar")
        .update({ email, auth_user_id: authUserId })
        .eq("id", row.id);
      if (e2) throw e2;
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
        .select("id,kod,ad,sira,aktif,ekip,kesit_gerektirir,kisa_ad")
        .eq("aktif", true)
        .order("sira");
      return must(data, error);
    },

    async createTestGrubu({ kod, ad, sira, ekip, kesit_gerektirir, kisa_ad }) {
      const { data, error } = await client
        .from("test_gruplari")
        .insert({ kod, ad, sira: sira ?? 0, ekip: ekip || null, kesit_gerektirir: Boolean(kesit_gerektirir), kisa_ad: kisa_ad || null })
        .select()
        .single();
      if (error) throw error;
      return data;
    },

    // Yönetim sayfası — aktif+pasif hepsi (pasifleri geri açabilmek için).
    async getAllTestGruplari() {
      const { data, error } = await client
        .from("test_gruplari")
        .select("id,kod,ad,sira,aktif,ekip,kesit_gerektirir,kisa_ad")
        .order("sira");
      return must(data, error);
    },

    async updateTestGrubu(id, { ad, sira, ekip, kesit_gerektirir, kisa_ad }) {
      const { error } = await client.from("test_gruplari")
        .update({ ad, sira: sira ?? 0, ekip: ekip || null, kesit_gerektirir: Boolean(kesit_gerektirir), kisa_ad: kisa_ad || null })
        .eq("id", id);
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

    async createTestKatalogEntry({ grup, ad, klon, kontrol, sira }) {
      const { data, error } = await client
        .from("test_katalog")
        .insert({ grup, ad, klon: klon || null, kontrol: kontrol || null, sira: sira ?? 0 })
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

    async updateTestKatalogEntry(id, { ad, klon, kontrol, sira }) {
      const { error } = await client.from("test_katalog").update({ ad, klon: klon || null, kontrol: kontrol || null, sira: sira ?? 0 }).eq("id", id);
      if (error) throw error;
    },

    // Kontrol listesi eşleştirmesi için TÜM katalog (aktif + pasif, tüm gruplar).
    async getKatalogTumu() {
      const out = [];
      for (;;) {
        const { data, error } = await client
          .from("test_katalog")
          .select("id,grup,ad,klon,kontrol,aktif")
          .order("grup").order("sira").order("id")
          .range(out.length, out.length + 999);
        must(data, error);
        out.push(...data);
        if (data.length < 1000) return out;
      }
    },

    // Onaylanan kontrol listesini tek işlemde yazar (kontrol_sema.sql).
    // liste: [{id, kontrol}] — dönen: {guncellenen}
    async katalogKontrolYukle(liste) {
      const { data, error } = await client.rpc("katalog_kontrol_yukle", { p_liste: liste });
      if (error) throw error;
      return data;
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
        .select("id,grup,ad,klon,kontrol,sira,aktif")
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

    // Şablonlar — kullanıcının kendi şablonları + başkalarının herkese
    // açık işaretledikleri (kendi şablonları önce). RLS admin'e başkalarının
    // özel şablonlarını da gösterir; burada bilerek listelenmez.
    async getSablonlar(userId) {
      const { data, error } = await client
        .from("sablonlar")
        .select("id,grup,ad,sahip_id,herkese_acik,kullanicilar(ad_soyad),sablon_kalemleri(test_id,ozel_test,test_katalog(id,ad,klon))")
        .or(`sahip_id.eq.${userId},herkese_acik.eq.true`)
        .order("ad");
      must(data, error);
      return data.map((s) => ({
        id: s.id, grup: s.grup, ad: s.ad,
        sahip_id: s.sahip_id, sahip_adi: s.kullanicilar?.ad_soyad || "—", herkese_acik: Boolean(s.herkese_acik),
        testler: (s.sablon_kalemleri || [])
          .map((k) =>
            k.test_katalog
              ? { id: k.test_katalog.id, ad: k.test_katalog.ad, klon: k.test_katalog.klon || "", grup: s.grup, custom: false }
              : { ad: k.ozel_test, grup: s.grup, custom: true }
          )
          .filter((t) => t.ad),
      })).sort((a, b) => Number(b.sahip_id === userId) - Number(a.sahip_id === userId));
    },

    async createSablon({ sahip_id, grup, ad, herkese_acik, testler }) {
      const { data: s, error: e1 } = await client
        .from("sablonlar")
        .insert({ sahip_id, grup, ad, herkese_acik: Boolean(herkese_acik) })
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

    async updateSablon(id, { ad, grup, herkese_acik, testler }) {
      const { data: upd, error: e1 } = await client
        .from("sablonlar")
        .update({ ad, grup, herkese_acik: Boolean(herkese_acik) })
        .eq("id", id)
        .select("id");
      if (e1) throw e1;
      if (!upd || !upd.length) throw forbiddenError();
      const { error: e2 } = await client.from("sablon_kalemleri").delete().eq("sablon_id", id);
      if (e2) throw e2;
      if (testler.length) {
        const kalemler = testler.map((t) => ({ sablon_id: id, test_id: t.test_id || null, ozel_test: t.ozel_test || null }));
        const { error: e3 } = await client.from("sablon_kalemleri").insert(kalemler);
        if (e3) throw e3;
      }
    },

    async deleteSablon(id) {
      const { data, error } = await client.from("sablonlar").delete().eq("id", id).select("id");
      if (error) throw error;
      if (!data || !data.length) throw forbiddenError();
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
    // Storage list() varsayılan olarak en fazla 100 dosya döner — günlük
    // yedekler + haftalık/aylık özetler bunu kısa sürede aşar; sayfa sayfa
    // okunur. Klasör girdileri (id'siz) atlanır.
    async listYedekler() {
      const hepsi = [];
      for (;;) {
        const { data, error } = await client.storage
          .from("yedekler")
          .list("", { limit: 100, offset: hepsi.length, sortBy: { column: "created_at", order: "desc" } });
        must(data, error);
        hepsi.push(...data);
        if (data.length < 100) return hepsi.filter((f) => f.id);
      }
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
    // id -> { ad, kisaltma }
    // Oturumda bir kez çekilen kişi listesi (canlı olayla / 10 dk'da tazelenir).
    async getKullaniciMap() {
      return { ...(await kisileriYukle(Date.now() - kisiZamani > 600000)) };
    },

    // istemler.istem_yapan_id VE fatura_giren_id ikisi de kullanicilar'a
    // referans veriyor — PostgREST nested embed bu durumda belirsiz olur,
    // bu yüzden isimler burada client-side çözülüyor (getKullaniciMap ile).
    // Sayfa sayfa okunur (PostgREST 1000 satır sınırı — bkz. listQueue).
    async getHizmetler() {
      // Kalemlerin "hizmetler" yazdırma kayıtları da (arsiv_yazdirma_sema.sql);
      // şema henüz yoksa (ilişki bulunamadı) eski sorguya düşülür.
      // Sıra: created_at ↓ → toplu_sira ↑ (toplu gönderim bir arada, sepetteki
      // sırayla; toplu_sema.sql) → id. Kolonlar yoksa toplu sırası olmadan.
      const TEMEL = "id,patoloji_no,istem_yapan_id,uzman_id,created_at,fatura_girildi,fatura_giren_id,fatura_zamani";
      const istemleriOku = async (kalemSecimi, toplu) => {
        const satirlar = [];
        for (;;) {
          let q = client
            .from("istemler")
            .select(`${TEMEL}${konsDurum ? ",kons_no" : ""}${toplu ? ",toplu_id,toplu_sira" : ""},istem_kalemleri(${kalemSecimi})`)
            .order("created_at", { ascending: false });
          if (toplu) q = q.order("toplu_sira", { ascending: true, nullsFirst: false });
          const { data, error } = await q
            .order("id", { ascending: true })
            .range(satirlar.length, satirlar.length + 999);
          must(data, error);
          if (!data.length) return satirlar;
          satirlar.push(...data);
        }
      };
      const YZ = "id,grup,tekrar_kaynagi_id,yazdirma_kayitlari(baglam,created_at,yazdiran_id)", DUZ = "id,grup,tekrar_kaynagi_id";
      const oku = () => istemleriOku(YZ, !topluKolonuYok).catch((e) => {
        if (!topluKolonuYok && kolonYokHatasi(e)) {
          topluKolonuYok = true;
          return istemleriOku(YZ, false).catch(() => istemleriOku(DUZ, false));
        }
        return istemleriOku(DUZ, !topluKolonuYok);
      });
      // Fatura girişinin son geri alınması (kim, ne zaman) — tablo yoksa boş.
      const geriAlmalar = async () => {
        const { data, error } = await client.from("fatura_gecmisi").select("istem_id,kullanici_id,created_at").eq("islem", "geri_alindi").order("created_at", { ascending: false });
        return error ? [] : data;
      };
      // Düzeltmeler (duzeltme_sema.sql) — tablo yoksa boş.
      const duzeltmeler = async () => {
        const { data, error } = await client.from("istem_duzeltmeleri").select("istem_id,alan,eski_deger,duzelten_id,created_at").order("created_at", { ascending: true });
        return error ? [] : data;
      };
      await this.konsYokla();
      const [istemler, kullaniciMap, geriler, duzList] = await Promise.all([oku(), this.getKullaniciMap(), geriAlmalar(), duzeltmeler()]);
      // istem_id -> { alanSon: {alan: son zaman}, alanKim: {alan: son düzelten}, eskiPat: [..], pat: {eski (ilk), kim, zaman} }
      const duzIstem = new Map();
      duzList.forEach((x) => {
        if (!duzIstem.has(x.istem_id)) duzIstem.set(x.istem_id, { alanSon: {}, alanKim: {}, eskiPat: [], pat: null });
        const d = duzIstem.get(x.istem_id);
        d.alanSon[x.alan] = x.created_at;
        d.alanKim[x.alan] = x.duzelten_id;
        if (x.alan === "patoloji_no") {
          d.eskiPat.push(x.eski_deger);
          d.pat = { eski: d.pat ? d.pat.eski : x.eski_deger, kim: kullaniciMap[x.duzelten_id]?.ad || "—", zaman: x.created_at };
        }
      });
      const ad = (id) => kullaniciMap[id]?.ad || "—";
      const sonGeri = new Map();
      geriler.forEach((g) => { if (!sonGeri.has(g.istem_id)) sonGeri.set(g.istem_id, { zaman: g.created_at, kim: ad(g.kullanici_id) }); });

      const grupSira = Object.fromEntries(["ihc", "hk", "mol", "kesit", "hucre", "yayma", "diger"].map((g, i) => [g, i]));
      return istemler.map((i) => {
        const counts = {};
        (i.istem_kalemleri || []).forEach((k) => { counts[k.grup] = (counts[k.grup] || 0) + 1; });
        const ozet = Object.entries(counts)
          .sort((a, b) => (grupSira[a[0]] ?? 99) - (grupSira[b[0]] ?? 99))
          .map(([grup, count]) => ({ grup, count }));
        const kalemler = i.istem_kalemleri || [];
        // "hizmetler" bağlamı: her kalemin son kaydı; istem, TÜM kalemleri
        // yazdırılmışsa yazdırılmış sayılır.
        const sonKayitlar = kalemler.map((k) => (k.yazdirma_kayitlari || []).filter((y) => y.baglam === "hizmetler")
          .reduce((m, y) => (!m || y.created_at > m.created_at ? y : m), null));
        const enSon = sonKayitlar.reduce((m, y) => (y && (!m || y.created_at > m.created_at) ? y : m), null);
        // Çıktıdan SONRA düzeltilmişse çıktı eskidir: yeniden "yazdırılmamış"
        // sayılır ve satırda uyarı çıkar (numara: patoloji no / blok).
        const duz = duzIstem.get(i.id);
        const enEskiBaski = sonKayitlar.every(Boolean) && sonKayitlar.length
          ? sonKayitlar.reduce((m, y) => (!m || y.created_at < m ? y.created_at : m), null) : null;
        const sonraki = duz && enEskiBaski ? Object.keys(duz.alanSon).filter((a) => new Date(duz.alanSon[a]) > new Date(enEskiBaski)) : [];
        const cikti_eski = sonraki.length ? (sonraki.some((a) => a === "patoloji_no" || a === "blok_no") ? "numara" : "bilgi") : null;
        // Hizmetler'de "düzeltildi" rozeti: baskıdan sonra düzeltilen alanlar + son düzeltme (kim, ne zaman).
        const sonAlan = sonraki.reduce((m, a) => (!m || duz.alanSon[a] > duz.alanSon[m] ? a : m), null);
        const duzeltme_sonrasi = sonAlan
          ? { alanlar: sonraki, zaman: duz.alanSon[sonAlan], kim: kullaniciMap[duz.alanKim[sonAlan]]?.ad || "—" } : null;
        const yazdirilmamis = !kalemler.length || sonKayitlar.some((y) => !y) || Boolean(cikti_eski);
        return {
          kalem_idler: kalemler.map((k) => k.id).filter(Boolean),
          yazdirilmamis,
          cikti_eski,
          duzeltme_sonrasi,
          eski_patoloji_nolar: duz ? duz.eskiPat : [],
          pat_duzeltme: duz && duz.pat ? duz.pat : null,
          yazdirma: !yazdirilmamis && enSon ? { zaman: enSon.created_at, kim: ad(enSon.yazdiran_id), kisaltma: kullaniciMap[enSon.yazdiran_id]?.kisaltma || null } : null,
          fatura_giren_id: i.fatura_giren_id || null,
          son_geri_alma: sonGeri.get(i.id) || null,
          // "Tekrar İste" ile açılan istem (tüm kalemleri bir tekrar) —
          // Hizmetler'de ayrıca işaretlenir.
          tekrar: kalemler.length > 0 && kalemler.every((k) => k.tekrar_kaynagi_id),
          istem_id: i.id,
          toplu_id: i.toplu_id || null,
          toplu_sira: i.toplu_sira || null,
          patoloji_no: i.patoloji_no,
          kons_no: i.kons_no || null,
          isteyen_adi: ad(i.istem_yapan_id),
          isteyen_kisaltma: kullaniciMap[i.istem_yapan_id]?.kisaltma || null,
          uzman_adi: i.uzman_id ? ad(i.uzman_id) : "—",
          uzman_kisaltma: i.uzman_id ? kullaniciMap[i.uzman_id]?.kisaltma || null : null,
          created_at: i.created_at,
          ozet,
          fatura_girildi: i.fatura_girildi,
          fatura_giren_adi: i.fatura_giren_id ? ad(i.fatura_giren_id) : null,
          fatura_zamani: i.fatura_zamani,
        };
      });
    },

    // Gir'i geri al — yetki (işaretleyen / yönetici) ve kayıt (fatura_gecmisi)
    // veritabanında trigger'la (arsiv_yazdirma_sema.sql).
    async faturaGeriAl(istemId) {
      const { error } = await client.from("istemler")
        .update({ fatura_girildi: false, fatura_giren_id: null, fatura_zamani: null })
        .eq("id", istemId);
      if (error) throw error;
    },

    // ---------------- Arşiv: blok çıkarma (arsiv_yazdirma_sema.sql) ----------------
    async blokCikarildi(kalemIdleri) {
      const { data, error } = await client.rpc("blok_cikarildi", { p_kalem_ids: kalemIdleri });
      if (error) throw error;
      return data;
    },
    async blokCikarildiGeriAl(kalemIdleri) {
      const { data, error } = await client.rpc("blok_cikarildi_geri_al", { p_kalem_ids: kalemIdleri });
      if (error) throw error;
      return data;
    },

    // ---------------- Yazdırma kayıtları ----------------
    // Dönen: eklenen kayıtların id'leri ("Yazdırılmadı — geri al" için).
    async yazdirmaKaydet(kalemIdleri, baglam, yazdiranId) {
      const ids = [];
      for (let i = 0; i < kalemIdleri.length; i += 500) {
        const { data, error } = await client.from("yazdirma_kayitlari")
          .insert(kalemIdleri.slice(i, i + 500).map((k) => ({ kalem_id: k, baglam, yazdiran_id: yazdiranId })))
          .select("id");
        if (error) throw error;
        ids.push(...data.map((r) => r.id));
      }
      return ids;
    },
    // RLS: yalnız kendi ve son 15 dakikalık kayıtlar silinir.
    async yazdirmaKaydiSil(kayitIdleri) {
      for (let i = 0; i < kayitIdleri.length; i += 200) {
        const { error } = await client.from("yazdirma_kayitlari").delete().in("id", kayitIdleri.slice(i, i + 200));
        if (error) throw error;
      }
    },

    // Kullanıcının son Hizmetler yazdırması (sunucu saati) — "Yeni" etiketi
    // bunun sonrasında oluşturulan istemlere konur. Kayıt yoksa / okunamazsa null.
    async sonHizmetlerYazdirmam(kullaniciId) {
      const { data, error } = await client.from("yazdirma_kayitlari")
        .select("created_at")
        .eq("baglam", "hizmetler")
        .eq("yazdiran_id", kullaniciId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error || !data || !data.length) return null;
      return data[0].created_at;
    },

    // Toplu Gir / toplu geri alma — tek güncelleme (çok büyük seçimde 150'şerlik
    // parçalar). Dönen: gerçekten değişen istem id'leri (bu arada başkası
    // işaretlediyse / geri aldıysa o satır atlanır). Geri almada yetki
    // (işaretleyen / yönetici) ve fatura_gecmisi kaydı veritabanında
    // tetikleyiciyle (arsiv_yazdirma_sema.sql). Bir parça hata verirse önceki
    // parçalar işlenmiş kalır: hata nesnesinde .tamamlanan.
    async faturaGirildiToplu(istemIdler, kullaniciId) {
      const zaman = new Date().toISOString();
      return parcaParcaGuncelle(istemIdler, (q) => q
        .update({ fatura_girildi: true, fatura_giren_id: kullaniciId, fatura_zamani: zaman })
        .eq("fatura_girildi", false));
    },
    async faturaGeriAlToplu(istemIdler) {
      return parcaParcaGuncelle(istemIdler, (q) => q
        .update({ fatura_girildi: false, fatura_giren_id: null, fatura_zamani: null })
        .eq("fatura_girildi", true));
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
        .on("postgres_changes", { event: "*", schema: "public", table: "yazdirma_kayitlari" }, onChange)
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
    //
    // Sayfa sayfa okunur: PostgREST tek istekte en fazla "max rows" (1000)
    // satır döner — eskiden kayıt sayısı büyüyünce en eski satırlar SESSİZCE
    // kayboluyordu. Dönen satır sayısı kadar ilerlenir, boş sayfada durulur.
    //
    // İş Kuyruğu yükü (kons_eski_sema.sql):
    //  - açık işler (Bekleyen, Cihazda) tarih sınırı OLMADAN hepsi,
    //  - Tamamlandı: tamamlanma zamanı (tamamlandi_at) son tamamlananGun gün
    //    içinde olanlar (0/boş = Tümü), en yeniden; tamamlananLimit verilirse
    //    en fazla o kadar — fazlası varsa dönen dizide dahaVar = true,
    //  - pencere dışında da olsa HER ZAMAN: teslim bekleyenler (teslim edilmeyen
    //    lam gözden kaybolmasın) ve son kesildiGun günde kesilenler ("Kesildi"
    //    sekmesi).
    // Sonuç sunucu sırasıyla (kuyrukSirasi) birleştirilir.
    // tam: true → her şey (Excel'e Aktar).
    // tamamlandi_at yoksa (SQL çalışmadı) pencere eski usul created_at'e göre.
    //
    // performans_sema.sql kuruluysa TEK istek: kuyruk_getir (ince satırlar,
    // sütun adları bir kez; "N daha eski" sayısı da içinde → eskiSayisi).
    async listQueue({ tamamlananGun = 0, tamamlananLimit = 0, kesildiGun = 7, tam = false } = {}) {
      const gunISO = (g) => new Date(Date.now() - g * 86400000).toISOString();
      if (!tam) {
        const l = await getir({ p_tamamlanan_gun: tamamlananGun || 0, p_limit: tamamlananLimit || 0, p_kesildi_gun: kesildiGun });
        if (l) return l;
      }
      if (!tam && !tamamKolonuYok && !topluKolonuYok && !teslimKolonuYok) {
        try {
          const sinir = tamamlananGun ? gunISO(tamamlananGun) : null;
          const [acik, tamam, surekli] = await Promise.all([
            kuyrukSuz((q) => q.in("durum", ["bekleyen", "cihazda"]), kuyrukSiraSorgu),
            kuyrukSuz((q) => {
              q = q.eq("durum", "tamamlandi");
              return sinir ? q.gte("tamamlandi_at", sinir) : q;
            }, (q) => q.order("tamamlandi_at", { ascending: false, nullsFirst: false }).order("kalem_id", { ascending: true }),
            tamamlananLimit ? tamamlananLimit + 1 : 0),
            kuyrukSuz((q) => q.eq("durum", "tamamlandi").or(`teslim_bekliyor.is.true,kesildi_at.gte."${gunISO(kesildiGun)}"`), kuyrukSiraSorgu),
          ]);
          const dahaVar = Boolean(tamamlananLimit) && tamam.length > tamamlananLimit;
          const gorulen = new Set();
          const liste = [...acik, ...(dahaVar ? tamam.slice(0, tamamlananLimit) : tamam), ...surekli]
            .filter((r) => (gorulen.has(r.kalem_id) ? false : gorulen.add(r.kalem_id)))
            .sort(kuyrukSirasi);
          liste.dahaVar = dahaVar;
          return liste;
        } catch (e) {
          // Çok eski şema (kolon yok): eski sorguya düşülür, o da kendi
          // eksik kolonlarını ayıklar.
          if (!tamamKolonHatasi(e) && !kolonYokHatasi(e)) throw e;
          tamamKolonuYok = true;
        }
      }
      const eskiSinir = !tam && tamamlananGun ? gunISO(tamamlananGun) : null;
      for (;;) {
        try {
          const liste = await kuyrukOku(eskiSinir, !teslimKolonuYok, !topluKolonuYok);
          liste.dahaVar = false;
          return liste;
        } catch (e) {
          if (!kolonYokHatasi(e)) throw e;
          const m = String(e.message || "");
          if (!topluKolonuYok && /toplu_|istem_created_at/.test(m)) topluKolonuYok = true;
          else if (!teslimKolonuYok) teslimKolonuYok = true;
          else if (!topluKolonuYok) topluKolonuYok = true;
          else throw e;
        }
      }
    },

    // Canlı güncelleme: yalnız değişen kalemler (kalem ya da istem kimliğiyle).
    // Dönen: ince satırlar; istenip dönmeyen kalem silinmiş (ya da artık
    // görülemiyor) demektir.
    async kalemleriGetir({ kalemIds = [], istemIds = [] } = {}) {
      const k = [...new Set(kalemIds.filter(Boolean))], i = [...new Set(istemIds.filter(Boolean))];
      if (!k.length && !i.length) return [];
      const l = await getir({ p_kalem_ids: k, p_istem_ids: i });
      if (l) return l;
      const sart = [k.length ? `kalem_id.in.(${k.join(",")})` : "", i.length ? `istem_id.in.(${i.join(",")})` : ""].filter(Boolean).join(",");
      const { data, error } = await client.from("istem_kuyruk_v").select("*").or(sart);
      return must(data, error);
    },
    // Arama kutusu: tarih sınırı olmadan tüm kayıtlarda (patoloji no, eski
    // patoloji no, kons no, blok) — en yeni 300.
    async kuyrukAra(metin) {
      const q = String(metin || "").trim();
      if (!q) return [];
      const l = await getir({ p_ara: q, p_limit: 300 });
      if (l) return l;
      const d = q.replace(/[,()*"\\]/g, " ").trim();
      if (!d) return [];
      const { data, error } = await client.from("istem_kuyruk_v").select("*")
        .or(`patoloji_no.ilike.*${d}*,blok_no.ilike.*${d}*${konsDurum ? `,kons_no.ilike.*${d}*` : ""}`)
        .order("created_at", { ascending: false }).limit(300);
      return must(data, error);
    },
    // Detay paneli: kalemin tüm notları + kalite notu (ince listede yok).
    async kalemDetay(kalemId) {
      const { data, error } = await client.from("istem_kuyruk_v").select("notlar,kalite_notu,cihaz_adi").eq("kalem_id", kalemId).maybeSingle();
      must(data, error);
      return data;
    },
    // Blok detayı: istemlerin tüm notları (en yeniden), adlarıyla.
    async istemNotlari(istemIds) {
      const ids = [...new Set((istemIds || []).filter(Boolean))];
      if (!ids.length) return [];
      const { data, error } = await client.from("istem_notlari").select("id,istem_id,yazan_id,metin,created_at").in("istem_id", ids).order("created_at", { ascending: false });
      must(data, error);
      if (!kisiler) await kisileriYukle().catch(() => {});
      return data.map((n) => { const u = kisi(n.yazan_id); return { id: n.id, istem_id: n.istem_id, yazan_id: n.yazan_id, yazan: u ? u.ad : null, kisaltma: u ? u.kisaltma : null, zaman: n.created_at, metin: n.metin }; });
    },
    // Tek duyuru (canlı olayda: kritik / çözüldü bildirimi için).
    async getDuyuru(id) {
      const { data, error } = await client.from("duyuru_v").select("*").eq("id", id).maybeSingle();
      if (error) return null;
      return data;
    },
    // Kişi listesi oturumda bir kez (kullanicilar değişince zorla tazelenir).
    async kisileriTazele() { return kisileriYukle(true); },
    async performansOzellikleri() { return { ...(await ozellikYokla()) }; },

    // TEK canlı kanal. Önce özel yayın kanalı ("istem-canli", performans_sema.sql
    // tetikleyicileri); kurulu değilse, abone olunamazsa ya da 10 sn içinde
    // SUBSCRIBED olmazsa tablo dinlemeye (yedek) düşer — konsola tek satır
    // uyarı. onOlay({ t, o, k?, i?, id? }); onDurum(mod, durum) — mod:
    // "yayin" | "tablo", durum: SUBSCRIBED | CHANNEL_ERROR | TIMED_OUT | CLOSED.
    canliKanal({ onOlay, onDurum } = {}) {
      let kanal = null, kapandi = false, zaman = null, mod = null;
      const bildir = (d) => { if (!kapandi && onDurum) onDurum(mod, d); };
      const tabloDinle = () => {
        mod = "tablo";
        kanal = client.channel("istem-canli-tablo");
        CANLI_TABLOLAR.forEach((t) => kanal.on("postgres_changes", { event: "*", schema: "public", table: t }, (p) => { if (!kapandi) onOlay(tabloOlayi(p)); }));
        kanal.subscribe((durum) => bildir(durum));
      };
      const dus = (neden) => {
        if (kapandi || mod !== "yayin") return;
        clearTimeout(zaman);
        console.warn(`[canlı] Yayın kanalı kullanılamadı (${neden}) — tablo dinlemeye (yedek) geçildi`);
        const eski = kanal;
        kanal = null;
        if (eski) client.removeChannel(eski);
        tabloDinle();
        bildir("BEKLENIYOR");
      };
      ozellikYokla().then((oz) => {
        if (kapandi) return;
        if (!oz.canli_yayin) { tabloDinle(); bildir("BEKLENIYOR"); return; }
        mod = "yayin";
        let abone = false;
        kanal = client.channel("istem-canli", { config: { private: true } });
        kanal.on("broadcast", { event: "degisiklik" }, (m) => { if (!kapandi && m && m.payload) onOlay(m.payload); });
        zaman = setTimeout(() => { if (!abone) dus("10 sn içinde abone olunamadı"); }, 10000);
        kanal.subscribe((durum, hata) => {
          if (kapandi || mod !== "yayin") return;
          if (durum === "SUBSCRIBED") { abone = true; clearTimeout(zaman); }
          else if (!abone && (durum === "CHANNEL_ERROR" || durum === "TIMED_OUT" || durum === "CLOSED")) { dus(durum + (hata && hata.message ? ": " + hata.message : "")); return; }
          bildir(durum);
        });
        bildir("BEKLENIYOR");
      });
      return {
        mod: () => mod,
        kapat() { kapandi = true; clearTimeout(zaman); if (kanal) client.removeChannel(kanal); kanal = null; },
      };
    },

    // "N daha eski" bilgisi için: pencere dışında kalan (yüklenmeyen)
    // Tamamlandı sayısı — teslim bekleyenler gizlenmediği için sayılmaz.
    async gizliEskiSayisi(tamamlananGun) {
      if (!tamamlananGun) return 0;
      const sinir = new Date(Date.now() - tamamlananGun * 86400000).toISOString();
      const say = (teslimli, alan) => {
        let q = client
          .from("istem_kuyruk_v")
          .select("kalem_id", { count: "exact", head: true })
          .eq("durum", "tamamlandi")
          .lt(alan, sinir);
        if (teslimli) q = q.eq("teslim_bekliyor", false);
        return q;
      };
      let { count, error } = await say(!teslimKolonuYok, tamamKolonuYok ? "created_at" : "tamamlandi_at");
      if (error && !tamamKolonuYok && tamamKolonHatasi(error)) {
        tamamKolonuYok = true;
        ({ count, error } = await say(!teslimKolonuYok, "created_at"));
      }
      if (error && !teslimKolonuYok && kolonYokHatasi(error)) {
        teslimKolonuYok = true;
        ({ count, error } = await say(false, tamamKolonuYok ? "created_at" : "tamamlandi_at"));
      }
      if (error) throw error;
      return count || 0;
    },
    // Tamamlanma zamanı gerçek kolondan mı (kons_eski_sema.sql)? İlk
    // listQueue'dan sonra kesinleşir.
    tamamlanmaDestekli() { return !tamamKolonuYok; },

    // Konsültasyon no kolonu var mı (kons_eski_sema.sql)? Oturum başında bir
    // kez yoklanır; sonra konsDestekli() eşzamanlı cevap verir.
    async konsYokla() {
      if (konsDurum !== null) return konsDurum;
      const { error } = await client.from("istemler").select("kons_no").limit(1);
      konsDurum = !error;
      return konsDurum;
    },
    konsDestekli() { return konsDurum === true; },

    // Vaka görünümü "tüm geçmiş"tir: gizli eski kayıtlar dahil o patoloji
    // no'nun bütün kalemleri.
    async vakaKalemleri(patolojiNo) {
      // performans_sema.sql: ince satırlar, tek istek (arama + tam eşleşme).
      const ince = await getir({ p_ara: patolojiNo, p_limit: 1000 });
      if (ince) return ince.filter((r) => r.patoloji_no === patolojiNo).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.kalem_id).localeCompare(String(b.kalem_id)));
      const satirlar = [];
      for (;;) {
        const { data, error } = await client
          .from("istem_kuyruk_v")
          .select("*")
          .eq("patoloji_no", patolojiNo)
          .order("created_at", { ascending: true })
          .order("kalem_id", { ascending: true })
          .range(satirlar.length, satirlar.length + 999);
        must(data, error);
        if (!data.length) return satirlar;
        satirlar.push(...data);
      }
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

    // ---------------- Teslim alındı (teslim_sema.sql) ----------------
    // Kim / ne zaman sunucuda yazılır (tetikleyici: current_kullanici_id(),
    // now()); yetki, "yalnız Tamamlandı" ve durum kaydı (istem_log) da orada.
    // "teslim_at is null" koşulu: aynı anda basan ikinci kişi 0 satır bulur —
    // kayıt önce basanın adına kalır.
    async teslimAl(kalemId) {
      const { data, error } = await client
        .from("istem_kalemleri")
        .update({ teslim_at: new Date().toISOString() })
        .eq("id", kalemId)
        .eq("durum", "tamamlandi")
        .is("teslim_at", null)
        .select("id");
      if (error) throw error;
      if (!data || !data.length) {
        const e = new Error("Kalem zaten teslim alınmış ya da Tamamlandı değil");
        e.uygunDegil = true;
        throw e;
      }
    },

    // Yetki (işaretleyen kişi / yönetici) tetikleyicide; teslim_alan_id de orada temizlenir.
    async teslimGeriAl(kalemId) {
      const { data, error } = await client
        .from("istem_kalemleri")
        .update({ teslim_at: null })
        .eq("id", kalemId)
        .not("teslim_at", "is", null)
        .select("id");
      if (error) throw error;
      if (!data || !data.length) {
        const e = new Error("Kalemin teslimi zaten geri alınmış");
        e.uygunDegil = true;
        throw e;
      }
    },

    // ---------------- Sistem ayarları (okuma herkes, yazma yönetici) ----------------
    // Dönen: { anahtar: deger }. Tablo yoksa (SQL çalışmadıysa) boş nesne.
    async getAyarlar() {
      const { data, error } = await client.from("sistem_ayarlari").select("anahtar,deger");
      if (error) return {};
      return Object.fromEntries((data || []).map((r) => [r.anahtar, r.deger]));
    },
    async setAyar(anahtar, deger) {
      const { data, error } = await client
        .from("sistem_ayarlari")
        .update({ deger })
        .eq("anahtar", anahtar)
        .select("anahtar");
      if (error) throw error;
      if (!data || !data.length) throw forbiddenError();
    },

    // items: [{test_id}|{ozel_test}], bloklar: ["1","2",...]
    // -> her blok x her test için ayrı bir istem_kalemi satırı
    // Not (varsa) istemler.not_metni'ye DEĞİL, istem_notlari'na yazılır
    // (yazan + zaman damgalı liste; bkz. ek_ozellikler_sema.sql).
    async createIstem({ patoloji_no, kons_no, istem_yapan_id, uzman_id, oncelik, not_metni, bloklar, testler }) {
      const { data: istem, error: e1 } = await client
        .from("istemler")
        .insert({ patoloji_no, istem_yapan_id, uzman_id, oncelik, ...(kons_no ? { kons_no } : {}) })
        .select()
        .single();
      if (e1) throw e1;

      if (not_metni) {
        const { error: eN } = await client.from("istem_notlari").insert({ istem_id: istem.id, yazan_id: istem_yapan_id, metin: not_metni });
        if (eN) throw eN;
      }

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

    // ---------------- Toplu istem (sepet; toplu_sema.sql) ----------------
    // TEK RPC = tek veritabanı işlemi: ya bütün vakalar kaydedilir ya hiçbiri.
    // Yetki (RLS) fonksiyon çağıranın yetkisiyle (security invoker) uygulanır.
    // vakalar: [{ patoloji_no, uzman_id, oncelik, not_metni, bloklar: [..],
    //             testler: [{ test_id? , ozel_test?, grup }] }] — sepetteki sırayla.
    // Dönen: { toplu_id, istem, kalem }.
    async topluIstemOlustur(vakalar) {
      const { data, error } = await client.rpc("toplu_istem_olustur", { p_vakalar: vakalar });
      if (error) throw error;
      return data;
    },
    // Kuyruk görünümünde toplu kolonları var mı (toplu_sema.sql çalışmış mı)?
    // İlk listQueue'dan sonra kesinleşir.
    topluDestekli() { return !topluKolonuYok; },

    // ---------------- "Yazıyor…" (Realtime Presence; yaziyor_sema.sql) ----------------
    // Private kanal: yalnız oturum açmış kullanıcılar katılır (realtime.messages
    // politikası). Dönen: { yayinla(veri | null), kapat() }. Abonelik
    // tamamlanmadan istenen yayın, kanal hazır olunca ve HER yeniden
    // bağlanmada (sunucu kopan bağlantının kaydını siler) yeniden uygulanır.
    // onDurum(status) uygulamaya da bildirilir; log(...) geçici debug çıktısı.
    yaziyorKanali(sekmeKey, { onSync, onDurum, log = () => {} } = {}) {
      let hazir = false, istenen = null, kapandi = false;
      const ch = client.channel("istem-yaziyor", { config: { private: true, presence: { key: sekmeKey } } });
      const uygula = () => {
        if (!hazir || kapandi) return;
        const veri = istenen;
        Promise.resolve(veri ? ch.track(veri) : ch.untrack())
          .then((sonuc) => log(veri ? "track" : "untrack", sonuc, veri ? `${veri.patoloji_no} ${JSON.stringify(veri.gruplar)}` : ""))
          .catch((e) => log(veri ? "track HATA" : "untrack HATA", (e && e.message) || e));
      };
      ch.on("presence", { event: "sync" }, () => {
        const st = ch.presenceState();
        log("sync", Object.values(st).flat().map((m) => `${m.kisaltma || "?"}:${m.patoloji_no}`).join(", ") || "(kimse yazmıyor)");
        if (onSync) onSync(st);
      });
      ch.subscribe((status, err) => {
        hazir = status === "SUBSCRIBED";
        log("kanal", status, err ? (err.message || String(err)) : "");
        if (hazir) uygula();
        if (onDurum) onDurum(status);
      });
      return {
        yayinla(veri) { istenen = veri; uygula(); },
        kapat() { kapandi = true; log("kanal kapatıldı"); client.removeChannel(ch); },
      };
    },

    // ---------------- İstem düzeltme (duzeltme_sema.sql) ----------------
    // degisiklik: { patoloji_no?, kons_no? (null = sil), uzman_id?, oncelik?, bloklar?: [{kalem_id, blok_no}] }
    // Yetki (giren kişi / yönetici) ve kayıt + not veritabanında, tek işlemde.
    async istemDuzelt(istemId, degisiklik) {
      const { data, error } = await client.rpc("istem_duzelt", { p_istem_id: istemId, p_degisiklik: degisiklik });
      if (error) throw error;
      return data;
    },
    // Hizmetler'de "Gir" işaretli mi (test düzeltmesi uyarısı için).
    async istemFaturaDurumu(istemId) {
      const { data, error } = await client.from("istemler").select("fatura_girildi").eq("id", istemId).maybeSingle();
      if (error) throw error;
      return Boolean(data && data.fatura_girildi);
    },
    // İstemin düzeltme geçmişi (yeni → eski); tablo yoksa boş.
    async getDuzeltmeler(istemId) {
      const [{ data, error }, kullaniciMap] = await Promise.all([
        client.from("istem_duzeltmeleri").select("id,istem_id,kalem_id,alan,eski_deger,yeni_deger,duzelten_id,created_at")
          .eq("istem_id", istemId).order("created_at", { ascending: false }),
        this.getKullaniciMap(),
      ]);
      if (error) return [];
      return data.map((d) => ({ ...d, kim: kullaniciMap[d.duzelten_id]?.ad || "—", kisaltma: kullaniciMap[d.duzelten_id]?.kisaltma || null }));
    },

    // Boya tekrarı — yeni istem başlığı + Bekleyen kalem + log tek
    // transaction'da, sunucuda (bkz. yetki_sema.sql → tekrar_iste).
    // Dönen değer yeni kalemin id'si.
    async tekrarIste(kalemId, neden) {
      const { data, error } = await client.rpc("tekrar_iste", { p_kalem_id: kalemId, p_not: neden || null });
      if (error) throw error;
      return data;
    },

    // ---------------- Web Push (push_sema.sql) ----------------
    async vapidAcikAnahtar() {
      const { data, error } = await client.rpc("vapid_acik_anahtar");
      if (error) throw error;
      return data;
    },
    // Bu cihazı oturumdaki kullanıcıya bağlar (ortak bilgisayarda devralır).
    async pushAboneOl(endpoint, keys) {
      const { error } = await client.rpc("push_abone_ol", { p_endpoint: endpoint, p_keys: keys });
      if (error) throw error;
    },
    // RLS: yalnız kendi satırı görünür — başkasına kayıtlıysa false.
    async pushAbonelikVarMi(endpoint) {
      const { data, error } = await client.from("push_abonelikleri").select("id").eq("endpoint", endpoint).maybeSingle();
      if (error) throw error;
      return Boolean(data);
    },
    async pushAbonelikSil(endpoint) {
      const { error } = await client.from("push_abonelikleri").delete().eq("endpoint", endpoint);
      if (error) throw error;
    },
    async getBildirimTercihleri(kullaniciId) {
      const { data, error } = await client.from("bildirim_tercihleri").select("grup_kod").eq("kullanici_id", kullaniciId);
      return must(data, error).map((r) => r.grup_kod);
    },
    async bildirimTercihleriEkle(kullaniciId, gruplar) {
      const { error } = await client.from("bildirim_tercihleri")
        .upsert(gruplar.map((g) => ({ kullanici_id: kullaniciId, grup_kod: g })), { onConflict: "kullanici_id,grup_kod", ignoreDuplicates: true });
      if (error) throw error;
    },
    async setBildirimTercihi(kullaniciId, grup, acik) {
      if (acik) return this.bildirimTercihleriEkle(kullaniciId, [grup]);
      const { error } = await client.from("bildirim_tercihleri").delete().eq("kullanici_id", kullaniciId).eq("grup_kod", grup);
      if (error) throw error;
    },
    // Kendi cihazlarına deneme bildirimi (push-gonder, kullanıcının oturumuyla).
    // Dönen: { gonderilen, silinen, hatalar } ya da { ok:false, hata }.
    async pushDeneme() {
      const { data, error } = await client.functions.invoke("push-gonder", { body: { islem: "test" } });
      if (error) {
        // HTTP hatası: fonksiyonun kendi açıklaması ({ ok:false, hata }); ağ/CORS
        // hatası: istemcinin mesajı — her durumda neden kullanıcıya gösterilir.
        if (error.context && typeof error.context.json === "function") {
          try { return await error.context.json(); } catch (e) { /* gövde JSON değil */ }
        }
        return { ok: false, hata: error.message || String(error) };
      }
      return data;
    },

    // ---------------- Kesit ekranı (ekip_sema.sql) ----------------
    // Yalnız verilen kalem id'leri (ekranda o blok satırında görünenler).
    // Dönen: { tamamlanan, damga, atlanan }.
    async blokKesildi(kalemIdleri) {
      const { data, error } = await client.rpc("blok_kesildi", { p_kalem_ids: kalemIdleri });
      if (error) throw error;
      return data;
    },
    // Dönen: { geri, damga, atlanan }.
    async blokKesildiGeriAl(kalemIdleri) {
      const { data, error } = await client.rpc("blok_kesildi_geri_al", { p_kalem_ids: kalemIdleri });
      if (error) throw error;
      return data;
    },

    // Toplu Tekrar İste — aynı kaynak istemden gelenler tek yeni istemde
    // toplanır (sunucuda). Dönen: { istem, kalem, atlanan }.
    async tekrarIsteToplu(kalemIdleri, neden) {
      const { data, error } = await client.rpc("tekrar_iste_toplu", { p_kalem_ids: kalemIdleri, p_not: neden || null });
      if (error) throw error;
      return data;
    },

    // ---------------- İstem notları (çoklu, yazan + zaman damgalı) ----------------
    async notEkle(istemId, yazanId, metin) {
      const { error } = await client.from("istem_notlari").insert({ istem_id: istemId, yazan_id: yazanId, metin });
      if (error) throw error;
    },

    // RLS: yazan kendi notunu, admin her notu siler — reddedilirse 0 satır döner.
    async notSil(notId) {
      const { data, error } = await client.from("istem_notlari").delete().eq("id", notId).select("id");
      if (error) throw error;
      if (!data || !data.length) throw forbiddenError();
    },

    // ---------------- İstatistikler (canlı, yalnız admin) ----------------
    // bas / bit: "YYYY-AA-GG" (Türkiye yerel tarihi, ikisi de dahil);
    // periyot: "week" | "month". Hesap sunucuda (bkz. istatistik()).
    async istatistik(bas, bit, periyot) {
      const { data, error } = await client.rpc("istatistik", { p_bas: bas, p_bit: bit, p_periyot: periyot });
      if (error) throw error;
      return data;
    },

    async updateKaliteNotu(kalemId, metin) {
      const { error } = await client
        .from("istem_kalemleri")
        .update({ kalite_notu: metin || null, updated_at: new Date().toISOString() })
        .eq("id", kalemId);
      if (error) throw error;
    },

    // İstem detay panelindeki "Sil" — yanlış girilen tek bir kalemi düzeltmek
    // için. Sadece o istem_kalemleri satırı (ve ON DELETE CASCADE ile onun
    // istem_log kayıtları) silinir; kardeş kalemlere ve istemler üst kaydına
    // dokunulmaz. İstemin son kalemi silinmişse (artık boş kaldığı için)
    // üst istemler kaydı da ayrıca silinir. Kimin neyi silebileceği RLS'te
    // (admin her şeyi; diğerleri kendi istemindeki Tamamlandı olmayanları).
    async deleteIstemKalem(kalemId) {
      const { data: kalem, error: e0 } = await client
        .from("istem_kalemleri")
        .select("istem_id")
        .eq("id", kalemId)
        .maybeSingle();
      if (e0) throw e0;
      if (!kalem) return;

      const { data: silinen, error: e1 } = await client.from("istem_kalemleri").delete().eq("id", kalemId).select("id");
      if (e1) throw e1;
      if (!silinen || !silinen.length) throw forbiddenError();

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
        .on("postgres_changes", { event: "*", schema: "public", table: "istem_notlari" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "yazdirma_kayitlari" }, onChange)
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

    // ---------------- Duyurular (duyuru_sema.sql) ----------------
    // duyuru_v: aktif = cozuldu_at boş VE (bitis_at boş YA DA gelecekte) —
    // veritabanı saatiyle. Tablo / görünüm yoksa (SQL çalıştırılmamış) null.
    async getDuyurular({ aktif = true, limit = 100 } = {}) {
      let q = client.from("duyuru_v").select("*").eq("aktif", aktif);
      q = aktif
        ? q.order("onem_sira", { ascending: true }).order("created_at", { ascending: false })
        : q.order("kapanis_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(limit);
      const { data, error } = await q;
      if (error) {
        if (error.code === "PGRST205" || error.code === "42P01" || /duyuru_v|does not exist|schema cache/i.test(String(error.message || ""))) return null;
        throw error;
      }
      return data || [];
    },
    // Yazan / zaman / çözen sunucuda (tetikleyici) yazılır.
    async duyuruEkle(v) {
      const { data, error } = await client.from("duyurular").insert({
        baslik: v.baslik, metin: v.metin || "", onem: v.onem, test_id: v.test_id || null, cihaz_id: v.cihaz_id || null, bitis_at: v.bitis_at || null,
      }).select("id").single();
      if (error) throw error;
      return data.id;
    },
    // RLS'e takılan güncelleme hata vermez, 0 satır döner — yetki hatası sayılır.
    async duyuruGuncelle(id, degisiklik) {
      const { data, error } = await client.from("duyurular").update(degisiklik).eq("id", id).select("id");
      if (error) throw error;
      if (!data || !data.length) { const e = new Error("Bu duyuruyu değiştirme yetkiniz yok"); e.code = "42501"; throw e; }
    },
    duyuruCozuldu(id) { return this.duyuruGuncelle(id, { cozuldu_at: new Date().toISOString() }); },
    duyuruYenidenAc(id) { return this.duyuruGuncelle(id, { cozuldu_at: null }); },
    async duyuruSil(id) {
      const { data, error } = await client.from("duyurular").delete().eq("id", id).select("id");
      if (error) throw error;
      if (!data || !data.length) { const e = new Error("Duyuruyu yalnız yönetici silebilir"); e.code = "42501"; throw e; }
    },
    async duyuruGuncellemeEkle(duyuruId, metin) {
      const { error } = await client.from("duyuru_guncellemeleri").insert({ duyuru_id: duyuruId, metin });
      if (error) throw error;
    },
    async duyuruGizle(duyuruId, kullaniciId) {
      const { error } = await client.from("duyuru_gizleme").insert({ duyuru_id: duyuruId, kullanici_id: kullaniciId });
      if (error && error.code !== "23505") throw error;
    },
    async duyuruGoster(duyuruId, kullaniciId) {
      const { error } = await client.from("duyuru_gizleme").delete().eq("duyuru_id", duyuruId).eq("kullanici_id", kullaniciId);
      if (error) throw error;
    },
    // "CD3 duyurusu çözüldü" — kişi bu testi son N günde istemiş mi?
    async testiSonGunlerdeIstedim(testId, kullaniciId, gun = 7) {
      const sinir = new Date(Date.now() - gun * 86400000).toISOString();
      const { data, error } = await client.from("istem_kalemleri").select("id, istemler!inner(istem_yapan_id)")
        .eq("test_id", testId).eq("istemler.istem_yapan_id", kullaniciId).gte("created_at", sinir).limit(1);
      if (error) throw error;
      return Boolean(data && data.length);
    },
    subscribeDuyurular(onChange) {
      const channel = client
        .channel("duyurular-realtime")
        .on("postgres_changes", { event: "*", schema: "public", table: "duyurular" }, onChange)
        .on("postgres_changes", { event: "*", schema: "public", table: "duyuru_guncellemeleri" }, onChange)
        .subscribe();
      return () => client.removeChannel(channel);
    },
  };

  window.Api = Api;
})();
