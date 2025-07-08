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
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(keyList.map((key) => {
        // 如果缓存名不在白名单中，则删除它
        if (cacheWhitelist.indexOf(key) === -1) {
          console.log('[Service Worker] Deleting old cache:', key);
          return caches.delete(key);
        }
      }));
    })
  );
  self.clients.claim();
});

// 正确的“缓存优先”策略
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // 如果在缓存中找到了匹配的响应，则直接返回它。
      if (response) {
        return response;
      }
      // 如果缓存中没有，则通过网络去获取。
      // （这主要用于处理一些意外情况，因为我们已经预缓存了所有文件）
      return fetch(event.request);
    })
  );
});