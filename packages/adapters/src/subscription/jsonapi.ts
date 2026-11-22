import {
  clean,
  episodeSortKey,
  formatEpisodeSort,
  parseEpisodeSort,
  qs,
  text,
  toParagraphs,
  videoKindOf,
} from '@agg/core';
import type {
  BookDetail,
  BookRef,
  BookSection,
  Chapter,
  ChapterContent,
  Site,
  SiteCtx,
} from '@agg/core';
import type { JsonApiRequest, RawSource, SearchConfig } from './config.ts';
import { autoMatchOf, finalBaseUrl, guessBaseUrl, parseHeaderLines } from './config.ts';
import { jsonPath } from './jsonpath.ts';

/**
 * animeko 的 `json-api` 数据源工厂（订阅里的「稀饭动漫 Next」）。
 *
 * 配置把「搜索 → 条目详情/剧集 → 播放地址」三段都描述成 HTTP 请求 + JSONPath，
 * 这里用一个通用执行器把三段串起来，站点改接口只要改订阅。
 */

type Vars = Record<string, string | number>;

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

function render(template: string, vars: Vars): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => {
    const v = vars[key];
    if (v === undefined) return m;
    if (key === 'keyword') {
      // 嵌在 JSON 字符串里：转义引号但不要外层引号
      return JSON.stringify(String(v)).slice(1, -1);
    }
    return String(v);
  });
}

