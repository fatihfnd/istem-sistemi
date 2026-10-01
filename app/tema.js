// tema.js — tema / mod / tablo yoğunluğu tercihleri.
// <head>'de, styles.css'ten hemen sonra SENKRON yüklenir: kayıtlı tercih
// sayfa ilk boyanmadan <html data-tema/data-mod/data-yogunluk>'a yazılır,
// yanlış temanın bir an görünmesi (flash) olmaz. Renklerin kendisi
// styles.css'teki CSS değişkenlerinde; burası sadece hangisinin seçili
// olduğunu yönetir.
//
// Saklama: localStorage, KULLANICI BAŞINA ("istem_tercih:<kullanici_id>") —
// laboratuvardaki ortak bilgisayarda herkes kendi temasını görür. Giriş
// ekranı son uygulanan tercihle ("istem_tercih_son") açılır. Veritabanına
// hiçbir şey yazılmaz; tercih tarayıcıya özeldir.
(function () {
  // bar: mobil tarayıcı/PWA durum çubuğu rengi (meta theme-color).
  const TEMALAR = [
    { id: "zeytin",    ad: "Zeytin",     renk: { acik: "#1f4d47", koyu: "#5fb3a3" }, bar: { acik: "#1f4d47", koyu: "#0e1412" } },
    { id: "gunbatimi", ad: "Gün Batımı", renk: { acik: "#b4532a", koyu: "#f08a5d" }, bar: { acik: "#b4532a", koyu: "#140f0c" } },
    { id: "okyanus",   ad: "Okyanus",    renk: { acik: "#1d5c8c", koyu: "#5aa9e6" }, bar: { acik: "#1d5c8c", koyu: "#0b1117" } },
    { id: "elektron",  ad: "Elektron",   renk: { acik: "#c0187a", koyu: "#ff3ea5" }, bar: { acik: "#16161f", koyu: "#07080c" } },
    { id: "grafit",    ad: "Grafit",     renk: { acik: "#3d3d3a", koyu: "#d6d6d2" }, bar: { acik: "#3d3d3a", koyu: "#101010" } },
  ];
  const MODLAR = ["acik", "koyu", "sistem"];
  const YOGUNLUKLAR = ["kompakt", "normal", "genis"];
  const VARSAYILAN = { tema: "zeytin", mod: "acik", yogunluk: "normal" };
  const SON_KEY = "istem_tercih_son";
  const userKey = (id) => "istem_tercih:" + id;

  // localStorage gizli pencerede / engellenmiş site verisinde fırlatabilir —
  // tercih kaydedilemezse uygulama yine çalışır, sadece hatırlanmaz.
  function oku(key) {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch (e) { return null; }
  }
  function yaz(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* kaydedilemedi — önemli değil */ }
  }
  function temizle(p) {
    p = p || {};
    return {
      tema: TEMALAR.some((t) => t.id === p.tema) ? p.tema : VARSAYILAN.tema,
      mod: MODLAR.includes(p.mod) ? p.mod : VARSAYILAN.mod,
      yogunluk: YOGUNLUKLAR.includes(p.yogunluk) ? p.yogunluk : VARSAYILAN.yogunluk,
    };
  }

  const mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const gercekMod = (mod) => (mod === "sistem" ? (mq && mq.matches ? "koyu" : "acik") : mod);

  let cur = temizle(oku(SON_KEY));
  let kullaniciId = null;

  function uygula(p) {
    cur = temizle(p);
    const el = document.documentElement;
    const mod = gercekMod(cur.mod);
    el.dataset.tema = cur.tema;
    el.dataset.mod = mod;
    el.dataset.yogunluk = cur.yogunluk;
    const t = TEMALAR.find((x) => x.id === cur.tema);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta && t) meta.setAttribute("content", t.bar[mod]);
    yaz(SON_KEY, cur);
    document.dispatchEvent(new CustomEvent("tema-degisti", { detail: Object.assign({}, cur) }));
  }

  if (mq) {
    const onChange = () => { if (cur.mod === "sistem") uygula(cur); };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  uygula(cur);

  window.Tema = {
    TEMALAR, MODLAR, YOGUNLUKLAR,
    get: () => Object.assign({}, cur),
    // Girişte: kullanıcının kendi kayıtlı tercihi — yoksa VARSAYILAN (ortak
    // bilgisayarda bir önceki kullanıcının teması devralınmaz).
    kullaniciYukle(id) {
      kullaniciId = id;
      uygula(oku(userKey(id)) || VARSAYILAN);
    },
    cikis() { kullaniciId = null; },
    set(patch) {
      uygula(Object.assign({}, cur, patch));
      if (kullaniciId) yaz(userKey(kullaniciId), cur);
    },
  };
})();
