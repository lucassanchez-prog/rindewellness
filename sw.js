// Service worker mínimo: solo existe para que el navegador ofrezca
// "Agregar a la pantalla de inicio" (evita tener que buscar la URL en el
// navegador cada vez, útil para cargar un gasto parado en terreno) y para
// mostrar la app (aunque sea desactualizada) si se abre sin señal, en vez
// de una pantalla en blanco.
//
// A PROPÓSITO no cachea nada de Supabase, Resend, Gemini ni los CDN
// externos (xlsx/jspdf/pdf.js) -- ver el filtro de mismo-origen en
// fetch() más abajo. Tampoco cachea con estrategia "cache-first": siempre
// intenta la red PRIMERO y solo cae al caché si falla (sin conexión). Con
// "cache-first" alguien podía quedar viendo una versión vieja de la app
// indefinidamente sin darse cuenta -- justo el problema de caché que ya
// nos mordió varias veces con index.html/styles.css durante el desarrollo.
const CACHE_NAME = "rindewellness-shell-v1";
const SHELL_FILES = ["/", "/index.html", "/styles.css", "/pure.js", "/config.js", "/manifest.json", "/assets/logo-gw.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((nombres) =>
      Promise.all(nombres.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Nada fuera de este origen (Supabase, Resend, Gemini, CDNs) pasa por
  // acá -- esas peticiones siguen su camino normal, sin intervención.
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((resp) => {
        const copia = resp.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia)).catch(() => {});
        return resp;
      })
      .catch(() =>
        caches.match(event.request).then((cacheado) => cacheado || caches.match("/index.html"))
      )
  );
});
