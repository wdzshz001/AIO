# 聚合阅读

一个把多个网页站点收进同一个入口的阅读启动器。首页是「继续阅读 + 应用入口 + 最近记录」，打开后是统一的列表 / 详情 / 阅读界面——不打开浏览器，也不看各站自己的广告和排版。
动画应用按 animeko 的模型工作：搜索匹配 Bangumi 条目，打开条目选集，再按集到 20+ 个数据源里选源播放。
漫画应用把 CloudWN、MYCOMIC 与拷贝漫画三个源聚合到同一个阅读器里。

> 项目当前进度、已知问题、待办与环境踩坑，见 [HANDOVER.md](HANDOVER.md)。
> 双端编译步骤见 [docs/BUILD.md](docs/BUILD.md)，双端架构差异/修改影响范围见 [docs/PLATFORM.md](docs/PLATFORM.md)。
> Git CI 与热更新方案见 [docs/HOT-UPDATE.md](docs/HOT-UPDATE.md)。
> 与 animeko 的逐项对照见 [docs/ANI-COMPARISON.md](docs/ANI-COMPARISON.md)。

当前完成 **P0**：Windows 桌面端，三个应用（小说 / 动画 / 漫画）跑通完整链路。动画已切到「Bangumi 条目 → 单集 → 选源 → 播放」。

界面以「内容优先」组织：首页首屏是一张继续阅读/观看大卡，下面是应用入口和横向最近记录；
内容页统一使用封面网格、详情 Hero、章节/剧集列表和沉浸式阅读器；设置页只保留用户能理解的开关与入口。
左侧栏固定为首页图标、搜索、小说 / 动画 / 漫画和齿轮设置；飞行模式默认关闭。

## 打包 Windows 免安装版 / Android APK

Windows：

```bash
npm run dist:win
```

产物在 `release/聚合阅读-0.1.0-portable.exe`。运行后会在 EXE 同级创建 `data/`，
设置、书架、缓存都放在里面，移动时 EXE + `data/` 一起复制即可。
第一次运行可能被 SmartScreen 拦一下，点「更多信息 → 仍要运行」。

Android：

- 产物 `release/agg-reader-0.1.0-android.apk`（minSdk 26，targetSdk 35，debug 签名，可侧载）
- 源码与构建说明见 [apps/android/README.md](apps/android/README.md)
- 当前已验证首页、小说/漫画、搜索；动画网络与视频链路仍需真机验证

GitHub Actions 自动构建：`.github/workflows/build.yml`。push main 只构建；`v*` tag 创建 Release
并附带 Windows 热更新 bundle。热更新方案见 [docs/HOT-UPDATE.md](docs/HOT-UPDATE.md)。

## 应用与站点

用户只面对「应用」，站点在应用内部聚合，不再有单独的站点入口。

| 应用 | 聚合的站点 | 能力 |
|---|---|---|
| 小说 | 起点（默认书源）、得奇小说网、69书吧、同人小说网 | 起点推荐/分类/排行首页、详情、目录、阅读、书架直达进度、跨站换源 |
| 动画 | 21 个 animeko 在线源（含 1 个 json-api） | Bangumi 热度/本季推荐/新番时间表、条目搜索、剧集表、按集选源、换源、续播、连播 |
| 漫画 | CloudWN 漫画、MYCOMIC、拷贝漫画 | 最新/排行首页、搜索、详情、全部图片竖排阅读、图片代理 |

站点按 `kind` 归属应用（`apps` 注册表），加站点只要实现 `Site` 并在 `sites` 里注册一行，UI 不用改；
订阅源在运行时加载，不写死。

### 动画为什么先搜 Bangumi

站点的标题、集号、线路都很脏，同一个作品在不同站叫法不同。animeko 的做法是：

1. 只用 Bangumi 条目做「作品身份」，搜索页把条目列出来；
2. 打开条目拿到标准剧集表（集号 `01`、`02`…）；
3. 播放某一集时，用条目的**全部别名**去各源搜索，按标题相似度 80% 对齐作品，再把站点集号
   （`第1集` / `01` / `SP1`）解析成 `EpisodeSort` 与 Bangumi 的集号匹配；
