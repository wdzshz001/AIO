package com.agg.reader;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.FormBody;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** window.agg 的 Android 实现。 */
public final class NativeAgg {
    private static final String TAG = "AggNative";
    private static final String UPDATE_MANIFEST =
            "https://github.com/wdzshz001/AIO/releases/latest/download/android-latest.json";
    private static final String UPDATE_API =
            "https://api.github.com/repos/wdzshz001/AIO/releases/latest";
    private static final String UPDATE_APK =
            "https://github.com/wdzshz001/AIO/releases/latest/download/agg-reader-android.apk";
    /** 隐藏 WebView 里只抓地址，不允许任何声音/视频抢占前台 */
    private static final String MUTE_MEDIA_JS =
            "(function(){var m=function(){try{document.querySelectorAll('video,audio').forEach(function(v){v.muted=true;v.volume=0;});}catch(e){}};"
                    + "m();setInterval(m,700);try{new MutationObserver(m).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}})()";
    static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private final MainActivity activity;
    private final WebView webView;
    private final MediaProxy mediaProxy;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http;
    private final CookieManager cookies = CookieManager.getInstance();

    NativeAgg(MainActivity activity, WebView webView, MediaProxy mediaProxy) {
        this.activity = activity;
        this.webView = webView;
        this.mediaProxy = mediaProxy;
        cookies.setAcceptCookie(true);
        http = new OkHttpClient.Builder()
                .cookieJar(new CookieJar() {
                    @Override
                    public void saveFromResponse(HttpUrl url, List<Cookie> list) {
                        for (Cookie c : list) cookies.setCookie(url.toString(), c.toString());
                        cookies.flush();
                    }

                    @Override
                    public List<Cookie> loadForRequest(HttpUrl url) {
                        String raw = cookies.getCookie(url.toString());
                        if (raw == null || raw.isEmpty()) return new ArrayList<>();
                        List<Cookie> out = new ArrayList<>(); for (String part : raw.split(";")) { Cookie c = Cookie.parse(url, part.trim()); if (c != null) out.add(c); } return out;
                    }
                })
                .followRedirects(true)
                .followSslRedirects(true)
                .callTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .connectTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .build();
    }

