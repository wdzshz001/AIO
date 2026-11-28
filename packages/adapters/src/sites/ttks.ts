import { clean, qs, qsa, text, toParagraphs } from '@agg/core';
import type {
  BookDetail,
  BookRef,
  BookSection,
  Chapter,
  ChapterContent,
  Site,
  SiteCtx,
} from '@agg/core';

/**
 * 天天看小说（ttks.tw）。
 *
 * 站点是 Nuxt SSR + Cloudflare，静态请求会 403，统一走真实浏览器渲染。
 * - 搜索：/novel/search?searchkey=...&searchtype=all
 * - 详情：/novel/chapters/{slug}/index.html；全部章节在页面里
 * - 正文：div.content p[data-num]
 */

const BASE = 'https://ttks.tw';
const WAIT = 'h1, .rank_title, .novel_info, .content';
const CHAPTER_TTL = 30 * 60_000;

function absolute(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, BASE).toString();
  } catch {
    return undefined;
  }
}

function cleanText(raw: string | null | undefined): string {
  if (!raw) return '';
  let s = raw.replace(/\u00a0/g, ' ').replace(/\u3000/g, ' ');
  s = s.replace(/loadAdv\([^)]*\);?/gi, '');
  s = s.replace(/【[^】]*(?:本站|域名|追書|追书|天天看)[^】]*】/g, '');
  s = s.replace(/\[[^\]]*(?:本站|域名|追書|追书|天天看)[^\]]*\]/g, '');
  // 站点的反爬水印经常插数学字母 / 域名
  s = s.replace(/[\u{1D400}-\u{1D7FF}]+(?:\.[^\s]*)?/gu, '');
  s = s.replace(/[A-Za-z0-9ɥɔɯ˙.\-]*[ɥɔɯ˙][A-Za-z0-9ɥɔɯ˙.\-]*/g, '');
  s = s.replace(/[A-Za-z0-9./:_-]*(?:ttks?\.?tw|69shu|69shux|shux)[A-Za-z0-9./:_-]*/gi, '');
  // 60 章后开始出现的口播式广告，常拼在正文末尾（可能带全角空格）
  s = s.replace(
    /(?:看[书書](?:認準|认准|首選|首选)?|首選|首选|認準|认准)\s*天天看[小説说][\s\S]*$/g,
    '',
  );
  s = s.replace(/^天天看[小説说][\s\S]*$/g, '');
  // 有些广告直接拼在正文段尾：“……   天天看小說伴你讀，”
  s = s.replace(/天天看[小説说][\s\S]*$/g, '');
  s = s.replace(/天天看[小説说][\s\S]{0,40}?(?:超|最|免费|免費|順暢|顺畅|靠譜|靠谱)[\s\S]*$/g, '');
  s = s.replace(/(?:請|请)?(?:記住|记住)(?:本站|本站域名|域名|網址|网址)[\s\S]*$/g, '');
  return clean(s);
}

