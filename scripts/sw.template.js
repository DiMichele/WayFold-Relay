const CACHE_NAME = __CACHE_NAME__;
const PRECACHE_URLS = __PRECACHE_URLS__;
const PRECACHE_SET = new Set(PRECACHE_URLS);
const CACHE_PREFIX = "wayfold-relay-precache-";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function htmlFallbackPath(pathname) {
  if (pathname.endsWith("/")) return `${pathname}index.html`;
  return pathname.endsWith(".html") ? pathname : `${pathname}/index.html`;
}

async function networkFirstHtml(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (
      (await cache.match(request)) ||
      (await cache.match(htmlFallbackPath(new URL(request.url).pathname))) ||
      Response.error()
    );
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const acceptsHtml = request.mode === "navigate" || request.headers.get("accept")?.includes("text/html");
  if (acceptsHtml) {
    event.respondWith(networkFirstHtml(request));
    return;
  }

  if (PRECACHE_SET.has(url.pathname)) {
    event.respondWith(caches.open(CACHE_NAME).then(async (cache) => (await cache.match(request)) || fetch(request)));
  }
});