4. 同一集在多个源/多条线路可用时，列出候选并记住上次选择。

这样封面、同名合并、换源、续播、集数顺序都由条目统一，不再依赖站点自己的排版。

### 小说首页：起点找书

小说首页以**起点中文网**为主，分三个找书模块：

- **推荐**：限时免费 / 新书抢鲜 / 畅销完本（各 20 本）+ 起点首页推荐位
- **分类**：玄幻 / 奇幻 / 武侠 / 仙侠 / 都市 / 现实 / 军事 / 历史 / 游戏 / 体育 / 科幻 / 悬疑 / 轻小说
- **排行**：月票榜、畅销榜、阅读榜、书友榜、推荐榜、更新榜、签约榜、新书榜、新人榜（各 20 本）

每个栏目右上角都有「更多」：打开该栏的完整列表页（榜单 20 本，免费/新书/畅销列表约 20–22 本）。
点开书籍后**默认书源为起点**；详情页右上角「换源」会按书名在得奇小说网 / 69书吧 / 同人小说网里找同名作品，
一键切换。起点免费章节可以直接读；付费章节匿名只能看到预览，阅读器会提示回详情页换源。

### 漫画应用：CloudWN / MYCOMIC / 拷贝漫画

- **CloudWN 漫画**：图集站。首页/收藏排行/全部漫画 -> `/photos-index-aid-{id}.html`；
  一个图集就是一部作品，内部按 12 张一页分页，阅读时自动抓齐全部分页并竖排展示。
- **MYCOMIC**：`/cn/comics` 列表、`/cn/comics/{id}` 详情、`/cn/chapters/{id}` 章节；
  章节正文是一组 `biccam.com/chapters/...` 图片。
- 两个源的图片 CDN 都校验 Referer，统一走 `aggmedia` 图片代理（补 Referer/UA）。
- **拷贝漫画**：网页 `mangacopy.com/comic/{path}`；API 走 `api.manga2025.com` 等镜像域，
  必须带 `Version: 2025.11.21`、`Region: 0`、`platform: 1` 请求头；章节图在
  `/api/v3/comic/{path}/chapter/{uuid}` 的 `results.chapter.contents`。
- MYCOMIC 在部分网络会被 Cloudflare 拦截；漫画首页会给出「验证 / 重试」入口。
- 阅读器新增竖排长图模式；图片懒加载，工具栏只保留返回/换源等必要项。
- **继续阅读**：动画记录播放秒数，小说记录滚动比例，漫画记录当前页/总页数；书架和最近记录会显示进度。

### 设置

左侧栏「设」进入设置：

- **飞行模式**：开启后显示全部源；关闭时隐藏所有被标记的源。旁边的 `⋯` 进入
  **NSFW 标记**三级页，逐源标记；CloudWN / MYCOMIC 默认标记，拷贝漫画默认普通。
- **内容源**：逐源启用/禁用、上下排序、分类首选源、单源健康检查、验证、清 Cookie。
- **阅读与播放**：小说字号/行距/段距/正文宽度/主题；漫画铺满或完整显示；
  动画自动连播、倍速、静音、默认清晰度。
- **外观**：深色 / 浅色 / 跟随系统、强调色、紧凑/舒适、减少动画。
- **启动与搜索**：首页/上次页面/指定应用启动、开机启动、最小化到托盘、默认搜索分类。
- **存储与隐私**：localStorage 占用、清理章节缓存/最近记录/Cookie、无痕模式、模糊最近封面、
  导出/导入/恢复默认。
- **网络与缓存**：搜索并发、请求超时、HTML 缓存、图片预加载、系统代理状态。
- **关于**：版本/运行环境、检查更新、运行信息（折叠）、打开数据目录。
- 设置保存在 `localStorage` 的 `agg.settings.v1`，阅读偏好单独在 `agg.reader.v1`，重启后保留。

### 源从哪里来（重要）

animeko 的在线源不是写死在代码里的，而是通过**数据源订阅**下发：

- 在线源：`https://sub.creamycake.org/v1/css1.json`
- BT 源：`https://sub.creamycake.org/v1/bt1.json`（本项目暂未接入）
- 社区聚合：`https://github.com/MajoSissi/animeko-source`（`dist/all.json`）

