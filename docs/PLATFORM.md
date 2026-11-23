# Windows / Android 双端架构差异与修改影响范围

## 一、总体结构

```text
packages/core       类型、DOM、HTTP 契约、HostBridge 接口      ← 双端共用
packages/adapters   站点解析、订阅、搜索、B站条目             ← 双端共用
packages/ui         React 页面、设置、阅读器                  ← 双端共用
apps/desktop        Electron 主进程 + preload                 ← Windows 专属
apps/android        原生 WebView + Java HostBridge            ← Android 专属
```

UI 只依赖 `window.agg`（`HostBridge`），不知道当前是 Electron 还是 Android。

```text
core/types.ts  HostBridge:
  fetchHtml / request / renderHtml / harvestLinks
  submitForm / captureMedia / verifySite
  appInfo / openWindow / openExternal / clearSiteData
  proxyInfo / setNetworkConfig / setTray / setLoginItem
```

---

## 二、两端对应实现

| 能力 | Windows / Electron | Android |
|---|---|---|
| UI 容器 | `BrowserWindow` | `Activity` + `WebView` |
| UI 加载 | 自定义 `agg://` 协议 | `file:///android_asset/www/index.html` |
| JS 桥 | `preload.cjs` → IPC | `@JavascriptInterface NativeAgg` |
| HTTP | `session.fetch` / `net.fetch` | OkHttp |
| Cookie | 每站点独立 `persist:site-*` session | 全局 `CookieManager` |
| 隐藏页面渲染 | 隐藏 `BrowserWindow` | 隐藏 `WebView` |
| 表单提交 | 页面内表单提交 | OkHttp FormBody（简单表单） |
| 媒体嗅探 | `captureMedia` + WebRequest | 隐藏 WebView `shouldInterceptRequest` |
| 图片代理 | `aggmedia://stream` 自定义协议 | `http://127.0.0.1:<port>/?u=...` 本地 HTTP |
| 视频/HLS | Chromium 原生 + `aggmedia` 重写 m3u8 | WebView `<video>` + hls.js + 本地代理重写 m3u8 |
| 验证窗口 | 可见 BrowserWindow | `VerifyActivity` |
| 系统集成 | 托盘、开机启动、系统代理 | 无托盘；返回键 + 安全区 |
| 打包 | electron-builder portable EXE | Gradle debug APK |

### 图片/视频代理差异

桌面：

```text
UI -> aggmedia://stream/?u=...&r=... 
    -> Electron protocol.handle('aggmedia')
    -> Chromium net.fetch（系统代理）
```

Android：

```text
UI -> window.agg.proxyUrl(...) -> http://127.0.0.1:port/?u=...&r=...
    -> MediaProxy（ServerSocket + OkHttp）
    -> 图片直接流式返回；MP4 支持 Range；m3u8 重写分片/Key
```

这就是为什么 `packages/adapters/src/image.ts` 和
`packages/ui/src/components/VideoPlayer.tsx` 里都有一层
`platform === 'android' ? proxyUrl(...) : aggmedia://...` 分支。

---

## 三、修改内容的影响范围

| 修改位置 | 影响 | 需要重跑 |
|---|---|---|
| `packages/core/types.ts` HostBridge | 双端接口契约；两端必须同步实现 | `npm run check`、两端构建 |
| `packages/core/dom.ts` / `ctx.ts` | 双端解析与缓存行为 | `npm test`、两端构建 |
| `packages/adapters/**` 站点解析 | 双端所有源；可能影响搜索/详情/正文 | `npm test`、桌面冒烟、Android 冒烟 |
| `packages/ui/**` 页面/样式 | 双端 UI；Android 还要重新生成 assets | `npm run build`、`node scripts/build-android.mjs`、APK |
| `packages/ui` 中新增 `bridge.xxx` | Android 必须在 `android-bridge.js` + `NativeAgg` 同步实现；Windows 在 preload/IPC 实现 | 双端 |
| `apps/desktop/src/main.ts` / `preload.ts` | 仅 Windows；协议、窗口、代理、系统集成 | `npm run dist:win` |
| `apps/desktop/package.json` build 配置 | 仅 Windows 打包 | `npm run dist:win` |
| `apps/android/**` Java/Manifest/Gradle | 仅 Android；桥能力/权限/播放器 | `gradle :app:assembleDebug` |
| `apps/android/android-bridge.js` | Android 的 `window.agg`；不改 TS 类型时也需保持返回结构一致 | assets + APK |
| `scripts/build.mjs` | 双端构建产物 | 双端 |
| `scripts/build-android.mjs` | 仅 Android assets | APK |
| `release/**` | 交付物；构建会覆盖 | 重新打包 |

### 改动前判断口诀

1. **只在 `apps/desktop`**：Windows 专属，不影响 Android。
2. **只在 `apps/android`**：Android 专属，不影响 Windows。
3. **在 `packages/**`**：双端共用，必须在两端分别验证。
4. **新增 HostBridge 方法**：先改 `core/types.ts`，再同时补
   `preload.ts` + `main.ts`（Windows）和 `android-bridge.js` + `NativeAgg.java`（Android）。
5. **改图片/视频地址生成**：同时检查 `image.ts`、`VideoPlayer.tsx` 和
   `MediaProxy.java`（Android）与 `main.ts` 的 `aggmedia`（Windows）。

---

## 四、能力/限制差异

| 能力 | Windows | Android |
|---|---|---|
| 小说/漫画 | 完整 | 已跑通 |
| 搜索 | 完整 | 已跑通 |
| 动画 Bangumi 条目 | 完整 | 代码已接；当前模拟器网络超时 |
| 动画播放 | 完整 | 桥/播放器已写，待真机验证 |
| 站点 Cookie 隔离 | 按站点分区 | 全局 CookieManager |
| 隐藏 WebView WAF | 桌面 Chromium | Android WebView，兼容性较弱 |
| 系统代理 | 跟随系统 | 无系统代理设置 |
| 开机启动/托盘 | 支持 | 不支持 |
| 安装包 | portable EXE | debug-signed APK |

---

## 五、当前功能相关文件

- 起点 VIP/APP 自动换源：`packages/ui/src/App.tsx`（`autoSwitchQidian`）
- 阅读器锁章检测/换源回调：`packages/ui/src/pages/Reader.tsx`
- 顶部 Toast：`App.tsx` 的 `toastNode` + `.app-toast` 样式
- 动画选集自动选源：`packages/ui/src/pages/SubjectPage.tsx`（`playEpisode`）
- 视频自动播放：`packages/ui/src/components/VideoPlayer.tsx`（`autoPlay`）
- 内容缓存：`packages/ui/src/contentCache.ts`（IndexedDB，双端共用）
- 预加载：`packages/ui/src/preload.ts`（漫画图片）+ `Reader.tsx`（下一章/下一集）
- 媒体缓存头：`apps/desktop/src/main.ts`（aggmedia）与 `apps/android/.../MediaProxy.java`
- 漫画 NSFW 默认值：`packages/adapters/src/sites/mangacopy.ts`（`nsfw: false`）
