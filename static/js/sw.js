const CACHE = "noxtify-v6";

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
  // Обрабатываем только http/https запросы
  if (!e.request.url.startsWith("http")) return;

  const url = new URL(e.request.url);

  // /static/, /api/ и navigate — network-first с fallback
  if (
    url.pathname.startsWith("/static/") ||
    url.pathname.startsWith("/api/") ||
    e.request.mode === "navigate"
  ) {
    e.respondWith(
      fetch(e.request).catch(() => {
        if (e.request.mode === "navigate") {
          return new Response(
            "<html><body><p style='font-family:sans-serif;padding:20px'>Нет подключения</p></body></html>",
            { headers: { "Content-Type": "text/html" } }
          );
        }
        return new Response("", { status: 503 });
      })
    );
  }
});