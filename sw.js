// Court Sense — service worker. Caches the app shell so it loads and runs
// with no internet at the court. Bump CACHE to ship a new version.
const CACHE = "court-sense-v1";
const ASSETS = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "engine.js",
  "store.js",
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

// Cache-first for our own files; network as a fallback; offline navigations
// fall back to the app shell so the organizer always gets a working screen.
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  e.respondWith(
    caches.match(req).then(hit =>
      hit || fetch(req).then(res => {
        if (res && res.ok && new URL(req.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => req.mode === "navigate" ? caches.match("index.html") : undefined)
    )
  );
});
