# Git CI 与双端热更新方案

## 0. 当前实现（已确认的选项）

- 仓库：`https://github.com/wdzshz001/AIO`，main 已可 push。
- 发布策略：push main 只跑 CI 构建；`v*` tag 才创建 GitHub Release。
- 热更新范围：**先 Windows Web Bundle**；Android 本轮仍走 APK。
- 更新时机：启动只检查并提示，**用户在 设置→关于 手动点击检查更新**后下载并应用。
- 已实现：
  - CI workflow 的 `hot` job 在 tag 时生成 `hot-win.json` + 3 个资源
  - Windows 主进程 `hot-check` / `hot-apply`、overlay 加载、SHA256 校验、下次/立即 reload
  - 设置 About「检查更新」按钮
  - 启动时顶部 Toast 提示“发现新版本”
- 未实现：Android 热更新、自动下载并强制重启。

> 当前仓库：`https://github.com/wdzshz001/AIO`，`main` 已推送；CI 由该仓库的 Actions 执行。
> 本地调试可用 `AGG_HOT_BASE=http://127.0.0.1:8765` 指向静态服务。


---

## 1. 推荐方案：Web Bundle 热更新（少改动）

只热更新 **UI + adapters + core 打包出来的前端资源**：

```text
index.html
renderer.js
renderer.css
(Android 额外带 android-bridge.js)
```

阅读器、搜索、书源解析、自动换源、自动选源、播放器等都在这个 bundle 里。
原生壳、权限、HostBridge 方法、图片/媒体代理协议不在热更新范围；这些需要重装 EXE/APK。

### 为什么不用 electron-updater / 整包更新

- Windows 是 **portable 单 EXE**，electron-updater 对 portable 支持差，替换运行中的 EXE 也麻烦。
- Android 不能静默安装 APK，整包更新必须走系统安装器，不是“热更新”。
- Web Bundle 体积约 2.5 MB，下载快、回滚简单，适合自用。

### 1.1 CI 产物

只在 `v*` tag 上产出并发布：

```text
hot-win.json
hot-win-index.html
hot-win-renderer.js
hot-win-renderer.css
```

manifest 实际格式：

```json
{
  "version": "0.1.2",
  "builtAt": "2026-11-22T12:10:18.829Z",
  "files": {
    "index.html": "sha256...",
    "renderer.js": "sha256...",
    "renderer.css": "sha256..."
  }
}
```

- 发布到 GitHub Release assets（当前仓库公开），app 不需要 git clone。
- 客户端只请求：
  `https://github.com/wdzshz001/AIO/releases/latest/download/hot-win.json`

### 1.2 Windows 实现（已完成）

1. `userData/hot/win/<version>/` 保存已下载 bundle。
2. 启动时 `protocol.handle('agg')` 优先从 hot 目录读；没有则读 `__dirname`。
3. About 页手动「检查更新」：
   - 请求 `hot-win.json`，与 `current.json`/内置 `app.getVersion()` 比较
   - 逐个下载 3 个文件到临时目录，校验 SHA256
   - 原子写入 `hot/win/<version>/`，写 `current.json`
   - 700ms 后 `webContents.reload()`
4. 启动时只检查并在顶部 Toast 提示，不自动下载。
5. 校验失败/文件缺失自动用内置版本，不破坏启动。

实际改动：`main.ts` 的 `hot-check`/`hot-apply`、`preload.ts` 暴露方法、
`HostBridge` 可选类型、App 启动提示、About 检查按钮。没有引入 electron-updater。

### 1.3 Android 实现（未实现，后续可选）

当前 UI 从 `file:///android_asset/www/index.html` 加载。直接切到 `filesDir/hot` 会改变
localStorage origin，导致书架/设置丢失。

**推荐做法：单文件 HTML**

CI 把 `index.html + android-bridge.js + renderer.css + renderer.js` 内联成一个
`hot-android.html`。`MainActivity`：