    @JavascriptInterface
    public void invoke(String method, String argsJson, String id) {
        JSONArray args;
        try {
            args = new JSONArray(argsJson == null || argsJson.isEmpty() ? "[]" : argsJson);
        } catch (Exception e) {
            reject(id, "bad args: " + e.getMessage());
            return;
        }

        if ("renderHtml".equals(method) || "harvestLinks".equals(method) || "captureMedia".equals(method)) {
            main.post(() -> {
                try {
                    if ("renderHtml".equals(method)) renderAsync(args, id);
                    else if ("harvestLinks".equals(method)) harvestAsync(args, id);
                    else captureAsync(args, id);
                } catch (Exception e) {
                    reject(id, e.getMessage());
                }
            });
            return;
        }

        pool.execute(() -> {
            try {
                resolve(id, dispatch(method, args));
            } catch (Throwable e) {
                Log.w(TAG, method + " failed", e);
                reject(id, e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    /** 同步返回本地代理地址，JS 在生成图片/视频 URL 时调用 */
    @JavascriptInterface
    public String proxyUrl(String url, String referer, String ua, String ck) {
        return mediaProxy.proxyUrl(url, referer, ua, ck);
    }

    private Object dispatch(String method, JSONArray args) throws Exception {        switch (method) {
            case "fetchHtml":
                return fetchHtml(args.optString(1), args.optString(2, null));
            case "request":
                return request(args.optString(1), args.optJSONObject(2));
            case "submitForm":
                return submitForm(args.optString(2), args.optString(1), args.optJSONObject(3));
            case "verifySite":
            case "openWindow": {
                String url = args.optString(1);
                main.post(() -> openVerify(url));
                return true;
            }
            case "openExternal": {
                String url = args.optString(0);
                main.post(() -> {
                    try {
                        activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception ignored) {
                    }
                });
                return true;
            }
            case "clearSiteData": {
                cookies.removeAllCookies(null);
                cookies.flush();
                WebStorage.getInstance().deleteAllData();
                return true;
            }
            case "appInfo": {
                JSONObject o = new JSONObject();
                o.put("version", BuildConfig.VERSION_NAME);
                o.put("electron", "Android WebView");
                o.put("chrome", WebSettings.getDefaultUserAgent(activity));
                o.put("platform", "android");
                return o;
            }
            case "proxyInfo":
                return mediaProxy.getPort() > 0
                        ? "本地代理 127.0.0.1:" + mediaProxy.getPort()
                        : "直连";
            case "appUpdateCheck":
                return checkAppUpdate();
            case "appUpdateInstall": {
                String url = args.optString(0);
                main.post(() -> activity.downloadApk(url));
                return true;
            }
            case "setImmersive": {
                boolean on = args.optBoolean(0);
                main.post(() -> activity.setAppImmersive(on));
                return true;
            }
            case "setVideoFullscreen": {
                boolean on = args.optBoolean(0);
                main.post(() -> activity.setVideoFullscreen(on));
                return true;
            }
            case "setNetworkConfig":
            case "setLoginItem":
            case "setTray":
                return true;
            default:
                throw new IllegalArgumentException("unknown method " + method);
        }
    }

    private Object fetchHtml(String url, String referer) throws Exception {
        Request.Builder rb = new Request.Builder().url(url)
                .header("User-Agent", UA)
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
        if (referer != null && !referer.isEmpty()) rb.header("Referer", referer);
        try (Response resp = http.newCall(rb.build()).execute()) {
            ResponseBody body = resp.body();
            byte[] bytes = body == null ? new byte[0] : body.bytes();
            String html = decode(bytes, resp.header("Content-Type"));
            JSONObject o = new JSONObject();
            o.put("url", resp.request().url().toString());
            o.put("status", resp.code());
            o.put("html", html);
            return o;
        }
    }

    private Object request(String url, JSONObject opts) throws Exception {
        String method = opts == null ? "GET" : opts.optString("method", "GET");
        JSONObject headers = opts == null ? null : opts.optJSONObject("headers");
        String body = opts == null ? null : opts.optString("body", null);
        long timeoutMs = opts == null ? 30_000 : opts.optLong("timeoutMs", 30_000);

        OkHttpClient client = http.newBuilder()
                .callTimeout(Math.max(5_000, timeoutMs), java.util.concurrent.TimeUnit.MILLISECONDS)
                .build();
        Request.Builder rb = new Request.Builder().url(url)
                .header("User-Agent", UA)
                .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
        if (headers != null) {
            for (java.util.Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String k = it.next();
                rb.header(k, headers.optString(k));
            }
        }
        RequestBody reqBody = null;
        if (body != null) {
            String ct = headers == null ? null : headers.optString("content-type", null);
            if (ct == null) ct = "application/json; charset=utf-8";
            reqBody = RequestBody.create(body, MediaType.parse(ct));
        }
        rb.method(method, reqBody);
        try (Response resp = client.newCall(rb.build()).execute()) {
            ResponseBody b = resp.body();
            byte[] bytes = b == null ? new byte[0] : b.bytes();
            String ct = resp.header("Content-Type");
            JSONObject o = new JSONObject();
            o.put("url", resp.request().url().toString());
            o.put("status", resp.code());
            o.put("body", decode(bytes, ct));
            if (ct != null) o.put("contentType", ct);
            return o;
        }
    }

    private Object submitForm(String actionUrl, String pageUrl, JSONObject fields) throws Exception {
        FormBody.Builder form = new FormBody.Builder();
        if (fields != null) {
            for (java.util.Iterator<String> it = fields.keys(); it.hasNext(); ) {
                String k = it.next();
                form.add(k, fields.optString(k, ""));
            }
        }
        Request.Builder rb = new Request.Builder().url(actionUrl)
                .header("User-Agent", UA)
                .header("Referer", pageUrl == null ? "" : pageUrl)
                .post(form.build());
        try (Response resp = http.newCall(rb.build()).execute()) {
            ResponseBody body = resp.body();
            byte[] bytes = body == null ? new byte[0] : body.bytes();
            JSONObject o = new JSONObject();
            o.put("url", resp.request().url().toString());
            o.put("status", resp.code());
            o.put("html", decode(bytes, resp.header("Content-Type")));
            return o;
        }
    }

    private void renderAsync(JSONArray args, String id) {
        String url = args.optString(1);
        JSONObject opts = args.optJSONObject(2);
        long timeout = opts == null ? 45_000 : opts.optLong("timeoutMs", 45_000);
        String waitFor = opts == null ? "" : opts.optString("waitFor", "");
        boolean scroll = opts != null && opts.optBoolean("scroll", false);

        WebView v = newWebView();
        addHidden(v);
        AtomicBoolean done = new AtomicBoolean(false);
        final long deadline = System.currentTimeMillis() + timeout;

        Runnable finish = () -> {
            if (!done.compareAndSet(false, true)) return;
            captureHtml(v, id);
        };

        v.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String u) {
                if (done.get()) return;
                if (waitFor != null && !waitFor.isEmpty()) {
                    pollSelector(v, waitFor, deadline, () -> {
                        if (scroll) doScroll(v, finish);
                        else main.postDelayed(finish, 600);
                    });
                } else if (scroll) {
                    doScroll(v, finish);
                } else {
                    main.postDelayed(finish, 900);
                }
            }

            @Override
            public void onReceivedError(WebView view, int code, String desc, String failingUrl) {
                Log.w(TAG, "render error " + code + " " + desc);
            }
        });
        v.loadUrl(url);
        main.postDelayed(finish, timeout);
    }

    private void captureHtml(WebView v, String id) {
        try {
            v.evaluateJavascript("document.documentElement.outerHTML", value -> {
                try {
                    String html = unquote(value);
                    JSONObject o = new JSONObject();
                    o.put("url", v.getUrl() == null ? "" : v.getUrl());
                    o.put("status", 200);
                    o.put("html", html);
                    resolve(id, o);
                } catch (Exception e) {
                    reject(id, e.getMessage());
                } finally {
                    cleanup(v);
                }
            });
        } catch (Exception e) {
            reject(id, e.getMessage());
            cleanup(v);
        }
    }

    private void doScroll(WebView v, Runnable after) {
        String js =
                "(async()=>{const H=()=>Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);"
                        + "const step=Math.max(420,Math.floor(window.innerHeight*0.8));let lastH=0;"
                        + "for(let i=0;i<80;i++){const h=H();const y=Math.min(h,Math.floor((i+1)*step));"
                        + "window.scrollTo(0,y);await new Promise(r=>setTimeout(r,300));"
                        + "if(y>=h-2&&h===lastH)break;lastH=h;}"
                        + "await new Promise(r=>setTimeout(r,1600));window.scrollTo(0,0);return 'ok';})()";
        v.evaluateJavascript(js, ignored -> main.postDelayed(after, 800));
    }

    private void pollSelector(WebView v, String selector, long deadline, Runnable ok) {
        if (System.currentTimeMillis() > deadline) {
            ok.run();
            return;
        }
        String js = "!!document.querySelector(" + JSONObject.quote(selector) + ")";
        v.evaluateJavascript(js, value -> {
            if ("true".equals(value)) ok.run();
            else main.postDelayed(() -> pollSelector(v, selector, deadline, ok), 450);
        });
    }

    private void harvestAsync(JSONArray args, String id) {
        String url = args.optString(1);
        String selector = args.optString(2, "a[href]");
        int limit = args.optInt(3, 200);
        WebView v = newWebView();
        addHidden(v);
        AtomicBoolean done = new AtomicBoolean(false);
        Runnable finish = () -> {
            if (!done.compareAndSet(false, true)) return;
            String js = "JSON.stringify(Array.from(document.querySelectorAll(" + JSONObject.quote(selector) + ")).slice(0," + limit + ").map(a=>({url:a.href||a.getAttribute('href')||'',text:(a.innerText||a.textContent||'').trim()})))";
            v.evaluateJavascript(js, value -> {
                try {
                    String raw = unquote(value);
                    JSONArray arr = new JSONArray(raw == null || raw.isEmpty() ? "[]" : raw);
                    resolve(id, arr);
                } catch (Exception e) {
                    reject(id, e.getMessage());
                } finally {
                    cleanup(v);
                }
            });
        };
        v.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String u) {
                main.postDelayed(finish, 1500);
            }
        });
        v.loadUrl(url);
        main.postDelayed(finish, 45_000);
    }

    private void captureAsync(JSONArray args, String id) {
        String pageUrl = args.optString(1);
        JSONObject opts = args.optJSONObject(2);
        Pattern pattern = null;
        try {
            String p = opts == null ? null : opts.optString("pattern", null);
            if (p != null && !p.isEmpty()) pattern = Pattern.compile(p);
        } catch (Exception ignored) {
        }
        Pattern finalPattern = pattern;
        AtomicReference<String> found = new AtomicReference<>();
        WebView v = newWebView();
        addHidden(v);
        AtomicBoolean done = new AtomicBoolean(false);
        Runnable finish = () -> {
            if (!done.compareAndSet(false, true)) return;
            String media = found.get();
            if (media == null) {
                resolve(id, null);
            } else {
                try {
                    JSONObject o = new JSONObject();
                    o.put("url", media);
                    o.put("referer", pageUrl);
                    resolve(id, o);
                } catch (Exception e) {
                    reject(id, e.getMessage());
                }
            }
            cleanup(v);
        };
        v.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                if (looksMedia(u, finalPattern)) found.compareAndSet(null, u);
                return null;
            }

            @Override
            public void onPageFinished(WebView view, String u) {
                String js = "JSON.stringify(Array.from(document.querySelectorAll('video,source')).map(v=>v.src||v.getAttribute('src')||'').filter(Boolean))";
                v.evaluateJavascript(js, value -> {
                    try {
                        JSONArray arr = new JSONArray(unquote(value));
                        for (int i = 0; i < arr.length(); i++) {
                            String s = arr.optString(i);
                            if (looksMedia(s, finalPattern)) found.compareAndSet(null, s);
                        }
                    } catch (Exception ignored) {
                    }
                });
            }
        });
        v.loadUrl(pageUrl);
        main.postDelayed(finish, 12_000);
    }

    private static boolean looksMedia(String url, Pattern pattern) {
        if (url == null) return false;
        String lower = url.toLowerCase(Locale.ROOT);
        if (lower.startsWith("data:") || lower.contains("favicon")) return false;
        if (pattern != null) return pattern.matcher(url).find();
        return lower.contains(".m3u8") || lower.contains(".mp4") || lower.contains(".flv") || lower.contains(".webm");
    }

    private void openVerify(String url) {
        if (url == null || url.isEmpty()) return;
        Intent i = new Intent(activity, VerifyActivity.class);
        i.putExtra("url", url);
        activity.startActivity(i);
    }

    private WebView newWebView() {
        WebView v = new WebView(activity);
        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setUserAgentString(UA);
        // 隐藏 WebView 只用于抓页面/媒体地址，禁止自动播放，避免前台加载时后台先出声
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(v, true);
        v.postDelayed(() -> {
            try {
                v.evaluateJavascript(MUTE_MEDIA_JS, null);
            } catch (Exception ignored) {
            }
        }, 1200);
        return v;
    }

    private void addHidden(WebView v) {
        FrameLayout root = activity.getRoot();
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(2, 2);
        lp.leftMargin = -4;
        lp.topMargin = -4;
        root.addView(v, lp);
    }

    private void cleanup(WebView v) {
        try {
            activity.getRoot().removeView(v);
            v.stopLoading();
            v.loadUrl("about:blank");
            v.destroy();
        } catch (Exception ignored) {
        }
    }

    private void resolve(String id, Object result) {
        String json = result == null ? "null" : result.toString();
        String js = "window.__aggResolve(" + JSONObject.quote(id) + "," + JSONObject.quote(json) + ")";
        main.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    private void reject(String id, String message) {
        String js = "window.__aggReject(" + JSONObject.quote(id) + "," + JSONObject.quote(message == null ? "bridge error" : message) + ")";
        main.post(() -> {
            try {
                webView.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    private Object checkAppUpdate() throws Exception {
        JSONObject out = new JSONObject();
        out.put("current", BuildConfig.VERSION_NAME);
        String bestVersion = "";
        String bestUrl = "";
        String lastError = "";

        // 1) 静态 manifest 优先（快，且老版本也兼容）。加时间戳绕过 CDN 缓存。
        try {
            JSONObject json = fetchJson(UPDATE_MANIFEST + "?t=" + System.currentTimeMillis());
            bestVersion = normalizeVersion(json.optString("version", ""));
            bestUrl = json.optString("apkUrl", "");
        } catch (Exception e) {
            lastError = e.getMessage() == null ? e.toString() : e.getMessage();
        }

        // 2) 静态文件被 CDN 缓存 / 发布未同步时，用 GitHub API 兜底
        try {
            JSONObject release = fetchJson(UPDATE_API);
            String apiVersion = normalizeVersion(release.optString("tag_name", ""));
            String apiUrl = "";
            JSONArray assets = release.optJSONArray("assets");
            if (assets != null) {
                for (int i = 0; i < assets.length(); i++) {
                    JSONObject asset = assets.optJSONObject(i);
                    if (asset == null) continue;
                    String name = asset.optString("name", "");
                    if (name.endsWith(".apk")) {
                        apiUrl = asset.optString("browser_download_url", "");
                        break;
                    }
                }
            }
            if (!apiVersion.isEmpty()
                    && (bestVersion.isEmpty()
                    || versionValue(apiVersion) > versionValue(bestVersion))) {
                bestVersion = apiVersion;
                bestUrl = apiUrl;
            }
        } catch (Exception e) {
            if (lastError.isEmpty()) lastError = e.getMessage() == null ? e.toString() : e.getMessage();
        }

        if (bestUrl.isEmpty()) bestUrl = UPDATE_APK;
        out.put("version", bestVersion);
        out.put("url", bestUrl);
        if (bestVersion.isEmpty()) {
            out.put("available", false);
            out.put("error", lastError.isEmpty() ? "未获取到版本信息" : lastError);
            return out;
        }
        out.put("available", versionValue(bestVersion) > versionValue(BuildConfig.VERSION_NAME));
        return out;
    }

    private JSONObject fetchJson(String url) throws Exception {
        Request req = new Request.Builder()
                .url(url)
                .header("User-Agent", UA)
                .header("Accept", "application/vnd.github+json, application/json")
                .header("Cache-Control", "no-cache")
                .build();
        try (Response res = http.newCall(req).execute()) {
            ResponseBody body = res.body();
            String text = body == null ? "" : body.string();
            if (!res.isSuccessful()) {
                throw new Exception("HTTP " + res.code() + " " + url);
            }
            return new JSONObject(text);
        }
    }

    private static String normalizeVersion(String version) {
        String v = version == null ? "" : version.trim();
        if (v.startsWith("v") || v.startsWith("V")) v = v.substring(1);
        return v;
    }

    private static int versionValue(String version) {
        String[] parts = version.replaceFirst("^v", "").split("\\.");
        int major = 0;
        int minor = 0;
        int patch = 0;
        try {
            major = parts.length > 0 ? Integer.parseInt(parts[0].replaceAll("\\D.*$", "")) : 0;
            minor = parts.length > 1 ? Integer.parseInt(parts[1].replaceAll("\\D.*$", "")) : 0;
            patch = parts.length > 2 ? Integer.parseInt(parts[2].replaceAll("\\D.*$", "")) : 0;
        } catch (Exception ignored) {
        }
        return major * 10000 + minor * 100 + patch;
    }

    private static String unquote(String value) {
        if (value == null) return "";
        if (value.startsWith("\"") && value.endsWith("\"")) {
            try {
                return new JSONArray("[" + value + "]").getString(0);
            } catch (Exception ignored) {
            }
        }
        return value;
    }

    private static String decode(byte[] bytes, String contentType) {
        String enc = "UTF-8";
        if (contentType != null) {
            Matcher m = Pattern.compile("charset=[\"']?([\\w-]+)", Pattern.CASE_INSENSITIVE).matcher(contentType);
            if (m.find()) enc = m.group(1);
        }
        String lower = enc.toLowerCase(Locale.ROOT);
        if (lower.contains("gb")) enc = "GBK";
        try {
            return new String(bytes, Charset.forName(enc));
        } catch (Exception e) {
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }
}

