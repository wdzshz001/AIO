import { clean, qs, qsa, text } from '@agg/core';
import type {
  BookDetail,
  BookRef,
  BookSection,
  Chapter,
  ChapterContent,
  Site,
  SiteCtx,
} from '@agg/core';
import { proxyImage } from '../image.ts';

/**
 * MYCOMIC 我的漫画（https://mycomic.com）。
 *
 * 结构：
 * - 列表：`/cn/comics?sort=-update`、`/cn/comics?q={keyword}`
 * - 详情：`/cn/comics/{id}`，章节列表内嵌在 `x-data="{ chapters: [...] }"`
 * - 章节：`/cn/chapters/{id}`，正文是一组 `biccam.com/chapters/{id}/...` 图片
 * - 封面/图片 CDN 校验 Referer，统一走 aggmedia 图片代理
 *
 * 注意：mycomic.com 在部分网络会被 Cloudflare 拦截（静态 403）。
 * `ctx.doc` 会自动切真实浏览器；仍失败时由 UI 提供「验证」入口。
 */

const BASE = 'https://mycomic.com';
const REFERER = BASE + '/';

function absolute(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const raw = url.trim();
  if (!raw) return undefined;
  if (raw.startsWith('//')) return 'https:' + raw;
  try {
    return new URL(raw, BASE).toString();
  } catch {
    return undefined;
  }
}

function comicId(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = /\/cn\/comics\/(\d+)/.exec(href) ?? /\/comics\/(\d+)/.exec(href);
  return m ? m[1] : null;
}

function comicUrl(id: string): string {
  return `${BASE}/cn/comics/${id}`;
}

/** 列表卡片上的「第1150话」「短篇 [完]」等不是漫画名 */
function isChapterLabel(text: string): boolean {
  return /^(第\s*[0-9一二三四五六七八九十百千零两]+\s*[话話卷章回]|番外|完结加页|短篇|预览|序章|楔子)/.test(
    text.trim(),
  );
}

function cardTitle(a: HTMLAnchorElement, root: Element): string {
  const alt = clean(qs<HTMLImageElement>(root, 'img[alt]')?.getAttribute('alt') ?? '');
  const subheading = clean(text(qs(root, '[data-flux-subheading]')));
  const heading = clean(text(qs(root, 'h1, h2, h3')));
  const candidates = [
    clean(a.getAttribute('title') ?? ''),
    alt,
    subheading,
    heading,
    clean(a.textContent ?? ''),
  ].filter(Boolean);

  // 优先取漫画名；「第xx话」这类章节文字只作为最后兜底，且不允许覆盖真书名
  for (const candidate of candidates) {
    if (!isChapterLabel(candidate)) return candidate;
  }
  return '';
}

function parseCards(doc: ParentNode): BookRef[] {
  const out: BookRef[] = [];
  const seen = new Set<string>();
  for (const a of qsa<HTMLAnchorElement>(doc, 'a[href*="/comics/"]')) {
    const href = a.getAttribute('href');
    const id = comicId(href);
    if (!id || seen.has(id)) continue;
    const root =
      a.closest('div.group, article, li, [class*="card"]') ??
      a.parentElement?.parentElement ??
      a.parentElement ??
      a;
    const title = cardTitle(a, root);
    if (!title) continue;
    seen.add(id);
    const img = qs<HTMLImageElement>(root, 'img');
    const rawCover =
      img?.getAttribute('data-src') ??
      img?.getAttribute('src') ??
      undefined;
    out.push({
      url: comicUrl(id),
      title,
      cover: proxyImage(absolute(rawCover), REFERER),
    });
  }
  return out;
}

