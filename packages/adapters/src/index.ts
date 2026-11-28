import type { AppDef, Site } from '@agg/core';
import shuba69 from './sites/shuba69.ts';
import trxs from './sites/trxs.ts';
import qidian from './sites/qidian.ts';
import deqixss from './sites/deqixss.ts';
import ttks from './sites/ttks.ts';
import cloudwn from './sites/cloudwn.ts';
import mycomic from './sites/mycomic.ts';
import mangacopy from './sites/mangacopy.ts';

/**
 * 静态站点：起点 / 得奇小说 / 小说站 / 三个漫画源。
 * 动画源全部来自 animeko 在线源订阅（运行时加载），见 subscription/loader.ts。
 */
export const sites: Site[] = [qidian, deqixss, ttks, shuba69, trxs, cloudwn, mycomic, mangacopy];

/**
 * 应用注册表：用户只面对应用，站点在应用内部聚合。
 * 以后加漫画/论坛，只需要新增一个 AppDef 和对应站点。
 */
export const apps: AppDef[] = [
  {
    id: 'novel',
    name: '小说',
    icon: '书',
    color: '#4f8cff',
    kinds: ['novel'],
    desc: '小说 · 发现与书架',
  },
  {
    id: 'anime',
    name: '动画',
    icon: '番',
    color: '#e0567a',
    kinds: ['anime'],
    desc: '动画 · 新番与追番',
  },
  {
    id: 'comic',
    name: '漫画',
    icon: '漫',
    color: '#e08a3c',
    kinds: ['comic'],
    desc: '漫画 · 发现与阅读',
  },
];

export function getSite(id: string, list: Site[] = sites): Site | undefined {
  return list.find((s) => s.id === id);
}

export function getApp(id: string): AppDef | undefined {
  return apps.find((a) => a.id === id);
}

export function sitesOfApp(app: AppDef, list: Site[] = sites): Site[] {
  return list.filter((s) => app.kinds.includes(s.kind));
}

export function appOfSite(siteId: string, list: Site[] = sites): AppDef | undefined {
  const site = getSite(siteId, list);
  if (!site) return undefined;
  return apps.find((a) => a.kinds.includes(site.kind));
}

export { loadSubscription, DEFAULT_SUBSCRIPTION } from './subscription/loader.ts';
export {
  searchBangumi,
  getBangumiSubject,
  getBangumiEpisodes,
  loadBangumiSubject,
  getBangumiCalendar,
  listBangumi,
  getBangumiTrending,
  getBangumiSeason,
  currentAnimeSeason,
  matchSubject,
} from './bangumi.ts';
export type { BangumiSubject, BangumiEpisode, BangumiCalendarItem } from './bangumi.ts';
export * from './anime/catalog.ts';
export {
  QIDIAN_CATEGORIES,
  loadQidianHome,
  loadQidianRank,
  loadQidianCategory,
  loadQidianList,
} from './sites/qidian.ts';
export { isSupportedByPlatform } from './subscription/engine.ts';