订阅是 `{ schemaVersion: 2, mediaSources: [...] }` 的 JSON，每个源带 `factoryId`（`web-selector` / `json-api`）
和一份选择器/接口配置。站点换域名时**改的是订阅文件**，客户端只要重新拉订阅即可。

```bash
node scripts/check-sources.mjs   # 拉订阅并打印所有源的当前域名，用来发现换域名
```

当前订阅里（21 个源：20 个 `web-selector` + 1 个 `json-api`）与本项目相关的：

| 源 | 当前域名 | 接入状态 |
|---|---|---|
| 海星动漫 | `www.haixingdmx.com` | ✅ 实测播放 |
| 嘀嗒影视 | `www.didahd.pro`（跳 .xyz） | ✅ 已按订阅配置接入 |
| 番茄动漫 | `www.fqdm.cc` | ✅ 实测播放 |
| E-ACG | `www.eacg1.com` | ✅ 实测播放 |
| girigiri | `bg.girigirilove.com`（详情）/ `m3u8.girigirilove.com`（搜索） | ✅ 实测 1920×1080 |
| 稀饭动漫 | `dm1.xfdm.pro` | ✅ 实测匹配 |
| 森之屋 / 叽哔 | `senfun.in` / `www.jibi.cc` | ✅ 实测匹配 |
| 稀饭 Next | `api.xifanacg.com` | ✅ json-api 工厂已实现 |

小说侧：起点走移动端 `m.qidian.com`（桌面站有 JS 挑战，移动端是服务端渲染），
首页/分类/排行/详情/目录/正文都可直接抓取；付费章节只返回预览，因此保留「换源」。

`packages/adapters/src/subscription/` 是订阅引擎：`config.ts` 声明 schema，`format.ts` 解析条目/线路/剧集，
`engine.ts` 是 `web-selector` 工厂，`jsonapi.ts` 是 `json-api` 工厂。换域名时同步订阅即可，不用改代码。

### 播放页嗅探

网页源的播放页 iframe 是 JS 动态生成的，靠 `captureMedia()` 打开真实页面、监听网络请求截获 m3u8
（对应 animeko 的 `WebVideoMatcher`）。播放器页常见的 `player.html?url=<m3u8>` 会把真实地址从参数里挖出来；
订阅里的 `matchNestedUrl` 命中嵌套页时会继续打开，`scanDomMediaUrls`/`scanInlineScriptUrls`
再从 DOM、`performance` 资源与内联脚本兜底。

## 快速开始

**桌面快捷方式**：`聚合阅读`（`C:\Users\<你>\Desktop\聚合阅读.lnk`），双击即用。
它指向仓库里的 `launch.vbs` → `launch.cmd`：先静默构建，再启动 Electron，不弹控制台窗口。
改了源码也不用重新打包，每次启动都会重新构建。

命令行方式：

```bash
npm install          # 已配好 npmmirror
npm run dev          # 开发模式（esbuild watch + Electron，改完自动刷新）
npm run smoke        # 冒烟测试：自动走完整流程并截图到 _probe/
AGG_SMOKE_SETTINGS_ONLY=1 npm run smoke  # 只跑设置的七个页面
AGG_SMOKE_MANGA=1 npm run smoke          # 拷贝漫画源专项
AGG_SMOKE_CLOUDWN=1 npm run smoke        # CloudWN 原图专项
AGG_SMOKE_NOVEL_PROGRESS=1 npm run smoke # 小说滚动进度
AGG_SMOKE_DEQIXSS=1 npm run smoke        # 得奇小说网专项
npm run check        # 类型检查
npm test             # core 集号/匹配 + 设置过滤 + 订阅 21 源构建测试
launch.cmd           # 等价于双击快捷方式
```

## 目录结构

