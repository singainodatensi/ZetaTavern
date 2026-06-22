const CACHE_NAME = 'zetatavern-cache-v104';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './marked.js',
  './js/app.js',
  './js/db.js',
  './js/state.js',
  './js/ai-client.js',
  './js/ui.js',
  './js/story-characters.js',
  './js/sanitizer.js',
  './js/dropbox.js',
  './assets/default-silhouette.png'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Dropbox / AI API / temporary download URLs などの外部通信は、
  // Service Worker で 504 に置き換えずブラウザの通常通信に任せる。
  if (url.origin !== self.location.origin) {
    return;
  }

  // HTML / JS は常にネットワーク優先（OAuth 修正や古い SW キャッシュ対策）
  const isAppShell =
    req.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css');

  if (isAppShell) {
    event.respondWith(
      fetch(req)
        .then(networkRes => {
          if (networkRes && networkRes.ok) {
            const copy = networkRes.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, copy));
          }
          return networkRes;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
          return new Response('Offline', {
            status: 503,
            statusText: 'Offline',
            headers: { 'Content-Type': 'text/plain; charset=UTF-8' }
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).catch(() => new Response('', { status: 504, statusText: 'Gateway Timeout' }));
    })
  );
});

self.addEventListener('activate', event => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});
