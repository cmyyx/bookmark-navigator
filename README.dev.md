# 开发者指南 (Developer Guide)

本文档为开发者和维护者提供一份关于本项目工作流程、架构和设计理念的综合性技术指南。

## 🎯 核心设计理念：源文件驱动

本项目的核心是一个 **“源文件驱动” (Source-Driven)** 的静态网站生成器。这一理念意味着整个应用的“状态”——包括所有的书签数据和配置——都由版本控制系统中的源文件明确定义，而非数据库或动态后端。

-   **状态源 (Source of Truth):**
    -   `bookmarks.html`: 标准的浏览器书签导出文件，作为核心数据源。
    -   `src/config.json`: 定义了所有可配置的行为，包括搜索引擎、UI 特性和构建参数。

-   **构建引擎 (Build Engine):**
    -   `build.js`: 这是一个独立的 Node.js 脚本，其唯一职责是将上述的“状态源”编译成一套可部署的、高效的静态网站产物，存放于 `dist/` 目录。

这种模式确保了项目的可复现性、透明度和简洁性。开发者只需关心数据和配置，而构建过程是确定性的、自动化的。

---

## ⚙️ 核心配置 (`src/config.json`)

这是控制项目行为的中央枢纽，所有可调整的参数都集中于此，以实现逻辑与配置的分离。

### `buildSettings`
此对象包含用于微调 `build.js` 脚本行为的高级参数。

-   `concurrentRequests` (number): 定义在图标抓取阶段可以同时发起的最大网络请求数。默认值 `50` 是一个在性能和服务器友好性之间的平衡。
-   `maxIconSizeBytes` (number): 单个图标文件的最大允许大小（字节）。用于防止下载过大的文件，默认 `5MB`。
-   `allowedIconContentTypes` (string[]): 一个MIME类型字符串数组，定义了哪些类型的图片可以被接受为图标。

### `searchEngines`
一个嵌套对象，用于定义搜索栏中的所有搜索引擎。

-   **结构**: 每个键代表一个引擎ID（如 "google"）。其值是一个对象，包含：
    -   `name` (string): 显示在前端的名称。
    -   `url` (string): 搜索的URL模板，其中 `{query}` 会被替换为用户的输入。对于书签搜索，此值为 `null`。
    -   `icon` (string): 图标的URL或Base64编码的SVG。如果为空，`build.js` 会自动抓取。
    -   `engines` (object, optional): 一个可选的嵌套对象，用于创建子搜索引擎菜单（例如，Bilibili下的不同搜索类型）。结构与父级相同。

---

## 📜 构建流程详解 (`build.js`)

`npm run build` 命令会执行此脚本。它不仅仅是一个简单的文件复制工具，而是一个经过精心设计的编译引擎，解决了静态网站生成过程中的几个关键挑战。

1.  **初始化 (`initialize`)**: 清理环境。删除并重建 `dist` 目录，确保每次构建都是一次全新的生成。

2.  **解析书签 (`parseBookmarksWithRegex`)**:
    -   读取 `bookmarks.html` 文件。
    -   **设计决策**: 使用基于正则表达式的行扫描方式解析HTML。这种方法对不规范的HTML格式有极高的容错性，远比依赖严格DOM结构的解析器更健壮。
    -   构建一个包含文件夹、书签和层级结构的JavaScript树状对象。

