import type {
  BookDetail,
  BookRef,
  BookSection,
  Chapter,
  ChapterContent,
  Site,
  SiteCtx,
} from '@agg/core';
import { clean } from '@agg/core';
import { proxyImage } from '../image.ts';

/**
 * 拷贝漫画（mangacopy.com）。
 *
 * 网页/API 入口分离：
 * - 网页：`https://www.mangacopy.com/comic/{path_word}`
 * - API：`api.manga2025.com` / `mapi.hotmangasd.com` 等镜像域
 * - 请求头必须带 Version / Region / platform，否则详情和章节会返回 210
 * - 章节图片在 `/api/v3/comic/{path}/chapter/{uuid}` 的 results.chapter.contents
 *
 * 漫画详情 API 用 path_word；章节用 uuid。
 */

const BASE = 'https://www.mangacopy.com';
const REFERER = BASE + '/';

const API_DOMAINS = [
  'https://api.manga2025.com',
  'https://mapi.hotmangasd.com',
  'https://api.copy202601.com',
  'https://api.copy4000.com',
  'https://api.mangacopy.com',
];

const API_HEADERS: Record<string, string> = {
  accept: 'application/json',
  version: '2025.11.21',
  region: '0',
  webp: '0',
  platform: '1',
  origin: BASE,
  referer: REFERER,
};

interface ApiEnvelope {
  code?: number;
  message?: string;
  results?: unknown;
}

