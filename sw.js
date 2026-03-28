const CACHE_NAME = 'ams-player-cache-v1.2.2';
const urlsToCache = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache))
  );
});

self.addEventListener('fetch', event => {
  // FirebaseやYouTubeの外部通信はキャッシュしない設定
  if (event.request.url.includes('firebase') || event.request.url.includes('googleapis')) {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});