3.  **图标抓取与缓存 (`getFavicon` & `processItemsInParallel`)**:
    这是构建流程中最复杂、最核心的部分。为每个书签获取高质量的图标是主要挑战，因为网站图标的提供方式极度不可靠。

    -   **设计决策：健壮的多级回退策略**:
        直接访问网站的 `favicon.ico` 常常失败。为了解决这个问题，我们实现了一个包含多级回退的健壮策略。如果直接获取失败，构建脚本会自动向多个第三方图标服务（如 Google、DuckDuckGo）请求图标，直到找到一个有效的为止。

    -   **设计决策：内容哈希命名以实现高效缓存**:
        成功获取的图标会根据其文件内容的 MD5 哈希值进行重命名（例如 `example.com.a1b2c3d4.png`）。这种设计至关重要，因为它实现了最理想的缓存策略：
        -   **持久缓存:** 只要图标内容不变，其文件名就不会变，浏览器可以永久缓存它。
        -   **自动更新:** 当网站更新其图标时，文件内容会改变，哈希值随之改变，生成一个新的文件名。这会自动触发浏览器下载新图标，从而避免了复杂的缓存失效问题。

    -   **实现细节**:
        -   `iconCache` 和 `fetchingPromises` (Map): 通过两级内存缓存，前者存储已完成的结果，后者防止对同一域名发起重复的并发请求，极大地提升了构建效率。
        -   **严格验证**: 对下载的图标进行大小、MIME类型和内容（检测是否为通用占位符）的多重验证，确保图标质量。

4.  **Service Worker 动态生成**:
    ~~为了实现完全的离线访问能力~~现在并不行，Service Worker 必须预缓存所有必要的应用资源。

    -   **设计决策：动态文件清单生成**:
        由于图标文件名是根据其内容动态生成的，因此无法在源代码中硬编码一个静态的缓存列表。构建脚本在完成所有处理后，会扫描整个 `dist/` 目录，动态生成一份包含所有最终资源（HTML, CSS, JS, 以及所有哈希命名的图标）的完整文件清单。这份清单随后被注入到 `sw.js` 模板中，确保 Service Worker 能够准确地缓存每一个必要的文件，从而为用户提供无缝的离线体验。

---

## 🚀 前端架构 (`src/script.js`)

项目的前端被设计为一个纯粹的 **“渲染层”**。

-   **设计决策：逻辑与数据的分离**:
    前端的唯一职责是获取由构建脚本在 `dist/` 目录中生成的静态 JSON 文件 (`bookmarks.json`, `config.json`)，然后将这些数据动态地渲染成用户可见的 DOM 元素。它不包含任何业务逻辑或状态管理，所有状态都源于构建产物。这种清晰的分离使得前端代码极易维护和调试。

-   **核心功能**:
    -   **初始化 (`init`)**: 使用 `Promise.all` 并发加载数据和配置JSON，然后触发渲染和事件绑定。
    -   **动态渲染**: `renderFolderTree`, `renderBookmarks`, `renderSearchEngines` 等函数负责将JSON数据转化为DOM结构。
    -   **交互逻辑**: 处理搜索引擎切换、实时书签搜索等用户输入。
    ~~-   **离线感知**: 监听 `online`/`offline` 事件，并更新UI以向用户明确传达当前的网络状态。~~

---

## 🔧 开发与调试 (Development & Debugging)

遵循以下步骤进行本地开发和调试。

### 本地开发流程

1.  **安装依赖:**
    ```bash
    npm install
    ```

2.  **修改代码:**
    在 `src/` 目录中对 HTML, CSS, 或 JavaScript 进行修改。若要更改数据或配置，请直接编辑 `bookmarks.html` 或 `src/config.json`。

3.  **运行构建:**
    ```bash
    npm run build
    ```
    此命令会执行 `build.js`，将你的修改和数据源编译到 `dist/` 目录。

4.  **本地预览:**
    使用任何静态文件服务器在本地预览构建产物。推荐使用 `serve`：
    ```bash
    npx serve dist
    ```
    现在，你可以在浏览器中打开提供的地址（通常是 `http://localhost:3000`）来查看最终结果。

### 调试技巧

-   **验证构建数据:** 在调试时，首先检查 `dist/` 目录中的生成文件。
    -   `dist/bookmarks.json`: 检查此文件可以确认 `bookmarks.html` 是否被正确解析，以及图标路径是否已成功填充。
    -   `dist/config.json`: 验证配置是否按预期合并和输出。

-   **验证 Service Worker 缓存:**
    -   打开 `dist/sw.js`，检查 `PRECACHE_ASSETS` 数组。确认所有必要的应用外壳文件和动态生成的图标都已包含在内。~~这是确保离线功能正常工作的关键。~~