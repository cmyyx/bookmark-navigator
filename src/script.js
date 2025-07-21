// --- Service Worker Registration & Communication (Immediate Execution) ---
const statusIndicator = document.getElementById('status-indicator');

const showStatus = (message, duration) => {
    if (!statusIndicator) return;

    // Apply styles directly via JS to bypass any potential CSS caching issues.
    // This makes the feature more robust.
    Object.assign(statusIndicator.style, {
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        color: 'white',
        padding: '10px 20px',
        borderRadius: '5px',
        fontSize: '14px',
        zIndex: '1001',
        transition: 'opacity 0.5s',
        opacity: '1',
        visibility: 'visible'
    });

    statusIndicator.textContent = message;

    if (duration) {
        setTimeout(() => {
            statusIndicator.style.opacity = '0';
            // Hide it completely after the transition
            setTimeout(() => {
                statusIndicator.style.visibility = 'hidden';
            }, 500); // Corresponds to transition duration
        }, duration);
    }
};

if ('serviceWorker' in navigator) {
    let installTimeout;

    // Use a Broadcast Channel for the most reliable communication.
    const channel = new BroadcastChannel('sw-messages');
    channel.onmessage = (event) => {
        clearTimeout(installTimeout);
        if (!event.data || !statusIndicator) return;
        const { type, payload } = event.data;

        if (type === 'caching-progress') {
            const { total, current, asset, status } = payload;
            const statusText = status === 'success' ? '缓存成功' : '缓存失败';
            showStatus(`[${current}/${total}] ${statusText}: ${asset}`);
        } else if (type === 'caching-complete') {
            showStatus('离线资源加载完成。', 5000);
            channel.close(); // We can close the channel once the work is done.
        }
    };

    // Register the service worker with the correct absolute path for deployed environments.
    navigator.serviceWorker.register('sw.js').then(registration => {
        console.log('Service Worker registered, waiting for installation...');
        installTimeout = setTimeout(() => {
            showStatus('离线功能安装超时，请使用 Ctrl+Shift+R 强制刷新重试。');
        }, 20000); // Increased timeout to 20s for very slow networks

        const installingWorker = registration.installing;
        if (installingWorker) {
            installingWorker.onstatechange = () => {
                if (installingWorker.state === 'redundant') {
                    clearTimeout(installTimeout);
                    showStatus('离线功能安装失败，请使用 Ctrl+Shift+R 强制刷新重试。');
                    console.error('Service Worker installation failed, it became redundant.');
                }
            };
        } else {
            clearTimeout(installTimeout);
        }
    }).catch(error => {
        console.error('Service Worker registration failed:', error);
        showStatus('Service Worker 注册失败，浏览器可能不支持或已禁用。');
    });

    if (navigator.serviceWorker.controller) {
        console.log('This page is already controlled by a service worker.');
        showStatus('已从缓存加载。', 3000);
    }
}

