import type { HostBridge } from '@agg/core';
import { normalizeTitle, pickBestTitle } from '@agg/core';

/**
 * Bangumi 客户端（v0 API）。
 *
 * animeko 的条目体系就是 Bangumi：搜索只列条目，播放时再用条目名去各数据源找资源。
 * 这里提供三件事：
 * - `searchBangumi`：搜索动画条目
 * - `getBangumiSubject`：条目详情（含全部别名）
 * - `getBangumiEpisodes`：条目剧集表（集号 / 集名 / 播出日期）
 */

const API = 'https://api.bgm.tv';
const UA = 'agg/0.2 (local; https://github.com/open-ani/animeko)';

export interface BangumiSubject {
  id: number;
  name: string;
  nameCn?: string;
  cover?: string;
  date?: string;
  score?: number;
  summary?: string;
  tags: string[];
  eps?: number;
  totalEpisodes?: number;
  aliases: string[];
  /** nameCn、name、所有别名，顺序固定（用于数据源搜索） */
  allNames: string[];
  nsfw?: boolean;
}

export interface BangumiEpisode {
  id: number;
  /** 系列内集数；Bangumi 可能给字符串 */
  sort: number | string;
  /** 季度内集数 */
  ep?: number | null;
  name: string;
  nameCn?: string;
  airDate?: string;
  type?: number;
}

interface RawSearchSubject {
  id: number;
  name: string;
  name_cn?: string;
  date?: string;
  images?: Record<string, string>;
  image?: string;
  summary?: string;
  eps?: number;
  total_episodes?: number;
  rating?: { score?: number };
  tags?: { name?: string }[];
  infobox?: { key?: string; value?: unknown }[];
  nsfw?: boolean;
}

interface RawEpisode {
  id: number;
  type?: number;
  sort?: number | string;
  ep?: number | null;
  name?: string;
  name_cn?: string;
  air_date?: string;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    'user-agent': UA,
    accept: 'application/json',
    ...(extra ?? {}),
  };
}

