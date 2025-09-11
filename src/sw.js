const CACHE_NAME = 'bookmarks-cache-v1';

// The build script will replace these placeholders
const CORE_ASSETS = self.__CORE_ASSETS__ || [];
const ICON_ASSETS = self.__ICON_ASSETS__ || [];

self.addEventListener('install', (event) => {
    const channel = new BroadcastChannel('sw-messages');

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Pre-caching core assets...');
                const allAssetsToCache = [...CORE_ASSETS, ...ICON_ASSETS];
                const totalAssets = allAssetsToCache.length;
                let cachedCount = 0;

                const cachePromises = allAssetsToCache.map(asset => {
                    return cache.add(asset)
                        .then(() => {
                            cachedCount++;
                            // 立即发送进度更新
                            channel.postMessage({
                                type: 'caching-progress',
                                payload: { total: totalAssets, current: cachedCount, asset: asset, status: 'success' }
                            });
                        })
                        .catch(err => {
                            console.warn(`Failed to cache asset: ${asset}`, err);
                        });
                });
                return Promise.all(cachePromises);
            })
            .then(() => {
                console.log('[Service Worker] All assets cached. Installation complete.');
                channel.postMessage({ type: 'caching-complete' });
                channel.close();
                return self.skipWaiting();
            })
            .catch(error => {
                console.error('[Service Worker] Caching failed:', error);
                channel.postMessage({ type: 'caching-error', payload: { message: error.message } });
                channel.close();
            })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[Service Worker] Clearing old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // 1. 对API请求不使用缓存
    if (url.origin === 'http://localhost:3000') {
        event.respondWith(fetch(request));
        return;
    }
    
    // 2. 对于导航请求 (index.html)，采用网络优先策略
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() => caches.match('index.html'))
        );
        return;
    }

    // 3. 对所有其他资源 (带哈希的JS/CSS, 图标, 字体等)，采用缓存优先策略
    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            return cachedResponse || fetch(request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseToCache = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseToCache);
                    });
                }
                return networkResponse;
            });
        })
    );
});