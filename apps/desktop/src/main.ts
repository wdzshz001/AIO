import { app, BrowserWindow, ipcMain, Menu, nativeImage, net, protocol, session, shell, Tray } from 'electron';
import type { Session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runSmoke } from './smoke.ts';

interface HttpRequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * UI 走自定义协议而不是 file://：
 * file:// 页面发不出跨域 XHR，视频 CDN（m3u8）会直接 manifestLoadError。
 */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'agg',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: 'aggmedia',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/** 媒体代理：渲染进程不直接连 CDN，统一由主进程带 UA/Referer 取流 */
function mediaProxyUrl(target: string, referer?: string, userAgent?: string, cookies?: string): string {
  const p = new URLSearchParams({ u: target });
  if (referer) p.set('r', referer);
  if (userAgent) p.set('ua', userAgent);
  if (cookies) p.set('ck', cookies);
  return `aggmedia://stream/?${p.toString()}`;
}

/** 把 m3u8 里的相对地址全部改写成代理地址 */
function rewritePlaylist(
  text: string,
  base: string,
  referer: string,
  userAgent?: string,
  cookies?: string,
): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        return line.replace(
          /URI="([^"]+)"/g,
          (_m, uri: string) =>
            `URI="${mediaProxyUrl(new URL(uri, base).toString(), referer, userAgent, cookies)}"`,
        );
      }
      return mediaProxyUrl(new URL(t, base).toString(), referer, userAgent, cookies);
    })
    .join('\n');
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEV = !!process.env.AGG_DEV;
/** electron-builder portable 会注入这个变量；数据放在 EXE 同级的 data/，换机可整体带走 */
const PORTABLE_DIR = process.env.PORTABLE_EXECUTABLE_DIR;
if (PORTABLE_DIR) {
  const dataDir = path.join(PORTABLE_DIR, 'data');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    app.setPath('userData', dataDir);
    app.setPath('sessionData', dataDir);
  } catch {
    // 目录不可写时退回系统 userData
  }
}

let mainWindow: BrowserWindow | null = null;
const siteSessions = new Map<string, Session>();
let networkTimeoutMs = 30_000;
let tray: Tray | null = null;
let trayEnabled = false;
let quitting = false;

/**
 * Windows Web Bundle 热更新：
 * - 只覆盖 index.html / renderer.js / renderer.css
 * - 主进程/原生能力仍由 EXE 决定
 * - 先通知，用户在设置里手动下载并应用
 */
const HOT_BASE =
  process.env.AGG_HOT_BASE || 'https://github.com/wdzshz001/AIO/releases/latest/download';
const HOT_FILES = ['index.html', 'renderer.js', 'renderer.css'] as const;
let hotRoot: string | null = null;

interface HotManifest {
  version: string;
  builtAt?: string;
  files: Record<string, string>;
}

function hotBaseDir(): string {
  return path.join(app.getPath('userData'), 'hot', 'win');
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function hotVersionValue(version: string): number[] {
  return version
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => Number.parseInt(x, 10) || 0)
    .slice(0, 3);
}

function versionGreater(a: string, b: string): boolean {
  const av = hotVersionValue(a);
  const bv = hotVersionValue(b);
  for (let i = 0; i < 3; i++) {
    if ((av[i] ?? 0) !== (bv[i] ?? 0)) return (av[i] ?? 0) > (bv[i] ?? 0);
  }
  return false;
}

function readHotCurrent(): (HotManifest & { root: string }) | null {
  try {
    const dir = hotBaseDir();
    const current = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8')) as HotManifest;
    const root = path.join(dir, current.version.replace(/[^\w.-]/g, '_'));
    if (!current.version || !current.files || !fs.existsSync(path.join(root, 'index.html'))) return null;
    // 重装/升级 EXE 后，旧热更新不能覆盖更新的壳
    if (!versionGreater(current.version, app.getVersion())) return null;
    for (const name of HOT_FILES) {
      const file = path.join(root, name);
      const expected = current.files[name];
      if (!expected || !fs.existsSync(file)) return null;
      if (sha256(fs.readFileSync(file)) !== expected) return null;
    }
    return { ...current, root };
  } catch {
    return null;
  }
}

