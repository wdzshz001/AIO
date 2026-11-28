# 聚合阅读 · 交接说明

> 给下一个对话的上下文。最后更新：2026-11-22 晚（双端打包 + 起点自动换源 + 动画自动选源）。
>
> 双端编译：[docs/BUILD.md](docs/BUILD.md)；双端差异/影响范围：[docs/PLATFORM.md](docs/PLATFORM.md)；
> Git CI 与热更新：[docs/HOT-UPDATE.md](docs/HOT-UPDATE.md)。

## 一、项目是什么

一个 Windows / 安卓的「启动器 + 聚合阅读」应用：把多个网页站点收进统一界面，
提供一致的列表、详情、阅读/播放体验。

技术栈：Electron（桌面壳）+ React（UI）+ TypeScript，monorepo（npm workspaces）。
仓库**尚未 git init**，建议先初始化再做大改。

**三个应用：**

- **小说**：起点（默认书源）+ 天天看小说 + 69书吧 + 同人小说网。首页是起点的推荐/分类/排行；
  打开书籍默认书源为起点，详情页可换源到另外三个站。
  阅读起点 VIP/APP 章节时自动搜索同名免费书源，跳到同章节并在顶部浮层提示；
  起点有免费章时仍按原书源阅读。
- **动画**：按 animeko 模型重构。首页是 Bangumi 热度榜 / 本季推荐 / 新番时间表；
  搜索匹配条目 → 条目页看标准剧集 → 选集后自动按偏好/线路质量选源并进入播放页，
  视频自动播放；没有候选时才退回手动选源面板。
- 选集不再等全部源：第一个可用源就播；设置→阅读与播放→动画播放可指定默认优先源，
  最多等首选源 900ms，避免卡住的线路拖住播放。默认动画首选=樱花动漫，漫画首选=拷贝漫画。
- **漫画**：CloudWN 漫画 + MYCOMIC + 拷贝漫画。首页是最新/排行/全部；一个图集=一部作品，
  阅读器显示竖排长图；图片统一走 aggmedia 代理补 Referer/UA。
  拷贝漫画默认标记为普通（非 NSFW）；CloudWN/MYCOMIC 仍为 NSFW。

与 animeko 的逐项对照、字段表和后续路线见 [docs/ANI-COMPARISON.md](docs/ANI-COMPARISON.md)。

## 二、界面规范（2026-11-22 重构）

- **首页**（`Launcher.tsx`）：继续阅读/观看大卡（封面、章节、进度条、继续按钮）→ 三张应用卡 → 横向最近记录。
- **左侧栏**：首页图标、搜索、小说/动画/漫画（`漫`）、底部齿轮设置；应用用色块高亮。
- **默认设置**：飞行模式默认关闭；设置 schema v3，从 v2 升级时重置一次，之后按用户选择持久化。
- **应用页**：统一 sticky 头部（返回、应用图标、标题、一句话说明、刷新图标）+ 大搜索框；不再显示“N 个源/N 个数据源”这类技术副标题。
- **内容网格**：封面 3:4，桌面 1120px 宽下 7 列；卡片 hover 上浮，标题两行、作者/日期一行。
- **详情页**：大封面 Hero + 标签/简介 + 主操作；章节/剧集用低对比圆角列表。
- **选源弹窗**：只显示可用线路与集号，匹配过程统一显示“正在寻找可用线路…”，失败来源折叠到“部分来源没有结果”。
- **设置**：根页只保留飞行模式 + 七个入口；`源管理`→`内容源`、`高级网络`→`网络与缓存`、`关于与诊断`→`关于`；运行信息默认折叠。
- **文案**：清除“Bangumi 条目/数据源/订阅源/正在解析/诊断”等面向开发者的可见文案，统一为作品、来源、线路、加载等用户语言。

### Windows 免安装包

- `npm run dist:win` → `release/聚合阅读-0.4.1-portable.exe`
- `apps/desktop/package.json` 内置 electron-builder `portable` 配置；本机无 GitHub Electron 下载网络，
  用 `electronDist: ../../node_modules/electron/dist` 走本地 Electron。
- `winCodeSign` 在本机因无符号链接权限解压失败，暂时 `signAndEditExecutable: false`；
  NSIS 仍能生成带应用图标的 portable EXE（已验证图标/版本/启动）。
- portable 运行注入 `PORTABLE_EXECUTABLE_DIR`，主进程把 `userData/sessionData` 指到 EXE 同级 `data/`；
  关闭开机启动项（移动 EXE 后无效）。
- 已实测：portable EXE 启动 → 设置专项冒烟 `SETTINGS OK`，`data/` 正常创建；
  交付包附带 `README.txt` 与 SHA256。
