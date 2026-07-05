// app.js — ekran mantığı. Veriye HER ZAMAN Api.* üzerinden erişir,
// Supabase'i doğrudan görmez (bkz. api.js).

// yonetim_sema.sql henüz çalıştırılmadıysa (test_gruplari tablosu yoksa)
// bu sabit liste devrede kalır; initApp() dinamik listeyi çekebilirse
// GROUPS/TIP'i onunla değiştirir (bkz. initApp).
const DEFAULT_GROUPS = [
  ["ihc", "IHC"], ["hk", "Histokimya"], ["mol", "Moleküler"],
  ["kesit", "Yeni Kesit"], ["hucre", "Hücre Bloğu"], ["yayma", "Yeniden Yayma"], ["diger", "Diğer"],
];
let GROUPS = DEFAULT_GROUPS;
let TIP = Object.fromEntries(GROUPS);
const ROL_LABEL = { uzman: "Uzman Patolog", asistan: "Asistan", teknisyen: "Teknisyen" };
const PILL = { bekleyen: ["st-bekleyen", "Bekleyen"], cihazda: ["st-cihazda", "Cihazda"], tamamlandi: ["st-tamamlandi", "Tamamlandı"] };
const PRIO = { rutin: ["p-rutin", "Rutin"], acil: ["p-acil", "Acil"], stat: ["p-stat", "STAT"] };
const KUYRUK_EXPORT_COLS = [
  { label: "Patoloji No", value: (r) => r.patoloji_no },
  { label: "Blok", value: (r) => r.blok_no },
  { label: "Test", value: (r) => r.test_adi },
  { label: "Klon", value: (r) => r.klon || "" },
  { label: "Tip", value: (r) => TIP[r.grup] || "Diğer" },
  { label: "İsteyen", value: (r) => r.isteyen_adi || "" },
  { label: "Uzman Adına", value: (r) => r.uzman_adi || "" },
  { label: "Tarih", value: (r) => formatDateFull(r.created_at) },
  { label: "Öncelik", value: (r) => PRIO[r.oncelik][1] },
  { label: "Durum", value: (r) => PILL[r.durum][1] },
  { label: "Not", value: (r) => r.not_metni || "" },
];
const SESSION_KEY = "istem_session";
const EMPTY_MSG = {
  kuyruk: { t: "Bir istek seç", d: "Detayını ve durum geçmişini görmek için soldan bir satıra dokun, ya da yeni istek ver." },
  setler: { t: "Bir set seç", d: "Testlerini görmek ve doğrudan istek vermek için bir karta dokun." },
  sablonlar: { t: "Bir şablon seç", d: "Düzenlemek için bir şablona dokun, ya da yeni şablon oluştur." },
  cihazlar: { t: "Bir cihaz seç", d: "Düzenlemek için bir cihaza dokun, ya da yeni cihaz ekle." },
  hizmetler: { t: "Faturalama", d: "Her satır bir istemi temsil eder. \"Girildi\" ile faturalandığını işaretle." },
  kullanicilar: { t: "Bir kullanıcı seç", d: "Düzenlemek için bir kullanıcıya dokun, ya da yeni kullanıcı ekle." },
  "test-gruplari": { t: "Bir grup seç", d: "Düzenlemek için bir gruba dokun, ya da yeni grup ekle." },
  "test-katalogu": { t: "Bir test seç", d: "Düzenlemek için bir teste dokun, ya da yeni test ekle." },
  yedekler: { t: "Otomatik yedekler", d: "Her gece 02:00'de alınan veritabanı yedeklerini buradan indirebilirsiniz." },
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function timeAgo(iso) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "az önce";
  if (min < 60) return min + " dk önce";
  const sa = Math.floor(min / 60);
  if (sa < 24) return sa + " sa önce";
  return Math.floor(sa / 24) + " gün önce";
}
function formatDT(iso) {
  return new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function formatDateFull(iso) {
  return new Date(iso).toLocaleString("tr-TR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function initials(name) {
  const parts = name.replace(/^Dr\.?\s*/i, "").split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
}
function groupByGrup(list) {
  const out = {};
  list.forEach((item) => { (out[item.grup] ??= []).push(item); });
  return out;
}
// Yeni İstek formundaki "Hazır Setler" hızlı-doldurma pasifleştirilmiş
// setleri teklif etmesin diye SETS_INST hep aktif olanlardan hesaplanır.
function activeSetsInst(list) {
  return groupByGrup(list.filter((s) => s.aktif));
}

// istem_test_kullanim_v satırlarını (zaten son_kullanim'e göre azalan sırada)
// CAT'teki ad/klon ile zenginleştirip gruba göre ayırır. Pasifleştirilmiş/
// silinmiş testler (artık CAT'te yok) sessizce atlanır.
function buildRecentTests(usageRows) {
  const byGrup = {};
  usageRows.forEach((u) => {
    const t = (CAT[u.grup] || []).find((c) => c.id === u.test_id);
    if (!t) return;
    (byGrup[u.grup] ??= []).push({ id: t.id, ad: t.ad, klon: t.klon, grup: u.grup });
  });
  return byGrup;
}

function buildRecentSetlerMap(usageRows) {
  const map = new Map();
  usageRows.forEach((u) => map.set(u.istek_seti_id, { son_kullanim: u.son_kullanim, kullanim_sayisi: u.kullanim_sayisi }));
  return map;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ---------------- Excel'e Aktar (manuel, tarayıcı tarafı — SheetJS) ----------------
// columns: [{label, value(row)}]. Dosya adı otomatik tarih damgalı.
function exportToExcel(rows, columns, filenamePrefix) {
  if (!rows.length) { toast("Aktarılacak kayıt yok", true); return; }
  const data = rows.map((r) => Object.fromEntries(columns.map((c) => [c.label, c.value(r)])));
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Veri");
  const tarih = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filenamePrefix}_${tarih}.xlsx`);
}

// "Excel'e Aktar ▾" butonu + Görünenler/Tümü mini menüsü — hem İş Kuyruğu
// hem Hizmetler sayfasında aynı davranışı verir. onPick("gorunen"|"tum")
// export'u tetikler.
function bindExportMenu(boxSel, onPick) {
  const box = $(boxSel);
  if (!box) return;
  box.querySelector(".exportbtn").addEventListener("click", (e) => {
    e.stopPropagation();
    box.querySelector(".thfilter").classList.toggle("open");
  });
  box.querySelectorAll("[data-exp]").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      box.querySelector(".thfilter").classList.remove("open");
      onPick(opt.dataset.exp);
    });
  });
}
const EXPORT_MENU_HTML = `
  <div class="exportbox">
    <button class="btn-ghost btn-sm exportbtn">Excel'e Aktar ▾</button>
    <div class="thfilter" style="right:auto;left:0">
      <button class="thopt" data-exp="gorunen">Görünenler</button>
      <button class="thopt" data-exp="tum">Tümü</button>
    </div>
  </div>`;
document.addEventListener("click", () => $$(".exportbox .thfilter.open").forEach((p) => p.classList.remove("open")));

// Yönetim ekranlarındaki "Sil" aksiyonlarının ortak yolu — basit bir
// onay diyaloğu + silme + başarı/hata geri bildirimi. Kayıt başka bir
// tabloda kullanılıyorsa (api.js'teki deleteRow FK ihlalini yakalayıp
// e.isReferenced/e.hasAuthAccount işaretler) anlamlı mesaj gösterilir.
async function confirmAndDelete(label, deleteFn, onSuccess) {
  if (!confirm(`"${label}" kalıcı olarak silinsin mi? Bu geri alınamaz.`)) return;
  try {
    await deleteFn();
    await onSuccess();
  } catch (e) {
    toast(e && (e.isReferenced || e.hasAuthAccount) ? e.message : "Silinemedi", true);
  }
}

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function setSession(u) { localStorage.setItem(SESSION_KEY, JSON.stringify(u)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

// ---- state ----
let session = null;
let CAT = {}, UZMANLAR = [], CIHAZLAR = [];
let ISTEK_SETLERI = [], SETS_INST = {};   // kurumsal, herkese açık
let MY_SABLONLAR = [], SETS_MINE = {};    // kişiye özel
let RECENT_TESTS = {};                    // {grup: [{id,ad,klon,grup}]} — kullanıcının en son kullandığı testler
let RECENT_SETLER = new Map();            // istek_seti_id -> {son_kullanim, kullanim_sayisi}
const RECENT_CAP = 20;                    // Tek Tek Seç varsayılan görünümünde grup başına üst sınır
const RECENT_SET_CAP = 10;                // Hazır Setler varsayılan görünümünde üst sınır
let rows = [];
let selId = null, searchQ = "";
let unsub = null, pageUnsub = null, reloadTimer = null;
let grp = "ihc", prio = "rutin";
let selectedTests = new Map(); // test_id -> {ad,klon,grup}
let customItems = []; // {ad, sel, grup}
let uiWired = false;
let currentPage = "kuyruk";
let setFilterGrup = "all", setFilterUzmanlik = "all";
// Metin alanları: küçük harfe çevrilmiş alt-dizi arama. Set alanları
// (tip/oncelik/durum): çoklu seçim — "durum" aynı zamanda üstteki
// Tümü/Bekleyen/Cihazda/Tamamlandı sekmeleriyle PAYLAŞILAN tek gerçek kaynak
// (bkz. isTabActive/setDurumTab) — sekmeler tek değere kısayol, sütun
// başlığındaki checkbox listesi aynı Set'i çoklu işaretleyebilir.
function freshColFilters() {
  return {
    pat: "", blok: "", test: "", isteyen: "", uzman: "",
    tip: new Set(), oncelik: new Set(), durum: new Set(),
  };
}
let colFilters = freshColFilters();
let sortCol = null, sortDir = "asc";
let caseView = null; // aktifken bir patoloji_no string'i (vaka görünümü)

function isTabActive(f) {
  return f === "all" ? colFilters.durum.size === 0 : colFilters.durum.size === 1 && colFilters.durum.has(f);
}
function setDurumTab(f) {
  colFilters.durum = f === "all" ? new Set() : new Set([f]);
}
function hasActiveFilters() {
  return Boolean(searchQ) || Boolean(colFilters.pat || colFilters.blok || colFilters.test || colFilters.isteyen || colFilters.uzman)
    || colFilters.tip.size > 0 || colFilters.oncelik.size > 0 || colFilters.durum.size > 0;
}
function clearAllFilters() {
  colFilters = freshColFilters();
  searchQ = "";
  const qs = $("#qSearch"); if (qs) qs.value = "";
  $$("#tabs button").forEach((x) => x.classList.toggle("on", isTabActive(x.dataset.f)));
  renderTable();
}

const SORT_RANK = {
  oncelik: { rutin: 0, acil: 1, stat: 2 },
  durum: { bekleyen: 0, cihazda: 1, tamamlandi: 2 },
};
const SORT_FIELD = { blok: "blok_no", pat: "patoloji_no", test: "test_adi", tip: "grup", isteyen: "isteyen_adi", uzman: "uzman_adi", oncelik: "oncelik", durum: "durum" };
function compareForSort(a, b, col) {
  if (col === "oncelik" || col === "durum") {
    const rank = SORT_RANK[col];
    return (rank[a[col]] ?? 99) - (rank[b[col]] ?? 99);
  }
  const field = SORT_FIELD[col];
  return String(a[field] ?? "").localeCompare(String(b[field] ?? ""), "tr", { numeric: true });
}

// ---------------- Auth ----------------
async function showAuth() {
  $("#appRoot").classList.add("hidden");
  $("#authOverlay").classList.remove("hidden");
  $("#authErr").textContent = "";
  $("#authPin").value = "";
  const sel = $("#authUser");
  sel.innerHTML = "<option>Yükleniyor…</option>";
  try {
    const users = await Api.listActiveUsers();
    sel.innerHTML = users.map((u) => `<option value="${u.id}">${esc(u.ad_soyad)}</option>`).join("");
  } catch (e) {
    sel.innerHTML = '<option value="">(kullanıcı listesi yüklenemedi)</option>';
  }
}

async function handleAuthSubmit() {
  const id = $("#authUser").value;
  const pin = $("#authPin").value;
  if (!id) { $("#authErr").textContent = "Kullanıcı seçin"; return; }
  $("#authSubmit").disabled = true;
  try {
    const user = await Api.login(id, pin);
    if (!user) { $("#authErr").textContent = "PIN hatalı"; return; }
    setSession(user);
    $("#authOverlay").classList.add("hidden");
    await initApp(user);
  } catch (e) {
    $("#authErr").textContent = "Giriş yapılamadı (bağlantı sorunu olabilir)";
  } finally {
    $("#authSubmit").disabled = false;
  }
}

async function handleLogout() {
  clearSession();
  await Api.signOut();
  if (unsub) { unsub(); unsub = null; }
  if (pageUnsub) { pageUnsub(); pageUnsub = null; }
  rows = []; selId = null; searchQ = "";
  colFilters = freshColFilters();
  sortCol = null; sortDir = "asc"; caseView = null;
  currentPage = "kuyruk";
  $("#appRoot").classList.add("hidden");
  showAuth();
}

// ---------------- App init ----------------
async function initApp(user) {
  session = user;
  $("#authOverlay").classList.add("hidden");
  $("#appRoot").classList.remove("hidden");
  $("#meAv").textContent = initials(user.ad_soyad);
  $("#meName").textContent = user.ad_soyad;
  $("#meRole").textContent = ROL_LABEL[user.rol] || user.rol;

  // allSettled: setler_sema.sql henüz çalıştırılmadıysa (istek_setleri/cihazlar
  // tabloları yoksa) o sorgular başarısız olur ama temel katalog/uzman listesi
  // yine de yüklenir — tek bir eksik tablo tüm girişi kilitlemesin.
  const results = await Promise.allSettled([
    Api.getTestKatalog(), Api.getIstekSetleri(), Api.getMySablonlar(user.id), Api.getUzmanlar(), Api.getCihazlar(), Api.getTestGruplari(),
    Api.getSonKullanilanTestler(user.id), Api.getSonKullanilanSetler(user.id),
  ]);
  const [catR, setlerR, mineR, uzmanlarR, cihazlarR, gruplarR, sonTestR, sonSetR] = results;
  if (catR.status === "fulfilled") CAT = catR.value; else toast("Test kataloğu yüklenemedi", true);
  if (setlerR.status === "fulfilled") { ISTEK_SETLERI = setlerR.value; SETS_INST = activeSetsInst(ISTEK_SETLERI); }
  else toast("İstek Setleri yüklenemedi — setler_sema.sql çalıştırıldı mı?", true);
  if (mineR.status === "fulfilled") { MY_SABLONLAR = mineR.value; SETS_MINE = groupByGrup(MY_SABLONLAR); }
  if (uzmanlarR.status === "fulfilled") UZMANLAR = uzmanlarR.value;
  if (cihazlarR.status === "fulfilled") CIHAZLAR = cihazlarR.value;
  if (gruplarR.status === "fulfilled" && gruplarR.value.length) {
    GROUPS = gruplarR.value.map((g) => [g.kod, g.ad]);
    TIP = Object.fromEntries(GROUPS);
  } else if (gruplarR.status === "rejected") {
    toast("Test grupları yüklenemedi — yonetim_sema.sql çalıştırıldı mı? (varsayılan gruplar kullanılıyor)", true);
  }
  // son_kullanilanlar_sema.sql henüz çalıştırılmadıysa bu iki view/tablo yok
  // olur — sessizce eski (tam liste) davranışa düşülür, hata gösterilmez.
  if (sonTestR.status === "fulfilled") RECENT_TESTS = buildRecentTests(sonTestR.value);
  if (sonSetR.status === "fulfilled") RECENT_SETLER = buildRecentSetlerMap(sonSetR.value);

  wireStaticUI();
  if (unsub) unsub();
  unsub = Api.subscribeQueue(scheduleReload);

  navigate("kuyruk");
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadQueue, 150);
}

async function refreshMySablonlar() {
  MY_SABLONLAR = await Api.getMySablonlar(session.id);
  SETS_MINE = groupByGrup(MY_SABLONLAR);
}

async function refreshGruplar() {
  const list = await Api.getTestGruplari();
  if (list.length) {
    GROUPS = list.map((g) => [g.kod, g.ad]);
    TIP = Object.fromEntries(GROUPS);
  }
}

// ---------------- Router ----------------
function navigate(page) {
  currentPage = page;
  $$("#nav a").forEach((a) => a.classList.toggle("on", a.dataset.page === page));
  if (pageUnsub) { pageUnsub(); pageUnsub = null; }
  showEmpty();

  if (page === "kuyruk") {
    renderQueuePage();
  } else if (page === "setler") {
    renderSetlerPage();
    pageUnsub = Api.subscribeIstekSetleri(async () => {
      try { ISTEK_SETLERI = await Api.getIstekSetleri(); SETS_INST = activeSetsInst(ISTEK_SETLERI); if (currentPage === "setler") renderSetlerPage(); } catch (e) { /* geçici bağlantı sorunu */ }
    });
  } else if (page === "sablonlar") {
    renderSablonlarPage();
  } else if (page === "cihazlar") {
    renderCihazlarPage();
    pageUnsub = Api.subscribeCihazlar(async () => {
      try { CIHAZLAR = await Api.getCihazlar(); if (currentPage === "cihazlar") renderCihazlarPage(); } catch (e) { /* geçici bağlantı sorunu */ }
    });
  } else if (page === "hizmetler") {
    renderHizmetlerPage();
    pageUnsub = Api.subscribeHizmetler(() => loadHizmetler());
  } else if (page === "kullanicilar") {
    renderKullanicilarPage();
  } else if (page === "test-gruplari") {
    renderTestGruplariPage();
  } else if (page === "test-katalogu") {
    renderTestKatalogPage();
  } else if (page === "yedekler") {
    renderYedeklerPage();
  }
}

// ================================================================
// İŞ KUYRUĞU
// ================================================================
function renderQueuePage() {
  $("#mainView").innerHTML = `
    <div class="main-head">
      <h1>İş Kuyruğu</h1>
      <div class="sub"><b id="totalN">0</b> istek · IHC, histokimya, moleküler</div>
    </div>
    <div class="barrow" id="barrow">
      <div class="tabs" id="tabs">
        <button class="${isTabActive("all") ? "on" : ""}" data-f="all">Tümü <span class="count" data-c="all">0</span></button>
        <button class="${isTabActive("bekleyen") ? "on" : ""}" data-f="bekleyen">Bekleyen <span class="count" data-c="bekleyen">0</span></button>
        <button class="${isTabActive("cihazda") ? "on" : ""}" data-f="cihazda">Cihazda <span class="count" data-c="cihazda">0</span></button>
        <button class="${isTabActive("tamamlandi") ? "on" : ""}" data-f="tamamlandi">Tamamlandı <span class="count" data-c="tamamlandi">0</span></button>
      </div>
      <div class="grow"></div>
      <button class="btn-ghost btn-sm hidden" id="clearFiltersBtn">Filtreleri Temizle</button>
      <div id="qExport">${EXPORT_MENU_HTML}</div>
      <div class="msearch">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#26221d" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input id="qSearch" placeholder="Blok, patoloji no…" value="${esc(searchQ)}">
      </div>
    </div>
    <div class="case-banner hidden" id="caseBanner"></div>
    <div class="tablewrap">
      <table>
        <thead id="qhead"></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>`;

  if (caseView !== null) $("#barrow").classList.add("dimmed");

  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    setDurumTab(b.dataset.f);
    $$("#tabs button").forEach((x) => x.classList.toggle("on", isTabActive(x.dataset.f)));
    renderTable();
  });
  $("#qSearch").addEventListener("input", (e) => { searchQ = e.target.value; renderTable(); });
  $("#clearFiltersBtn").addEventListener("click", clearAllFilters);
  bindExportMenu("#qExport", (which) => {
    const list = which === "tum" ? rows : getVisibleRows();
    exportToExcel(list, KUYRUK_EXPORT_COLS, `istem_kuyruk_${which === "tum" ? "tumu" : "gorunenler"}`);
  });
  $("#rows").addEventListener("click", (e) => {
    const patCell = e.target.closest(".c-pat");
    if (patCell) {
      e.stopPropagation();
      const tr = patCell.closest("tr[data-kalem]");
      const r = rows.find((x) => x.kalem_id === tr.dataset.kalem);
      if (r) openCaseView(r.patoloji_no);
      return;
    }
    const btn = e.target.closest(".act[data-id]");
    if (btn) { e.stopPropagation(); advance(btn.dataset.id, btn.dataset.to); return; }
    const tr = e.target.closest("tr[data-kalem]");
    if (tr) { const r = rows.find((x) => x.kalem_id === tr.dataset.kalem); if (r) showDetail(r); }
  });
  $("#qhead").addEventListener("click", (e) => {
    const caret = e.target.closest("[data-thopen]");
    if (caret) {
      e.stopPropagation();
      const panel = $(`[data-thpanel="${caret.dataset.thopen}"]`);
      const isOpen = panel.classList.contains("open");
      $$(".thfilter.open").forEach((p) => p.classList.remove("open"));
      if (!isOpen) {
        panel.classList.add("open");
        panel.querySelector("[data-thsearch]")?.focus();
      }
      return;
    }
    const label = e.target.closest("[data-sortcol]");
    if (label) {
      const key = label.dataset.sortcol;
      if (sortCol === key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortCol = key; sortDir = "asc"; }
      renderTable();
    }
  });
  // Checkbox'lar (Tip/Öncelik/Durum çoklu seçim) — "change" ile, popover
  // KAPANMAZ, art arda birden fazla değer işaretlenebilsin.
  $("#qhead").addEventListener("change", (e) => {
    const chk = e.target.closest("[data-thcheck]");
    if (!chk) return;
    const key = chk.dataset.thcheck, val = chk.value;
    if (key === "durum") {
      if (chk.checked) colFilters.durum.add(val); else colFilters.durum.delete(val);
      $$("#tabs button").forEach((b) => b.classList.toggle("on", isTabActive(b.dataset.f)));
    } else {
      if (chk.checked) colFilters[key].add(val); else colFilters[key].delete(val);
    }
    renderTable();
  });
  // Metin sütun filtreleri — canlı arama.
  $("#qhead").addEventListener("input", (e) => {
    const inp = e.target.closest("[data-thsearch]");
    if (!inp) return;
    colFilters[inp.dataset.thsearch] = inp.value.toLowerCase();
    renderTable();
  });

  loadQueue();
}

function openCaseView(patNo) {
  caseView = patNo;
  $("#barrow")?.classList.add("dimmed");
  renderTable();
}
function closeCaseView() {
  caseView = null;
  $("#barrow")?.classList.remove("dimmed");
  renderTable();
}
function renderCaseBanner() {
  const el = $("#caseBanner");
  if (!el) return;
  if (caseView === null) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const count = rows.filter((r) => r.patoloji_no === caseView).length;
  el.classList.remove("hidden");
  el.innerHTML = `<span>Vaka: <b>${esc(caseView)}</b> — tüm geçmiş (${count} kayıt, kronolojik)</span>
    <button class="btn-ghost btn-sm" id="closeCaseView">× Kuyruğa dön</button>`;
  $("#closeCaseView").onclick = closeCaseView;
}

// Paylaşılan th-builder'lar (İş Kuyruğu + Hizmetler) — global state'e doğrudan
// erişmeden, tüm değerleri parametre olarak alır.
// sortState: {active, dir} ya da null (sıralanamayan sütun, ör. Özet).
function thHead(key, label, sortState, filterOn, innerPanelHTML) {
  const arrow = sortState ? (sortState.active ? (sortState.dir === "asc" ? " ▲" : " ▼") : "") : "";
  const labelHTML = sortState
    ? `<span class="thlabel" data-sortcol="${key}">${esc(label)}${arrow}</span>`
    : `<span class="thlabel-static">${esc(label)}</span>`;
  return `<th class="thcol${filterOn ? " filtered" : ""}">
    ${labelHTML}
    <button class="thcaret ${filterOn ? "on" : ""}" data-thopen="${key}">▾</button>
    <div class="thfilter" data-thpanel="${key}">${innerPanelHTML}</div>
  </th>`;
}
function thTextFilter(key, label, value, sortState) {
  return thHead(key, label, sortState, Boolean(value), `
    <input type="text" class="thsearch" data-thsearch="${key}" placeholder="${esc(label)} ara…" value="${esc(value || "")}">`);
}
function thMultiFilter(key, label, options, activeSet, sortState) {
  return thHead(key, label, sortState, activeSet.size > 0, options.map((o) => `
    <label class="thcheck"><input type="checkbox" data-thcheck="${key}" value="${esc(o.value)}" ${activeSet.has(o.value) ? "checked" : ""}> ${esc(o.label)}</label>`).join(""));
}

function renderQHead() {
  const head = $("#qhead");
  if (!head) return;
  if (caseView !== null) {
    head.innerHTML = `<tr><th>Aksiyon</th><th>Patoloji No</th><th>Blok</th><th>İstek</th><th>Tip</th><th>İsteyen</th><th>Uzman Adına</th><th>Tarih</th><th>Öncelik</th><th>Durum</th><th>Not</th></tr>`;
    return;
  }

  // Bu fonksiyon her renderTable()'da (tuş vuruşu, realtime güncelleme, sekme
  // tıklaması...) TÜM thead'i yeniden kuruyor — açık panel ve odaklı bir metin
  // filtresi varsa, kullanıcı yazarken odağının/imlecinin kaybolmaması için
  // kaydedip innerHTML'den SONRA geri yükle.
  const openKey = head.querySelector(".thfilter.open")?.dataset.thpanel;
  const active = document.activeElement;
  const focusKey = active?.matches("[data-thsearch]") ? active.dataset.thsearch : null;
  const selStart = focusKey ? active.selectionStart : null;
  const selEnd = focusKey ? active.selectionEnd : null;

  const sortOf = (key) => ({ active: sortCol === key, dir: sortDir });
  head.innerHTML = `<tr>
    <th>Aksiyon</th>
    ${thTextFilter("pat", "Patoloji No", colFilters.pat, sortOf("pat"))}
    ${thTextFilter("blok", "Blok", colFilters.blok, sortOf("blok"))}
    ${thTextFilter("test", "İstek", colFilters.test, sortOf("test"))}
    ${thMultiFilter("tip", "Tip", GROUPS.map(([k, l]) => ({ value: k, label: l })), colFilters.tip, sortOf("tip"))}
    ${thTextFilter("isteyen", "İsteyen", colFilters.isteyen, sortOf("isteyen"))}
    ${thTextFilter("uzman", "Uzman Adına", colFilters.uzman, sortOf("uzman"))}
    <th>Tarih</th>
    ${thMultiFilter("oncelik", "Öncelik", ["rutin", "acil", "stat"].map((k) => ({ value: k, label: PRIO[k][1] })), colFilters.oncelik, sortOf("oncelik"))}
    ${thMultiFilter("durum", "Durum", ["bekleyen", "cihazda", "tamamlandi"].map((k) => ({ value: k, label: PILL[k][1] })), colFilters.durum, sortOf("durum"))}
    <th>Not</th>
  </tr>`;

  if (openKey) head.querySelector(`[data-thpanel="${openKey}"]`)?.classList.add("open");
  if (focusKey) {
    const input = head.querySelector(`[data-thsearch="${focusKey}"]`);
    if (input) { input.focus(); input.setSelectionRange(selStart, selEnd); }
  }
}

function passesFilter(r) {
  if (colFilters.durum.size && !colFilters.durum.has(r.durum)) return false;
  if (colFilters.tip.size && !colFilters.tip.has(r.grup)) return false;
  if (colFilters.oncelik.size && !colFilters.oncelik.has(r.oncelik)) return false;
  if (colFilters.pat && !r.patoloji_no.toLowerCase().includes(colFilters.pat)) return false;
  if (colFilters.blok && !r.blok_no.toLowerCase().includes(colFilters.blok)) return false;
  if (colFilters.test && !r.test_adi.toLowerCase().includes(colFilters.test)) return false;
  if (colFilters.isteyen && !(r.isteyen_adi || "").toLowerCase().includes(colFilters.isteyen)) return false;
  if (colFilters.uzman && !(r.uzman_adi || "").toLowerCase().includes(colFilters.uzman)) return false;
  if (searchQ) {
    const q = searchQ.toLowerCase();
    if (!r.blok_no.toLowerCase().includes(q) && !r.patoloji_no.toLowerCase().includes(q)) return false;
  }
  return true;
}

// Ekranda o an görünen (filtre+arama+sıralama+vaka görünümü uygulanmış)
// satırlar — hem renderTable hem "Görünenler" Excel export'u bunu kullanır.
function getVisibleRows() {
  if (caseView !== null) {
    return rows.filter((r) => r.patoloji_no === caseView)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  let list = rows.filter(passesFilter);
  if (sortCol) {
    const dir = sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => compareForSort(a, b, sortCol) * dir);
  }
  return list;
}

function renderTable() {
  const tb = $("#rows");
  if (!tb) return; // kuyruk sayfasında değiliz
  renderQHead();
  renderCaseBanner();
  tb.innerHTML = "";

  const list = getVisibleRows();

  list.forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.kalem = r.kalem_id;
    if (r.kalem_id === selId) tr.className = "sel";
    let act;
    if (r.durum === "bekleyen") act = `<button class="act act-cihaza" data-id="${r.kalem_id}" data-to="cihazda">Cihaza al</button>`;
    else if (r.durum === "cihazda") act = `<button class="act act-tamamla" data-id="${r.kalem_id}" data-to="tamamlandi">Tamamla</button>`;
    else act = `<span style="color:var(--ink-3);font-size:12px">${timeAgo(r.updated_at)}</span>`;
    const notCell = r.not_metni
      ? `<span class="note-txt" title="${esc(r.not_metni)}">${esc(r.not_metni.length > 40 ? r.not_metni.slice(0, 40) + "…" : r.not_metni)}</span>`
      : "";
    tr.innerHTML = `<td>${act}</td>
      <td class="c-pat">${esc(r.patoloji_no)}</td>
      <td class="c-blok">${esc(r.blok_no)}</td>
      <td class="c-test">${esc(r.test_adi)}${r.klon ? `<small>${esc(r.klon)}</small>` : ""}</td>
      <td><span class="tag">${TIP[r.grup] || "Diğer"}</span></td>
      <td>${esc(r.isteyen_adi || "—")}</td>
      <td>${esc(r.uzman_adi || "—")}</td>
      <td style="color:var(--ink-3);font-size:12px;white-space:nowrap">${formatDateFull(r.created_at)}</td>
      <td><span class="prio ${PRIO[r.oncelik][0]}">${PRIO[r.oncelik][1]}</span></td>
      <td><span class="pill ${PILL[r.durum][0]}">${PILL[r.durum][1]}</span></td>
      <td class="c-not">${notCell}</td>`;
    tb.appendChild(tr);
  });
  updateCounts();
}

function updateCounts() {
  const totalEl = $("#totalN"); if (!totalEl) return;
  totalEl.textContent = rows.length;
  ["all", "bekleyen", "cihazda", "tamamlandi"].forEach((f) => {
    const el = document.querySelector(`[data-c="${f}"]`);
    if (el) el.textContent = f === "all" ? rows.length : rows.filter((r) => r.durum === f).length;
  });
  $("#clearFiltersBtn")?.classList.toggle("hidden", !hasActiveFilters());
}

async function advance(kalemId, toDurum) {
  try {
    await Api.advanceDurum(kalemId, toDurum, session.id);
    await loadQueue();
  } catch (e) {
    toast("Durum güncellenemedi", true);
  }
}

async function loadQueue() {
  try {
    rows = await Api.listQueue();
  } catch (e) {
    toast("İş kuyruğu yüklenemedi", true);
    return;
  }
  if (currentPage !== "kuyruk") return;
  renderTable();
  if (selId) {
    const cur = rows.find((r) => r.kalem_id === selId);
    if (cur) showDetail(cur); else showEmpty();
  }
}

// ---------------- Sağ panel: boş / detay ----------------
function showEmpty() {
  selId = null;
  const m = EMPTY_MSG[currentPage] || EMPTY_MSG.kuyruk;
  $("#rail").innerHTML = `<div class="empty">
    <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2v6l-5 9a2 2 0 0 0 2 3h12a2 2 0 0 0 2-3l-5-9V2M9 2h6M7 14h10"/></svg>
    <div class="t">${esc(m.t)}</div>
    <div class="d">${esc(m.d)}</div>
  </div>`;
  renderTable();
}

async function showDetail(r) {
  selId = r.kalem_id;
  renderTable();
  const rail = $("#rail");
  rail.innerHTML = `<div class="rail-head"><h2>İstek Detayı</h2><button class="rx" id="closeDetail">×</button></div>
    <div class="rail-body" id="detailBody">Yükleniyor…</div>`;
  $("#closeDetail").onclick = showEmpty;

  let logs = [];
  try { logs = await Api.getTimeline(r.kalem_id); } catch (e) { /* geçmişsiz devam */ }
  if (selId !== r.kalem_id) return; // kullanıcı başka satıra geçti

  const steps = [["bekleyen", "İstendi"], ["cihazda", "Cihaza alındı"], ["tamamlandi", "Tamamlandı"]];
  const order = steps.findIndex((s) => s[0] === r.durum);
  const timeFor = (key) => { const f = logs.find((l) => l.yeni_durum === key); return f ? formatDT(f.created_at) : null; };
  const tl = steps.map(([key, lbl], i) => {
    const cls = i < order ? "done" : i === order ? "cur" : "";
    const t = timeFor(key);
    return `<div class="step ${cls}"><div class="node"></div><div><div class="lbl">${lbl}</div>${t ? `<div class="time">${t}</div>` : ""}</div></div>`;
  }).join("");

  const aktifCihazlar = CIHAZLAR.filter((c) => c.aktif || c.id === r.cihaz_id);

  $("#detailBody").innerHTML = `
    <div class="d-pat">${esc(r.patoloji_no)}</div><div class="d-blok">${esc(r.blok_no)}</div>
    <div class="d-test"><div class="n">${esc(r.test_adi)}</div>${r.klon ? `<div class="c">Klon ${esc(r.klon)}</div>` : ""}</div>
    <div class="d-grid">
      <div><div class="k">Tip</div><div class="v"><span class="tag">${TIP[r.grup] || "Diğer"}</span></div></div>
      <div><div class="k">Öncelik</div><div class="v"><span class="prio ${PRIO[r.oncelik][0]}">${PRIO[r.oncelik][1]}</span></div></div>
      <div><div class="k">İsteyen</div><div class="v">${esc(r.isteyen_adi || "—")}</div></div>
      <div><div class="k">Uzman adına</div><div class="v">${esc(r.uzman_adi || "—")}</div></div>
    </div>
    <div class="m-label">Cihaz</div>
    <div class="m-sec">
      <select class="finput" id="cihazSel">
        <option value="">— cihaz seçilmedi —</option>
        ${aktifCihazlar.map((c) => `<option value="${c.id}" ${c.id === r.cihaz_id ? "selected" : ""}>${esc(c.ad)}${c.tip ? ` (${esc(c.tip)})` : ""}</option>`).join("")}
      </select>
    </div>
    <div class="m-label" style="margin-bottom:10px">Durum geçmişi</div>
    <div class="tl">${tl}</div>
    <div class="m-label">Not</div>
    <div class="v" style="font-size:13px">${r.not_metni ? esc(r.not_metni) : "—"}</div>`;

  $("#cihazSel").onchange = async (e) => {
    try {
      await Api.assignCihaz(r.kalem_id, e.target.value || null);
      toast("Cihaz güncellendi");
      await loadQueue();
    } catch (err) {
      toast("Cihaz atanamadı", true);
    }
  };

  let toDurum = null;
  if (r.durum === "bekleyen") toDurum = "cihazda";
  else if (r.durum === "cihazda") toDurum = "tamamlandi";
  const advLabel = toDurum === "cihazda" ? "Cihaza al" : toDurum === "tamamlandi" ? "Tamamla" : null;
  const canDelete = r.durum !== "tamamlandi"; // tamamlanmış kayıtlar kalıcıdır, silinemez
  if (canDelete || advLabel) {
    rail.insertAdjacentHTML("beforeend", `<div class="rail-foot">
      ${canDelete ? `<button class="btn-ghost" id="delIstemBtn">Sil</button>` : ""}
      ${advLabel ? `<button class="btn-primary" id="advBtn">${advLabel}</button>` : ""}
    </div>`);
    if (toDurum) $("#advBtn").onclick = () => advance(r.kalem_id, toDurum);
    if (canDelete) {
      $("#delIstemBtn").onclick = () => confirmAndDelete(`${r.patoloji_no} — ${r.test_adi}`, () => Api.deleteIstemKalem(r.kalem_id), async () => {
        toast("Kalem silindi");
        showEmpty();
        await loadQueue();
      });
    }
  }
}

// ================================================================
// Paylaşılan test seçici (Yeni İstek formu + Şablon düzenleyici)
// ================================================================
function pickerSectionsHTML({ withQuickFill }) {
  return `
    <div class="m-sec"><div class="groups" id="groups">
      ${GROUPS.map(([k, l], i) => `<button class="${i === 0 ? "on" : ""}" data-g="${k}">${l}</button>`).join("")}
    </div></div>
    ${withQuickFill ? `
    <div class="m-sec" id="setsSec"><p class="m-label">Hazır Setler</p>
      <div class="antisearch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#26221d" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input id="setSearch" placeholder="Set ara…"></div>
      <div class="sets" id="sets"></div></div>
    <div class="m-sec" id="mySetsSec"><p class="m-label">Şablonlarım</p><div class="sets" id="mySets"></div></div>` : ""}
    <div class="m-sec" id="antiSec"><p class="m-label">Tek Tek Seç <button type="button" class="bulkpick-toggle" id="bulkPickToggle">Toplu Seç</button></p>
      <div class="antisearch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#26221d" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input id="antiSearch" placeholder="Test ara… ER, HER2, CK7… (Enter ile hızlı ekle)"></div>
      <div class="bulkpick-box" id="bulkPickBox">
        <textarea id="bulkPickText" placeholder="Her satıra bir test adı, opsiyonel olarak virgülle klon…&#10;ER, SP1&#10;PR"></textarea>
        <button class="btn-ghost btn-sm" id="bulkPickAdd">Seç</button>
      </div>
      <div id="pickedSec" style="display:none;margin-bottom:12px">
        <p class="m-label">Seçilenler</p>
        <div class="antis" id="pickedChips"></div>
      </div>
      <div class="antis" id="antis"></div>
      <div class="otherbox" id="otherbox"><input id="otherin" placeholder="Katalogda olmayan istek…"><button class="add" id="addOtherBtn">+</button></div></div>`;
}

function applySetTestler(testler) {
  testler.forEach((t) => {
    if (t.custom) {
      const existing = customItems.find((c) => c.ad === t.ad);
      if (existing) existing.sel = true; else customItems.push({ ad: t.ad, sel: true, grup: t.grup });
    } else {
      selectedTests.set(t.id, { ad: t.ad, klon: t.klon, grup: t.grup });
    }
  });
}

// Varsayılan (arama boş): kullanıcının bu grupta en son kullandığı setler
// (RECENT_SETLER, en fazla RECENT_SET_CAP) — hiç kullanım geçmişi yoksa
// mevcut "sira" sırasına göre ilk N. Arama doluysa: ada göre tam liste.
function renderSets() {
  const s = $("#sets"); if (!s) return;
  const all = SETS_INST[grp] || [];
  $("#setsSec").style.display = all.length ? "" : "none";
  const q = ($("#setSearch")?.value || "").trim().toLowerCase();

  let list;
  if (q) {
    list = all.filter((set) => set.ad.toLowerCase().includes(q));
  } else {
    const used = all
      .map((set) => ({ set, usage: RECENT_SETLER.get(set.id) }))
      .filter((x) => x.usage)
      .sort((a, b) => new Date(b.usage.son_kullanim) - new Date(a.usage.son_kullanim));
    list = used.length ? used.slice(0, RECENT_SET_CAP).map((x) => x.set) : all.slice(0, RECENT_SET_CAP);
  }

  s.innerHTML = "";
  list.forEach((set) => {
    const el = document.createElement("button");
    el.className = "set";
    el.textContent = set.ad;
    el.onclick = () => {
      applySetTestler(set.testler);
      el.classList.add("hot");
      Api.logSetKullanimi(session.id, set.id).catch(() => {}); // best-effort — başarısız olursa forma engel olmaz
      renderAntis($("#antiSearch")?.value || "");
    };
    s.appendChild(el);
  });
}

function renderMySets() {
  const s = $("#mySets"); if (!s) return;
  const list = SETS_MINE[grp] || [];
  $("#mySetsSec").style.display = list.length ? "" : "none";
  s.innerHTML = "";
  list.forEach((set) => {
    const el = document.createElement("button");
    el.className = "set";
    el.textContent = set.ad;
    el.onclick = () => { applySetTestler(set.testler); el.classList.add("hot"); renderAntis($("#antiSearch")?.value || ""); };
    s.appendChild(el);
  });
}

// Varsayılan (arama boş): kullanıcının bu grupta en son kullandığı testler
// (RECENT_TESTS, en fazla RECENT_CAP) — hiç kullanım geçmişi yoksa mevcut
// "sira" sırasına göre ilk N. Arama doluysa: tüm katalogda ada göre arar
// (eski davranış). Zaten seçilmiş testler burada TEKRAR gösterilmez —
// "Seçilenler" sabit alanında (renderPicked) yaşarlar.
function renderAntis(q = "") {
  const wrap = $("#antis");
  if (!wrap) return;
  const isDiger = grp === "diger";
  $("#otherbox").classList.toggle("show", isDiger);
  wrap.innerHTML = "";
  const query = q.trim().toLowerCase();

  let catMatches;
  if (query) {
    catMatches = (CAT[grp] || []).filter((t) => t.ad.toLowerCase().includes(query) && !selectedTests.has(t.id));
  } else {
    const recent = (RECENT_TESTS[grp] || []).filter((t) => !selectedTests.has(t.id));
    catMatches = recent.length
      ? recent.slice(0, RECENT_CAP)
      : (CAT[grp] || []).filter((t) => !selectedTests.has(t.id)).slice(0, RECENT_CAP);
  }
  catMatches.forEach((t) => {
    const el = document.createElement("span");
    el.className = "anti";
    el.innerHTML = `${esc(t.ad)}${t.klon ? `<small>${esc(t.klon)}</small>` : ""}`;
    el.onclick = () => {
      selectedTests.set(t.id, { ad: t.ad, klon: t.klon, grup: t.grup });
      renderAntis(q);
    };
    wrap.appendChild(el);
  });

  // "Diğer" grubunun kendi serbest-metin (ozel_test, kataloğa yazılmayan)
  // öğeleri — otherbox ile eklenir, burada da (henüz seçilmemişse) aranır.
  let customMatches = [];
  if (isDiger) {
    const unsel = customItems.filter((c) => !c.sel);
    customMatches = query ? unsel.filter((c) => c.ad.toLowerCase().includes(query)) : unsel;
    customMatches.forEach((c) => {
      const el = document.createElement("span");
      el.className = "anti";
      el.textContent = c.ad;
      el.onclick = () => { c.sel = true; renderAntis(q); };
      wrap.appendChild(el);
    });
  }

  // Hiçbir eşleşme yoksa: yazılanı gerçek bir test_katalog kaydı olarak
  // ekleme seçeneği — bir dahaki sefere kataloğa kayıtlı çıkar. "Diğer"
  // dahil tüm gruplarda çalışır; otherbox'ın tek-seferlik ozel_test akışını
  // bozmaz, ona ek bir yol sunar.
  if (query && catMatches.length === 0 && customMatches.length === 0) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "anti-add";
    addBtn.textContent = `+ "${q.trim()}" olarak ekle`;
    addBtn.onclick = () => addTestToKatalog(q.trim());
    wrap.appendChild(addBtn);
  }

  renderPicked();
}

// Zaten seçilmiş tüm testler/serbest-metin öğeleri — TÜM gruplar (bir istem
// birden fazla gruptan test içerebilir, bkz. collectPickedTestler), sabit bir
// alanda. Tıklamak seçimi kaldırır (antis listesine geri döner).
function renderPicked() {
  const wrap = $("#pickedChips"), sec = $("#pickedSec");
  if (!wrap || !sec) return;
  const chips = [];
  selectedTests.forEach((v, id) => chips.push({ kind: "cat", key: id, ad: v.ad, klon: v.klon }));
  customItems.filter((c) => c.sel).forEach((c) => chips.push({ kind: "custom", key: c.ad, ad: c.ad, klon: "" }));

  sec.style.display = chips.length ? "" : "none";
  wrap.innerHTML = chips.map((c) =>
    `<span class="anti sel" data-kind="${c.kind}" data-key="${esc(c.key)}">${esc(c.ad)}${c.klon ? `<small>${esc(c.klon)}</small>` : ""}</span>`
  ).join("");
  wrap.querySelectorAll(".anti").forEach((el) => {
    el.onclick = () => {
      if (el.dataset.kind === "cat") selectedTests.delete(el.dataset.key);
      else { const c = customItems.find((x) => x.ad === el.dataset.key); if (c) c.sel = false; }
      renderAntis($("#antiSearch")?.value || "");
    };
  });
}

async function addTestToKatalog(ad) {
  try {
    const row = await Api.addTestKatalogQuick(grp, ad);
    (CAT[grp] ??= []).push({ id: row.id, ad: row.ad, klon: "", grup: grp });
    selectedTests.set(row.id, { ad: row.ad, klon: "", grup: grp });
    const input = $("#antiSearch");
    if (input) input.value = "";
    renderAntis("");
    toast(`"${ad}" kataloğa ve seçime eklendi`);
  } catch (e) {
    toast("Eklenemedi", true);
  }
}

function bindPicker(withQuickFill) {
  $("#groups").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("#groups button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    grp = b.dataset.g;
    if (withQuickFill) { renderSets(); renderMySets(); }
    renderAntis();
  });
  $("#antiSearch").addEventListener("input", (e) => renderAntis(e.target.value));
  // Enter: o an görünen ilk sonucu (ya da eşleşme yoksa "+ ... olarak ekle"
  // seçeneğini) seçip kutuyu temizler — art arda isim yazıp Enter'a basarak
  // fareye dokunmadan hızlıca ekleme.
  $("#antiSearch").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const input = $("#antiSearch");
    if (!input.value.trim()) return;
    const first = $("#antis .anti, #antis .anti-add");
    if (first) first.click();
    input.value = "";
    renderAntis("");
    input.focus();
  });
  if (withQuickFill) {
    $("#setSearch").addEventListener("input", renderSets);
  }
  $("#addOtherBtn").addEventListener("click", () => {
    const v = $("#otherin").value.trim(); if (!v) return;
    const existing = customItems.find((c) => c.ad === v);
    if (existing) existing.sel = true; else customItems.push({ ad: v, sel: true, grup: "diger" });
    $("#otherin").value = ""; renderAntis();
  });
  $("#bulkPickToggle").addEventListener("click", () => {
    $("#bulkPickBox").classList.toggle("show");
  });
  $("#bulkPickAdd").addEventListener("click", bulkPickSelect);
  if (withQuickFill) { renderSets(); renderMySets(); }
  renderAntis();
}

// "Toplu Seç" — yapıştırılan satırları (İsim, Klon — klon opsiyonel)
// mevcut katalogla eşleştirir; eşleşenler doğrudan seçime eklenir,
// eşleşmeyenler test_katalog'a yeni kayıt olarak eklenip (bulkCreateTestKatalogEntries
// ile — Test Kataloğu'ndaki toplu ekleme ile aynı mekanizma) seçime eklenir.
async function bulkPickSelect() {
  const items = parseBulkLines($("#bulkPickText").value);
  if (!items.length) { toast("Eklenecek satır yok", true); return; }
  const btn = $("#bulkPickAdd");
  btn.disabled = true;
  try {
    const catalog = CAT[grp] || [];
    const toCreate = [];
    let matchedCount = 0;
    items.forEach((it) => {
      const found = catalog.find((t) => t.ad.toLowerCase() === it.ad.toLowerCase());
      if (found) {
        selectedTests.set(found.id, { ad: found.ad, klon: found.klon, grup: found.grup });
        matchedCount++;
      } else if (!toCreate.some((t) => t.ad.toLowerCase() === it.ad.toLowerCase())) {
        toCreate.push(it);
      }
    });
    if (toCreate.length) {
      const created = await Api.bulkCreateTestKatalogEntries(grp, toCreate);
      created.forEach((row) => {
        (CAT[grp] ??= []).push({ id: row.id, ad: row.ad, klon: row.klon || "", grup: grp });
        selectedTests.set(row.id, { ad: row.ad, klon: row.klon || "", grup: grp });
      });
    }
    $("#bulkPickText").value = "";
    $("#bulkPickBox").classList.remove("show");
    renderAntis("");
    toast(`${matchedCount} kataloğa kayıtlıydı, ${toCreate.length} yeni eklendi — hepsi seçime alındı`);
  } catch (e) {
    toast("Toplu seçim başarısız", true);
  } finally {
    btn.disabled = false;
  }
}

function collectPickedTestler() {
  const testler = [];
  selectedTests.forEach((v, id) => testler.push({ test_id: id, grup: v.grup }));
  customItems.filter((c) => c.sel).forEach((c) => testler.push({ ozel_test: c.ad, grup: c.grup }));
  return testler;
}

// ================================================================
// YENİ İSTEK FORMU
// ================================================================
function showForm(prefill) {
  navigate("kuyruk");
  grp = "ihc"; prio = "rutin";
  selectedTests = new Map(); customItems = [];
  if (prefill && prefill.testler) {
    grp = prefill.grup || "ihc";
    applySetTestler(prefill.testler);
  }

  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>Yeni İstek</h2><button class="rx" id="closeForm">×</button></div>
    <div class="rail-body">
      <div class="m-sec"><p class="m-label">Uzman adına</p>
        <select class="onbehalf" id="mUzman">${UZMANLAR.map((u) => `<option value="${u.id}">${esc(u.ad_soyad)}</option>`).join("")}</select></div>
      <div class="m-sec"><p class="m-label">Patoloji No</p>
        <div class="patrow"><input id="mPat" placeholder="ör. 11240/26">
          <button class="scan" disabled title="Yakında: barkod ile tarama"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg></button></div></div>
      ${pickerSectionsHTML({ withQuickFill: true })}
      <div class="m-sec"><p class="m-label">Blok Seçimi <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— manuel, opsiyonel</span></p>
        <div class="blocks" id="blocks"><input class="bin" id="blockin" placeholder="+ blok"></div></div>
      <div class="m-sec"><p class="m-label">Öncelik</p>
        <div class="prios" id="prios"><button class="on" data-p="rutin">Rutin</button><button data-p="acil">Acil</button><button data-p="stat">STAT</button></div></div>
      <div class="m-sec" style="margin-bottom:2px"><p class="m-label">Not</p><textarea id="mNot" placeholder="Teknisyene not…"></textarea></div>
    </div>
    <div class="rail-foot"><button class="btn-ghost" id="cancelForm">İptal</button><button class="btn-primary" id="submitForm">İstek Ver</button></div>`;

  $("#closeForm").onclick = showEmpty;
  $("#cancelForm").onclick = showEmpty;
  $$("#groups button").forEach((b) => b.classList.toggle("on", b.dataset.g === grp));
  bindPicker(true);

  $("#blockin").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      addBlockChip(e.target.value.trim());
      e.target.value = "";
    }
  });
  $("#prios").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("#prios button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    prio = b.dataset.p;
  });
  $("#submitForm").onclick = submitForm;
}