function resolveAggFile(rel: string): string {
  const hot = hotRoot ? path.resolve(hotRoot, '.' + rel) : '';
  if (hotRoot && hot.startsWith(hotRoot + path.sep) && fs.existsSync(hot)) return hot;
  return path.resolve(__dirname, '.' + rel);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await net.fetch(url, { cache: 'no-store' } as RequestInit);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function checkHotUpdate(): Promise<{
  available: boolean;
  version?: string;
  current?: string;
  error?: string;
}> {
  try {
    const current = readHotCurrent()?.version ?? app.getVersion();
    const manifest = await fetchJson<HotManifest>(`${HOT_BASE}/hot-win.json`);
    const available = !!manifest.version && versionGreater(manifest.version, current);
    return { available, version: manifest.version, current };
  } catch (e) {
    return { available: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function applyHotUpdate(version: string): Promise<{ ok: boolean; error?: string; version?: string }> {
  try {
    const manifest = await fetchJson<HotManifest>(`${HOT_BASE}/hot-win.json`);
    if (!manifest.version || manifest.version !== version) throw new Error('版本已变化，请重新检查');
    const dir = hotBaseDir();
    const target = path.join(dir, version.replace(/[^\w.-]/g, '_'));
    const tmp = path.join(dir, `.tmp-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    for (const name of HOT_FILES) {
      const res = await net.fetch(`${HOT_BASE}/hot-win-${name}`, { cache: 'no-store' } as RequestInit);
      if (!res.ok) throw new Error(`下载 ${name} 失败（HTTP ${res.status}）`);
      const buf = Buffer.from(await res.arrayBuffer());
      const expected = manifest.files?.[name];
      if (!expected || sha256(buf) !== expected) throw new Error(`${name} 校验失败`);
      fs.writeFileSync(path.join(tmp, name), buf);
    }
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(tmp, target);
    const current = { ...manifest, root: target };
    const currentPath = path.join(dir, 'current.json');
    fs.writeFileSync(currentPath + '.tmp', JSON.stringify(current, null, 2));
    fs.rmSync(currentPath, { force: true });
    fs.renameSync(currentPath + '.tmp', currentPath);
    hotRoot = target;
    setTimeout(() => mainWindow?.webContents.reload(), 700);
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 每个站点独立分区，Cookie / 登录态互不干扰 */
function siteSession(id: string): Session {
  let s = siteSessions.get(id);
  if (!s) {
    s = session.fromPartition(`persist:site-${id}`);
    s.setUserAgent(UA);
    siteSessions.set(id, s);
  }
  return s;
}

function decodeBody(buf: Buffer, contentType: string | null): string {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const head = buf.subarray(0, 4096).toString('latin1');
  const fromMeta = /charset=["']?([\w-]+)/i.exec(head)?.[1];
  let enc = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  if (enc === 'gb2312' || enc === 'gbk') enc = 'gb18030';
  try {
    return new TextDecoder(enc).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

async function fetchHtml(
  siteId: string,
  url: string,
  referer?: string,
): Promise<{ url: string; status: number; html: string }> {
  const s = siteSession(siteId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), networkTimeoutMs);
  try {
    const res = await s.fetch(url, {
      headers: {
        'user-agent': UA,
        referer: referer || url,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      url: res.url,
      status: res.status,
      html: decodeBody(buf, res.headers.get('content-type')),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通用 HTTP 请求：JSON API（Bangumi / 订阅 / json-api 数据源）需要自定义
 * method、Content-Type、Authorization 等头，fetchHtml 不够用。
 */
async function requestHttp(
  siteId: string,
  url: string,
  opts: HttpRequestOpts = {},
): Promise<{ url: string; status: number; body: string; contentType?: string }> {
  const s = siteSession(siteId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? networkTimeoutMs);
  try {
    const headers: Record<string, string> = {
      'user-agent': UA,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(opts.headers ?? {}),
    };
    const res = await s.fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body,
      redirect: 'follow',
      signal: controller.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? undefined;
    return {
      url: res.url,
      status: res.status,
      body: decodeBody(buf, contentType ?? null),
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForPage(
  win: BrowserWindow,
  opts: { waitFor?: string; timeoutMs?: number } = {},
): Promise<string> {
  const timeout = opts.timeoutMs ?? 30_000;
  const started = Date.now();
  const sel = opts.waitFor ? JSON.stringify(opts.waitFor) : 'null';

  while (Date.now() - started < timeout) {
    const state = await win.webContents
      .executeJavaScript(
        `(() => {
          const sel = ${sel};
          const blocked = /altcha|aegis_altcha|cf-challenge|Just a moment|Checking your browser/i
            .test(document.title + (document.body ? document.body.innerHTML.slice(0, 3000) : ''));
          const ready = document.readyState === 'complete';
          const found = sel ? !!document.querySelector(sel) : true;
          return { ok: found && ready && !blocked, blocked, ready };
        })()`,
      )
      .catch(() => ({ ok: false, blocked: true, ready: false }));

    if (state.ok) {
      return await win.webContents.executeJavaScript('document.documentElement.outerHTML');
    }
    await delay(400);
  }
  // 超时也要把当前内容交回去，上层会判断是不是拦截页
  return await win.webContents
    .executeJavaScript('document.documentElement.outerHTML')
    .catch(() => '');
}

async function renderHtml(
  siteId: string,
  url: string,
  opts: { waitFor?: string; timeoutMs?: number; scroll?: boolean } = {},
): Promise<{ url: string; status: number; html: string }> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1600,
    webPreferences: {
      session: siteSession(siteId),
      sandbox: true,
      contextIsolation: true,
      javascript: true,
      images: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setUserAgent(UA);
  win.webContents.setAudioMuted(true);

  let status = 200;
  win.webContents.on('did-fail-load', (_e, code, desc, _u, isMainFrame) => {
    if (isMainFrame && code !== -3 /* ERR_ABORTED，重定向常见 */) {
      console.error('render did-fail-load', code, desc);
    }
  });
  win.webContents.on('did-finish-load', () => {
    status = 200;
  });
  win.webContents.on('did-navigate', (_e, navUrl) => {
    if (!navUrl.startsWith('http')) status = 0;
  });

  try {
    // 验证页 / 播放页会自己跳转或长期挂着长连接，loadURL 可能很久不返回；不能让它阻塞嗅探
    await Promise.race([win.loadURL(url).catch(() => undefined), delay(12_000)]);

    if (opts.scroll) {
      await win.webContents
        .executeJavaScript(
          `(async () => {
            const H = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            const step = Math.max(420, Math.floor(window.innerHeight * 0.8));
            let lastH = 0;
            for (let i = 0; i < 80; i++) {
              const h = H();
              const y = Math.min(h, Math.floor((i + 1) * step));
              window.scrollTo(0, y);
              await new Promise(r => setTimeout(r, 260));
              if (y >= h - 2 && h === lastH) break;
              lastH = h;
            }
            await new Promise(r => setTimeout(r, 1600));
            window.scrollTo(0, 0);
          })()`,
        )
        .catch(() => undefined);
    }

    const html = await waitForPage(win, opts);
    return { url: win.webContents.getURL(), status, html };
  } finally {
    win.destroy();
  }
}

interface HarvestLink {
  url: string;
  text: string;
}

/**
 * 在页面里构造表单并提交，用于站内搜索 / 登录 / 回帖这类只能 POST 的入口。
 * 提交交给浏览器真实导航，链路里的 JS 跳转、Cookie、验证都能自然带上。
 */
async function submitForm(
  siteId: string,
  pageUrl: string,
  actionUrl: string,
  fields: Record<string, string>,
  opts: { waitFor?: string; timeoutMs?: number } = {},
): Promise<{ url: string; status: number; html: string }> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1400,
    webPreferences: {
      session: siteSession(siteId),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setUserAgent(UA);
  win.webContents.setAudioMuted(true);

  try {
    await Promise.race([win.loadURL(pageUrl).catch(() => undefined), delay(15_000)]);
    await waitForPage(win, { timeoutMs: 30_000 }).catch(() => '');
    await win.webContents
      .executeJavaScript('document.readyState === "complete" || true')
      .catch(() => undefined);

    const timeout = opts.timeoutMs ?? 25_000;
    const navigated = new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', done);
      setTimeout(done, timeout);
    });

    await win.webContents.executeJavaScript(`(() => {
      const data = ${JSON.stringify(fields)};
      const f = document.createElement('form');
      f.method = 'post';
      f.action = ${JSON.stringify(actionUrl)};
      f.style.display = 'none';
      for (const k of Object.keys(data)) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = k;
        input.value = String(data[k]);
        f.appendChild(input);
      }
      document.body.appendChild(f);
      f.submit();
      return true;
    })()`);

    await navigated;

    if (opts.waitFor) {
      const sel = JSON.stringify(opts.waitFor);
      const started = Date.now();
      while (Date.now() - started < 15_000) {
        const ok = await win.webContents
          .executeJavaScript(`!!document.querySelector(${sel})`)
          .catch(() => false);
        if (ok) break;
        await delay(300);
      }
    }

    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
    return { url: win.webContents.getURL(), status: 200, html };
  } finally {
    win.destroy();
  }
}

/**
 * 有些站点的链接是 JS 点击才生成的（服务端不输出 href），
 * 这里用真实输入事件逐个点开，并拦截跳转把地址收回来。
 * 注意必须用 sendInputEvent：页面会检查 event.isTrusted，JS 的 .click() 无效。
 */
async function harvestLinks(
  siteId: string,
  url: string,
  selector: string,
  limit = 500,
): Promise<HarvestLink[]> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1000,
    webPreferences: {
      session: siteSession(siteId),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setUserAgent(UA);

  let resolveNav: ((u: string | null) => void) | null = null;
  const onNav = (e: { preventDefault: () => void }, target: string) => {
    e.preventDefault();
    const r = resolveNav;
    resolveNav = null;
    if (r) r(target);
  };
  win.webContents.on('will-navigate', onNav);
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    const r = resolveNav;
    resolveNav = null;
    if (r) r(u);
    return { action: 'deny' };
  });

  const clickAt = async (i: number): Promise<HarvestLink | null> => {
    const info = await win.webContents
      .executeJavaScript(
        `(() => {
          const el = document.querySelectorAll(${JSON.stringify(selector)})[${i}];
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            text: (el.textContent || '').trim(),
          };
        })()`,
      )
      .catch(() => null);
    if (!info || info.x <= 0 || info.y <= 0) return null;

    const got = new Promise<string | null>((resolve) => {
      resolveNav = resolve;
      setTimeout(() => {
        if (resolveNav === resolve) {
          resolveNav = null;
          resolve(null);
        }
      }, 1200);
    });

    win.webContents.sendInputEvent({ type: 'mouseMove', x: info.x, y: info.y });
    win.webContents.sendInputEvent({
      type: 'mouseDown',
      x: info.x,
      y: info.y,
      button: 'left',
      clickCount: 1,
    });
    win.webContents.sendInputEvent({
      type: 'mouseUp',
      x: info.x,
      y: info.y,
      button: 'left',
      clickCount: 1,
    });

    const target = await got;
    return target ? { url: target, text: String(info.text ?? '') } : null;
  };

  try {
    await Promise.race([win.loadURL(url).catch(() => undefined), delay(15_000)]);

    // 就绪条件只要求目标元素出现，不要求广告等子资源全加载完（否则每页要多等好几秒）
    const started = Date.now();
    while (Date.now() - started < 60_000) {
      const ready = await win.webContents
        .executeJavaScript(
          `(() => {
            const blocked = /altcha|aegis_altcha|Just a moment|Checking your browser/i
              .test(document.title + (document.body ? document.body.innerHTML.slice(0, 2000) : ''));
            return !blocked && !!document.querySelector(${JSON.stringify(selector)});
          })()`,
        )
        .catch(() => false);
      if (ready) break;
      await delay(300);
    }
    await delay(400); // 留一点时间给点击处理器绑定

    const total = Number(
      await win.webContents
        .executeJavaScript(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
        .catch(() => 0),
    );

    const n = Math.min(total, limit);
    const results: (HarvestLink | null)[] = [];
    for (let i = 0; i < n; i++) results.push(await clickAt(i));

    // 有漏掉的（处理器还没绑好）再补一轮
    const misses = results.map((r, i) => (r ? -1 : i)).filter((i) => i >= 0);
    if (misses.length) {
      await delay(600);
      for (const i of misses) results[i] = await clickAt(i);
    }

    const out: HarvestLink[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      if (r && !seen.has(r.url)) {
        seen.add(r.url);
        out.push(r);
      }
    }
    return out;
  } finally {
    win.webContents.removeListener('will-navigate', onNav);
    win.destroy();
  }
}

/**
 * 播放页的播放器多半是 JS 动态生成 iframe，
 * 这里打开真实页面，监听网络请求把 m3u8 / mp4 截下来（相当于 ani 的 WebVideoMatcher）。
 *
 * 除了网络请求，还按订阅配置扫描 DOM（video/source/iframe/performance）与内联脚本，
 * 并在命中 matchNestedUrl 时打开嵌套播放页继续嗅探。
 */
async function captureMedia(
  siteId: string,
  pageUrl: string,
  opts: {
    timeoutMs?: number;
    pattern?: string;
    nestedPattern?: string;
    userAgent?: string;
    cookies?: string;
    scanDomMediaUrls?: boolean;
    scanInlineScriptUrls?: boolean;
  } = {},
): Promise<{ url: string; referer?: string } | null> {
  const ses = siteSession(siteId);
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const ua = opts.userAgent?.trim() || UA;
  win.webContents.setUserAgent(ua);

  /** 把订阅里的 Java 正则转成 JS（处理内联 (?i)） */
  const compile = (p?: string): RegExp | null => {
    if (!p) return null;
    let src = p.trim();
    let flags = '';
    const inline = /^\(\?([ims]+)\)/.exec(src);
    if (inline) {
      flags = inline[1].replace(/[^ims]/g, '');
      src = src.slice(inline[0].length);
    }
    try {
      return new RegExp(src, flags);
    } catch {
      return null;
    }
  };

  const pattern = compile(opts.pattern);
  const nested = compile(opts.nestedPattern);
  let found: { url: string; referrer?: string } | null = null;
  let pendingNested: string | null = null;
  const visited = new Set<string>([pageUrl]);

  /** 判断一个地址是否就是媒体地址（或包含它的播放器页） */
  const consider = (raw: string, referrer: string): void => {
    if (found || !raw) return;
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return;
    const candidates: string[] = [raw];
    try {
      const inner = new URL(raw).searchParams.get('url');
      if (inner) candidates.push(inner);
    } catch {
      /* ignore */
    }

    for (const c of candidates) {
      if (pattern) {
        const m = pattern.exec(c);
        if (m) {
          found = {
            url: (m.groups as Record<string, string> | undefined)?.v ?? c,
            referrer,
          };
          return;
        }
        // 嵌套播放页：先把内层地址挖出来再试
        if (nested && nested.test(raw)) {
          try {
            const inner = new URL(raw).searchParams.get('url');
            if (inner && pattern.test(inner)) {
              found = { url: inner, referrer: raw };
              return;
            }
          } catch {
            /* ignore */
          }
        }
      } else if (/\.(m3u8|mp4|flv|mkv)(\?|$)/i.test(c) && !/\.html?($|\?)/i.test(c)) {
        found = { url: c, referrer };
        return;
      }
    }

    // 命中嵌套播放页规则：记录，稍后在这个窗口里打开继续嗅探
    if (!found && nested && nested.test(raw) && !visited.has(raw) && !pendingNested) {
      pendingNested = raw;
    }
  };

  const listener = (
    details: Electron.OnBeforeRequestListenerDetails,
    callback: (r: object) => void,
  ) => {
    consider(details.url, details.referrer || pageUrl);
    callback({});
  };

  /** 播放器请求媒体时补 UA / Cookie（订阅里的 userAgent、cookies） */
  const onBeforeSendHeaders = (
    details: Electron.OnBeforeSendHeadersListenerDetails,
    callback: (r: object) => void,
  ) => {
    const headers: Record<string, string> = { ...details.requestHeaders };
    if (opts.userAgent?.trim()) headers['User-Agent'] = opts.userAgent.trim();
    if (opts.cookies?.trim()) {
      const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie') ?? 'Cookie';
      headers[key] = headers[key] ? `${headers[key]}; ${opts.cookies.trim()}` : opts.cookies.trim();
    }
    callback({ requestHeaders: headers });
  };

  const scanPage = async (): Promise<void> => {
    if (opts.scanDomMediaUrls) {
      const urls = await win.webContents
        .executeJavaScript(
          `(() => {
            const out = [];
            for (const v of document.querySelectorAll('video, source')) {
              if (v.currentSrc) out.push(v.currentSrc);
              if (v.src) out.push(v.src);
            }
            for (const f of document.querySelectorAll('iframe[src]')) out.push(f.src);
            try {
              for (const e of performance.getEntriesByType('resource')) out.push(e.name);
            } catch (_) {}
            return out;
          })()`,
        )
        .catch(() => [] as string[]);
      for (const u of urls as string[]) consider(u, pageUrl);
    }

    if (opts.scanInlineScriptUrls && pattern && !found) {
      const html = await win.webContents
        .executeJavaScript('document.documentElement.outerHTML')
        .catch(() => '');
      const m = pattern.exec(html);
      if (m) {
        found = {
          url: (m.groups as Record<string, string> | undefined)?.v ?? m[0],
          referrer: pageUrl,
        };
      }
    }
  };

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, listener);
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, onBeforeSendHeaders);

  try {
    await Promise.race([win.loadURL(pageUrl).catch(() => undefined), delay(8_000)]);

    const timeout = opts.timeoutMs ?? 15_000;
    const started = Date.now();
    let lastScan = 0;
    while (Date.now() - started < timeout && !found) {
      if (pendingNested) {
        const next = pendingNested;
        pendingNested = null;
        if (next && !visited.has(next)) {
          visited.add(next);
          await Promise.race([win.loadURL(next).catch(() => undefined), delay(8_000)]);
          await delay(600);
          continue;
        }
      }

      // 每 1.5 秒扫一次页面，覆盖 fetch/XHR 拿不到的地址
      if (Date.now() - lastScan > 1500) {
        lastScan = Date.now();
        await scanPage();
        if (found) break;
      }
      await delay(300);
    }

    if (!found) await scanPage();

    return found;
  } finally {
    ses.webRequest.onBeforeRequest(null);
    ses.webRequest.onBeforeSendHeaders(null);
    win.destroy();
  }
}

/**
 * 打开可见窗口，让用户亲自过一次人机验证（Cloudflare Turnstile 等）。
 * 通过后 cf_clearance 会存进该站点的分区，之后隐藏窗口的请求也能复用。
 */
async function verifySite(siteId: string, url: string): Promise<boolean> {
  const ses = siteSession(siteId);
  const win = new BrowserWindow({
    width: 1180,
    height: 880,
    title: '完成站点验证',
    webPreferences: { session: ses, contextIsolation: true, sandbox: true },
  });
  win.webContents.setUserAgent(UA);
  await win.loadURL(url).catch(() => undefined);

  const started = Date.now();
  let hardBlockedSince = 0;
  while (Date.now() - started < 300_000) {
    await delay(1000);
    if (win.isDestroyed()) return false;

    const clearance = await ses.cookies.get({ name: 'cf_clearance' }).catch(() => []);
    const state = await win.webContents
      .executeJavaScript(
        `({ title: document.title || '', text: (document.body && document.body.innerText || '').slice(0, 1200) })`,
      )
      .catch(() => ({ title: '', text: '' }));
    const info = `${state.title}\n${state.text}`;
    const hardBlocked = /you have been blocked|Attention Required|cf-error-details|Ray ID|Access denied/i.test(info);
    const challenge = /请稍候|Just a moment|Checking|安全验证|Verify you are human|Turnstile/i.test(info);

    if (hardBlocked) {
      // IP 级拦截不是验证码：给用户一点时间换网络/重开，但不要傻等 5 分钟
      if (!hardBlockedSince) hardBlockedSince = Date.now();
      if (Date.now() - hardBlockedSince > 15_000) {
        win.destroy();
        return false;
      }
      continue;
    }
    hardBlockedSince = 0;

    const passed = clearance.length > 0 || (!!state.title && !challenge);
    if (passed) {
      win.destroy();
      return true;
    }
  }

  if (!win.isDestroyed()) win.destroy();
  return false;
}

function openSiteWindow(siteId: string, url: string): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    title: url,
    webPreferences: {
      session: siteSession(siteId),
      sandbox: true,
      contextIsolation: true,
    },
  });
  win.webContents.setUserAgent(UA);
  win.loadURL(url).catch(() => undefined);
}

function registerIpc(): void {
  ipcMain.handle('agg:fetch', (_e, siteId: string, url: string, referer?: string) =>
    fetchHtml(siteId, url, referer),
  );
  ipcMain.handle('agg:request', (_e, siteId: string, url: string, opts?: HttpRequestOpts) =>
    requestHttp(siteId, url, opts),
  );
  ipcMain.handle(
    'agg:render',
    (_e, siteId: string, url: string, opts?: { waitFor?: string; timeoutMs?: number; scroll?: boolean }) =>
      renderHtml(siteId, url, opts),
  );
  ipcMain.handle('agg:open', (_e, siteId: string, url: string) => {
    openSiteWindow(siteId, url);
  });
  ipcMain.handle('agg:harvest', (_e, siteId: string, url: string, selector: string, limit?: number) =>
    harvestLinks(siteId, url, selector, limit),
  );
  ipcMain.handle(
    'agg:capture',
    (
      _e,
      siteId: string,
      url: string,
      opts?: {
        timeoutMs?: number;
        pattern?: string;
        nestedPattern?: string;
        userAgent?: string;
        cookies?: string;
        scanDomMediaUrls?: boolean;
        scanInlineScriptUrls?: boolean;
      },
    ) => captureMedia(siteId, url, opts),
  );
  ipcMain.handle('agg:verify', (_e, siteId: string, url: string) => verifySite(siteId, url));
  ipcMain.handle(
    'agg:submit',
    (
      _e,
      siteId: string,
      pageUrl: string,
      actionUrl: string,
      fields: Record<string, string>,
      opts?: { waitFor?: string; timeoutMs?: number },
    ) => submitForm(siteId, pageUrl, actionUrl, fields, opts),
  );
  ipcMain.handle('agg:external', (_e, url: string) => shell.openExternal(url));

  ipcMain.handle('agg:clear-site', async (_e, siteId: string) => {
    const s = siteSessions.get(siteId);
    if (!s) return;
    await s.clearStorageData().catch(() => undefined);
    await s.clearCache().catch(() => undefined);
  });

  ipcMain.handle('agg:app-info', () => ({
    version: app.getVersion(),
    hotVersion: readHotCurrent()?.version,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
  }));

  ipcMain.handle('agg:hot-check', () => checkHotUpdate());
  ipcMain.handle('agg:hot-apply', (_e, version: string) => applyHotUpdate(version));

  ipcMain.handle('agg:open-data', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('agg:login-item', (_e, enabled: boolean) => {
    if (PORTABLE_DIR) return;
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
  });

  ipcMain.handle('agg:tray', (_e, enabled: boolean) => applyTray(!!enabled));

  ipcMain.handle('agg:proxy', () => session.defaultSession.resolveProxy('https://mycomic.com'));

  ipcMain.handle('agg:network', (_e, opts: { timeoutMs?: number }) => {
    const n = Number(opts?.timeoutMs);
    if (Number.isFinite(n)) networkTimeoutMs = Math.max(5_000, Math.min(90_000, n));
  });
}

function applyTray(enabled: boolean): void {
  trayEnabled = enabled;
  if (!enabled) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (tray) return;

  const candidates = [
    path.join(process.resourcesPath, 'app.ico'),
    path.resolve(__dirname, '../../../assets/app.ico'),
    path.resolve(process.cwd(), 'assets/app.ico'),
  ];
  let icon = nativeImage.createEmpty();
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      icon = nativeImage.createFromPath(p);
      if (!icon.isEmpty()) break;
    }
  }
  try {
    tray = new Tray(icon);
  } catch {
    trayEnabled = false;
    tray = null;
    return;
  }
  tray.setToolTip('聚合阅读');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: () => mainWindow?.show() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => mainWindow?.show());
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0f1115',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (process.env.AGG_SMOKE && mainWindow) runSmoke(mainWindow);
  });
  // 视频 CDN 常按 UA 拒绝非浏览器请求
  mainWindow.webContents.setUserAgent(UA);
  mainWindow.loadURL('agg://app/index.html');

  if (DEV) {
    // 重建完成即刷新，近似热更新
    let timer: NodeJS.Timeout | undefined;
    fs.watch(path.join(__dirname, 'renderer.js'), () => {
      clearTimeout(timer);
      timer = setTimeout(() => mainWindow?.webContents.reloadIgnoringCache(), 120);
    });
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('close', (e) => {
    if (trayEnabled && !quitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

const menu = Menu.buildFromTemplate([
  {
    label: '视图',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  },
]);

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(UA);
  hotRoot = readHotCurrent()?.root ?? null;

  protocol.handle('agg', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = resolveAggFile(rel);
    const base = path.resolve(__dirname);
    if (file !== base && !file.startsWith(base + path.sep) && !(hotRoot && file.startsWith(hotRoot + path.sep))) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });

  protocol.handle('aggmedia', async (request) => {
    const url = new URL(request.url);
    const target = url.searchParams.get('u');
    if (!target) return new Response('missing u', { status: 400 });

    const referer = url.searchParams.get('r') || '';
    const ua = url.searchParams.get('ua') || UA;
    const cookies = url.searchParams.get('ck') || '';
    const headers: Record<string, string> = {
      'user-agent': ua,
      accept: '*/*',
      'accept-language': 'zh-CN,zh;q=0.9',
    };
    if (referer) headers.referer = referer;
    if (cookies) headers.cookie = cookies;
    const range = request.headers.get('range');
    if (range) headers.range = range;

    let upstream: Response;
    try {
      // 必须用 net.fetch（Chromium 网络栈，会走系统代理）；Node 的 fetch 不走系统代理，
      // 在有代理的环境里直连 CDN 会超时，表现为播放器一直 0:00。
      upstream = await net.fetch(target, { headers, redirect: 'follow' });
    } catch (e) {
      return new Response('upstream error: ' + (e as Error).message, { status: 502 });
    }

    const ctype = upstream.headers.get('content-type') || '';
    const isPlaylist = /mpegurl/i.test(ctype) || /\.m3u8(\?|$)/i.test(target);

    if (isPlaylist) {
      const text = await upstream.text();
      return new Response(rewritePlaylist(text, target, referer, ua, cookies), {
        status: upstream.status,
        headers: {
          'content-type': 'application/vnd.apple.mpegurl',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      });
    }

    // mp4 这类由 <video> 直接加载的文件必须原样返回上游 Response：
    // 重新包装成 new Response(stream) 会让 Chromium 媒体加载器报 MEDIA_ERR_SRC_NOT_SUPPORTED。
    const isDirectVideo =
      /^video\/(mp4|x-m4v|webm|quicktime)/i.test(ctype) ||
      /\.(mp4|m4v|webm|mov)(\?|$)/i.test(target);
    if (isDirectVideo) return upstream;

    const body = upstream.body;
    const out = new Headers({
      'content-type': ctype || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
    });
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) out.set('content-length', contentLength);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) out.set('content-range', contentRange);
    // 图片/HLS 分片是重复访问最多的资源，交给 Chromium HTTP 缓存
    if (/^image\//i.test(ctype)) {
      out.set('cache-control', 'public, max-age=604800, immutable');
    } else if (/\.(ts|m4s)(\?|$)/i.test(target) || /video\/(mp2t|iso\.segment)/i.test(ctype)) {
      out.set('cache-control', 'public, max-age=86400');
    }

    // 分片（.ts / .m4s 等）由 hls.js 用 fetch 读取，需要补 CORS；仍然流式透传
    return new Response(body, { status: upstream.status, headers: out });
  });

  Menu.setApplicationMenu(menu);
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (trayEnabled) return;
  if (process.platform !== 'darwin') app.quit();
});
