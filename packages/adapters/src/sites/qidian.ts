import { clean, parseHtml, qs, qsa, text, toParagraphs } from '@agg/core';
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
 * 起点中文网（移动端 m.qidian.com）。
 *
 * 桌面站 www.qidian.com 有 JS 挑战，移动端页面是服务端渲染的，直接静态请求即可：
 * - 首页：推荐位、畅销/猜你喜欢等板块
 * - /category/catidX/：分类书单
 * - /rank/：月票/畅销/阅读/书友/推荐/更新等榜单
 * - /book/{id}/：详情（meta 标签里有书名/作者/封面/简介）
 * - /book/{id}/catalog/：完整目录（免费章节带「免费」标记）
 * - /chapter/{bookId}/{chapterId}/：正文；付费章节匿名只能看到前几段
 *
 * 起点是本项目小说的默认书源；付费章节需要登录/订阅，读取时给出明确提示，
 * 由详情页的「换源」切换到其他小说源。
 */

const BASE = 'https://m.qidian.com';
const UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

export const QIDIAN_CATEGORIES = [
  { name: '玄幻', id: '21' },
  { name: '奇幻', id: '1' },
  { name: '武侠', id: '2' },
  { name: '仙侠', id: '22' },
  { name: '都市', id: '4' },
  { name: '现实', id: '15' },
  { name: '军事', id: '6' },
  { name: '历史', id: '5' },
  { name: '游戏', id: '7' },
  { name: '体育', id: '8' },
  { name: '科幻', id: '9' },
  { name: '悬疑', id: '10' },
  { name: '轻小说', id: '12' },
];

