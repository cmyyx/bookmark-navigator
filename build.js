const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');

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

const processedHostnames = new Set();
const processingHostnames = new Set(); // 新增，用于处理并发请求

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
    // 规则1: Yandex 返回的1x1像素图片文件大小极小
    if (sourceUrl.includes('yandex.net') && buffer.length < 100) {
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

    const rootHostname = hostname.startsWith('www.') ? hostname.substring(4) : hostname;

    // --- 并发锁定和等待 ---
    while (processingHostnames.has(rootHostname)) {
        await logDebug(`... Waiting for another process for ${rootHostname}`);
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    // --- 文件存在性检查 (主要) ---
    try {
        const files = await fs.readdir(ICONS_DIR);
        const existingIcon = files.find(file => file.startsWith(`${rootHostname}.`));
        if (existingIcon) {
            // 如果文件已存在，我们就不需要再次获取。
            // 只有在第一次遇到这个已存在的文件时才打印日志。
            if (!processedHostnames.has(rootHostname)) {
                await logDebug(`Icon for ${rootHostname} already exists as ${existingIcon}. Skipping.`);
                processedHostnames.add(rootHostname);
            }
            return `icons/${existingIcon}`;
        }
    } catch (e) {
        // 忽略目录不存在的错误
    }

    // 锁定主机，开始获取
    processingHostnames.add(rootHostname);

    try {
        const fallbackUrls = [
            `https://${hostname}/favicon.ico`,
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
                    
                    const iconFilename = `${rootHostname}.${extension}`;
                    const iconPath = path.join(ICONS_DIR, iconFilename);
                    
                    await fs.writeFile(iconPath, response.data);
                    await logDebug(`✅ Fetched and saved ${iconFilename} from ${fallbackUrl}`);
                    return `icons/${iconFilename}`;
                }
            } catch (error) {
                let errorMessage = error.message;
                if (error.response) errorMessage += ` (status: ${error.response.status})`;
                await logDebug(`Failed to fetch from ${fallbackUrl} for ${hostname}. Error: ${errorMessage}`);
            }
        }

        await logDebug(`❌ All fallbacks failed for ${hostname}. Using placeholder.`);
        return placeholder;
    } finally {
        processedHostnames.add(rootHostname);
        processingHostnames.delete(rootHostname);
    }
}

async function processItemsInParallel(items, itemUrlField = 'url') {
    const concurrentRequests = CONCURRENT_REQUESTS || 10; // Fallback
    const batches = [];
    for (let i = 0; i < items.length; i += concurrentRequests) {
        batches.push(items.slice(i, i + concurrentRequests));
    }

    for (const batch of batches) {
        await Promise.all(batch.map(async (item) => {
            item.icon = await getFavicon(item.icon || item[itemUrlField]);
        }));
    }
}

async function collectAndProcessAll(bookmarkNodes, engineConfig) {
    let allBookmarks = [];
    function collectBookmarks(nodes) {
        for (const node of nodes) {
            if (node.bookmarks) allBookmarks.push(...node.bookmarks);
            if (node.children) collectBookmarks(node.children);
        }
    }
    collectBookmarks(bookmarkNodes);
    await logDebug(`Found ${allBookmarks.length} bookmarks to process.`);
    await processItemsInParallel(allBookmarks, 'url');

    let allEngines = [];
    function collectEngines(engines) {
        for (const key in engines) {
            const engine = engines[key];
            allEngines.push(engine);
            if (engine.engines) {
                collectEngines(engine.engines);
            }
        }
    }
    collectEngines(engineConfig.searchEngines);
    await logDebug(`Found ${allEngines.length} search engines to process.`);
    await processItemsInParallel(allEngines, 'url');
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

        await logDebug('🎉 Build process completed successfully!');
    } catch (error) {
        await logDebug(`💥 An error occurred during the build process: ${error.message}`);
        process.exit(1);
    }
}

build();