// --- Main Application Logic ---
document.addEventListener('DOMContentLoaded', () => {
    const folderTree = document.getElementById('folder-tree');
    const bookmarkGrid = document.getElementById('bookmark-grid');
    const searchInput = document.getElementById('search-input');
    const engineSelector = document.querySelector('.engine-selector');

    let bookmarksData = [];
    let allBookmarks = [];
    let searchEngines = {};
    let backgroundConfig = {};
    let currentEngine = 'bookmark';
    let currentSearchUrl = null;
    let iconObserver;

    const init = async () => {
        setupIconObserver();
        await Promise.all([loadConfig(), loadBookmarks()]);
        renderSearchEngines();
        if (bookmarksData.length > 0 && bookmarksData[0].children) {
            renderFolderTree(bookmarksData[0].children, folderTree, 0);
        }
        if (bookmarksData.length > 0) {
            const firstFolder = findFirstFolderWithBookmarks(bookmarksData);
            if (firstFolder) {
                renderBookmarks(firstFolder.bookmarks);
            }
        }
        setupEventListeners();
        setActiveEngine('bookmark');
        setupBackground();
    };

    const setupBackground = () => {
        if (!backgroundConfig || !backgroundConfig.fallback) {
            console.error("Background config is missing or invalid.");
            return;
        }
        if (backgroundConfig.api && backgroundConfig.api.enabled) {
            loadDynamicBackgroundWithTransition(backgroundConfig.api.url, backgroundConfig.fallback);
        } else {
            loadDynamicBackgroundWithTransition(backgroundConfig.fallback);
        }
    };

    const loadDynamicBackgroundWithTransition = (primaryUrl, fallbackUrl) => {
        const img = new Image();
        img.src = primaryUrl;
        img.onload = () => {
            document.documentElement.style.setProperty('--bg-image', `url('${primaryUrl}')`);
            document.body.classList.add('background-loaded');
        };
        img.onerror = () => {
            console.error(`Failed to load primary image: ${primaryUrl}.`);
            if (fallbackUrl) {
                const fallbackImg = new Image();
                fallbackImg.src = fallbackUrl;
                fallbackImg.onload = () => {
                    document.documentElement.style.setProperty('--bg-image', `url('${fallbackUrl}')`);
                    document.body.classList.add('background-loaded');
                };
                fallbackImg.onerror = () => console.error(`Failed to load fallback image: ${fallbackUrl}.`);
            } else {
                console.error('No fallback image available.');
            }
        };
    };

    const loadConfig = async () => {
        try {
            const response = await fetch('config.json');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const config = await response.json();
            searchEngines = config.searchEngines;
            backgroundConfig = config.background || { enabled: false };
        } catch (error) {
            console.error("无法加载配置文件:", error);
        }
    };

    const loadBookmarks = async () => {
        try {
            const response = await fetch('bookmarks.json');
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            bookmarksData = await response.json();
            allBookmarks = flattenBookmarks(bookmarksData);
        } catch (error) {
            console.error("无法加载书签数据:", error);
            bookmarkGrid.innerHTML = '<p style="color: #ffcccc;">加载书签数据失败，请检查 bookmarks.json 文件。</p>';
        }
    };

    const flattenBookmarks = (nodes, path = []) => {
        let bookmarks = [];
        for (const node of nodes) {
            const currentPath = [...path, node.name];
            if (node.bookmarks) {
                node.bookmarks.forEach(b => {
                    if (!b.path) b.path = path.join(' / ');
                });
                bookmarks = bookmarks.concat(node.bookmarks);
            }
            if (node.children) {
                bookmarks = bookmarks.concat(flattenBookmarks(node.children, currentPath));
            }
        }
        return bookmarks;
    };

    const findFirstFolderWithBookmarks = (nodes) => {
        for (const node of nodes) {
            if (node.bookmarks && node.bookmarks.length > 0) return node;
            if (node.children) {
                const found = findFirstFolderWithBookmarks(node.children);
                if (found) return found;
            }
        }
        return null;
    };

    const renderFolderTree = (nodes, parentElement, level) => {
        const ul = document.createElement('ul');
        if (level > 0) ul.style.paddingLeft = `1rem`;
        nodes.forEach(node => {
            if (!node.name) return;
            const li = document.createElement('li');
            li.textContent = node.name;
            li.classList.add('folder-item');
            li.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.folder-item').forEach(el => el.classList.remove('active'));
                li.classList.add('active');
                renderBookmarks(node.bookmarks || []);
            });
            parentElement.appendChild(li);
            if (node.children && node.children.length > 0) {
                renderFolderTree(node.children, li, level + 1);
            }
        });
    };

    const renderBookmarks = (bookmarks) => {
        bookmarkGrid.innerHTML = '';
        if (!bookmarks || bookmarks.length === 0) return;
        bookmarks.forEach(bookmark => {
            const item = document.createElement('a');
            item.href = bookmark.url;
            item.target = '_blank';
            item.rel = 'noopener noreferrer';
            item.classList.add('bookmark-item');

            const icon = document.createElement('img');
            icon.dataset.src = bookmark.icon;
            icon.src = 'assets/placeholder_icon.svg';
            icon.onerror = () => {
                icon.src = 'assets/placeholder_icon.svg';
                if (iconObserver) iconObserver.unobserve(item);
            };

            const name = document.createElement('span');
            name.textContent = bookmark.name;
            name.title = bookmark.name;

            item.appendChild(icon);
            item.appendChild(name);

            if (bookmark.path) {
                const pathElement = document.createElement('small');
                pathElement.classList.add('bookmark-path');
                pathElement.textContent = bookmark.path;
                pathElement.title = bookmark.path;
                item.appendChild(pathElement);
            }

            bookmarkGrid.appendChild(item);
            if (iconObserver) iconObserver.observe(item);
        });
    };

    const renderSearchEngines = () => {
        engineSelector.innerHTML = '';
        for (const key in searchEngines) {
            const engine = searchEngines[key];
            const option = document.createElement('div');
            option.classList.add('engine-option');
            option.dataset.engineKey = key;

            const icon = document.createElement('img');
            icon.src = engine.icon;
            icon.onerror = () => { icon.src = 'assets/placeholder_icon.svg'; };

            const name = document.createElement('span');
            name.textContent = engine.name;

            option.appendChild(icon);
            option.appendChild(name);

            if (engine.engines) {
                const dropdown = document.createElement('div');
                dropdown.classList.add('dropdown');
                for (const subKey in engine.engines) {
                    const subEngine = engine.engines[subKey];
                    const dropdownItem = document.createElement('div');
                    dropdownItem.classList.add('dropdown-item');
                    dropdownItem.dataset.engineKey = subKey;
                    dropdownItem.dataset.parentKey = key;

                    const subIcon = document.createElement('img');
                    subIcon.src = subEngine.icon;
                    subIcon.onerror = () => { subIcon.src = 'assets/placeholder_icon.svg'; };

                    const subName = document.createElement('span');
                    subName.textContent = subEngine.name;

                    dropdownItem.appendChild(subIcon);
                    dropdownItem.appendChild(subName);
                    dropdown.appendChild(dropdownItem);
                }
                option.appendChild(dropdown);
            }
            engineSelector.appendChild(option);
        }
    };

    const setActiveEngine = (key, parentKey) => {
        document.querySelectorAll('.engine-option, .dropdown-item').forEach(el => {
            el.classList.remove('active', 'parent-active');
        });
        if (parentKey) {
            const parentEl = engineSelector.querySelector(`.engine-option[data-engine-key="${parentKey}"]`);
            const subEl = engineSelector.querySelector(`.dropdown-item[data-engine-key="${key}"]`);
            if (parentEl) parentEl.classList.add('parent-active');
            if (subEl) subEl.classList.add('active');
            const parentEngine = searchEngines[parentKey];
            const subEngine = parentEngine.engines[key];
            currentEngine = key;
            currentSearchUrl = subEngine.url;
        } else {
            const engineEl = engineSelector.querySelector(`.engine-option[data-engine-key="${key}"]`);
            if (engineEl) engineEl.classList.add('active');
            const engine = searchEngines[key];
            currentEngine = key;
            currentSearchUrl = engine.url;
        }
        searchInput.focus();
    };

    const setupIconObserver = () => {
        const options = { root: null, rootMargin: '0px', threshold: 0.1 };
        iconObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const item = entry.target;
                    const icon = item.querySelector('img');
                    const realSrc = icon.dataset.src;
                    if (realSrc) {
                        icon.src = realSrc;
                        observer.unobserve(item);
                    }
                }
            });
        }, options);
    };

    const setupEventListeners = () => {
        engineSelector.addEventListener('click', (e) => {
            const target = e.target.closest('.engine-option, .dropdown-item');
            if (!target) return;
            const key = target.dataset.engineKey;
            const parentKey = target.dataset.parentKey;
            setActiveEngine(key, parentKey);
        });

        searchInput.addEventListener('input', () => {
            if (currentEngine === 'bookmark') {
                const query = searchInput.value.toLowerCase();
                if (query) {
                    const filteredBookmarks = allBookmarks.filter(b =>
                        b.name.toLowerCase().includes(query) || b.url.toLowerCase().includes(query)
                    );
                    renderBookmarks(filteredBookmarks);
                } else {
                    const activeFolder = document.querySelector('.folder-item.active');
                    if (activeFolder) activeFolder.click();
                    else if (bookmarksData.length > 0) {
                        const firstFolder = findFirstFolderWithBookmarks(bookmarksData);
                        if (firstFolder) renderBookmarks(firstFolder.bookmarks);
                    }
                }
            }
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && searchInput.value && currentSearchUrl) {
                const url = currentSearchUrl.replace('{query}', encodeURIComponent(searchInput.value));
                window.open(url, '_blank');
            }
        });
    };

    init();
});