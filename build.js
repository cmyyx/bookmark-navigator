const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');
const crypto = require('crypto');

// --- 配置 ---
const SRC_DIR = path.join(__dirname, 'src');
const DIST_DIR = path.join(__dirname, 'dist');
const ICONS_DIR = path.join(DIST_DIR, 'icons');
const DEBUG_LOG_FILE = path.join(__dirname, 'debug.log');
const BOOKMARKS_FILE = path.join(__dirname, 'bookmarks.html');
const SRC_CONFIG_FILE = path.join(SRC_DIR, 'config.json');
const DIST_CONFIG_FILE = path.join(DIST_DIR, 'config.json');
const ASSETS_DIR = path.join(SRC_DIR, 'assets');
const DIST_ASSETS_DIR = path.join(DIST_DIR, 'assets');
// 将在 build 函数中从 config.json 加载这些设置
let CONCURRENT_REQUESTS;
let MAX_ICON_SIZE_BYTES;
let ALLOWED_ICON_CONTENT_TYPES;

const iconCache = new Map(); // 缓存最终的图标路径
const fetchingPromises = new Map(); // 缓存正在进行中的 fetch Promise

// --- 核心函数 ---

async function logDebug(message) {
    const timestamp = new Date().toISOString();
    // Log to console for real-time feedback
    if (typeof message === 'object') {
        console.log(JSON.stringify(message, null, 2));
        await fs.appendFile(DEBUG_LOG_FILE, `[${timestamp}] ${JSON.stringify(message, null, 2)}\n`);
    } else {
        console.log(message);
        await fs.appendFile(DEBUG_LOG_FILE, `[${timestamp}] ${message}\n`);
    }
}

async function initialize() {
    await logDebug('Initializing build environment...');
    await fs.rm(DIST_DIR, { recursive: true, force: true });
    await fs.mkdir(DIST_DIR, { recursive: true });
    await fs.mkdir(ICONS_DIR, { recursive: true });
    await fs.mkdir(DIST_ASSETS_DIR, { recursive: true });
    await logDebug('Build environment cleaned.');
}

async function copyStaticAssets() {
    await logDebug('Copying static assets...');
    try {
        const assets = await fs.readdir(ASSETS_DIR);
        for (const asset of assets) {
            await fs.copyFile(path.join(ASSETS_DIR, asset), path.join(DIST_ASSETS_DIR, asset));
        }
        await fs.copyFile(path.join(SRC_DIR, 'index.html'), path.join(DIST_DIR, 'index.html'));
        await fs.copyFile(path.join(SRC_DIR, 'style.css'), path.join(DIST_DIR, 'style.css'));
        await fs.copyFile(path.join(SRC_DIR, 'script.js'), path.join(DIST_DIR, 'script.js'));
        await fs.copyFile(path.join(__dirname, 'favicon.ico'), path.join(DIST_DIR, 'favicon.ico'));
        await logDebug('Static assets copied.');
    } catch (error) {
        await logDebug(`Error copying static assets: ${error.message}`);
    }
}


function parseBookmarksWithRegex(htmlContent) {
    const results = { name: 'root', bookmarks: [], children: [] };
    // The stack now holds objects with the node and its path
    const stack = [{ node: results, path: '' }];

    const lines = htmlContent.split('\n');

    for (const line of lines) {
        const trimmedLine = line.trim();

        // Check for folder start
        const folderMatch = trimmedLine.match(/<H3.*>(.*)<\/H3>/i);
        if (folderMatch) {
            const folderName = folderMatch[1].trim();
            const currentStackItem = stack[stack.length - 1];
            const parentPath = currentStackItem.path;

            const newPath = parentPath ? `${parentPath} / ${folderName}` : folderName;
            const newFolder = { name: folderName, bookmarks: [], children: [] };
            
            currentStackItem.node.children.push(newFolder);
            stack.push({ node: newFolder, path: newPath });
            continue;
        }

        // Check for bookmark
        const bookmarkMatch = trimmedLine.match(/<A HREF="([^"]*)"[^>]*>(.*)<\/A>/i);
        if (bookmarkMatch) {
            const url = bookmarkMatch[1];
            const name = bookmarkMatch[2];
            const currentStackItem = stack[stack.length - 1];
            
            currentStackItem.node.bookmarks.push({ name, url, icon: '', path: currentStackItem.path });
            continue;
        }

        // Check for folder end
        if (trimmedLine.includes('</DL>')) {
            if (stack.length > 1) {
                stack.pop();
            }
        }
    }

    return results;
}

function isPlaceholder(buffer, sourceUrl, hostname, contentType) {
    // 规则1: 任何小于100字节的文件都极有可能是无效的占位符。
    if (buffer.length < 100) {
        return true;
    }
    // 规则2: favicon.im 返回的SVG占位符通常包含 <text> 元素，而真实图标使用 <path>。
    if (sourceUrl.includes('favicon.im') && contentType && contentType.includes('image/svg+xml')) {
        const svgContent = buffer.toString('utf-8').toLowerCase();
        if (svgContent.includes('<text')) {
            return true;
        }
    }
    return false;
}