1. 启动时检查 `filesDir/hot/current.html`，存在则：
   ```java
   webView.loadDataWithBaseURL(
     "file:///android_asset/www/", hotHtml, "text/html", "utf-8", null);
   ```
   base URL 保持 `android_asset/www/`，localStorage origin 不变。
2. 不存在则继续加载原 asset。
3. 后台用 OkHttp 下载 `hot-android.json` + HTML，校验 SHA256，原子替换。
4. 保留上一版本；失败回退。

一次性原生改动约 100–150 行 Java；之后前端/书源更新不再发 APK。

### 1.4 更新时机（已确认）

- 启动：静默检查；发现新版本只弹顶部 Toast，**不自动下载**。
- 用户：设置 → 关于 → 检查更新，手动下载并应用。
- 应用后 reload；失败保留旧版本。
- 版本显示：设置 → 关于 显示「壳版本（前端 hotVersion）」；重装更高版本 EXE 后会忽略旧热更新。
- 不做自动强制重启。

---

## 2. Android：不做热更新，走 APK 下载更新（已实现）

- 设置 → 关于 → 检查更新
- `NativeAgg.appUpdateCheck` 请求 Release 的 `android-latest.json`
- 版本大于 `BuildConfig.VERSION_NAME` 时，`DownloadManager` 下载
  `agg-reader-android.apk`
- 下载完成广播自动打开系统安装器（需要用户允许安装未知来源）
- APK 使用固定 debug 签名，本地/CI 可互相覆盖安装

再次强调：Android 原生壳/权限变化仍需新 APK；只有新的 APK 才能继续获得后续更新能力。

---

## 3. 备选方案：整包自动更新

| 端 | 方案 | 问题 |
|---|---|---|
| Windows | CI Release → 下载新 portable EXE → 外部 launcher 替换 | 运行中不能覆盖自身；portable 数据目录要处理；杀软/SmartScreen |
| Android | DownloadManager 下载 APK → `Intent` 安装 | 必须用户点安装；不是热更新 |

适合“壳/原生能力变了”的版本，不适合高频书源修复。建议保留手动下载新包，不做静默整包。

---

## 4. Git 连接方式

应用不直接连 Git，而是连 **CI 发布出来的静态资产**：

```text
git push tag v0.1.4
  -> GitHub Actions
    -> 构建 EXE/APK
    -> 构建 hot-win.*
    -> 上传 GitHub Release
  -> App 启动请求 releases/latest/download/hot-win.json
  -> 用户在设置中确认后下载/校验/覆盖 userData
```

好处：

- 不在客户端保存 Git 凭据
- CI 是唯一可信构建入口
- 版本、回滚、审计都在 Git/Release 里
- 不引入 electron-updater 等新依赖

当前仓库已配置并验证：

- Actions：`https://github.com/wdzshz001/AIO/actions`
- Release：`https://github.com/wdzshz001/AIO/releases`
- `v0.1.1` / `v0.1.2` / `v0.1.3` / `v0.1.4` / `v0.1.5` / `v0.1.6` / `v0.1.7` / `v0.1.8` / `v0.1.9` 已成功跑完双端 + hot + release
- `v0.1.2` 的 `hot-win.json` 可被客户端读取，实测检查/应用成功
- Android debug 签名已固定为 `apps/android/debug.keystore`，本地/CI 可覆盖安装

---

## 5. 当前已确认的决定

1. Git：`https://github.com/wdzshz001/AIO`，公开仓库。
2. 热更新范围：先 Windows Web Bundle；Android 暂走 APK（后续可加单文件 HTML）。
3. 发布：push main 只构建 artifact，`v*` tag 才发 Release。
4. 更新：启动只提示，设置里手动检查并应用。
5. Android 签名：当前 debug 签名自用；要 release 签名需在 CI 配置 keystore secrets。
6. 私有仓库：当前公开，可直接用 Release；若改私有，需换独立 public 发布源或静态存储。

