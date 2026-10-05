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
  { label: "Tekrar", value: (r) => (r.tekrar_kaynagi_id ? "Evet" : "") },
  { label: "Not", value: (r) => notlarOf(r).map((n) => n.yazan ? `${n.metin} (${n.yazan}, ${formatDateFull(n.zaman)})` : n.metin).join(" | ") },
  { label: "Kalite Notu", value: (r) => r.kalite_notu || "" },
];
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
  istatistikler: { t: "İstatistikler", d: "Canlı veritabanından hesaplanır — tarih aralığını ve dönemi üstten seç." },
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ---------------- Piksel ikonlar (tip rozetleri + Tekrar) ----------------
// "#" = dolu piksel; 12×12 ızgara, 1 birim = 1 CSS px (retina'da tam 2× —
// bulanıklaşmaz). fill=currentColor: rozetin rengini (tip × tema × mod) alır.
const PIXEL_ICONS = {
  ihc:   ["##........##", "###......###", ".###....###.", "..###..###..", "...######...", "....####....", ".....##.....", ".....##.....", ".....##.....", ".....##.....", "....####....", "............"],
  hk:    ["............", ".....##.....", ".....##.....", "....####....", "....####....", "...######...", "..########..", "..##.#####..", "..#.######..", "..########..", "...######...", "....####...."],
  mol:   [".##.####.##.", "..##....##..", "...##..##...", ".....##.....", "...##..##...", "..##....##..", ".##.####.##.", "..##....##..", "...##..##...", ".....##.....", "...##..##...", "..##....##.."],
  fish:  ["............", "............", "............", "...#####...#", ".########.##", "##.#########", "############", ".########.##", "...#####...#", "............", "............", "............"],
  kesit: ["............", ".........###", "........####", ".......####.", "......####..", ".....###....", "....#.......", "...##.......", "..##........", ".##.........", "##..........", "............"],
  hucre: ["............", ".##########.", ".#........#.", ".#.##..#..#.", ".#.##.....#.", ".#.....##.#.", ".#..#..##.#.", ".#........#.", ".#.##..#..#.", ".#.##.....#.", ".##########.", "............"],
  yayma: ["............", "............", "............", "############", "#...##...###", "#..####..###", "#...##...###", "############", "............", "............", "............", "............"],
  diger: ["............", "............", "............", "............", "............", ".##..##..##.", ".##..##..##.", "............", "............", "............", "............", "............"],
  tekrar: ["...####...", ".##....#.#", ".#.....###", "#.....####", "#.........", ".........#", "####.....#", "###.....#.", "#.#....##.", "...####..."],
};
function pixelSvg(rows) {
  const h = rows.length, w = rows[0].length;
  let rects = "";
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      if (row[x] !== "#") continue;
      let x2 = x;
      while (x2 < w && row[x2] === "#") x2++;
      rects += `<rect x="${x}" y="${y}" width="${x2 - x}" height="1"/>`;
      x = x2;
    }
  });
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true">${rects}</svg>`;
}
const PIXEL_SVG = Object.fromEntries(Object.entries(PIXEL_ICONS).map(([k, v]) => [k, pixelSvg(v)]));
// Test grupları dinamik (Test Grupları sayfasından yenisi eklenebilir) —
// tanınmayan kod Diğer'in ikonu + rengiyle gösterilir.
const TIP_KODLARI = new Set(["ihc", "hk", "mol", "fish", "kesit", "hucre", "yayma", "diger"]);
function tipKey(grup) {
  const k = String(grup || "").toLowerCase();
  return TIP_KODLARI.has(k) ? k : "diger";
}
function tipTag(grup) {
  const k = tipKey(grup);
  return `<span class="tag" data-g="${k}">${PIXEL_SVG[k]}${esc(TIP[grup] || "Diğer")}</span>`;
}
const TEKRAR_BADGE = `<span class="badge-tekrar" title="Boya tekrarı">${PIXEL_SVG.tekrar}Tekrar</span>`;

