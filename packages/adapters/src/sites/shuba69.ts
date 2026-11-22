import { attr, clean, first, qs, qsa, text, toParagraphs } from '@agg/core';
import type {
  BookDetail,
  BookRef,
  BookSection,
  Chapter,
  ChapterContent,
  HarvestLink,
  Site,
  SiteCtx,
} from '@agg/core';

const BASE = 'https://69shuba.tw';

/** 一旦发现该站正文必须渲染才拿得到，后续章节直接走渲染，省一次无效请求 */
let chapterNeedsRender = false;

function bookId(url: string): string | null {
  const m = /\/book\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

/** 站点封面是协议相对地址 */
function coverUrl(src: string | undefined): string | undefined {
  if (!src) return undefined;
  if (src.startsWith('//')) return 'https:' + src;
  return src;
}

/** 列表页不给封面，但封面地址是固定规律：/前三位id/id/ids.jpg */
function coverFromId(url: string): string | undefined {
  const id = bookId(url);
  if (!id) return undefined;
  return `https://p.69shuba.tw/${id.slice(0, 3)}/${id}/${id}s.jpg`;
}

/** 列表项文案形如「作者：《书名》」 */
function splitAuthorTitle(raw: string): { author?: string; title: string } {
  const t = clean(raw);
  const m = /^(.+?)[：:]\s*(.+)$/.exec(t);
  const strip = (s: string) => s.replace(/^《/, '').replace(/》$/, '').trim();
  if (m) return { author: m[1].trim(), title: strip(m[2]) };
  return { title: strip(t) };
}

function parseHome(doc: Document): BookSection[] {
  const sections: BookSection[] = [];

  for (const sec of qsa(doc, '.s_m')) {
    const title = text(qs(sec, '.c_big_border')) || '推荐';
    const books: BookRef[] = [];
    const seen = new Set<string>();

    // 每个板块的头条是一张带简介的大卡
    const featured = qs(sec, '.sort_top');
    const featuredLink = qs<HTMLAnchorElement>(featured ?? sec, '.s_title');
    const featuredHref = featuredLink?.getAttribute('href');
    if (featured && featuredLink && featuredHref) {
      const url = new URL(featuredHref, BASE).toString();
      seen.add(url);
      const meta = text(qs(featured, '.s_div'));
      const slash = meta.split('/');
      books.push({
        url,
        title: text(featuredLink),
        author: slash.length > 1 ? slash[slash.length - 1].trim() : undefined,
        cover: coverUrl(attr(qs(featured, 'img'), 'src')),
        intro: text(qs(featured, '.s_intro')),
      });
    }

    for (const a of qsa<HTMLAnchorElement>(sec, '.s_list a')) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const url = new URL(href, BASE).toString();
      if (seen.has(url)) continue;
      seen.add(url);
      const { author, title: t } = splitAuthorTitle(a.textContent ?? '');
      if (!t) continue;
      books.push({ url, title: t, author, cover: coverFromId(url) });
    }

    if (books.length) sections.push({ title, books });
  }

  return sections;
}

const shuba69: Site = {
  id: 'shuba69',
  name: '69书吧',
  icon: '书',
  baseUrl: BASE,
  kind: 'novel',
  color: '#4f8cff',
  referer: BASE + '/',

  async home(ctx) {
    const doc = await ctx.doc(BASE + '/');
    return parseHome(doc);
  },

  async search(ctx, keyword) {
    // 列表页是 GET，但入口表单是 POST；搜索结果页本身可以直接 GET
    const doc = await ctx.doc(`${BASE}/search/1?searchkey=${encodeURIComponent(keyword)}`);
    const books: BookRef[] = [];

    for (const row of qsa(doc, 'table.list-item')) {
      const a = qs<HTMLAnchorElement>(row, '.article a[href]');
      const href = a?.getAttribute('href');
      if (!href) continue;
      const url = ctx.abs(href);
      if (!url) continue;

      const meta = text(qs(row, '.fs12.gray'));
      books.push({
        url,
        title: text(a),
        author: /作者[:：]\s*([^\s阅]+)/.exec(meta)?.[1],
        cover: coverUrl(attr(qs(row, 'img'), 'src')),
        extra: /字数[：:]\s*(.+)$/.exec(meta)?.[1],
      });
    }

    return books;
  },

  async detail(ctx, url) {
    const doc = await ctx.doc(url);
    const info = qs(doc, '.bookinfo') ?? doc.body;
    const title = text(qs(info, 'h1')) || text(qs(doc, 'h1'));
    if (!title) throw new Error('没有解析到书名，页面可能已改版或被拦截');

    let author = '';
    let status = '';
    for (const p of qsa(info, 'p')) {
      const t = text(p);
      if (/^作者/.test(t)) author = text(qs(p, 'a')) || t.replace(/^作者[：:]\s*/, '');
      if (/^状态/.test(t)) status = t.replace(/^状态[：:]\s*/, '');
    }

    const detail: BookDetail = {
      url,
      title,
      author: author || undefined,
      status: status || undefined,
      cover: coverUrl(attr(qs(info, 'table img'), 'src')),
      intro: text(qs(doc, '.intro')) || undefined,
      chapters: [],
    };
    return detail;
  },

  async chapters(ctx, bookUrl, onProgress) {
    const id = bookId(bookUrl);
    if (!id) throw new Error('无法识别书籍编号');

    const out: Chapter[] = [];
    const seen = new Set<string>();

    // 每页 100 章，链接只能靠真实点击拿到，逐页采集
    for (let page = 1; page <= 100; page++) {
      const listUrl = page === 1 ? `${BASE}/indexlist/${id}/` : `${BASE}/indexlist/${id}/${page}/`;
      let links: HarvestLink[] = [];
      try {
        links = await ctx.harvest(listUrl, '.ch-item');
      } catch {
        break;
      }
      const fresh = links.filter((l) => /\/read\//.test(l.url) && !seen.has(l.url));
      if (!fresh.length) break;
      for (const l of fresh) {
        seen.add(l.url);
        out.push({ title: clean(l.text), url: l.url });
      }
      // 采到一页先交出去，用户可以边读边等剩下几页
      onProgress?.(out.slice());
      if (links.length < 90) break;
    }

    if (!out.length) throw new Error('目录为空，可能需要先在站点内完成验证');
    return out;
  },

  async chapter(ctx, url) {
    // 该站正文在静态 HTML 里是被剥离的，必须真实渲染才能拿到
    const parse = (d: Document) => ({
      title: text(qs(d, '#nr_title')) || text(qs(d, 'h1')),
      paragraphs: toParagraphs(first(d, ['#nr1', '#nr_body', '.nr_nr', '#content'])),
    });

    let doc = await ctx.doc(url, chapterNeedsRender ? { render: true } : undefined);
    let parsed = parse(doc);

    if (!parsed.paragraphs.length && !chapterNeedsRender) {
      chapterNeedsRender = true;
      doc = await ctx.doc(url, { render: true });
      parsed = parse(doc);
    }

    if (!parsed.paragraphs.length) {
      throw new Error('本章正文解析失败，可能需要先在站点内完成验证');
    }

    const content: ChapterContent = { title: parsed.title, paragraphs: parsed.paragraphs };
    return content;
  },
};

export default shuba69;
