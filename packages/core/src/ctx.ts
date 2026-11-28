import { runtime } from './runtime.ts';
import type {
  CaptureOpts,
  DocOpts,
  FetchResult,
  FormOpts,
  HarvestLink,
  HostBridge,
  HttpRequestOpts,
  HttpResponse,
  MediaCapture,
  Site,
  SiteCtx,
} from './types.ts';
import { absUrl, parseHtml, stripOverlays } from './dom.ts';

/** 常见的人机验证 / 拦截页特征 */
const BLOCK_RE =
  /aegis_altcha|altcha-widget|cf-challenge|__cf_chl|Just a moment|Checking your browser|cf-browser-verification|Verification<\/title>|请稍候|安全验证|正在进行安全验证|you have been blocked|Attention Required|cf-error-details|Ray ID|Access denied/i;

export function looksBlocked(html: string, status: number): boolean {
  if (status === 403 || status === 429 || status === 503) return true;
  // JSON 接口（订阅里的 json-path / json-api）经常很短，不是拦截页
  const head = html.trimStart().slice(0, 1);
  if (head === '{' || head === '[') return false;
  if (html.length < 400) return true;
  return BLOCK_RE.test(html);
}

const MAX_CACHE = 64;

/**
 * 生成站点上下文。
 * 静态请求优先，只有被拦截 / 明确需要 JS / 强制渲染时才启动真实浏览器，
 * 这样章节页这种高频请求不会每次都吃一次渲染开销。
 */
export function createCtx(bridge: HostBridge, site: Site): SiteCtx {
  const cache = new Map<string, { html: string; at: number }>();

  async function html(url: string, opts: DocOpts = {}): Promise<string> {
    const key = (opts.render ? 'R|' : 'F|') + (opts.scroll ? 'S|' : '') + url;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < runtime.htmlTtlMs) return hit.html;

    let res: FetchResult | null = null;

    if (!opts.render && !site.needsRender) {
      try {
        res = await bridge.fetchHtml(site.id, url, site.referer ?? site.baseUrl);
      } catch {
        res = null;
      }
    }

    if (!res || looksBlocked(res.html, res.status)) {
      res = await bridge.renderHtml(site.id, url, {
        waitFor: site.renderWait,
        timeoutMs: 45_000,
        scroll: opts.scroll,
      });
      if (looksBlocked(res.html, res.status)) {
        throw new Error(`${site.name}：页面被安全校验拦截，请先打开站点完成验证`);
      }
    }

    cache.set(key, { html: res.html, at: Date.now() });
    if (cache.size > MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    return res.html;
  }

  async function doc(url: string, opts: DocOpts = {}): Promise<Document> {
    const d = parseHtml(await html(url, opts));
    stripOverlays(d);
    return d;
  }

  async function harvest(url: string, selector: string, limit?: number): Promise<HarvestLink[]> {
    return bridge.harvestLinks(site.id, url, selector, limit);
  }

  async function request(url: string, opts: HttpRequestOpts = {}): Promise<HttpResponse> {
    return bridge.request(site.id, url, opts);
  }

  async function json<T = unknown>(url: string, opts: HttpRequestOpts = {}): Promise<T> {
    const res = await request(url, {
      ...opts,
      headers: { accept: 'application/json, text/plain, */*', ...(opts.headers ?? {}) },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}：${url}`);
    }
    const raw = res.body.replace(/^\uFEFF/, '').trim();
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`接口返回的不是 JSON：${url}`);
    }
  }

  async function submit(
    pageUrl: string,
    actionUrl: string,
    fields: Record<string, string>,
    opts: FormOpts = {},
  ): Promise<Document> {
    const res = await bridge.submitForm(site.id, pageUrl, actionUrl, fields, opts);
    const d = parseHtml(res.html);
    stripOverlays(d);
    return d;
  }

  async function capture(pageUrl: string, opts: CaptureOpts = {}): Promise<MediaCapture | null> {
    return bridge.captureMedia(site.id, pageUrl, opts);
  }

  async function verify(url: string): Promise<boolean> {
    const ok = await bridge.verifySite(site.id, url);
    if (ok) cache.clear();
    return ok;
  }

  return {
    site,
    doc,
    html,
    request,
    json,
    harvest,
    submit,
    capture,
    verify,
    abs: (href) => absUrl(href, site.baseUrl),
    clearCache: () => cache.clear(),
  };
}
