# 双端编译方案

本文是给下一次 AI/开发者直接照着执行的构建手册。当前两个端已经产出：

| 端 | 产物 | 技术栈 |
|---|---|---|
| Windows | `release/聚合阅读-0.3.1-portable.exe` | Electron 45 + React |
| Android | `release/agg-reader-0.3.1-android.apk` | 原生 Android WebView + Java 桥 |

---

## 一、公共部分

```bash
npm install
npm run check          # tsc
npm test               # core + settings + subscription
npm run build          # 构建 apps/desktop/dist
```

`packages/core`、`packages/adapters`、`packages/ui` 是两端共用的。任何一端的构建都必须先有
`apps/desktop/dist`（Android 的 `scripts/build-android.mjs` 也会先调用 `buildAll()`）。

---

## 二、Windows 免安装版

### 环境

- Windows 10/11 x64
- Node.js 20+
- 依赖已包含 `electron@45.4.1`、`electron-builder@26.0.12`

### 构建

```powershell
npm run dist:win
```

产物：

```text
release/聚合阅读-0.3.1-portable.exe
```

### 配置位置

`apps/desktop/package.json` 的 `build` 字段：

- `appId: com.agg.reader`
- `electronDist: ../../node_modules/electron/dist`：本机无法从 GitHub 下载 Electron 时走本地 Electron
- `win.signAndEditExecutable: false`：本机无符号链接权限，`winCodeSign` 的 darwin 符号链接解压失败；
  关闭后 NSIS portable 仍能生成带应用图标的 EXE
- `extraResources`: 把 `assets/app.ico` 复制到 `resources/app.ico`
- `files`: 只打包 `dist/**/*`（排除 sourcemap）和 `package.json`

### 便携数据

主进程 `apps/desktop/src/main.ts` 顶部：

- electron-builder portable 注入 `PORTABLE_EXECUTABLE_DIR`
- 检测到后把 `userData` / `sessionData` 指到 `EXE/../data`
- portable 模式下关闭开机启动项
- 托盘图标优先读 `process.resourcesPath/app.ico`

删除 `release/data` 可恢复干净状态。

### 坑

- 本会话环境有 `ELECTRON_RUN_AS_NODE=1` 时，直接启动打包 EXE 会当 Node 运行并秒退。
  启动验证前先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`。
- 修改 `apps/desktop/src/main.ts` 后必须重新 `npm run dist:win`，只 `npm run build` 不会更新 EXE。
- 未做代码签名，SmartScreen 会提示“更多信息 → 仍要运行”。

---

## 三、Android APK

### 已安装工具链（本机路径）

```text
JDK 21:       C:\za\android-tools\jdk-21.0.13.1+2
Android SDK:  C:\za\android-tools\android-sdk
  platform:   android-35
  build-tools:35.0.0
  platform-tools
Gradle:       C:\za\android-tools\gradle-8.10.2
```

### 构建

```powershell
$jdk = "C:\za\android-tools\jdk-21.0.13.1+2"
$sdk = "C:\za\android-tools\android-sdk"
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:PATH = "$jdk\bin;$sdk\platform-tools;$sdk\build-tools\35.0.0;C:\za\android-tools\gradle-8.10.2\bin;$env:PATH"

node scripts/build-android.mjs
gradle.bat -p apps/android :app:assembleDebug --no-daemon --console=plain
```

产物：

```text
apps/android/app/build/outputs/apk/debug/app-debug.apk
```

交付副本：

```text
release/agg-reader-0.3.1-android.apk
```

安装：

```powershell
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

### Android 工程结构

```text
apps/android/
  android-bridge.js                 window.agg 的 JS 注入层
  app/src/main/assets/www/          由 scripts/build-android.mjs 生成
  app/src/main/java/com/agg/reader/
    MainActivity.java               WebView、安全区、返回键、全屏视频
    NativeAgg.java                  HostBridge 的 Java 实现
    MediaProxy.java                 127.0.0.1 图片/视频/HLS 代理
    VerifyActivity.java             站点验证 WebView
  app/src/main/res/                 图标、主题、字符串
  gradle.properties                 SDK/代理/路径检查
```

### 签名

`apps/android/app/build.gradle` 的 `signingConfigs.aggDebug` 固定使用
`apps/android/debug.keystore`：

- alias: `androiddebugkey`
- store/key password: `android`
- 本地和 CI 同证书，APK 可互相覆盖安装
- 这是自用 debug 证书，不用于商店分发；要正式签名时替换成 CI secrets keystore

### Android 坑（下次直接照做）

1. **workspace 路径含中文**：AGP 会拒绝，`apps/android/gradle.properties` 必须有
   `android.overridePathCheck=true`。
2. **Gradle/Java 文件不要带 BOM**：PowerShell `Set-Content -Encoding UTF8` 会写 BOM，
   Groovy 报 `Unexpected character: '﻿'`。用 Node 写或 `UTF8Encoding($false)`。
3. Gradle 依赖下载需要代理：`gradle.properties` 里的
   `systemProp.http(s).proxyHost/Port`；换网络时按需改。
4. `assembleDebug` 用 `-p apps/android` 或在 `apps/android` 目录执行，不要从仓库根直接跑。
5. 改完 `packages/ui` 后必须先 `node scripts/build-android.mjs`，否则 APK 里还是旧前端。
6. 修改 `android-bridge.js` / Java 后只需重跑 Gradle；修改 UI/adapters 后重跑 assets + Gradle。
7. 模拟器测试：`emulator -avd agg -no-window -no-audio -gpu swiftshader_indirect`；
   WebView 调试用 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`。
8. 当前 APK 为 debug 签名，适合自用/侧载；release 签名尚未做。
9. 站点 Cookie 目前是全局 CookieManager，不是桌面端的分区隔离。

### 已确认可用 / 待真机

模拟器已验证：

- 首页、小说首页/详情、免费章节阅读
- 全局搜索
- 漫画首页/详情/多页原图阅读（本地代理 1080×1620）
- 返回键/安全区/移动布局

待真机：

- Bangumi 接口（当前模拟器网络超时）
- 动画选源后的视频播放/HLS
- 隐藏 WebView 的复杂 WAF 验证

---

## 四、GitHub Actions

`.github/workflows/build.yml`：

- push main / PR：构建 Windows portable 与 Android APK（只上传 artifact，不发布）
- `v*` tag：额外构建 `hot-win` bundle，并创建 GitHub Release
- Release 资产：
  - `agg-reader-portable.exe`
  - `agg-reader-android.apk`
  - `hot-win.json` / `hot-win-index.html` / `hot-win-renderer.js` / `hot-win-renderer.css`

本地热更新 bundle：

```bash
HOT_VERSION=0.1.1 npm run hot:win
```

产物为 `release/hot-win*`。Windows 端只覆盖 UI/adapters bundle；壳/原生改动仍需重新出 EXE。
详见 [HOT-UPDATE.md](HOT-UPDATE.md)。

---

## 五、每次改动后的推荐验证

```powershell
# 共用
npm run check
npm test

# Windows
npm run build
npm run dist:win
# 启动 EXE 验证（先移除 ELECTRON_RUN_AS_NODE）

# Android
node scripts/build-android.mjs
gradle.bat -p apps/android :app:assembleDebug --no-daemon
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```