const GERI_IKON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.6-6.4L3 8"/><path d="M3 3v5h5"/></svg>`;
const SEARCH_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>`;

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
// Unvanlar ("Öğr. Gör. Dr.", "Prof.Dr.", "Arş. Gör.") atlanır, ilk ve son adın
// baş harfleri alınır: "Öğr. Gör. Dr. Fatih Demir" → "FD", "M. Urgancı" → "MU".
const UNVANLAR = new Set(["prof", "doç", "doc", "dr", "öğr", "ogr", "gör", "gor", "arş", "ars", "yrd", "uzm", "op"]);
function initials(name) {
  const parts = String(name || "").split(/\s+/).filter((tok) => {
    const parcalar = tok.split(".").filter(Boolean);
    return parcalar.length && !parcalar.every((x) => UNVANLAR.has(x.toLocaleLowerCase("tr")));
  });
  const pick = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  return pick.map((p) => p[0].toLocaleUpperCase("tr")).join("") || "?";
}

// ---------------- Avatarlar ----------------
// Bucket private → imzalı URL'ler (24 saat) girişte toplu alınır, 6 saatte
// bir ve kendi fotoğrafını değiştirince tazelenir. Fotoğraf yoksa baş harf.
const AVATAR_URL_SURE_SN = 24 * 3600;
let AVATAR_BY_ID = {}, AVATAR_BY_NAME = {};
let avatarTimer = null;
async function refreshAvatarlar() {
  try {
    const a = await Api.getAvatarlar(AVATAR_URL_SURE_SN);
    AVATAR_BY_ID = a.byId; AVATAR_BY_NAME = a.byName;
  } catch (e) { /* profil_sema.sql yoksa ya da geçici hata — baş harflerle devam */ }
}
function avatarHTML({ id, ad }, cls = "av") {
  const url = (id && AVATAR_BY_ID[id]) || (ad && AVATAR_BY_NAME[ad]);
  return url
    ? `<span class="${cls} has-img"><img src="${esc(url)}" alt=""></span>`
    : `<span class="${cls}">${esc(initials(ad || "?"))}</span>`;
}
function renderMe() {
  if (!session) return;
  $("#meAv").outerHTML = avatarHTML({ id: session.id, ad: session.ad_soyad }, "av").replace('class="av', 'id="meAv" class="av');
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
const exportMenuHTML = (gorunenEtiket = "Görünenler") => `
  <div class="exportbox">
    <button class="btn-ghost btn-sm exportbtn">Excel'e Aktar ▾</button>
    <div class="thfilter" style="right:auto;left:0">
      <button class="thopt" data-exp="gorunen">${gorunenEtiket}</button>
      <button class="thopt" data-exp="tum">Tümü</button>
    </div>
  </div>`;
const EXPORT_MENU_HTML = exportMenuHTML();
document.addEventListener("click", () => $$(".exportbox .thfilter.open").forEach((p) => p.classList.remove("open")));
// Çoklu seçim: checkbox üstünde sürükleyerek seçim (masaüstü, opsiyonel) —
// sürüklemeyi nerede bitirirse bitirsin devreyi kapatır.
document.addEventListener("mouseup", () => { dragStartId = null; dragActive = false; });

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
    toast(e && (e.isReferenced || e.hasAuthAccount || e.isForbidden) ? e.message : "Silinemedi", true);
  }
}


// ---- state ----
let session = null;
let CAT = {}, UZMANLAR = [], CIHAZLAR = [];
let ISTEK_SETLERI = [], SETS_INST = {};   // kurumsal, herkese açık
let SABLONLAR = [], SETS_SABLON = {};     // kendi şablonların + başkalarının herkese açık olanları
let RECENT_TESTS = {};                    // {grup: [{id,ad,klon,grup}]} — kullanıcının en son kullandığı testler
let RECENT_SETLER = new Map();            // istek_seti_id -> {son_kullanim, kullanim_sayisi}
const RECENT_CAP = 20;                    // Tek Tek Seç varsayılan görünümünde grup başına üst sınır
const RECENT_SET_CAP = 10;                // Hazır Setler varsayılan görünümünde üst sınır
let rows = [];
let selId = null, searchQ = "";
let bulkSelected = new Set(); // kalem_id'ler — çoklu seçim (İş Kuyruğu)
let bulkAnchor = null;        // Shift+tık ile ardışık aralık genişletmede sabit kalan "temel" satır
let dragStartId = null;       // checkbox sürükleyerek seçim (masaüstü, opsiyonel) — mousedown olan satır
let dragActive = false;       // fare gerçekten başka bir satıra taşındı mı (basit tıkla karışmasın diye)
let dragValue = false;        // sürüklenirken uygulanacak checked durumu
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
    tekrar: new Set(), // "tekrar" | "normal" — İstek sütununun filtre panelinde
  };
}
let colFilters = freshColFilters();
let sortCol = null, sortDir = "asc";
let caseView = null; // aktifken bir patoloji_no string'i (vaka görünümü)
let kaliteDrafts = new Map(); // kalem_id -> kaydedilmemiş kalite notu taslağı
let detailStale = false;      // detayda yazı yazılırken gelen realtime yenilemesi ertelendi mi
let notDrafts = new Map();    // istem_id -> kaydedilmemiş yeni not taslağı (detay paneli)
// Eski kayıtlar: created_at'i ESKI_GUN günden eski TAMAMLANDI kalemler
// varsayılan olarak yüklenmez/gösterilmez — Bekleyen/Cihazda her zaman
// görünür. Vaka görünümü her zaman tüm geçmiştir (eskiler ayrıca çekilir).
const ESKI_GUN = 30;
let eskileriGoster = false;
let eskiSinirMs = null;       // son yüklemedeki 30 gün sınırı (ms) — toggle açıkken de tutulur (sayaç için)
let gizliEskiSayisi = 0;      // sunucuda kalan (yüklenmeyen) eski Tamamlandı sayısı
let queueSeq = 0;             // üst üste binen yüklemelerde yalnız en sonuncusu yazsın
// Yeni istem bildirimi: şimdiye kadar görülen kalem id'leri (null = ilk
// yükleme henüz olmadı) ve henüz bakılmamış yeni kalemler ("Yeni" etiketi).
let bilinenKalemler = null;
let yeniKalemler = new Set();

// ---------------- Yetkiler (arayüz) ----------------
// Asıl uygulama RLS'te (yetki_sema.sql) — buradakiler sadece kullanıcının
// yapamayacağı şeyleri ona hiç göstermemek için. Admin teknisyen
// kısıtlarından muaftır (RLS'teki is_teknisyen() ile aynı kural).
const isAdmin = () => Boolean(session && session.is_admin);
const isTeknisyen = () => Boolean(session && session.rol === "teknisyen" && !session.is_admin);
// Teknisyen sıfırdan istem giremez — tek yolu detay panelindeki "Tekrar İste".
const canCreateIstem = () => !isTeknisyen();
// Durum geri alma (Tamamlandı→Cihazda, Cihazda→Bekleyen): admin + teknisyen
// her kalemi; uzman/asistan yalnız KENDİ açtığı istemin kalemlerini (RLS:
// istem_kalemleri_geri_alma_kontrol, ek_ozellikler_sema.sql).
const canRevert = (r) => isAdmin() || Boolean(session && session.rol === "teknisyen")
  || Boolean(r && session && r.istem_yapan_id === session.id);
// Admin her kalemi (Tamamlandı dahil); diğerleri kendi istemindeki,
// Tamamlandı olmayan kalemleri.
const canDeleteKalem = (r) => isAdmin() || (r.istem_yapan_id === session.id && r.durum !== "tamamlandi");
// İstek Setleri: teknisyen dışında herkes ekler/düzenler/siler (RLS de öyle).
const canManageSets = () => !isTeknisyen();
const canEditSablon = (s) => isAdmin() || (!isTeknisyen() && s.sahip_id === session.id);
const ADMIN_PAGES = new Set(["kullanicilar", "test-gruplari", "test-katalogu", "yedekler", "istatistikler"]);
function pageAllowed(page) {
  if (ADMIN_PAGES.has(page)) return isAdmin();
  if (page === "sablonlar") return !isTeknisyen();
  return true;
}
// Nav/sidebar görünürlüğü — her girişte (initApp) yeniden uygulanır.
function applyRoleUI() {
  $("#newBtn").classList.toggle("hidden", !canCreateIstem());
  $$("#nav [data-admin]").forEach((el) => el.classList.toggle("hidden", !isAdmin()));
  $$("#nav a[data-page]").forEach((a) => {
    if (!a.hasAttribute("data-admin")) a.classList.toggle("hidden", !pageAllowed(a.dataset.page));
  });
}

function isTabActive(f) {
  return f === "all" ? colFilters.durum.size === 0 : colFilters.durum.size === 1 && colFilters.durum.has(f);
}
function setDurumTab(f) {
  colFilters.durum = f === "all" ? new Set() : new Set([f]);
}
function hasActiveFilters() {
  return Boolean(searchQ) || Boolean(colFilters.pat || colFilters.blok || colFilters.test || colFilters.isteyen || colFilters.uzman)
    || colFilters.tip.size > 0 || colFilters.oncelik.size > 0 || colFilters.durum.size > 0 || colFilters.tekrar.size > 0;
}
function clearAllFilters() {
  colFilters = freshColFilters();
  searchQ = "";
  const qs = $("#qSearch"); if (qs) qs.value = "";
  $$("#tabs button").forEach((x) => x.classList.toggle("on", isTabActive(x.dataset.f)));
  clearBulkSelection();
  renderTable();
}

// Çoklu seçim, sekme/filtre değişince ya da bir toplu aksiyon bitince
// temizlenir — sıralama değişikliğinde ve realtime yeniden yüklemede KORUNUR.
function clearBulkSelection() {
  bulkSelected = new Set();
  bulkAnchor = null;
  syncBulkUI();
}

// Düz tık ve Ctrl/Cmd+tık (ve checkbox'a doğrudan tık) buradan geçer —
// anchor'ı bu satıra taşır ki bir sonraki Shift+tık buradan başlasın.
function toggleBulkSelect(kalemId) {
  if (bulkSelected.has(kalemId)) bulkSelected.delete(kalemId);
  else bulkSelected.add(kalemId);
  bulkAnchor = kalemId;
  syncBulkUI();
}

// Shift+tık — anchor'dan hedefe, GÖRÜNEN sıraya göre aralık seçer. Anchor
// kasıtlı olarak DEĞİŞMEZ: ardışık Shift+tık'larla aynı temelden aralık
// büyütülüp küçültülebilsin (Windows Gezgini deseni).
function selectRange(fromId, toId) {
  const ids = getVisibleRows().map((r) => r.kalem_id);
  const i1 = ids.indexOf(fromId), i2 = ids.indexOf(toId);
  if (i1 === -1 || i2 === -1) { toggleBulkSelect(toId); return; }
  const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
  bulkSelected = new Set(ids.slice(lo, hi + 1));
  syncBulkUI();
}

// Başlıktaki "tümünü seç/kaldır" — GÖRÜNEN (filtre/arama/vaka görünümü
// uygulanmış) satırların hepsi zaten seçiliyse seçimlerini kaldırır, aksi
// halde hepsini seçime ekler. Görünmeyen ama seçili satırlara dokunmaz.
function toggleAllVisibleSelection() {
  const ids = getVisibleRows().map((r) => r.kalem_id);
  const allOn = ids.length > 0 && ids.every((id) => bulkSelected.has(id));
  ids.forEach((id) => (allOn ? bulkSelected.delete(id) : bulkSelected.add(id)));
  syncBulkUI();
}

// Vaka grubunun başındaki kısayol — o patoloji no'nun GÖRÜNEN tüm
// satırları (tablo içinde dağınık olsalar bile) aynı mantıkla seçilir/kaldırılır.
function toggleCaseSelection(patNo) {
  const ids = getVisibleRows().filter((r) => r.patoloji_no === patNo).map((r) => r.kalem_id);
  const allOn = ids.length > 0 && ids.every((id) => bulkSelected.has(id));
  ids.forEach((id) => (allOn ? bulkSelected.delete(id) : bulkSelected.add(id)));
  syncBulkUI();
}

// Tam yeniden çizimden sonra (renderTable) ya da tek başına bir seçim
// değişikliğinden sonra çağrılır — satırları/checkbox'ları TEK TEK güncelleyip
// tüm tabloyu yeniden kurmadan akıcı kalır. Artık rows'ta olmayan (silinmiş/
// realtime'da kaybolmuş) kalem_id'ler burada sessizce düşürülür.
function syncBulkUI() {
  const liveIds = new Set(rows.map((r) => r.kalem_id));
  bulkSelected = new Set([...bulkSelected].filter((id) => liveIds.has(id)));
  $$("#rows tr[data-kalem]").forEach((tr) => {
    const on = bulkSelected.has(tr.dataset.kalem);
    tr.classList.toggle("bulk-checked", on);
    const cb = tr.querySelector("[data-bulk-check]");
    if (cb) cb.checked = on;
  });

  const visible = $("#rows") ? getVisibleRows() : [];
  const all = $("[data-bulk-all]");
  if (all) {
    const n = visible.filter((r) => bulkSelected.has(r.kalem_id)).length;
    all.checked = visible.length > 0 && n === visible.length;
    all.indeterminate = n > 0 && n < visible.length;
  }
  $$("#rows [data-case-sel]").forEach((btn) => {
    const ids = visible.filter((r) => r.patoloji_no === btn.dataset.caseSel);
    btn.classList.toggle("on", ids.length > 0 && ids.every((r) => bulkSelected.has(r.kalem_id)));
  });
  renderBulkBar();
}

const SORT_RANK = {
  oncelik: { rutin: 0, acil: 1, stat: 2 },
  durum: { bekleyen: 0, cihazda: 1, tamamlandi: 2 },
};
const SORT_FIELD = { blok: "blok_no", pat: "patoloji_no", test: "test_adi", tip: "grup", isteyen: "isteyen_adi", uzman: "uzman_adi", oncelik: "oncelik", durum: "durum", tarih: "created_at" };
// İsteyen / Uzman: ekranda görünen değere (kısaltma, yoksa ad) göre.
const SORT_VAL = { isteyen: (r) => r.isteyen_kisaltma || r.isteyen_adi, uzman: (r) => r.uzman_kisaltma || r.uzman_adi };
function compareForSort(a, b, col) {
  if (col === "oncelik" || col === "durum") {
    const rank = SORT_RANK[col];
    return (rank[a[col]] ?? 99) - (rank[b[col]] ?? 99);
  }
  const get = SORT_VAL[col] || ((r) => r[SORT_FIELD[col]]);
  return String(get(a) ?? "").localeCompare(String(get(b) ?? ""), "tr", { numeric: true });
}

// ---------------- Auth ----------------
// Giriş formunu gösterir — boot() (doğrulanmış oturum yoksa) ve
// handleLogout() tarafından çağrılır. #bootLoadCard'ı (varsayılan "Yükleniyor…"
// durumu) gizleyip gerçek formu açar, sonra kullanıcı listesini doldurur.
async function showAuth() {
  $("#appRoot").classList.add("hidden");
  $("#authOverlay").classList.remove("hidden");
  $("#bootLoadCard").classList.add("hidden");
  $("#authCard").classList.remove("hidden");
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
    $("#authOverlay").classList.add("hidden");
    await initApp(user);
  } catch (e) {
    $("#authErr").textContent = "Giriş yapılamadı (bağlantı sorunu olabilir)";
  } finally {
    $("#authSubmit").disabled = false;
  }
}

async function handleLogout() {
  togglePrefs(false);
  if (window.Tema) Tema.cikis();
  await Api.signOut();
  if (unsub) { unsub(); unsub = null; }
  if (pageUnsub) { pageUnsub(); pageUnsub = null; }
  rows = []; selId = null; searchQ = "";
  colFilters = freshColFilters();
  sortCol = null; sortDir = "asc"; caseView = null;
  kaliteDrafts = new Map(); notDrafts = new Map(); detailStale = false;
  eskileriGoster = false; eskiSinirMs = null; gizliEskiSayisi = 0;
  bilinenKalemler = null; yeniKalemler = new Set(); renderYeniBildirim();
  currentPage = "kuyruk";
  $("#appRoot").classList.add("hidden");
  showAuth();
}

// ---------------- App init ----------------
async function initApp(user) {
  session = user;
  if (window.Tema) Tema.kullaniciYukle(user.id); // kişisel tema/mod/yoğunluk
  $("#authOverlay").classList.add("hidden");
  $("#appRoot").classList.remove("hidden");
  renderMe();
  $("#meName").textContent = user.ad_soyad;
  $("#meRole").textContent = (ROL_LABEL[user.rol] || user.rol) + (user.is_admin ? " · Yönetici" : "");
  applyRoleUI();

  // allSettled: setler_sema.sql henüz çalıştırılmadıysa (istek_setleri/cihazlar
  // tabloları yoksa) o sorgular başarısız olur ama temel katalog/uzman listesi
  // yine de yüklenir — tek bir eksik tablo tüm girişi kilitlemesin.
  const avatarP = refreshAvatarlar(); // paralel — gelince sol alttaki baş harf fotoğrafa döner
  const results = await Promise.allSettled([
    Api.getTestKatalog(), Api.getIstekSetleri(), Api.getSablonlar(user.id), Api.getUzmanlar(), Api.getCihazlar(), Api.getTestGruplari(),
    Api.getSonKullanilanTestler(user.id), Api.getSonKullanilanSetler(user.id),
  ]);
  const [catR, setlerR, sablonR, uzmanlarR, cihazlarR, gruplarR, sonTestR, sonSetR] = results;
  if (catR.status === "fulfilled") CAT = catR.value; else toast("Test kataloğu yüklenemedi", true);
  if (setlerR.status === "fulfilled") { ISTEK_SETLERI = setlerR.value; SETS_INST = activeSetsInst(ISTEK_SETLERI); }
  else toast("İstek Setleri yüklenemedi — setler_sema.sql çalıştırıldı mı?", true);
  if (sablonR.status === "fulfilled") { SABLONLAR = sablonR.value; SETS_SABLON = groupByGrup(SABLONLAR); }
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
  await avatarP;
  renderMe();
  if (!avatarTimer) avatarTimer = setInterval(async () => { await refreshAvatarlar(); renderMe(); }, 6 * 3600 * 1000);

  wireStaticUI();
  if (unsub) unsub();
  unsub = Api.subscribeQueue(scheduleReload);

  navigate("kuyruk");
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadQueue, 150);
}

async function refreshSablonlar() {
  SABLONLAR = await Api.getSablonlar(session.id);
  SETS_SABLON = groupByGrup(SABLONLAR);
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
  if (!pageAllowed(page)) page = "kuyruk";
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
  } else if (page === "istatistikler") {
    renderIstatistiklerPage();
  }
}

// ================================================================
// İŞ KUYRUĞU
// ================================================================
function renderQueuePage() {
  $("#mainView").innerHTML = `
    <div class="main-head mh-zil">
      <div>
        <h1>İş Kuyruğu</h1>
        <div class="sub"><b id="totalN">0</b> istek · IHC, histokimya, moleküler</div>
      </div>
      <button type="button" class="zil" id="zilBtn"></button>
    </div>
    <div class="barrow" id="barrow">
      <div class="tabs" id="tabs">
        <button class="${isTabActive("all") ? "on" : ""}" data-f="all">Tümü <span class="count" data-c="all">0</span></button>
        <button class="${isTabActive("bekleyen") ? "on" : ""}" data-f="bekleyen">Bekleyen <span class="count" data-c="bekleyen">0</span></button>
        <button class="${isTabActive("cihazda") ? "on" : ""}" data-f="cihazda">Cihazda <span class="count" data-c="cihazda">0</span></button>
        <button class="${isTabActive("tamamlandi") ? "on" : ""}" data-f="tamamlandi">Tamamlandı <span class="count" data-c="tamamlandi">0</span></button>
      </div>
      <div class="eski-kutu hidden" id="eskiKutu" title="${ESKI_GUN} günden eski Tamamlandı kayıtlar yalnız bu ekranda gizlenir — İstatistikler, Excel'e Aktar ve yedekler her zaman tüm kayıtları kapsar.">
        <button class="btn-ghost btn-sm eski-btn" id="eskiBtn"></button>
        <span class="eski-sayac" id="eskiSayac"></span>
      </div>
      <div class="grow"></div>
      <button class="btn-ghost btn-sm hidden" id="clearFiltersBtn">Filtreleri Temizle</button>
      <div id="qExport">${exportMenuHTML("Filtreye uyanlar (eskiler dahil)")}</div>
      <div class="zoomctl" id="zoomCtl">
        <button type="button" data-zoom="-1" aria-label="Tabloyu sıkılaştır">A−</button>
        <span class="lvl"></span>
        <button type="button" data-zoom="1" aria-label="Tabloyu genişlet">A+</button>
      </div>
      <div class="msearch">
        ${SEARCH_ICON}
        <input id="qSearch" placeholder="Blok, patoloji no…" value="${esc(searchQ)}">
      </div>
    </div>
    <div class="case-banner hidden" id="caseBanner"></div>
    <div class="bulkbar hidden" id="bulkBar">
      <span id="bulkCount"></span>
      <div class="grow"></div>
      <button class="act act-cihaza" id="bulkCihazaBtn">Cihaza Al</button>
      <button class="act act-tamamla" id="bulkTamamlaBtn">Tamamla</button>
      <button class="btn-ghost btn-sm" id="bulkYazdirBtn" title="Seçili kalemlerin çalışma listesini yazdır">${YAZDIR_IKON} Yazdır</button>
      <button class="btn-ghost btn-sm" id="bulkTekrarBtn">↻ Tekrar İste</button>
      <button class="btn-ghost btn-sm" id="bulkGeriBtn">↺ Geri Al</button>
      <button class="btn-ghost btn-sm" id="bulkSilBtn">Sil</button>
      <button class="ub-x" id="bulkClearBtn" title="Seçimi temizle">×</button>
    </div>
    <div class="tablewrap">
      <table>
        <thead id="qhead"></thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="eski-ipucu hidden" id="eskiIpucu"></div>
    </div>`;

  if (caseView !== null) $("#barrow").classList.add("dimmed");

  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    setDurumTab(b.dataset.f);
    $$("#tabs button").forEach((x) => x.classList.toggle("on", isTabActive(x.dataset.f)));
    clearBulkSelection();
    renderTable();
  });
  $("#qSearch").addEventListener("input", (e) => { searchQ = e.target.value; renderTable(); });
  $("#zoomCtl").addEventListener("click", (e) => {
    const b = e.target.closest("[data-zoom]");
    if (!b || !window.Tema) return;
    const list = Tema.YOGUNLUKLAR;
    const i = list.indexOf(Tema.get().yogunluk) + Number(b.dataset.zoom);
    if (i >= 0 && i < list.length) Tema.set({ yogunluk: list[i] });
  });
  renderZoomCtl();
  $("#clearFiltersBtn").addEventListener("click", clearAllFilters);
  $("#eskiBtn").addEventListener("click", eskiToggle);
  $("#eskiIpucu").addEventListener("click", (e) => { if (e.target.closest("[data-eski-goster]")) eskiToggle(); });
  bindExportMenu("#qExport", kuyruguDisaAktar);
  $("#bulkCihazaBtn").addEventListener("click", () => bulkAdvance("cihazda", "bekleyen", "Cihaza alındı"));
  $("#bulkTamamlaBtn").addEventListener("click", () => bulkAdvance("tamamlandi", "cihazda", "Tamamlandı"));
  $("#bulkYazdirBtn").addEventListener("click", calismaListesiYazdir);
  $("#bulkTekrarBtn").addEventListener("click", bulkTekrar);
  $("#zilBtn").addEventListener("click", () => sesAyarla(!sesAcik()));
  renderZil();
  $("#bulkGeriBtn").addEventListener("click", bulkRevert);
  $("#bulkSilBtn").addEventListener("click", bulkDelete);
  $("#bulkClearBtn").addEventListener("click", clearBulkSelection);
  $("#rows").addEventListener("click", (e) => {
    const caseSel = e.target.closest("[data-case-sel]");
    if (caseSel) {
      e.stopPropagation();
      toggleCaseSelection(caseSel.dataset.caseSel);
      return;
    }
    const patCell = e.target.closest(".c-pat");
    if (patCell) {
      e.stopPropagation();
      const tr = patCell.closest("tr[data-kalem]");
      const r = rows.find((x) => x.kalem_id === tr.dataset.kalem);
      if (r) openCaseView(r.patoloji_no);
      return;
    }
    const btn = e.target.closest("[data-aks]");
    if (btn) {
      e.stopPropagation();
      const r = rows.find((x) => x.kalem_id === btn.dataset.id);
      if (!r) return;
      if (btn.dataset.aks === "geri") revertDurum(r);
      else advance(r.kalem_id, btn.dataset.aks);
      return;
    }
    const checkEl = e.target.closest("[data-bulk-check]");
    if (checkEl) {
      e.stopPropagation();
      toggleBulkSelect(checkEl.dataset.bulkCheck);
      return;
    }
    const tr = e.target.closest("tr[data-kalem]");
    if (!tr) return;
    const r = rows.find((x) => x.kalem_id === tr.dataset.kalem);
    if (!r) return;
    // Shift/Ctrl+tık: sadece çoklu seçimi yönetir, detay panelini AÇMAZ
    // (mevcut seçili detay ne ise öyle kalır).
    if (e.shiftKey && bulkAnchor) { e.preventDefault(); selectRange(bulkAnchor, r.kalem_id); return; }
    if (e.ctrlKey || e.metaKey) { toggleBulkSelect(r.kalem_id); return; }
    // Düz tık: hem detay panelini açar (mevcut davranış) hem çoklu seçimi
    // bu tek satıra indirger (öncekini temizler).
    bulkSelected = new Set([r.kalem_id]);
    bulkAnchor = r.kalem_id;
    syncBulkUI();
    showDetail(r);
  });
  // Sürükleyerek seçim (masaüstü, opsiyonel — bkz. plan #7): basit bir tıkla
  // ASLA çakışmaz, çünkü sadece fare GERÇEKTEN başka bir checkbox'a
  // taşındığında (dragActive) devreye girer — aksi halde native "click"
  // olayı yukarıdaki handler'dan normal şekilde (tek seferlik toggle) geçer.
  $("#rows").addEventListener("mousedown", (e) => {
    const cb = e.target.closest("[data-bulk-check]");
    if (!cb) return;
    dragStartId = cb.dataset.bulkCheck;
    dragActive = false;
    dragValue = !bulkSelected.has(dragStartId);
  });
  $("#rows").addEventListener("mouseover", (e) => {
    if (!dragStartId) return;
    const cb = e.target.closest("[data-bulk-check]");
    if (!cb) return;
    const id = cb.dataset.bulkCheck;
    if (!dragActive) {
      if (id === dragStartId) return; // fare henüz aynı checkbox üstünde, sürükleme başlamadı
      dragActive = true;
      if (dragValue) bulkSelected.add(dragStartId); else bulkSelected.delete(dragStartId);
      bulkAnchor = dragStartId;
    }
    if (dragValue) bulkSelected.add(id); else bulkSelected.delete(id);
    bulkAnchor = id;
    syncBulkUI();
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
    if (e.target.closest("[data-bulk-all]")) { toggleAllVisibleSelection(); return; }
    const chk = e.target.closest("[data-thcheck]");
    if (!chk) return;
    const key = chk.dataset.thcheck, val = chk.value;
    if (key === "durum") {
      if (chk.checked) colFilters.durum.add(val); else colFilters.durum.delete(val);
      $$("#tabs button").forEach((b) => b.classList.toggle("on", isTabActive(b.dataset.f)));
    } else {
      if (chk.checked) colFilters[key].add(val); else colFilters[key].delete(val);
    }
    clearBulkSelection();
    renderTable();
  });
  // Metin sütun filtreleri — canlı arama.
  $("#qhead").addEventListener("input", (e) => {
    const inp = e.target.closest("[data-thsearch]");
    if (!inp) return;
    colFilters[inp.dataset.thsearch] = inp.value.toLowerCase();
    clearBulkSelection();
    renderTable();
  });

  loadQueue();
}

function openCaseView(patNo) {
  caseView = patNo;
  $("#barrow")?.classList.add("dimmed");
  renderTable();
  vakaGecmisiniYukle(patNo);
}
// Vaka görünümü tüm geçmiştir: kuyrukta yüklü olmayan (eski Tamamlandı)
// kalemler de çekilip rows'a eklenir — normal görünümde eskiGizli() onları
// yine gizler.
async function vakaGecmisiniYukle(patNo) {
  if (eskileriGoster) return; // hepsi zaten yüklü
  try {
    const vaka = await Api.vakaKalemleri(patNo);
    if (caseView !== patNo) return;
    rows = mergeRows(rows, vaka);
    renderTable();
  } catch (e) { /* yüklü olanlarla devam */ }
}
function mergeRows(base, extra) {
  const ids = new Set(base.map((r) => r.kalem_id));
  return base.concat(extra.filter((r) => !ids.has(r.kalem_id)));
}
// 30 günden eski Tamamlandı mı (son yüklemedeki sınıra göre)?
function eskiMi(r) {
  return eskiSinirMs !== null && r.durum === "tamamlandi" && new Date(r.created_at).getTime() < eskiSinirMs;
}
// Gizleme YALNIZ İş Kuyruğu ekranı içindir (toggle kapalıyken). İstatistikler
// (sunucuda, istatistik()), Excel'e Aktar (kuyruguDisaAktar — sunucudan tam
// liste), Hizmetler ve otomatik yedekler bu filtreyi hiç kullanmaz.
function eskiGizli(r) {
  return !eskileriGoster && eskiMi(r);
}

// Excel'e Aktar — 30 gün gizlemesinden ETKİLENMEZ: kayıtlar tıklandığı anda
// sunucudan eskiler dahil tam olarak çekilir. "Tümü" hepsini; "Filtreye
// uyanlar" sütun filtreleri + arama + sıralamayı (vaka görünümünde o vakayı)
// bu tam liste üzerinde uygular.
async function kuyruguDisaAktar(which) {
  toast("Excel hazırlanıyor…");
  let tum;
  try {
    tum = await Api.listQueue();
  } catch (e) {
    toast("Kayıtlar alınamadı — Excel oluşturulmadı", true);
    return;
  }
  const list = which === "tum" ? tum : filtreleVeSirala(tum, { eskiDahil: true });
  exportToExcel(list, KUYRUK_EXPORT_COLS, `istem_kuyruk_${which === "tum" ? "tumu" : "filtreli"}`);
}
async function eskiToggle() {
  eskileriGoster = !eskileriGoster;
  clearBulkSelection();
  updateCounts(); // düğme metni hemen değişsin
  await loadQueue();
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
// Filtresiz, sadece sıralanabilir sütun (ör. Tarih) — caret/popover yok,
// mevcut [data-sortcol] delegasyonu (renderQueuePage/renderHizmetlerPage'de
// zaten bağlı) bunu da kapsar.
function thSortOnly(key, label, sortState) {
  const arrow = sortState.active ? (sortState.dir === "asc" ? " ▲" : " ▼") : "";
  return `<th><span class="thlabel" data-sortcol="${key}">${esc(label)}${arrow}</span></th>`;
}

function renderQHead() {
  const head = $("#qhead");
  if (!head) return;
  const bulkAllTh = `<th class="bulkcell"><input type="checkbox" data-bulk-all aria-label="Görünen tümünü seç/kaldır" title="Görünen tümünü seç/kaldır"></th>`;
  if (caseView !== null) {
    head.innerHTML = `<tr>${bulkAllTh}<th>Durum</th><th>Patoloji No</th><th>Blok</th><th>İstek</th><th>Tip</th><th>İsteyen</th><th>Uzman Adına</th><th>Tarih</th><th>Öncelik</th><th>Not</th></tr>`;
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
    ${bulkAllTh}
    ${thMultiFilter("durum", "Durum", ["bekleyen", "cihazda", "tamamlandi"].map((k) => ({ value: k, label: PILL[k][1] })), colFilters.durum, sortOf("durum"))}
    ${thTextFilter("pat", "Patoloji No", colFilters.pat, sortOf("pat"))}
    ${thTextFilter("blok", "Blok", colFilters.blok, sortOf("blok"))}
    ${thHead("test", "İstek", sortOf("test"), Boolean(colFilters.test) || colFilters.tekrar.size > 0, `
      <input type="text" class="thsearch" data-thsearch="test" placeholder="İstek ara…" value="${esc(colFilters.test || "")}">
      <div class="thsep"></div><div class="thsub">Tekrar</div>
      ${[["tekrar", "Sadece tekrarlar"], ["normal", "Tekrar olmayanlar"]].map(([v, l]) => `
        <label class="thcheck"><input type="checkbox" data-thcheck="tekrar" value="${v}" ${colFilters.tekrar.has(v) ? "checked" : ""}> ${l}</label>`).join("")}`)}
    ${thMultiFilter("tip", "Tip", GROUPS.map(([k, l]) => ({ value: k, label: l })), colFilters.tip, sortOf("tip"))}
    ${thTextFilter("isteyen", "İsteyen", colFilters.isteyen, sortOf("isteyen"))}
    ${thTextFilter("uzman", "Uzman Adına", colFilters.uzman, sortOf("uzman"))}
    ${thSortOnly("tarih", "Tarih", sortOf("tarih"))}
    ${thMultiFilter("oncelik", "Öncelik", ["rutin", "acil", "stat"].map((k) => ({ value: k, label: PRIO[k][1] })), colFilters.oncelik, sortOf("oncelik"))}
    <th>Not</th>
  </tr>`;

  if (openKey) head.querySelector(`[data-thpanel="${openKey}"]`)?.classList.add("open");
  if (focusKey) {
    const input = head.querySelector(`[data-thsearch="${focusKey}"]`);
    if (input) { input.focus(); input.setSelectionRange(selStart, selEnd); }
  }
}

