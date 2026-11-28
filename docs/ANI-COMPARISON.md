# animeko（ani）对照分析与优化记录

> 2026-11-22。对象：本项目「聚合阅读」的小说 / 动画 / 漫画三个应用，对照 animeko。
> 结论：动画链路已按 ani 的「Bangumi 条目 → 单集 → 选源 → 播放」模型重构；小说补上书架续读与跨站换源。
> 验证：`tsc` 通过，core/subscription 单测通过，冒烟两条链路 `SMOKE OK`，动画 1920×1080 出画。

---

## 0. 先给结论

本项目原状是「站点中心」：搜索直接列各站结果，点进去就是某个站的详情页。ani 是「条目中心」：
搜索只列 Bangumi 条目，打开条目拿到剧集表，播放某一集时再去各数据源找这一集的资源。

这不是 UI 风格差异，而是数据模型差异，会连锁影响：封面、同名合并、换源、续播、剧集顺序、
多线路、失效源处理。本次把动画应用整体切到 ani 模型，并把订阅引擎缺的字段补齐。

| 能力 | 改造前 | 改造后 |
|---|---|---|
| 动画搜索 | 各站结果按标题合并，Bangumi 只补封面 | Bangumi 条目为主（9 条），站点直搜作为兜底与小说入口 |
| 作品身份 | 无，靠标题归一化 | Bangumi subjectId，全别名参与匹配 |
| 剧集 | 站点自己的章节列表，集号不解析 | Bangumi 剧集表 + EpisodeSort 跨源对齐 |
| 选源 | 无法选，只能返回换源 | 条目页按集并行查 20+ 源，列出可用线路并记忆上次选择 |
| 播放 | 单源播放，失败只能退出 | 续播（同集换源也续）、换源、自动连播（默认关） |
| 订阅解析 | 21 个源里 json-api 被跳过，部分选择器字段忽略 | 21/21 全部构建；补齐 15+ 字段 |
| 小说 | 书架 → 详情 → 再点继续 | 书架直达上次章节；详情页可跨站换源 |

---

## 1. 分析方法与版本

- **本地快照**：`_ref/ani`，`open-ani/ani` 2024-09 的浅克隆（2566 个文件）。用于读领域模型、
  数据源契约、播放器与用户流程。
- **最新源码**：本机 git 连 GitHub 被重置，但 `raw.githubusercontent.com` 可用，按需拉了
  animeko **6.4.1** 的关键文件到 `_ref/ani-6.4.1/`（选择器引擎、订阅配置、匹配算法、Bangumi 模型）。
- **线上订阅**：`https://sub.creamycake.org/v1/css1.json`，`schemaVersion: 2`，
  **21 个源：20 个 `web-selector` + 1 个 `json-api`**，保存在 `_ref/subscription.json`。
- **本项目基线**：改造前 `tsc` 通过；动画链路能播非凡/百度，但订阅源大量 0 结果；小说链路可用。

> 版本注意：本地 2024-09 快照**还没有**订阅 / `web-selector` / `json-api` 这一层，
> 数据源是硬编码 Kotlin 类 + SPI。选择器字段与匹配算法以 6.4.1 为准；
> 领域模型、选源思想、播放器流程在旧快照里已经稳定，两者可以互相印证。

---

## 2. ani 的核心设计（标准答案）

### 2.1 三层模型：条目 / 剧集 / 资源

| 层 | 类型 | 关键字段 |
|---|---|---|
| 条目 | `SubjectInfo` | `subjectId`、`name`、`nameCn`、`aliases`/`allNames`、`summary`、`airDate`、`tags`、`ratingInfo` |
| 剧集 | `EpisodeInfo` | `id`、`type`、`sort`（系列内集数）、`ep`（季度内集数）、`name`/`nameCn`、`airDate` |
| 资源 | `Media` | `mediaId`、`mediaSourceId`、`originalUrl`、`download`、`episodeRange`、`properties`、`kind` |

关键约束：

- **数据源不提供条目**。`MediaSource.fetch(MediaFetchRequest)` 的请求里带
  `subjectId`、`subjectNames`、`episodeSort`、`episodeEp`、`episodeName`，
  源只负责「找这一集的资源」。
