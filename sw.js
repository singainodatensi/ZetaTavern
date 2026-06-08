const CACHE_NAME = 'zetatavern-cache-v49';
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
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => cached || fetch(req))
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
    })
  );
});