function passesFilter(r, eskiDahil = false) {
  if (!eskiDahil && eskiGizli(r)) return false;
  if (colFilters.durum.size && !colFilters.durum.has(r.durum)) return false;
  if (colFilters.tip.size && !colFilters.tip.has(r.grup)) return false;
  if (colFilters.oncelik.size && !colFilters.oncelik.has(r.oncelik)) return false;
  if (colFilters.tekrar.size && !colFilters.tekrar.has(r.tekrar_kaynagi_id ? "tekrar" : "normal")) return false;
  if (colFilters.pat && !r.patoloji_no.toLowerCase().includes(colFilters.pat)) return false;
  if (colFilters.blok && !r.blok_no.toLowerCase().includes(colFilters.blok)) return false;
  if (colFilters.test && !r.test_adi.toLowerCase().includes(colFilters.test)) return false;
  if (colFilters.isteyen && !`${r.isteyen_adi || ""} ${r.isteyen_kisaltma || ""}`.toLowerCase().includes(colFilters.isteyen)) return false;
  if (colFilters.uzman && !`${r.uzman_adi || ""} ${r.uzman_kisaltma || ""}`.toLowerCase().includes(colFilters.uzman)) return false;
  if (searchQ) {
    const q = searchQ.toLowerCase();
    if (!r.blok_no.toLowerCase().includes(q) && !r.patoloji_no.toLowerCase().includes(q)) return false;
  }
  return true;
}

// Filtre+arama+sıralama (vaka görünümünde o vakanın tüm geçmişi, kronolojik).
// eskiDahil: 30 gün gizlemesini uygulama (Excel'e Aktar).
function filtreleVeSirala(list, { eskiDahil = false } = {}) {
  if (caseView !== null) {
    return list.filter((r) => r.patoloji_no === caseView)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  let out = list.filter((r) => passesFilter(r, eskiDahil));
  if (sortCol) {
    const dir = sortDir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => compareForSort(a, b, sortCol) * dir);
  }
  return out;
}
// Ekranda o an görünen satırlar (renderTable, seçim kısayolları).
function getVisibleRows() {
  return filtreleVeSirala(rows);
}

function renderTable() {
  const tb = $("#rows");
  if (!tb) return; // kuyruk sayfasında değiliz
  renderQHead();
  renderCaseBanner();
  tb.innerHTML = "";

  const list = getVisibleRows();
  // Vaka (patoloji no) gruplaması sadece aynı vakanın satırlarını yan yana
  // tutan sıralamalarda anlamlı: varsayılan sıra, Patoloji No sırası ve vaka
  // görünümü. Başka bir sütuna göre sıralanınca vakalar dağılır — orada kalın
  // ayraç çizilmez, "vakayı seç" kısayolu da vakanın ilk görünen satırında kalır.
  const grouped = caseView !== null || sortCol === null || sortCol === "pat";
  const seenPat = new Set();

  list.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.dataset.kalem = r.kalem_id;
    const groupStart = i === 0 || list[i - 1].patoloji_no !== r.patoloji_no;
    const showCaseSel = grouped ? groupStart : !seenPat.has(r.patoloji_no);
    seenPat.add(r.patoloji_no);
    tr.classList.add(`row-${r.durum}`);
    if (grouped && groupStart && i > 0) tr.classList.add("case-start");
    if (r.kalem_id === selId) tr.classList.add("sel");
    if (yeniKalemler.has(r.kalem_id)) tr.classList.add("row-yeni");
    const caseSel = showCaseSel
      ? `<button class="case-sel" data-case-sel="${esc(r.patoloji_no)}" title="Bu vakanın tümünü seç/kaldır" aria-label="Bu vakanın tümünü seç/kaldır"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7.5 12.5l3 3 6-6.5"/></svg></button>`
      : "";
    const tekrarTag = r.tekrar_kaynagi_id ? TEKRAR_BADGE : "";
    tr.innerHTML = `<td class="bulkcell"><input type="checkbox" data-bulk-check="${r.kalem_id}" aria-label="Seç"></td>
      <td class="c-durum">${durumAksiyon(r)}</td>
      <td class="c-pat">${caseSel}<span class="pat-no">${esc(r.patoloji_no)}</span></td>
      <td class="c-blok">${esc(r.blok_no)}</td>
      <td class="c-test">${esc(r.test_adi)}${tekrarTag}${yeniKalemler.has(r.kalem_id) ? `<span class="badge-yeni">Yeni</span>` : ""}${r.klon ? `<small>${esc(r.klon)}</small>` : ""}</td>
      <td>${tipTag(r.grup)}</td>
      ${kisiTd(r.isteyen_adi, r.isteyen_kisaltma)}
      ${kisiTd(r.uzman_adi, r.uzman_kisaltma)}
      <td style="color:var(--ink-3);font-size:12px;white-space:nowrap">${formatDateFull(r.created_at)}</td>
      <td><span class="prio ${PRIO[r.oncelik][0]}">${PRIO[r.oncelik][1]}</span></td>
      <td class="c-not">${notHucre(r)}</td>`;
    tb.appendChild(tr);
  });
  updateCounts();
  syncBulkUI();
}

// Durum hücresi: rozet (gerçek durum, HER ZAMAN) + bitişiğinde küçük ↺
// (geri al; yalnız yetkisi olana — canRevert) + tek birincil buton (yalnız
// bir sonraki adım; Tamamlandı'da yok). ↺ olmayan satırda aynı genişlikte
// boşluk kalır ki birincil butonlar alt alta hizalı dursun.
function durumAksiyon(r) {
  const geriHedef = REVERT_TO[r.durum];
  const geri = geriHedef && canRevert(r)
    ? `<button class="ab-geri" data-aks="geri" data-id="${r.kalem_id}" data-tip="Geri Al" aria-label="Geri Al: ${PILL[r.durum][1]} → ${PILL[geriHedef][1]}">${GERI_IKON}</button>`
    : `<span class="ab-geri-yer" aria-hidden="true"></span>`;
  const sonraki = r.durum === "bekleyen" ? ["cihazda", "ab-cihaza", "Cihaza Al"]
    : r.durum === "cihazda" ? ["tamamlandi", "ab-tamamla", "Tamamla"] : null;
  const birincil = sonraki ? `<button class="ab ${sonraki[1]}" data-aks="${sonraki[0]}" data-id="${r.kalem_id}">${sonraki[2]}</button>` : "";
  return `<div class="dacts"><span class="pill ${PILL[r.durum][0]}">${PILL[r.durum][1]}</span>${geri}${birincil}</div>`;
}

// İsteyen / Uzman Adına: kısaltma varsa o (tam ad ipucu), yoksa tam ad.
function kisiTd(ad, kisa) {
  if (!ad) return `<td class="c-kisi">—</td>`;
  return `<td class="c-kisi${kisa ? " kisa" : ""}" title="${esc(ad)}">${esc(kisa || ad)}</td>`;
}

// İstemin notları (istem_notlari, en yeniden eskiye). Görünüm eskiyse
// (ek_ozellikler_sema.sql henüz çalışmadıysa) tekil not_metni'ne düşer.
function notlarOf(r) {
  if (Array.isArray(r.notlar)) return r.notlar;
  return r.not_metni ? [{ metin: r.not_metni }] : [];
}
// Tabloda: en yeni not TAM metin (teknisyene talimat — fareyle üzerine
// gelmeye bağlı kalmasın) + yazanın kısaltması + "+N not".
function notHucre(r) {
  const n = notlarOf(r);
  if (!n.length) return "";
  const son = n[0];
  const kim = son.yazan
    ? `<span class="note-by" title="${esc(son.yazan)} · ${esc(formatDateFull(son.zaman))}">${esc(son.kisaltma || initials(son.yazan))}</span>`
    : "";
  const fazla = n.length > 1 ? `<span class="note-more" title="Toplam ${n.length} not — tümü detay panelinde">+${n.length - 1} not</span>` : "";
  return `<span class="note-txt">${kim}${esc(son.metin)}${fazla}</span>`;
}

function updateCounts() {
  const totalEl = $("#totalN"); if (!totalEl) return;
  // Sayaçlar görünen kapsamı yansıtır: gizli eski Tamamlandı'lar sayılmaz.
  const kapsam = rows.filter((r) => !eskiGizli(r));
  totalEl.textContent = kapsam.length;
  ["all", "bekleyen", "cihazda", "tamamlandi"].forEach((f) => {
    const el = document.querySelector(`[data-c="${f}"]`);
    if (el) el.textContent = f === "all" ? kapsam.length : kapsam.filter((r) => r.durum === f).length;
  });
  $("#clearFiltersBtn")?.classList.toggle("hidden", !hasActiveFilters());

  // Eski kayıtlar: toggle + her zaman görünen sayaç ("nereye gitti" kalmasın).
  const kutu = $("#eskiKutu");
  if (kutu && eskiSinirMs !== null) {
    const n = eskileriGoster ? rows.filter(eskiMi).length : gizliEskiSayisi;
    kutu.classList.remove("hidden");
    const eb = $("#eskiBtn");
    eb.classList.toggle("hidden", n === 0 && !eskileriGoster);
    eb.classList.toggle("on", eskileriGoster);
    eb.textContent = eskileriGoster ? "Eski kayıtları gizle" : "Eski kayıtları göster";
    $("#eskiSayac").textContent = n === 0
      ? (eskileriGoster ? "Eski kayıt yok" : "Gizli eski kayıt yok")
      : eskileriGoster ? `${n} eski kayıt gösteriliyor` : `${n} eski kayıt gizli`;
  }
  // Arama yapılıyor ve eski kayıtlar gizliyse: aranan şey orada olabilir.
  const ip = $("#eskiIpucu");
  if (ip) {
    const goster = caseView === null && !eskileriGoster && gizliEskiSayisi > 0 && Boolean(searchQ || colFilters.pat || colFilters.blok);
    ip.classList.toggle("hidden", !goster);
    ip.innerHTML = goster
      ? `Aradığın burada yoksa: ${ESKI_GUN} günden eski <b>${gizliEskiSayisi}</b> tamamlanmış kayıt gizli. <button class="linkbtn" data-eski-goster>Eski kayıtları da göster</button>`
      : "";
  }
}

async function advance(kalemId, toDurum) {
  try {
    await Api.advanceDurum(kalemId, toDurum, session.id);
    await loadQueue();
  } catch (e) {
    toast("Durum güncellenemedi", true);
  }
}

