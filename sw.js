/* Offline support. The engine alone is 1.5MB, so without this the home-screen
   app re-downloads it on every cold start and does nothing on a plane. */
const VERSION = 'v1';
const CACHE = `chess-coach-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './logic.js',
  './book.js',
  './app.js',
  './pieces.svg',
  './manifest.webmanifest',
  './vendor/chess.js',
  './vendor/stockfish.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never intercept anything external

  // Navigations go to the network first, so a new deploy lands on the next
  // visit rather than being pinned by the cache; the cache is the fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // Everything else is served from the cache and refreshed behind the scenes.
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