```
packages/
  core/       纯逻辑：类型、DOM、集号/标题匹配、抓取上下文（fetch → render 自动降级）
  adapters/   Bangumi 客户端、订阅引擎、起点/得奇/小说站、CloudWN/MYCOMIC/拷贝漫画源、图片代理
  ui/         React 界面：宫格 / 搜索 / 动画首页 / 起点找书 / 漫画首页 / 设置子页 / 条目 / 选源 / 详情 / 阅读器
apps/
  desktop/    Electron 主进程（会话、渲染、采集、HTTP、媒体/图片代理）+ preload
scripts/      build / dev / smoke / probe / test-core / test-subscription
docs/         与 animeko 的对照分析
launch.cmd    启动脚本（静默构建 + 启动 Electron）
launch.vbs    无控制台窗口的启动包装
assets/app.ico 快捷方式图标
```

## 核心设计：从 `ctx.doc()` 到 `ctx.capture()`

| 能力 | 用途 | 实现 |
|---|---|---|
| `fetchHtml` / `request` | 静态页 / JSON API | Electron `session.fetch`，带该站 Cookie/Referer；`request` 支持 method/headers/body |
| `renderHtml` | 需要 JS 或被 WAF 拦的页 | 隐藏 `BrowserWindow` 加载后 dump `outerHTML` |
| `harvestLinks` | 链接是 JS 点出来的页 | 真实鼠标事件逐个点开 + 拦截跳转收 URL |
| `submitForm` | 只能 POST 的入口（搜索/登录/回帖） | 隐藏窗口里构造表单并提交，跟随真实导航 |
| `captureMedia` | 播放页的 m3u8/mp4 | 真实窗口嗅探网络 + DOM/performance/内联脚本 + 嵌套播放页 |

上层只调用 `ctx.doc(url)`：先走静态请求，被拦截或内容残缺时才启动真实浏览器，并缓存 HTML（5 分钟）。
**关键点是 `extract` 是纯函数（DOM 进、JSON 出）**，桌面端和将来的安卓端可以共用一字不改。

## 搜索与选源

- 首页顶部、左侧栏、以及**每个应用内部**都有搜索入口。应用内搜索会自动只勾选本应用分类
  （小说应用 → 只看小说；动画应用 → 只看动画）。
- **动画**：先列 Bangumi 条目（作品身份），点条目进剧集页；站点直搜结果折叠在下面兜底。
  选中某一集后，用条目全部别名并发搜索所有动画源，按标题 80% 匹配、按集号对齐，
  列出可选源/线路，点击播放。选过的源会记住。
- **小说**：一次搜全部小说站，结果按站点合并；**起点结果优先**，点结果进详情；详情页可「换源」。
- **漫画**：搜 CloudWN / MYCOMIC / 拷贝漫画，结果按漫画分类合并；点结果进详情，阅读器显示竖排长图。
- 飞行模式关闭时，被标记为 NSFW 的源不参与搜索。
- 站点只要实现了 `search(ctx, keyword)`，就自动进入聚合搜索，不需要改 UI。
- 各站并行搜索，单站失败不影响其他站（错误就地显示 + 重试 / 去验证）；结果按「站点+关键词」缓存 10 分钟。
- 三种实现样本：
  - `起点`：移动端静态页，搜索 `/so/{关键词}.html`
  - `69书吧`：结果页可以直接 GET（`/search/1?searchkey=`）
  - `同人小说网`：只有 POST 表单，走 `ctx.submit()`；该站还有 60 秒搜索频率限制，超限会提示原因
- 点击结果直接进书籍页；目录边采边显示（先给前 100 章，剩下的后台继续），不用等整本目录采集完。

## 适配器接口

```ts
interface Site {
  id, name, icon, baseUrl, kind, color?
  sourceTier?, channelTiers?, autoMatch?              // 订阅源元数据
  home?(ctx): Promise<BookSection[]>
  search?(ctx, keyword): Promise<BookRef[]>
  detail(ctx, url): Promise<BookDetail>               // chapters: {title,url,sort?,channel?,order?,locked?}[]
  chapters?(ctx, bookUrl, onProgress?): Promise<Chapter[]>
  chapter(ctx, url): Promise<ChapterContent>          // 正文或 video
}
```

## 新增一个站点

1. 用 `node scripts/probe.mjs <url>` 抓一份渲染后的 HTML 到 `_probe/probe.html`，看选择器
2. 在 `packages/adapters/src/sites/` 加一个文件，实现 `home / detail / chapter`（目录能一次拿全就不用写 `chapters`）
3. 在 `packages/adapters/src/index.ts` 注册一行
4. `npm run smoke`（`AGG_SMOKE_INDEX=0` 小说 / `1` 动画）验证全链路并截图