// Durum geri alma — Tamamlandı→Cihazda, Cihazda→Bekleyen. Api.advanceDurum
// yön bağımsız (sadece durum günceller + istem_log'a satır düşer), bu yüzden
// aynı fonksiyon yeniden kullanılıyor; burada eklenen tek şey onay diyaloğu.
const REVERT_TO = { cihazda: "bekleyen", tamamlandi: "cihazda" };
async function revertDurum(r) {
  const fromDurum = r.durum, toDurum = REVERT_TO[fromDurum];
  if (!toDurum || !canRevert(r)) return;
  if (!confirm(`↺ Geri Al: "${PILL[fromDurum][1]}" → "${PILL[toDurum][1]}"\n\nOnaylıyor musun?`)) return;
  try {
    await Api.advanceDurum(r.kalem_id, toDurum, session.id);
    toast(`"${PILL[fromDurum][1]}" durumu geri alındı`);
    await loadQueue();
  } catch (e) {
    toast(e && e.code === "42501" ? "Bu kalemin durumunu geri alma yetkin yok" : "Durum geri alınamadı", true);
  }
}

// ---------------- Toplu aksiyonlar (İş Kuyruğu çoklu seçim) ----------------
function renderBulkBar() {
  const bar = $("#bulkBar");
  if (!bar) return;
  const n = bulkSelected.size;
  bar.classList.toggle("hidden", n === 0);
  if (n) $("#bulkCount").textContent = `${n} seçili`;
}

function summarize(prefix, ok, skipped, fail) {
  let msg = `${ok} ${prefix}, ${skipped} atlandı (uygun değildi)`;
  if (fail) msg += `, ${fail} başarısız`;
  toast(msg, ok === 0 && fail > 0);
}

