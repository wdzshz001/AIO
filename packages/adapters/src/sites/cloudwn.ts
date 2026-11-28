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
 * CloudWN 漫画（wnacg 系图集站）。
 *
 * - 首页/分类/排行都是图集列表：`/photos-index-aid-{id}.html`
 * - 一个图集 = 一部作品，内含 1..N 页图片；每页 12 张，分页
 *   `/photos-index-page-{n}-aid-{id}.html`
 * - 图片 CDN 校验 Referer，统一走 aggmedia 图片代理
 * - 搜索：`/search/?q={keyword}`
 */

const BASE = 'https://www.cloudwn.shop';
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

function albumId(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = /(?:aid-|photos-index-aid-)(\d+)/.exec(href) ?? /\/photos-[^/]*-aid-(\d+)/.exec(href);
  return m ? m[1] : null;
}

function albumUrl(id: string): string {
  return `${BASE}/photos-index-aid-${id}.html`;
}

function parseAlbums(doc: ParentNode): BookRef[] {
  const out: BookRef[] = [];
  const seen = new Set<string>();
  for (const li of qsa(doc, 'li.gallary_item')) {
    const a =
      qs<HTMLAnchorElement>(li, '.pic_box a[href]') ??
      qs<HTMLAnchorElement>(li, '.title a[href]');
    const href = a?.getAttribute('href');
    const id = albumId(href);
    if (!id || seen.has(id)) continue;
    const title = clean(
      a?.getAttribute('title') || text(qs(li, '.title a')) || text(qs(li, '.title')),
    );
    if (!title) continue;
    seen.add(id);

    const img = qs(li, 'img');
    const rawCover =
      img?.getAttribute('data-src') ?? img?.getAttribute('src') ?? undefined;
    out.push({
      url: albumUrl(id),
      title,
      cover: proxyImage(absolute(rawCover), REFERER),
      extra: clean(text(qs(li, '.info_col'))) || undefined,
    });
  }
  return out;
}

function pagesOf(doc: Document): number {
  const body = clean(doc.body?.textContent ?? '');
  const m = /(\d+)\s*張圖片/.exec(body);
  if (m) return Math.max(1, Number(m[1]));
  return 1;
}

function maxPage(doc: Document, id: string): number {
  let max = 1;
  for (const a of qsa<HTMLAnchorElement>(doc, 'a[href*="photos-index-page-"]')) {
    const href = a.getAttribute('href') ?? '';
    if (!href.includes(`aid-${id}`)) continue;
    const m = /photos-index-page-(\d+)-aid-/.exec(href);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

function pageUrl(id: string, page: number): string {
  return page <= 1
    ? albumUrl(id)
    : `${BASE}/photos-index-page-${page}-aid-${id}.html`;
}

function imagesOf(doc: Document): string[] {
  const imgs = qsa<HTMLImageElement>(
    doc,
    '.gallary_wrap li.gallary_item img, #bodywrap .gallary_wrap img',
  );
  const out: string[] = [];
  for (const img of imgs) {
    const raw = img.getAttribute('data-src') ?? img.getAttribute('src') ?? '';
    const abs = absolute(raw);
    if (!abs) continue;
    if (!/wnimg|\.(jpg|jpeg|png|webp|gif)/i.test(abs)) continue;
    const proxied = proxyImage(abs, REFERER);
    if (proxied) out.push(proxied);
  }
  return out;
}

/** 图集页只给 /data/t/ 缩略图；每张图对应一个 view 页，view 页里才是 /data/ 原图 */
function viewLinksOf(doc: Document): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of qsa<HTMLAnchorElement>(doc, '.gallary_wrap li.gallary_item .pic_box a[href]')) {
    const href = absolute(a.getAttribute('href'));
    if (!href || !/photos-view-id-\d+\.html/.test(href) || seen.has(href)) continue;
    seen.add(href);
    out.push(href);
  }
  return out;
}

