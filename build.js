const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const mime = require('mime-types');
const crypto = require('crypto');

const SRC_DIR = path.join(__dirname, 'src');
const DIST_DIR = path.join(__dirname, 'dist');
const ICONS_DIR = path.join(DIST_DIR, 'icons');
const DEBUG_LOG_FILE = path.join(__dirname, 'debug.log');
const BOOKMARKS_FILE = path.join(__dirname, 'bookmarks.html');
const SRC_CONFIG_FILE = path.join(SRC_DIR, 'config.json');
const ASSETS_DIR = path.join(SRC_DIR, 'assets');
const DIST_ASSETS_DIR = path.join(DIST_DIR, 'assets');

let CONCURRENT_REQUESTS, MAX_ICON_SIZE_BYTES, ALLOWED_ICON_CONTENT_TYPES;
const iconCache = new Map();
const fetchingPromises = new Map();

async function logDebug(message) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    console.log(logMessage);
    await fs.appendFile(DEBUG_LOG_FILE, logMessage + '\n');
}

async function initialize() {
    await logDebug('Initializing build environment...');
    await fs.rm(DIST_DIR, { recursive: true, force: true });
    await fs.mkdir(DIST_DIR, { recursive: true });
    await fs.mkdir(ICONS_DIR, { recursive: true });
    await logDebug('Build environment cleaned.');
}

function parseBookmarksWithRegex(htmlContent) {
    const results = { name: 'root', bookmarks: [], children: [] };
    const stack = [{ node: results, path: '' }];
    const lines = htmlContent.split('\n');
    for (const line of lines) {
        const trimmedLine = line.trim();
        const folderMatch = trimmedLine.match(/<H3.*>(.*)<\/H3>/i);
        if (folderMatch) {
            const folderName = folderMatch[1].trim();
            const currentStackItem = stack[stack.length - 1];
            const newFolder = { name: folderName, bookmarks: [], children: [] };
            currentStackItem.node.children.push(newFolder);
            stack.push({ node: newFolder, path: currentStackItem.path ? `${currentStackItem.path} / ${folderName}` : folderName });
            continue;
        }
        const bookmarkMatch = trimmedLine.match(/<A HREF="([^"]*)"[^>]*>(.*)<\/A>/i);
        if (bookmarkMatch) {
            const currentStackItem = stack[stack.length - 1];
            currentStackItem.node.bookmarks.push({ name: bookmarkMatch[2], url: bookmarkMatch[1], icon: '', path: currentStackItem.path });
            continue;
        }
        if (trimmedLine.includes('</DL>') && stack.length > 1) {
            stack.pop();
        }
    }
    return results;
}

// ... [isPlaceholder, getFavicon, processItemsInParallel, collectAndProcessAll functions remain unchanged]
function isPlaceholder(buffer, sourceUrl, hostname, contentType) {
    if (buffer.length < 100) return true;
    if (sourceUrl.includes('favicon.im') && contentType && contentType.includes('image/svg+xml')) {
        const svgContent = buffer.toString('utf-8').toLowerCase();
        if (svgContent.includes('<text')) return true;
    }
    return false;
}