- **`mediaId` 全局唯一**，通常编码来源与线路，避免多源同资源在 UI 里冲突。
- 集号是值对象 `EpisodeSort`：`Normal(1)`、`Normal(1.5)`、`Special(SP, 1)`、`Unknown(raw)`，
  `Normal < Special < Unknown`。`.5` 合法，`SP/OP/ED/PV/MAD/OVA/OAD` 是特殊集。
- 覆盖关系由 `EpisodeRange.single(x).contains(y)` 表达：特殊集允许只按数字匹配（`SP01` ↔ `01`）。

### 2.2 三段取数：搜索 → 条目页 → 播放页

`web-selector` 的配置就是这三段的声明：

1. **搜索条目**：`subjectFormatId` ∈ `a` / `indexed` / `json-path-indexed`，
   `searchUrl` 里的 `{keyword}` 由「去特殊字符 + 取首词」归一化后填入。
2. **条目页剧集**：`channelFormatId` ∈ `index-grouped` / `no-channel`。
   - 线路名与播放列表按下标一一对应；
   - 集名元素与链接元素可以分开配置（`selectEpisodesFromList` / `selectEpisodeLinksFromList`）；
   - 集号用 `matchEpisodeSortFromName` 正则从标题里取 `(?<ep>...)`；
   - 纯画质标签（「正片」「HD高清国语版」）视为第 1 集。
3. **播放地址**：`matchVideo.matchVideoUrl` 用命名组 `(?<v>...)` 取真实地址；
   `matchNestedUrl` 命中时先打开嵌套播放页；`scanDomMediaUrls` / `scanInlineScriptUrls`
   再从 DOM、`performance` 资源与内联脚本里兜底。播放请求带 `addHeadersToVideo` 的
   Referer / UA 与 `cookies`。

### 2.3 匹配：归一化 + 80% 相似度 + 集号

- 标题先做 `removeSpecials`：去标点、中文数字转阿拉伯数字、删「剧场版/OVA」等标记词（**只在搜索关键词阶段删**，
  匹配阶段保留，见 ani #1794），再 `contains` 或 Levenshtein ≥ 80%。
- 条目名要全部参与：中文名、原名、infobox 别名；多季作品还会用「去季度后缀的基础名」做回退关键词。
- 集号匹配优先级：`episodeSort` → 特殊集名 → `episodeEp`；都没有时才按序号退化。
- 同一集出现在多条线路时，按线路阶级 `channelTiers` 选最优线路。

### 2.4 选源：过滤 + 排序 + 四层偏好

ani 的 `MediaSelector` 不是「第一个能播的」，而是：

- **过滤**：本地缓存永远保留；完结番隐藏 BT 单集；无字幕资源按设置过滤；平台不支持的
  字幕类型过滤。
- **排序**：字幕类型（硬字幕优先）→ 下载代价（本地 < 局域网 < 在线）→ 发布时间（新优先）。
- **自动选择**：按「分辨率 → 字幕语言 → 字幕组 → 数据源」四层 DFS，逐层回退；
  原则是「不能为了 4K 牺牲字幕语言」。
- **记忆**：用户选一次会同时记住字幕组、分辨率、数据源与字幕语言，下次同条目优先。

### 2.5 用户流程与进度

- 搜索 → 条目 → 选集 → 选源/自动选 → 播放。
- 播放到 90% 自动标记看过（5 秒采样、仅播放中判定、最多重试 5 次）。
- 自动连播默认**关**；跳过 OP/ED 依赖播放器章节信息。
- 进度：旧版是 Bangumi 的 per-episode watched 布尔；新版本地有更细的集级记录。
- 「我的」= 追番（5 种收藏类型）+ 账号两页，不做成一个大杂烩。

---

## 3. 本项目原状（改造前）

### 3.1 动画