- **Windows 热更新**：`hot:win` bundle + GitHub Release；启动只提示，About 页手动检查下载；
  主进程覆盖 `agg://` 的 index/renderer/css，SHA256 校验，失败回退内置版本。
- **本地缓存/预加载**：`packages/ui/src/contentCache.ts` 用 IndexedDB 持久化
  小说正文/漫画章节（12h、最多 80 条、可清理）；`preload.ts` 预取漫画附近页；
  Reader 预取下一章/下一集页面。图片/HLS 分片由代理层加 Cache-Control。
- **阅读全屏**：小说不做全屏，点击正文不隐藏工具栏；漫画默认全屏，点中心切换工具栏；阅读器顶栏有换源/刷新图标。
- **Android 动画全屏**：默认不横屏；点全屏图标后调用原生 `setVideoFullscreen(true)`
  横屏，退出恢复。全屏控制层默认隐藏，点击视频/空白唤出上一集、下一集、退出按钮 3 秒。
- **繁简转换**：`packages/ui/src/chinese.ts` 使用 opencc-js（t→cn），默认开启；
  ReaderPrefs `t2s` 可关；正文/章节/书籍/卡片/最近阅读统一 `displayText()`。
  “当前章节内容不完整”/“加载中”等占位符；正文缓存 key 升 v2。
- **发现页/频道**：`DiscoverPage` 聚合源站频道；`ChannelPage` 按应用/源/模式（推荐/排行/分类）浏览。
  `packages/adapters/src/channels.ts` 定义 `SiteChannel`，qidian/ttks 提供排行和分类，
  其余源复用 `home()` 频道；默认频道配置在 `DEFAULT_CHANNEL_TARGETS`。
- **路由**：新增 `discover`、`channels(appId)`，左侧栏「发现」、AppPage 右上角「频道」进入。
- **CloudWN 频道**：`CLOUDWN_CATEGORIES` + `loadCloudwnRank/loadCloudwnCategory`；
  频道页排行=收藏排行，分类=网站真实分类，不再只是首页三个板块。
- **小说阅读**：不做全屏；Reader 顶栏有换源/刷新图标；换源会回详情页并自动打开换源面板。
- **ttks.tw 广告清洗**：60 章后广告可能拼在正文段尾（看书认准/天天看小说伴你读/ⓣⓣⓚ.ⓣⓦ 等），
  在 `cleanText` 中从广告起始词组截断；`contentCacheKey` 升 v3 清旧正文缓存。
- **已移除得奇小说网**：正文需要滚动到区块才由 JS 加载的书源不再收录。
- **换源匹配**：`findSourcesByTitle` 先把候选书名和查询都过 `toSimplified()`，
  再做 pickBestTitle；解决简体查询命中繁体站（ttks.tw）时相似度低于 80 的问题。
- **ttks.tw 搜索**：站内精确命中会 302 到详情页；`searchTtks` 检测 `.novel_info` 并用
  canonical/og:url 还原书籍，避免被当成 0 条搜索结果。站内会把简体查询自动转繁体。
- **ttks.tw 书源**：`packages/adapters/src/sites/ttks.ts`，需真实浏览器渲染；
  Cloudflare 通过隐藏浏览器会话处理，正文取 `div.content p[data-num]` 并清广告水印。
- **动画全屏**：原生播放器全屏按钮是开关式，进入显示上下集控制层，右上角退出按钮常驻。
- **最近阅读**：动画条目 `autoPlay` 走 `playEpisode` 自动选源，旧书架缺 `sort` 时从标题补；
  动画历史按 `subjectId` 显示，不依赖某个源是否启用。
- **全屏底栏**：非全屏时固定视口底部；全屏时位于正文末尾，滚到底出现。
- **路由保存**：`agg.routeStack.v1` 保存完整返回栈（阅读器路由不落盘），
  小说 `/category` 子列表 `agg.novel.list.v1` 也会恢复。
- **阅读滚动**：AppPage 持续监听并保存 `.main` 滚动，内容加载后多次补恢复。
- **漫画分批加载**：`ComicImage` 用 IntersectionObserver + 占位高度，仅加载视口附近页；
  CloudWN 等长图源不再一话全量请求。
- **Android 后台播放**：隐藏 WebView `setMediaPlaybackRequiresUserGesture(true)` + 静音注入；
  Android 不再预取下一集视频页，避免前后台双播放/双声音。
- **Windows 热更新版本**：About 版本号优先显示 `hotVersion`，壳版本放括号内，
  热更新后数字会实际变化。
