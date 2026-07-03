// app.js — ekran mantığı. Veriye HER ZAMAN Api.* üzerinden erişir,
// Supabase'i doğrudan görmez (bkz. api.js).

const GROUPS = [
  ["ihc", "IHC"], ["hk", "Histokimya"], ["mol", "Moleküler"],
  ["kesit", "Yeni Kesit"], ["hucre", "Hücre Bloğu"], ["yayma", "Yeniden Yayma"], ["diger", "Diğer"],
];
const TIP = Object.fromEntries(GROUPS);
const ROL_LABEL = { uzman: "Uzman Patolog", asistan: "Asistan", teknisyen: "Teknisyen" };
const PILL = { bekleyen: ["st-bekleyen", "Bekleyen"], cihazda: ["st-cihazda", "Cihazda"], tamamlandi: ["st-tamamlandi", "Tamamlandı"] };
const PRIO = { rutin: ["p-rutin", "Rutin"], acil: ["p-acil", "Acil"], stat: ["p-stat", "STAT"] };
const SESSION_KEY = "istem_session";
const EMPTY_MSG = {
  kuyruk: { t: "Bir istek seç", d: "Detayını ve durum geçmişini görmek için soldan bir satıra dokun, ya da yeni istek ver." },
  setler: { t: "Bir set seç", d: "Testlerini görmek ve doğrudan istek vermek için bir karta dokun." },
  sablonlar: { t: "Bir şablon seç", d: "Düzenlemek için bir şablona dokun, ya da yeni şablon oluştur." },
  cihazlar: { t: "Bir cihaz seç", d: "Düzenlemek için bir cihaza dokun, ya da yeni cihaz ekle." },
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
function initials(name) {
  const parts = name.replace(/^Dr\.?\s*/i, "").split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join("") || "?";
}
function groupByGrup(list) {
  const out = {};
  list.forEach((item) => { (out[item.grup] ??= []).push(item); });
  return out;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
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
let rows = [];
let filter = "all", selId = null, searchQ = "";
let unsub = null, pageUnsub = null, reloadTimer = null;
let grp = "ihc", prio = "rutin";
let selectedTests = new Map(); // test_id -> {ad,klon,grup}
let customItems = []; // {ad, sel, grup}
let uiWired = false;
let currentPage = "kuyruk";
let setFilterGrup = "all", setFilterUzmanlik = "all";

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

function handleLogout() {
  clearSession();
  if (unsub) { unsub(); unsub = null; }
  if (pageUnsub) { pageUnsub(); pageUnsub = null; }
  rows = []; selId = null; filter = "all"; searchQ = "";
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
    Api.getTestKatalog(), Api.getIstekSetleri(), Api.getMySablonlar(user.id), Api.getUzmanlar(), Api.getCihazlar(),
  ]);
  const [catR, setlerR, mineR, uzmanlarR, cihazlarR] = results;
  if (catR.status === "fulfilled") CAT = catR.value; else toast("Test kataloğu yüklenemedi", true);
  if (setlerR.status === "fulfilled") { ISTEK_SETLERI = setlerR.value; SETS_INST = groupByGrup(ISTEK_SETLERI); }
  else toast("İstek Setleri yüklenemedi — setler_sema.sql çalıştırıldı mı?", true);
  if (mineR.status === "fulfilled") { MY_SABLONLAR = mineR.value; SETS_MINE = groupByGrup(MY_SABLONLAR); }
  if (uzmanlarR.status === "fulfilled") UZMANLAR = uzmanlarR.value;
  if (cihazlarR.status === "fulfilled") CIHAZLAR = cihazlarR.value;

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
      try { ISTEK_SETLERI = await Api.getIstekSetleri(); SETS_INST = groupByGrup(ISTEK_SETLERI); if (currentPage === "setler") renderSetlerPage(); } catch (e) { /* geçici bağlantı sorunu */ }
    });
  } else if (page === "sablonlar") {
    renderSablonlarPage();
  } else if (page === "cihazlar") {
    renderCihazlarPage();
    pageUnsub = Api.subscribeCihazlar(async () => {
      try { CIHAZLAR = await Api.getCihazlar(); if (currentPage === "cihazlar") renderCihazlarPage(); } catch (e) { /* geçici bağlantı sorunu */ }
    });
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
    <div class="barrow">
      <div class="tabs" id="tabs">
        <button class="${filter === "all" ? "on" : ""}" data-f="all">Tümü <span class="count" data-c="all">0</span></button>
        <button class="${filter === "bekleyen" ? "on" : ""}" data-f="bekleyen">Bekleyen <span class="count" data-c="bekleyen">0</span></button>
        <button class="${filter === "cihazda" ? "on" : ""}" data-f="cihazda">Cihazda <span class="count" data-c="cihazda">0</span></button>
        <button class="${filter === "tamamlandi" ? "on" : ""}" data-f="tamamlandi">Tamamlandı <span class="count" data-c="tamamlandi">0</span></button>
      </div>
      <div class="grow"></div>
      <div class="msearch">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#26221d" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input id="qSearch" placeholder="Blok, patoloji no…" value="${esc(searchQ)}">
      </div>
    </div>
    <div class="tablewrap">
      <table>
        <thead><tr><th>Blok</th><th>Patoloji No</th><th>İstek</th><th>Tip</th><th>Öncelik</th><th>Durum</th><th>Aksiyon</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>`;

  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    $$("#tabs button").forEach((x) => x.classList.remove("on")); b.classList.add("on");
    filter = b.dataset.f; renderTable();
  });
  $("#qSearch").addEventListener("input", (e) => { searchQ = e.target.value; renderTable(); });
  $("#rows").addEventListener("click", (e) => {
    const btn = e.target.closest(".act[data-id]");
    if (btn) { e.stopPropagation(); advance(btn.dataset.id, btn.dataset.to); return; }
    const tr = e.target.closest("tr[data-kalem]");
    if (tr) { const r = rows.find((x) => x.kalem_id === tr.dataset.kalem); if (r) showDetail(r); }
  });

  loadQueue();
}

function passesFilter(r) {
  if (filter !== "all" && r.durum !== filter) return false;
  if (searchQ) {
    const q = searchQ.toLowerCase();
    if (!r.blok_no.toLowerCase().includes(q) && !r.patoloji_no.toLowerCase().includes(q)) return false;
  }
  return true;
}

function renderTable() {
  const tb = $("#rows");
  if (!tb) return; // kuyruk sayfasında değiliz
  tb.innerHTML = "";
  rows.filter(passesFilter).forEach((r) => {
    const tr = document.createElement("tr");
    tr.dataset.kalem = r.kalem_id;
    if (r.kalem_id === selId) tr.className = "sel";
    let act;
    if (r.durum === "bekleyen") act = `<button class="act" data-id="${r.kalem_id}" data-to="cihazda">Cihaza al</button>`;
    else if (r.durum === "cihazda") act = `<button class="act" data-id="${r.kalem_id}" data-to="tamamlandi">Tamamla</button>`;
    else act = `<span style="color:var(--ink-3);font-size:12px">${timeAgo(r.updated_at)}</span>`;
    tr.innerHTML = `<td class="c-blok">${esc(r.blok_no)}</td>
      <td class="c-pat">${esc(r.patoloji_no)}</td>
      <td class="c-test">${esc(r.test_adi)}${r.klon ? `<small>${esc(r.klon)}</small>` : ""}</td>
      <td><span class="tag">${TIP[r.grup] || "Diğer"}</span></td>
      <td><span class="prio ${PRIO[r.oncelik][0]}">${PRIO[r.oncelik][1]}</span></td>
      <td><span class="pill ${PILL[r.durum][0]}">${PILL[r.durum][1]}</span></td>
      <td>${act}</td>`;
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
  if (toDurum) {
    const label = toDurum === "cihazda" ? "Cihaza al" : "Tamamla";
    rail.insertAdjacentHTML("beforeend", `<div class="rail-foot"><button class="btn-primary" id="advBtn">${label}</button></div>`);
    $("#advBtn").onclick = () => advance(r.kalem_id, toDurum);
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
    <div class="m-sec" id="setsSec"><p class="m-label">Hazır Setler</p><div class="sets" id="sets"></div></div>
    <div class="m-sec" id="mySetsSec"><p class="m-label">Şablonlarım</p><div class="sets" id="mySets"></div></div>` : ""}
    <div class="m-sec" id="antiSec"><p class="m-label">Tek Tek Seç</p>
      <div class="antisearch"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#26221d" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>
        <input id="antiSearch" placeholder="Antikor ara… ER, HER2, CK7…"></div>
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