function pathWord(bookUrl: string): string | null {
  const m = /\/comic\/([^/?#]+)/.exec(bookUrl);
  return m ? m[1] : null;
}

function chapterId(url: string): string | null {
  const m = /\/chapter\/([^/?#]+)/.exec(url);
  return m ? m[1] : null;
}

function absolute(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, BASE).toString();
  } catch {
    return undefined;
  }
}

function apiUrl(base: string, path: string, query?: Record<string, string>): string {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

async function api(
  ctx: SiteCtx,
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  let lastError = '';
  for (const base of API_DOMAINS) {
    try {
      const res = await ctx.request(apiUrl(base, path, query), {
        headers: API_HEADERS,
      });
      if (res.status < 200 || res.status >= 300) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const body = JSON.parse(res.body) as ApiEnvelope;
      if (body.code === 200) return body.results;
      lastError = `${body.code ?? '?'}：${body.message ?? ''}`;
      // 210 = 该域要求升级 APP / 地区限制，换域继续
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`拷贝漫画 API 不可用：${lastError || '没有可用域名'}`);
}

interface ApiComic {
  name?: string;
  alias?: string;
  path_word?: string;
  cover?: string;
  brief?: string;
  author?: { name?: string }[];
  theme?: { name?: string }[];
  status?: { display?: string };
  free_type?: { display?: string };
  popular?: number;
}

interface ApiChapter {
  uuid?: string;
  name?: string;
  ordered?: number;
  count?: number;
  size?: number;
}

function bookRefOf(c: ApiComic): BookRef | null {
  if (!c.path_word || !c.name) return null;
  const author = c.author?.map((a) => a.name).filter(Boolean).join(' / ');
  return {
    url: `${BASE}/comic/${c.path_word}`,
    title: clean(c.name),
    author: author || undefined,
    cover: proxyImage(absolute(c.cover), REFERER),
    extra: [c.free_type?.display, c.status?.display, author].filter(Boolean).join(' · ') || undefined,
  };
}

function listOf(results: unknown): ApiComic[] {
  const out: ApiComic[] = [];
  const push = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const obj = value as { comic?: ApiComic } & ApiComic;
    // recs 返回 { type, comic: {...} }；comics/search 直接返回 comic 对象
    out.push(obj.comic ?? obj);
  };
  if (Array.isArray(results)) results.forEach(push);
  else if (results && typeof results === 'object') {
    const list = (results as { list?: unknown }).list;
    if (Array.isArray(list)) list.forEach(push);
  }
  return out;
}

const chapterCache = new Map<string, { at: number; content: ChapterContent }>();
const TTL = 30 * 60_000;

async function homeMangacopy(ctx: SiteCtx): Promise<BookSection[]> {
  const [popular, latest] = await Promise.all([
    api(ctx, '/api/v3/recs', { pos: '3200102', limit: '21', offset: '0' }),
    api(ctx, '/api/v3/comics', {
      ordering: '-datetime_updated',
      limit: '21',
      offset: '0',
      _update: 'true',
    }),
  ]);
  const sections: BookSection[] = [];
  const hot = listOf(popular).map(bookRefOf).filter((b): b is BookRef => !!b);
  const fresh = listOf(latest).map(bookRefOf).filter((b): b is BookRef => !!b);
  if (hot.length) sections.push({ title: '热门漫画', books: hot });
  if (fresh.length) sections.push({ title: '最新更新', books: fresh });
  return sections;
}

async function searchMangacopy(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
  const results = await api(ctx, '/api/v3/search/comic', {
    q: keyword,
    limit: '21',
    offset: '0',
    _update: 'true',
  });
  return listOf(results).map(bookRefOf).filter((b): b is BookRef => !!b);
}

async function detailMangacopy(ctx: SiteCtx, url: string): Promise<BookDetail> {
  const path = pathWord(url);
  if (!path) throw new Error('无法识别拷贝漫画路径');

  const results = (await api(ctx, `/api/v3/comic2/${encodeURIComponent(path)}`)) as {
    comic?: ApiComic;
  };
  const comic = results?.comic;
  if (!comic?.name) throw new Error('拷贝漫画没有解析到作品信息');

  const listResults = (await api(ctx, `/api/v3/comic/${encodeURIComponent(path)}/group/default/chapters`, {
    limit: '500',
    offset: '0',
    _update: 'true',
  })) as { list?: ApiChapter[] } | ApiChapter[];
  const raw = Array.isArray(listResults) ? listResults : listResults?.list ?? [];
  const chapters: Chapter[] = raw
    .filter((c) => c.uuid && c.name)
    .sort((a, b) => (a.ordered ?? 0) - (b.ordered ?? 0))
    .map((c) => ({
      title: clean(c.name ?? ''),
      url: `${BASE}/comic/${path}/chapter/${c.uuid}`,
    }));

  const author = comic.author?.map((a) => a.name).filter(Boolean).join(' / ');
  const themes = comic.theme?.map((t) => t.name).filter(Boolean).join(' · ');
  return {
    url,
    title: clean(comic.name),
    author: author || undefined,
    cover: proxyImage(absolute(comic.cover), REFERER),
    intro: clean(comic.brief ?? '') || undefined,
    extra: [comic.status?.display, comic.free_type?.display, themes].filter(Boolean).join(' · ') || undefined,
    chapters,
  };
}

async function chapterMangacopy(ctx: SiteCtx, url: string): Promise<ChapterContent> {
  const hit = chapterCache.get(url);
  if (hit && Date.now() - hit.at < TTL) return hit.content;

  const path = pathWord(url);
  const cid = chapterId(url);
  if (!path || !cid) throw new Error('无法识别拷贝漫画章节');

  let payload: unknown;
  try {
    payload = await api(ctx, `/api/v3/comic/${encodeURIComponent(path)}/chapter/${encodeURIComponent(cid)}`);
  } catch {
    payload = await api(ctx, `/api/v3/comic/${encodeURIComponent(path)}/chapter2/${encodeURIComponent(cid)}`);
  }

  const root = payload as {
    chapter?: { name?: string; contents?: { url?: string }[] };
    contents?: { url?: string }[];
  };
  const chapter = root?.chapter;
  const contents = chapter?.contents ?? root?.contents ?? [];
  const images: string[] = [];
  const seen = new Set<string>();
  for (const item of contents) {
    const raw = typeof item === 'string' ? item : item?.url;
    const img = proxyImage(absolute(raw), REFERER);
    if (img && !seen.has(img)) {
      seen.add(img);
      images.push(img);
    }
  }
  if (!images.length) throw new Error('这一话没有解析到图片');

  const content: ChapterContent = {
    title: clean(chapter?.name ?? ''),
    paragraphs: [],
    images,
  };
  chapterCache.set(url, { at: Date.now(), content });
  return content;
}

const mangacopy: Site = {
  id: 'mangacopy',
  name: '拷贝漫画',
  icon: '拷',
  color: '#8b5cf6',
  baseUrl: BASE,
  kind: 'comic',
  nsfw: false,
  referer: REFERER,

  home: homeMangacopy,
  search: searchMangacopy,
  detail: detailMangacopy,
  chapter: chapterMangacopy,
};

export default mangacopy;
