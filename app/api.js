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

  const Api = {
    // ---------------- Auth (ad seç + PIN) ----------------
    async listActiveUsers() {
      const { data, error } = await client
        .from("kullanicilar")
        .select("id,ad_soyad,rol")
        .eq("aktif", true)
        .order("ad_soyad");
      return must(data, error);
    },

    async login(kullaniciId, pin) {
      const { data, error } = await client
        .from("kullanicilar")
        .select("id,ad_soyad,rol,pin")
        .eq("id", kullaniciId)
        .eq("aktif", true)
        .maybeSingle();
      must(data, error);
      if (!data || String(data.pin ?? "") !== String(pin ?? "")) return null;
      return { id: data.id, ad_soyad: data.ad_soyad, rol: data.rol };
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

    // Kurumsal, herkese açık "hazır setler" (owner yok).
    async getIstekSetleri() {
      const { data, error } = await client
        .from("istek_setleri")
        .select("id,grup,ad,uzmanlik,sira,istek_seti_kalemleri(test_id,ozel_test,test_katalog(id,ad,klon))")
        .eq("aktif", true)
        .order("sira");
      must(data, error);
      return data.map((s) => ({
        id: s.id, grup: s.grup, ad: s.ad, uzmanlik: s.uzmanlik,
        testler: (s.istek_seti_kalemleri || [])
          .map((k) =>
            k.test_katalog
              ? { id: k.test_katalog.id, ad: k.test_katalog.ad, klon: k.test_katalog.klon || "", grup: s.grup, custom: false }
              : { ad: k.ozel_test, grup: s.grup, custom: true }
          )
          .filter((t) => t.ad),
      }));
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

    async assignCihaz(kalemId, cihazId) {
      const { error } = await client
        .from("istem_kalemleri")
        .update({ cihaz_id: cihazId || null, updated_at: new Date().toISOString() })
        .eq("id", kalemId);
      if (error) throw error;
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
    async listQueue() {
      const { data, error } = await client
        .from("istem_kuyruk_v")
        .select("*")
        .order("created_at", { ascending: false });
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