function isBookUrl(href: string): boolean {
  return /\/novel\/chapters\/[^/]+\/index\.html(?:[?#].*)?$/.test(href);
}

function bookUrlOf(href: string): string | undefined {
  const abs = absolute(href);
  return abs && isBookUrl(abs) ? abs.split('#')[0].split('?')[0] : undefined;
}

function bookFromLink(a: HTMLAnchorElement): BookRef | null {
  const url = bookUrlOf(a.getAttribute('href') ?? '');
  const img = qs<HTMLImageElement>(a, 'img');
  const title =
    cleanText(text(a)) ||
    cleanText(a.getAttribute('aria-label')) ||
    cleanText(img?.getAttribute('alt'));
  if (!url || !title) return null;
  return {
    url,
    title,
    cover: absolute(img?.getAttribute('src')),
  };
}

function coverOf(doc: Document): string | undefined {
  const img = qsa<HTMLImageElement>(doc, 'img').find((i) =>
    (i.getAttribute('src') ?? '').includes('/files/article/image/'),
  );
  return absolute(img?.getAttribute('src'));
}

function parseLinks(doc: Document): BookRef[] {
  const out: BookRef[] = [];
  const seen = new Set<string>();
  for (const a of qsa<HTMLAnchorElement>(doc, 'a[href*="/novel/chapters/"]')) {
    const ref = bookFromLink(a);
    if (!ref || seen.has(ref.url)) continue;
    seen.add(ref.url);
    out.push(ref);
  }
  return out;
}

function parseHome(doc: Document): BookSection[] {
  const books = parseLinks(doc);
  return books.length ? [{ title: '热门小说推荐', books }] : [];
}

async function homeTtks(ctx: SiteCtx): Promise<BookSection[]> {
  return parseHome(await ctx.doc(BASE + '/'));
}

async function searchTtks(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
  const query = new URLSearchParams({ searchkey: keyword, searchtype: 'all' });
  const doc = await ctx.doc(`${BASE}/novel/search?${query.toString()}`);

  // 站内精确命中会直接 302 到详情页；此时不能只解析“搜索结果的卡片链接”
  if (qs(doc, '.novel_info')) {
    const canonical =
      absolute(qs<HTMLLinkElement>(doc, 'link[rel="canonical"]')?.getAttribute('href')) ||
      absolute(qs<HTMLMetaElement>(doc, 'meta[property="og:url"]')?.getAttribute('content'));
    const title = cleanText(text(qs(doc, 'h1')));
    if (canonical && title) return [{ url: canonical, title, cover: coverOf(doc) }];
  }

  return parseLinks(doc);
}

async function detailTtks(ctx: SiteCtx, url: string): Promise<BookDetail> {
  const doc = await ctx.doc(url);
  const title = cleanText(text(qs(doc, 'h1')));
  if (!title) throw new Error('ttks.tw 没有解析到书名');

  const infoText = cleanText(text(qs(doc, '.novel_info ul')));
  const author = /作者[：:]\s*([^\s]+)/.exec(infoText)?.[1];
  const category = /類別[：:]\s*([^\s]+)/.exec(infoText)?.[1];
  const status = /狀態[：:]\s*([^\s]+)/.exec(infoText)?.[1];

  const description = qs(doc, '.description');
  const introParagraphs = toParagraphs(description)
    .map(cleanText)
    .filter((p) => p && !/^(.*簡介|.*简介)$/.test(p));
  const intro = introParagraphs.join('\n') || undefined;

  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  for (const a of qsa<HTMLAnchorElement>(doc, 'a[href*="/novel/chapters/"]')) {
    const href = absolute(a.getAttribute('href'));
    if (!href || !/\/novel\/chapters\/[^/]+\/\d+\.html$/.test(href)) continue;
    if (seen.has(href)) continue;
    const name = cleanText(text(a));
    if (!name) continue;
    seen.add(href);
    chapters.push({ title: name, url: href });
  }
  chapters.sort((a, b) => {
    const ai = Number(/(\d+)\.html$/.exec(a.url)?.[1] ?? 0);
    const bi = Number(/(\d+)\.html$/.exec(b.url)?.[1] ?? 0);
    return ai - bi;
  });
  if (!chapters.length) throw new Error('ttks.tw 没有解析到目录');

  return {
    url,
    title,
    author,
    cover: coverOf(doc),
    intro,
    status,
    extra: [category, status].filter(Boolean).join(' · ') || undefined,
    chapters,
  };
}

const chapterCache = new Map<string, { at: number; content: ChapterContent }>();

export const TTKS_CATEGORIES = [
  { id: 'dushi', name: '都市' },
  { id: 'wuxia', name: '武侠' },
  { id: 'yaniqng', name: '言情' },
  { id: 'youxi', name: '游戏' },
  { id: 'kehuan', name: '科幻' },
  { id: 'kongbu', name: '悬疑' },
  { id: 'xuanhuan', name: '玄幻' },
  { id: 'lishi', name: '历史' },
  { id: 'tongren', name: '同人' },
  { id: 'qita', name: '其它' },
];

/** 排行频道：页面结构可能调整，用统一的“书籍链接”解析兜底 */
export async function loadTtksRank(ctx: SiteCtx): Promise<BookSection[]> {
  const url = `${BASE}/novel/rank`;
  const doc = await ctx.doc(url);
  const books = parseLinks(doc);
  return books.length ? [{ title: '综合排行', books, moreUrl: url }] : [];
}

export async function loadTtksCategory(
  ctx: SiteCtx,
  id: string,
  name: string,
): Promise<BookSection[]> {
  const url = `${BASE}/novel/class/${id}`;
  const doc = await ctx.doc(url);
  const books = parseLinks(doc);
  return books.length ? [{ title: `${name} · 分类`, books, moreUrl: url }] : [];
}

function chapterParagraphs(doc: Document): string[] {
  const root = qs(doc, 'div.content');
  if (!root) return [];
  return qsa(root, 'p')
    .map((p) => cleanText(text(p)))
    .filter((p) => {
      if (!p) return false;
      if (/^(loadAdv|記住本站|记住本站|追書|追书)/i.test(p)) return false;
      return p.length > 1;
    });
}

async function chapterTtks(
  ctx: SiteCtx,
  url: string,
  onPartial?: (content: ChapterContent) => void,
): Promise<ChapterContent> {
  const hit = chapterCache.get(url);
  if (hit && Date.now() - hit.at < CHAPTER_TTL) return hit.content;

  const doc = await ctx.doc(url, { render: true, scroll: true });
  const title = cleanText(text(qs(doc, 'h1'))).replace(/^.*?[》>]\s*/, '') || '正文';
  const paragraphs = chapterParagraphs(doc);
  if (!paragraphs.length) throw new Error('ttks.tw 没有解析到正文');

  const content: ChapterContent = { title, paragraphs };
  chapterCache.set(url, { at: Date.now(), content });
  onPartial?.(content);
  return content;
}

const ttks: Site = {
  id: 'ttks',
  name: '天天看小说',
  icon: '天',
  color: '#27ae60',
  baseUrl: BASE,
  kind: 'novel',
  referer: BASE + '/',
  needsRender: true,
  renderWait: WAIT,

  home: homeTtks,
  search: searchTtks,
  detail: detailTtks,
  chapter: chapterTtks,
};

export default ttks;
