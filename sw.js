/* Offline support. The engine alone is 1.5MB, so without this the home-screen
   app re-downloads it on every cold start and does nothing on a plane.

   Code is served network-first and only falls back to the cache when offline.
   An earlier version served everything cache-first, which meant a deploy was
   always one reload behind — you'd get the previous build, and the new one only
   on the load after that. Big immutable assets stay cache-first. */
const VERSION = 'v4';
const CACHE = `chess-coach-${VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './logic.js',
  './book.js',
  './app.js',
  './pieces.svg',
  './puzzles.json',
  './manifest.webmanifest',
  './vendor/chess.js',
  './vendor/stockfish.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Large and effectively immutable — always worth serving straight from cache.
function isStaticAsset(pathname) {
  return pathname.includes('/vendor/')
    || pathname.includes('/icons/')
    || pathname.endsWith('.svg')
    || pathname.endsWith('.png');
}

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

function cacheFirst(req) {
  return caches.match(req).then((hit) => {
    const network = fetch(req).then((res) => {
      if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone())).catch(() => {});
      return res;
    }).catch(() => hit);
    return hit || network;
  });
}

function networkFirst(req, fallbackKey) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(fallbackKey || req, copy)).catch(() => {});
      }
      return res;
    })
    .catch(() => caches.match(fallbackKey || req).then((hit) => hit || caches.match('./index.html')));
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // never intercept anything external

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, './index.html'));
    return;
  }
  event.respondWith(isStaticAsset(url.pathname) ? cacheFirst(req) : networkFirst(req));
});