async function getFavicon(url) {
    const placeholder = 'assets/placeholder_icon.svg';
    if (!url || !url.startsWith('http')) {
        return url || placeholder;
    }

    let hostname;
    try {
        hostname = new URL(url).hostname;
    } catch (e) {
        await logDebug(`Invalid URL: ${url}`);
        return placeholder;
    }

    // 1. 检查最终结果缓存
    if (iconCache.has(hostname)) {
        return iconCache.get(hostname);
    }

    // 2. 检查是否有正在进行的Promise
    if (fetchingPromises.has(hostname)) {
        return await fetchingPromises.get(hostname);
    }

    // 3. 如果都没有，则创建新的Promise来处理抓取
    const fetchPromise = (async () => {
        try {
            const fallbackUrls = [
                `https://${hostname}/favicon.ico`, // 优先使用原始hostname
                `https://www.google.com/s2/favicons?sz=64&domain_url=${hostname}`,
                `https://icons.duckduckgo.com/ip3/${hostname}.ico`,
                `https://favicon.im/${hostname}`,
                `https://favicon.yandex.net/favicon/${hostname}`,
                `https://logo.clearbit.com/${hostname}`,
            ];

            for (const fallbackUrl of fallbackUrls) {
                try {
                    const response = await axios.get(fallbackUrl, {
                        responseType: 'arraybuffer',
                        timeout: 8000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                    });

                    if (response.status === 200 && response.data.length > 0) {
                        const contentType = response.headers['content-type'];
                        const contentLength = response.headers['content-length'];

                        if (response.data.length > MAX_ICON_SIZE_BYTES) {
                            await logDebug(`Skipping ${fallbackUrl} for ${hostname}: File size (${response.data.length} bytes) exceeds limit.`);
                            continue;
                        }
                        if (contentLength && parseInt(contentLength, 10) > MAX_ICON_SIZE_BYTES) {
                            await logDebug(`Skipping ${fallbackUrl} for ${hostname}: Header size (${contentLength}) exceeds limit.`);
                            continue;
                        }
                        if (!contentType || !ALLOWED_ICON_CONTENT_TYPES.some(type => contentType.includes(type))) {
                            await logDebug(`Skipping ${fallbackUrl} for ${hostname}: Invalid content type: ${contentType}`);
                            continue;
                        }
                        if (isPlaceholder(response.data, fallbackUrl, hostname, contentType)) {
                            await logDebug(`Skipping ${fallbackUrl} for ${hostname}: Detected placeholder image.`);
                            continue;
                        }

                        let extension = mime.extension(contentType);
                        if (!extension || extension === 'bin') {
                            const urlPath = new URL(fallbackUrl).pathname;
                            const urlExt = path.extname(urlPath).substring(1);
                            extension = urlExt || 'png';
                        }
                        
                        const hash = crypto.createHash('md5').update(response.data).digest('hex').substring(0, 8);
                        const iconFilename = `${hostname}.${hash}.${extension}`;
                        const iconPath = path.join(ICONS_DIR, iconFilename);
                        const relativeIconPath = `icons/${iconFilename}`;

                        await fs.writeFile(iconPath, response.data);
                        await logDebug(`✅ Fetched and saved ${iconFilename} from ${fallbackUrl}`);
                        
                        iconCache.set(hostname, relativeIconPath); // 缓存最终结果
                        return relativeIconPath;
                    }
                } catch (error) {
                    let errorMessage = error.message;
                    if (error.response) errorMessage += ` (status: ${error.response.status})`;
                    await logDebug(`Failed to fetch from ${fallbackUrl} for ${hostname}. Error: ${errorMessage}`);
                }
            }

            await logDebug(`❌ All fallbacks failed for ${hostname}. Using placeholder.`);
            iconCache.set(hostname, placeholder); // 缓存失败结果
            return placeholder;
        } catch (error) {
            await logDebug(`💥 Unexpected error during favicon fetch for ${hostname}: ${error.message}`);
            iconCache.set(hostname, placeholder); // 缓存异常结果
            return placeholder;
        } finally {
            // 无论成功、失败还是异常，都要从正在进行的Promise map中移除
            fetchingPromises.delete(hostname);
        }
    })();

    // 将Promise存入map，然后返回它
    fetchingPromises.set(hostname, fetchPromise);
    return await fetchPromise;
}

