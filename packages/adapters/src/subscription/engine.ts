import {
  clean,
  qs,
  removeSpecials,
  text,
  toParagraphs,
  videoKindOf,
} from '@agg/core';
import type { BookDetail, BookRef, BookSection, Chapter, ChapterContent, Site, SiteCtx } from '@agg/core';
import type { RawSource, SearchConfig } from './config.ts';
import { autoMatchOf, finalBaseUrl, guessBaseUrl } from './config.ts';
import { jsonPath } from './jsonpath.ts';
import {
  applyLinkTemplate,
  parseChapters,
  parseIntro,
  parseSubjectAnchors,
  parseSubjectTitle,
  resolveHref,
} from './format.ts';
import { buildJsonApiSite } from './jsonapi.ts';

function siteColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 52%)`;
}

/** 搜索关键词归一化，对齐 ani `MediaSourceEngineHelpers.getSearchKeyword` */
export function normalizeKeyword(keyword: string, cfg: SearchConfig): string {
  const am = autoMatchOf(cfg);
  let word = am.searchRemoveSpecial
    ? removeSpecials(keyword, { removeWhitespace: false, replaceNumbers: false, removeMarkers: true })
    : keyword;
  word = word.trim();
  if (am.searchUseOnlyFirstWord) {
    const first = word.split(/\s+/)[0];
    if (first) word = first;
  }
  return word;
}

function asString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string' || typeof value === 'number') {
    const s = String(value).trim();
    return s || undefined;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const s = asString(v);
      if (s) return s;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) {
      const s = asString(v);
      if (s) return s;
    }
  }
  return undefined;
}

/** 从搜索结果卡片上抓封面（各模板类名不同，做通用兜底） */
function cardCover(a: HTMLAnchorElement, baseUrl: string): string | undefined {
  const card =
    a.closest(
      'li, .module-card-item, .public-list-box, .fed-list-item, .myui-vodlist__media, .thumb-content, .stui-vodlist__box, .video-info',
    ) ?? a.parentElement;
  const img = card?.querySelector('img');
  if (!img) return undefined;
  const raw =
    img.getAttribute('data-original') ??
    img.getAttribute('data-src') ??
    img.getAttribute('src') ??
    undefined;
  return raw ? resolveHref(baseUrl, clean(raw)) : undefined;
}

async function searchByJsonPath(
  ctx: SiteCtx,
  url: string,
  cfg: SearchConfig,
): Promise<BookRef[]> {
  const raw = await ctx.html(url);
  let data: unknown;
  try {
    data = JSON.parse(raw.replace(/^\uFEFF/, '').trim());
  } catch {
    return [];
  }
  const jp = cfg.selectorSubjectFormatJsonPathIndexed;
  const ids = jp?.selectLinks ? jsonPath(data, jp.selectLinks) : [];
  const names = jp?.selectNames ? jsonPath(data, jp.selectNames) : [];
  const out: BookRef[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i++) {
    const rawLink = asString(ids[i]);
    if (!rawLink) continue;
    const href = applyLinkTemplate(jp?.linkTemplate, rawLink);
    const abs = resolveHref(ctx.site.baseUrl, href);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, title: asString(names[i]) ?? rawLink });
  }
  return out;
}

export function buildSite(src: RawSource): Site | null {
  if (src.factoryId === 'json-api') return buildJsonApiSite(src);
  if (src.factoryId && src.factoryId !== 'web-selector') return null;

  const args = src.arguments ?? {};
  const cfg: SearchConfig = args.searchConfig ?? {};
  if (!cfg.searchUrl) return null;

  const baseUrl = finalBaseUrl(cfg);
  if (!baseUrl) return null;
  const searchOrigin = guessBaseUrl(cfg.searchUrl);
  if (!searchOrigin) return null;

  const name = clean(args.name ?? src.id) || src.id;
  const autoMatch = autoMatchOf(cfg);
  const format = cfg.subjectFormatId ?? 'a';

  async function search(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
    const word = normalizeKeyword(keyword, cfg);
    const url = cfg.searchUrl!.replace('{keyword}', encodeURIComponent(word));

    if (format === 'json-path-indexed') return searchByJsonPath(ctx, url, cfg);

    const doc = await ctx.doc(url);
    const anchors = parseSubjectAnchors(doc, cfg);
    const out: BookRef[] = [];
    const seen = new Set<string>();
    for (const item of anchors) {
      const abs = resolveHref(baseUrl, item.href);
      if (!abs || seen.has(abs)) continue;
      seen.add(abs);
      out.push({
        url: abs,
        title: item.title,
        cover: item.el instanceof HTMLAnchorElement ? cardCover(item.el, baseUrl) : undefined,
      });
    }
    return out;
  }

  return {
    id: `sub:${src.id}`,
    name,
    icon: name.slice(0, 1),
    color: siteColor(src.id),
    baseUrl,
    kind: 'anime',
    referer: searchOrigin + '/',
    sourceTier: args.tier,
    channelTiers: args.channelTiers,
    autoMatch,
    defaultResolution: cfg.defaultResolution,

    async home(): Promise<BookSection[]> {
      // 订阅源不提供首页板块；动画首页由资源站 + Bangumi 新番撑起来
      return [];
    },

    search,

    async detail(ctx, url): Promise<BookDetail> {
      const doc = await ctx.doc(url);
      const title = parseSubjectTitle(doc, url);
      if (!title) throw new Error('没有解析到标题，页面可能已改版');

      const parsed = parseChapters(doc, cfg);
      const chapters: Chapter[] = [];
      const seen = new Set<string>();
      for (const ep of parsed.chapters) {
        const abs = resolveHref(baseUrl, ep.href);
        if (!abs || seen.has(abs)) continue;
        seen.add(abs);
        chapters.push({
          title: ep.title,
          url: abs,
          sort: ep.sort,
          channel: ep.channel,
          order: ep.order,
        });
      }

      const og = qs(doc, 'meta[property="og:image"]')?.getAttribute('content');
      const intro = parseIntro(doc) ?? toParagraphs(qs(doc, '.module-info-introduction, .info, #desc')).join('\n');
      return {
        url,
        title,
        cover: og ? resolveHref(baseUrl, og) : cardCoverFirst(doc, baseUrl),
        intro: intro || undefined,
        chapters,
        channels: parsed.channels,
      };
    },

    async chapter(ctx, url): Promise<ChapterContent> {
      const mv = cfg.matchVideo ?? {};
      const media = await ctx.capture(url, {
        timeoutMs: 20_000,
        pattern: mv.matchVideoUrl,
        nestedPattern: mv.enableNestedUrl ? mv.matchNestedUrl : undefined,
        userAgent: cfg.userAgent?.trim() || mv.addHeadersToVideo?.userAgent,
        cookies: mv.cookies,
        scanDomMediaUrls: mv.scanDomMediaUrls,
        scanInlineScriptUrls: mv.scanInlineScriptUrls,
      });
      if (!media) throw new Error('播放页没有截到媒体地址，可能需要先在站点内验证');

      const kind = videoKindOf(media.url);
      return {
        title: '',
        paragraphs: [],
        video: {
          url: media.url,
          kind,
          referer: mv.addHeadersToVideo?.referer || media.referer || baseUrl + '/',
          userAgent: cfg.userAgent?.trim() || mv.addHeadersToVideo?.userAgent,
          cookies: mv.cookies,
        },
      };
    },
  };
}

function cardCoverFirst(doc: ParentNode, baseUrl: string): string | undefined {
  const img = doc.querySelector('img');
  const raw = img?.getAttribute('data-src') ?? img?.getAttribute('src') ?? undefined;
  return raw ? resolveHref(baseUrl, raw) : undefined;
}

/** 供 UI 判断该源当前平台能否播放（订阅里的 onlySupportsPlayers） */
export function isSupportedByPlatform(players: string[] | undefined): boolean {
  if (!players || players.length === 0) return true;
  const current = ['chromium', 'hlsjs', 'mpv', 'vlc', 'web'];
  return players.some((p) => current.includes(p.toLowerCase()));
}

/** 供调试/测试：解析一个订阅源，不做网络请求 */
export { parseChapters, parseSubjectAnchors };