function addBlockChip(v) {
  const c = document.createElement("span");
  c.className = "bchip";
  c.innerHTML = `${esc(v)} <span class="x">×</span>`;
  c.querySelector(".x").onclick = () => c.remove();
  $("#blocks").insertBefore(c, $("#blockin"));
}

async function submitForm() {
  const patNo = $("#mPat").value.trim();
  if (!patNo) { toast("Patoloji no gerekli", true); return; }

  // Enter'a basılmadan input'ta kalan yazı da otomatik chip'e dönüşsün —
  // blok girişi opsiyonel, Enter'a basmak artık zorunlu değil.
  const blockInput = $("#blockin");
  const pending = blockInput ? blockInput.value.trim() : "";
  if (pending) { addBlockChip(pending); blockInput.value = ""; }

  let bloklar = [...$$("#blocks .bchip")].map((c) => c.textContent.replace("×", "").trim()).filter(Boolean);
  if (!bloklar.length) bloklar = [""]; // blok girilmemişse tek, boş bloklu kalemler oluşur

  const testler = collectPickedTestler();
  if (!testler.length) { toast("En az bir test seçin", true); return; }

  const uzmanEl = $("#mUzman");
  const uzman_id = uzmanEl && uzmanEl.value ? uzmanEl.value : null;
  const not_metni = $("#mNot").value.trim() || null;

  $("#submitForm").disabled = true;
  try {
    await Api.createIstem({ patoloji_no: patNo, istem_yapan_id: session.id, uzman_id, oncelik: prio, not_metni, bloklar, testler });
    setDurumTab("all");
    $$("#tabs button").forEach((x) => x.classList.toggle("on", isTabActive(x.dataset.f)));
    toast("İstek oluşturuldu");
    showEmpty();
    await loadQueue();
    if (currentPage === "kuyruk") renderTable();
    // Az önce kullanılan testler bu oturumda hemen "son kullanılanlar"a
    // yansısın diye — best-effort, başarısız olursa sessizce geç.
    Api.getSonKullanilanTestler(session.id).then((rows) => { RECENT_TESTS = buildRecentTests(rows); }).catch(() => {});
  } catch (e) {
    toast("İstek oluşturulamadı", true);
  } finally {
    const btn = $("#submitForm"); if (btn) btn.disabled = false;
  }
}