// Cihaza Al / Tamamla — mevcut tekli advance() ile aynı primitif
// (Api.advanceDurum), sadece seçili+uygun (fromDurum'daki) kalemler için
// paralel çalıştırılır. İleri aksiyonlarda (tekli davranışla simetrik) onay
// istenmez.
async function bulkAdvance(toDurum, fromDurum) {
  const targets = rows.filter((r) => bulkSelected.has(r.kalem_id) && r.durum === fromDurum);
  const skipped = bulkSelected.size - targets.length;
  if (!targets.length) { toast("Uygun satır yok", true); return; }
  const results = await Promise.allSettled(targets.map((r) => Api.advanceDurum(r.kalem_id, toDurum, session.id)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  clearBulkSelection();
  await loadQueue();
  summarize("güncellendi", ok, skipped, results.length - ok);
}

// Geri Al — her satır KENDİ durumuna göre bir önceki adıma döner
// (REVERT_TO), tekli revertDurum ile aynı kural (canRevert); tek bir toplu onay.
async function bulkRevert() {
  const targets = rows.filter((r) => bulkSelected.has(r.kalem_id) && REVERT_TO[r.durum] && canRevert(r));
  const skipped = bulkSelected.size - targets.length;
  if (!targets.length) { toast("Uygun satır yok", true); return; }
  if (!confirm(`${targets.length} kaydın durumu geri alınsın mı?`)) return;
  const results = await Promise.allSettled(targets.map((r) => Api.advanceDurum(r.kalem_id, REVERT_TO[r.durum], session.id)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  clearBulkSelection();
  await loadQueue();
  summarize("güncellendi", ok, skipped, results.length - ok);
}

// Tekrar İste (toplu) — yalnız Cihazda/Tamamlandı kalemler; aynı kaynak
// istemden gelenler sunucuda TEK yeni istemde toplanır. Tek prompt: hem
// onay hem opsiyonel tekrar nedeni (yeni istem(ler)in notu).
async function bulkTekrar() {
  const targets = rows.filter((r) => bulkSelected.has(r.kalem_id) && (r.durum === "cihazda" || r.durum === "tamamlandi"));
  const skipped = bulkSelected.size - targets.length;
  if (!targets.length) { toast("Uygun satır yok — yalnız Cihazda/Tamamlandı kalemler tekrar istenebilir", true); return; }
  const neden = prompt(`${targets.length} kalem için tekrar istensin mi?${skipped ? ` (${skipped} uygun olmayan atlanacak)` : ""}\nAynı istemden gelenler tek yeni istemde toplanır.\n\nTekrar nedeni (opsiyonel, teknisyene not olarak gider):`, "");
  if (neden === null) return;
  try {
    const s = await Api.tekrarIsteToplu(targets.map((r) => r.kalem_id), neden.trim());
    clearBulkSelection();
    await loadQueue();
    const atlanan = skipped + Number(s?.atlanan || 0);
    toast(`${s?.kalem ?? targets.length} kalem tekrar istendi (${s?.istem ?? "?"} yeni istem)${atlanan ? `, ${atlanan} atlandı (uygun değildi)` : ""}`);
  } catch (e) {
    toast("Tekrar istenemedi", true);
  }
}

// Sil — tekli silmeyle aynı kural (canDeleteKalem): admin her kalemi
// (Tamamlandı dahil), diğerleri kendi istemindeki Tamamlandı olmayanları.
async function bulkDelete() {
  const targets = rows.filter((r) => bulkSelected.has(r.kalem_id) && canDeleteKalem(r));
  const skipped = bulkSelected.size - targets.length;
  if (!targets.length) { toast("Uygun satır yok", true); return; }
  const tamamlanan = targets.filter((r) => r.durum === "tamamlandi").length;
  const ek = tamamlanan ? `\n\nDİKKAT: ${tamamlanan} tanesi Tamamlandı durumunda (yönetici yetkisiyle siliniyor).` : "";
  if (!confirm(`${targets.length} kaydı silmek istediğinize emin misiniz? Bu geri alınamaz.${ek}`)) return;
  const results = await Promise.allSettled(targets.map((r) => Api.deleteIstemKalem(r.kalem_id)));
  const ok = results.filter((r) => r.status === "fulfilled").length;
  clearBulkSelection();
  await loadQueue(); // silinen satır o an detayda açıksa loadQueue kendi showEmpty()'yi tetikler
  summarize("silindi", ok, skipped, results.length - ok);
}

async function loadQueue() {
  const seq = ++queueSeq;
  const esik = Date.now() - ESKI_GUN * 86400000;
  const sinirISO = eskileriGoster ? null : new Date(esik).toISOString();
  let liste, gizli;
  try {
    [liste, gizli] = await Promise.all([
      Api.listQueue(sinirISO ? { eskiSinir: sinirISO } : {}),
      sinirISO ? Api.gizliEskiSayisi(sinirISO).catch(() => 0) : 0,
    ]);
  } catch (e) {
    if (seq === queueSeq) toast("İş kuyruğu yüklenemedi", true);
    return;
  }
  // Vaka görünümü açıksa o vakanın gizli eski kalemleri de (tüm geçmiş).
  const vaka = caseView;
  if (sinirISO && vaka !== null) {
    try { liste = mergeRows(liste, await Api.vakaKalemleri(vaka)); } catch (e) { /* yüklü olanlarla devam */ }
  }
  if (seq !== queueSeq) return; // bu arada daha yeni bir yükleme başladı
  rows = liste; gizliEskiSayisi = gizli; eskiSinirMs = esik;
  yeniIstemKontrol(liste);
  if (currentPage !== "kuyruk") return;
  renderTable();
  if (selId) {
    const cur = rows.find((r) => r.kalem_id === selId);
    // Detayda yazı yazılırken paneli yeniden çizmek imleci/odağı koparır —
    // yenileme, alan odaktan çıkınca yapılır (bkz. showDetail → blur).
    if (cur && detailEditing()) detailStale = true;
    else if (cur) showDetail(cur);
    else showEmpty();
  }
}

function detailEditing() {
  const a = document.activeElement;
  return Boolean(a && (a.id === "kaliteNot" || a.id === "yeniNot"));
}

// Detay panelindeki "Tekrar İste" — aynı test/klon/blok ile yeni bir
// Bekleyen kalem (ayrı bir istem kaydı olarak) kuyruğa düşer. prompt():
// hem onay (İptal = vazgeç) hem opsiyonel tekrar nedeni (yeni istemin notu).
async function tekrarIste(r) {
  const neden = prompt(`${r.patoloji_no} · ${r.blok_no || "—"} · ${r.test_adi}\n\nBu kalem için tekrar istensin mi?\nTekrar nedeni (opsiyonel, teknisyene not olarak gider):`, "");
  if (neden === null) return;
  try {
    const yeniId = await Api.tekrarIste(r.kalem_id, neden.trim());
    toast("Tekrar istendi — kuyruğa Bekleyen olarak eklendi");
    selId = yeniId || selId;
    await loadQueue();
  } catch (e) {
    toast("Tekrar istenemedi", true);
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
  if (yeniKalemler.delete(r.kalem_id)) renderYeniBildirim();
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

  // Son log kaydı bir geri alma ise (yeni_durum, eski_durum'dan geriyse)
  // şeffaflık için ayrı, göze çarpan bir not olarak gösterilir — sessizce
  // geçilmez.
  const lastLog = logs[logs.length - 1];
  const isRevert = lastLog && SORT_RANK.durum[lastLog.yeni_durum] < SORT_RANK.durum[lastLog.eski_durum];
  const revertNote = isRevert
    ? `<div class="revert-note">↩ ${esc(lastLog.kullanicilar?.ad_soyad || "Bilinmeyen kullanıcı")} tarafından ${formatDT(lastLog.created_at)} tarihinde "${esc(PILL[lastLog.eski_durum][1])}" durumu geri alındı.</div>`
    : "";

  const aktifCihazlar = CIHAZLAR.filter((c) => c.aktif || c.id === r.cihaz_id);

  // Tekrar ilişkisi: bu satır bir tekrarsa kaynağı, kaynak bir satırsa
  // kendisinden açılan tekrarlar (kuyrukta yüklü olanlar üzerinden).
  const kaynak = r.tekrar_kaynagi_id ? rows.find((x) => x.kalem_id === r.tekrar_kaynagi_id) : null;
  const tekrarlari = rows.filter((x) => x.tekrar_kaynagi_id === r.kalem_id);
  const tekrarInfo = r.tekrar_kaynagi_id
    ? `<div class="tekrar-info">${TEKRAR_BADGE} ${kaynak
        ? `Kaynak kalem: <a href="#" data-goto="${kaynak.kalem_id}">${formatDT(kaynak.created_at)} · ${esc(PILL[kaynak.durum]?.[1] || kaynak.durum)}</a>`
        : !eskileriGoster
          ? "Kaynak kalem listede yok (30 günden eski tamamlanmış ya da silinmiş olabilir — patoloji no'ya tıklayınca vaka geçmişinde görünür)."
          : "Kaynak kalem artık kuyrukta yok."}</div>`
    : tekrarlari.length
      ? `<div class="tekrar-info">Bu kalem için ${tekrarlari.length} kez tekrar istendi: ${tekrarlari
          .map((t) => `<a href="#" data-goto="${t.kalem_id}">${formatDT(t.created_at)}</a>`).join(", ")}</div>`
      : "";
  const canTekrar = r.durum === "cihazda" || r.durum === "tamamlandi";
  const kaliteVal = kaliteDrafts.has(r.kalem_id) ? kaliteDrafts.get(r.kalem_id) : (r.kalite_notu || "");
  // Notlar istem düzeyindedir (istemin tüm kalemlerinde ortak); düzenleme
  // yok, yazan kendi notunu / yönetici her notu siler.
  const notlar = notlarOf(r);
  const notDraft = notDrafts.get(r.istem_id) || "";
  const notlarHTML = notlar.length
    ? notlar.map((n) => `<div class="not-item">
        <div class="not-meta"><b>${esc(n.yazan || "—")}</b>${n.zaman ? ` · ${formatDateFull(n.zaman)}` : ""}
          ${n.id && (isAdmin() || n.yazan_id === session.id) ? `<button class="not-sil" data-not-sil="${n.id}" title="Notu sil" aria-label="Notu sil">×</button>` : ""}</div>
        <div class="not-metin">${esc(n.metin)}</div>
      </div>`).join("")
    : `<div class="not-bos">Henüz not yok.</div>`;

  $("#detailBody").innerHTML = `
    <div class="d-pat">${esc(r.patoloji_no)}</div><div class="d-blok">${esc(r.blok_no)}</div>
    <div class="d-test"><div class="n">${esc(r.test_adi)}</div>${r.klon ? `<div class="c">Klon ${esc(r.klon)}</div>` : ""}</div>
    ${tekrarInfo}
    ${canTekrar ? `<div class="m-sec"><button class="btn-ghost btn-sm" id="tekrarBtn" style="width:100%">↻ Tekrar İste</button></div>` : ""}
    <div class="d-grid">
      <div><div class="k">Tip</div><div class="v">${tipTag(r.grup)}</div></div>
      <div><div class="k">Öncelik</div><div class="v"><span class="prio ${PRIO[r.oncelik][0]}">${PRIO[r.oncelik][1]}</span></div></div>
      <div><div class="k">İsteyen</div><div class="v pchip">${r.isteyen_adi ? avatarHTML({ id: r.istem_yapan_id, ad: r.isteyen_adi }, "av-sm") : ""}<span>${esc(r.isteyen_adi || "—")}</span></div></div>
      <div><div class="k">Uzman adına</div><div class="v pchip">${r.uzman_adi ? avatarHTML({ ad: r.uzman_adi }, "av-sm") : ""}<span>${esc(r.uzman_adi || "—")}</span></div></div>
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
    ${revertNote}
    <div class="m-label">Notlar${notlar.length ? ` (${notlar.length})` : ""}</div>
    <div class="notlar">${notlarHTML}</div>
    <textarea id="yeniNot" placeholder="Not ekle — bu istemin tüm kalemlerinde görünür…">${esc(notDraft)}</textarea>
    <div style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="btn-ghost btn-sm" id="notEkleBtn" ${notDraft.trim() ? "" : "disabled"}>Not Ekle</button>
    </div>
    <div class="m-label" style="margin-top:18px">Kalite Değerlendirmesi</div>
    <textarea id="kaliteNot" placeholder="Boyanın kalitesi — ör. zemin boyanması, zayıf boyanma, doku kalkması…">${esc(kaliteVal)}</textarea>
    <div style="display:flex;justify-content:flex-end;margin-top:6px">
      <button class="btn-ghost btn-sm" id="kaliteSaveBtn" ${kaliteVal === (r.kalite_notu || "") ? "disabled" : ""}>Kaydet</button>
    </div>`;

  $$("#detailBody [data-goto]").forEach((a) => {
    a.onclick = (e) => {
      e.preventDefault();
      const hedef = rows.find((x) => x.kalem_id === a.dataset.goto);
      if (hedef) showDetail(hedef);
    };
  });
  if (canTekrar) $("#tekrarBtn").onclick = () => tekrarIste(r);

  const kaliteEl = $("#kaliteNot"), kaliteBtn = $("#kaliteSaveBtn");
  kaliteEl.addEventListener("input", () => {
    const dirty = kaliteEl.value !== (r.kalite_notu || "");
    if (dirty) kaliteDrafts.set(r.kalem_id, kaliteEl.value); else kaliteDrafts.delete(r.kalem_id);
    kaliteBtn.disabled = !dirty;
  });
  kaliteEl.addEventListener("blur", () => {
    // Kaydedilmemiş taslak varsa yeniden çizme: kullanıcı büyük ihtimalle
    // Kaydet'e basıyor ve paneli şimdi yeniden kurmak butonu tıklama
    // gerçekleşmeden DOM'dan söker (Safari'de buton odak almadığı için
    // relatedTarget'a da güvenilemez). Kaydetme akışı zaten yeniler.
    if (!detailStale || kaliteDrafts.has(r.kalem_id) || notDrafts.has(r.istem_id)) return;
    detailStale = false;
    const cur = rows.find((x) => x.kalem_id === r.kalem_id);
    if (cur && selId === r.kalem_id) showDetail(cur);
  });
  kaliteBtn.onclick = async () => {
    kaliteBtn.disabled = true;
    try {
      await Api.updateKaliteNotu(r.kalem_id, kaliteEl.value.trim());
      kaliteDrafts.delete(r.kalem_id);
      detailStale = false;
      toast("Kalite notu kaydedildi");
      await loadQueue();
    } catch (err) {
      kaliteBtn.disabled = false;
      toast("Kalite notu kaydedilemedi", true);
    }
  };

  // Yeni not — kalite notuyla aynı taslak/erteleme deseni (bkz. yukarısı).
  const notEl = $("#yeniNot"), notBtn = $("#notEkleBtn");
  notEl.addEventListener("input", () => {
    if (notEl.value) notDrafts.set(r.istem_id, notEl.value); else notDrafts.delete(r.istem_id);
    notBtn.disabled = !notEl.value.trim();
  });
  notEl.addEventListener("blur", () => {
    if (!detailStale || notDrafts.has(r.istem_id) || kaliteDrafts.has(r.kalem_id)) return;
    detailStale = false;
    const cur = rows.find((x) => x.kalem_id === r.kalem_id);
    if (cur && selId === r.kalem_id) showDetail(cur);
  });
  notBtn.onclick = async () => {
    const metin = notEl.value.trim();
    if (!metin) return;
    notBtn.disabled = true;
    try {
      await Api.notEkle(r.istem_id, session.id, metin);
      notDrafts.delete(r.istem_id);
      detailStale = false;
      toast("Not eklendi");
      await loadQueue();
    } catch (err) {
      notBtn.disabled = false;
      toast("Not eklenemedi", true);
    }
  };
  $$("#detailBody [data-not-sil]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Bu not silinsin mi? Geri alınamaz.")) return;
      try {
        await Api.notSil(b.dataset.notSil);
        toast("Not silindi");
        await loadQueue();
      } catch (err) {
        toast(err && err.isForbidden ? "Bu notu silme yetkin yok" : "Not silinemedi", true);
      }
    };
  });

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
  const revertTo = canRevert(r) ? REVERT_TO[r.durum] || null : null;
  const canDelete = canDeleteKalem(r);
  if (canDelete || advLabel || revertTo) {
    rail.insertAdjacentHTML("beforeend", `<div class="rail-foot">
      ${canDelete ? `<button class="btn-ghost" id="delIstemBtn">Sil</button>` : ""}
      ${revertTo ? `<button class="btn-ghost" id="revertBtn">↩ Geri Al</button>` : ""}
      ${advLabel ? `<button class="btn-primary" id="advBtn">${advLabel}</button>` : ""}
    </div>`);
    if (toDurum) $("#advBtn").onclick = () => advance(r.kalem_id, toDurum);
    if (revertTo) $("#revertBtn").onclick = () => revertDurum(r);
    if (canDelete) {
      const label = `${r.patoloji_no} — ${r.test_adi}${r.durum === "tamamlandi" ? " (Tamamlandı — yönetici yetkisiyle)" : ""}`;
      $("#delIstemBtn").onclick = () => confirmAndDelete(label, () => Api.deleteIstemKalem(r.kalem_id), async () => {
        toast("Kalem silindi");
        kaliteDrafts.delete(r.kalem_id);
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
      <div class="antisearch">${SEARCH_ICON}
        <input id="setSearch" placeholder="Set ara…"></div>
      <div class="sets" id="sets"></div></div>
    <div class="m-sec" id="mySetsSec"><p class="m-label">Şablonlar</p><div class="sets" id="mySets"></div></div>` : ""}
    <div class="m-sec" id="antiSec"><p class="m-label">Tek Tek Seç <button type="button" class="bulkpick-toggle" id="bulkPickToggle">Toplu Seç</button></p>
      <div class="antisearch">${SEARCH_ICON}
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

// Kendi şablonların + başkalarının herkese açık şablonları (kendi
// şablonların önce — bkz. Api.getSablonlar). Başkasınınki sahibinin adıyla.
function renderMySets() {
  const s = $("#mySets"); if (!s) return;
  const list = SETS_SABLON[grp] || [];
  $("#mySetsSec").style.display = list.length ? "" : "none";
  s.innerHTML = "";
  list.forEach((set) => {
    const el = document.createElement("button");
    el.className = "set";
    const baskasi = set.sahip_id !== session.id;
    el.textContent = set.ad;
    if (baskasi) {
      el.classList.add("set-shared");
      el.title = `Herkese açık — ${set.sahip_adi}`;
    }
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
  // Teknisyen sıfırdan istem giremez (RLS de reddeder) — tek yolu "Tekrar İste".
  if (!canCreateIstem()) { toast("Teknisyen yeni istem giremez — mevcut bir kalem için \"Tekrar İste\"yi kullanın", true); return; }
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
          <button type="button" class="scan" id="scanBtn" title="Kameradan oku (lam etiketi)" aria-label="Patoloji No'yu kameradan oku"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg></button></div>
        <div class="ocr-not hidden" id="mPatOcr">Kameradan okundu — İstek Ver'den önce kontrol edin.</div></div>
      ${pickerSectionsHTML({ withQuickFill: true })}
      <div class="m-sec"><p class="m-label">Blok Seçimi <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— manuel, opsiyonel</span></p>
        <div class="blocks" id="blocks"><input class="bin" id="blockin" placeholder="+ blok"></div></div>
      <div class="m-sec"><p class="m-label">Öncelik</p>
        <div class="prios" id="prios"><button class="on" data-p="rutin">Rutin</button><button data-p="acil">Acil</button><button data-p="stat">STAT</button></div></div>
      <div class="m-sec" style="margin-bottom:2px"><p class="m-label">Not</p><textarea id="mNot" placeholder="Teknisyene not…"></textarea></div>
    </div>
    <div class="rail-foot"><button class="btn-ghost" id="cancelForm">İptal</button><button class="btn-primary" id="submitForm">İstek Ver</button></div>`;

  $("#closeForm").onclick = showEmpty;
  // Kameradan OCR (ocr.js): sonuç ancak kullanıcı "Kullan" deyince alana
  // yazılır; alan düzenlenebilir kalır, form kendiliğinden gönderilmez.
  // Blok No'ya dokunulmaz.
  $("#scanBtn").onclick = () => {
    if (!window.PatolojiOCR) { toast("Tarama bileşeni yüklenemedi — Patoloji No'yu elle girin", true); return; }
    PatolojiOCR.ac({
      onSonuc: (deger) => {
        const inp = $("#mPat");
        if (!inp) return; // form bu arada kapatıldı
        inp.value = deger;
        inp.classList.add("ocr-dolu");
        $("#mPatOcr").classList.remove("hidden");
        inp.focus();
      },
      // "Elle Gir": kamera kapanır, doğrudan Patoloji No alanında yazmaya devam edilir.
      onElle: () => {
        const inp = $("#mPat");
        if (!inp) return;
        inp.focus();
        inp.select();
      },
    });
  };
  $("#mPat").addEventListener("input", () => {
    $("#mPat").classList.remove("ocr-dolu");
    $("#mPatOcr").classList.add("hidden");
  });
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
      ${canManageSets() ? `<button class="btn-primary btn-sm" id="newSetBtn">+ Yeni Set</button>` : ""}
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
  if (canManageSets()) $("#newSetBtn").onclick = () => showSetForm(null);

  renderSetGrid();
}

// Setleri teknisyen dışında herkes ekler/düzenler/siler (RLS de öyle).
// Teknisyen sadece görür — pasif setler (yalnızca düzenleyende anlamlı)
// ona gösterilmez; sıfırdan istem giremediği için "İstek Ver" de
// gösterilmez (bkz. canCreateIstem).
function renderSetGrid() {
  const grid = $("#setGrid"); if (!grid) return;
  const manage = canManageSets();
  const list = ISTEK_SETLERI.filter((s) =>
    (manage || s.aktif) &&
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
      <div class="btnrow">${s.aktif && canCreateIstem() ? `<button class="btn-primary" data-act="ver">İstek Ver</button>` : ""}${manage ? `<button class="btn-ghost" data-act="duzenle">Düzenle</button>` : ""}</div>
    </div>`).join("");
  grid.querySelectorAll(".tile").forEach((tile) => {
    const find = () => list.find((s) => s.id === tile.dataset.id);
    const verBtn = tile.querySelector('[data-act="ver"]');
    if (verBtn) verBtn.onclick = (e) => { e.stopPropagation(); showForm(find()); };
    const duzBtn = tile.querySelector('[data-act="duzenle"]');
    if (duzBtn) duzBtn.onclick = (e) => { e.stopPropagation(); showSetForm(find()); };
  });
}

async function refreshIstekSetleri() {
  ISTEK_SETLERI = await Api.getIstekSetleri();
  SETS_INST = activeSetsInst(ISTEK_SETLERI);
}

function showSetForm(existing) {
  if (!canManageSets()) return;
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
// ŞABLONLAR (kişisel / herkese açık — teknisyen erişemez)
// ================================================================
function renderSablonlarPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Şablonlar</h1>
      <div class="sub">Kendi test kombinasyonların ve başkalarının herkese açık paylaştıkları — Yeni İstek formunda hızlıca kullanılır.</div>
      <div class="spacer"></div>
      <button class="btn-primary btn-sm" id="newSablonBtn">+ Yeni Şablon</button>
    </div>
    <div class="sablonpage" id="sablonPage"></div>`;
  $("#newSablonBtn").onclick = () => showSablonForm(null);
  renderSablonGrid();
}

function sablonTileHTML(s) {
  const mine = s.sahip_id === session.id;
  const vis = s.herkese_acik
    ? `<span class="vis-badge acik">Herkese açık</span>`
    : `<span class="vis-badge ozel">Sadece bana özel</span>`;
  const btns = [
    canCreateIstem() ? `<button class="btn-primary" data-act="ver">İstek Ver</button>` : "",
    canEditSablon(s) ? `<button class="btn-ghost" data-act="duzenle">Düzenle</button>` : "",
  ].join("");
  return `
    <div class="tile${canEditSablon(s) ? "" : " tile-ro"}" data-id="${s.id}">
      <div class="nm">${esc(s.ad)}</div>
      <div class="meta">${TIP[s.grup] || "Diğer"}${mine ? "" : ` · ${esc(s.sahip_adi)}`} ${vis}</div>
      <div class="chips">${s.testler.length ? s.testler.map((t) => `<span class="chip">${esc(t.ad)}</span>`).join("") : '<span class="chip">—</span>'}</div>
      <div class="btnrow">${btns}</div>
    </div>`;
}

function renderSablonGrid() {
  const page = $("#sablonPage"); if (!page) return;
  const mine = SABLONLAR.filter((s) => s.sahip_id === session.id);
  const shared = SABLONLAR.filter((s) => s.sahip_id !== session.id);
  page.innerHTML = `
    <p class="gridlabel">Şablonlarım</p>
    <div class="tilegrid">${mine.length
      ? mine.map(sablonTileHTML).join("")
      : `<div class="empty" style="grid-column:1/-1"><div class="t">Henüz şablonun yok</div><div class="d">"+ Yeni Şablon" ile ilk kombinasyonunu oluştur.</div></div>`}</div>
    ${shared.length ? `<p class="gridlabel">Herkese açık (diğer kullanıcılar)</p><div class="tilegrid">${shared.map(sablonTileHTML).join("")}</div>` : ""}`;
  page.querySelectorAll(".tile").forEach((tile) => {
    const find = () => SABLONLAR.find((s) => s.id === tile.dataset.id);
    const verBtn = tile.querySelector('[data-act="ver"]');
    if (verBtn) verBtn.onclick = (e) => { e.stopPropagation(); showForm(find()); };
    const duzBtn = tile.querySelector('[data-act="duzenle"]');
    if (duzBtn) {
      duzBtn.onclick = (e) => { e.stopPropagation(); showSablonForm(find()); };
      tile.onclick = () => showSablonForm(find());
    }
  });
}

function showSablonForm(existing) {
  if (isTeknisyen() || (existing && !canEditSablon(existing))) return;
  grp = existing ? existing.grup : "ihc";
  let herkeseAcik = existing ? existing.herkese_acik : false;
  selectedTests = new Map(); customItems = [];
  if (existing) existing.testler.forEach((t) => {
    if (t.custom) customItems.push({ ad: t.ad, sel: true, grup: t.grup });
    else selectedTests.set(t.id, { ad: t.ad, klon: t.klon, grup: t.grup });
  });

  const rail = $("#rail");
  rail.innerHTML = `
    <div class="rail-head"><h2>${existing ? "Şablonu Düzenle" : "Yeni Şablon"}</h2><button class="rx" id="closeSablon">×</button></div>
    <div class="rail-body">
      ${existing && existing.sahip_id !== session.id ? `<div class="m-sec"><p class="m-label">Sahibi</p><div class="v" style="font-size:13px">${esc(existing.sahip_adi)} <span style="color:var(--ink-3)">— yönetici olarak düzenliyorsun</span></div></div>` : ""}
      <div class="m-sec"><p class="m-label">Ad</p><input class="finput" id="sablonAd" value="${existing ? esc(existing.ad) : ""}" placeholder="ör. fd meme 1"></div>
      <div class="m-sec"><p class="m-label">Görünürlük</p>
        <div class="segs" id="sablonVis">
          <button type="button" data-vis="ozel" class="${herkeseAcik ? "" : "on"}">Sadece bana özel</button>
          <button type="button" data-vis="acik" class="${herkeseAcik ? "on" : ""}">Herkese açık</button>
        </div></div>
      ${pickerSectionsHTML({ withQuickFill: false })}
    </div>
    <div class="rail-foot">
      ${existing ? `<button class="btn-danger" id="delSablon">Sil</button>` : `<button class="btn-ghost" id="cancelSablon">İptal</button>`}
      <button class="btn-primary" id="saveSablon">${existing ? "Kaydet" : "Oluştur"}</button>
    </div>`;

  $("#closeSablon").onclick = showEmpty;
  if (existing) $("#delSablon").onclick = () => confirmAndDelete(existing.ad, () => Api.deleteSablon(existing.id), afterSablonChange("Şablon silindi"));
  else $("#cancelSablon").onclick = showEmpty;
  $("#sablonVis").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-vis]"); if (!b) return;
    herkeseAcik = b.dataset.vis === "acik";
    $$("#sablonVis button").forEach((x) => x.classList.toggle("on", x === b));
  });

  $$("#groups button").forEach((b) => b.classList.toggle("on", b.dataset.g === grp));
  bindPicker(false);

  $("#saveSablon").onclick = async () => {
    const ad = $("#sablonAd").value.trim();
    if (!ad) { toast("Ad girin", true); return; }
    const testler = collectPickedTestler();
    if (!testler.length) { toast("En az bir test seçin", true); return; }
    $("#saveSablon").disabled = true;
    try {
      if (existing) await Api.updateSablon(existing.id, { ad, grup: grp, herkese_acik: herkeseAcik, testler });
      else await Api.createSablon({ sahip_id: session.id, grup: grp, ad, herkese_acik: herkeseAcik, testler });
      await afterSablonChange(existing ? "Şablon güncellendi" : "Şablon oluşturuldu")();
    } catch (e) {
      toast(e && e.isForbidden ? e.message : "Kaydedilemedi", true);
    } finally {
      const btn = $("#saveSablon"); if (btn) btn.disabled = false;
    }
  };
}

function afterSablonChange(msg) {
  return async () => {
    toast(msg);
    await refreshSablonlar();
    showEmpty();
    if (currentPage === "sablonlar") renderSablonlarPage();
  };
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
const HIZ_SORT_FIELD = { pat: "patoloji_no", isteyen: "isteyen_adi", uzman: "uzman_adi", tarih: "created_at" };
// Üç bölüm: Bekleyen = faturası girilmemiş (tekrar olmayan) istemler;
// Tekrarlar = tüm tekrar istemleri (fatura durumundan bağımsız);
// Girilmiş = faturası girilmiş (tekrar olmayan) istemler.
const HIZ_SEKMELER = [["bekleyen", "Bekleyen"], ["tekrar", "Tekrarlar"], ["girilmis", "Girilmiş"]];
let hizSekme = "bekleyen";
function hizSekmesi(h) {
  return h.tekrar ? "tekrar" : h.fatura_girildi ? "girilmis" : "bekleyen";
}

function hizOzetSayilar(h) {
  return h.ozet.length ? h.ozet.map((o) => `${o.count} ${TIP[o.grup] || "Diğer"}`).join(", ") : "—";
}
// Özet sütunu filtresi "tekrar" yazarak tekrar istemlerini de bulabilsin.
function hizOzetTxt(h) {
  return h.tekrar ? `${hizOzetSayilar(h)} (tekrar)` : hizOzetSayilar(h);
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
  if (hizColFilters.isteyen && !`${h.isteyen_adi || ""} ${h.isteyen_kisaltma || ""}`.toLowerCase().includes(hizColFilters.isteyen)) return false;
  if (hizColFilters.uzman && !`${h.uzman_adi || ""} ${h.uzman_kisaltma || ""}`.toLowerCase().includes(hizColFilters.uzman)) return false;
  if (hizColFilters.ozet && !hizOzetTxt(h).toLowerCase().includes(hizColFilters.ozet)) return false;
  return true;
}
function hizCompareForSort(a, b, col) {
  const field = HIZ_SORT_FIELD[col];
  return String(a[field] ?? "").localeCompare(String(b[field] ?? ""), "tr", { numeric: true });
}
// Excel export'unun "Görünenler" seçeneği ve renderHizTable bunu kullanır.
function getVisibleHizmetler() {
  let list = hizmetlerList.filter((h) => hizSekmesi(h) === hizSekme && hizPassesFilter(h));
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
  { label: "Tekrar", value: (h) => (h.tekrar ? "Evet" : "") },
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
    <div class="barrow">
      <div class="tabs" id="hizTabs">
        ${HIZ_SEKMELER.map(([k, l]) => `<button class="${hizSekme === k ? "on" : ""}" data-hs="${k}">${l} <span class="count" data-hc="${k}">0</span></button>`).join("")}
      </div>
    </div>
    <div class="tablewrap">
      <table>
        <thead id="hizhead"></thead>
        <tbody id="hizRows"></tbody>
      </table>
    </div>`;

  bindExportMenu("#hizExport", (which) => {
    const list = which === "tum" ? hizmetlerList : getVisibleHizmetler();
    exportToExcel(list, HIZMETLER_EXPORT_COLS, which === "tum" ? "istem_hizmetler" : `istem_hizmetler_${hizSekme}`);
  });
  $("#hizTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-hs]"); if (!b) return;
    hizSekme = b.dataset.hs;
    $$("#hizTabs button").forEach((x) => x.classList.toggle("on", x.dataset.hs === hizSekme));
    renderHizTable();
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
    ${thSortOnly("tarih", "Tarih", sortOf("tarih"))}
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
  HIZ_SEKMELER.forEach(([k]) => {
    const el = document.querySelector(`[data-hc="${k}"]`);
    if (el) el.textContent = hizmetlerList.filter((h) => hizSekmesi(h) === k).length;
  });
  const list = getVisibleHizmetler();
  if (!list.length) {
    tb.innerHTML = `<tr class="bos-satir"><td colspan="6">${hizHasActiveFilters() ? "Filtreye uyan kayıt yok." : "Bu bölümde kayıt yok."}</td></tr>`;
  }
  list.forEach((h) => {
    const tr = document.createElement("tr");
    const act = h.fatura_girildi
      ? `<span style="color:var(--ink-3);font-size:12px">✓ ${esc(h.fatura_giren_adi || "—")} · ${formatDT(h.fatura_zamani)}</span>`
      : `<button class="act" data-hiz="${h.istem_id}">Gir</button>`;
    tr.innerHTML = `<td class="c-pat" data-pat="${esc(h.patoloji_no)}" style="cursor:pointer">${esc(h.patoloji_no)}</td>
      ${kisiTd(h.isteyen_adi, h.isteyen_kisaltma)}
      ${kisiTd(h.uzman_adi === "—" ? null : h.uzman_adi, h.uzman_kisaltma)}
      <td>${esc(hizOzetSayilar(h))}${h.tekrar ? TEKRAR_BADGE : ""}</td>
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
      ${avatarHTML({ id: u.id, ad: u.ad_soyad }, "av-sm av-md")}
      <div><div class="nm">${esc(u.ad_soyad)}${u.kisaltma ? ` <span class="kisa-chip">${esc(u.kisaltma)}</span>` : ""}</div><div class="tip">${esc(ROL_LABEL[u.rol] || u.rol)}${u.is_admin ? " · Yönetici" : ""}${!u.auth_user_id ? " · Auth hesabı yok" : ""}</div></div>
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
      <div class="m-sec"><p class="m-label">Kısaltma <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— İş Kuyruğu'nda İsteyen / Uzman Adına'da görünür; opsiyonel, benzersiz</span></p><input class="finput" id="kKisa" value="${existing ? esc(existing.kisaltma || "") : ""}" placeholder="ör. FD" maxlength="10" autocomplete="off"></div>
      <div class="m-sec"><p class="m-label">Rol</p>
        <select class="finput" id="kRol">
          <option value="uzman" ${existing && existing.rol === "uzman" ? "selected" : ""}>Uzman Patolog</option>
          <option value="asistan" ${existing && existing.rol === "asistan" ? "selected" : ""}>Asistan</option>
          <option value="teknisyen" ${existing && existing.rol === "teknisyen" ? "selected" : ""}>Teknisyen</option>
        </select></div>
      <div class="m-sec"><label class="chkrow"><input type="checkbox" id="kAdmin" ${existing && existing.is_admin ? "checked" : ""} ${existing && existing.id === session.id ? "disabled" : ""}> Yönetici <span style="color:var(--ink-3);font-weight:400">— Yönetim sayfaları, her kalemi silme, tüm şablon/setleri düzenleme</span></label>
        ${existing && existing.id === session.id ? `<div class="v" style="font-size:12px;color:var(--ink-3);margin-top:4px">Kendi yönetici yetkini kaldıramazsın (kilitlenmeyi önlemek için) — başka bir yönetici kaldırabilir.</div>` : ""}</div>
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
    const kisaltma = $("#kKisa").value.trim();
    // Benzersizlik veritabanında da var (kullanicilar_kisaltma_uniq); burada
    // önceden bakmak, yeni kullanıcıda Auth hesabı açıldıktan sonra
    // kayıt hatası almayı (yetim Auth hesabını) önler.
    const cakisan = kisaltma && KULLANICILAR_LIST.find((u) => u.id !== existing?.id && (u.kisaltma || "").toLowerCase() === kisaltma.toLowerCase());
    if (cakisan) { toast(`"${kisaltma}" kısaltması zaten ${cakisan.ad_soyad} için kullanılıyor`, true); return; }
    // Kendi satırında kutu kilitli — değer her zaman mevcut hali (true) kalır.
    const is_admin = existing && existing.id === session.id ? existing.is_admin : $("#kAdmin").checked;
    $("#saveKullanici").disabled = true;
    try {
      if (existing) {
        await Api.updateKullanici(existing.id, { ad_soyad, kisaltma, rol, is_admin });
      } else {
        const pin = $("#kPin").value.trim();
        if (!pin) { toast("PIN girin", true); $("#saveKullanici").disabled = false; return; }
        await Api.createKullanici({ ad_soyad, kisaltma, rol, is_admin, pin });
      }
      toast(existing ? "Kullanıcı güncellendi" : "Kullanıcı eklendi");
      UZMANLAR = await Api.getUzmanlar();
      await loadKullanicilar();
      showEmpty();
    } catch (e) {
      toast(e && e.code === "23505" && /kisaltma/.test(e.message || "") ? "Bu kısaltma başka bir kullanıcıda var" : "Kaydedilemedi", true);
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

// ---------------- Görünüm: tema / mod / tablo yoğunluğu ----------------
// Tercihin kendisi tema.js'te (Tema.*) — localStorage'da kullanıcı başına.
// Burası sadece kontrolleri (A−/A+ ve sol alttaki ayarlar paneli) çizer.
const MOD_LABEL = [["acik", "Açık"], ["koyu", "Koyu"], ["sistem", "Sistem"]];
const YOG_LABEL = [["kompakt", "Kompakt"], ["normal", "Normal"], ["genis", "Geniş"]];

function renderZoomCtl() {
  const box = $("#zoomCtl");
  if (!box || !window.Tema) return;
  const cur = Tema.get().yogunluk;
  const i = Tema.YOGUNLUKLAR.indexOf(cur);
  box.querySelector(".lvl").innerHTML = Tema.YOGUNLUKLAR.map((_, j) => `<i class="${j === i ? "on" : ""}"></i>`).join("");
  box.querySelector('[data-zoom="-1"]').disabled = i <= 0;
  box.querySelector('[data-zoom="1"]').disabled = i >= Tema.YOGUNLUKLAR.length - 1;
  box.title = `Tablo yoğunluğu: ${(YOG_LABEL.find(([k]) => k === cur) || [])[1] || cur}`;
}

function renderPrefs() {
  const el = $("#prefsPanel");
  if (!el || !window.Tema) return;
  const p = Tema.get();
  const mod = document.documentElement.dataset.mod === "koyu" ? "koyu" : "acik";
  const segs = (attr, opts, val) => opts.map(([k, l]) =>
    `<button type="button" data-${attr}="${k}" class="${k === val ? "on" : ""}" aria-pressed="${k === val}">${l}</button>`).join("");
  const profil = session ? `
    <div class="m-sec"><p class="m-label">Profil</p>
      <div class="prof-row">
        ${avatarHTML({ id: session.id, ad: session.ad_soyad }, "av")}
        <div class="prof-acts">
          <label class="btn-ghost btn-sm" for="avatarFile">Fotoğraf Yükle</label>
          <input type="file" id="avatarFile" accept="image/jpeg,image/png" hidden>
          ${session.avatar_url ? `<button type="button" class="btn-ghost btn-sm" data-avatar-kaldir>Fotoğrafı Kaldır</button>` : ""}
        </div>
      </div>
      <button type="button" class="linkbtn" data-pin-ac aria-expanded="${prefsPinOpen}">PIN'imi Değiştir</button>
      ${prefsPinOpen ? `
      <form class="pinform" id="pinForm" autocomplete="off" novalidate>
        <input class="finput pinmask" id="pinEski" type="text" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="Eski PIN" aria-label="Eski PIN">
        <input class="finput pinmask" id="pinYeni" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="Yeni PIN (4 hane)" aria-label="Yeni PIN">
        <input class="finput pinmask" id="pinYeni2" type="text" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="Yeni PIN (tekrar)" aria-label="Yeni PIN tekrar">
        <div class="err" id="pinErr" role="alert"></div>
        <div class="btnrow"><button type="button" class="btn-ghost btn-sm" data-pin-kapat>Vazgeç</button><button type="submit" class="btn-primary btn-sm" id="pinKaydet">Kaydet</button></div>
      </form>` : ""}
    </div>` : "";
  el.innerHTML = `${profil}
    <div class="m-sec"><p class="m-label">Tema</p>
      <div class="temalar">${Tema.TEMALAR.map((t) => `
        <button type="button" class="tema-opt ${t.id === p.tema ? "on" : ""}" data-tema-sec="${t.id}" aria-pressed="${t.id === p.tema}">
          <span class="sw" style="background:${t.renk[mod]}"></span>${esc(t.ad)}</button>`).join("")}</div></div>
    <div class="m-sec"><p class="m-label">Mod</p><div class="segs">${segs("mod-sec", MOD_LABEL, p.mod)}</div></div>
    <div class="m-sec"><p class="m-label">Tablo yoğunluğu</p><div class="segs">${segs("yog-sec", YOG_LABEL, p.yogunluk)}</div></div>
    ${session ? `<div class="m-sec"><p class="m-label">Yeni istem sesi</p><div class="segs">${segs("ses-sec", [["acik", "Açık"], ["kapali", "Kapalı"]], sesAcik() ? "acik" : "kapali")}</div></div>` : ""}`;
}

// ---------------- Kendi profilim: PIN + fotoğraf (herkes, sadece kendi hesabı) ----------------
let prefsPinOpen = false;

async function handlePinSubmit() {
  const eski = $("#pinEski").value.trim(), yeni = $("#pinYeni").value.trim(), yeni2 = $("#pinYeni2").value.trim();
  const hata = (m) => { $("#pinErr").textContent = m; };
  if (!/^\d{4,6}$/.test(eski)) return hata("Eski PIN'inizi girin");
  if (!/^\d{4}$/.test(yeni)) return hata("Yeni PIN 4 haneli bir sayı olmalı");
  if (yeni !== yeni2) return hata("Yeni PIN'ler eşleşmiyor");
  if (yeni === eski) return hata("Yeni PIN eskisiyle aynı olamaz");
  hata("");
  $("#pinKaydet").disabled = true;
  try {
    await Api.changePin(eski, yeni);
    prefsPinOpen = false;
    renderPrefs();
    toast("PIN güncellendi — oturumunuz açık kalıyor; bir sonraki girişte yeni PIN'i kullanın");
  } catch (e) {
    if ($("#pinErr")) {
      hata(e && e.isWrongPin ? "Eski PIN hatalı"
        : e && e.code === "same_password" ? "Yeni PIN eskisiyle aynı olamaz"
        : `PIN güncellenemedi${e && e.message ? ` (${e.message})` : ""}`);
      $("#pinKaydet").disabled = false;
    }
  }
}

// Seçilen fotoğrafı ortadan kare kırpıp 256×256 JPEG'e küçültür (tarayıcıda).
// createImageBitmap EXIF yönünü uygular; desteklemeyen tarayıcıda <img>'e düşer.
async function kareKirp(file, size = 256) {
  let src, objUrl = null;
  try {
    src = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    objUrl = URL.createObjectURL(file);
    src = await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = objUrl; });
  }
  const w = src.width, h = src.height, k = Math.min(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // saydam PNG → beyaz zemin (JPEG saydamlık taşımaz)
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(src, (w - k) / 2, (h - k) / 2, k, k, 0, 0, size, size);
  if (objUrl) URL.revokeObjectURL(objUrl);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Görüntü işlenemedi"))), "image/jpeg", 0.86));
}

async function handleAvatarFile(file) {
  if (!file) return;
  if (!["image/jpeg", "image/png"].includes(file.type)) { toast("Sadece JPG veya PNG yükleyebilirsiniz", true); return; }
  if (file.size > 2 * 1024 * 1024) { toast("Fotoğraf en fazla 2 MB olabilir", true); return; }
  toast("Fotoğraf yükleniyor…");
  try {
    const blob = await kareKirp(file);
    session.avatar_url = await Api.uploadAvatar(blob, session.avatar_url);
    await refreshAvatarlar();
    renderMe();
    renderPrefs();
    toast("Fotoğraf güncellendi");
  } catch (e) {
    toast("Fotoğraf yüklenemedi", true);
  }
}

async function handleAvatarRemove() {
  if (!confirm("Profil fotoğrafınız kaldırılsın mı?")) return;
  try {
    await Api.removeAvatar(session.avatar_url);
    session.avatar_url = null;
    delete AVATAR_BY_ID[session.id];
    delete AVATAR_BY_NAME[session.ad_soyad];
    renderMe();
    renderPrefs();
    toast("Fotoğraf kaldırıldı");
  } catch (e) {
    toast("Fotoğraf kaldırılamadı", true);
  }
}

function togglePrefs(open) {
  const el = $("#prefsPanel"), btn = $("#meBtn");
  if (!el || !btn) return;
  const willOpen = open === undefined ? !el.classList.contains("open") : open;
  if (!willOpen) prefsPinOpen = false;
  if (willOpen) renderPrefs();
  el.classList.toggle("open", willOpen);
  btn.setAttribute("aria-expanded", String(willOpen));
}

// ---------------- Statik UI (sadece bir kez bağlanır) ----------------
function wireStaticUI() {
  if (uiWired) return;
  uiWired = true;

  $("#meBtn").addEventListener("click", (e) => { e.stopPropagation(); togglePrefs(); });
  $("#prefsPanel").addEventListener("click", (e) => {
    e.stopPropagation();
    if (!window.Tema) return;
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.sesSec) { sesAyarla(b.dataset.sesSec === "acik"); return; }
    if (b.dataset.temaSec) Tema.set({ tema: b.dataset.temaSec });
    else if (b.dataset.modSec) Tema.set({ mod: b.dataset.modSec });
    else if (b.dataset.yogSec) Tema.set({ yogunluk: b.dataset.yogSec });
    else if (b.hasAttribute("data-pin-ac") || b.hasAttribute("data-pin-kapat")) {
      prefsPinOpen = b.hasAttribute("data-pin-ac") ? !prefsPinOpen : false;
      renderPrefs();
      if (prefsPinOpen) $("#pinEski")?.focus();
    } else if (b.hasAttribute("data-avatar-kaldir")) handleAvatarRemove();
  });
  $("#prefsPanel").addEventListener("change", (e) => {
    if (e.target.id === "avatarFile") handleAvatarFile(e.target.files && e.target.files[0]);
  });
  $("#prefsPanel").addEventListener("submit", (e) => {
    e.preventDefault();
    if (e.target.id === "pinForm") handlePinSubmit();
  });
  document.addEventListener("click", () => togglePrefs(false));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if ($("#prefsPanel")?.classList.contains("open")) { togglePrefs(false); return; }
    // Esc yalnız İstem Detayı'nı kapatır — Yeni İstek / düzenleme formları
    // (yazılanlar kaybolmasın) ve yazı alanındayken kapanmaz.
    const a = document.activeElement;
    if ($("#closeDetail") && !(a && a.matches("input, textarea, select"))) showEmpty();
  });
  $("#sideDaraltBtn").addEventListener("click", () => navDarAyarla(!document.documentElement.hasAttribute("data-nav-dar")));
  $("#yeniBildirimGoster").addEventListener("click", yeniBildirimGoster);
  $("#yeniBildirimKapat").addEventListener("click", () => { yeniKalemler = new Set(); renderYeniBildirim(); renderTable(); });
  // Tarayıcılar sesi ancak sayfayla bir etkileşimden sonra çalar — ilk
  // tık/tuşta ses motoru hazırlanır (bkz. sesKilidiAc).
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, sesKilidiAc, { capture: true, passive: true }));
  // tema.js her değişiklikte yayınlar (ayarlar paneli, A−/A+, "Sistem" modunda
  // işletim sistemi açık/koyu geçişi) — açık kontrolleri tazele.
  document.addEventListener("tema-degisti", () => {
    renderZoomCtl();
    if ($("#prefsPanel")?.classList.contains("open")) renderPrefs();
  });

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

// sw.js zaten skipWaiting()+clients.claim() ile yeni sürümü otomatik
// devreye alıyor (bkz. sw.js) — burada yapılan tek şey, o geçiş olduğunda
// kullanıcıya haber vermek. "controllerchange", bu sayfa AÇIKKEN kontrolü
// devralan bir SW değiştiğinde tetiklenir; hadController kontrolü olmadan
// bunu dinlemek İLK KURULUMDA da (henüz hiçbir "eski sürüm" yokken) yanlışlıkla
// banner göstermeye yol açardı.
function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) showUpdateBanner();
    });

    const reg = await navigator.serviceWorker.register("sw.js").catch(() => null);
    if (!reg) return;

    // Sekme uzun süre açık kalabilir (SPA) — tarayıcının kendi periyodik
    // güncelleme kontrolüne (~24 saat) ek olarak, saatte bir ve sekme tekrar
    // görünür olduğunda da elle bir güncelleme kontrolü tetikle.
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") reg.update().catch(() => {});
    });
  });
}

