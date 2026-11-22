import {
  absUrl,
  clean,
  compilePattern,
  convertSpecialEpisode,
  DEFAULT_EPISODE_SORT_PATTERN,
  episodeSortKey,
  formatEpisodeSort,
  qsa,
  text,
  type EpisodeSort,
} from '@agg/core';
import type { SearchConfig } from './config.ts';

export interface ParsedSubject {
  title: string;
  href: string;
  /** 命中这个条目的原始元素（用于抓封面） */
  el?: Element;
}

export interface ParsedEpisode {
  title: string;
  href: string;
  channel?: string;
  /** 规范化的集号，如 "01"、"SP01" */
  sort?: string;
  /** 集号排序键 */
  order?: number;
}

export interface ParsedChapters {
  chapters: ParsedEpisode[];
  channels: string[];
}

/** 把模板里的 {value} 换成抽出的原始值 */
export function applyLinkTemplate(template: string | undefined, value: string): string {
  if (!template || !template.trim()) return value;
  return template.split('{value}').join(value);
}

/**
 * 解析详情页链接。与浏览器一致：https 页面里硬编码的 http 同域链接升级为 https。
 */
export function resolveHref(baseUrl: string, href: string | null | undefined): string | undefined {
  const abs = absUrl(href, baseUrl);
  if (!abs) return undefined;
  try {
    const base = new URL(baseUrl);
    const target = new URL(abs);
    if (
      base.protocol === 'https:' &&
      target.protocol === 'http:' &&
      target.port === '' &&
      base.host.replace(/^www\./, '') === target.host.replace(/^www\./, '')
    ) {
      target.protocol = 'https:';
      return target.toString();
    }
  } catch {
    /* ignore */
  }
  return abs;
}

/** 解析搜索结果页里的条目（a / indexed 两种格式） */
export function parseSubjectAnchors(doc: ParentNode, cfg: SearchConfig): ParsedSubject[] {
  const format = cfg.subjectFormatId ?? 'a';
  const out: ParsedSubject[] = [];
  const seen = new Set<string>();

  if (format === 'indexed') {
    const f = cfg.selectorSubjectFormatIndexed;
    const names = qsa(doc, f?.selectNames || '.search-box .thumb-content > .thumb-txt')
      .map((el) => text(el))
      .filter(Boolean);
    const links = qsa<HTMLAnchorElement>(doc, f?.selectLinks || '.search-box .thumb-menu > a')
      .map((a) => a.getAttribute('href') ?? '')
      .filter(Boolean);
    const n = Math.min(names.length, links.length);
    for (let i = 0; i < n; i++) {
      const href = applyLinkTemplate(f?.linkTemplate, links[i]);
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const el = qsa<HTMLAnchorElement>(doc, f?.selectLinks || '.search-box .thumb-menu > a')[i];
      out.push({ title: names[i], href, el });
    }
    return out;
  }

  const f = cfg.selectorSubjectFormatA;
  for (const a of qsa<HTMLAnchorElement>(doc, f?.selectLists || 'div.video-info-header > a')) {
    const title = clean(a.getAttribute('title') || text(a));
    let href = a.getAttribute('href') ?? '';
    if (!title || !href) continue;
    href = applyLinkTemplate(f?.linkTemplate, href);
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title, href, el: a });
  }
  return out;
}

function sortFromName(name: string, pattern: string | undefined): EpisodeSort {
  const p = pattern === undefined ? DEFAULT_EPISODE_SORT_PATTERN : pattern;
  if (!p.trim()) return convertSpecialEpisode(name, null);
  const re = compilePattern(p);
  if (!re) return convertSpecialEpisode(name, null);
  const m = re.exec(name);
  if (!m) return convertSpecialEpisode(name, null);
  const group = (m.groups as Record<string, string | undefined> | undefined)?.ep;
  return convertSpecialEpisode(name, group ?? name);
}

