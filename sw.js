// Offline support: keeps a copy of the app on the device.
// Bump VERSION (and APP_VERSION in index.html) whenever you upload a changed file, so phones pick up the update.
// Station data is saved by the page itself in the "kippu-data" cache, so it's left alone here.
const VERSION = "kippu-v2";
const DATA_CACHE = "kippu-data";
const FILES = [
  "./",
  "./index.html",
  "./logic.js",
  "./lang.js",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./leaflet.js",
  "./leaflet.css"
];
const SHELL = new Set(FILES.map(f => new URL(f, self.location).href));

self.addEventListener("install", event => {
  // cache: "reload" skips the browser's own copy, which GitHub Pages lets go 10 minutes stale
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(FILES.map(f => new Request(f, { cache: "reload" })))));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== DATA_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  // The app page comes from this version's saved copy, so it always matches the saved logic.js.
  // New versions arrive when sw.js changes (raise VERSION), which saves every file together.
  if (req.mode === "navigate") {
    event.respondWith(caches.open(VERSION).then(c => c.match("./index.html")).then(hit => hit || fetch(req)));
    return;
  }

  const url = new URL(req.url);
  url.search = "";
  if (SHELL.has(url.href)) event.respondWith(caches.open(VERSION).then(c => c.match(url.href)).then(hit => hit || fetch(req)));
});