function showUpdateBanner() {
  const el = $("#updateBanner");
  if (el) el.classList.add("show");
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

// Tür dosya adından anlaşılır (daily-backup / ozet-yedek Edge Function'ları).
const YEDEK_TURLERI = [
  ["gunluk", "Günlük", "istem_otomatik_yedek_"],
  ["haftalik", "Haftalık", "istem_haftalik_ozet_"],
  ["aylik", "Aylık", "istem_aylik_ozet_"],
];
let yedekTurFiltre = "hepsi";
function yedekTuru(ad) {
  const t = YEDEK_TURLERI.find(([, , onek]) => String(ad).startsWith(onek));
  return t ? t[0] : "diger";
}

function renderYedeklerPage() {
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>Yedekler</h1>
      <div class="sub">Günlük ham veri yedeği her gece 02:00'de; haftalık özet Pazartesi, aylık özet ayın 1'inde 05:00'te (Türkiye saati).</div>
      <div class="spacer"></div>
    </div>
    <div class="barrow"><div class="tabs" id="yedekTabs"></div></div>
    <div class="devlist" id="yedekList"></div>`;
  $("#yedekTabs").addEventListener("click", (e) => {
    const b = e.target.closest("[data-yt]"); if (!b) return;
    yedekTurFiltre = b.dataset.yt;
    renderYedekList();
  });
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
  const tabs = $("#yedekTabs");
  if (tabs) {
    tabs.innerHTML = [["hepsi", "Tümü"], ...YEDEK_TURLERI].map(([k, l]) => {
      const n = k === "hepsi" ? YEDEKLER_LIST.length : YEDEKLER_LIST.filter((f) => yedekTuru(f.name) === k).length;
      return `<button class="${yedekTurFiltre === k ? "on" : ""}" data-yt="${k}">${l} <span class="count">${n}</span></button>`;
    }).join("");
  }
  const list = yedekTurFiltre === "hepsi" ? YEDEKLER_LIST : YEDEKLER_LIST.filter((f) => yedekTuru(f.name) === yedekTurFiltre);
  if (!list.length) {
    const ilk = { hepsi: "İlk otomatik yedek gece 02:00'de alınacak.", gunluk: "İlk günlük yedek gece 02:00'de alınacak.",
      haftalik: "İlk haftalık özet Pazartesi 05:00'te oluşur.", aylik: "İlk aylık özet ayın 1'inde 05:00'te oluşur." }[yedekTurFiltre];
    wrap.innerHTML = `<div class="empty"><div class="t">Bu türde henüz dosya yok</div><div class="d">${ilk}</div></div>`;
    return;
  }
  const TUR_AD = Object.fromEntries(YEDEK_TURLERI.map(([k, l]) => [k, l]));
  wrap.innerHTML = list.map((f) => `
    <div class="devrow" style="cursor:default">
      <span class="yedek-tur" data-tur="${yedekTuru(f.name)}">${TUR_AD[yedekTuru(f.name)] || "Diğer"}</span>
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

// ================================================================
// İSTATİSTİKLER (yönetim) — canlı veritabanından, sayfa her açıldığında
// ve "Yenile"de yeniden hesaplanır (yedek dosyalarından DEĞİL). Hesap
// sunucuda: istatistik() (ek_ozellikler_sema.sql).
// ================================================================
const IST_ARALIKLAR = [["hafta", "Bu hafta"], ["ay", "Bu ay"], ["3ay", "Son 3 ay"], ["ozel", "Özel aralık"]];
let istAralik = "ay", istPeriyot = "week", istOzelBas = "", istOzelBit = "";
let istSeq = 0;

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function parseYmd(str) {
  const [y, m, d] = String(str).slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}
// Seçili aralık → [bas, bit] ("YYYY-AA-GG", ikisi de dahil). Hafta Pazartesi başlar.
function istAralikTarihleri() {
  const bugun = new Date(); bugun.setHours(0, 0, 0, 0);
  if (istAralik === "hafta") {
    const bas = new Date(bugun); bas.setDate(bas.getDate() - ((bas.getDay() + 6) % 7));
    return [ymd(bas), ymd(bugun)];
  }
  if (istAralik === "ay") return [ymd(new Date(bugun.getFullYear(), bugun.getMonth(), 1)), ymd(bugun)];
  if (istAralik === "3ay") return [ymd(new Date(bugun.getFullYear(), bugun.getMonth() - 2, 1)), ymd(bugun)];
  return [istOzelBas, istOzelBit];
}
function fmtSure(saat) {
  if (saat === null || saat === undefined) return "—";
  const h = Number(saat);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} dk`;
  if (h < 48) return `${h.toLocaleString("tr-TR", { maximumFractionDigits: 1 })} sa`;
  return `${(h / 24).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} gün`;
}
function fmtGun(str) {
  return parseYmd(str).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
}
// Dönem etiketi; ilk/son hafta aralığın dışına taşıyorsa kırpılmış haliyle.
function donemEtiketi(d, per, bas, bit) {
  const t = parseYmd(d);
  if (per === "month") return t.toLocaleDateString("tr-TR", { month: "long", year: "numeric" });
  const son = new Date(t); son.setDate(son.getDate() + 6);
  const b0 = parseYmd(bas), b1 = parseYmd(bit);
  const f = (x) => x.toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  return `${f(t < b0 ? b0 : t)} – ${f(son > b1 ? b1 : son)}`;
}

function renderIstatistiklerPage() {
  if (!istOzelBas) [istOzelBas, istOzelBit] = istAralikTarihleri();
  $("#mainView").innerHTML = `
    <div class="page-head">
      <h1>İstatistikler</h1>
      <div class="sub">Canlı veritabanından — her açılışta yeniden hesaplanır.</div>
      <div class="spacer"></div>
      <button class="btn-ghost btn-sm" id="istYenile">Yenile</button>
    </div>
    <div class="barrow">
      <div class="tabs" id="istAralik">
        ${IST_ARALIKLAR.map(([k, l]) => `<button class="${istAralik === k ? "on" : ""}" data-ar="${k}">${l}</button>`).join("")}
      </div>
      <div class="ist-ozel${istAralik === "ozel" ? "" : " hidden"}" id="istOzel">
        <input type="date" class="finput" id="istBas" value="${istOzelBas}" aria-label="Başlangıç">
        <span>–</span>
        <input type="date" class="finput" id="istBit" value="${istOzelBit}" aria-label="Bitiş">
        <button class="btn-ghost btn-sm" id="istUygula">Uygula</button>
      </div>
      <div class="grow"></div>
      <div class="tabs" id="istPeriyot">
        <button class="${istPeriyot === "week" ? "on" : ""}" data-p="week">Haftalık</button>
        <button class="${istPeriyot === "month" ? "on" : ""}" data-p="month">Aylık</button>
      </div>
    </div>
    <div class="ist-wrap" id="istIcerik"><div class="ist-mesaj">Hesaplanıyor…</div></div>`;

  $("#istAralik").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ar]"); if (!b) return;
    istAralik = b.dataset.ar;
    $$("#istAralik button").forEach((x) => x.classList.toggle("on", x.dataset.ar === istAralik));
    $("#istOzel").classList.toggle("hidden", istAralik !== "ozel");
    if (istAralik !== "ozel") loadIstatistik();
  });
  $("#istUygula").addEventListener("click", () => {
    istOzelBas = $("#istBas").value; istOzelBit = $("#istBit").value;
    loadIstatistik();
  });
  $("#istPeriyot").addEventListener("click", (e) => {
    const b = e.target.closest("[data-p]"); if (!b) return;
    istPeriyot = b.dataset.p;
    $$("#istPeriyot button").forEach((x) => x.classList.toggle("on", x.dataset.p === istPeriyot));
    loadIstatistik();
  });
  $("#istYenile").addEventListener("click", loadIstatistik);
  loadIstatistik();
}

async function loadIstatistik() {
  const el = $("#istIcerik"); if (!el) return;
  // Özel aralıkta tarih kutularındaki GÜNCEL değer (Uygula'ya basılmadan
  // dönem değiştirilse de).
  if (istAralik === "ozel" && $("#istBas")) { istOzelBas = $("#istBas").value; istOzelBit = $("#istBit").value; }
  const [bas, bit] = istAralikTarihleri();
  if (!bas || !bit || bas > bit) { el.innerHTML = `<div class="ist-mesaj">Geçerli bir tarih aralığı seç (başlangıç ≤ bitiş).</div>`; return; }
  const seq = ++istSeq;
  el.classList.add("yukleniyor");
  try {
    const s = await Api.istatistik(bas, bit, istPeriyot);
    if (seq !== istSeq || currentPage !== "istatistikler") return;
    el.innerHTML = istatistikHTML(s);
  } catch (e) {
    if (seq !== istSeq) return;
    const msg = e && e.code === "42501" ? "İstatistikler yalnızca yönetici içindir."
      : e && (e.code === "PGRST202" || e.code === "42883") ? "istatistik() bulunamadı — ek_ozellikler_sema.sql çalıştırıldı mı?"
      : "İstatistikler yüklenemedi.";
    el.innerHTML = `<div class="ist-mesaj hata">${esc(msg)}</div>`;
  } finally {
    if (seq === istSeq) el.classList.remove("yukleniyor");
  }
}

function istatistikHTML(s) {
  const o = s.ozet || {};
  const per = s.aralik?.periyot || istPeriyot;
  const bas = String(s.aralik?.bas || ""), bit = String(s.aralik?.bit || "");
  const n = (x) => Number(x || 0).toLocaleString("tr-TR");
  const kart = (lbl, val, alt) => `<div class="ist-kart"><div class="k">${lbl}</div><div class="v">${val}</div>${alt ? `<div class="a">${alt}</div>` : ""}</div>`;
  const tipler = s.tipler || [];
  const toplamKalem = Number(o.kalem || 0);
  const maxTip = Math.max(1, ...tipler.map((t) => t.n));
  const donemler = s.donemler || [];
  // Kişi dağılımı kartı (Kullanıcı bazında / Uzman adına — aynı tasarım).
  // list undefined: sunucudaki istatistik() eski sürüm (ozet_yedek_sema.sql çalışmamış).
  const kisiKarti = (baslik, list) => `<div class="ist-blok">
      <div class="m-label">${baslik}</div>
      ${list === undefined ? `<div class="ist-mesaj">Bu dağılım için ozet_yedek_sema.sql çalıştırılmalı.</div>`
        : !list.length ? `<div class="ist-mesaj">Bu aralıkta istem yok.</div>`
        : list.map((u) => `<div class="ist-bar">
          <div class="l pchip" title="${esc(u.ad)}">${u.id && !u.ad.startsWith("(") ? avatarHTML({ id: u.id, ad: u.ad }, "av-sm") : ""}<span class="ad">${esc(u.ad)}</span>${u.kisaltma ? `<span class="kisa-chip">${esc(u.kisaltma)}</span>` : ""}</div>
          <div class="b"><i style="width:${(u.istem / Math.max(1, ...list.map((x) => x.istem)) * 100).toFixed(1)}%"></i></div>
          <div class="n">${n(u.istem)}</div>
        </div>`).join("")}
    </div>`;
  const tipAd = (t) => TIP[t.kod] || t.ad || t.kod;
  const sifir = `<span class="sifir">0</span>`;

  return `
    <div class="ist-aralik">${esc(fmtGun(bas))} – ${esc(fmtGun(bit))}</div>
    <div class="ist-kartlar">
      ${kart("İstem", n(o.istem), "İstek Ver işlemi")}
      ${kart("Kalem", n(o.kalem), o.tekrar ? `${n(o.tekrar)} tekrar dahil` : "test × blok")}
      ${kart("Tamamlanan", n(o.tamamlanan), "aralıkta tamamlanan kalem")}
      ${kart("Ort. tamamlanma", fmtSure(o.ort_saat), o.medyan_saat != null ? `medyan ${fmtSure(o.medyan_saat)}` : "")}
      ${kart("Şu an açık", n(o.acik), "Bekleyen + Cihazda")}
    </div>
    <div class="ist-blok">
      <div class="m-label">${per === "month" ? "Aylık" : "Haftalık"} döküm</div>
      <div class="ist-tablo"><table>
        <thead><tr>
          <th>Dönem</th><th class="sayi">İstem</th><th class="sayi">Kalem</th>
          ${tipler.map((t) => `<th class="sayi">${esc(tipAd(t))}</th>`).join("")}
          <th class="sayi">Tekrar</th><th class="sayi">Tamamlanan</th><th class="sayi">Ort. süre</th><th class="sayi">Medyan</th>
        </tr></thead>
        <tbody>${donemler.map((d) => `<tr>
          <td>${esc(donemEtiketi(d.d, per, bas, bit))}</td>
          <td class="sayi">${d.istem ? n(d.istem) : sifir}</td>
          <td class="sayi">${d.kalem ? n(d.kalem) : sifir}</td>
          ${tipler.map((t) => `<td class="sayi">${d.tipler && d.tipler[t.kod] ? n(d.tipler[t.kod]) : sifir}</td>`).join("")}
          <td class="sayi">${d.tekrar ? n(d.tekrar) : sifir}</td>
          <td class="sayi">${d.tamamlanan ? n(d.tamamlanan) : sifir}</td>
          <td class="sayi">${fmtSure(d.ort_saat)}</td>
          <td class="sayi">${fmtSure(d.medyan_saat)}</td>
        </tr>`).join("")}</tbody>
      </table></div>
    </div>
    <div class="ist-dagilim">
      <div class="ist-blok">
        <div class="m-label">Tip dağılımı (kalem)</div>
        ${tipler.length ? tipler.map((t) => `<div class="ist-bar">
          <div class="l"><span class="tag" data-g="${tipKey(t.kod)}">${PIXEL_SVG[tipKey(t.kod)]}${esc(tipAd(t))}</span></div>
          <div class="b"><i style="width:${(t.n / maxTip * 100).toFixed(1)}%"></i></div>
          <div class="n">${n(t.n)} <span>%${toplamKalem ? Math.round(t.n / toplamKalem * 100) : 0}</span></div>
        </div>`).join("") : `<div class="ist-mesaj">Bu aralıkta kalem yok.</div>`}
      </div>
      ${kisiKarti("Kullanıcı bazında istem (isteyen)", s.kullanicilar || [])}
      ${kisiKarti("Uzman adına dağılım (kimin adına istendi)", s.uzmanlar)}
    </div>
    <div class="ist-not">İstem, kalem, tip, kullanıcı ve uzman sayıları istendiği döneme sayılır; uzman adına dağılımda "Uzman Adına" boş bırakılan istemler "(uzman seçilmedi)" satırındadır. Tamamlanma süresi: kalemin istenmesinden son "Tamamlandı"ya geçişine kadar; tamamlanma tarihi aralıktaki kalemler, tamamlandığı döneme sayılır. Silinmiş kalemler sayılmaz.</div>`;
}

// ================================================================
// ÇALIŞMA LİSTESİ (yazdır) — seçili kalemler, A4, siyah-beyaz.
// Aynı sayfada, ekranda hiç görünmeyen #yazdirAlani'na yazılır; yazdırırken
// (body.yazdiriliyor) uygulamanın geri kalanı gizlenir (styles.css @media
// print). Ayrı pencere değil: açılır pencere engelleyiciye ve ana ekrana
// eklenmiş uygulama/tablet kısıtlarına takılmaz, yazdırma ekranı hemen açılır.
// ================================================================
const YAZDIR_IKON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/></svg>`;

// "11240/26" → [26, 11240]: önce yıl, sonra numara (eski yıllar önce).
function patAnahtar(p) {
  const m = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(p || "");
  return m ? [Number(m[2]), Number(m[1])] : null;
}
function yazdirSirasi(a, b) {
  const pa = patAnahtar(a.patoloji_no), pb = patAnahtar(b.patoloji_no);
  const c = pa && pb ? (pa[0] - pb[0] || pa[1] - pb[1])
    : pa ? -1 : pb ? 1 : String(a.patoloji_no).localeCompare(String(b.patoloji_no), "tr", { numeric: true });
  return c
    || String(a.blok_no || "").localeCompare(String(b.blok_no || ""), "tr", { numeric: true })
    || String(a.test_adi || "").localeCompare(String(b.test_adi || ""), "tr");
}
const kisaAd = (ad, kisa) => kisa || (ad ? initials(ad) : "—");

function calismaListesiYazdir() {
  const list = rows.filter((r) => bulkSelected.has(r.kalem_id)).sort(yazdirSirasi);
  if (!list.length) { toast("Yazdırılacak kalem seçilmedi", true); return; }
  const vakaSayisi = new Set(list.map((r) => r.patoloji_no)).size;
  const ONC = { acil: "(ACİL)", stat: "(STAT)" };
  $("#yazdirAlani").innerHTML = `
    <div class="yl-bas"><div class="yl-baslik">Çalışma Listesi</div><div>${esc(formatDateFull(new Date().toISOString()))}</div></div>
    <div class="yl-alt">${list.length} kalem · ${vakaSayisi} vaka · Hazırlayan: ${esc(kisaAd(session.ad_soyad, session.kisaltma))}</div>
    <table class="yl-tablo">
      <thead><tr><th class="yl-kutu"></th><th>Patoloji No</th><th>Blok</th><th>Test / Boya</th><th>Öncelik</th><th>Uzman Adına</th><th>İsteyen</th></tr></thead>
      <tbody>${list.map((r, i) => {
        const cls = [ONC[r.oncelik] ? "acil" : "", i > 0 && list[i - 1].patoloji_no !== r.patoloji_no ? "vaka-bas" : ""].filter(Boolean).join(" ");
        return `<tr${cls ? ` class="${cls}"` : ""}>
          <td class="yl-kutu"><span class="kutu"></span></td>
          <td class="yl-id">${esc(r.patoloji_no)}</td>
          <td class="yl-id">${esc(r.blok_no || "—")}</td>
          <td>${esc(r.test_adi)}</td>
          <td>${ONC[r.oncelik] || ""}</td>
          <td>${esc(kisaAd(r.uzman_adi, r.uzman_kisaltma))}</td>
          <td>${esc(kisaAd(r.isteyen_adi, r.isteyen_kisaltma))}</td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
  document.body.classList.add("yazdiriliyor");
  window.print();
  // Ekran düzenine dönüş bir sonraki tık/dokunuşta — bazı mobil tarayıcılarda
  // print() hemen döner ve "afterprint"e güvenmek önizlemeyi boşaltabilir.
  document.addEventListener("pointerdown", () => {
    document.body.classList.remove("yazdiriliyor");
    $("#yazdirAlani").innerHTML = "";
  }, { once: true, capture: true });
}

// ================================================================
// SOL MENÜ DARALTMA — tercih bu tarayıcıda (localStorage). Hiç seçim
// yapılmamışsa orta genişlikte (< 1600 px) dar, geniş ekranda açık başlar.
// Telefon düzeninde (≤ 900 px) etkisi yok (styles.css).
// ================================================================
const NAV_DAR_KEY = "istem_nav_dar";
const NAV_GENIS_MQ = window.matchMedia ? window.matchMedia("(min-width: 1600px)") : null;
function navDarTercih() {
  try { const v = localStorage.getItem(NAV_DAR_KEY); return v === null ? null : v === "1"; } catch (e) { return null; }
}
function navDarUygula() {
  const t = navDarTercih();
  const dar = t !== null ? t : !(NAV_GENIS_MQ && NAV_GENIS_MQ.matches);
  document.documentElement.toggleAttribute("data-nav-dar", dar);
  const btn = $("#sideDaraltBtn");
  if (btn) {
    btn.title = dar ? "Menüyü genişlet" : "Menüyü daralt";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-expanded", String(!dar));
  }
  // Dar modda yalnız ikon kalır — ad, üzerine gelince ipucu olarak.
  $$("#nav a[data-page]").forEach((a) => { if (dar) a.title = a.textContent.trim(); else a.removeAttribute("title"); });
  const nb = $("#newBtn"); if (nb) { if (dar) nb.title = "Yeni İstek"; else nb.removeAttribute("title"); }
}
function navDarAyarla(dar) {
  try { localStorage.setItem(NAV_DAR_KEY, dar ? "1" : "0"); } catch (e) { /* hatırlanmaz, önemli değil */ }
  navDarUygula();
}
if (NAV_GENIS_MQ) {
  const f = () => { if (navDarTercih() === null) navDarUygula(); };
  if (NAV_GENIS_MQ.addEventListener) NAV_GENIS_MQ.addEventListener("change", f); else if (NAV_GENIS_MQ.addListener) NAV_GENIS_MQ.addListener(f);
}

// ================================================================
// YENİ İSTEM BİLDİRİMİ — ayrı abonelik yok: canlı güncelleme zaten her
// değişiklikte kuyruğu yeniden yüklüyor (subscribeQueue → loadQueue); her
// yüklemede bir öncekiyle karşılaştırılır. Daha önce HİÇ görülmemiş ve
// Bekleyen kalem = yeni. Sayılmayanlar: ilk yükleme, kişinin kendi açtığı
// istemler. Geri alma (aynı kalem) ve eski kayıt / vaka geçmişi
// (Tamamlandı) yanlış alarm üretmez; toplu gelenler tek bildirimde toplanır.
// ================================================================
const SAYFA_BASLIGI = document.title;
function yeniIstemKontrol(liste) {
  const ilk = bilinenKalemler === null;
  if (ilk) bilinenKalemler = new Set();
  const gorulmemis = liste.filter((r) => !bilinenKalemler.has(r.kalem_id));
  gorulmemis.forEach((r) => bilinenKalemler.add(r.kalem_id));
  if (ilk || !session) return;
  const gelen = gorulmemis.filter((r) => r.durum === "bekleyen" && r.istem_yapan_id !== session.id);
  if (!gelen.length) return;
  gelen.forEach((r) => yeniKalemler.add(r.kalem_id));
  renderYeniBildirim(true);
  if (sesAcik()) zilCal();
}

function renderYeniBildirim(yeniGeldi = false) {
  const el = $("#yeniBildirim");
  // Silinen / artık listede olmayan kalemler düşülür.
  if (yeniKalemler.size) {
    const canli = new Set(rows.map((r) => r.kalem_id));
    yeniKalemler = new Set([...yeniKalemler].filter((id) => canli.has(id)));
  }
  const n = yeniKalemler.size;
  document.title = n ? `(${n}) ${SAYFA_BASLIGI}` : SAYFA_BASLIGI;
  if (!el) return;
  if (!n) { el.hidden = true; el.classList.remove("parla"); return; }
  // Vaka bazında özet: "11240/26 (ER, PR, HER2) · 11198/26 (CD3)" — ilk 3 vaka.
  const vakalar = new Map();
  rows.filter((r) => yeniKalemler.has(r.kalem_id)).forEach((r) => {
    if (!vakalar.has(r.patoloji_no)) vakalar.set(r.patoloji_no, []);
    vakalar.get(r.patoloji_no).push(r.test_adi);
  });
  const ozet = [...vakalar].slice(0, 3).map(([p, t]) => `${p} (${t.join(", ")})`).join(" · ") + (vakalar.size > 3 ? ` · +${vakalar.size - 3} vaka` : "");
  $("#yeniBildirimMetin").innerHTML = `<b>${n} yeni istem geldi</b><span class="yb-ozet">${esc(ozet)}</span>`;
  el.hidden = false;
  if (yeniGeldi) { el.classList.remove("parla"); void el.offsetWidth; el.classList.add("parla"); }
}

// "Göster": İş Kuyruğu'na geçer, ilk yeni satıra kaydırır (filtreler değişmez).
function yeniBildirimGoster() {
  if (currentPage !== "kuyruk") navigate("kuyruk");
  const tr = $("#rows tr.row-yeni");
  if (tr) tr.scrollIntoView({ block: "center", behavior: "smooth" });
}

// ---------------- Ses (Web Audio — dosya yok, çevrimdışı da çalışır) ----------------
// Tercih kullanıcı başına (ortak bilgisayar); varsayılan açık.
const sesKey = () => "istem_ses:" + (session ? session.id : "");
function sesAcik() {
  try { return localStorage.getItem(sesKey()) !== "0"; } catch (e) { return true; }
}
function sesAyarla(acik) {
  try { localStorage.setItem(sesKey(), acik ? "1" : "0"); } catch (e) { /* hatırlanmaz */ }
  renderZil();
  if ($("#prefsPanel")?.classList.contains("open")) renderPrefs();
  if (acik) { sesKilidiAc(); zilCal(); } // açarken örnek ton (tık zaten etkileşim)
  toast(acik ? "Yeni istem sesi açık" : "Yeni istem sesi kapalı");
}
const ZIL_IKON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
const ZIL_KAPALI_IKON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13.73 21a2 2 0 0 1-3.46 0M18.63 13A17.9 17.9 0 0 1 18 8M6.26 6.26A5.9 5.9 0 0 0 6 8c0 7-3 9-3 9h14M18 8a6 6 0 0 0-9.33-5M2 2l20 20"/></svg>`;
function renderZil() {
  const b = $("#zilBtn"); if (!b) return;
  const acik = sesAcik();
  b.innerHTML = acik ? ZIL_IKON : ZIL_KAPALI_IKON;
  b.classList.toggle("kapali", !acik);
  b.title = acik ? "Yeni istem sesi açık — kapatmak için tıkla" : "Yeni istem sesi kapalı — açmak için tıkla";
  b.setAttribute("aria-label", b.title);
  b.setAttribute("aria-pressed", String(acik));
}

let sesCtx = null;
function sesKilidiAc() {
  if (!sesAcik()) return; // ses kapalıyken ses motoru hiç açılmaz
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!sesCtx) {
      sesCtx = new AC();
      // Safari: kilit, etkileşim içinde bir ses başlatılınca açılır — sessiz örnek.
      const kaynak = sesCtx.createBufferSource();
      kaynak.buffer = sesCtx.createBuffer(1, 1, 22050);
      kaynak.connect(sesCtx.destination);
      kaynak.start(0);
    }
    if (sesCtx.state === "suspended") sesCtx.resume();
  } catch (e) { /* ses yok — görsel bildirim yeter */ }
}
// Kısa, yumuşak iki notalı ton (~0,4 sn). Sayfayla henüz etkileşim yoksa
// tarayıcı izin vermez — sessizce geçilir (görsel bildirim yine çıkar).
function zilCal() {
  if (!sesCtx) return;
  try {
    if (sesCtx.state === "suspended") sesCtx.resume();
    const t0 = sesCtx.currentTime + 0.02;
    [[659.25, 0], [880, 0.15]].forEach(([frekans, dt]) => {
      const o = sesCtx.createOscillator(), g = sesCtx.createGain();
      o.type = "sine";
      o.frequency.value = frekans;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.13, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.3);
      o.connect(g);
      g.connect(sesCtx.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.32);
    });
  } catch (e) { /* ses çalınamadı */ }
}