- **分批加载/返回不刷新**：动画源每批 6 个；阅读器覆盖层保留底层详情页，
  返回不丢滚动/数据；Android 返回键可退出全屏阅读。
- **CloudWN 合集**：详情解析 `a[data-chid]` 多话目录，章节转成单话 album URL；
  合集页无封面时抓第一话封面兜底，修复多话合集封面/内容空白。
- **CloudWN 章节缓存**：`BookPage` 详情自带目录优先于旧缓存，缓存 key v3；
  旧版“全一话”缓存不会覆盖新合集。
- **Android 动画播放**：hls.js 在 Android WebView 关闭 Worker（file:// 下 Worker 易失败）；
  订阅源原始 JSON 本地缓存兜底；自动选源 Android 单源超时 18s；
  MediaProxy 支持 OPTIONS/PNA 预检，HLS 代理失败后会直连重试。
- **首页状态记忆**：`packages/ui/src/viewState.ts` 持久化漫画源 tab、小说 tab/分类、
  动画星期、应用页滚动；AppPage 持续监听滚动事件记录位置，返回后恢复。
- **Android 签名**：`apps/android/debug.keystore` 是自用固定 debug 证书，CI 和本地一致，
  APK 可覆盖安装；不要用于正式分发。
- **Android 更新**：设置 → 关于 → 检查更新。静态 `android-latest.json` 加时间戳
  绕缓存，失败用 GitHub Releases API 兜底；下载用唯一 APK 文件名，完成后自动打开安装器。
  0.2.1 起修复了旧版本检测/下载的兼容问题。
- **Android 视频/漫画**：动画视频点全屏才横屏；漫画默认全屏阅读。
- **GitHub Actions**：`.github/workflows/build.yml`，push main 构建双端 artifact；
  `v*` tag 发布安装包 + `hot-win` 热更新资产。
- **Android**：已实现原生 WebView 壳（`apps/android`，Java，不需要 Capacitor）：
  `MainActivity` + `NativeAgg`（OkHttp/Cookie、隐藏 WebView、表单、媒体嗅探）
  + `MediaProxy`（127.0.0.1 图片/MP4 Range/m3u8 重写）。
  APK：`release/agg-reader-0.4.1-android.apk`；构建工具 JDK21/SDK35/Gradle 8.10 已装在
  `C:\za\android-tools`。已在 x86 模拟器验证：首页、小说首页/详情/免费章节、搜索结果、
  漫画首页/详情/24 张原图阅读（1080×1620）。动画 Bangumi 接口在当前模拟器网络超时，
  视频链路未在真机验证。

## 三、目录结构

```
packages/
  core/        平台无关内核
    src/types.ts     Site / SiteCtx / HostBridge / BookRef / Chapter / VideoInfo / CaptureOpts
    src/ctx.ts       createCtx：静态 fetch → 渲染 → 解析，带 HTML 缓存与拦截识别；新增 request/json
    src/dom.ts       clean/text/attr/absUrl/toParagraphs 等
    src/episode.ts   EpisodeSort / 集号解析 / 跨源包含（移植 ani）
    src/match.ts     标题归一化 / Levenshtein 80% 匹配（移植 ani）
    src/media.ts     videoKindOf（m3u8 vs mp4）
  adapters/    站点与数据源
    src/index.ts         静态站点表 + 应用表（apps）+ 导出
    src/bangumi.ts       Bangumi v0：搜索/详情/剧集/放送表（含旧接口回退）
    src/anime/catalog.ts 条目 → 各源详情 → 单集匹配 / 并发查源 / 换源
    src/subscription/config.ts  animeko 订阅 schema（6.4.1 对齐）
    src/subscription/format.ts  条目/线路/剧集解析（选择器）
    src/subscription/engine.ts  web-selector 工厂
    src/subscription/jsonapi.ts json-api 工厂（稀饭 Next）
    src/subscription/loader.ts  订阅加载
    src/sites/qidian.ts   起点（移动端静态页：首页/分类/排行/详情/目录/正文）
    src/sites/shuba69.ts  69书吧（ALTCHA + JS 链接 + 正文需渲染）
    src/sites/trxs.ts     同人小说网（纯静态 GBK）
    src/sites/cloudwn.ts  CloudWN 漫画（图集分页 + 图片代理）
    src/sites/mycomic.ts  MYCOMIC（JSON-LD 详情 + x-data 章节 + 图片）
    src/sites/mangacopy.ts 拷贝漫画（API 镜像域 + 加密响应 + 章节 contents）
    src/image.ts          图片代理（aggmedia + Referer）
  ui/
    src/App.tsx          路由：home / search / app / subject / book / read
    src/sites.tsx        SitesProvider：启动时加载订阅源
    src/store.ts         书架/进度/阅读偏好/章节缓存/飞行模式设置
    src/pages/Launcher.tsx    首页：继续阅读大卡 + 应用入口 + 最近记录
    src/pages/AppPage.tsx     应用页：动画首页 / 起点找书 / 漫画首页 / 其他书源
    src/pages/AnimeHome.tsx   热度榜 / 本季推荐 / 新番时间表
    src/pages/NovelHome.tsx   起点推荐 / 分类 / 排行
    src/pages/ComicHome.tsx   漫画源聚合首页
    src/pages/SettingsPage.tsx 设置：飞行模式 + NSFW 标记图标入口
    src/pages/NsfwSourcesPage.tsx 三级页：逐源 NSFW 标记
    src/pages/SearchPage.tsx  Bangumi 条目优先 + 小说/漫画/站点直搜
    src/pages/SubjectPage.tsx 条目页：剧集 + 选源面板
    src/pages/BookPage.tsx    站点详情：目录 + 跨站换源 + 起点 VIP 标记
    src/pages/Reader.tsx      阅读器 / 播放器 / 漫画长图（续播、连播、换源）
    src/components/VideoPlayer.tsx  hls.js + aggmedia 代理
    src/components/Cover.tsx
apps/desktop/src/
  main.ts      主进程：会话分区、渲染、采集、表单提交、媒体嗅探、验证窗口、协议、HTTP 请求
  preload.ts   暴露 window.agg（含 request）
  smoke.ts     端到端冒烟（搜索 → 条目 → 选源 → 播放 / 小说阅读）
scripts/        build / dev / smoke / probe / check-sources / test-core / test-subscription
docs/ANI-COMPARISON.md  与 animeko 的对照分析与优化记录
launch.cmd / launch.vbs / assets/app.ico   桌面启动与图标
```

