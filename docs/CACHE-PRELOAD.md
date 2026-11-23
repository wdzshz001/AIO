# 本地缓存与预加载方案

## 一、现状

当前已有但分散：

| 层 | 内容 | 生命周期 |
|---|---|---|
| `ctx.ts` HTML 缓存 | 单站点页面 HTML | 内存，TTL 可设 |
| 各站点 adapter | 章节正文/首页/详情 | 内存 10–30 分钟 |
| localStorage | 章节列表、书架、设置 | 持久 |
| Chromium/WebView | 图片/HLS 分片 | 看响应头，不可控 |
| 搜索/Bangumi | 结果列表 | 内存 |

问题：

- 章节正文/漫画图片列表重启即丢；
- 漫画图片滚动到时才请求；
- 小说虽然预取 HTML，但没有落到章节缓存；
- 动画下一集没有预热；
- 代理层没有显式的媒体磁盘缓存和容量上限。

## 二、已落地（0.1.6）

### 1. 内容缓存

`packages/ui/src/contentCache.ts`：

- IndexedDB `agg-content-cache`，双端 WebView 通用
- 只缓存小说正文与漫画章节元数据（视频 URL 有时效，不持久化）
- TTL 12 小时，最多 80 条
- 内存 L1 + IndexedDB L2
- 设置 → 存储与隐私 可查看条数/大小并清理

### 2. 预加载

- 小说：读完当前章后 800ms 预取下一章正文
- 漫画：按当前页预取前 1 页、后 6 页，2 并发，滚动到新页继续补
- 动画：播放开始后 1.5s 预取下一集页面，本次会话 10 分钟短缓存
- 只在当前章/集内容真正加载后触发，不阻塞首屏

### 3. 媒体缓存头

- 图片：`Cache-Control: public, max-age=604800, immutable`
- HLS 分片：`max-age=86400`
- 由 Chromium HTTP 缓存 / Android WebView 缓存落盘
- HLS playlist 仍然 `no-store`，避免拿到过期线路

## 三、建议的下一步

### P1：原生代理磁盘缓存（收益最大）

目标：不依赖 WebView 的 HTTP 缓存，页面自己可控。

- Windows：`apps/desktop/src/main.ts` 的 `aggmedia`
- Android：`MediaProxy.java`
- 只缓存：
  - `image/*`
  - HLS 分片 `.ts/.m4s`、key
  - 小于 8MB 的非视频响应
- 不缓存整段 MP4，避免 100MB+ 视频塞满磁盘
- key = sha256(url + referer + UA + cookie)
- 磁盘目录：
  - Windows `userData/media-cache`
  - Android `cacheDir/media-cache`
- 容量 256–512MB，LRU 淘汰；每 100 次写检查一次
- 启动/设置页显示占用，可单独清理
- 这样图片第二次打开、同一话回看、HLS 重播都直接命中磁盘

### P2：离线下载（按需）

- 漫画：整话图片预下载 + 离线标记
- 小说：整本正文缓存
- 动画：只缓存用户主动“缓存本集”的片段
- 独立下载管理页，不做全局自动缓存

### 不建议

- 全量缓存视频（存储和版权/隐私都不合适）
- 无限 IndexedDB 正文（移动端配额小）
- 预取所有漫画图片（首次流量和并发太大）

## 四、默认策略

- 首屏只取当前章/当前页
- 预取量有上限（漫画 6 页、小说 1 章、动画 1 集页面）
- 所有缓存有 TTL 和清理入口
- 失败不影响主流程，缓存坏了自动回退网络
