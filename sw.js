const CACHE_NAME = 'zetatavern-cache-v2';
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
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // キャッシュがあればキャッシュを返し、なければネットワークから取得する
        if (response) {
          return response;
        }
        return fetch(event.request);
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
    })
  );
});
