import {
  DEFAULT_EPISODE_SORT_PATTERN,
  episodeSortContains,
  episodeSortKey,
  formatEpisodeSort,
  matchEpisodeSortFromName,
  matchesAnyTitle,
  normalizeTitle,
  parseEpisodeSort,
  pickBestTitle,
  runtime,
  type Chapter,
  type EpisodeSort,
  type Site,
  type SiteCtx,
} from '@agg/core';
import type { BangumiEpisode, BangumiSubject } from '../bangumi.ts';
import { autoMatchOf } from '../subscription/config.ts';

/**
 * 动画条目服务：把 Bangumi 条目落到各数据源。
 *
 * 对应 animeko 的 `MediaSource.fetch(MediaFetchRequest)`：
 * 用条目的多个名字依次搜索源站 → 用标题匹配出同一个作品 → 解析条目页全部剧集
 * → 按集号找到请求的那一集。结果按源缓存，切集不会重复搜索。
 */

export interface SourceCandidate {
  siteId: string;
  siteName: string;
  url: string;
  title: string;
  chapters: Chapter[];
  /** 在 chapters 里的下标 */
  index: number;
  channel?: string;
  sort?: string;
  score: number;
}

export interface SourceLookup {
  siteId: string;
  siteName: string;
  status: 'pending' | 'ok' | 'empty' | 'error';
  candidate?: SourceCandidate;
  error?: string;
  /** 站点提供的线路名（用于展示/换线） */
  channels?: string[];
  elapsedMs?: number;
}

interface SourceDetail {
  url: string;
  title: string;
  chapters: Chapter[];
  channels: string[];
  score: number;
}

const DETAIL_TTL = 10 * 60_000;
const detailCache = new Map<string, { at: number; promise: Promise<SourceDetail | null> }>();

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 「孤独摇滚！第二季」→「孤独摇滚！」：站点常把多季放在第一季条目里 */
function baseName(name: string): string {
  return name
    .replace(/\s*(第[0-9一二三四五六七八九十]+季|Season\s*\d+|S\d+)\s*/gi, '')
    .trim();
}