- `Site.search()` 直接返回各站搜索结果；`SearchPage` 用标题归一化合并，Bangumi 只补封面。
- `Site.detail()` 把条目页所有线路的剧集拍平成一个 `Chapter[]`，不解析集号、不保留线路。
- 播放：点某一章 → 打开该章播放页 → 隐藏窗口嗅探 m3u8/mp4。
- 没有条目页、没有单集选源、没有换源、没有续播与连播。
- 订阅引擎只认 `web-selector`；`json-api` 直接跳过；`baseUrl` 取 `searchUrl` 的 origin，
  导致 girigiri（搜索在 m3u8 域、详情在 bg 域）0 结果；`matchEpisodeSortFromName`、
  `selectEpisodeLinks*`、`rawBaseUrl`、`userAgent`、`cookies`、DOM/脚本扫描全部未实现。

### 3.2 小说

- 搜索/详情/目录/阅读链路完整，69书吧的 ALTCHA、JS 点击目录、正文剥离都处理了。
- 书架只记录到「哪一章」，点书架先回详情页再点「继续阅读」。
- 没有跨站换源。

### 3.3 数据访问

`fetch` / `render` / `harvest` / `submit` / `capture` / `verify` 六种能力已经很强，
其中 `capture` 已经相当于 ani 的 `WebVideoMatcher`，但缺少 UA/Cookie/脚本扫描与嵌套页加载。

---

## 4. 差距清单（按 ani 标准）

| # | 维度 | ani | 本项目旧 | 影响 | 本次处理 |
|---|---|---|---|---|---|
| 1 | 作品身份 | Bangumi subject | 站点 URL / 标题 | 同名、换源、续播全无根 | ✅ 条目页 + subjectId 历史 |
| 2 | 搜索 | 条目搜索为主 | 站点结果合并 | 封面/集数/排序不可靠 | ✅ Bangumi 优先，站点直搜兜底 |
| 3 | 集号 | EpisodeSort/Range | 字符串标题 | 跨源对不上集 | ✅ 移植 EpisodeSort |
| 4 | 订阅解析 | 完整 selector/json-api | 子集 | 大量源 0 结果 | ✅ 21/21 + 15 字段 |
| 5 | 匹配 | 全别名 + 80% + 回退词 | 简单归一化包含 | 搜不到/错配 | ✅ 全别名 + 去季后缀回退 |
| 6 | 选源 | 过滤/排序/四层 DFS/记忆 | 无 | 只能回退换源 | ◐ 列出并排序可用源 + 记忆；DFS 待做 |
| 7 | 播放 | 续播、连播、换源 | 每次从头 | 体验断裂 | ✅ 续播（跨源按集号）、连播、换源 |
| 8 | 历史 | 收藏 + 集级状态 | 单条 URL | 换源丢历史 | ✅ 按 subjectId 归并 |
| 9 | 首页 | 放送表/热门 | 仅资源站 | 动画首页空 | ✅ 热度/本季推荐/时间表 + 起点推荐/分类/排行 |
| 10 | 弹幕/缓存/BT | 完整 | 无 | — | ⏳ 未做 |
| 11 | 多清晰度 | MediaProperties | 单地址 | — | ⏳ 未做 |

---

## 5. 已实施的优化

### 5.1 core：ani 原语的移植

新增：

- `packages/core/src/episode.ts`
  - `parseEpisodeSort` / `formatEpisodeSort` / `compareEpisodeSort` / `episodeSortKey`
  - `episodeSortContains`（特殊集按数字匹配）
  - `matchEpisodeSortFromName`（`(?<ep>)` 命名组；空模式=整个标题）
  - `convertSpecialEpisode`（正片/高清版/1080P → 第 1 集）
  - `matchingEpisodeSortOf`（只有画质语言标签的整部作品 → 第 1 集）
- `packages/core/src/match.ts`
  - `removeSpecials`（标点、中文/罗马数字、标记词）
  - `normalizeTitle` / `titleMatchScore`（Levenshtein，0..100）
  - `matchesAnyTitle` / `pickBestTitle`（80% 阈值 + `preferShorterName`）
- `packages/core/src/media.ts`
  - `videoKindOf`：`.mp4/.m4v/...` → mp4，其余按 HLS（无扩展名的 m3u8 常见）