## 四、已完成

### 1. 桌面壳

- Electron 主窗口，UI 跑在自定义协议 `agg://app/index.html`（不能用 file://，否则跨域 XHR 全废）
- 每个站点独立会话分区 `persist:site-<id>`，Cookie/登录态隔离
- 桌面快捷方式「聚合阅读」（`launch.vbs` → `launch.cmd`，启动前静默构建）
- 主进程新增 `agg:request`：自定义 method/headers/body 的通用 HTTP 请求（Bangumi / json-api）

### 2. 七种取数能力（HostBridge → SiteCtx）

| 能力 | 用途 |
|---|---|
| `fetchHtml` | 静态 GET（Chromium 网络栈，带 UA/Referer/Cookie） |
| `request` | 通用 HTTP（JSON API、POST、自定义头） |
| `renderHtml` | 隐藏窗口渲染后 dump HTML（JS 渲染、绕正文剥离） |
| `harvestLinks` | 真实鼠标事件点开 JS 链接并拦截跳转收 URL |
| `submitForm` | 页面内构造表单提交（POST 搜索/登录） |
| `captureMedia` | 播放页嗅探 m3u8/mp4；支持嵌套页、DOM/performance/脚本文本、UA/Cookie |
| `verifySite` | 打开可见窗口让用户过 Cloudflare，成功后 Cookie 复用 |

媒体播放链路：`aggmedia://stream/?u=…&r=…&ua=…&ck=…` 主进程代理。
**必须用 `net.fetch`**（Chromium 网络栈，走系统代理）；Node fetch 不走系统代理。
mp4 直接返回上游 Response；m3u8 改写分片地址；分片补 CORS 后流式透传。

### 3. 小说应用

- **起点（默认书源）**：移动端 `m.qidian.com` 服务端渲染，静态请求即可
  - 首页：限时免费 / 新书抢鲜 / 畅销完本（各 20 本）+ 推荐位；每栏右上角「更多」
  - 分类：13 个分类，`/category/catidX/`
  - 排行：月票/畅销/阅读/书友/推荐/更新/签约/新书/新人 9 个榜单（各 20 本，「更多」打开榜单页）
  - 详情/目录/正文：`/book/{id}/`、`/book/{id}/catalog/`、`/chapter/{bookId}/{chapterId}/`
  - 目录按「第一章」定位完整列表（首条是最新章），标题去掉「免费/VIP」后缀；
    付费章节标记 `Chapter.locked`，正文检测到「登录订阅本章」时提示换源
  详情 `#list-chapterAll dd a`；正文静态为空，`#chapter-content` 由 chapter.js 分块渲染。
  章节标题带 `(第N/M页)`；第 1 页先回调给阅读器，剩余页后台 3 并发抓取并按页序合并，
  阅读器正文尾部显示「正在加载后续内容…」，完成后 `streaming=false`。
