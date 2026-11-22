# Git CI 与双端热更新方案

## 0. 当前状态

- 仓库已 `git init` 并生成首个提交（本地）。
- `.github/workflows/build.yml` 已配置：
  - push / PR / tag 触发
  - Windows：`npm run dist:win` → portable EXE
  - Android：`build-android.mjs` + Gradle → debug APK
  - tag：把两个安装包上传到 GitHub Release
- 还没有远端地址和推送凭据，`git remote` 为空。

> 需要用户提供空的 Git 仓库地址（GitHub/Gitee/GitLab），以及是否公开。
> CI 不依赖远端即可先本地运行；推送后自动生效。

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

在 tag / main 上额外产出一个 release：

```text
hot-win.json
hot-win-index.html
hot-win-renderer.js
hot-win-renderer.css

hot-android.json
hot-android.html        # index + bridge + renderer.js + css 内联成单文件
```

manifest 示例：

```json
{
  "version": 12,
  "shellMin": 1,
  "sha256": {
    "renderer.js": "...",
    "renderer.css": "...",
    "index.html": "..."
  }
}
```

- 发布到 GitHub Release assets（公开仓库），app 不需要 git clone。
- 私有仓库不能在客户端放 token；私有仓库建议改用自建静态文件服务或 public release。

### 1.2 Windows 实现（约 100 行）

1. `userData/hot/win/<version>/` 保存下载的 bundle。
2. 启动时 `protocol.handle('agg')` 优先从 hot 目录读；没有则读 `__dirname`。
3. 窗口显示后异步请求 `hot-win.json`：
   - 版本大于本地、shellMin ≤ 当前 shell 版本
   - 下载文件到临时目录，校验 SHA256
   - 原子写入 `hot/win/<version>/`，写 `current.json`
4. 下次启动加载新版本；也可立即 `webContents.reload()`。
5. 保留上一版本，坏文件自动回退。

不改 `preload`、IPC、图片/媒体协议。

### 1.3 Android 实现（一次原生改动后即可）

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

### 1.4 更新时机

建议默认：

- 启动后 **静默检查 + 后台下载**
- 下一次启动应用；或下载完成时顶部 toast「内容已更新，重启后生效」
- 设置里可保留「检查更新」手动按钮（现有 About 页已有入口）

不要默认“立即强制重启”，会打断阅读。

---

## 2. 备选方案：整包自动更新

| 端 | 方案 | 问题 |
|---|---|---|
| Windows | CI Release → 下载新 portable EXE → 外部 launcher 替换 | 运行中不能覆盖自身；portable 数据目录要处理；杀软/SmartScreen |
| Android | DownloadManager 下载 APK → `Intent` 安装 | 必须用户点安装；不是热更新 |

适合“壳/原生能力变了”的版本，不适合高频书源修复。建议保留手动下载新包，不做静默整包。

---

## 3. Git 连接方式

应用不直接连 Git，而是连 **CI 发布出来的静态资产**：

```text
git push tag v0.1.1
  -> GitHub Actions
    -> 构建 EXE/APK
    -> 构建 hot-win.* / hot-android.*
    -> 上传 GitHub Release
  -> App 请求 releases/latest/download/hot-win.json
  -> 校验/覆盖 userData 或 filesDir
```

好处：

- 不在客户端保存 Git 凭据
- CI 是唯一可信构建入口
- 版本、回滚、审计都在 Git/Release 里
- 不引入 electron-updater 等新依赖

---

## 4. 需要确认的选择

1. **Git 服务与仓库地址**：GitHub / Gitee / GitLab？仓库是否公开？
2. **热更新范围**：
   - A. 先做 Windows Web Bundle（最快，原生零改动）
   - B. 双端都做（Android 需一次性改 `MainActivity` + 新增下载器）
3. **发布触发**：每次 push main 都发，还是只发 `v*` tag？
4. **更新时机**：静默下载 + 下次启动生效（推荐），还是下载完弹窗询问？
5. **Android 签名**：继续 debug 签名自用，还是 CI 用固定 keystore 签 release？
6. **私有仓库**：如果是私有仓库，热更新资产放哪里？建议单独 public release repo 或静态对象存储。

确认后按“先 Windows、再 Android 单文件 HTML”的顺序实现，改动面最小。