### 5.2 Bangumi 客户端

`packages/adapters/src/bangumi.ts` 重写：

- `searchBangumi`：`POST /v0/search/subjects`（`filter.type=[2]`），失败回退旧版
  `GET /search/subject/{kw}`。
- `getBangumiSubject`：v0 详情，提取 `name_cn`、`summary`、`images`、`rating`、`tags`、
  `infobox` 里的「别名/中文名」。
- `getBangumiEpisodes`：`/v0/episodes?subject_id=&type=0`，自动翻页，输出 `sort`/`ep`/`name_cn`/`air_date`。
- `getBangumiCalendar`：`/calendar`，供动画首页「今日新番」。
- `matchSubject`：改为 `pickBestTitle` + 全别名。

### 5.3 订阅引擎对齐 6.4.1

`config.ts` 补齐：`tags`、`tier`、`channelTiers`、`userAgent`、`headers`、`requestInterval`、
`searchCacheTtl`、`autoMatch`（含旧版平铺字段兼容）、`selectMedia`、`onlySupportsPlayers`、
`defaultResolution`、`defaultSubtitleLanguage`、`linkTemplate`、`selectEpisodeLinks(FromList)`、
`matchEpisodeSortFromName`、`matchVideo.scanDomMediaUrls/scanInlineScriptUrls`、
`addHeadersToVideo.userAgent`，以及 json-api 的 `search/subject/play` 三段配置。

`engine.ts` / `format.ts` 修复：

- **`rawBaseUrl` 优先**作为详情页基准（girigiri 的 `/GV1091/` 必须拼在 `bg.girigirilove.com`）。
- 条目链接支持 `linkTemplate`（`/GV{value}/`、`/voddetail/{value}.html`、`/vod-detail/{value}/`）。
- 线路格式：线路名与列表按下标 zip；`matchChannelName` 的 `(?<ch>)`；支持独立的链接选择器
  （嘀哩嘀哩的 `a span` + `a` 这种结构）。
- 集号：`matchEpisodeSortFromName` → `convertSpecialEpisode`；`Chapter` 增加 `sort/channel/order`。
- 标题：`<h1>` → `og:title` → `<title>`（去掉站点后缀），修复「标题变成 URL」。
- 播放：UA / Cookie / Referer、嵌套页、DOM 扫描、内联脚本扫描全部透传。
- `json-api` 工厂：模板化 URL/body/headers、JSONPath 取搜索结果、条目/剧集/播放候选三段调用，
  剧集 URL 自描述（模板反解 id），方便缓存后直接播放。

### 5.4 动画条目流程（核心）

新增 `packages/adapters/src/anime/catalog.ts`：

- `subjectKeywords`：中文名 → 原名 → 别名 → **去季度后缀的基础名**，去重后取 2~5 个。
- `resolveSourceDetail`：逐关键词搜索源站 → 80% 标题匹配 → 拉条目页 → 缓存 10 分钟（按 site+subject）。
- `resolveEpisodeOnSite`：按 `episodeSort → episodeEp → 特殊集名 → 序号` 找集；
  多条线路命中时按 `channelTiers` 选最优；**播放列表只保留同线路**，上一集/下一集不跨线。
- `findEpisodeSources`：并发 6，单源 60s 超时，逐源回调；按 `tier → 匹配分 → 标题短` 排序。

UI：

- `SearchPage`：动画条目区（Bangumi）+ 小说结果 + 「源站直搜」折叠区；分类计数。
- `SubjectPage`：封面/原名/评分/标签/简介、剧集网格（已看标记、当前集）、
  「继续观看」、选集后弹出的选源面板（进度、线路、耗时、失败原因、验证入口、重新匹配）。
- `App`：新增 `subject` 路由；播放路由带 `subjectId/subjectEpisodeSort`；返回时自动重开该集选源。
- 选源偏好：`agg.preferredSource.v1`，同条目优先上次的源。

### 5.5 播放器与代理