- 69书吧：ALTCHA 人机验证、目录链接 JS 点击生成、正文静态被剥离
- 同人小说网：纯静态 GBK，目录一次拿全
- 阅读器：字号/主题（纸质·护眼·夜间）、进度持久化、相邻章预取、目录边采边显示
- 书架点击可直接回到上次章节（有章节缓存时），否则回详情

### 4. 动画应用（重写）

- **首页**：Bangumi 热度榜（全站 heat）/ 本季推荐（当前季度 air_date + heat）/ 新番时间表（周一至周日）
- **搜索**：Bangumi `POST /v0/search/subjects` 条目为主；站点直搜折叠为兜底；
  分类计数 = 条目数 + 站点结果数
- **条目页**：封面/原名/评分/标签/简介；Bangumi 剧集表（分页加载，默认 120 集、可搜索）；
  「继续观看」；已看标记（真正播放过才算）
- **选源**：点某一集 → 用条目全部别名（含去季度后缀的基础名）并发搜索所有动画源
  → 标题 80% 匹配 → 拉条目页 → 按集号匹配合适线路 → 列出候选（源/线路/耗时/失败原因）
  → 点选播放；同一集多线路按 `channelTiers` 选最优
- **播放**：hls.js + 代理；mp4 直连代理；续播（按 subjectId + 集号，换源也能续）；
  自动连播默认关（阅读设置里开）；播放页「换源」回条目页并自动重开该集选源
- **历史**：按 Bangumi subjectId 归并，换源/换线不新增历史
- **应用内搜索**：动画 / 小说 / 漫画应用页都有搜索栏，进入搜索页时默认只勾选本应用分类
- **订阅**：21/21 源可构建（20 web-selector + 1 json-api）；补齐 `rawBaseUrl`、
  `linkTemplate`、`matchEpisodeSortFromName`、`selectEpisodeLinks*`、`channelTiers`、
  `autoMatch`、`userAgent`、`cookies`、DOM/脚本扫描等字段

### 5. 漫画应用

- **CloudWN 漫画**：`/photos-index-aid-{id}.html` 图集；一个图集=一部作品，每页 12 张、
  分页 `photos-index-page-{n}-aid-{id}.html`。图集页 `img` 是 `/data/t/` 缩略图，
  每张图对应 `/photos-view-id-{id}.html`，必须再抓 view 页里的 `#picarea` 才能拿到
  `/data/` 原图和 `verify` 参数；适配器 4 并发抓 view 页，失败时回退缩略图。
- **MYCOMIC**：`/cn/comics` 列表、`/cn/comics/{id}` 详情、`/cn/chapters/{id}` 章节；
  详情章节列表内嵌在 `x-data="{ chapters: [...] }"`，章节图片在 `biccam.com/chapters/...`。
  列表卡片上的「第1150话」是封面叠加的最近章节，书名取 `img[alt]` / `data-flux-subheading`，
  不能用链接文本当标题。
- **拷贝漫画**：网页 `/comic/{path}`；API 走 `api.manga2025.com` 等镜像域，必须带
  `Version: 2025.11.21` / `Region: 0` / `platform: 1`；详情 `/api/v3/comic2/{path}`，
  章节 `/api/v3/comic/{path}/group/default/chapters`，图片 `/api/v3/comic/{path}/chapter/{uuid}`
  的 `results.chapter.contents`。部分域返回 `code=210` 时自动换域。
- 三个源的封面/漫画图片都校验 Referer，统一经 `aggmedia` 图片代理补 Referer/UA。
- 阅读器新增 `ChapterContent.images` 竖排长图模式；图片懒加载，隐藏字号设置。
- **进度**：`ShelfEntry` 增加 `page/pageCount`（漫画）和 `scroll`（小说 0..1）；
  动画继续用 `position/duration` 秒数。`Reader` 滚动时回写，续读时恢复页码或滚动位置。
- 漫画首页聚合三个源的最新/排行/全部；单源失败显示「验证 / 重试」。

### 6. 设置

- 左侧栏「设」进入设置根页，子页包括：内容源、阅读与播放、外观、启动与搜索、
  存储与隐私、网络与缓存、关于；NSFW 标记仍是飞行模式旁 `⋯` 的三级页。
- **飞行模式**：开启显示全部（仅排除手动禁用源）；关闭隐藏 NSFW 标记源。
- **内容源**：`sourceEnabled` / `sourceRank` / `preferredSource` 生效于 `filterSites`；
  支持逐源检测、验证、清 Cookie。设置页用 `ctxForAll`，被隐藏/禁用的源也能检测。