function absolute(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  const raw = url.trim();
  if (!raw) return undefined;
  if (raw.startsWith('//')) return 'https:' + raw;
  if (/^https?:\/\//.test(raw)) return raw;
  try {
    return new URL(raw, BASE).toString();
  } catch {
    return undefined;
  }
}

function coverOf(el: Element): string | undefined {
  const img = qs(el, 'img');
  const raw =
    img?.getAttribute('data-src') ??
    img?.getAttribute('src') ??
    img?.getAttribute('data-original') ??
    undefined;
  return absolute(raw);
}

function bookIdOf(href: string | null): string | null {
  if (!href) return null;
  const m = /\/book\/(\d+)/.exec(href) ?? /\/chapter\/(\d+)/.exec(href);
  return m ? m[1] : null;
}

/** 从列表卡片里抽一本（首页/分类/排行/搜索共用） */
function bookFromAnchor(a: HTMLAnchorElement): BookRef | null {
  const href = a.getAttribute('href') ?? '';
  const id = bookIdOf(href) ?? a.getAttribute('data-bid') ?? null;
  if (!id) return null;

  // 有的卡片链接只包住封面，书名/作者在 li 的 figcaption 里
  const root: Element = a.closest('li') ?? a.parentElement ?? a;
  const rawTitle =
    text(qs(a, 'h2')) ||
    text(qs(root, 'h2')) ||
    (a.getAttribute('title') ?? '')
      .replace(/(最新章节|在线阅读).*$/, '')
      .replace(/最新章节.*$/, '')
      .trim();
  if (!rawTitle) return null;

  const authorText = clean(
    text(
      qs(
        a,
        '[class*="_searchBookAuthor_"], [class*="_authorName_"], [class*="_bookTip_"], [class*="_subTitle_"]',
      ),
    ) ||
      text(
        qs(
          root,
          '[class*="_searchBookAuthor_"], [class*="_authorName_"], [class*="_bookTip_"], [class*="_subTitle_"]',
        ),
      ) ||
      text(qs(root, 'figcaption + p, p')),
  );
  // 首页的 _bookTip_ 是「分类 · 字数」，不是作者
  const parts = authorText
    .split(/[·|｜]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const author =
    parts[0] && !/万字|连载|完结/.test(parts[0]) ? parts[0] : undefined;
  const metaExtra = parts.length > 1 ? parts.slice(1).join(' · ') : undefined;

  const tagParts = [
    ...qsa(a, '[class*="_tags_"] p').map((el) => text(el)),
    ...qsa(root, '[class*="_tags_"] p').map((el) => text(el)),
    ...qsa(root, '[class*="_footerTip_"] a, [class*="_footerTip_"] em').map((el) => text(el)),
  ].filter(Boolean);
  const extra = tagParts.length ? [...new Set(tagParts)].join(' · ') : metaExtra;

  const desc = clean(text(qs(a, '[class*="_searchBookDesc_"]')));
  const intro = desc.length > 20 ? desc : undefined;

  return {
    url: `${BASE}/book/${id}/`,
    title: rawTitle.replace(/\(\s*$/, '').trim(),
    author,
    cover: coverOf(a) ?? coverOf(root),
    extra,
    intro,
  };
}

function dedupeBooks(books: BookRef[]): BookRef[] {
  const seen = new Set<string>();
  const out: BookRef[] = [];
  for (const b of books) {
    const id = bookIdOf(b.url);
    const key = id ?? b.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

function booksIn(root: ParentNode): BookRef[] {
  const anchors = qsa<HTMLAnchorElement>(
    root,
    'a[class*="_bookWrapper_"], a[href*="/book/"]',
  );
  return dedupeBooks(
    anchors.map(bookFromAnchor).filter((b): b is BookRef => !!b),
  );
}

async function fetchDoc(ctx: SiteCtx, url: string): Promise<Document> {
  const res = await ctx.request(url, {
    headers: {
      'user-agent': UA,
      referer: BASE + '/',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
    timeoutMs: 25_000,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`起点返回 HTTP ${res.status}`);
  }
  if (res.body.includes('probe.js') && res.body.length < 2000) {
    throw new Error('起点触发了人机校验，请稍后重试');
  }
  return parseHtml(res.body);
}

/** 首页推荐板块 */
export async function loadQidianHome(ctx: SiteCtx): Promise<BookSection[]> {
  const doc = await fetchDoc(ctx, BASE + '/');
  const sections: BookSection[] = [];
  for (const card of qsa(doc, 'div[class*="_bookViewCard_"]')) {
    const title = clean(text(qs(card, 'h3'))) || '推荐';
    const books = booksIn(card);
    if (!books.length) continue;
    const more = qsa<HTMLAnchorElement>(card, 'a[href]').find((a) => /更多/.test(text(a)));
    let moreHref = more?.getAttribute('href') ?? '';
    if (!moreHref || moreHref.includes('cardid=undefined')) {
      moreHref =
        title.includes('畅销') ? `${BASE}/bestsell/` :
        title.includes('免费') ? `${BASE}/free/` :
        title.includes('新书') ? `${BASE}/newbook/` :
        title.includes('轻小说') ? `${BASE}/category/catid12/` :
        '';
    }
    const moreUrl = absolute(moreHref);

    const existing = sections.find((s) => s.title === title);
    if (existing) {
      existing.books = dedupeBooks([...existing.books, ...books]).slice(0, 20);
      existing.moreUrl ??= moreUrl;
    } else {
      sections.push({ title, books: books.slice(0, 16), moreUrl });
    }
  }

  // 首页静态页的推荐位有限，补三个完整列表页，每栏 20 本
  const extras: { title: string; url: string }[] = [
    { title: '限时免费', url: `${BASE}/free/` },
    { title: '新书抢鲜', url: `${BASE}/newbook/` },
    { title: '畅销完本', url: `${BASE}/bestsell/` },
  ];
  const extraSections = await Promise.all(
    extras.map(async (def) => {
      try {
        const d = await fetchDoc(ctx, def.url);
        const books = booksIn(d).slice(0, 20);
        return books.length ? { title: def.title, books, moreUrl: def.url } : null;
      } catch {
        return null;
      }
    }),
  );
  for (const extra of extraSections) {
    if (!extra) continue;
    const existing = sections.find((s) => s.title === extra.title);
    if (existing) {
      existing.books = dedupeBooks([...existing.books, ...extra.books]).slice(0, 20);
      existing.moreUrl = extra.moreUrl;
    } else {
      sections.push(extra);
    }
  }

  if (!sections.length) {
    const books = booksIn(qs(doc, 'main') ?? doc);
    if (books.length) sections.push({ title: '推荐', books: books.slice(0, 18) });
  }
  if (!sections.length) throw new Error('起点首页没有解析到书籍');

  // 完整列表页的栏目（20 本/栏）排前面，首页原生的小栏目排后面
  const priority = new Map([
    ['限时免费', 0],
    ['新书抢鲜', 1],
    ['畅销完本', 2],
  ]);
  sections.sort((a, b) => (priority.get(a.title) ?? 9) - (priority.get(b.title) ?? 9));
  return sections.slice(0, 8);
}

/** 排行榜：月票榜/畅销榜/阅读榜/书友榜/推荐榜… */
export async function loadQidianRank(ctx: SiteCtx): Promise<BookSection[]> {
  const doc = await fetchDoc(ctx, `${BASE}/rank/`);
  const sections: BookSection[] = [];
  for (const sec of qsa(doc, 'div[class*="_ranks_"]')) {
    const title = clean(text(qs(sec, '[class*="_rankTitle_"]'))) || '排行';
    const books = booksIn(sec);
    if (!books.length) continue;
    const more = qsa<HTMLAnchorElement>(sec, 'a[href]').find((a) => /更多/.test(text(a)));
    sections.push({
      title,
      books,
      moreUrl: absolute(more?.getAttribute('href') ?? '') ?? `${BASE}/rank/`,
    });
  }
  if (!sections.length) {
    const books = booksIn(doc);
    if (books.length) sections.push({ title: '排行榜', books: books.slice(0, 30) });
  }

  // 主榜单页每栏只有 5 本；再取每栏的完整榜单页，补到 20 本
  for (const section of sections) {
    if (!section.moreUrl || section.moreUrl === `${BASE}/rank/`) continue;
    try {
      const detailDoc = await fetchDoc(ctx, section.moreUrl);
      const moreBooks = booksIn(detailDoc);
      if (moreBooks.length) section.books = moreBooks.slice(0, 20);
    } catch {
      /* 单栏失败保留主页面数据 */
    }
  }
  return sections;
}

/** 分类书单（第一页） */
export async function loadQidianCategory(
  ctx: SiteCtx,
  catId: string,
  name: string,
): Promise<BookSection[]> {
  const url = `${BASE}/category/catid${catId}/`;
  const doc = await fetchDoc(ctx, url);
  const books = booksIn(doc);
  return books.length ? [{ title: `${name} · 热门`, books, moreUrl: url }] : [];
}

/** 任意起点列表页（分类 / 榜单 / 免费 / 新书 / 畅销 / 更多） */
export async function loadQidianList(
  ctx: SiteCtx,
  url: string,
): Promise<BookRef[]> {
  const doc = await fetchDoc(ctx, url);
  const books = booksIn(doc);
  if (!books.length) throw new Error('起点列表页没有解析到书籍');
  return books;
}

function meta(doc: Document, key: string): string {
  const el =
    doc.querySelector(`meta[property="${key}"]`) ??
    doc.querySelector(`meta[name="${key}"]`);
  return clean(el?.getAttribute('content') ?? '');
}

async function searchQidian(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
  const url = `${BASE}/so/${encodeURIComponent(keyword)}.html`;
  const doc = await fetchDoc(ctx, url);
  return booksIn(doc).slice(0, 30);
}

async function detailQidian(ctx: SiteCtx, url: string): Promise<BookDetail> {
  const doc = await fetchDoc(ctx, url);
  const title =
    meta(doc, 'og:novel:book_name') ||
    clean(text(qs(doc, 'h1'))) ||
    clean((doc.title || '').split('(')[0]);
  if (!title) throw new Error('起点没有解析到书名，页面可能已改版');

  const author = meta(doc, 'og:novel:author') || undefined;
  const status = meta(doc, 'og:novel:status') || undefined;
  const category = meta(doc, 'og:novel:category');
  const cover = absolute(meta(doc, 'og:image'));
  const intro =
    meta(doc, 'og:description') ||
    meta(doc, 'description') ||
    undefined;

  return {
    url,
    title,
    author,
    cover,
    status,
    extra: [category, status].filter(Boolean).join(' · ') || undefined,
    intro: clean(intro) || undefined,
    chapters: [],
  };
}

async function chaptersQidian(
  ctx: SiteCtx,
  bookUrl: string,
  onProgress?: (chapters: Chapter[]) => void,
): Promise<Chapter[]> {
  const base = bookUrl.replace(/\/+$/, '');
  const doc = await fetchDoc(ctx, `${base}/catalog/`);
  const bookId = bookIdOf(bookUrl);
  if (!bookId) throw new Error('无法识别起点书籍编号');

  type RawChapter = { id: string; title: string; free: boolean; url: string };
  const raw: RawChapter[] = [];
  for (const a of qsa<HTMLAnchorElement>(doc, 'a[href*="/chapter/"]')) {
    const href = a.getAttribute('href') ?? '';
    if (!new RegExp(`/chapter/${bookId}/`).test(href)) continue;
    const m = /\/chapter\/\d+\/(\d+)/.exec(href);
    const id = m?.[1];
    if (!id || id === '0') continue;
    const rawText = clean(text(a));
    if (!rawText) continue;
    const free = /免费/.test(rawText);
    const title = rawText
      .replace(/\s*\d{4}-\d{2}-\d{2}.*$/, '')
      .replace(/\s*(免费|VIP|订阅|已订阅)\s*$/g, '')
      .trim();
    if (!title) continue;
    raw.push({ id, title, free, url: `${BASE}/chapter/${bookId}/${id}/` });
  }

  // 目录第一条常是「最新章节」，真正的完整列表从第一章/序章开始
  const start = raw.findIndex(
    (c) =>
      /^第\s*(?:一|1|0?1)\s*[章回]/.test(c.title) ||
      /^(序章|楔子|前言|引子)/.test(c.title),
  );
  const list = start > 0 ? raw.slice(start) : raw;

  const seen = new Set<string>();
  const anyFree = list.some((c) => c.free);
  const chapters: Chapter[] = [];
  for (const c of list) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    chapters.push({
      title: c.title,
      url: c.url,
      locked: anyFree ? !c.free : undefined,
    });
  }
  if (!chapters.length) throw new Error('起点目录为空，可能需要先完成人机校验');
  onProgress?.(chapters);
  return chapters;
}

async function chapterQidian(ctx: SiteCtx, url: string): Promise<ChapterContent> {
  const doc = await fetchDoc(ctx, url);
  const bodyText = clean(doc.body?.textContent ?? '');
  if (/登录订阅本章|订阅本章|本章为付费章节/.test(bodyText)) {
    throw new Error('起点本章需要登录/订阅，请返回详情页切换到其他书源');
  }

  const main = qs(doc, 'main') ?? doc.body;
  const paragraphs = toParagraphs(main).filter(
    (p) =>
      p.length > 0 &&
      !/^(菜单|书友圈|讨论热烈|本章含\d+条段评|推荐|日常系人生)$/.test(p),
  );
  if (paragraphs.length < 3) {
    throw new Error('起点本章正文为空（可能是付费章节），请返回详情页切换到其他书源');
  }

  const title =
    clean(text(qs(doc, 'main h1'))) ||
    clean(text(qs(doc, 'h1'))) ||
    clean((doc.title || '').replace(/^《[^》]*》/, '').replace(/_.*$/, ''));

  return { title, paragraphs };
}

const qidian: Site = {
  id: 'qidian',
  name: '起点中文网',
  icon: '起',
  color: '#c8352b',
  baseUrl: BASE,
  kind: 'novel',
  referer: BASE + '/',

  home: loadQidianHome,
  search: searchQidian,
  detail: detailQidian,
  chapters: chaptersQidian,
  chapter: chapterQidian,
};

export default qidian;