- 新增 `VideoInfo.userAgent/cookies`；`aggmedia://` 代理参数增加 `ua/ck`。
- 主进程媒体代理改用 **`net.fetch`**（Chromium 网络栈，走系统代理）。
  原来的 Node `fetch` 不走系统代理，是本机「播放器一直 0:00」的根因。
- **mp4 直接返回上游 Response**：重新包装 `new Response(stream)` 会让 Chromium 媒体加载器报
  `MEDIA_ERR_SRC_NOT_SUPPORTED`（code 4）；HLS 分片仍补 CORS 后流式透传。
- 播放页：`loadedmetadata` 后 seek 到续播位置；`timeupdate` 每 4 秒持久化；播完可自动下一集
  （默认关，设置里可开）。
- 播放失败自动回退：代理 → 代理 + 缓存参数重试 → mp4 直连；避免 CDN 偶发不完整 Range
  或 Chromium 坏缓存导致黑屏。
- 播放失败显示 `video.error` code；HLS 错误同时写 `data-hls-state`。

### 5.6 小说应用：起点默认书源

- 新增 `qidian.ts`：走移动端 `m.qidian.com`（桌面站有 JS 挑战），静态页即可解析
  - 首页推荐、13 个分类、9 个排行榜；
  - 详情 meta（书名/作者/封面/简介/状态）、完整目录、正文；
  - 目录以「第一章」定位完整列表（首条是最新章），按 DOM 顺序保留章节顺序；
    标题去掉「免费/VIP」后缀；付费章节标 `Chapter.locked`，正文检测到「登录订阅本章」时提示换源。
- 小说首页改为起点「推荐 / 分类 / 排行」三模块；推荐含限时免费/新书抢鲜/畅销完本（各 20 本），
  每栏有「更多」；排行 9 个榜单（各 20 本，主榜页 5 本 + 榜单页补全）；分类 13 类。
- 点书默认书源为起点；详情页「换源」按标题并发搜索天天看小说 / 69书吧 / 同人小说网，列出同名作品一键切换。
- 动画/小说/漫画应用页内都有搜索栏，进入搜索页时默认只勾选本应用分类（小说 / 动画 / 漫画）。

### 5.8 漫画应用

- 新增 CloudWN 漫画、MYCOMIC、拷贝漫画三个 `comic` 源，以及漫画聚合首页、搜索分类、长图阅读器。
- `ChapterContent.images` 承载漫画页；图片统一经 `aggmedia` 代理补 Referer/UA。
- CloudWN：图集按 12 张/页分页，阅读时抓齐全部分页（一个图集 = 一部作品）。
- MYCOMIC：JSON-LD 详情 + `x-data` 章节数组 + `biccam.com/chapters/...` 图片；
  当前网络被 Cloudflare 403 拦截，应用内提供验证入口。
- 拷贝漫画：独立 API 镜像域 + `Version/Region/platform` 请求头；`comic2` 详情、
  `group/default/chapters` 目录、`chapter/{uuid}` 图片。
- 设置新增「飞行模式」：开启显示全部源，关闭隐藏被标记源；逐源 NSFW 标记收在旁边的图标三级页。
- 书架点击：有章节缓存且记录到具体章节时**直接进阅读器**，否则回详情。
- 书架按 `subjectId`（动画）/ URL（小说）归并；动画换源不丢历史。
- 动画集「看过」要求真正播放过（有位置），打开选集页不算。

### 5.7 首页

- **动画**：热度榜（Bangumi 全站 heat）、本季推荐（当前季度 air_date + heat）、
  新番时间表（周一至周日）。点卡片直接进条目页。
- **小说**：起点推荐 / 分类 / 排行；排行含月票、畅销、阅读、书友、推荐、更新、签约、新书、新人。
- 移除非凡资源 / 百度资源两个静态资源站；动画首页与播放源完全由订阅 + Bangumi 条目支撑。

---

## 6. 验证

### 6.1 静态与单测

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json   # 0 error
node scripts/test-core.mjs                              # core tests OK
node scripts/test-subscription.mjs                      # 21 sources built
```

- core：集号解析/特殊集/正片、跨源包含、中文数字与标记词归一化、80% 匹配。
- subscription：21/21 构建；girigiri 的 `baseUrl` 为 `https://bg.girigirilove.com`；
  json-path 与 json-api 源均识别；关键词归一化与 JSONPath 断言。