async function getFavicon(url) {
    const placeholder = 'assets/placeholder_icon.svg';
    if (!url || !url.startsWith('http')) return url || placeholder;

    let hostname;
    try {
        hostname = new URL(url).hostname;
    } catch (e) {
        await logDebug(`Invalid URL, skipping: ${url}`);
        return placeholder;
    }

    if (iconCache.has(hostname)) return iconCache.get(hostname);
    if (fetchingPromises.has(hostname)) return await fetchingPromises.get(hostname);

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
                        responseType: 'arraybuffer', timeout: 8000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
                    });

                    if (response.status === 200 && response.data.length > 0) {
                        const contentType = response.headers['content-type'];
                        if (response.data.length > MAX_ICON_SIZE_BYTES) {
                            await logDebug(`Skipping ${fallbackUrl} for ${hostname}: File size too large.`);
                            continue;
                        }
                        if (!contentType || !ALLOWED_ICON_CONTENT_TYPES.some(type => contentType.includes(type))) {
                            await logDebug(`Skipping ${fallbackUrl} for ${hostname}: Invalid content type: ${contentType}`);
                            continue;
                        }
                        if (isPlaceholder(response.data, fallbackUrl, hostname, contentType)) {
                            await logDebug(`Skipping ${fallbackUrl} for ${hostname}: Detected placeholder.`);
                            continue;
                        }

                        let extension = mime.extension(contentType) || 'png';
                        const hash = crypto.createHash('md5').update(response.data).digest('hex').substring(0, 8);
                        const iconFilename = `${hostname}.${hash}.${extension}`;
                        const relativeIconPath = `icons/${iconFilename}`;
                        
                        await fs.writeFile(path.join(ICONS_DIR, iconFilename), response.data);
                        await logDebug(`✅ Fetched and saved ${iconFilename} from ${fallbackUrl}`);
                        
                        iconCache.set(hostname, relativeIconPath);
                        return relativeIconPath;
                    }
                } catch (error) {
                    const errorMessage = error.response ? `status ${error.response.status}` : error.message;
                    await logDebug(`Failed to fetch from ${fallbackUrl} for ${hostname}. Error: ${errorMessage}`);
                }
            }
            await logDebug(`❌ All fallbacks failed for ${hostname}. Using placeholder.`);
            iconCache.set(hostname, placeholder);
            return placeholder;
        } catch (error) {
            await logDebug(`💥 Unexpected error in getFavicon for ${hostname}: ${error.stack}`);
            iconCache.set(hostname, placeholder);
            return placeholder;
        } finally {
            fetchingPromises.delete(hostname);
        }
    })();

    fetchingPromises.set(hostname, fetchPromise);
    return await fetchPromise;
}

async function processItemsInParallel(items, itemUrlField = 'url') {
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
    await Promise.allSettled(allFetchPromises);
    for (const item of items) {
        const url = item.icon || item[itemUrlField];
        if (url && url.startsWith('http')) {
            let hostname;
            try { hostname = new URL(url).hostname; } catch (e) { item.icon = 'assets/placeholder_icon.svg'; continue; }
            item.icon = iconCache.get(hostname) || 'assets/placeholder_icon.svg';
        } else {
            item.icon = url || 'assets/placeholder_icon.svg';
        }
    }
}

async function collectAndProcessAll(bookmarkNodes, engineConfig) {
    const allItems = [];
    function collectBookmarks(nodes) {
        for (const node of nodes) {
            if (node.bookmarks) allItems.push(...node.bookmarks);
            if (node.children) collectBookmarks(node.children);
        }
    }
    collectBookmarks(bookmarkNodes);
    function collectEngines(engines) {
        for (const key in engines) {
            const engine = engines[key];
            allItems.push(engine);
            if (engine.engines) collectEngines(engine.engines);
        }
    }
    collectEngines(engineConfig.searchEngines);
    await processItemsInParallel(allItems, 'url');
}