- **阅读与播放**：`ReaderPrefs` 扩展行距/段距/正文宽度/漫画适配；`playback` 控制倍速、
  静音、HLS 首选高度；`network.imagePreload` 控制漫画首屏 eager 数量。
- **存储与隐私**：localStorage 占用、清章节缓存、清最近记录、清站点 Cookie、无痕
  （不写书架）、模糊封面、导出/导入、恢复默认。
- **外观**：`data-theme` / `data-density` / `data-motion` + `--accent`，支持深浅色与跟随系统。
- **启动**：起始页（首页/上次/指定应用）、开机启动（`app.setLoginItemSettings`）、
  托盘（`Tray`，关闭窗口隐藏）、默认搜索分类。
- **网络与缓存**：`core/runtime` 的并发/HTML TTL，主进程 `networkTimeoutMs`，
  设置页显示 `resolveProxy` 的系统代理结果。
- **关于**：`agg:app-info`、`agg:open-data`、诊断文本复制。
- 设置持久化在 `localStorage` 的 `agg.settings.v1`；阅读偏好独立在 `agg.reader.v1`。

### 7. 工具与测试

- `npm run dev` 开发（watch + DevTools）
- `npm run check` 类型检查
- `npm test`：core 集号/匹配单测 + 订阅 21 源构建测试
- `npm run smoke` 端到端；支持 `AGG_SMOKE_INDEX`（应用序号）、`AGG_SMOKE_QUERY`、
  `AGG_SMOKE_OUT`、`AGG_SMOKE_FRESH`
- `node scripts/probe.mjs <url>` 抓渲染后 HTML 到 `_probe/probe.html`
- `node scripts/check-sources.mjs` 查看订阅源当前域名

## 五、关键设计

- **保留 `Site` 抽象**，新增可选元数据（`autoMatch`、`sourceTier`、`channelTiers`）与
  `Chapter.sort/channel`，没有照搬 ani 的 `MediaSource`；六种取数通道已经覆盖桌面端需求。
- **动画是条目中心**：作品身份 = Bangumi subject；源只回答「这一集在哪」。
- **小说是站点中心**：没有 Bangumi 小说体系；跨站换源按标题匹配。
- **漫画是图集中心**：一个图集/章节对应一组图片，`ChapterContent.images` 直接进入长图阅读器；
  图片必须走主进程代理补 Referer。
- **纯函数优先**：`extract` 是 DOM 进 JSON 出；集号/标题匹配在 core 里可单测。
- **历史/续播按 subjectId**；小说/漫画按 URL。

## 六、已知问题与限制

1. **Cloudflare 源**：部分源仍需用户点「验证」；`verifySite` 只负责打开窗口与判断 Cookie/标题，
   没在真机上把每一步都点通。
2. **订阅限流**：`requestInterval`/`searchCacheTtl` 还没有在客户端强制；`findEpisodeSources`
   一次会并发 6 个源，批量冒烟时容易触发站点限流，表现为部分源 0 结果。
3. **选源仍是手动**：没有 ani 的四层 DFS 自动选择（分辨率 → 字幕语言 → 字幕组 → 数据源）；
   当前只按 tier/匹配分排序并记忆上次源。
4. **剧集类型**：只取 Bangumi `type=0`（本篇）；SP/OVA/OP/ED 未展示。
5. **多清晰度**：同一线路的多清晰度没有解析；`defaultResolution` 仅展示。
6. **自动连播默认关**：与 ani 的 `autoPlayNext=false` 一致，设置里可开。
7. **控制台 CSP 警告**：index.html 没有 CSP，不影响功能。
8. **Bangumi API 依赖网络**：搜索/条目页失败时只能看站点直搜结果；无本地条目缓存。
9. **CSP/自定义协议**：mp4 必须原样返回上游 Response，重新包装会 code 4；m3u8 分片可以重新包装。
   播放器失败会自动回退（代理 → 代理+缓存参数 → mp4 直连），偶发 Range/缓存问题可自愈。
10. **动画源完全依赖订阅**：已移除非凡/百度两个静态资源站；订阅拉取失败时动画应用没有可用源，
    需要重新加载订阅（错误会显示在应用页）。
11. **起点付费章节**：匿名只能看到预览；`Chapter.locked` 会标 VIP，正文检测到「登录订阅本章」
    时提示换源。免费章节可正常读。
12. **起点页面结构**：使用 CSS Modules 哈希类名（`_bookWrapper_...`），起点改版时需更新选择器；
    当前分类/排行只取第一页，没有「查看更多」分页。