// ================================================================
// İSTEK SETLERİ (kurumsal, ortak)
// ================================================================
function renderSetlerPage() {
  const uzmanlikList = Array.from(new Set(ISTEK_SETLERI.map((s) => s.uzmanlik).filter(Boolean))).sort();
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>İstek Setleri</h1>
      <div class="sub">Kurumsal hazır setler — bir karta dokunup doğrudan istek ver.</div>
      <div class="spacer"></div>
      <button class="btn-primary btn-sm" id="newSetBtn">+ Yeni Set</button>
    </div>
    <div class="setpage">
      <div class="setfilter" id="setFilter">
        <p class="flabel">Uzmanlık Alanı</p>
        <button class="fchip ${setFilterUzmanlik === "all" ? "on" : ""}" data-uz="all">Tümü</button>
        ${uzmanlikList.map((u) => `<button class="fchip ${setFilterUzmanlik === u ? "on" : ""}" data-uz="${esc(u)}">${esc(u)}</button>`).join("")}
        <p class="flabel">Tip</p>
        <button class="fchip ${setFilterGrup === "all" ? "on" : ""}" data-gr="all">Tümü</button>
        ${GROUPS.map(([k, l]) => `<button class="fchip ${setFilterGrup === k ? "on" : ""}" data-gr="${k}">${l}</button>`).join("")}
      </div>
      <div class="tilegrid" id="setGrid"></div>
    </div>`;

  $("#setFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.uz !== undefined) setFilterUzmanlik = b.dataset.uz;
    if (b.dataset.gr !== undefined) setFilterGrup = b.dataset.gr;
    renderSetlerPage();
  });
  $("#newSetBtn").onclick = () => showSetForm(null);

  renderSetGrid();
}

function renderSetGrid() {
  const grid = $("#setGrid"); if (!grid) return;
  const list = ISTEK_SETLERI.filter((s) =>
    (setFilterGrup === "all" || s.grup === setFilterGrup) &&
    (setFilterUzmanlik === "all" || s.uzmanlik === setFilterUzmanlik)
  );
  if (!list.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="t">Set bulunamadı</div><div class="d">Filtreyi değiştirin.</div></div>`;
    return;
  }
  grid.innerHTML = list.map((s) => `
    <div class="tile" data-id="${s.id}">
      <div class="nm">${esc(s.ad)} ${!s.aktif ? '<span class="status pasif" style="margin-left:6px">Pasif</span>' : ""}</div>
      <div class="meta">${TIP[s.grup] || "Diğer"}${s.uzmanlik ? " · " + esc(s.uzmanlik) : ""}</div>
      <div class="chips">${s.testler.length ? s.testler.map((t) => `<span class="chip">${esc(t.ad)}</span>`).join("") : '<span class="chip">—</span>'}</div>
      <div class="btnrow">${s.aktif ? `<button class="btn-primary" data-act="ver">İstek Ver</button>` : ""}<button class="btn-ghost" data-act="duzenle">Düzenle</button></div>
    </div>`).join("");
  grid.querySelectorAll(".tile").forEach((tile) => {
    const find = () => list.find((s) => s.id === tile.dataset.id);
    const verBtn = tile.querySelector('[data-act="ver"]');
    if (verBtn) verBtn.onclick = (e) => { e.stopPropagation(); showForm(find()); };
    tile.querySelector('[data-act="duzenle"]').onclick = (e) => { e.stopPropagation(); showSetForm(find()); };
  });
}

