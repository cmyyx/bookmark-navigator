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

    // --- 初始化 ---
    const init = async () => {
        await Promise.all([
            loadConfig(),
            loadBookmarks()
        ]);
        
        renderSearchEngines();
        if (bookmarksData.length > 0 && bookmarksData[0].children) {
            renderFolderTree(bookmarksData[0].children, folderTree, 0);
        }
        
        if (bookmarksData.length > 0) {
            const firstFolder = findFirstFolderWithBookmarks(bookmarksData);
            if (firstFolder) {
                renderBookmarks(firstFolder.bookmarks);
                updateOnlineStatus();
                // TODO: Highlight the first folder
            }
        }
        
        setupEventListeners();
        setActiveEngine('bookmark');
        
        setupBackground();
    };

    // --- 背景设置 ---
    const setupBackground = () => {
        if (!backgroundConfig || !backgroundConfig.fallback) {
            console.error("Background config is missing or invalid.");
            return;
        }

        // 始终设置一个默认背景
        document.documentElement.style.setProperty('--bg-image', `url('${backgroundConfig.fallback}')`);

        // 如果启用了API，则加载动态背景并应用过渡
        if (backgroundConfig.api && backgroundConfig.api.enabled) {
            loadDynamicBackgroundWithTransition();
        }
    };

    const loadDynamicBackgroundWithTransition = () => {
        const { url: apiUrl } = backgroundConfig.api;
        const transitionDuration = 800; // 必须与 CSS 中的 transition-duration 匹配

        const img = new Image();
        
        const updateBackground = (imageUrl) => {
            // 1. 触发淡出
            document.body.classList.add('background-fade-out');

            // 2. 等待淡出动画完成
            setTimeout(() => {
                // 3. 更新背景图片
                document.documentElement.style.setProperty('--bg-image', `url('${imageUrl}')`);
                
                // 4. 触发淡入
                document.body.classList.remove('background-fade-out');
            }, transitionDuration);
        };

        img.onload = () => {
            updateBackground(img.src);
        };

        img.onerror = () => {
            console.error('Failed to load dynamic background, using fallback.');
            // 当API失败时，我们不需要做任何事，因为fallback已经是默认背景了
        };

        // 预加载图片
        img.src = apiUrl;
    };

    // --- 数据加载 ---
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
                    // 从 build.js 传递过来的原始路径优先级更高
                    if (!b.path) {
                        b.path = path.join(' / ');
                    }
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
        for(const node of nodes) {
            if(node.bookmarks && node.bookmarks.length > 0) return node;
            if(node.children) {
                const found = findFirstFolderWithBookmarks(node.children);
                if(found) return found;
            }
        }
        return null;
    };

    // --- 渲染逻辑 ---
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
            icon.src = bookmark.icon;
            icon.onerror = () => { icon.src = 'assets/placeholder_icon.svg'; };

            const name = document.createElement('span');
            name.textContent = bookmark.name;
            name.title = bookmark.name; // Add full name to title attribute for tooltip

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

    // --- 事件与逻辑 ---
    const setActiveEngine = (key, parentKey) => {
        // 移除所有高亮
        document.querySelectorAll('.engine-option, .dropdown-item').forEach(el => {
            el.classList.remove('active', 'parent-active');
        });

        if (parentKey) {
            // 选中了子菜单项
            const parentEl = engineSelector.querySelector(`.engine-option[data-engine-key="${parentKey}"]`);
            const subEl = engineSelector.querySelector(`.dropdown-item[data-engine-key="${key}"]`);
            
            if (parentEl) parentEl.classList.add('parent-active');
            if (subEl) subEl.classList.add('active');

            const parentEngine = searchEngines[parentKey];
            const subEngine = parentEngine.engines[key];
            currentEngine = key;
            currentSearchUrl = subEngine.url;
        } else {
            // 选中了主菜单项
            const engineEl = engineSelector.querySelector(`.engine-option[data-engine-key="${key}"]`);
            if (engineEl) engineEl.classList.add('active');
            
            const engine = searchEngines[key];
            currentEngine = key;
            currentSearchUrl = engine.url;
        }
        searchInput.focus();
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

// --- Offline Mode Logic ---
const placeholderSrc = 'assets/placeholder_icon.svg';

function updateOnlineStatus() {
  const toastNotification = document.getElementById('toast-notification');
  const isOnline = navigator.onLine;
  
  if (isOnline) {
    toastNotification.classList.remove('show');
    // 等待动画结束（0.5s）后，再添加 hidden 类，以便 display: none
    setTimeout(() => {
      if (navigator.onLine) { // 再次检查，确保在延迟期间状态没有再次变为离线
        toastNotification.classList.add('hidden');
      }
    }, 500);

    // 移除所有占位符的特殊样式
    document.querySelectorAll(`img.is-placeholder-offline`).forEach(img => {
      img.classList.remove('is-placeholder-offline');
    });
  } else {
    toastNotification.classList.remove('hidden'); // 移除 display: none
    // 使用一个微小的延迟来确保浏览器渲染了 display 的变化，从而使动画能够触发
    setTimeout(() => {
        toastNotification.classList.add('show');
    }, 10);

    // 为所有占位符图标添加特殊样式
    document.querySelectorAll(`img[src$="${placeholderSrc}"]`).forEach(img => {
      img.classList.add('is-placeholder-offline');
    });
  }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(registration => {
      console.log('Service Worker registered with scope:', registration.scope);
    }).catch(error => {
      console.error('Service Worker registration failed:', error);
    });
  }
});