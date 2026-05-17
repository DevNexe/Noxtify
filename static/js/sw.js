const CACHE = "noxtify-v5";
const STATIC = [
  "/",
  "/static/css/app.css",
  "/static/js/app.js",
  "/static/langs/ru.json",
  "/static/langs/en.json",
  "/manifest.json"
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Stream audio directly — never cache
  if (url.pathname.startsWith("/api/v1/stream/")) return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res.ok && e.request.method === "GET") {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => cached || new Response("Offline", {status: 503}));
    })
  );
});