async function refreshIstekSetleri() {
  ISTEK_SETLERI = await Api.getIstekSetleri();
  SETS_INST = activeSetsInst(ISTEK_SETLERI);
}

function showSetForm(existing) {
  grp = existing ? existing.grup : "ihc";
  selectedTests = new Map(); customItems = [];
  if (existing) existing.testler.forEach((t) => {
    if (t.custom) customItems.push({ ad: t.ad, sel: true, grup: t.grup });
    else selectedTests.set(t.id, { ad: t.ad, klon: t.klon, grup: t.grup });
  });

  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>${existing ? "Seti Düzenle" : "Yeni Set"}</h2><button class="rx" id="closeSet">×</button></div>
    <div class="rail-body">
      <div class="m-sec"><p class="m-label">Ad</p><input class="finput" id="setAd" value="${existing ? esc(existing.ad) : ""}" placeholder="ör. Meme IHC Temel"></div>
      <div class="m-sec"><p class="m-label">Uzmanlık Alanı <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— opsiyonel, filtrede kullanılır</span></p><input class="finput" id="setUzmanlik" value="${existing && existing.uzmanlik ? esc(existing.uzmanlik) : ""}" placeholder="ör. Meme"></div>
      ${pickerSectionsHTML({ withQuickFill: false })}
    </div>
    <div class="rail-foot">
      ${existing ? `<button class="btn-ghost" id="delSet">Sil</button><button class="btn-danger" id="toggleSetAktif">${existing.aktif ? "Pasifleştir" : "Aktifleştir"}</button>` : `<button class="btn-ghost" id="cancelSet">İptal</button>`}
      <button class="btn-primary" id="saveSet">${existing ? "Kaydet" : "Oluştur"}</button>
    </div>`;

  $("#closeSet").onclick = showEmpty;
  if (existing) {
    $("#toggleSetAktif").onclick = async () => {
      try {
        await Api.setIstekSetiAktif(existing.id, !existing.aktif);
        toast(existing.aktif ? "Set pasifleştirildi" : "Set aktifleştirildi");
        await refreshIstekSetleri();
        showEmpty();
        if (currentPage === "setler") renderSetlerPage();
      } catch (e) { toast("Güncellenemedi", true); }
    };
    $("#delSet").onclick = () => confirmAndDelete(existing.ad, () => Api.deleteIstekSeti(existing.id), async () => {
      toast("Set silindi");
      await refreshIstekSetleri();
      showEmpty();
      if (currentPage === "setler") renderSetlerPage();
    });
  } else {
    $("#cancelSet").onclick = showEmpty;
  }

  $$("#groups button").forEach((b) => b.classList.toggle("on", b.dataset.g === grp));
  bindPicker(false);

  $("#saveSet").onclick = async () => {
    const ad = $("#setAd").value.trim();
    if (!ad) { toast("Ad girin", true); return; }
    const uzmanlik = $("#setUzmanlik").value.trim();
    const testler = collectPickedTestler();
    if (!testler.length) { toast("En az bir test seçin", true); return; }
    $("#saveSet").disabled = true;
    try {
      if (existing) await Api.updateIstekSeti(existing.id, { ad, grup: grp, uzmanlik, testler });
      else await Api.createIstekSeti({ grup: grp, ad, uzmanlik, testler });
      toast(existing ? "Set güncellendi" : "Set oluşturuldu");
      await refreshIstekSetleri();
      showEmpty();
      if (currentPage === "setler") renderSetlerPage();
    } catch (e) {
      toast("Kaydedilemedi", true);
    } finally {
      const btn = $("#saveSet"); if (btn) btn.disabled = false;
    }
  };
}

// ================================================================
// ŞABLONLAR (kişiye özel)
// ================================================================
function renderSablonlarPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Şablonlarım</h1>
      <div class="sub">Kişiye özel test kombinasyonların — Yeni İstek formunda hızlıca kullanılır.</div>
      <div class="spacer"></div>
      <button class="btn-primary btn-sm" id="newSablonBtn">+ Yeni Şablon</button>
    </div>
    <div class="tilegrid" id="sablonGrid"></div>`;
  $("#newSablonBtn").onclick = () => showSablonForm(null);
  renderSablonGrid();
}

