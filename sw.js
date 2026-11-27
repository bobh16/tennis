// Court Sense — service worker.
// Network-first for our own files so updates always show when online, with a
// cache fallback so the app still runs offline at the court. Bump CACHE to
// force older installs to drop their old cache.
const CACHE = "court-sense-v10";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "engine.js",
  "store.js",
  "tournaments.js",
  "config.js",
  "sync.js",
  "tennis.js",
  "umpire.html",
  "umpire.js",
  "manifest.webmanifest",
  "icon.svg",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== location.origin) return; // let fonts etc. hit the network directly
  // Network-first: always try fresh, update the cache, fall back to cache offline.
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || (req.mode === "navigate" ? caches.match("index.html") : Response.error())))
  );
});