### 6.2 冒烟（真实窗口 + 真站点）

`_probe/ani-opt-6/`（小说应用）与 `_probe/ani-opt-anime-app/`（动画应用）：

- 搜索「孤独摇滚」：**9 个 Bangumi 条目 + 12 条站点结果**；分类 `动画条目 9` / `小说 11`。
- 条目页：12 集，集名来自 Bangumi。
- 动画首页：热度榜 18、本季推荐、新番时间表；点命运石之门 → 24 集 → 4 个源 → 1920×1080。
- 小说首页：起点推荐（每栏 20 本，更多 22 本）/ 分类（25 本）/ 排行（9 个榜单 × 20 本）。
- 应用内搜索：小说分类 46 条、动画分类 10 条，默认分类勾选正确。
- 起点书籍：目录 213 章、第 1 章 121 段、下一章第 2 章，标题无「免费」后缀。
- 第 1 集选源：**4~7 个源命中**（girigiri、稀饭、森之屋、叽哔等），失败源给出原因。
- 点击 girigiri 源：**1920×1080 出画，播放 17 秒**；日志出现「从 0:04 续播」。
- 动画应用首页 → 柯南条目（1000 集）→ HLS（`playlist.m3u8`）播放 1920×1080。
- 小说链路：目录 300 章、阅读 86 段、下一章正常。
- 结论：两条链路 `SMOKE OK`。

截图：`09-search-subject.png`、`09-search-sources.png`、`09-search-video.png`、`02-site.png`、
`03-app-book.png`、`03-app-reader.png`。

### 6.3 已知环境问题

- 控制台仍有 Electron 的 CSP 警告（index.html 没有 CSP；不影响功能）。
- Cloudflare 源仍需用户点「验证」；`verifySite` 只负责打开窗口，是否通过由 Cookie/标题判断。
- 订阅源限流时部分源会 0 结果；`requestInterval` 目前未在客户端强制节流（见 §7）。

---

## 7. 与 ani 仍存在的差距 / 后续路线

按优先级：

1. **选源偏好引擎**：把分辨率 / 字幕语言 / 字幕组 / 数据源四层 DFS、过滤规则与自动选择
   抽成纯函数（ani 的 `MediaSelector` + `MediaSelectorFilterSortAlgorithm`）。
   当前只按 tier/分数排序，且需要用户手动点。
2. **订阅节流与缓存**：`requestInterval`、`searchCacheTtl` 尚未落地；搜索缓存按内存 10 分钟，
   没有持久化；高频换集会重复请求。
3. **多清晰度/多线路**：同一集的多线路已经能选，但同一线路的多清晰度（`MediaProperties.resolution`）
   没有解析；订阅里的 `defaultResolution` 只展示。
4. **Bangumi 账号与收藏同步**：目前只有本地历史；没有 OAuth、收藏类型、集级 watched 同步。
5. **缓存/下载/BT**：ani 的 `MediaCacheManager`、BT 源、Mikan 索引都未做。
6. **弹幕**：未做。
7. **跳过 OP/ED**：未做（依赖播放器章节信息）。
8. **特殊集展示**：Bangumi 只取 `type=0`；SP/OVA/OP/ED 未进剧集表。
9. **平台能力表**：`onlySupportsPlayers` 现在对桌面端一律放行（hls.js/Chromium），
   没有按播放器能力过滤。
10. **起点体验**：分类页没有分页 API（`?page=2` 返回同一页），排行榜更多页为 20 本；
    付费章节只做提示换源，未做登录态/购买同步；页面使用哈希类名，起点改版需要更新选择器。
11. **安卓端**：仍是计划（Capacitor + Kotlin 桥），TS 层可复用。

---

## 8. 设计取舍

- **保留 `Site` 抽象，不照搬 `MediaSource`**：现有六种取数通道（fetch/render/harvest/submit/capture/verify）
  已经解决了 ani 在桌面端要单独实现的 WebView/网络层，重写收益低。新增的是 `Site.autoMatch`、
  `sourceTier`、`channelTiers` 等元数据，以及 `Chapter.sort/channel`。
