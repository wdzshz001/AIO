package com.agg.reader;

import android.net.Uri;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 本地媒体代理：Android WebView 不能走 Electron 的 aggmedia 协议，
 * 图片/HLS/MP4 统一改走 http://127.0.0.1:<port>/?u=...，由这里补 Referer/UA/Cookie/Range。
 */
public final class MediaProxy {
    private static final String TAG = "AggProxy";
    private static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private final ExecutorService pool = Executors.newFixedThreadPool(6);
    private final OkHttpClient http;
    private ServerSocket server;
    private int port;

    public MediaProxy() {
        http = new OkHttpClient.Builder()
                .cookieJar(new AndroidCookieJar())
                .followRedirects(true)
                .followSslRedirects(true)
                .build();
    }

    public synchronized int start() {
        if (server != null) return port;
        try {
            server = new ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"));
            port = server.getLocalPort();
            Thread t = new Thread(this::acceptLoop, "agg-media-proxy");
            t.setDaemon(true);
            t.start();
            Log.i(TAG, "listening 127.0.0.1:" + port);
        } catch (Exception e) {
            Log.e(TAG, "start failed", e);
            port = 0;
        }
        return port;
    }

    public int getPort() {
        return port;
    }

    /** 同步返回本地代理 URL，供 JS 在构建 img/video 地址时直接调用 */
    public String proxyUrl(String url, String referer, String ua, String ck) {
        if (url == null || url.isEmpty()) return url;
        if (url.startsWith("http://127.0.0.1:")) return url;
        if (port == 0) return url;
        StringBuilder sb = new StringBuilder("http://127.0.0.1:").append(port).append("/?u=");
        sb.append(Uri.encode(url));
        if (referer != null && !referer.isEmpty()) sb.append("&r=").append(Uri.encode(referer));
        if (ua != null && !ua.isEmpty()) sb.append("&ua=").append(Uri.encode(ua));
        if (ck != null && !ck.isEmpty()) sb.append("&ck=").append(Uri.encode(ck));
        return sb.toString();
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try {
                Socket socket = server.accept();
                pool.execute(() -> handle(socket));
            } catch (Exception e) {
                if (!server.isClosed()) Log.w(TAG, "accept failed", e);
            }
        }
    }

    private void handle(Socket socket) {
        try (Socket s = socket) {
            s.setSoTimeout(30_000);
            InputStream in = s.getInputStream();
            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] first = requestLine.split(" ");
            if (first.length < 2) return;
            String method = first[0];
            String target = first[1];

            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT),
                            line.substring(colon + 1).trim());
                }
            }

            Uri uri = Uri.parse("http://127.0.0.1" + target);
            String url = uri.getQueryParameter("u");
            String referer = uri.getQueryParameter("r");
            String ua = uri.getQueryParameter("ua");
            String ck = uri.getQueryParameter("ck");

            if (url == null || url.isEmpty()) {
                writeText(s, 400, "text/plain", "missing u");
                return;
            }

            // hls.js 从 file:// 页面 XHR 到 127.0.0.1 时可能触发 Private Network/CORS 预检
            if ("OPTIONS".equalsIgnoreCase(method)) {
                OutputStream out = s.getOutputStream();
                out.write("HTTP/1.1 204 No Content\r\n".getBytes(StandardCharsets.ISO_8859_1));
                writeHeader(out, "Access-Control-Allow-Origin", "*");
                writeHeader(out, "Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
                writeHeader(out, "Access-Control-Allow-Headers", "Range, Origin, Accept, Content-Type, Cache-Control");
                writeHeader(out, "Access-Control-Allow-Private-Network", "true");
                writeHeader(out, "Access-Control-Max-Age", "600");
                out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                out.flush();
                return;
            }

            Request.Builder rb = new Request.Builder().url(url).header("User-Agent", ua == null || ua.isEmpty() ? UA : ua);
            rb.header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.6");
            if (referer != null && !referer.isEmpty()) rb.header("Referer", referer);
            if (ck != null && !ck.isEmpty()) rb.header("Cookie", ck);
            if (headers.containsKey("range")) rb.header("Range", headers.get("range"));
            if ("HEAD".equalsIgnoreCase(method)) rb.head();

            try (Response resp = http.newCall(rb.build()).execute()) {
                ResponseBody body = resp.body();
                String contentType = resp.header("Content-Type", "application/octet-stream");
                String ctLower = contentType.toLowerCase(Locale.ROOT);
                String urlLower = url.toLowerCase(Locale.ROOT);
                boolean hls = ctLower.contains("mpegurl") || ctLower.contains("m3u8")
                        || urlLower.contains(".m3u8");
                OutputStream out = s.getOutputStream();
                String statusLine = "HTTP/1.1 " + resp.code() + " " + (resp.message().isEmpty() ? "OK" : resp.message()) + "\r\n";
                out.write(statusLine.getBytes(StandardCharsets.ISO_8859_1));

                if (hls && resp.code() < 400) {
                    byte[] bytes = body == null ? new byte[0] : body.bytes();
                    String text = new String(bytes, StandardCharsets.UTF_8);
                    String base = resp.request().url().toString();
                    String rewritten = rewritePlaylist(text, base, referer, ua, ck);
                    byte[] outBytes = rewritten.getBytes(StandardCharsets.UTF_8);
                    writeHeader(out, "Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
                    writeHeader(out, "Content-Length", String.valueOf(outBytes.length));
                    writeHeader(out, "Access-Control-Allow-Origin", "*");
                    writeHeader(out, "Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
                    writeHeader(out, "Access-Control-Allow-Headers", "Range, Origin, Accept, Content-Type, Cache-Control");
                    writeHeader(out, "Access-Control-Allow-Private-Network", "true");
                    writeHeader(out, "Cache-Control", "no-cache");
                    out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                    if (!"HEAD".equalsIgnoreCase(method)) out.write(outBytes);
                    out.flush();
                    return;
                }

                // 图片/MP4 直接流式透传，避免把大视频整个读进内存
                writeHeader(out, "Content-Type", contentType);
                String len = resp.header("Content-Length");
                if (len != null) writeHeader(out, "Content-Length", len);
                writeHeader(out, "Accept-Ranges", resp.header("Accept-Ranges", "bytes"));
                String cr = resp.header("Content-Range");
                if (cr != null) writeHeader(out, "Content-Range", cr);
                writeHeader(out, "Access-Control-Allow-Origin", "*");
                writeHeader(out, "Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
                writeHeader(out, "Access-Control-Allow-Headers", "Range, Origin, Accept, Content-Type, Cache-Control");
                writeHeader(out, "Access-Control-Allow-Private-Network", "true");
                writeHeader(out, "Access-Control-Expose-Headers", "Content-Length, Content-Range");
                String cacheControl;
                if (ctLower.startsWith("image/")) {
                    cacheControl = "public, max-age=604800, immutable";
                } else if (urlLower.contains(".ts") || urlLower.contains(".m4s")
                        || ctLower.contains("mp2t") || ctLower.contains("iso.segment")) {
                    cacheControl = "public, max-age=86400";
                } else {
                    cacheControl = "public, max-age=3600";
                }
                writeHeader(out, "Cache-Control", cacheControl);
                writeHeader(out, "Connection", "close");
                out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                if (!"HEAD".equalsIgnoreCase(method) && body != null) {
                    InputStream stream = body.byteStream();
                    byte[] buffer = new byte[64 * 1024];
                    int n;
                    while ((n = stream.read(buffer)) > 0) out.write(buffer, 0, n);
                }
                out.flush();
            }
        } catch (Exception e) {
            Log.w(TAG, "proxy request failed", e);
            try {
                writeText(socket, 502, "text/plain", "proxy error: " + e.getMessage());
            } catch (Exception ignored) {
            }
        }
    }

    private static boolean looksHls(String url, String type, byte[] bytes) {
        String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
        if (t.contains("mpegurl") || t.contains("m3u8")) return true;
        if (url != null && url.toLowerCase(Locale.ROOT).contains(".m3u8")) return true;
        if (bytes.length > 0) {
            String head = new String(bytes, 0, Math.min(bytes.length, 16), StandardCharsets.UTF_8);
            return head.startsWith("#EXTM3U");
        }
        return false;
    }

    private String rewritePlaylist(String text, String base, String referer, String ua, String ck) {
        StringBuilder out = new StringBuilder();
        for (String raw : text.split("\\r?\\n")) {
            String line = raw.trim();
            if (line.isEmpty()) {
                out.append(raw).append('\n');
                continue;
            }
            if (line.startsWith("#")) {
                if (line.contains("URI=\"")) {
                    StringBuilder sb = new StringBuilder();
                    int from = 0;
                    while (true) {
                        int i = line.indexOf("URI=\"", from);
                        if (i < 0) {
                            sb.append(line, from, line.length());
                            break;
                        }
                        int end = line.indexOf('"', i + 5);
                        if (end < 0) {
                            sb.append(line, from, line.length());
                            break;
                        }
                        sb.append(line, from, i + 5);
                        String key = line.substring(i + 5, end);
                        try {
                            sb.append(proxyUrl(new URL(new URL(base), key).toString(), referer, ua, ck));
                        } catch (Exception e) {
                            sb.append(key);
                        }
                        from = end;
                    }
                    out.append(sb);
                } else {
                    out.append(line);
                }
                out.append('\n');
                continue;
            }
            try {
                out.append(proxyUrl(new URL(new URL(base), line).toString(), referer, ua, ck));
            } catch (Exception e) {
                out.append(line);
            }
            out.append('\n');
        }
        return out.toString();
    }

    private static void writeHeader(OutputStream out, String name, String value) throws Exception {
        out.write((name + ": " + value + "\r\n").getBytes(StandardCharsets.UTF_8));
    }

    private static void writeText(Socket socket, int status, String type, String text) {
        try (OutputStream out = socket.getOutputStream()) {
            String body = text == null ? "" : text;
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 " + status + " X\r\n").getBytes(StandardCharsets.ISO_8859_1));
            writeHeader(out, "Content-Type", type + "; charset=utf-8");
            writeHeader(out, "Content-Length", String.valueOf(bytes.length));
            writeHeader(out, "Access-Control-Allow-Origin", "*");
            out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
            out.write(bytes);
            out.flush();
        } catch (Exception ignored) {
        }
    }

    private static String readLine(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int b;
        while ((b = in.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') buf.write(b);
        }
        if (b == -1 && buf.size() == 0) return null;
        return buf.toString(StandardCharsets.ISO_8859_1.name());
    }

    private static final class AndroidCookieJar implements CookieJar {
        private final android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();

        @Override
        public void saveFromResponse(HttpUrl url, List<Cookie> cookies) {
            for (Cookie c : cookies) cm.setCookie(url.toString(), c.toString());
            cm.flush();
        }

        @Override
        public List<Cookie> loadForRequest(HttpUrl url) {
            String raw = cm.getCookie(url.toString());
            if (raw == null || raw.isEmpty()) return new ArrayList<>();
            List<Cookie> out = new ArrayList<>(); for (String part : raw.split(";")) { Cookie c = Cookie.parse(url, part.trim()); if (c != null) out.add(c); } return out;
        }
    }
}

