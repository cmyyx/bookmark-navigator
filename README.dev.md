# 开发者文档 (README.dev.md)

本文档旨在为开发者和维护本项目的AI提供深入的技术指导。它详细解释了项目的架构、核心脚本 `build.js` 的工作流程、设计决策以及维护时需要遵守的规则。

## 🎯 项目目标

本项目的核心目标是创建一个“Git-driven”的个人导航网站。用户只需维护一个标准的浏览器书签导出文件 (`bookmarks.html`)，通过运行 `npm run build` 命令，即可全自动生成一个功能完整的、包含所有网站图标的静态导航页。

## 🛠️ 技术栈

- **运行时**: [Node.js](https://nodejs.org/)
- **核心依赖**:
  - `axios`: 用于发起 HTTP 请求，获取网站图标。
  - `mime-types`: 用于根据服务器返回的 `Content-Type` 头部信息推断正确的文件扩展名。
- **开发依赖**: 无。本项目力求轻量化，不依赖构建工具或框架。

## 📁 架构与文件职责

```
.
├── dist/                # [构建产物] 最终生成的静态网站。此目录在每次构建时会被完全清空。
│   ├── icons/           # [构建产物] 所有成功下载的网站图标。
│   ├── assets/          # [构建产物] 从 src/assets/ 复制的静态资源。
│   ├── bookmarks.json   # [构建产物] 从 bookmarks.html 解析并处理后的数据，供前端使用。
│   ├── config.json      # [构建产物] 从 src/config.json 复制的配置文件，供前端使用。
│   ├── index.html       # [构建产物] 最终的 HTML 页面。
│   └── ...
├── src/                 # [源码] 网站的前端模板和配置。
│   ├── config.json      # [核心配置] 定义搜索引擎和高级构建设置。
│   ├── index.html       # [前端模板] 主页的 HTML 结构。
│   ├── style.css        # [前端模板] 主页的 CSS 样式。
│   └── script.js        # [前端模板] 主页的客户端 JavaScript 逻辑，负责渲染数据。
├── bookmarks.html       # [数据源] 用户提供的书签文件，是所有数据的唯一来源。
├── build.js             # [核心脚本] 整个项目的构建引擎。
├── package.json         # [项目配置] Node.js 项目定义和依赖管理。
├── debug.log            # [调试日志] 记录详细的构建过程，用于问题排查。
└── README.md            # [文档] 面向普通用户的说明。
└── README.dev.md        # [文档] 本开发者文档。
```

## 📜 `build.js` 核心脚本详解

`build.js` 是本项目的发动机。其执行流程如下：

1.  **初始化 (`initialize`)**:
    - 清理旧的构建产物：删除 `dist` 目录。
    - 创建新的目录结构：重新创建 `dist`, `dist/icons`, `dist/assets`。

2.  **加载配置**:
    - 读取 `src/config.json`。
    - 将 `buildSettings` 中的高级设置（如并发数、图标大小限制）加载到全局变量中。

3.  **复制静态资源 (`copyStaticAssets`)**:
    - 将 `src` 目录下的 `index.html`, `style.css`, `script.js` 等前端文件复制到 `dist`。
    - 将 `src/assets` 目录下的所有资源复制到 `dist/assets`。

4.  **解析书签 (`parseBookmarksWithRegex`)**:
    - 读取 `bookmarks.html` 的内容。
    - **关键**: 使用正则表达式逐行解析 HTML。此方法取代了最初使用的 `cheerio`，因为它对不规范的 HTML 格式具有更强的容错性。
    - 将解析结果构建成一个嵌套的、包含文件夹和书签的树状 JavaScript 对象。

5.  **收集和处理所有链接 (`collectAndProcessAll`)**:
    - 遍历解析出的书签树和 `config.json` 中的搜索引擎，将所有需要处理的链接（书签和搜索引擎）收集到一个列表中。
    - 调用 `processItemsInParallel` 并行处理这些链接。

6.  **并行处理 (`processItemsInParallel`)**:
    - 将链接列表分割成多个批次（批次大小由 `CONCURRENT_REQUESTS` 控制）。
    - 使用 `Promise.all` 对每个批次中的链接并发执行 `getFavicon` 函数，以获取图标。

7.  **获取图标 (`getFavicon`)**:
    - 这是整个脚本中最复杂、最核心的函数。
    - **并发处理**:
        - 使用 `processingHostnames` 集合作为锁，防止对同一域名的并发请求。如果一个域名正在被处理，其他请求会等待。
        - 使用 `processedHostnames` 集合记录已处理过的域名（无论成功或失败），避免在同一次构建中重复工作。
    - **图标查找与备用链**:
        - 首先检查 `dist/icons` 目录中是否已存在该域名的图标。如果存在，则直接返回路径，跳过所有网络请求。
        - 如果不存在，则按顺序尝试一个备用 URL 列表 (`fallbackUrls`) 来获取图标。这个列表包括：
            1.  网站根目录的 `favicon.ico`
            2.  Google 的图标 API
            3.  DuckDuckGo 的图标 API
            4.  Clearbit 的 Logo API
            5.  favicon.im 的 API
            6.  Yandex 的图标 API
    - **安全与占位符验证**:
        - **大小验证**: 检查响应头 `Content-Length` 和实际数据大小，拒绝超过 `MAX_ICON_SIZE_BYTES` 的文件。
        - **类型验证**: 检查响应头 `Content-Type` 是否在 `ALLOWED_ICON_CONTENT_TYPES` 允许的列表中。
        - **占位符验证 (`isPlaceholder`)**:
            - **Yandex**: 拒绝尺寸过小（< 100字节）的图片。
            - **favicon.im**: 拒绝内容包含 `<text>` 标签的 SVG 文件，因为这通常是其自动生成的占位符。
    - **文件保存**:
        - 如果图标通过所有验证，则使用 `mime-types` 根据 `Content-Type` 推断文件扩展名。
        - 将图标文件保存在 `dist/icons` 目录中，文件名为 `[hostname].[extension]`。
    - **失败处理**: 如果所有备用源都失败，则返回一个默认的本地占位符图标路径。

8.  **保存最终数据**:
    - 将处理完成（即包含图标路径）的书签树和配置数据写入 `dist/bookmarks.json` 和 `dist/config.json`。前端页面将加载这些 JSON 文件来动态渲染内容。

## ⚖️ 开发与维护规则

为了确保项目的稳定性和可维护性，请务必遵守以下规则：

1.  **数据源唯一性**: `bookmarks.html` 是唯一的数据来源。不要在 `build.js` 中硬编码任何书签信息。
2.  **配置分离**: 所有可配置项（如 API URL、并发数、MIME类型等）都应放在 `src/config.json` 中，而不是硬编码在脚本里。
3.  **无状态构建**: `build.js` 必须是无状态的。它不应该依赖于前一次运行的结果（除了 `dist/icons` 目录下的缓存）。每次运行都应该能从头开始生成一个完整的、正确的网站。
4.  **错误处理**: 所有可能失败的操作（特别是网络请求和文件系统操作）都必须包含在 `try...catch` 块中，并使用 `logDebug` 记录详细的错误信息。
5.  **日志先行**: 在进行任何重要操作或遇到错误时，都应先调用 `logDebug` 记录日志。这对于调试至关重要。
6.  **修改 `getFavicon` 的注意事项**:
    - 任何对备用源顺序或验证逻辑的修改，都必须考虑到可能对性能和成功率产生的影响。
    - 添加新的占位符检测规则时，要确保规则足够精确，以避免误判。
7.  **依赖最小化**: 除非有绝对必要，否则不要添加新的 npm 依赖。本项目的优势之一就是其轻量和简洁。