- **小说不强行套 Subject**：小说没有 Bangumi 条目体系，跨站换源用「标题匹配」即可；
  阅读进度用 URL + 章节，书架直达。
- **自动连播默认关**：与 ani 的 `autoPlayNext=false` 一致，设置里可开。
- **历史按 subjectId 归并**：换源/换线路不产生多条历史；小说仍按 URL。
- **`json-api` 用自描述 URL**（模板反解 id）：不依赖内存 Map，章节缓存/跨重启后仍可播放。

---

## 附录 A：关键文件

```
packages/core/src/episode.ts         EpisodeSort / 集号解析 / 范围包含
packages/core/src/match.ts           标题归一化 / Levenshtein 匹配
packages/core/src/media.ts           videoKindOf
packages/adapters/src/bangumi.ts     Bangumi v0 客户端
packages/adapters/src/subscription/config.ts   订阅 schema（6.4.1 对齐）
packages/adapters/src/subscription/format.ts   条目/线路/剧集解析
packages/adapters/src/subscription/engine.ts   web-selector 工厂
packages/adapters/src/subscription/jsonapi.ts  json-api 工厂
packages/adapters/src/sites/qidian.ts  起点（推荐/分类/排行/详情/目录/正文）
packages/adapters/src/anime/catalog.ts         条目 → 源 → 单集
packages/ui/src/pages/AnimeHome.tsx           热度 / 本季推荐 / 新番时间表
packages/ui/src/pages/NovelHome.tsx           起点推荐 / 分类 / 排行
packages/ui/src/pages/SubjectPage.tsx          条目页 + 选源面板
packages/ui/src/pages/SearchPage.tsx           Bangumi 优先搜索
packages/ui/src/pages/Reader.tsx               续播 / 连播 / 换源
packages/ui/src/pages/BookPage.tsx             详情页 + 跨站换源
apps/desktop/src/main.ts                       request / capture / aggmedia 代理
```

## 附录 B：订阅字段对照（本次补齐）

| 字段 | 旧 | 新 | 用途 |
|---|---|---|---|
| `rawBaseUrl` | 用 `searchUrl` 的 origin | 优先 | girigiri 等跨域详情页 |
| `subjectFormatId=json-path-indexed` | 部分支持 | 完整 | 2k/Anime7/girigiri 搜索 |
| `selectorSubjectFormat*.linkTemplate` | 无 | 有 | 裸 id → 详情 URL |
| `channelFormatId` | 默认 index-grouped | 按配置 | `no-channel`（影视森林） |
| `matchChannelName` | 忽略 | 有 | 线路名归一化 |
| `selectEpisodeLinks(FromList)` | 忽略 | 有 | 名称与链接不同元素 |
| `matchEpisodeSortFromName` | 忽略 | 有 | 集号/排序/跨源匹配 |
| `selectMedia` | 忽略 | 记录 | 展示/换源 |
| `autoMatch.*` | 忽略 | 有 | 关键词数/首词/去特殊/长短名 |
| `tier` / `channelTiers` | 无 | 有 | 源与线路优先级 |
| `userAgent` / `headers` | 无 | 有 | 接口/播放请求 |
| `matchVideo.cookies` | 忽略 | 有 | 画质 Cookie |
| `matchVideo.addHeadersToVideo.userAgent` | 忽略 | 有 | 播放 UA |
| `scanDomMediaUrls` / `scanInlineScriptUrls` | 忽略 | 有 | 抓不到请求时兜底 |
| json-api `search/subject/play` | 整源跳过 | 完整 | 稀饭 Next |

## 附录 C：复现命令

```bash
npm run check
node scripts/test-core.mjs
node scripts/test-subscription.mjs
AGG_SMOKE_QUERY=孤独摇滚 npm run smoke
AGG_SMOKE_INDEX=1 AGG_SMOKE_QUERY=孤独摇滚 npm run smoke   # 动画应用首页
```
