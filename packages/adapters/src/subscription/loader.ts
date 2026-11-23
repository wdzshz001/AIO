import type { HostBridge, Site } from '@agg/core';
import type { SubscriptionFile } from './config.ts';
import { buildSite, isSupportedByPlatform } from './engine.ts';

/** animeko 官方在线源订阅 */
export const DEFAULT_SUBSCRIPTION = 'https://sub.creamycake.org/v1/css1.json';

const SUB_CACHE_KEY = 'agg.subscription.raw.v1';

function readCached(): string {
  try {
    return globalThis.localStorage?.getItem(SUB_CACHE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveCached(raw: string): void {
  try {
    globalThis.localStorage?.setItem(SUB_CACHE_KEY, raw);
  } catch {
    /* ignore quota */
  }
}

/** 拉订阅并生成 Site 列表；单个源配置有问题只跳过它 */
export async function loadSubscription(
  bridge: HostBridge,
  url: string = DEFAULT_SUBSCRIPTION,
): Promise<Site[]> {
  let raw = '';
  try {
    const res = await bridge.fetchHtml('subscription', url);
    raw = res.html.replace(/^\uFEFF/, '').trim();
    if (!raw.startsWith('{')) throw new Error('订阅返回的不是 JSON，可能被拦截');
    saveCached(raw);
  } catch (e) {
    // 网络/验证失败时优先用上一次成功的订阅，避免动画源整组消失
    const cached = readCached().replace(/^\uFEFF/, '').trim();
    if (cached.startsWith('{')) raw = cached;
    else throw e;
  }

  const json = JSON.parse(raw) as SubscriptionFile;
  const version = json.schemaVersion ?? 1;
  if (version > 2) {
    throw new Error(`订阅格式版本 ${version} 高于当前客户端支持的 2，请更新应用`);
  }

  const sources = json.mediaSources ?? [];
  const sites: Site[] = [];
  for (const src of sources) {
    try {
      if (!isSupportedByPlatform(src.arguments?.searchConfig?.onlySupportsPlayers)) continue;
      const site = buildSite(src);
      if (site) sites.push(site);
    } catch {
      // 跳过无法解析的源
    }
  }
  // 阶级高的源排在后面，UI 默认先展示低阶（更稳定）的源
  sites.sort((a, b) => (a.sourceTier ?? 99) - (b.sourceTier ?? 99));
  return sites;
}
