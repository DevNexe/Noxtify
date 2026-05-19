const CACHE = "noxtify-v5";

self.addEventListener("install", e => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  
  // Всё из /static/ и /api/ — всегда с сервера, без кэша
  if (url.pathname.startsWith("/static/") || url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request));
    return;
  }
  
  // HTML страницы — тоже без кэша
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request));
    return;
  }
});