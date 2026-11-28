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
 * 得奇小说网（deqixss.com）。
 *
 * - 搜索是 POST 表单：`/modules/article/search.php`（字段 searchkey/action/searchtype）
 * - 详情：`/books/{id}/`；全部目录在 `#list-chapterAll dd a`
 * - 正文：静态页只有空 `#chapter-content`，必须真实浏览器渲染；
 *   正文由 chapter.js / yuedu.js 分块加载，用 scroll 触发
 */

const BASE = 'https://www.deqixss.com';
const CHAPTER_TTL = 30 * 60_000;

function absolute(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, BASE).toString();
  } catch {
    return undefined;
  }
}

function bookRefOf(
  link: HTMLAnchorElement | null,
  root: Element | Document,
  fallbackCover?: Element | null,
): BookRef | null {
  if (!link) return null;
  const url = absolute(link.getAttribute('href'));
  const title = clean(text(link));
  if (!url || !title) return null;
  const author = clean(
    text(qs(root, '.author')) ||
      text(qs(root, '.booktag a[title^="作者"]')) ||
      text(qs(root, 'dl dt span')),
  );
  const intro = clean(text(qs(root, '.update')) || text(qs(root, 'dd')));
  const img = qs<HTMLImageElement>(root, '.image img, .bookcover img') ?? fallbackCover;
  return {
    url,
    title,
    author: author.replace(/^作者[:：]\s*/, '') || undefined,
    cover: absolute(img?.getAttribute('src')) || undefined,
    intro: intro || undefined,
  };
}

function parseHome(doc: Document): BookSection[] {
  const books: BookRef[] = [];
  const seen = new Set<string>();
  for (const item of qsa(doc, '#fengtui .item, .content.book .item')) {
    const a = qs<HTMLAnchorElement>(item, 'dl dt a[href*="/books/"], h4 a[href*="/books/"]');
    const ref = bookRefOf(a, item);
    if (!ref || seen.has(ref.url)) continue;
    seen.add(ref.url);
    books.push(ref);
  }
  return books.length ? [{ title: '热门小说推荐', books }] : [];
}

function parseSearch(doc: Document): BookRef[] {
  const out: BookRef[] = [];
  const seen = new Set<string>();
  for (const box of qsa(doc, '.bookbox')) {
    const root = qs(box, '.bookinfo') ?? box;
    const a = qs<HTMLAnchorElement>(root, '.bookname a[href*="/books/"]');
    const ref = bookRefOf(a, root);
    if (!ref || seen.has(ref.url)) continue;
    seen.add(ref.url);
    out.push(ref);
  }

  // 精确书名搜索会被服务端 302 到详情页，直接返回这一本
  if (!out.length) {
    const titleEl = qs<HTMLAnchorElement>(doc, '.booktitle');
    if (titleEl) {
      const url =
        absolute(qs<HTMLMetaElement>(doc, 'meta[property="og:url"]')?.getAttribute('content')) ||
        absolute(qs<HTMLLinkElement>(doc, 'link[rel="canonical"]')?.getAttribute('href'));
      const cover = absolute(
        qs<HTMLImageElement>(doc, '.bookcover img, .bookintro img')?.getAttribute('src'),
      );
      const name = clean(text(qs(doc, '.booktitle')));
      if (url && name) out.push({ url, title: name, cover });
    }
  }
  return out;
}

async function homeDeqixss(ctx: SiteCtx): Promise<BookSection[]> {
  return parseHome(await ctx.doc(BASE + '/'));
}

async function searchDeqixss(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
  const doc = await ctx.submit(
    BASE + '/',
    `${BASE}/modules/article/search.php`,
    {
      searchkey: keyword,
      action: 'login',
      searchtype: 'all',
      submit: '',
    },
    { waitFor: '.bookbox, .booktitle, .msgbox', timeoutMs: 25_000 },
  );
  return parseSearch(doc);
}

async function detailDeqixss(ctx: SiteCtx, url: string): Promise<BookDetail> {
  const doc = await ctx.doc(url);
  const title = clean(text(qs(doc, '.booktitle')) || (doc.title || '').split('_')[0]);
  if (!title) throw new Error('得奇小说网没有解析到书名');

  const author = clean(
    qs<HTMLAnchorElement>(doc, '.booktag a[title^="作者"]')?.getAttribute('title') ?? '',
  ).replace(/^作者[:：]\s*/, '');
  const cover = absolute(
    qs<HTMLImageElement>(doc, '.bookcover img, .bookintro img')?.getAttribute('src'),
  );
  const intro = clean(text(qs(doc, '.bookintro'))) || undefined;
  const status = clean(
    text(
      qsa(doc, '.booktag .red').find((el) => el.tagName !== 'A') ?? null,
    ),
  );

  const chapters: Chapter[] = [];
  const seen = new Set<string>();
  for (const a of qsa<HTMLAnchorElement>(doc, '#list-chapterAll dd a[href]')) {
    const href = absolute(a.getAttribute('href'));
    const name = clean(text(a));
    if (!href || !name || seen.has(href)) continue;
    if (!/\/books\/\d+\/\d+\.html/.test(href)) continue;
    seen.add(href);
    chapters.push({ title: name, url: href });
  }

  return {
    url,
    title,
    author: author || undefined,
    cover,
    intro,
    status: status || undefined,
    extra: status || undefined,
    chapters,
  };
}