/** 搜索关键词：优先中文名，其次原名与别名，去重后最多 max 个 */
export function subjectKeywords(subject: BangumiSubject, site: Site, max = 5): string[] {
  const count = Math.max(1, site.autoMatch?.searchUseSubjectNamesCount ?? 1);
  const ordered = [
    subject.nameCn,
    subject.name,
    ...subject.aliases,
    baseName(subject.nameCn ?? ''),
    baseName(subject.name),
  ].filter((s): s is string => !!s && s.trim().length > 0);

  const out: string[] = [];
  const seen = new Set<string>();
  const limit = Math.min(max, Math.max(2, count));
  for (const name of ordered) {
    const key = normalizeTitle(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

function channelCost(
  site: Pick<Site, 'sourceTier' | 'channelTiers'>,
  channel: string | undefined,
): number {
  if (!channel) return site.sourceTier ?? 99;
  const byChannel = site.channelTiers?.[channel];
  if (typeof byChannel === 'number') return byChannel;
  return site.sourceTier ?? 99;
}

function matchChapterIndex(site: Site, chapters: Chapter[], episode: BangumiEpisode): number {
  if (!chapters.length) return -1;
  const target = parseEpisodeSort(String(episode.sort ?? ''));
  const epSort =
    episode.ep != null ? parseEpisodeSort(String(episode.ep)) : null;

  const parsed = chapters.map((c) => ({
    chapter: c,
    sort: c.sort ? parseEpisodeSort(c.sort) : matchEpisodeSortFromName(c.title, DEFAULT_EPISODE_SORT_PATTERN),
  }));

  /** 同一集可能同时出现在多个线路里，取阶级最低的线路 */
  const bestIndex = (hits: number[]): number => {
    let best = hits[0];
    for (const i of hits) {
      if (channelCost(site, chapters[i].channel) < channelCost(site, chapters[best].channel)) best = i;
    }
    return best;
  };

  for (const want of [target, epSort]) {
    if (!want || want.kind === 'unknown') continue;
    const hits: number[] = [];
    parsed.forEach((p, i) => {
      if (episodeSortContains(p.sort, want)) hits.push(i);
    });
    if (hits.length) return bestIndex(hits);
  }

  // 特殊集（SP/OVA）按名字匹配
  if (target.kind === 'special' && episode.name) {
    const key = normalizeTitle(episode.name);
    const idx = chapters.findIndex((c) => key && normalizeTitle(c.title).includes(key));
    if (idx >= 0) return idx;
  }

  // 站点完全没给集号时，退化为按序号取
  if (parsed.every((p) => p.sort.kind === 'unknown')) {
    const n = epSort?.kind === 'normal' ? epSort.number : target.kind === 'normal' ? target.number : NaN;
    if (Number.isFinite(n) && n >= 1 && n <= chapters.length) return Math.round(n) - 1;
  }

  return -1;
}

/** 在一个源站上找条目的详情页（含全部剧集），按站点+条目缓存 */
export async function resolveSourceDetail(
  site: Site,
  ctx: SiteCtx,
  subject: BangumiSubject,
): Promise<SourceDetail | null> {
  if (!site.search) return null;
  const cacheKey = `${site.id}|${subject.id}`;
  const hit = detailCache.get(cacheKey);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.promise;

  const promise = (async (): Promise<SourceDetail | null> => {
    const keywords = subjectKeywords(subject, site);
    for (const keyword of keywords) {
      let refs;
      try {
        refs = await withTimeout(
          site.search!(ctx, keyword),
          25_000,
          `${site.name} 搜索超时`,
        );
      } catch {
        continue;
      }
      if (!refs.length) continue;

      const best = pickBestTitle(refs, subject.allNames, {
        preferShorterName: site.autoMatch?.preferShorterName ?? true,
        threshold: 80,
      });
      if (!best) continue;

      try {
        const detail = await withTimeout(
          site.detail(ctx, refs[best.index].url),
          25_000,
          `${site.name} 条目页超时`,
        );
        if (!detail.chapters.length) continue;
        const ref = refs[best.index];
        const title = /^https?:\/\//i.test(detail.title) ? ref.title : detail.title;
        return {
          url: ref.url,
          title,
          chapters: detail.chapters,
          channels: detail.channels ?? [],
          score: best.score,
        };
      } catch {
        continue;
      }
    }
    return null;
  })();

  detailCache.set(cacheKey, { at: Date.now(), promise });
  const result = await promise.catch(() => null);
  if (!result) detailCache.delete(cacheKey);
  return result;
}

/** 在源站上定位某一集，返回可直接播放的候选 */
export async function resolveEpisodeOnSite(
  site: Site,
  ctx: SiteCtx,
  subject: BangumiSubject,
  episode: BangumiEpisode,
): Promise<SourceCandidate | null> {
  const detail = await resolveSourceDetail(site, ctx, subject);
  if (!detail) return null;
  const index = matchChapterIndex(site, detail.chapters, episode);
  if (index < 0) return null;
  const chosen = detail.chapters[index];
  // 播放列表只保留同一条线路，上一集/下一集才不会跨线路乱跳
  const list = chosen.channel
    ? detail.chapters.filter((c) => c.channel === chosen.channel)
    : detail.chapters;
  const listIndex = Math.max(0, list.findIndex((c) => c.url === chosen.url));
  return {
    siteId: site.id,
    siteName: site.name,
    url: detail.url,
    title: detail.title,
    chapters: list,
    index: listIndex,
    channel: chosen.channel,
    sort: chosen.sort,
    score: detail.score,
  };
}

/**
 * 并行在所有动画源里为某一集找资源。
 * 单源失败不影响其他源；每完成一个就回调一次，UI 可以边出边显示。
 */
export async function findEpisodeSources(
  ctxFor: (siteId: string) => SiteCtx | null,
  sites: Site[],
  subject: BangumiSubject,
  episode: BangumiEpisode,
  onUpdate?: (lookup: SourceLookup) => void,
  opts: { concurrency?: number } = {},
): Promise<SourceLookup[]> {
  const candidates = sites.filter((s) => s.kind === 'anime' && !!s.search && !!s.detail);
  const results: SourceLookup[] = candidates.map((s) => ({
    siteId: s.id,
    siteName: s.name,
    status: 'pending' as const,
  }));

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < candidates.length) {
      const i = cursor++;
      const site = candidates[i];
      const started = Date.now();
      let lookup: SourceLookup;
      const ctx = ctxFor(site.id);
      if (!ctx) {
        lookup = { siteId: site.id, siteName: site.name, status: 'error', error: '站点未就绪' };
      } else if (site.autoMatch && !site.autoMatch.enabled) {
        lookup = { siteId: site.id, siteName: site.name, status: 'empty', error: '该源未启用自动匹配' };
      } else {
        try {
          const candidate = await withTimeout(
            resolveEpisodeOnSite(site, ctx, subject, episode),
            60_000,
            `${site.name} 查找超时`,
          );
          lookup = candidate
            ? {
                siteId: site.id,
                siteName: site.name,
                status: 'ok',
                candidate,
                channels: candidate.chapters
                  .map((c) => c.channel)
                  .filter((c): c is string => !!c)
                  .filter((c, idx, arr) => arr.indexOf(c) === idx),
              }
            : { siteId: site.id, siteName: site.name, status: 'empty' };
        } catch (e) {
          lookup = {
            siteId: site.id,
            siteName: site.name,
            status: 'error',
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
      lookup.elapsedMs = Date.now() - started;
      results[i] = lookup;
      onUpdate?.(lookup);
    }
  };

  const n = Math.max(1, Math.min(opts.concurrency ?? runtime.searchConcurrency, candidates.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** 结果排序：源阶级 → 线路阶级 → 匹配分（高） → 标题更短 */
export function rankLookups(lookups: SourceLookup[], sites: Site[]): SourceLookup[] {
  const siteById = new Map(sites.map((s) => [s.id, s]));
  return lookups
    .filter((l) => l.status === 'ok' && l.candidate)
    .sort((a, b) => {
      const ca = a.candidate!;
      const cb = b.candidate!;
      const sa = channelCost(siteById.get(ca.siteId) ?? { sourceTier: 99 }, ca.channel);
      const sb = channelCost(siteById.get(cb.siteId) ?? { sourceTier: 99 }, cb.channel);
      if (sa !== sb) return sa - sb;
      if (ca.score !== cb.score) return cb.score - ca.score;
      if (ca.title.length !== cb.title.length) return ca.title.length - cb.title.length;
      return ca.siteName.localeCompare(cb.siteName);
    });
}

/** 集号显示：优先站点解析出的规范集号 */
export function episodeLabel(episode: BangumiEpisode): string {
  const sort = parseEpisodeSort(String(episode.sort ?? ''));
  return formatEpisodeSort(sort);
}

/** 给 UI 的集号排序键 */
export function episodeOrder(episode: BangumiEpisode): number {
  return episodeSortKey(parseEpisodeSort(String(episode.sort ?? '')));
}

/** 小说/通用：按标题在同类站点里找同名作品，用于换源 */
export async function findSourcesByTitle(
  ctxFor: (siteId: string) => SiteCtx | null,
  sites: Site[],
  title: string,
  kind: Site['kind'],
  onUpdate?: (siteId: string, state: { status: SourceLookup['status']; ref?: { url: string; title: string }; error?: string }) => void,
): Promise<{ siteId: string; url: string; title: string }[]> {
  const list = sites.filter((s) => s.kind === kind && !!s.search);
  const out: { siteId: string; url: string; title: string }[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < list.length) {
      const site = list[cursor++];
      const ctx = ctxFor(site.id);
      if (!ctx || !site.search) {
        onUpdate?.(site.id, { status: 'error', error: '站点未就绪' });
        continue;
      }
      try {
        const refs = await withTimeout(site.search(ctx, title), 25_000, '搜索超时');
        const best = refs.length
          ? pickBestTitle(refs, [title], { preferShorterName: true, threshold: 80 })
          : null;
        if (!best) {
          onUpdate?.(site.id, { status: 'empty' });
          continue;
        }
        const ref = refs[best.index];
        out.push({ siteId: site.id, url: ref.url, title: ref.title });
        onUpdate?.(site.id, { status: 'ok', ref });
      } catch (e) {
        onUpdate?.(site.id, {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
  return out;
}

export { autoMatchOf, matchesAnyTitle };