/** 从字符串里截出 marker 之后的第一个 JSON 数组（支持嵌套） */
function extractArrayAfter(text: string, marker: string): string | null {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  const start = text.indexOf('[', at + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseChapters(doc: Document): Chapter[] {
  // chapters 数组在某个元素的 x-data 属性里；取属性原文，避免 outerHTML 把引号转成 &quot;
  let data = '';
  for (const el of qsa(doc, '[x-data]')) {
    const value = el.getAttribute('x-data') ?? '';
    if (value.includes('chapters:')) {
      data = value;
      break;
    }
  }
  if (!data) data = doc.documentElement.outerHTML;

  const raw = extractArrayAfter(data, 'chapters:');
  if (!raw) return [];
  let list: { id?: number | string; title?: string }[] = [];
  try {
    list = JSON.parse(raw) as { id?: number | string; title?: string }[];
  } catch {
    return [];
  }
  const decending = /decending:\s*true/.test(data);
  const chapters: Chapter[] = [];
  for (const c of list) {
    const id = c.id != null ? String(c.id) : '';
    const title = clean(c.title ?? '');
    if (!id || !title) continue;
    chapters.push({ title, url: `${BASE}/cn/chapters/${id}` });
  }
  // `decending: true` 表示数组是「最新在前」，阅读顺序需要反转
  return decending ? chapters.reverse() : chapters;
}

function parseJsonLd(doc: Document): Record<string, unknown> | null {
  for (const s of qsa<HTMLScriptElement>(doc, 'script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent ?? '') as Record<string, unknown>;
      const type = data['@type'];
      const types = Array.isArray(type) ? type : [type];
      if (types.includes('ComicSeries') || types.includes('ComicIssue')) return data;
    } catch {
      /* ignore */
    }
  }
  return null;
}

const homeCache = new Map<string, { at: number; sections: BookSection[] }>();
const chapterCache = new Map<string, { at: number; content: ChapterContent }>();
const TTL = 30 * 60_000;

async function homeMycomic(ctx: SiteCtx): Promise<BookSection[]> {
  const hit = homeCache.get('home');
  if (hit && Date.now() - hit.at < TTL) return hit.sections;

  const [latestDoc, popularDoc] = await Promise.all([
    ctx.doc(`${BASE}/cn/comics?sort=-update`),
    ctx.doc(`${BASE}/cn/comics?sort=-views`),
  ]);
  const latest = parseCards(latestDoc);
  const popular = parseCards(popularDoc);
  const sections: BookSection[] = [];
  if (latest.length) sections.push({ title: '最近更新', books: latest.slice(0, 24) });
  if (popular.length) sections.push({ title: '人气漫画', books: popular.slice(0, 24) });
  homeCache.set('home', { at: Date.now(), sections });
  return sections;
}

async function searchMycomic(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
  const doc = await ctx.doc(`${BASE}/cn/comics?q=${encodeURIComponent(keyword)}`);
  return parseCards(doc).slice(0, 40);
}

async function detailMycomic(ctx: SiteCtx, url: string): Promise<BookDetail> {
  const doc = await ctx.doc(url);
  const ld = parseJsonLd(doc);
  const title =
    clean(String(ld?.name ?? '')) ||
    clean(text(qs(doc, 'h1'))) ||
    clean((doc.title || '').split(/\s+-\s+/)[0]);
  if (!title) throw new Error('没有解析到漫画标题');

  const authors = ld?.author;
  const author = Array.isArray(authors)
    ? clean(String((authors[0] as { name?: string })?.name ?? ''))
    : clean(String((authors as { name?: string })?.name ?? ''));

  const keywords = Array.isArray(ld?.keywords)
    ? (ld.keywords as unknown[]).map(String).filter(Boolean)
    : [];
  const cover = String(ld?.thumbnailUrl ?? ld?.image ?? '');
  const description = clean(String(ld?.description ?? '')) || undefined;
  const chapters = parseChapters(doc);

  return {
    url,
    title,
    author: author || undefined,
    cover: proxyImage(absolute(cover), REFERER),
    intro: description,
    extra: keywords.length ? keywords.join(' · ') : undefined,
    chapters,
  };
}

async function chapterMycomic(ctx: SiteCtx, url: string): Promise<ChapterContent> {
  const hit = chapterCache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.content;

  const doc = await ctx.doc(url);
  const rawImages = qsa<HTMLImageElement>(doc, 'img')
    .map((img) => img.getAttribute('data-src') ?? img.getAttribute('src') ?? '')
    .map((src) => absolute(src))
    .filter((src): src is string => !!src && /biccam\.com\/chapters\//i.test(src));

  // 按图片文件名前的序号排序（1-xxxx.jpg、2-xxxx.jpg…）
  rawImages.sort((a, b) => {
    const na = Number(/(?:^|\/)(\d+)-[^/]+$/.exec(a)?.[1] ?? 0);
    const nb = Number(/(?:^|\/)(\d+)-[^/]+$/.exec(b)?.[1] ?? 0);
    return na - nb;
  });

  const images: string[] = [];
  const seen = new Set<string>();
  for (const src of rawImages) {
    const proxied = proxyImage(src, REFERER);
    if (!proxied || seen.has(proxied)) continue;
    seen.add(proxied);
    images.push(proxied);
  }
  if (!images.length) throw new Error('这一话没有解析到图片，可能需要在站点内完成验证');

  const title =
    clean(text(qs(doc, 'h1'))) ||
    clean((doc.title || '').split(/\s+-\s+/)[0]) ||
    '漫画';
  const content: ChapterContent = { title, paragraphs: [], images };
  chapterCache.set(url, { at: Date.now(), content });
  return content;
}

const mycomic: Site = {
  id: 'mycomic',
  name: 'MYCOMIC',
  icon: 'M',
  color: '#7b5cff',
  baseUrl: BASE,
  kind: 'comic',
  nsfw: true,
  referer: REFERER,

  home: homeMycomic,
  search: searchMycomic,
  detail: detailMycomic,
  chapter: chapterMycomic,
};

export default mycomic;
