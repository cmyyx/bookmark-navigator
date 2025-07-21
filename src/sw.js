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
    // We only want to handle GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                // If the resource is in the cache, return it
                if (cachedResponse) {
                    return cachedResponse;
                }

                // If the resource is not in the cache, fetch it from the network
                return fetch(event.request)
                    .then((networkResponse) => {
                        // Check if we received a valid response
                        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                            return networkResponse;
                        }

                        // Clone the response because it can only be consumed once
                        const responseToCache = networkResponse.clone();

                        // Cache the new response for future use
                        caches.open(CACHE_NAME)
                            .then((cache) => {
                                cache.put(event.request, responseToCache);
                            });

                        // Return the network response
                        return networkResponse;
                    })
                    .catch(() => {
                        // If the network request fails (e.g., offline),
                        // we don't have a fallback in this case, so we let the request fail.
                        // The browser will handle it. This prevents the service worker from crashing.
                    });
            })
    );
});