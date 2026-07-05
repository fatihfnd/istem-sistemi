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
const CACHE = "istem-shell-v18";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./api.js",
  "./manifest.json",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
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