async function processItemsInParallel(items, itemUrlField = 'url') {
    // 这是一个更高阶的重构，将抓取和绑定分离

    // --- 阶段 1: 收集所有不重复的URL并触发抓取 ---
    const allFetchPromises = [];
    const uniqueUrls = new Set();
    
    for (const item of items) {
        const url = item.icon || item[itemUrlField];
        if (url && url.startsWith('http') && !uniqueUrls.has(url)) {
            uniqueUrls.add(url);
            allFetchPromises.push(getFavicon(url));
        }
    }
    
    await logDebug(`Found ${uniqueUrls.size} unique URLs to fetch icons for.`);

    // --- 阶段 2: 等待所有抓取任务完成 ---
    // Promise.allSettled 确保即使有任务失败，也会等待所有任务结束
    await Promise.allSettled(allFetchPromises);
    await logDebug('All icon fetching tasks have been settled.');

    // --- 阶段 3: 同步绑定所有图标 ---
    // 此时 iconCache 已经完全填充完毕
    for (const item of items) {
        const url = item.icon || item[itemUrlField];
        if (url && url.startsWith('http')) {
            let hostname;
            try {
                hostname = new URL(url).hostname;
            } catch (e) {
                item.icon = 'assets/placeholder_icon.svg';
                continue;
            }
            if (iconCache.has(hostname)) {
                item.icon = iconCache.get(hostname);
            } else {
                // 理论上不应该发生，但作为保险
                item.icon = 'assets/placeholder_icon.svg';
            }
        } else {
            item.icon = url || 'assets/placeholder_icon.svg';
        }
    }
    await logDebug('All icons have been assigned to their items.');
}

async function collectAndProcessAll(bookmarkNodes, engineConfig) {
    const allItems = [];

    // 收集所有书签
    function collectBookmarks(nodes) {
        for (const node of nodes) {
            if (node.bookmarks) allItems.push(...node.bookmarks);
            if (node.children) collectBookmarks(node.children);
        }
    }
    collectBookmarks(bookmarkNodes);
    await logDebug(`Found ${allItems.length} bookmarks.`);

    // 收集所有搜索引擎
    const initialEngineCount = allItems.length;
    function collectEngines(engines) {
        for (const key in engines) {
            const engine = engines[key];
            allItems.push(engine);
            if (engine.engines) {
                collectEngines(engine.engines);
            }
        }
    }
    collectEngines(engineConfig.searchEngines);
    await logDebug(`Found ${allItems.length - initialEngineCount} search engines.`);

    // 一次性并行处理所有项目
    await logDebug(`Processing a total of ${allItems.length} items for favicons...`);
    await processItemsInParallel(allItems, 'url');
}

// --- 主构建流程 ---
async function build() {
    try {
        await fs.writeFile(DEBUG_LOG_FILE, `[${new Date().toISOString()}] --- NEW BUILD LOG START ---\n`);
        
        await logDebug('Reading search engine config...');
        const configContent = await fs.readFile(SRC_CONFIG_FILE, 'utf-8');
        const configData = JSON.parse(configContent);

        // --- 加载构建配置 ---
        const settings = configData.buildSettings || {};
        CONCURRENT_REQUESTS = settings.concurrentRequests || 20;
        MAX_ICON_SIZE_BYTES = settings.maxIconSizeBytes || 1 * 1024 * 1024; // 1MB 默认
        ALLOWED_ICON_CONTENT_TYPES = settings.allowedIconContentTypes || [
            'image/x-icon', 'image/vnd.microsoft.icon', 'image/png',
            'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp'
        ];
        await logDebug(`Build settings loaded: Concurrent Requests=${CONCURRENT_REQUESTS}, Max Icon Size=${MAX_ICON_SIZE_BYTES} bytes`);
        // --- 配置加载完毕 ---

        await initialize();
        await copyStaticAssets();

        await logDebug('Reading and parsing bookmarks.html...');
        const htmlContent = await fs.readFile(BOOKMARKS_FILE, 'utf-8');
        const bookmarksData = parseBookmarksWithRegex(htmlContent);

        await collectAndProcessAll([bookmarksData], configData);

        await logDebug('Saving final bookmarks.json and config.json...');
        await fs.writeFile(path.join(DIST_DIR, 'bookmarks.json'), JSON.stringify([bookmarksData], null, 2));
        await fs.writeFile(DIST_CONFIG_FILE, JSON.stringify(configData, null, 2));

        // --- 生成并注入 Service Worker 文件列表 ---
        await logDebug('Generating Service Worker file list...');
        const baseFiles = ['/', 'index.html', 'style.css', 'script.js', 'bookmarks.json', 'favicon.ico', 'assets/background.webp', 'assets/MapleMono-Medium.woff2', 'assets/placeholder_icon.svg'];
        const iconFiles = (await fs.readdir(ICONS_DIR)).map(file => `icons/${file}`);
        const allFilesToCache = [...baseFiles, ...iconFiles];

        let swContent = await fs.readFile(path.join(SRC_DIR, 'sw.js'), 'utf-8');
        const cacheVersion = `bookmarks-cache-v${Date.now()}`;

        swContent = swContent
            .replace(`'bookmarks-cache-v1'`, `'${cacheVersion}'`)
            .replace(`self.__FILES_TO_CACHE__ || []`, JSON.stringify(allFilesToCache, null, 2));

        await fs.writeFile(path.join(DIST_DIR, 'sw.js'), swContent);
        await logDebug('Service Worker configured with all files.');
        // --- Service Worker 生成完毕 ---

        await logDebug('🎉 Build process completed successfully!');
    } catch (error) {
        await logDebug(`💥 An error occurred during the build process: ${error.message}`);
        process.exit(1);
    }
}

build();