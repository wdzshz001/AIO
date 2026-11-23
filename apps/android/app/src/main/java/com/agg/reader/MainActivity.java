package com.agg.reader;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final String APK_MIME = "application/vnd.android.package-archive";
    private FrameLayout root;
    private WebView webView;
    private MediaProxy mediaProxy;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private DownloadManager downloadManager;
    private long updateDownloadId = -1;
    private BroadcastReceiver downloadReceiver;

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(0xff0b0d12);
        getWindow().setNavigationBarColor(0xff0b0d12);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        mediaProxy = new MediaProxy();
        mediaProxy.start();

        root = new FrameLayout(this);
        root.setBackgroundColor(0xff0b0d12);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top = insets.getSystemWindowInsetTop();
            int bottom = insets.getSystemWindowInsetBottom();
            if (v.getPaddingTop() != top || v.getPaddingBottom() != bottom) {
                v.setPadding(0, top, 0, bottom);
            }
            return insets;
        });
        webView = new WebView(this);
        webView.setBackgroundColor(0xff0b0d12);
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(NativeAgg.UA);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        WebView.setWebContentsDebuggingEnabled(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new NativeAgg(this, webView, mediaProxy), "NativeAgg");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    view.loadUrl(url);
                    return true;
                }
                return false;
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            }

            @Override
            public void onHideCustomView() {
                if (customView == null) return;
                root.removeView(customView);
                customView = null;
                if (customViewCallback != null) {
                    customViewCallback.onCustomViewHidden();
                    customViewCallback = null;
                }
                webView.setVisibility(View.VISIBLE);
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            }
        });

        webView.loadUrl("file:///android_asset/www/index.html");
        root.requestApplyInsets();

        downloadManager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        downloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
                if (id <= 0 || id != updateDownloadId) return;
                try {
                    Uri uri = downloadManager.getUriForDownloadedFile(id);
                    if (uri == null) {
                        Toast.makeText(MainActivity.this, "安装包下载失败", Toast.LENGTH_LONG).show();
                        return;
                    }
                    Intent install = new Intent(Intent.ACTION_VIEW);
                    install.setDataAndType(uri, APK_MIME);
                    install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    try {
                        startActivity(install);
                    } catch (Exception e) {
                        if (Build.VERSION.SDK_INT >= 26) {
                            Intent settings = new Intent(
                                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + getPackageName()));
                            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(settings);
                            Toast.makeText(MainActivity.this,
                                    "请允许安装未知应用，然后重新点击检查更新", Toast.LENGTH_LONG).show();
                        } else {
                            throw e;
                        }
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "无法打开安装器，请到下载目录手动安装", Toast.LENGTH_LONG).show();
                }
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            registerReceiver(downloadReceiver, filter);
        }
    }

    /** 下载新版 APK；完成后由 downloadReceiver 自动打开系统安装器 */
    void downloadApk(String url) {
        try {
            if (downloadManager == null) {
                downloadManager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            }
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            req.setTitle("聚合阅读更新");
            req.setDescription("正在下载最新 APK");
            req.setMimeType(APK_MIME);
            req.setAllowedOverMetered(true);
            req.setAllowedOverRoaming(false);
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalFilesDir(
                    this,
                    Environment.DIRECTORY_DOWNLOADS,
                    "agg-reader-update-" + System.currentTimeMillis() + ".apk");
            updateDownloadId = downloadManager.enqueue(req);
            Toast.makeText(this, "已开始下载，完成后会自动打开安装器", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    void setAppImmersive(boolean on) {
        runOnUiThread(() -> {
            View decor = getWindow().getDecorView();
            if (on) {
                decor.setSystemUiVisibility(
                        View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                                | View.SYSTEM_UI_FLAG_FULLSCREEN
                                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
            } else {
                decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            }
        });
    }

    /** 动画视频默认横屏全屏；退出时恢复系统方向 */
    void setVideoFullscreen(boolean on) {
        runOnUiThread(() -> {
            if (on) {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                setAppImmersive(true);
            } else {
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
                setAppImmersive(false);
            }
        });
    }

    public FrameLayout getRoot() {
        return root;
    }

    @Override
    public void onBackPressed() {
        if (customView != null) {
            webView.setVisibility(View.VISIBLE);
            root.removeView(customView);
            customView = null;
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            return;
        }
        webView.evaluateJavascript(
                "(function(){var d=window.__aggDepth||1;if(d>1){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));return 'back';}return 'exit';})()",
                value -> {
                    if (value == null || value.contains("exit")) finish();
                });
    }

    @Override
    protected void onDestroy() {
        try {
            if (downloadReceiver != null) unregisterReceiver(downloadReceiver);
        } catch (Exception ignored) {
        }
        try {
            webView.destroy();
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