function selectLinksFrom(parent: ParentNode, selector: string | undefined): string[] | null {
  if (!selector || !selector.trim()) return null;
  return qsa<HTMLAnchorElement>(parent, selector)
    .map((a) => a.getAttribute('href') ?? '')
    .filter(Boolean);
}

/**
 * 解析条目页的线路与剧集列表。
 * 与 animeko `SelectorChannelFormatIndexGrouped` / `NoChannel` 一致：
 * 线路名与播放列表按下标一一对应，集号从标题正则里取（`matchEpisodeSortFromName`）。
 */
export function parseChapters(doc: ParentNode, cfg: SearchConfig): ParsedChapters {
  const format =
    cfg.channelFormatId ?? (cfg.selectorChannelFormatFlattened ? 'index-grouped' : 'no-channel');

  const episodes: ParsedEpisode[] = [];
  const channels: string[] = [];

  if (format === 'index-grouped') {
    const f = cfg.selectorChannelFormatFlattened ?? {};
    const channelLabels = qsa(doc, f.selectChannelNames || '.anthology-tab > .swiper-wrapper a').map(
      (el) => {
        const label = text(el).trim();
        if (!label) return null;
        const re = f.matchChannelName ? compilePattern(f.matchChannelName) : null;
        if (!re) {
          // 配置为空 → 用完整文本；配置非法 → 该线路不参与
          return f.matchChannelName ? null : { label, name: label };
        }
        const m = re.exec(label);
        if (!m) return null;
        const name = (m.groups as Record<string, string | undefined> | undefined)?.ch ?? m[0];
        return { label, name: clean(name) || label };
      },
    );

    const lists = qsa(doc, f.selectEpisodeLists || '.anthology-list-box');
    lists.forEach((list, index) => {
      const channel = channelLabels[index];
      if (!channel) return;
      const links = selectLinksFrom(list, f.selectEpisodeLinksFromList);
      const items = qsa(list, f.selectEpisodesFromList || 'a');
      items.forEach((el, i) => {
        const title = clean(text(el));
        const href = links?.[i] ?? el.getAttribute('href') ?? '';
        if (!title || !href) return;
        const sort = sortFromName(title, f.matchEpisodeSortFromName);
        episodes.push({
          title,
          href,
          channel: channel.name,
          sort: formatEpisodeSort(sort),
          order: episodeSortKey(sort),
        });
      });
      if (!channels.includes(channel.name)) channels.push(channel.name);
    });
  } else {
    const f = cfg.selectorChannelFormatNoChannel ?? {};
    const links = selectLinksFrom(doc, f.selectEpisodeLinks);
    const items = qsa(
      doc,
      f.selectEpisodes || '#glist-1 > div.module-blocklist.scroll-box.scroll-box-y > div > a',
    );
    items.forEach((el, i) => {
      const title = clean(text(el));
      const href = links?.[i] ?? el.getAttribute('href') ?? '';
      if (!title || !href) return;
      const sort = sortFromName(title, f.matchEpisodeSortFromName);
      episodes.push({
        title,
        href,
        sort: formatEpisodeSort(sort),
        order: episodeSortKey(sort),
      });
    });
  }

  return { chapters: episodes, channels };
}

/** 片头/简介文本：优先常见容器 */
export function parseIntro(doc: ParentNode): string | undefined {
  const el = doc.querySelector('.module-info-introduction, .fed-part-esan, .info, #desc, .intro');
  if (!el) return undefined;
  const t = text(el);
  return t || undefined;
}

/** 条目页标题 */
export function parseSubjectTitle(doc: Document, fallback: string): string {
  const h1 = text(doc.querySelector('h1'));
  if (h1) return h1;
  const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
  if (og) return clean(og);
  const raw = text(doc.querySelector('title'));
  if (raw) {
    // 去掉「- 站点名」「_站点名」这类后缀
    const cut = raw.replace(/\s*[-_|｜]\s*[^-_|｜]{1,30}\s*$/, '').trim();
    if (cut) return cut;
  }
  return clean(fallback);
}
