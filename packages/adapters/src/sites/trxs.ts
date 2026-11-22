import { attr, clean, first, qs, qsa, text, toParagraphs } from '@agg/core';
import type { BookDetail, BookRef, BookSection, Chapter, ChapterContent, Site } from '@agg/core';

const BASE = 'https://www.trxs.cc';

function absOf(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, BASE).toString();
  } catch {
    return undefined;
  }
}

/** 标题末尾常带「(全本)」「(1-172)」这类状态 */
function splitStatus(raw: string): { title: string; status?: string } {
  const m = /\(([^()]{1,12})\)\s*$/.exec(raw);
  if (!m) return { title: raw };
  return { title: raw.slice(0, m.index).trim(), status: m[1] };
}

function coverOf(el: Element | null): string | undefined {
  return absOf(attr(el ? el.querySelector('img') : null, 'src'));
}

function fromRecItem(li: Element): BookRef | null {
  const a = qs<HTMLAnchorElement>(li, 'p.dsbn a') ?? qs<HTMLAnchorElement>(li, 'a[href]');
  if (!a) return null;
  const url = absOf(a.getAttribute('href'));
  if (!url) return null;
  return { url, title: text(a), cover: coverOf(li) };
}

function fromBk(bk: Element): BookRef | null {
  const a = qs<HTMLAnchorElement>(bk, 'a[href]');
  if (!a) return null;
  const url = absOf(a.getAttribute('href'));
  if (!url) return null;

  const rawTitle = text(qs(bk, 'h3')) || attr(qs(bk, 'img'), 'alt');
  const { title, status } = splitStatus(rawTitle);

  const news = clean(text(qs(bk, '.booknews')))
    .replace(/\d{4}-\d{2}-\d{2}.*$/, '')
    .replace(/^作者[：:]\s*/, '')
    .replace(/[\d.]+\s*(?:MB|KB|GB)/gi, '')
    .trim();

  return {
    url,
    title,
    cover: coverOf(bk),
    author: news || undefined,
    extra: status,
    intro: text(qs(bk, 'p')) || undefined,
  };
}

function parseHome(doc: Document): BookSection[] {
  const sections: BookSection[] = [];

  // 推荐小说（页面上还有几个 display:none 的空板块，取第一个有内容的）
  const rec = qsa(doc, '.tui_book').find((el) => el.querySelector('p.dsbn a'));
  if (rec) {
    const books = qsa(rec, 'li')
      .map(fromRecItem)
      .filter((b): b is BookRef => !!b);
    if (books.length) sections.push({ title: '推荐小说', books });
  }

  // 热门榜（周榜默认可见，月/年榜是隐藏的同一套数据）
  const hot = qsa(doc, '#zhou li a[href]')
    .map((a) => {
      const url = absOf(a.getAttribute('href'));
      return url ? { url, title: text(a) } : null;
    })
    .filter((b): b is BookRef => !!b);
  if (hot.length) sections.push({ title: '热门', books: hot });

  // 最新小说
  const latest = qsa(doc, '.box .bk')
    .map(fromBk)
    .filter((b): b is BookRef => !!b);
  if (latest.length) sections.push({ title: '最新小说', books: latest });

  return sections;
}

/** 章节正文前面会重复一遍书籍简介，去掉 */
const CHAPTER_START = /^第[0-9一二三四五六七八九十百千零两]+[章节回][\s:：、]/;

function trimBoilerplate(paragraphs: string[]): string[] {
  const idx = paragraphs.findIndex((p) => CHAPTER_START.test(p));
  if (idx > 0 && idx <= 40) return paragraphs.slice(idx);
  return paragraphs;
}

const trxs: Site = {
  id: 'trxs',
  name: '同人小说网',
  icon: '同',
  baseUrl: BASE,
  kind: 'novel',
  color: '#e0567a',
  referer: BASE + '/',

  async home(ctx) {
    return parseHome(await ctx.doc(BASE + '/'));
  },

  async search(ctx, keyword) {
    // 站内搜索只有 POST 表单，提交后由 JS 跳到 session 绑定的结果页
    const doc = await ctx.submit(
      BASE + '/',
      `${BASE}/e/search/index.php`,
      { keyboard: keyword, show: 'title', classid: '0' },
      { waitFor: '.bk', timeoutMs: 25_000 },
    );

    const books = qsa(doc, '.bk')
      .map(fromBk)
      .filter((b): b is BookRef => !!b);

    if (!books.length) {
      const body = clean(doc.body?.textContent ?? '');
      if (/60/.test(body) && /限制|稍后|间隔/.test(body)) {
        throw new Error('搜索太频繁：该站限制 1 分钟一次');
      }
    }

    return books;
  },

  async detail(ctx, url) {
    const doc = await ctx.doc(url);
    const root = qs(doc, '.book_info') ?? doc.body;

    const rawTitle = text(qs(root, 'h1'));
    if (!rawTitle) throw new Error('没有解析到书名，页面可能已改版');

    const { title, status } = splitStatus(rawTitle);
    const dateText = text(qs(root, '.date'));

    const chapters: Chapter[] = qsa<HTMLAnchorElement>(doc, '.book_list a[href]')
      .map((a) => ({ title: text(a), url: absOf(a.getAttribute('href')) ?? '' }))
      .filter((c) => !!c.url);

    const detail: BookDetail = {
      url,
      title,
      status,
      author:
        text(qs(root, '.date a')) || /作者[：:]\s*(\S+)/.exec(dateText)?.[1] || undefined,
      cover: coverOf(root.querySelector('.pic') ?? root),
      intro: toParagraphs(qs(root, '.infos p')).join('\n') || undefined,
      chapters,
    };
    return detail;
  },

  async chapter(ctx, url) {
    const doc = await ctx.doc(url);
    const title = text(qs(doc, '.read_chapterName h1')) || text(qs(doc, 'h1'));
    const body = first(doc, ['.read_chapterDetail', '.readContent', '#content']);
    const paragraphs = trimBoilerplate(toParagraphs(body));
    if (!paragraphs.length) throw new Error('本章正文解析失败');

    const content: ChapterContent = { title, paragraphs };
    return content;
  },
};

export default trxs;