async function parseJsonResponse(res: { status: number; body: string }, what: string): Promise<unknown> {
  const raw = res.body.replace(/^\uFEFF/, '').trim();
  if (res.status < 200 || res.status >= 300) {
    let detail = '';
    try {
      detail = (JSON.parse(raw) as { description?: string; title?: string }).description ?? '';
    } catch {
      /* ignore */
    }
    throw new Error(`Bangumi ${what} 失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
  }
  if (!raw.startsWith('{') && !raw.startsWith('[')) {
    throw new Error(`Bangumi ${what} 返回异常，可能被拦截`);
  }
  return JSON.parse(raw);
}

/** 从 infobox 里提取别名 */
function aliasesOf(raw: RawSearchSubject): string[] {
  const out: string[] = [];
  const info = raw.infobox ?? [];
  for (const item of info) {
    if (!item || typeof item.key !== 'string') continue;
    if (!/别名|別名|中文名|英文名/.test(item.key)) continue;
    const v = item.value;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === 'string') out.push(x);
        else if (x && typeof x === 'object' && typeof (x as { v?: unknown }).v === 'string') {
          out.push((x as { v: string }).v);
        }
      }
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

function toSubject(raw: RawSearchSubject): BangumiSubject {
  const name = raw.name?.trim() ?? '';
  const nameCn = raw.name_cn?.trim() || undefined;
  const aliases = aliasesOf(raw).filter((a) => a !== name && a !== nameCn);
  const allNames = [nameCn, name, ...aliases].filter((s): s is string => !!s);
  return {
    id: raw.id,
    name,
    nameCn,
    cover: (raw.images?.large ?? raw.images?.common ?? raw.image ?? '').replace(/^http:\/\//, 'https://') || undefined,
    date: raw.date || undefined,
    score: typeof raw.rating?.score === 'number' ? raw.rating.score : undefined,
    summary: raw.summary?.trim() || undefined,
    tags: (raw.tags ?? []).map((t) => t.name?.trim() ?? '').filter(Boolean),
    eps: raw.eps,
    totalEpisodes: raw.total_episodes,
    aliases,
    allNames: allNames.length ? allNames : [name],
    nsfw: raw.nsfw,
  };
}

/** 搜索动画条目（Bangumi type=2） */
export async function searchBangumi(
  bridge: HostBridge,
  keyword: string,
  limit = 20,
): Promise<BangumiSubject[]> {
  const body = JSON.stringify({
    keyword,
    filter: { type: [2] },
    sort: 'match',
  });

  try {
    const res = await bridge.request('bangumi', `${API}/v0/search/subjects?limit=${limit}&offset=0`, {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body,
      timeoutMs: 20_000,
    });
    const json = (await parseJsonResponse(res, '搜索')) as { data?: RawSearchSubject[] };
    const list = json.data ?? [];
    if (list.length) return list.map(toSubject);
  } catch {
    // 新接口失败时退回旧接口（老接口不需要 token，容错更高）
  }

  const legacy = await bridge.request(
    'bangumi',
    `${API}/search/subject/${encodeURIComponent(keyword)}?type=2&responseGroup=large`,
    { headers: headers(), timeoutMs: 20_000 },
  );
  const json = (await parseJsonResponse(legacy, '旧版搜索')) as { list?: RawSearchSubject[] };
  return (json.list ?? []).map(toSubject);
}

/** 条目详情 */
export async function getBangumiSubject(bridge: HostBridge, id: number): Promise<BangumiSubject> {
  const res = await bridge.request('bangumi', `${API}/v0/subjects/${id}`, {
    headers: headers(),
    timeoutMs: 20_000,
  });
  const json = (await parseJsonResponse(res, '条目详情')) as RawSearchSubject & {
    infobox?: { key?: string; value?: unknown }[];
  };
  return toSubject(json);
}

/** 条目的本篇剧集（type=0），自动翻页 */
export async function getBangumiEpisodes(
  bridge: HostBridge,
  subjectId: number,
): Promise<BangumiEpisode[]> {
  const out: BangumiEpisode[] = [];
  const limit = 100;
  for (let offset = 0; offset < 1000; offset += limit) {
    const res = await bridge.request(
      'bangumi',
      `${API}/v0/episodes?subject_id=${subjectId}&type=0&limit=${limit}&offset=${offset}`,
      { headers: headers(), timeoutMs: 20_000 },
    );
    const json = (await parseJsonResponse(res, '剧集列表')) as {
      data?: RawEpisode[];
      total?: number;
    };
    const list = json.data ?? [];
    for (const ep of list) {
      out.push({
        id: ep.id,
        sort: ep.sort ?? ep.ep ?? 0,
        ep: ep.ep ?? null,
        name: ep.name?.trim() ?? '',
        nameCn: ep.name_cn?.trim() || undefined,
        airDate: ep.air_date || undefined,
        type: ep.type,
      });
    }
    if (list.length < limit) break;
    if (typeof json.total === 'number' && offset + limit >= json.total) break;
  }

  out.sort((a, b) => {
    const na = Number(a.sort);
    const nb = Number(b.sort);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a.sort).localeCompare(String(b.sort));
  });
  return out;
}

/** 条目 + 剧集一次取回 */
export async function loadBangumiSubject(
  bridge: HostBridge,
  id: number,
): Promise<{ subject: BangumiSubject; episodes: BangumiEpisode[] }> {
  const [subject, episodes] = await Promise.all([
    getBangumiSubject(bridge, id),
    getBangumiEpisodes(bridge, id).catch(() => []),
  ]);
  return { subject, episodes };
}

/** 列表类接口（热度/本季/评分）的缓存，首页来回切换不用反复请求 */
const listCache = new Map<string, { at: number; data: BangumiSubject[] }>();
const LIST_TTL = 30 * 60_000;

export interface BangumiListOptions {
  sort?: 'match' | 'heat' | 'rank' | 'score';
  /** [起始日期, 结束日期)，YYYY-MM-DD */
  airDate?: [string, string];
  limit?: number;
}

/** 搜索条目列表（空关键词 + sort 即热度/评分榜） */
export async function listBangumi(
  bridge: HostBridge,
  opts: BangumiListOptions = {},
): Promise<BangumiSubject[]> {
  const { sort = 'heat', airDate, limit = 18 } = opts;
  const key = `${sort}|${airDate?.join('~') ?? ''}|${limit}`;
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.data;

  const filter: Record<string, unknown> = { type: [2] };
  if (airDate) filter.air_date = [`>=${airDate[0]}`, `<${airDate[1]}`];
  const body = JSON.stringify({ sort, filter });

  const res = await bridge.request(
    'bangumi',
    `${API}/v0/search/subjects?limit=${limit}&offset=0`,
    {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json' }),
      body,
      timeoutMs: 20_000,
    },
  );
  const json = (await parseJsonResponse(res, '条目列表')) as { data?: RawSearchSubject[] };
  const data = (json.data ?? []).map(toSubject);
  listCache.set(key, { at: Date.now(), data });
  return data;
}

/** 当前动画季度：[本季开始, 下季开始) */
export function currentAnimeSeason(now = new Date()): [string, string] {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const startMonth = Math.floor(m / 3) * 3; // 0/3/6/9
  const start = new Date(y, startMonth, 1);
  const end = new Date(y, startMonth + 3, 1);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  return [fmt(start), fmt(end)];
}

/** 热度榜（全站） */
export function getBangumiTrending(bridge: HostBridge, limit = 18): Promise<BangumiSubject[]> {
  return listBangumi(bridge, { sort: 'heat', limit });
}

/** 本季新番（按热度） */
export function getBangumiSeason(
  bridge: HostBridge,
  limit = 18,
  now = new Date(),
): Promise<BangumiSubject[]> {
  return listBangumi(bridge, { sort: 'heat', airDate: currentAnimeSeason(now), limit });
}

export interface BangumiCalendarItem {
  id: number;
  name: string;
  nameCn?: string;
  cover?: string;
  weekday: string;
  airWeekday?: number;
}

/** 每周放送表（旧版 /calendar 接口），用于动画首页 */
export async function getBangumiCalendar(bridge: HostBridge): Promise<BangumiCalendarItem[]> {
  const res = await bridge.request('bangumi', `${API}/calendar`, {
    headers: headers(),
    timeoutMs: 20_000,
  });
  const json = (await parseJsonResponse(res, '放送表')) as {
    weekday?: { cn?: string };
    items?: RawSearchSubject[];
  }[];
  const out: BangumiCalendarItem[] = [];
  for (const day of json) {
    const weekday = day.weekday?.cn ?? '';
    for (const item of day.items ?? []) {
      const name = item.name?.trim() ?? '';
      if (!name) continue;
      out.push({
        id: item.id,
        name,
        nameCn: item.name_cn?.trim() || undefined,
        cover:
          (item.images?.large ?? item.images?.common ?? item.images?.medium ?? '').replace(
            /^http:\/\//,
            'https://',
          ) || undefined,
        weekday,
        airWeekday: (item as { air_weekday?: number }).air_weekday,
      });
    }
  }
  return out;
}

/** 站点的标题是否命中条目任意别名 */
export function matchSubject(
  title: string,
  subjects: BangumiSubject[],
): BangumiSubject | undefined {
  const best = pickBestTitle(
    subjects.map((s) => ({ title: s.nameCn || s.name })),
    [title],
    { threshold: 80 },
  );
  if (best) return subjects[best.index];

  const key = normalizeTitle(title);
  if (!key) return undefined;
  return subjects.find((s) => s.allNames.some((n) => normalizeTitle(n) === key));
}