// ---------------- Boot ----------------
(async function boot() {
  navDarUygula();
  $("#authSubmit").addEventListener("click", handleAuthSubmit);
  $("#authPin").addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuthSubmit(); });
  $("#logoutBtn").addEventListener("click", handleLogout);
  $("#updateBannerBtn").addEventListener("click", () => location.reload());
  $("#updateBannerClose").addEventListener("click", () => $("#updateBanner").classList.remove("show"));
  registerSW();

  // Eski (Auth migrasyonundan önceki) "istem_session" localStorage işareti —
  // artık hiçbir yerde yazılmıyor/okunmuyor, sadece eski taraycılarda kalmış
  // olabilecek kopyayı bir kerelik temizliyoruz. ASLA güvenilmez: tek
  // güvenilir kaynak her zaman client.auth.getSession()'dır — secure_rls_
  // authenticated.sql çalıştıktan sonra RLS authenticated-only kilitli
  // olduğundan, doğrulanmamış bir oturumla açılan İş Kuyruğu'nda TÜM veri
  // istekleri sessizce başarısız oluyordu (kullanıcı elle çıkış yapıp tekrar
  // girene kadar).
  try { localStorage.removeItem("istem_session"); } catch (e) { /* localStorage kapalıysa önemli değil */ }

  // #bootLoadCard (index.html'de varsayılan görünür) bu kontrol sonuçlanana
  // kadar tek görünen şey — ne boş bir giriş formu flaşı, ne de doğrulanmamış
  // bir oturumla doğrudan uygulama.
  let real = null;
  try { real = await Api.getCurrentAuthSession(); } catch (e) { real = null; }
  if (real) {
    await initApp(real);
  } else {
    showAuth();
  }
})();
