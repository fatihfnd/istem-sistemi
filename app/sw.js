// sw.js — sadece uygulama kabuğunu (statik dosyalar) önbelleğe alır.
// Supabase istekleri (farklı origin) her zaman ağdan geçer, asla önbellek/offline
// mantığına takılmaz.
//
// config.js İSTİSNADIR: network-first ile servis edilir. Böylece kullanıcı
// Supabase bilgilerini güncelleyince eski (boş) kopya önbellekten dönmez;
// çevrimdışıyken son bilinen kopyaya düşer.
const CACHE = "istem-shell-v4";
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

function isConfig(url) {
  return url.pathname.endsWith("/config.js") || url.pathname === "/config.js";
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;

  // config.js — önce ağ, olmazsa önbellek.
  if (isConfig(url)) {
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
