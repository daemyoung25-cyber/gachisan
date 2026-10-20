/* Bump CACHE on every deploy so phones fetch the new files. */
const CACHE = "gachisan-202610202300";
const LIBS = "gachisan-libs";
const TILES = "gachisan-tiles";
const MAX_TILES = 6000;
const FILES = ["./", "index.html", "app.js", "store.js", "m100.js", "firebase-config.js", "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
const TILE_HOSTS = /(^|\.)tile\.opentopomap\.org$|^tile\.openstreetmap\.org$|^tile\.waymarkedtrails\.org$/;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![CACHE, LIBS, TILES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

let puts = 0;
async function trimTiles(c) {
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_TILES))) await c.delete(k);
}

/* Own files: network first so updates show right away, cache when offline.
   Leaflet / Firebase SDK (pinned versions): cache first.
   Map tiles: cache first; a/b/c subdomains share one key so pre-downloaded tiles always hit. */
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
    );
    return;
  }
  if (url.hostname === "cdnjs.cloudflare.com" || (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/"))) {
    e.respondWith(
      caches.open(LIBS).then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) c.put(req, res.clone());
        return res;
      })))
    );
    return;
  }
  if (TILE_HOSTS.test(url.hostname)) {
    const key = req.url.replace(/^https:\/\/[abc]\.tile\.opentopomap\.org/, "https://tile.opentopomap.org");
    e.respondWith(
      caches.open(TILES).then((c) => c.match(key).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { c.put(key, res.clone()); if (++puts % 200 === 0) trimTiles(c); }
        return res;
      })))
    );
  }
});
