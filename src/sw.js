const CACHE_NAME = 'bookmarks-cache-v1';

// The build script will replace these placeholders
const CORE_ASSETS = self.__CORE_ASSETS__ || [];
const ICON_ASSETS = self.__ICON_ASSETS__ || [];

self.addEventListener('install', (event) => {
    // Create the channel once at the start of the install event.
    const channel = new BroadcastChannel('sw-messages');

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[Service Worker] Pre-caching core assets...');
                return cache.addAll(CORE_ASSETS)
                    .then(() => {
                        console.log('[Service Worker] Caching individual icons in chunks...');
                        const totalIcons = ICON_ASSETS.length;
                        let processedCount = 0;

                        // This function now uses the Broadcast Channel.
                        const postProgress = (asset, status) => {
                            processedCount++;
                            channel.postMessage({
                                type: 'caching-progress',
                                payload: {
                                    total: totalIcons,
                                    current: processedCount,
                                    asset: asset,
                                    status: status
                                }
                            });
                        };

                        const chunkSize = 10;
                        const chunks = [];
                        for (let i = 0; i < totalIcons; i += chunkSize) {
                            chunks.push(ICON_ASSETS.slice(i, i + chunkSize));
                        }

                        return chunks.reduce((promise, chunk) => {
                            return promise.then(() => {
                                const chunkPromises = chunk.map(asset => {
                                    return cache.add(asset)
                                        .then(() => postProgress(asset, 'success'))
                                        .catch(err => {
                                            postProgress(asset, 'failed');
                                            console.warn(`Failed to cache icon: ${asset}`, err);
                                        });
                                });
                                return Promise.all(chunkPromises);
                            });
                        }, Promise.resolve());
                    });
            })
            .then(() => {
                console.log('[Service Worker] All assets processed. Installation complete. Activating now.');
                // Send the completion message and close the channel.
                channel.postMessage({ type: 'caching-complete' });
                channel.close();
                return self.skipWaiting();
            })
            .catch(error => {
                console.error('[Service Worker] Core asset caching failed, installation aborted:', error);
                channel.postMessage({ type: 'caching-error', payload: { message: error.message } });
                channel.close();
                // Do not call skipWaiting() if core assets fail, to allow for retry.
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
        })
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // 1. 对于发往代理的API请求，直接从网络获取，不使用缓存
    if (url.origin === 'http://localhost:3000') {
        // 直接执行网络请求，不经过缓存
        event.respondWith(fetch(request));
        return;
    }

    // 2. 对于其他GET请求，采用 "Cache then network" 策略
    if (request.method === 'GET') {
        event.respondWith(
            caches.open(CACHE_NAME).then((cache) => {
                return cache.match(request).then((cachedResponse) => {
                    // 如果缓存命中，则返回缓存的响应
                    if (cachedResponse) {
                        return cachedResponse;
                    }

                    // 如果缓存未命中，则从网络获取
                    return fetch(request).then((networkResponse) => {
                        // 仅缓存有效的、非不透明的响应
                        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                            // 克隆响应，因为请求和响应流只能被消费一次
                            const responseToCache = networkResponse.clone();
                            cache.put(request, responseToCache);
                        }
                        return networkResponse;
                    }).catch(error => {
                        // 当网络请求失败时 (例如离线), 返回一个标准的错误响应
                        // 这修复了 "解析除了非响应值 ‘undefined’" 的问题
                        console.error('[Service Worker] Fetch failed; returning offline fallback. Request:', request.url, error);
                        // 可以返回一个自定义的离线页面或一个简单的错误响应
                        return new Response('Network error: You are offline', {
                            status: 408,
                            headers: { 'Content-Type': 'text/plain' },
                        });
                    });
                });
            })
        );
    }
});