function renderSablonGrid() {
  const grid = $("#sablonGrid"); if (!grid) return;
  if (!MY_SABLONLAR.length) {
    grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="t">Henüz şablonun yok</div><div class="d">"+ Yeni Şablon" ile ilk kombinasyonunu oluştur.</div></div>`;
    return;
  }
  grid.innerHTML = MY_SABLONLAR.map((s) => `
    <div class="tile" data-id="${s.id}">
      <div class="nm">${esc(s.ad)}</div>
      <div class="meta">${TIP[s.grup] || "Diğer"}</div>
      <div class="chips">${s.testler.length ? s.testler.map((t) => `<span class="chip">${esc(t.ad)}</span>`).join("") : '<span class="chip">—</span>'}</div>
      <button class="btn-ghost">Düzenle</button>
    </div>`).join("");
  grid.querySelectorAll(".tile").forEach((tile) => {
    const find = () => MY_SABLONLAR.find((s) => s.id === tile.dataset.id);
    tile.querySelector("button").onclick = (e) => { e.stopPropagation(); showSablonForm(find()); };
    tile.onclick = () => showSablonForm(find());
  });
}

function showSablonForm(existing) {
  grp = existing ? existing.grup : "ihc";
  selectedTests = new Map(); customItems = [];
  if (existing) existing.testler.forEach((t) => {
    if (t.custom) customItems.push({ ad: t.ad, sel: true, grup: t.grup });
    else selectedTests.set(t.id, { ad: t.ad, klon: t.klon, grup: t.grup });
  });

  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>${existing ? "Şablonu Düzenle" : "Yeni Şablon"}</h2><button class="rx" id="closeSablon">×</button></div>
    <div class="rail-body">
      <div class="m-sec"><p class="m-label">Ad</p><input class="finput" id="sablonAd" value="${existing ? esc(existing.ad) : ""}" placeholder="ör. fd meme 1"></div>
      ${pickerSectionsHTML({ withQuickFill: false })}
    </div>
    <div class="rail-foot">
      ${existing ? `<button class="btn-danger" id="delSablon">Sil</button>` : `<button class="btn-ghost" id="cancelSablon">İptal</button>`}
      <button class="btn-primary" id="saveSablon">${existing ? "Kaydet" : "Oluştur"}</button>
    </div>`;

  $("#closeSablon").onclick = showEmpty;
  if (existing) $("#delSablon").onclick = () => deleteSablonFlow(existing.id);
  else $("#cancelSablon").onclick = showEmpty;

  $$("#groups button").forEach((b) => b.classList.toggle("on", b.dataset.g === grp));
  bindPicker(false);

  $("#saveSablon").onclick = async () => {
    const ad = $("#sablonAd").value.trim();
    if (!ad) { toast("Ad girin", true); return; }
    const testler = collectPickedTestler();
    if (!testler.length) { toast("En az bir test seçin", true); return; }
    $("#saveSablon").disabled = true;
    try {
      if (existing) await Api.updateSablon(existing.id, { ad, grup: grp, testler });
      else await Api.createSablon({ sahip_id: session.id, grup: grp, ad, testler });
      toast(existing ? "Şablon güncellendi" : "Şablon oluşturuldu");
      await refreshMySablonlar();
      showEmpty();
      if (currentPage === "sablonlar") renderSablonlarPage();
    } catch (e) {
      toast("Kaydedilemedi", true);
    } finally {
      const btn = $("#saveSablon"); if (btn) btn.disabled = false;
    }
  };
}

async function deleteSablonFlow(id) {
  try {
    await Api.deleteSablon(id);
    toast("Şablon silindi");
    await refreshMySablonlar();
    showEmpty();
    if (currentPage === "sablonlar") renderSablonlarPage();
  } catch (e) {
    toast("Silinemedi", true);
  }
}

// ================================================================
// CİHAZLAR
// ================================================================
function renderCihazlarPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Cihazlar</h1>
      <div class="sub">İstek kalemlerine atanabilecek cihazlar.</div>
      <div class="spacer"></div>
      <button class="btn-primary btn-sm" id="newCihazBtn">+ Yeni Cihaz</button>
    </div>
    <div class="devlist" id="devList"></div>`;
  $("#newCihazBtn").onclick = () => showCihazForm(null);
  renderDevList();
}

function renderDevList() {
  const wrap = $("#devList"); if (!wrap) return;
  if (!CIHAZLAR.length) {
    wrap.innerHTML = `<div class="empty"><div class="t">Henüz cihaz yok</div><div class="d">"+ Yeni Cihaz" ile ekleyin.</div></div>`;
    return;
  }
  wrap.innerHTML = CIHAZLAR.map((c) => `
    <div class="devrow" data-id="${c.id}">
      <div><div class="nm">${esc(c.ad)}</div>${c.tip ? `<div class="tip">${esc(c.tip)}</div>` : ""}</div>
      <div class="grow"></div>
      <span class="status ${c.aktif ? "aktif" : "pasif"}">${c.aktif ? "Aktif" : "Pasif"}</span>
    </div>`).join("");
  wrap.querySelectorAll(".devrow").forEach((row) => {
    row.onclick = () => showCihazForm(CIHAZLAR.find((c) => c.id === row.dataset.id));
  });
}

function showCihazForm(existing) {
  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>${existing ? "Cihazı Düzenle" : "Yeni Cihaz"}</h2><button class="rx" id="closeCihaz">×</button></div>
    <div class="rail-body">
      <div class="m-sec"><p class="m-label">Ad</p><input class="finput" id="cihazAd" value="${existing ? esc(existing.ad) : ""}" placeholder="ör. Ventana BenchMark ULTRA"></div>
      <div class="m-sec"><p class="m-label">Tip</p><input class="finput" id="cihazTip" value="${existing && existing.tip ? esc(existing.tip) : ""}" placeholder="ör. IHC boyayıcı"></div>
    </div>
    <div class="rail-foot">
      ${existing ? `<button class="btn-ghost" id="delCihaz">Sil</button><button class="btn-danger" id="toggleAktif">${existing.aktif ? "Pasifleştir" : "Aktifleştir"}</button>` : `<button class="btn-ghost" id="cancelCihaz">İptal</button>`}
      <button class="btn-primary" id="saveCihaz">${existing ? "Kaydet" : "Ekle"}</button>
    </div>`;

  $("#closeCihaz").onclick = showEmpty;
  if (existing) {
    $("#toggleAktif").onclick = async () => {
      try {
        await Api.setCihazAktif(existing.id, !existing.aktif);
        toast(existing.aktif ? "Cihaz pasifleştirildi" : "Cihaz aktifleştirildi");
        CIHAZLAR = await Api.getCihazlar();
        showEmpty();
        if (currentPage === "cihazlar") renderCihazlarPage();
      } catch (e) { toast("Güncellenemedi", true); }
    };
    $("#delCihaz").onclick = () => confirmAndDelete(existing.ad, () => Api.deleteCihaz(existing.id), async () => {
      toast("Cihaz silindi");
      CIHAZLAR = await Api.getCihazlar();
      showEmpty();
      if (currentPage === "cihazlar") renderCihazlarPage();
    });
  } else {
    $("#cancelCihaz").onclick = showEmpty;
  }

  $("#saveCihaz").onclick = async () => {
    const ad = $("#cihazAd").value.trim();
    if (!ad) { toast("Ad girin", true); return; }
    const tip = $("#cihazTip").value.trim();
    $("#saveCihaz").disabled = true;
    try {
      if (existing) await Api.updateCihaz(existing.id, { ad, tip });
      else await Api.createCihaz({ ad, tip });
      toast(existing ? "Cihaz güncellendi" : "Cihaz eklendi");
      CIHAZLAR = await Api.getCihazlar();
      showEmpty();
      if (currentPage === "cihazlar") renderCihazlarPage();
    } catch (e) {
      toast("Kaydedilemedi", true);
    } finally {
      const btn = $("#saveCihaz"); if (btn) btn.disabled = false;
    }
  };
}

