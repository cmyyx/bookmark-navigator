const CACHE_NAME = 'bookmarks-cache-v1';
// 这个占位符将在后续步骤中由构建脚本动态替换
const FILES_TO_CACHE = []; // __REPLACE_ME__

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching offline page');
      return cache.addAll(FILES_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        if (key !== CACHE_NAME) {
          console.log('[Service Worker] Removing old cache', key);
          return caches.delete(key);
        }
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') {
    // Not a page navigation, bail.
    return;
  }
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        const response = await cache.match(event.request);
        return response || fetch(event.request);
      } catch (error) {
        console.log('Fetch failed; returning offline page instead.', error);
        // Fallback or error handling can be added here
      }
    })
  );
});