# Android 壳

当前是 **原生 WebView + JS NativeAgg 桥**，不是 Capacitor，目的是先快速跑通。

## 结构

- `app/src/main/assets/www/`：由 `node scripts/build-android.mjs` 从 `packages/ui` 构建并注入
  `android-bridge.js`
- `MainActivity`：WebView 容器、系统栏 Insets、返回键、全屏视频
- `NativeAgg`：`window.agg` 的 Java 实现
  - `fetchHtml` / `request` / `submitForm`：OkHttp，共用 CookieManager
  - `renderHtml` / `harvestLinks`：隐藏 WebView
  - `captureMedia`：隐藏 WebView 拦截媒体请求
  - `verifySite`：`VerifyActivity` 可见验证窗口
- `MediaProxy`：`127.0.0.1` 本地 HTTP 代理，补 Referer/UA/Cookie，
  支持图片、MP4 Range、m3u8 分片/Key 重写，替代桌面的 `aggmedia://`

## 构建

需要 JDK 21、Android SDK 35、Gradle 8.10+。

```powershell
$env:JAVA_HOME = "C:\za\android-tools\jdk-21.0.13.1+2"
$env:ANDROID_HOME = "C:\za\android-tools\android-sdk"
$env:PATH = "$env:JAVA_HOME\bin;C:\za\android-tools\android-sdk\platform-tools;$env:PATH"

node scripts/build-android.mjs
C:\za\android-tools\gradle-8.10.2\bin\gradle.bat -p apps/android :app:assembleDebug --no-daemon
```

产物：`apps/android/app/build/outputs/apk/debug/app-debug.apk`

## 已知限制

- 站点 Cookie 目前是全局 CookieManager，没有按站点隔离；小范围自用可接受。
- 动画 Bangumi 接口在当前模拟器网络下超时；视频代理/捕获路径已写，但未在真机验证。
- 隐藏 WebView 渲染的站点（得奇、69）只做了基础等待，复杂 WAF 仍可能需要“验证”窗口。
