// Service worker: makes the app open instantly and work offline.
//  - App files: cache-first (bump VERSION when they change).
//  - Data files (schedule, predictions, backtest from Supabase storage):
//    network-first, falling back to the last copy. Simulations and other
//    model requests are POSTs to the model API and never cached.
//  - Team logos and fonts: cache-first once seen.

const VERSION = "v20";
const SHELL_CACHE = `shell-${VERSION}`;
const RUNTIME_CACHE = "runtime";

const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "js/app.js",
  "js/teams.js",
  "js/scoring.js",
  "js/lines.js",
  "js/bets.js",
  "js/betsview.js",
  "js/account.js",
  "js/config.js",
  "js/vendor/supabase.js",
  "js/scorecard.js",
  "js/sim/schedule.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k.startsWith("shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k)),
    )).then(() => self.clients.claim()),
  );
});

async function networkFirst(request) {
  const cache = await caches.open(RUNTIME_CACHE);
  try {
    const resp = await fetch(request);
    if (resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const resp = await fetch(request);
  if (resp.ok || resp.type === "opaque") cache.put(request, resp.clone());
  return resp;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Public data in Supabase storage: network-first, falling back to the last copy.
  if (url.hostname.endsWith(".supabase.co") && url.pathname.includes("/storage/v1/object/public/")) {
    event.respondWith(networkFirst(request));
  } else if (url.origin === self.location.origin && url.pathname.includes("/data/")) {
    event.respondWith(networkFirst(request));
  } else if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  } else if (url.hostname === "assets.nhle.com" || url.hostname.endsWith("gstatic.com") || url.hostname === "fonts.googleapis.com") {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
  }
});