// ================================================================
// HİZMETLER (faturalama — laboratuvar iş akışından bağımsız)
// ================================================================
let hizmetlerList = [];
let hizColFilters = { pat: "", isteyen: "", uzman: "", ozet: "" };
let hizSortCol = null, hizSortDir = "asc";
const HIZ_SORT_FIELD = { pat: "patoloji_no", isteyen: "isteyen_adi", uzman: "uzman_adi" };

function hizOzetTxt(h) {
  return h.ozet.length ? h.ozet.map((o) => `${o.count} ${TIP[o.grup] || "Diğer"}`).join(", ") : "—";
}
function hizHasActiveFilters() {
  return Boolean(hizColFilters.pat || hizColFilters.isteyen || hizColFilters.uzman || hizColFilters.ozet);
}
function hizClearFilters() {
  hizColFilters = { pat: "", isteyen: "", uzman: "", ozet: "" };
  renderHizTable();
}
function hizPassesFilter(h) {
  if (hizColFilters.pat && !h.patoloji_no.toLowerCase().includes(hizColFilters.pat)) return false;
  if (hizColFilters.isteyen && !(h.isteyen_adi || "").toLowerCase().includes(hizColFilters.isteyen)) return false;
  if (hizColFilters.uzman && !(h.uzman_adi || "").toLowerCase().includes(hizColFilters.uzman)) return false;
  if (hizColFilters.ozet && !hizOzetTxt(h).toLowerCase().includes(hizColFilters.ozet)) return false;
  return true;
}
function hizCompareForSort(a, b, col) {
  const field = HIZ_SORT_FIELD[col];
  return String(a[field] ?? "").localeCompare(String(b[field] ?? ""), "tr", { numeric: true });
}
// Excel export'unun "Görünenler" seçeneği ve renderHizTable bunu kullanır.
function getVisibleHizmetler() {
  let list = hizmetlerList.filter(hizPassesFilter);
  if (hizSortCol) {
    const dir = hizSortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => hizCompareForSort(a, b, hizSortCol) * dir);
  }
  return list;
}

const HIZMETLER_EXPORT_COLS = [
  { label: "Patoloji No", value: (h) => h.patoloji_no },
  { label: "İsteyen", value: (h) => h.isteyen_adi || "" },
  { label: "Uzman Adına", value: (h) => h.uzman_adi || "" },
  { label: "Özet", value: (h) => h.ozet.map((o) => `${o.count} ${TIP[o.grup] || "Diğer"}`).join(", ") },
  { label: "Tarih", value: (h) => formatDT(h.created_at) },
  { label: "Fatura Durumu", value: (h) => (h.fatura_girildi ? "Girildi" : "Girilmedi") },
  { label: "Fatura Giren", value: (h) => h.fatura_giren_adi || "" },
  { label: "Fatura Zamanı", value: (h) => (h.fatura_zamani ? formatDT(h.fatura_zamani) : "") },
];

function renderHizmetlerPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Hizmetler</h1>
      <div class="sub">Faturalama özeti — her satır bir "İstek Ver" işlemini (istemler kaydını) temsil eder.</div>
      <div class="spacer"></div>
      <button class="btn-ghost btn-sm hidden" id="hizClearFiltersBtn">Filtreleri Temizle</button>
      <div id="hizExport">${EXPORT_MENU_HTML}</div>
    </div>
    <div class="tablewrap">
      <table>
        <thead id="hizhead"></thead>
        <tbody id="hizRows"></tbody>
      </table>
    </div>`;

  bindExportMenu("#hizExport", (which) => {
    const list = which === "tum" ? hizmetlerList : getVisibleHizmetler();
    exportToExcel(list, HIZMETLER_EXPORT_COLS, "istem_hizmetler");
  });
  $("#hizClearFiltersBtn").addEventListener("click", hizClearFilters);
  $("#hizRows").addEventListener("click", (e) => {
    const patCell = e.target.closest("[data-pat]");
    if (patCell) {
      const patNo = patCell.dataset.pat;
      navigate("kuyruk");
      openCaseView(patNo);
      return;
    }
    const btn = e.target.closest("[data-hiz]");
    if (btn) markFatura(btn.dataset.hiz);
  });
  $("#hizhead").addEventListener("click", (e) => {
    const caret = e.target.closest("[data-thopen]");
    if (caret) {
      e.stopPropagation();
      const panel = $(`[data-thpanel="${caret.dataset.thopen}"]`);
      const isOpen = panel.classList.contains("open");
      $$(".thfilter.open").forEach((p) => p.classList.remove("open"));
      if (!isOpen) {
        panel.classList.add("open");
        panel.querySelector("[data-thsearch]")?.focus();
      }
      return;
    }
    const label = e.target.closest("[data-sortcol]");
    if (label) {
      const key = label.dataset.sortcol;
      if (hizSortCol === key) hizSortDir = hizSortDir === "asc" ? "desc" : "asc";
      else { hizSortCol = key; hizSortDir = "asc"; }
      renderHizTable();
    }
  });
  $("#hizhead").addEventListener("input", (e) => {
    const inp = e.target.closest("[data-thsearch]");
    if (!inp) return;
    hizColFilters[inp.dataset.thsearch] = inp.value.toLowerCase();
    renderHizTable();
  });

  loadHizmetler();
}

async function loadHizmetler() {
  try {
    hizmetlerList = await Api.getHizmetler();
  } catch (e) {
    toast("Hizmetler yüklenemedi — hizmetler_sema.sql çalıştırıldı mı?", true);
    hizmetlerList = [];
  }
  if (currentPage !== "hizmetler") return;
  renderHizTable();
}

function renderHizHead() {
  const head = $("#hizhead");
  if (!head) return;

  // İş Kuyruğu'ndaki renderQHead ile aynı odak/panel koruma deseni — bkz.
  // oradaki yorum.
  const openKey = head.querySelector(".thfilter.open")?.dataset.thpanel;
  const active = document.activeElement;
  const focusKey = active?.matches("[data-thsearch]") ? active.dataset.thsearch : null;
  const selStart = focusKey ? active.selectionStart : null;
  const selEnd = focusKey ? active.selectionEnd : null;

  const sortOf = (key) => ({ active: hizSortCol === key, dir: hizSortDir });
  head.innerHTML = `<tr>
    ${thTextFilter("pat", "Patoloji No", hizColFilters.pat, sortOf("pat"))}
    ${thTextFilter("isteyen", "İsteyen", hizColFilters.isteyen, sortOf("isteyen"))}
    ${thTextFilter("uzman", "Uzman Adına", hizColFilters.uzman, sortOf("uzman"))}
    ${thTextFilter("ozet", "Özet", hizColFilters.ozet, null)}
    <th>Tarih</th>
    <th>Aksiyon</th>
  </tr>`;

  if (openKey) head.querySelector(`[data-thpanel="${openKey}"]`)?.classList.add("open");
  if (focusKey) {
    const input = head.querySelector(`[data-thsearch="${focusKey}"]`);
    if (input) { input.focus(); input.setSelectionRange(selStart, selEnd); }
  }
}

function renderHizTable() {
  renderHizHead();
  const tb = $("#hizRows");
  if (!tb) return;
  tb.innerHTML = "";
  getVisibleHizmetler().forEach((h) => {
    const tr = document.createElement("tr");
    const act = h.fatura_girildi
      ? `<span style="color:var(--ink-3);font-size:12px">✓ ${esc(h.fatura_giren_adi || "—")} · ${formatDT(h.fatura_zamani)}</span>`
      : `<button class="act" data-hiz="${h.istem_id}">Gir</button>`;
    tr.innerHTML = `<td class="c-pat" data-pat="${esc(h.patoloji_no)}" style="cursor:pointer">${esc(h.patoloji_no)}</td>
      <td>${esc(h.isteyen_adi)}</td>
      <td>${esc(h.uzman_adi || "—")}</td>
      <td>${esc(hizOzetTxt(h))}</td>
      <td style="color:var(--ink-3);font-size:12px">${formatDT(h.created_at)}</td>
      <td>${act}</td>`;
    tb.appendChild(tr);
  });
  $("#hizClearFiltersBtn")?.classList.toggle("hidden", !hizHasActiveFilters());
}

async function markFatura(istemId) {
  try {
    await Api.markFaturaGirildi(istemId, session.id);
    toast("Fatura girildi olarak işaretlendi");
    await loadHizmetler();
  } catch (e) {
    toast("İşaretlenemedi", true);
  }
}

// ================================================================
// KULLANICILAR (yönetim)
// ================================================================
let KULLANICILAR_LIST = [];

function renderKullanicilarPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Kullanıcılar</h1>
      <div class="sub">Sistemdeki tüm kullanıcılar.</div>
      <div class="spacer"></div>
      <button class="btn-ghost btn-sm hidden" id="migrateAuthBtn">Auth hesabı olmayanları taşı</button>
      <button class="btn-primary btn-sm" id="newKullaniciBtn">+ Yeni Kullanıcı</button>
    </div>
    <div class="devlist" id="kullaniciList"></div>`;
  $("#newKullaniciBtn").onclick = () => showKullaniciForm(null);
  $("#migrateAuthBtn").onclick = bulkMigrateUsersToAuth;
  loadKullanicilar();
}