async function build() {
    try {
        await fs.writeFile(DEBUG_LOG_FILE, `[${new Date().toISOString()}] --- NEW BUILD LOG START ---\n`);
        const configContent = await fs.readFile(SRC_CONFIG_FILE, 'utf-8');
        const configData = JSON.parse(configContent);

        const settings = configData.buildSettings || {};
        CONCURRENT_REQUESTS = settings.concurrentRequests || 20;
        MAX_ICON_SIZE_BYTES = settings.maxIconSizeBytes || 1 * 1024 * 1024;
        ALLOWED_ICON_CONTENT_TYPES = settings.allowedIconContentTypes || ['image/x-icon', 'image/vnd.microsoft.icon', 'image/png', 'image/jpeg', 'image/svg+xml', 'image/gif', 'image/webp'];

        await initialize();

        await logDebug('Parsing bookmarks.html...');
        const htmlContent = await fs.readFile(BOOKMARKS_FILE, 'utf-8');
        const bookmarksData = parseBookmarksWithRegex(htmlContent);
        
        const args = process.argv.slice(2);
        const noIcons = args.includes('--no-icons');

        if (noIcons) {
            await logDebug('Skipping icon fetching as per --no-icons flag.');
        } else {
            await logDebug('Starting icon fetching process...');
            await collectAndProcessAll([bookmarksData], configData);
            await logDebug('Icon fetching process completed.');
        }

        const assetManifest = {};

        // Hash and write JSON files
        for (const { name, data } of [{ name: 'bookmarks.json', data: [bookmarksData] }, { name: 'config.json', data: configData }]) {
            const content = JSON.stringify(data, null, 2);
            const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
            const newFilename = `${path.parse(name).name}.${hash}.json`;
            await logDebug(`Hashing ${name} -> ${newFilename}`);
            await fs.writeFile(path.join(DIST_DIR, newFilename), content);
            assetManifest[name.replace('.json', '.a1b2c3d4.json')] = newFilename; // Map placeholder to hashed name
        }

        // Hash and write CSS and JS files, and update internal references
        for (const file of ['script.js', 'style.css']) {
            let content = await fs.readFile(path.join(SRC_DIR, file), 'utf-8');
            if (file === 'script.js') {
                content = content.replace(/bookmarks\.a1b2c3d4\.json/g, assetManifest['bookmarks.a1b2c3d4.json']);
                content = content.replace(/config\.a1b2c3d4\.json/g, assetManifest['config.a1b2c3d4.json']);
                await logDebug(`Updated internal references in ${file}`);
            }
            const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
            const newFilename = `${path.parse(file).name}.${hash}${path.extname(file)}`;
            await logDebug(`Hashing ${file} -> ${newFilename}`);
            await fs.writeFile(path.join(DIST_DIR, newFilename), content);
            assetManifest[file] = newFilename;
        }

        // Update HTML references
        await logDebug('Updating references in index.html...');
        let indexContent = await fs.readFile(path.join(SRC_DIR, 'index.html'), 'utf-8');
        indexContent = indexContent.replace('"style.css"', `"${assetManifest['style.css']}"`).replace('"script.js"', `"${assetManifest['script.js']}"`);
        await fs.writeFile(path.join(DIST_DIR, 'index.html'), indexContent);
        await logDebug('index.html updated.');

        // Copy static assets
        await fs.mkdir(DIST_ASSETS_DIR, { recursive: true });
        for (const asset of await fs.readdir(ASSETS_DIR)) {
            await fs.copyFile(path.join(ASSETS_DIR, asset), path.join(DIST_ASSETS_DIR, asset));
        }
        await fs.copyFile(path.join(__dirname, 'favicon.ico'), path.join(DIST_DIR, 'favicon.ico'));

        // Generate Service Worker
        await logDebug('Generating Service Worker...');
        let swContent = await fs.readFile(path.join(SRC_DIR, 'sw.js'), 'utf-8');
        const coreAssets = ['index.html', ...Object.values(assetManifest), 'favicon.ico', 'assets/background.webp', 'assets/MapleMono-Medium.woff2', 'assets/placeholder_icon.svg'];
        const iconAssets = noIcons ? [] : (await fs.readdir(ICONS_DIR)).map(file => `icons/${file}`);
        swContent = swContent.replace(`'bookmarks-cache-v1'`, `'bookmarks-cache-v${Date.now()}'`)
                             .replace(`self.__CORE_ASSETS__ || []`, JSON.stringify(coreAssets.filter(Boolean), null, 2))
                             .replace(`self.__ICON_ASSETS__ || []`, JSON.stringify(iconAssets, null, 2));
        await fs.writeFile(path.join(DIST_DIR, 'sw.js'), swContent);
        await logDebug('Service Worker generated.');

        await logDebug('🎉 Build process completed successfully!');
    } catch (error) {
        await logDebug(`💥 An error occurred during the build process: ${error.stack}`);
        process.exit(1);
    }
}

build();