13. **起点会话**：没有做登录态/购买同步；需要登录的章节一律走换源。
14. **MYCOMIC Cloudflare**：本机网络访问 mycomic.com 会返回 403（Cloudflare IP 拦截）；
    HTML 静态/隐藏渲染都无法通过，图片 CDN `biccam.com` 带 Referer 可访问。
    应用内提供「验证 / 重试」，能否通过取决于用户网络。
15. **漫画图片**：CloudWN 图集页只有 `/data/t/` 缩略图，需要逐图抓 `/photos-view-id-*` 的
    `#picarea` 原图（36 图/3 个分页，首开约 3.6 秒）；`chapterCache` 内存缓存 30 分钟，
    未做磁盘缓存/预加载。
16. **未做**：弹幕、缓存/下载、BT/Mikan、Bangumi 账号收藏同步、跳过 OP/ED；
    安卓端动画接口/播放器仍需真机验证。

## 七、待完成（建议优先级）

### P0 选源偏好引擎
把 ani 的 `MediaSelector` 过滤/排序/四层 DFS 抽成纯函数：
`(candidates, preference, settings, context) => Media | null`，便于单测与回归。
先支持分辨率与字幕语言的偏好，再扩展到字幕组/数据源。

### P1 订阅节流与持久缓存
- 每源 `requestInterval` 在搜索/详情节流；
- 搜索缓存持久化（`searchCacheTtl`）；
- 选源结果缓存到 localStorage，切集不重复搜索。

### P2 起点体验与剧集类型
- 起点分类/排行榜「查看更多」分页、搜索翻页；
- 起点登录态复用与免费/付费筛选；
- Bangumi `/v0/episodes` 取全部类型，按 `type` 分组显示；
- 解析线路/清晰度标签，存 `Chapter.resolution`，选源时展示。

### P2.5 漫画体验
- MYCOMIC 会话/Cloudflare 验证复用；
- 漫画图集分页并发与磁盘缓存、预加载下一话；
- 图片代理失败重试/占位图。

### P3 账号与收藏
Bangumi OAuth、收藏类型、集级 watched 同步；「我的」页拆成追番 + 账号。

### P4 缓存/下载/BT/弹幕
按 ani 的 `MediaCacheManager`、BT 源、弹幕 provider 逐步补。

### P5 安卓端（首版已通）

- 已做：WebView + NativeAgg + MediaProxy，小说/漫画/搜索在模拟器可用。
- 待做：真机验证动画 Bangumi/选源/HLS；站点 Cookie 按域隔离；隐藏 WebView 的复杂 WAF；
  真机触控/返回键细节；release 签名。
- 详细构建与限制见 `apps/android/README.md`。

## 八、环境与踩坑（非常重要）

1. **`ELECTRON_RUN_AS_NODE=1`**：本机环境带这个变量，Electron 会退化成纯 Node 直接崩。
   所有启动脚本（`launch.cmd`、`scripts/*.mjs`）都显式清掉；直接用 electron.exe 跑脚本时也要清。
2. **Electron 命令行参数**：传空字符串或带 `?`/`%` 的 URL 会让进程直接退出（exit -1）。
   探测脚本一律把 URL 写死在脚本里。
3. **`spawn` 的 stdio**：`inherit` 在本环境会让 Electron 立刻退出；用 `ignore` 或 pipe。
4. **`.cmd` 必须 CRLF + 纯 ASCII**：LF + 中文注释会让 cmd 解析错乱。
5. **不要用 PowerShell 的 `Get-Content/Set-Content` 处理 UTF-8 源码**（PS 5.1 会按 ANSI 读）。
   改文件用编辑工具或 `[System.IO.File]::WriteAllText(..., UTF8Encoding($false))`。
6. **僵尸进程**：测试失败后常有残留 electron 进程，重跑前 `Get-Process electron | Stop-Process -Force`。
7. **网络**：本机 git 直连 GitHub 被重置，但 `raw.githubusercontent.com` / jsDelivr / 系统代理可用。
   主进程媒体代理必须 `net.fetch`；Node fetch 不走系统代理，会表现为播放器一直 0:00。
8. **mp4 播放**：`aggmedia` 对 mp4 必须直接返回 `net.fetch` 的 Response；重新包装
   `new Response(stream)` 会 `MEDIA_ERR_SRC_NOT_SUPPORTED`（code 4）。
9. **loadURL 可能挂很久**：渲染/采集/播放页要 `Promise.race(loadURL, delay(...))`，
   否则一个长连接会把整个嗅探拖到 80 秒。