async function loadKullanicilar() {
  try {
    KULLANICILAR_LIST = await Api.getAllKullanicilar();
  } catch (e) {
    toast("Kullanıcılar yüklenemedi", true);
    KULLANICILAR_LIST = [];
  }
  if (currentPage !== "kullanicilar") return;
  renderKullaniciList();
}

function renderKullaniciList() {
  const wrap = $("#kullaniciList"); if (!wrap) return;
  const missingBtn = $("#migrateAuthBtn");
  const missingCount = KULLANICILAR_LIST.filter((u) => !u.auth_user_id).length;
  if (missingBtn) {
    missingBtn.classList.toggle("hidden", missingCount === 0);
    missingBtn.textContent = `Auth hesabı olmayanları taşı (${missingCount})`;
  }
  if (!KULLANICILAR_LIST.length) {
    wrap.innerHTML = `<div class="empty"><div class="t">Henüz kullanıcı yok</div><div class="d">"+ Yeni Kullanıcı" ile ekleyin.</div></div>`;
    return;
  }
  wrap.innerHTML = KULLANICILAR_LIST.map((u) => `
    <div class="devrow" data-id="${u.id}">
      <div><div class="nm">${esc(u.ad_soyad)}</div><div class="tip">${esc(ROL_LABEL[u.rol] || u.rol)}${!u.auth_user_id ? " · Auth hesabı yok" : ""}</div></div>
      <div class="grow"></div>
      <span class="status ${u.aktif ? "aktif" : "pasif"}">${u.aktif ? "Aktif" : "Pasif"}</span>
    </div>`).join("");
  wrap.querySelectorAll(".devrow").forEach((row) => {
    row.onclick = () => showKullaniciForm(KULLANICILAR_LIST.find((u) => u.id === row.dataset.id));
  });
}

async function bulkMigrateUsersToAuth() {
  const targets = KULLANICILAR_LIST.filter((u) => !u.auth_user_id);
  if (!targets.length) return;
  const btn = $("#migrateAuthBtn");
  btn.disabled = true;
  let ok = 0, fail = 0;
  for (const row of targets) {
    try {
      await Api.migrateKullaniciToAuth(row);
      ok++;
    } catch (e) {
      fail++;
    }
    // Supabase signUp rate-limit'ine takılmamak için küçük bir ara.
    await new Promise((r) => setTimeout(r, 350));
  }
  toast(fail ? `${ok} taşındı, ${fail} başarısız` : `${ok} kullanıcı Auth'a taşındı`, fail > 0);
  await loadKullanicilar();
  btn.disabled = false;
}

function showKullaniciForm(existing) {
  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>${existing ? "Kullanıcıyı Düzenle" : "Yeni Kullanıcı"}</h2><button class="rx" id="closeKullanici">×</button></div>
    <div class="rail-body">
      <div class="m-sec"><p class="m-label">Ad Soyad</p><input class="finput" id="kAd" value="${existing ? esc(existing.ad_soyad) : ""}" placeholder="ör. Dr. A. Yılmaz"></div>
      <div class="m-sec"><p class="m-label">Rol</p>
        <select class="finput" id="kRol">
          <option value="uzman" ${existing && existing.rol === "uzman" ? "selected" : ""}>Uzman Patolog</option>
          <option value="asistan" ${existing && existing.rol === "asistan" ? "selected" : ""}>Asistan</option>
          <option value="teknisyen" ${existing && existing.rol === "teknisyen" ? "selected" : ""}>Teknisyen</option>
        </select></div>
      ${existing
        ? `<div class="m-sec"><p class="m-label">PIN <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— değiştirilemez</span></p><div class="v" style="font-size:13px;color:var(--ink-3)">${existing.auth_user_id ? "Supabase Auth üzerinden yönetiliyor" : "Auth hesabı yok — \"Auth hesabı olmayanları taşı\" ile oluşturulur"}</div></div>`
        : `<div class="m-sec"><p class="m-label">PIN <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— Auth hesabının şifresi olacak</span></p><input class="finput" id="kPin" placeholder="ör. 1234" inputmode="numeric" maxlength="6"></div>`}
    </div>
    <div class="rail-foot">
      ${existing ? `<button class="btn-ghost" id="delKullanici">Sil</button><button class="btn-danger" id="toggleKullaniciAktif">${existing.aktif ? "Pasifleştir" : "Aktifleştir"}</button>` : `<button class="btn-ghost" id="cancelKullanici">İptal</button>`}
      <button class="btn-primary" id="saveKullanici">${existing ? "Kaydet" : "Ekle"}</button>
    </div>`;

  $("#closeKullanici").onclick = showEmpty;
  if (existing) {
    $("#toggleKullaniciAktif").onclick = async () => {
      try {
        await Api.setKullaniciAktif(existing.id, !existing.aktif);
        toast(existing.aktif ? "Kullanıcı pasifleştirildi" : "Kullanıcı aktifleştirildi");
        UZMANLAR = await Api.getUzmanlar();
        await loadKullanicilar();
        showEmpty();
      } catch (e) { toast("Güncellenemedi", true); }
    };
    $("#delKullanici").onclick = () => confirmAndDelete(existing.ad_soyad, () => Api.deleteKullanici(existing.id), async () => {
      toast(existing.auth_user_id ? "Kullanıcı silindi — Auth hesabı dashboard'dan elle temizlenebilir (isteğe bağlı)" : "Kullanıcı silindi");
      UZMANLAR = await Api.getUzmanlar();
      await loadKullanicilar();
      showEmpty();
    });
  } else {
    $("#cancelKullanici").onclick = showEmpty;
  }

  $("#saveKullanici").onclick = async () => {
    const ad_soyad = $("#kAd").value.trim();
    if (!ad_soyad) { toast("Ad soyad girin", true); return; }
    const rol = $("#kRol").value;
    $("#saveKullanici").disabled = true;
    try {
      if (existing) {
        await Api.updateKullanici(existing.id, { ad_soyad, rol });
      } else {
        const pin = $("#kPin").value.trim();
        if (!pin) { toast("PIN girin", true); $("#saveKullanici").disabled = false; return; }
        await Api.createKullanici({ ad_soyad, rol, pin });
      }
      toast(existing ? "Kullanıcı güncellendi" : "Kullanıcı eklendi");
      UZMANLAR = await Api.getUzmanlar();
      await loadKullanicilar();
      showEmpty();
    } catch (e) {
      toast("Kaydedilemedi", true);
    } finally {
      const btn = $("#saveKullanici"); if (btn) btn.disabled = false;
    }
  };
}

// ================================================================
// TEST KATALOĞU (yönetim)
// ================================================================
let tkGrup = null;
let tkList = [];

function renderTestKatalogPage() {
  if (!tkGrup || !GROUPS.some(([k]) => k === tkGrup)) tkGrup = (GROUPS[0] && GROUPS[0][0]) || null;
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Test Kataloğu</h1>
      <div class="sub">Antikor/test kataloğu — gruplar "Test Grupları" sayfasından yönetilir.</div>
      <div class="spacer"></div>
      <button class="btn-ghost btn-sm" id="bulkTestBtn">Toplu Ekle</button>
      <button class="btn-primary btn-sm" id="newTestBtn">+ Yeni Test</button>
    </div>
    <div style="padding:14px 26px 6px"><div class="groups" id="tkGroups"></div></div>
    <div class="devlist" id="tkList"></div>`;

  renderTkGroups();
  $("#newTestBtn").onclick = () => { if (tkGrup) showTestKatalogForm(tkGrup, null); else toast("Önce bir grup seçin/oluşturun", true); };
  $("#bulkTestBtn").onclick = () => showTestKatalogBulkForm(tkGrup);
  loadTkList();
}

function renderTkGroups() {
  const wrap = $("#tkGroups"); if (!wrap) return;
  wrap.innerHTML = GROUPS.map(([k, l]) => `<button class="${k === tkGrup ? "on" : ""}" data-grup="${k}">${esc(l)}</button>`).join("");
  wrap.querySelectorAll("button").forEach((b) => {
    b.onclick = () => { tkGrup = b.dataset.grup; renderTkGroups(); loadTkList(); };
  });
}

async function loadTkList() {
  if (!tkGrup) { tkList = []; renderTkList(); return; }
  try {
    tkList = await Api.getTestKatalogByGrup(tkGrup);
  } catch (e) {
    toast("Test kataloğu yüklenemedi", true);
    tkList = [];
  }
  if (currentPage !== "test-katalogu") return;
  renderTkList();
}

function renderTkList() {
  const wrap = $("#tkList"); if (!wrap) return;
  if (!tkList.length) {
    wrap.innerHTML = `<div class="empty"><div class="t">Bu grupta test yok</div><div class="d">"+ Yeni Test" ile ekleyin.</div></div>`;
    return;
  }
  wrap.innerHTML = tkList.map((t) => `
    <div class="devrow" data-id="${t.id}">
      <div><div class="nm">${esc(t.ad)}</div>${t.klon ? `<div class="tip">Klon ${esc(t.klon)}</div>` : ""}</div>
      <div class="grow"></div>
      <span class="status ${t.aktif ? "aktif" : "pasif"}">${t.aktif ? "Aktif" : "Pasif"}</span>
    </div>`).join("");
  wrap.querySelectorAll(".devrow").forEach((row) => {
    row.onclick = () => showTestKatalogForm(tkGrup, tkList.find((t) => t.id === row.dataset.id));
  });
}

// ================================================================
// TEST GRUPLARI (yönetim)
// ================================================================
let TEST_GRUPLARI_LIST = [];

function renderTestGruplariPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Test Grupları</h1>
      <div class="sub">Üst gruplar — Test Kataloğu'ndaki grup sekmelerinin kaynağı.</div>
      <div class="spacer"></div>
      <button class="btn-primary btn-sm" id="newGrupBtn">+ Yeni Grup</button>
    </div>
    <div class="devlist" id="tgList"></div>`;
  $("#newGrupBtn").onclick = () => showTestGrubuForm(null);
  loadTestGruplariList();
}

async function loadTestGruplariList() {
  try {
    TEST_GRUPLARI_LIST = await Api.getAllTestGruplari();
  } catch (e) {
    toast("Test grupları yüklenemedi", true);
    TEST_GRUPLARI_LIST = [];
  }
  if (currentPage !== "test-gruplari") return;
  renderTgList();
}

function renderTgList() {
  const wrap = $("#tgList"); if (!wrap) return;
  if (!TEST_GRUPLARI_LIST.length) {
    wrap.innerHTML = `<div class="empty"><div class="t">Henüz grup yok</div><div class="d">"+ Yeni Grup" ile ekleyin.</div></div>`;
    return;
  }
  wrap.innerHTML = TEST_GRUPLARI_LIST.map((g) => `
    <div class="devrow" data-id="${g.id}">
      <div><div class="nm">${esc(g.ad)}</div><div class="tip">${esc(g.kod)} · sıra ${g.sira}</div></div>
      <div class="grow"></div>
      <span class="status ${g.aktif ? "aktif" : "pasif"}">${g.aktif ? "Aktif" : "Pasif"}</span>
    </div>`).join("");
  wrap.querySelectorAll(".devrow").forEach((row) => {
    row.onclick = () => showTestGrubuForm(TEST_GRUPLARI_LIST.find((g) => g.id === row.dataset.id));
  });
}

function showTestGrubuForm(existing) {
  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>${existing ? "Grubu Düzenle" : "Yeni Grup"}</h2><button class="rx" id="closeGrup">×</button></div>
    <div class="rail-body">
      ${existing
        ? `<div class="m-sec"><p class="m-label">Kod</p><div class="v" style="font-size:13px">${esc(existing.kod)}</div></div>`
        : `<div class="m-sec"><p class="m-label">Kod <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— küçük harf, boşluksuz</span></p><input class="finput" id="gKod" placeholder="ör. fish"></div>`}
      <div class="m-sec"><p class="m-label">Ad</p><input class="finput" id="gAd" value="${existing ? esc(existing.ad) : ""}" placeholder="ör. FISH"></div>
      <div class="m-sec"><p class="m-label">Sıra</p><input class="finput" id="gSira" type="number" value="${existing ? existing.sira : 80}"></div>
    </div>
    <div class="rail-foot">
      ${existing ? `<button class="btn-ghost" id="delGrup">Sil</button><button class="btn-danger" id="toggleGrupAktif">${existing.aktif ? "Pasifleştir" : "Aktifleştir"}</button>` : `<button class="btn-ghost" id="cancelGrup">İptal</button>`}
      <button class="btn-primary" id="saveGrup">${existing ? "Kaydet" : "Oluştur"}</button>
    </div>`;

  $("#closeGrup").onclick = showEmpty;
  if (existing) {
    $("#toggleGrupAktif").onclick = async () => {
      try {
        await Api.setTestGrubuAktif(existing.id, !existing.aktif);
        toast(existing.aktif ? "Grup pasifleştirildi" : "Grup aktifleştirildi");
        await refreshGruplar();
        await loadTestGruplariList();
        showEmpty();
      } catch (e) { toast("Güncellenemedi", true); }
    };
    $("#delGrup").onclick = () => confirmAndDelete(existing.ad, () => Api.deleteTestGrubu(existing.id), async () => {
      toast("Grup silindi");
      await refreshGruplar();
      await loadTestGruplariList();
      showEmpty();
    });
  } else {
    $("#cancelGrup").onclick = showEmpty;
  }

  $("#saveGrup").onclick = async () => {
    const ad = $("#gAd").value.trim();
    if (!ad) { toast("Ad girin", true); return; }
    const sira = Number($("#gSira").value) || 0;
    $("#saveGrup").disabled = true;
    try {
      if (existing) {
        await Api.updateTestGrubu(existing.id, { ad, sira });
      } else {
        const kod = $("#gKod").value.trim().toLowerCase();
        if (!kod) { toast("Kod girin", true); $("#saveGrup").disabled = false; return; }
        await Api.createTestGrubu({ kod, ad, sira });
      }
      await refreshGruplar();
      toast(existing ? "Grup güncellendi" : "Grup oluşturuldu");
      await loadTestGruplariList();
      showEmpty();
    } catch (e) {
      toast(existing ? "Kaydedilemedi" : "Oluşturulamadı (kod zaten var olabilir)", true);
    } finally {
      const btn = $("#saveGrup"); if (btn) btn.disabled = false;
    }
  };
}

function showTestKatalogForm(grup, existing) {
  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>${existing ? "Testi Düzenle" : "Yeni Test"}</h2><button class="rx" id="closeTk">×</button></div>
    <div class="rail-body">
      <div class="m-sec"><p class="m-label">Grup</p><div class="v" style="font-size:13px">${esc(TIP[grup] || grup)}</div></div>
      <div class="m-sec"><p class="m-label">Ad</p><input class="finput" id="tkAd" value="${existing ? esc(existing.ad) : ""}" placeholder="ör. ER"></div>
      <div class="m-sec"><p class="m-label">Klon <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— opsiyonel</span></p><input class="finput" id="tkKlon" value="${existing && existing.klon ? esc(existing.klon) : ""}" placeholder="ör. SP1"></div>
      <div class="m-sec"><p class="m-label">Sıra</p><input class="finput" id="tkSira" type="number" value="${existing ? existing.sira : 0}"></div>
    </div>
    <div class="rail-foot">
      ${existing ? `<button class="btn-ghost" id="delTk">Sil</button><button class="btn-danger" id="toggleTkAktif">${existing.aktif ? "Pasifleştir" : "Aktifleştir"}</button>` : `<button class="btn-ghost" id="cancelTk">İptal</button>`}
      <button class="btn-primary" id="saveTk">Kaydet</button>
    </div>`;

  $("#closeTk").onclick = showEmpty;
  if (existing) {
    $("#toggleTkAktif").onclick = async () => {
      try {
        await Api.setTestKatalogAktif(existing.id, !existing.aktif);
        toast(existing.aktif ? "Pasifleştirildi" : "Aktifleştirildi");
        CAT = await Api.getTestKatalog();
        await loadTkList();
        showEmpty();
      } catch (e) { toast("Güncellenemedi", true); }
    };
    $("#delTk").onclick = () => confirmAndDelete(existing.ad, () => Api.deleteTestKatalogEntry(existing.id), async () => {
      toast("Test silindi");
      CAT = await Api.getTestKatalog();
      await loadTkList();
      showEmpty();
    });
  } else {
    $("#cancelTk").onclick = showEmpty;
  }

  $("#saveTk").onclick = async () => {
    const ad = $("#tkAd").value.trim();
    if (!ad) { toast("Ad girin", true); return; }
    const klon = $("#tkKlon").value.trim();
    const sira = Number($("#tkSira").value) || 0;
    $("#saveTk").disabled = true;
    try {
      if (existing) await Api.updateTestKatalogEntry(existing.id, { ad, klon, sira });
      else await Api.createTestKatalogEntry({ grup, ad, klon, sira });
      toast(existing ? "Test güncellendi" : "Test eklendi");
      CAT = await Api.getTestKatalog();
      await loadTkList();
      showEmpty();
    } catch (e) {
      toast("Kaydedilemedi", true);
    } finally {
      const btn = $("#saveTk"); if (btn) btn.disabled = false;
    }
  };
}

// "İsim, Klon" satırlarını ayrıştırır — klon opsiyonel (virgül yoksa boş),
// boş satırlar yok sayılır.
function parseBulkLines(text) {
  return text.split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(",");
      const ad = (idx === -1 ? line : line.slice(0, idx)).trim();
      const klon = idx === -1 ? "" : line.slice(idx + 1).trim();
      return { ad, klon };
    })
    .filter((it) => it.ad);
}

function showTestKatalogBulkForm(defaultGrup) {
  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>Toplu Ekle</h2><button class="rx" id="closeBulkTk">×</button></div>
    <div class="rail-body">
      <div class="m-sec"><p class="m-label">Grup</p>
        <select class="finput" id="bulkGrup">${GROUPS.map(([k, l]) => `<option value="${k}" ${k === defaultGrup ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
      <div class="m-sec"><p class="m-label">Testler <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— her satır: İsim, Klon (klon opsiyonel)</span></p>
        <textarea id="bulkText" style="min-height:220px" placeholder="ER, SP1&#10;PR, BSB-2&#10;Ki-67"></textarea></div>
    </div>
    <div class="rail-foot"><button class="btn-ghost" id="cancelBulkTk">İptal</button><button class="btn-primary" id="saveBulkTk">Ekle</button></div>`;

  $("#closeBulkTk").onclick = showEmpty;
  $("#cancelBulkTk").onclick = showEmpty;
  $("#saveBulkTk").onclick = async () => {
    const grup = $("#bulkGrup").value;
    const items = parseBulkLines($("#bulkText").value);
    if (!items.length) { toast("Eklenecek satır yok", true); return; }
    $("#saveBulkTk").disabled = true;
    try {
      const existing = await Api.getTestKatalogByGrup(grup);
      const existingNames = new Set(existing.map((t) => t.ad.trim().toLowerCase()));
      const seen = new Set();
      const toInsert = [];
      let skipped = 0;
      items.forEach((it) => {
        const key = it.ad.toLowerCase();
        if (existingNames.has(key) || seen.has(key)) { skipped++; return; }
        seen.add(key);
        toInsert.push(it);
      });
      if (toInsert.length) await Api.bulkCreateTestKatalogEntries(grup, toInsert);
      toast(`${toInsert.length} eklendi, ${skipped} zaten vardı`);
      CAT = await Api.getTestKatalog();
      if (grup === tkGrup) await loadTkList();
      showEmpty();
    } catch (e) {
      toast("Toplu ekleme başarısız", true);
    } finally {
      const btn = $("#saveBulkTk"); if (btn) btn.disabled = false;
    }
  };
}

// ---------------- Statik UI (sadece bir kez bağlanır) ----------------
function wireStaticUI() {
  if (uiWired) return;
  uiWired = true;

  $("#nav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-page]"); if (!a) return;
    navigate(a.dataset.page);
  });
  $("#newBtn").addEventListener("click", () => showForm());

  // Sütun filtre popover'ı dışına tıklanınca kapat — sayfa her yeniden
  // render olduğunda DOM'u taze sorguladığı için tek seferlik bağlama
  // yeterli, leak olmaz.
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".thfilter") && !e.target.closest("[data-thopen]")) {
      $$(".thfilter.open").forEach((p) => p.classList.remove("open"));
    }
  });
}

function registerSW() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }
}

// ================================================================
// YEDEKLER (otomatik günlük yedek dosyaları — Storage, bkz. yedekler_sema.sql)
// ================================================================
let YEDEKLER_LIST = [];

function formatBytes(n) {
  if (!n && n !== 0) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function renderYedeklerPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Yedekler</h1>
      <div class="sub">Her gece 02:00'de otomatik alınan veritabanı yedekleri.</div>
      <div class="spacer"></div>
    </div>
    <div class="devlist" id="yedekList"></div>`;
  loadYedekler();
}

async function loadYedekler() {
  try {
    YEDEKLER_LIST = await Api.listYedekler();
  } catch (e) {
    toast("Yedekler yüklenemedi — yedekler_sema.sql çalıştırıldı mı?", true);
    YEDEKLER_LIST = [];
  }
  if (currentPage !== "yedekler") return;
  renderYedekList();
}

function renderYedekList() {
  const wrap = $("#yedekList"); if (!wrap) return;
  if (!YEDEKLER_LIST.length) {
    wrap.innerHTML = `<div class="empty"><div class="t">Henüz yedek yok</div><div class="d">İlk otomatik yedek gece 02:00'de alınacak.</div></div>`;
    return;
  }
  wrap.innerHTML = YEDEKLER_LIST.map((f) => `
    <div class="devrow" style="cursor:default">
      <div><div class="nm">${esc(f.name)}</div><div class="tip">${formatBytes(f.metadata?.size)} · ${formatDT(f.created_at)}</div></div>
      <div class="grow"></div>
      <button class="act" data-indir="${esc(f.name)}">İndir</button>
    </div>`).join("");
  wrap.querySelectorAll("[data-indir]").forEach((btn) => {
    btn.onclick = async () => {
      try {
        const url = await Api.getYedekIndirLink(btn.dataset.indir);
        window.open(url, "_blank");
      } catch (e) {
        toast("İndirme linki alınamadı", true);
      }
    };
  });
}

// ---------------- Boot ----------------
(async function boot() {
  $("#authSubmit").addEventListener("click", handleAuthSubmit);
  $("#authPin").addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuthSubmit(); });
  $("#logoutBtn").addEventListener("click", handleLogout);
  registerSW();

  // Önce GERÇEK Supabase Auth oturumuna bak (localStorage'a körü körüne
  // güvenmek yerine) — secure_rls_authenticated.sql çalıştıktan sonra
  // veri erişimi zaten sadece bu yolla mümkün olacak.
  let real = null;
  try { real = await Api.getCurrentAuthSession(); } catch (e) { real = null; }
  if (real) {
    setSession(real);
    await initApp(real);
    return;
  }

  // Gerçek Auth oturumu yok — GEÇİCİ: henüz Auth'a taşınmamış bir
  // kullanıcının dual-mode fallback ile girmiş olabileceği eski
  // localStorage oturumuna bak (migrasyon tamamlanıp RLS kilitlenince
  // bu dal zaten anlamsızlaşır, veri istekleri RLS'ye takılır).
  const legacy = getSession();
  if (legacy) {
    await initApp(legacy);
  } else {
    clearSession();
    showAuth();
  }
})();