const chapterCache = new Map<string, { at: number; content: ChapterContent }>();
const NOISE =
  /当前章节|本章节内容|本章内容|加载中|点击催更|速读谷|shudugu|看最新|退出阅读模式|章节内容不完整|更新不易|请订阅|本章节未完/i;

function stripDeqixssNoise(paragraph: string): string {
  let text = paragraph.replace(/\u00a0/g, ' ').trim();
  // 站点会把提示拆成“当&前@章#节…”，按真实起始位置截掉提示
  const hint = /当[&@#$%^~!_|;)(*]*前[&@#$%^~!_|;)(*]*章[&@#$%^~!_|;)(*]*节[&@#$%^~!_|;)(*]*内[&@#$%^~!_|;)(*]*容[&@#$%^~!_|;)(*]*不[&@#$%^~!_|;)(*]*完[&@#$%^~!_|;)(*]*整/;
  const match = hint.exec(text);
  if (match) text = text.slice(0, match.index);
  if (/^加载中[.…。]*$/.test(text)) return '';
  return text.trim();
}

function pageUrl(url: string, page: number): string {
  const u = new URL(url);
  u.searchParams.set('page', String(page));
  return u.toString();
}

function totalPagesOf(title: string): number {
  const m = /第\s*\d+\s*\/\s*(\d+)\s*页/.exec(title);
  return m ? Math.max(1, Math.min(100, Number(m[1]))) : 1;
}

function paragraphsOf(doc: Document): string[] {
  const root = qs(doc, '#chapter-content') ?? qs(doc, '.readcontent');
  const paragraphs = toParagraphs(root)
    .map(stripDeqixssNoise)
    .filter((p) => !NOISE.test(p))
    .map((p) => p.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
  if (paragraphs.length) return paragraphs;
  return toParagraphs(qs(doc, '.readcontent'))
    .map(stripDeqixssNoise)
    .filter((p) => !NOISE.test(p))
    .filter(Boolean);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function chapterDeqixss(
  ctx: SiteCtx,
  url: string,
  onPartial?: (content: ChapterContent) => void,
): Promise<ChapterContent> {
  const hit = chapterCache.get(url);
  if (hit && Date.now() - hit.at < CHAPTER_TTL) return hit.content;

  const first = await ctx.doc(url, { render: true, scroll: true });
  const rawTitle = clean(
    text(qs(first, '.readcontent h1, h1.pt10')) || (docTitle(first) || '').split('_')[0],
  );
  const title = rawTitle.replace(/\(\s*第\s*\d+\s*\/\s*\d+\s*页\s*\)$/, '').trim();
  const total = totalPagesOf(rawTitle);
  const paragraphs = paragraphsOf(first);

  // 第一页先交给阅读器，后面的页在后台按顺序追加
  if (total > 1) {
    onPartial?.({ title, paragraphs: [...paragraphs], streaming: true });
  }

  if (total > 1) {
    const parts: (string[] | null)[] = new Array(total - 1).fill(null);
    let next = 0;
    const flush = () => {
      while (next < parts.length && parts[next]) {
        paragraphs.push(...(parts[next] as string[]));
        const remaining = next < parts.length - 1;
        onPartial?.({ title, paragraphs: [...paragraphs], streaming: remaining });
        next++;
      }
    };
    await mapLimit(
      Array.from({ length: total - 1 }, (_, i) => i + 2),
      3,
      async (page) => {
        parts[page - 2] = paragraphsOf(
          await ctx.doc(pageUrl(url, page), { render: true, scroll: true }),
        );
        flush();
      },
    );
  }

  if (!paragraphs.length) throw new Error('得奇小说网没有解析到正文');

  const content: ChapterContent = { title, paragraphs };
  chapterCache.set(url, { at: Date.now(), content });
  return content;
}

function docTitle(doc: Document): string {
  return doc.title || '';
}

const deqixss: Site = {
  id: 'deqixss',
  name: '得奇小说网',
  icon: '得',
  color: '#2f9e8f',
  baseUrl: BASE,
  kind: 'novel',
  referer: BASE + '/',
  renderWait: '#chapter-content .chapter-block',

  home: homeDeqixss,
  search: searchDeqixss,
  detail: detailDeqixss,
  chapter: chapterDeqixss,
};

export default deqixss;