/** 由 "https://x/anime/{id}" 生成提取 id 的正则 */
function templateRegex(template: string): RegExp | null {
  const keys: string[] = [];
  let pattern = '';
  let i = 0;
  while (i < template.length) {
    const m = /\{(\w+)\}/g;
    m.lastIndex = i;
    const hit = m.exec(template);
    if (!hit) {
      pattern += escapeRegExp(template.slice(i));
      break;
    }
    pattern += escapeRegExp(template.slice(i, hit.index));
    pattern += `(?<${hit[1]}>[^/?#]+)`;
    keys.push(hit[1]);
    i = hit.index + hit[0].length;
  }
  if (!keys.length) return null;
  try {
    return new RegExp('^' + pattern + '$');
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface JsonApiContext {
  cfg: SearchConfig;
  /** 详情页 URL → 解析出的 id，供播放时使用 */
  urlVars: Map<string, Vars>;
}

async function call(
  ctx: SiteCtx,
  req: JsonApiRequest | undefined,
  vars: Vars,
): Promise<unknown> {
  if (!req?.url) throw new Error('订阅缺少 json-api 请求地址');
  const url = render(req.url, vars);
  const headers: Record<string, string> = {
    ...parseHeaderLines(req.headers),
  };
  const body = req.body ? render(req.body, vars) : undefined;
  if (body && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  const method = (req.method ?? 'GET').toUpperCase() as 'GET' | 'POST';
  const res = await ctx.request(url, { method, headers, body, timeoutMs: 25_000 });
  const raw = res.body.replace(/^\uFEFF/, '').trim();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`接口返回 HTTP ${res.status}：${url}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`接口返回的不是 JSON：${url}`);
  }
}

function firstString(data: unknown, path: string | undefined): string | undefined {
  if (!path) return undefined;
  return asString(jsonPath(data, path)[0]);
}

export function buildJsonApiSite(src: RawSource): Site | null {
  const args = src.arguments ?? {};
  const cfg = args.searchConfig ?? {};
  const search = cfg.search;
  const subjectCfg = cfg.subject;
  if (!search?.request?.url || !subjectCfg?.request?.url) return null;

  const baseUrl = finalBaseUrl(cfg) || guessBaseUrl(cfg.search?.request?.url ?? '') || '';
  const name = clean(args.name ?? src.id) || src.id;
  const autoMatch = autoMatchOf(cfg);
  const state: JsonApiContext = { cfg, urlVars: new Map() };
  const searchCfg = search;
  const subCfg = subjectCfg;

  const subjectUrl = (id: string): string => {
    const tpl = searchCfg.subjectUrlTemplate;
    return tpl ? render(tpl, { id }) : id;
  };

  async function searchSubjects(ctx: SiteCtx, keyword: string): Promise<BookRef[]> {
    const pageSize = searchCfg.pageSize ?? 20;
    const data = await call(ctx, searchCfg.request, {
      keyword,
      page: 1,
      pageSize,
    });
    const items = jsonPath(data, searchCfg.selectItems ?? '$[*]');
    const out: BookRef[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const id = firstString(item, searchCfg.selectId);
      const title = firstString(item, searchCfg.selectName);
      if (!id || !title) continue;
      const url = subjectUrl(id);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, title });
    }
    return out;
  }

  async function detail(ctx: SiteCtx, url: string): Promise<BookDetail> {
    const sub = subCfg;
    let vars: Vars = { ...(state.urlVars.get(url) ?? {}) };
    if (!vars.id) {
      const re = searchCfg.subjectUrlTemplate ? templateRegex(searchCfg.subjectUrlTemplate) : null;
      const m = re?.exec(url);
      if (m?.groups) vars = { ...vars, ...m.groups };
    }
    if (!vars.id) {
      try {
        const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
        if (seg) vars.id = seg;
      } catch {
        /* ignore */
      }
    }
    if (!vars.id) throw new Error('无法从条目链接中解析 id');
    state.urlVars.set(url, vars);

    const data = await call(ctx, sub.request, vars);
    const epCfg = sub.episodes ?? {};
    const items = jsonPath(data, epCfg.selectEpisodes ?? '$[*]');

    const channels: string[] = [];
    if (sub.channelFormatId === 'grouped' && sub.channelFormatGrouped?.selectChannels) {
      for (const ch of jsonPath(data, sub.channelFormatGrouped.selectChannels)) {
        const n = asString(
          sub.channelFormatGrouped.selectChannelName
            ? jsonPath(ch, sub.channelFormatGrouped.selectChannelName)[0]
            : ch,
        );
        if (n && !channels.includes(n)) channels.push(n);
      }
    }

    const chapters: Chapter[] = [];
    items.forEach((item, index) => {
      const id = firstString(item, epCfg.selectId);
      const name = firstString(item, epCfg.selectName) ?? '';
      const sortRaw = firstString(item, epCfg.selectSort);
      const sort = parseEpisodeSort(sortRaw ?? String(index + 1));
      const sortText = formatEpisodeSort(sort);
      let title = (epCfg.nameTemplate ?? '{sort} {name}')
        .replace('{sort}', sortText)
        .replace('{name}', name)
        .trim();
      if (!title) title = `第${sortText}集`;
      if (!id) return;
      const epUrl = epCfg.episodeUrlTemplate
        ? render(epCfg.episodeUrlTemplate, { ...vars, id, subjectId: vars.id })
        : id;
      chapters.push({
        title,
        url: epUrl,
        sort: sortText,
        order: episodeSortKey(sort),
      });
      const m = epCfg.episodeUrlTemplate ? templateRegex(epCfg.episodeUrlTemplate)?.exec(epUrl) : null;
      if (m?.groups) state.urlVars.set(epUrl, { ...vars, ...m.groups, id });
    });

    chapters.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    const cover = firstString(data, '$.poster') ?? firstString(data, '$.cover');
    const summary = firstString(data, '$.summary') ?? firstString(data, '$.description');
    return {
      url,
      title: firstString(data, '$.title') ?? firstString(data, '$.name') ?? url,
      cover,
      intro: summary,
      chapters,
      channels,
    };
  }

  async function chapter(ctx: SiteCtx, url: string): Promise<ChapterContent> {
    const play = cfg.play;
    if (!play?.request?.url) throw new Error('订阅缺少 json-api 播放配置');
    let vars: Vars = { ...(state.urlVars.get(url) ?? {}) };
    if (!vars.id && cfg.subject?.episodes?.episodeUrlTemplate) {
      const re = templateRegex(cfg.subject.episodes.episodeUrlTemplate);
      const m = re?.exec(url);
      if (m?.groups) vars = { ...vars, ...m.groups };
    }
    if (!vars.id) throw new Error('无法从剧集链接中解析 id');

    const data = await call(ctx, play.request, vars);
    const candidates = jsonPath(data, play.selectCandidates ?? '$[*]');
    let videoUrl: string | undefined;
    let channel: string | undefined;
    for (const c of candidates) {
      const u = firstString(c, play.selectVideoUrl ?? '$.url');
      if (!u) continue;
      videoUrl = u;
      channel = firstString(c, play.selectCandidateChannel ?? '$.source_name');
      break;
    }
    if (!videoUrl && play.fallbackToFirstCandidate) {
      const first = candidates[0];
      if (first) videoUrl = firstString(first, play.selectVideoUrl ?? '$.url');
    }
    if (!videoUrl) throw new Error('播放接口没有返回可用地址');

    return {
      title: '',
      paragraphs: [],
      video: {
        url: videoUrl,
        kind: videoKindOf(videoUrl),
        referer: play.referer || baseUrl + '/',
      },
    };
  }

  return {
    id: `sub:${src.id}`,
    name,
    icon: name.slice(0, 1),
    color: siteColor(src.id),
    baseUrl,
    kind: 'anime',
    referer: baseUrl + '/',
    sourceTier: args.tier,
    channelTiers: args.channelTiers,
    autoMatch,
    defaultResolution: cfg.defaultResolution,

    async home(): Promise<BookSection[]> {
      return [];
    },

    search: searchSubjects,
    detail,
    chapter,
  };
}

function siteColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 52%)`;
}
