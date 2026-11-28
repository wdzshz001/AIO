import type { BookRef, BookSection, Site, SiteCtx, SiteKind } from '@agg/core';
import { QIDIAN_CATEGORIES, loadQidianCategory, loadQidianRank } from './sites/qidian.ts';
import {
  CLOUDWN_CATEGORIES,
  loadCloudwnCategory,
  loadCloudwnRank,
} from './sites/cloudwn.ts';
import {
  TTKS_CATEGORIES,
  loadTtksCategory,
  loadTtksRank,
} from './sites/ttks.ts';

export type ChannelMode = 'recommend' | 'rank' | 'category';

export interface SiteChannel {
  id: string;
  siteId: string;
  siteName: string;
  kind: SiteKind;
  title: string;
  mode: ChannelMode;
  books: BookRef[];
  moreUrl?: string;
}

function channelOf(
  site: Site,
  mode: ChannelMode,
  section: BookSection,
  index: number,
): SiteChannel {
  return {
    id: `${site.id}:${mode}:${index}`,
    siteId: site.id,
    siteName: site.name,
    kind: site.kind,
    title: section.title,
    mode,
    books: section.books,
    moreUrl: section.moreUrl,
  };
}

/** 源站首页/推荐频道 */
export async function loadRecommendChannels(
  site: Site,
  ctx: SiteCtx,
): Promise<SiteChannel[]> {
  if (!site.home) return [];
  const sections = await site.home(ctx);
  return sections
    .filter((s) => s.books.length)
    .map((s, i) => channelOf(site, 'recommend', s, i));
}

/** 源站排行频道：目前起点、ttks 有独立排行页 */
export async function loadRankChannels(site: Site, ctx: SiteCtx): Promise<SiteChannel[]> {
  let sections: BookSection[] = [];
  if (site.id === 'qidian') sections = await loadQidianRank(ctx);
  else if (site.id === 'ttks') sections = await loadTtksRank(ctx);
  else if (site.id === 'cloudwn') sections = await loadCloudwnRank(ctx);
  return sections.map((s, i) => channelOf(site, 'rank', s, i));
}

/** 分类频道元数据；不加载内容，只告诉 UI 可选分类 */
export function channelCategories(site: Site): { id: string; name: string }[] {
  if (site.id === 'qidian') return QIDIAN_CATEGORIES;
  if (site.id === 'ttks') return TTKS_CATEGORIES;
  if (site.id === 'cloudwn') return CLOUDWN_CATEGORIES;
  return [];
}

export function hasRankChannels(site: Site): boolean {
  return site.id === 'qidian' || site.id === 'ttks' || site.id === 'cloudwn';
}

export async function loadCategoryChannels(
  site: Site,
  ctx: SiteCtx,
  categoryId?: string,
): Promise<SiteChannel[]> {
  const cats = channelCategories(site);
  if (!cats.length) return [];
  const cat = cats.find((c) => c.id === categoryId) ?? cats[0];
  let sections: BookSection[] = [];
  if (site.id === 'qidian') sections = await loadQidianCategory(ctx, cat.id, cat.name);
  else if (site.id === 'ttks') sections = await loadTtksCategory(ctx, cat.id, cat.name);
  else if (site.id === 'cloudwn') sections = await loadCloudwnCategory(ctx, cat.id, cat.name);
  return sections.map((s, i) => channelOf(site, 'category', s, i));
}

/** 发现页默认订阅的源站频道配置 */
export const DEFAULT_CHANNEL_TARGETS: { siteId: string; mode: ChannelMode; limit: number }[] = [
  { siteId: 'qidian', mode: 'recommend', limit: 2 },
  { siteId: 'qidian', mode: 'rank', limit: 3 },
  { siteId: 'ttks', mode: 'recommend', limit: 2 },
  { siteId: 'ttks', mode: 'rank', limit: 1 },
  { siteId: 'cloudwn', mode: 'recommend', limit: 1 },
  { siteId: 'cloudwn', mode: 'rank', limit: 1 },
  { siteId: 'mycomic', mode: 'recommend', limit: 1 },
  { siteId: 'mangacopy', mode: 'recommend', limit: 1 },
];