async function fullImageOf(ctx: SiteCtx, viewUrl: string): Promise<string | undefined> {
  const doc = await ctx.doc(viewUrl);
  const img =
    qs<HTMLImageElement>(doc, '#picarea') ??
    qs<HTMLImageElement>(doc, 'img.photo') ??
    qs<HTMLImageElement>(doc, '#posselect img');
  const raw = img?.getAttribute('data-src') ?? img?.getAttribute('src') ?? '';
  const abs = absolute(raw);
  if (!abs) return undefined;
  // 原图必须带 view 页生成的 verify 参数，不能只从缩略图路径推
  return proxyImage(abs, REFERER);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const homeCache = new Map<string, { at: number; sections: BookSection[] }>();
const chapterCache = new Map<string, { at: number; content: ChapterContent }>();
const TTL = 30 * 60_000;

export const CLOUDWN_CATEGORIES = [
  { id: '5', name: '同人志' },
  { id: '6', name: '单行本' },
  { id: '7', name: '杂志&短篇' },
  { id: '2', name: 'CG画集' },
  { id: '37', name: 'AI图集' },
  { id: '22', name: '3D漫画' },
  { id: '3', name: 'Cosplay' },
];

export async function loadCloudwnRank(ctx: SiteCtx): Promise<BookSection[]> {
  const url = `${BASE}/albums-favorite_ranking.html`;
  const books = parseAlbums(await ctx.doc(url));
  return books.length ? [{ title: '收藏排行', books, moreUrl: url }] : [];
}

export async function loadCloudwnCategory(
  ctx: SiteCtx,
  id: string,
  name: string,
): Promise<BookSection[]> {
  const url = `${BASE}/albums-index-cate-${id}.html`;
  const books = parseAlbums(await ctx.doc(url));
  return books.length ? [{ title: `${name} · 分类`, books, moreUrl: url }] : [];
}

async function homeCloudwn(ctx: SiteCtx): Promise<BookSection[]> {
  const hit = homeCache.get('home');
  if (hit && Date.now() - hit.at < TTL) return hit.sections;

  const [latest, rank, albums] = await Promise.all([
    ctx.doc(BASE + '/').then(parseAlbums),
    ctx.doc(`${BASE}/albums-favorite_ranking.html`).then(parseAlbums),
    ctx.doc(`${BASE}/albums.html`).then(parseAlbums),
  ]);
  const sections: BookSection[] = [];
  if (latest.length) sections.push({ title: '最新更新', books: latest.slice(0, 24) });
  if (rank.length) sections.push({ title: '收藏排行', books: rank.slice(0, 24) });
  if (albums.length) sections.push({ title: '全部漫画', books: albums.slice(0, 24) });
  homeCache.set('home', { at: Date.now(), sections });
  return sections;
}

async function searchCloudwn(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
  const doc = await ctx.doc(`${BASE}/search/?q=${encodeURIComponent(keyword)}`);
  return parseAlbums(doc).slice(0, 40);
}

/** 合集页：章节目录在 a[data-chid] 里，点进去是单话 album */
function seriesChaptersOf(doc: Document): Chapter[] {
  const out: Chapter[] = [];
  const seen = new Set<string>();
  for (const a of qsa<HTMLAnchorElement>(doc, 'a[data-chid][href*="photos-slide"]')) {
    const chid = a.getAttribute('data-chid');
    if (!chid || seen.has(chid)) continue;
    seen.add(chid);
    const title = clean(text(a)) || `第 ${out.length + 1} 话`;
    out.push({
      title,
      url: `${BASE}/photos-index-aid-${chid}.html`,
      order: out.length,
    });
  }
  return out;
}

function coverOf(doc: Document): string | undefined {
  const firstImg = qs<HTMLImageElement>(doc, '.gallary_wrap li.gallary_item img');
  return (
    qs<HTMLMetaElement>(doc, 'meta[property="og:image"]')?.getAttribute('content') ??
    firstImg?.getAttribute('data-src') ??
    firstImg?.getAttribute('src') ??
    undefined
  );
}

async function detailCloudwn(ctx: SiteCtx, url: string): Promise<BookDetail> {
  const doc = await ctx.doc(url);
  const id = albumId(url);
  if (!id) throw new Error('无法识别漫画编号');
  const title =
    clean(qs<HTMLMetaElement>(doc, 'meta[property="og:title"]')?.getAttribute('content')) ||
    clean((doc.title || '').split(/\s+-\s+/)[0]) ||
    clean(text(qs(doc, 'h1')));
  if (!title) throw new Error('没有解析到漫画标题');

  const series = seriesChaptersOf(doc);
  let rawCover = coverOf(doc);
  // 合集页通常不提供 og:image，用第一话封面兜底
  if (!rawCover && series.length) {
    try {
      rawCover = coverOf(await ctx.doc(series[0].url));
    } catch {
      rawCover = undefined;
    }
  }

  const tags = qsa(doc, '.addtags a')
    .map((el) => text(el))
    .filter(Boolean);
  const intro =
    clean(qs<HTMLMetaElement>(doc, 'meta[name="description"]')?.getAttribute('content')) ||
    undefined;
  const pages = pagesOf(doc);
  const chapters: Chapter[] = series.length
    ? series
    : [{ title: pages > 1 ? `全一话 · ${pages} 张` : '全一话', url }];

  return {
    url,
    title,
    cover: proxyImage(absolute(rawCover), REFERER),
    intro,
    extra: tags.length ? tags.join(' · ') : clean(text(qs(doc, '.info_col'))) || undefined,
    chapters,
  };
}

async function chapterCloudwn(
  ctx: SiteCtx,
  url: string,
  onPartial?: (content: ChapterContent) => void,
): Promise<ChapterContent> {
  const hit = chapterCache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.content;

  const id = albumId(url);
  if (!id) throw new Error('无法识别漫画编号');
  const first = await ctx.doc(url);
  const pages = Math.max(maxPage(first, id), 1);

  type PageData = { thumbs: string[]; views: string[] };
  const collect = (doc: Document): PageData => ({
    thumbs: imagesOf(doc),
    views: viewLinksOf(doc),
  });
  const thumbsByPage = new Map<number, string[]>();
  const viewsByPage = new Map<number, string[]>();
  const fullByPage = new Map<number, string[]>();
  const firstPage = collect(first);
  thumbsByPage.set(1, firstPage.thumbs);
  viewsByPage.set(1, firstPage.views);

  const emit = () => {
    if (!onPartial) return;
    const images: string[] = [];
    for (let page = 1; page <= pages; page++) {
      const full = fullByPage.get(page);
      const thumbs = thumbsByPage.get(page);
      if (full?.length) images.push(...full);
      else if (thumbs?.length) images.push(...thumbs);
      else break;
    }
    onPartial({ title: '全一话', paragraphs: [], images });
  };

  // 第一页缩略图立即可读，不用等所有分页/原图
  emit();

  const fillFull = async (page: number) => {
    const views = viewsByPage.get(page) ?? [];
    const thumbs = thumbsByPage.get(page) ?? [];
    if (!views.length) {
      fullByPage.set(page, thumbs);
      emit();
      return;
    }
    const full = await mapLimit(views, 6, async (viewUrl, index) => {
      try {
        return (await fullImageOf(ctx, viewUrl)) ?? thumbs[index];
      } catch {
        return thumbs[index];
      }
    });
    fullByPage.set(page, full.filter((src): src is string => !!src));
    emit();
  };

  const restTask = mapLimit(
    Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2),
    4,
    async (page) => {
      try {
        const doc = await ctx.doc(pageUrl(id, page));
        const data = collect(doc);
        thumbsByPage.set(page, data.thumbs);
        viewsByPage.set(page, data.views);
        emit();
        await fillFull(page);
      } catch {
        // 单页失败不拖垮其他页
      }
    },
  );

  await Promise.all([fillFull(1), restTask]);

  const images: string[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= pages; page++) {
    const list = fullByPage.get(page) ?? thumbsByPage.get(page) ?? [];
    for (const src of list) {
      if (!src || seen.has(src)) continue;
      seen.add(src);
      images.push(src);
    }
  }
  if (!images.length) throw new Error('这一话没有解析到图片，可能需要在站点内验证');

  const content: ChapterContent = { title: '全一话', paragraphs: [], images };
  chapterCache.set(url, { at: Date.now(), content });
  return content;
}


const cloudwn: Site = {
  id: 'cloudwn',
  name: 'CloudWN 漫画',
  icon: '云',
  color: '#e08a3c',
  baseUrl: BASE,
  kind: 'comic',
  nsfw: true,
  referer: REFERER,

  home: homeCloudwn,
  search: searchCloudwn,
  detail: detailCloudwn,
  chapter: chapterCloudwn,
};

export default cloudwn;