10. **漫画图片必须带 Referer**：cloudwn 的 `wnimg2.cfd` 与 mycomic 的 `biccam.com` 都会校验；
    统一走 `aggmedia://stream/?u=…&r=…`，主进程用 `net.fetch` 补 UA/Referer。
11. 站点会话 / 缓存：HTML 缓存默认 5 分钟（设置里可调 0–120）；搜索缓存 10 分钟；
    目录缓存 12 小时（localStorage）。

## 九、验证方式

```bash
npm run check
npm test
npm run smoke                                   # 默认搜索「孤独摇滚」（条目链路）
AGG_SMOKE_INDEX=1 AGG_SMOKE_QUERY=孤独摇滚 npm run smoke   # 动画首页（热度 → 条目 → 选源 → 播放）
AGG_SMOKE_INDEX=0 AGG_SMOKE_QUERY=诡秘之主 AGG_SMOKE_FRESH=1 npm run smoke  # 小说首页（起点）
AGG_SMOKE_INDEX=2 AGG_SMOKE_QUERY=同人 npm run smoke        # 漫画首页（CloudWN 图集 → 长图阅读）
AGG_SMOKE_MANGA=1 npm run smoke                 # 拷贝漫画源专项（首页 → 详情 → 51 章 → 20 图）
AGG_SMOKE_CLOUDWN=1 npm run smoke               # CloudWN 原图专项（图集 → view 页 → 1359×1920）
AGG_SMOKE_NOVEL_PROGRESS=1 npm run smoke        # 小说滚动进度保存/续读
AGG_SMOKE_SETTINGS_ONLY=1 AGG_SMOKE_OUT=_probe/settings-only npm run smoke  # 只跑设置七个页面
node scripts/check-sources.mjs                  # 查看订阅源当前域名
```

最近一次全量验证：
- 搜索：9 个 Bangumi 条目 + 26 条站点结果（含起点 20 条）；
- 动画首页：热度榜 18、本季推荐、新番时间表；点热度第一条（命运石之门）→ 24 集 → 4 个源 → 1920×1080 播放；
- 条目选源：第 1 集命中 4~7 个源，girigiri mp4 1920×1080 播放 26 秒；
- 小说首页：起点「推荐 / 分类 / 排行」；推荐每栏 20 本、「更多」22 本；排行 9 个榜单（各 20 本）；
  分类 25 本；
- 应用内搜索：小说分类 46 条、动画分类 10 条、漫画分类 24 条，分类 chip 默认勾选正确；
- 起点书籍：目录 213 章、第 1 章 121 段、下一章为第 2 章，标题无「免费」后缀；
- 漫画：CloudWN 首页最新/排行/全部；图集 1 话、36 张原图，首图代理加载成功（1359×1920，原 /data/ 图）；
  MYCOMIC 在本机被 Cloudflare 403 拦截，应用内显示「验证 / 重试」；
  拷贝漫画：首页 2 栏、详情 51 章、首章 20 图（首图代理加载成功）、下一章「第02話」；
- 漫画续读：滚到第 4 页后保存 `page=4/pageCount=21`，返回详情点「继续阅读」恢复到 `P4/21`；
- 小说续读：滚到 50% 后保存 `scroll=0.500`，返回详情点「继续阅读」恢复滚动比例 `0.500`；
  后台 3 并发加载剩余页，最终 224 段（约 14.4 秒，`streaming=false`），阅读器不再出现站点分页；
- 动画仍用原有 `position/duration`（秒）记录，Reader 新增的滚动/页码逻辑对视频内容不生效；
- 设置：根页 + 内容源/阅读与播放/外观/启动与搜索/存储与隐私/网络与缓存/关于
  七个三级页全部可打开；源健康检查：同人小说网 406ms、稀饭动漫 445ms（动画源走搜索，
  不再被订阅源的空 `home()` 误判为 0ms）；浅色主题 `data-theme=light` 生效；
- 飞行模式关闭时隐藏 2 个已标记源（CloudWN/MYCOMIC），拷贝漫画默认普通；开启后隐藏 0 个；
  `npm test` 含 `settings tests OK`；
- 截图在 `_probe/settings-only/`、`_probe/settings-final2/`；漫画/动画旧链路截图在
  `_probe/anime-search/`、`_probe/novel-final2/`、`_probe/comic-smoke/`。

## 十、下个对话建议的起手式

1. 先 `git init` 并提交当前状态，避免后续重构无回滚点。
2. 跑一次 `npm run check` + `npm test` + `npm run smoke`，确认基线可用。
3. 优先级：选源偏好引擎（P0）→ 订阅节流/缓存（P1）→ 剧集类型（P2）。
4. 动 Cloudflare 源需要用户配合点验证，无法自动化验证。