function renderSets() {
  const s = $("#sets"); if (!s) return;
  const list = SETS_INST[grp] || [];
  $("#setsSec").style.display = list.length ? "" : "none";
  s.innerHTML = "";
  list.forEach((set) => {
    const el = document.createElement("button");
    el.className = "set";
    el.textContent = set.ad;
    el.onclick = () => { applySetTestler(set.testler); el.classList.add("hot"); renderAntis($("#antiSearch")?.value || ""); };
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

function renderAntis(q = "") {
  const wrap = $("#antis");
  if (!wrap) return;
  const isDiger = grp === "diger";
  $("#otherbox").classList.toggle("show", isDiger);
  $("#antiSec").querySelector(".antisearch").style.display = isDiger ? "none" : "";
  wrap.innerHTML = "";

  if (isDiger) {
    customItems.forEach((c) => {
      const el = document.createElement("span");
      el.className = "anti" + (c.sel ? " sel" : "");
      el.textContent = c.ad;
      el.onclick = () => { c.sel = !c.sel; renderAntis(); };
      wrap.appendChild(el);
    });
    return;
  }

  (CAT[grp] || []).filter((t) => t.ad.toLowerCase().includes(q.toLowerCase())).forEach((t) => {
    const el = document.createElement("span");
    el.className = "anti" + (selectedTests.has(t.id) ? " sel" : "");
    el.innerHTML = `${esc(t.ad)}${t.klon ? `<small>${esc(t.klon)}</small>` : ""}`;
    el.onclick = () => {
      if (selectedTests.has(t.id)) selectedTests.delete(t.id);
      else selectedTests.set(t.id, { ad: t.ad, klon: t.klon, grup: t.grup });
      renderAntis(q);
    };
    wrap.appendChild(el);
  });
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
  $("#addOtherBtn").addEventListener("click", () => {
    const v = $("#otherin").value.trim(); if (!v) return;
    const existing = customItems.find((c) => c.ad === v);
    if (existing) existing.sel = true; else customItems.push({ ad: v, sel: true, grup: "diger" });
    $("#otherin").value = ""; renderAntis();
  });
  if (withQuickFill) { renderSets(); renderMySets(); }
  renderAntis();
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
      <div class="m-sec"><p class="m-label">Blok Seçimi <span style="text-transform:none;letter-spacing:0;color:var(--ink-3);font-weight:400">— manuel</span></p>
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
      const v = e.target.value.trim();
      const c = document.createElement("span");
      c.className = "bchip";
      c.innerHTML = `${esc(v)} <span class="x">×</span>`;
      c.querySelector(".x").onclick = () => c.remove();
      $("#blocks").insertBefore(c, e.target);
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

async function submitForm() {
  const patNo = $("#mPat").value.trim();
  if (!patNo) { toast("Patoloji no gerekli", true); return; }
  const bloklar = [...$$("#blocks .bchip")].map((c) => c.textContent.replace("×", "").trim()).filter(Boolean);
  if (!bloklar.length) { toast("En az bir blok girin", true); return; }
  const testler = collectPickedTestler();
  if (!testler.length) { toast("En az bir test seçin", true); return; }

  const uzmanEl = $("#mUzman");
  const uzman_id = uzmanEl && uzmanEl.value ? uzmanEl.value : null;
  const not_metni = $("#mNot").value.trim() || null;

  $("#submitForm").disabled = true;
  try {
    await Api.createIstem({ patoloji_no: patNo, istem_yapan_id: session.id, uzman_id, oncelik: prio, not_metni, bloklar, testler });
    filter = "all";
    toast("İstek oluşturuldu");
    showEmpty();
    await loadQueue();
    if (currentPage === "kuyruk") renderTable();
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
      <div class="nm">${esc(s.ad)}</div>
      <div class="meta">${TIP[s.grup] || "Diğer"}${s.uzmanlik ? " · " + esc(s.uzmanlik) : ""}</div>
      <div class="chips">${s.testler.length ? s.testler.map((t) => `<span class="chip">${esc(t.ad)}</span>`).join("") : '<span class="chip">—</span>'}</div>
      <button class="btn-primary">İstek Ver</button>
    </div>`).join("");
  grid.querySelectorAll(".tile").forEach((tile) => {
    tile.querySelector("button").onclick = (e) => {
      e.stopPropagation();
      const set = list.find((s) => s.id === tile.dataset.id);
      showForm(set);
    };
  });
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
      ${existing ? `<button class="btn-danger" id="toggleAktif">${existing.aktif ? "Pasifleştir" : "Aktifleştir"}</button>` : `<button class="btn-ghost" id="cancelCihaz">İptal</button>`}
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

// ---------------- Statik UI (sadece bir kez bağlanır) ----------------
function wireStaticUI() {
  if (uiWired) return;
  uiWired = true;

  $("#nav").addEventListener("click", (e) => {
    const a = e.target.closest("a[data-page]"); if (!a) return;
    navigate(a.dataset.page);
  });
  $("#newBtn").addEventListener("click", () => showForm());
}

function registerSW() {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => { navigator.serviceWorker.register("sw.js").catch(() => {}); });
  }
}

// ---------------- Boot ----------------
(function boot() {
  $("#authSubmit").addEventListener("click", handleAuthSubmit);
  $("#authPin").addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuthSubmit(); });
  $("#logoutBtn").addEventListener("click", handleLogout);
  registerSW();

  const existing = getSession();
  if (existing) initApp(existing); else showAuth();
})();
