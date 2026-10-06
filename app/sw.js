// sw.js — sadece uygulama kabuğunu (statik dosyalar) önbelleğe alır.
// Supabase istekleri (farklı origin) her zaman ağdan geçer, asla önbellek/offline
// mantığına takılmaz.
//
// index.html, app.js, api.js ve config.js İSTİSNADIR: network-first ile
// servis edilir — önce ağdan denenir, sadece ağ başarısız olursa
// (çevrimdışı) son bilinen önbellek kopyasına düşülür. Bunlar uygulamanın
// DAVRANIŞINI belirleyen dosyalar (auth/boot mantığı dahil) — eski bir
// kopyada takılı kalmak sadece görsel değil, işlevsel/güvenlik hatalarına
// yol açabilir (bkz. boot() — eski app.js'te oturum doğrulaması olmayabilir).
// styles.css bilerek cache-first kalıyor: en kötü ihtimalle bayat bir görsel
// verir, davranışı bozmaz.
const CACHE = "istem-shell-v30";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./api.js",
  "./tema.js",
  "./ocr.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
  "./icons/selcuk-logo.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// index.html (ve kök "/") + config.js — network-first. Navigasyon istekleri
// (sekme açılış/yenileme) de her zaman buraya düşer, çünkü tarayıcı bunları
// "./"/"./index.html" yerine doğrudan mode:"navigate" ile isteyebilir.
function isNetworkFirst(url, req) {
  return req.mode === "navigate"
    || url.pathname.endsWith("/config.js")
    || url.pathname.endsWith("/app.js")
    || url.pathname.endsWith("/api.js")
    || url.pathname.endsWith("/index.html")
    || url.pathname.endsWith("/");
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  if (isNetworkFirst(url, req)) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // diğer kabuk dosyaları — önce önbellek, olmazsa ağ.
  e.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
            return res;
          })
          .catch(() => cached)
    )
  );
});

// ---------------- Web Push (push-gonder) ----------------
// Uygulama açık ve öndeyse sistem bildirimi gösterilmez (ekran içi banner +
// ses zaten var). Safari/iOS HARİÇ: Apple her push'ta bildirim gösterilmesini
// şart koşar, aksi halde aboneliği iptal edebilir — orada her zaman gösterilir.
const SAFARI = /AppleWebKit/.test(self.navigator.userAgent) && !/Chrome|Chromium|CriOS|Edg|Android/.test(self.navigator.userAgent);
self.addEventListener("push", (e) => {
  let v = {};
  try { v = e.data ? e.data.json() : {}; } catch (_) { v = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    if (!SAFARI) {
      const pencereler = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      if (pencereler.some((c) => c.visibilityState === "visible" && c.focused)) return;
    }
    await self.registration.showNotification(v.title || "İstem", {
      body: v.body || "",
      tag: v.tag || "istem",
      renotify: true,
      icon: "icons/selcuk-logo.png",
      badge: "icons/selcuk-logo.png",
      data: { url: v.url || "./" },
    });
  })());
});

// Bildirime dokununca: açık bir pencere varsa öne getir, yoksa uygulamayı aç.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const hedef = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const pencereler = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const acik = pencereler.find((c) => c.url.startsWith(self.registration.scope));
    if (acik) { await acik.focus(); return; }
    await self.clients.openWindow(hedef);
  })());
});