订阅源不需要写代码：域名/选择器变化改订阅文件即可。只有「新站点类型」才需要实现 `Site`；
站点数量计划在 10–20 个静态适配器以内，其余走订阅。

### 现成样本

- [qidian.ts](packages/adapters/src/sites/qidian.ts)：移动端静态页；首页/分类/排行/详情/目录/正文，付费章节检测
- [deqixss.ts](packages/adapters/src/sites/deqixss.ts)：POST 搜索 + 目录；首屏先返回，剩余分页后台合并
- [cloudwn.ts](packages/adapters/src/sites/cloudwn.ts)：图集分页抓取 + 图片代理（多页图集）
- [mycomic.ts](packages/adapters/src/sites/mycomic.ts)：JSON-LD 详情 + x-data 章节 + 章节图片
- [mangacopy.ts](packages/adapters/src/sites/mangacopy.ts)：独立 API 域 + 加密响应 + 章节 contents
- [shuba69.ts](packages/adapters/src/sites/shuba69.ts)：难的那种，演示三通道怎么配合
- [trxs.ts](packages/adapters/src/sites/trxs.ts)：普通静态站，50 行左右就能接完

## 69书吧这个站点踩到的坑（很重要）

1. **整站有人机验证**（ALTCHA 工作量证明，PBKDF2）。静态请求一律 403，必须用真实 Chromium 过一次验证，之后 Cookie 存在分区里，后续请求才通。→ `render` 通道 + 每个站点独立 `persist:site-xxx` 会话。
2. **目录里的章节链接是 `<span>` 不是 `<a>`**，且点击处理器只接受 `event.isTrusted`，`element.click()` 无效。→ 用 `webContents.sendInputEvent` 发真实鼠标事件，`will-navigate` 里 `preventDefault()` 收地址。100 章约 300ms。
3. **正文在静态 HTML 里被剥离**，`#nr1` 是空的，必须渲染后才出现。→ 首次解析失败自动切 `render`，并记住该站以后直接渲染。
4. **分页目录**是 `/indexlist/{id}/{page}/`，每页 100 章，最后一页不足 100 即结束。

## 工程上的坑（Electron on Windows）

- 启动 Electron 时环境里若带 `ELECTRON_RUN_AS_NODE=1`，进程会退化成纯 Node（`require('electron')` 为空）。`scripts/*.mjs` 里都做了删除。
- 命令行里**传空字符串参数**会让 Chromium 直接退出（`status=-1`）。`probe.mjs` 里已改为按需追加参数。
- **媒体代理必须用 `net.fetch`**（Chromium 网络栈，走系统代理）。Node 的 `fetch` 不走系统代理，
  在本机表现为播放器一直 `0:00`。
- **mp4 必须原样返回上游 Response**；把 `net.fetch` 的 body 重新包成 `new Response(stream)`
  会让 Chromium 报 `MEDIA_ERR_SRC_NOT_SUPPORTED`（code 4）。m3u8 分片则要重新包装以补 CORS。
- 隐藏窗口的 `loadURL` 可能被长连接拖住，渲染/采集要用 `Promise.race(loadURL, delay(...))`。

## 下一步

- [ ] 选源偏好引擎：分辨率 / 字幕语言 / 字幕组 / 数据源四层 DFS 自动选源（animeko `MediaSelector`）
- [ ] 订阅节流（`requestInterval`）与搜索缓存持久化（`searchCacheTtl`）
- [ ] 起点分类 / 排行榜分页与「查看更多」；起点付费章节的登录态复用
- [ ] 漫画：MYCOMIC Cloudflare 会话复用、图集分页缓存与预加载
- [ ] 剧集类型（SP/OVA）与多清晰度解析
- [x] 安卓端首版：原生 WebView + NativeAgg（HTTP/Cookie、隐藏 WebView、图片/媒体代理）
- [ ] 论坛（回帖走可见 WebView，v2 再做页面内代提交）
- [ ] 离线缓存、BT/Mikan、弹幕、WebDAV 同步
