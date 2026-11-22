/**
 * animeko 在线源订阅的结构（schemaVersion 2）。
 * 字段与 animeko 6.4.1 的 `SelectorSearchConfig` / `JsonApiSearchConfig` 对齐，
 * 只声明本项目用得到的部分，其余忽略。
 */

export interface RawSource {
  id: string;
  factoryId: string;
  version?: number;
  tags?: string[];
  arguments?: SourceArguments;
}

export interface SourceArguments {
  name?: string;
  description?: string;
  iconUrl?: string;
  /** 数据源阶级，越小越优先 */
  tier?: number;
  /** 线路级阶级覆盖 */
  channelTiers?: Record<string, number>;
  searchConfig?: SearchConfig;
}

export interface AutoMatchConfig {
  enabled?: boolean;
  searchUseOnlyFirstWord?: boolean;
  searchRemoveSpecial?: boolean;
  searchUseSubjectNamesCount?: number;
  preferShorterName?: boolean;
  filterByEpisodeSort?: boolean;
}

export interface SelectorSubjectFormatA {
  selectLists?: string;
  linkTemplate?: string;
  preferShorterName?: boolean;
}

export interface SelectorSubjectFormatIndexed {
  selectNames?: string;
  selectLinks?: string;
  linkTemplate?: string;
  preferShorterName?: boolean;
}

export interface SelectorSubjectFormatJsonPathIndexed {
  selectLinks?: string;
  selectNames?: string;
  linkTemplate?: string;
  preferShorterName?: boolean;
}

export interface SelectorChannelFormatFlattened {
  selectChannelNames?: string;
  matchChannelName?: string;
  selectEpisodeLists?: string;
  selectEpisodesFromList?: string;
  selectEpisodeLinksFromList?: string;
  matchEpisodeSortFromName?: string;
}

export interface SelectorChannelFormatNoChannel {
  selectEpisodes?: string;
  selectEpisodeLinks?: string;
  matchEpisodeSortFromName?: string;
}

export interface MatchVideoConfig {
  enableNestedUrl?: boolean;
  matchNestedUrl?: string;
  matchVideoUrl?: string;
  scanInlineScriptUrls?: boolean;
  scanDomMediaUrls?: boolean;
  cookies?: string;
  addHeadersToVideo?: { referer?: string; userAgent?: string };
}

export interface SelectMediaConfig {
  distinguishSubjectName?: boolean;
  distinguishChannelName?: boolean;
}

/** json-api 的请求模板 */
export interface JsonApiRequest {
  url?: string;
  method?: string;
  body?: string;
  headers?: string;
}

export interface JsonApiSearchConfig {
  request?: JsonApiRequest;
  pageSize?: number;
  selectItems?: string;
  selectName?: string;
  selectId?: string;
  subjectUrlTemplate?: string;
}

export interface JsonApiSubjectConfig {
  request?: JsonApiRequest;
  channelFormatId?: string;
  channelFormatGrouped?: { selectChannels?: string; selectChannelName?: string };
  episodes?: {
    selectEpisodes?: string;
    selectName?: string;
    selectId?: string;
    selectSort?: string;
    selectType?: string;
    typeMapping?: string;
    nameTemplate?: string;
    episodeUrlTemplate?: string;
  };
}

export interface JsonApiPlayConfig {
  request?: JsonApiRequest;
  selectCandidates?: string;
  selectCandidateChannel?: string;
  selectVideoUrl?: string;
  fallbackToFirstCandidate?: boolean;
  referer?: string;
}

export interface SearchConfig {
  name?: string;
  searchUrl?: string;
  baseUrl?: string;
  rawBaseUrl?: string;
  /** json-api 里是 "k: v\nk2: v2" */
  headers?: string;
  requestInterval?: number;
  searchCacheTtl?: number;
  userAgent?: string;

  searchUseOnlyFirstWord?: boolean;
  searchRemoveSpecial?: boolean;
  searchUseSubjectNamesCount?: number;
  filterByEpisodeSort?: boolean;
  filterBySubjectName?: boolean;
  autoMatch?: AutoMatchConfig;

  subjectFormatId?: string;
  channelFormatId?: string;

  selectorSubjectFormatA?: SelectorSubjectFormatA;
  selectorSubjectFormatIndexed?: SelectorSubjectFormatIndexed;
  selectorSubjectFormatJsonPathIndexed?: SelectorSubjectFormatJsonPathIndexed;

  selectorChannelFormatFlattened?: SelectorChannelFormatFlattened;
  selectorChannelFormatNoChannel?: SelectorChannelFormatNoChannel;

  selectMedia?: SelectMediaConfig;
  matchVideo?: MatchVideoConfig;
  defaultResolution?: string;
  defaultSubtitleLanguage?: string;
  onlySupportsPlayers?: string[];

  // json-api 专用
  search?: JsonApiSearchConfig;
  subject?: JsonApiSubjectConfig;
  play?: JsonApiPlayConfig;
}

export interface SubscriptionFile {
  schemaVersion?: number;
  mediaSources?: RawSource[];
}

/** 自动匹配配置，带默认值（与 animeko 6.4.1 一致） */
export function autoMatchOf(cfg: SearchConfig): Required<AutoMatchConfig> {
  const am = cfg.autoMatch ?? {};
  const preferShorter =
    am.preferShorterName ??
    cfg.selectorSubjectFormatA?.preferShorterName ??
    cfg.selectorSubjectFormatIndexed?.preferShorterName ??
    cfg.selectorSubjectFormatJsonPathIndexed?.preferShorterName ??
    true;
  return {
    enabled: am.enabled ?? true,
    searchUseOnlyFirstWord: am.searchUseOnlyFirstWord ?? cfg.searchUseOnlyFirstWord ?? true,
    searchRemoveSpecial: am.searchRemoveSpecial ?? cfg.searchRemoveSpecial ?? true,
    searchUseSubjectNamesCount:
      am.searchUseSubjectNamesCount ?? cfg.searchUseSubjectNamesCount ?? 1,
    preferShorterName: preferShorter,
    filterByEpisodeSort: am.filterByEpisodeSort ?? cfg.filterByEpisodeSort ?? true,
  };
}

/** 详情页链接的基准地址：rawBaseUrl 优先，否则从 searchUrl 猜 */
export function finalBaseUrl(cfg: SearchConfig): string {
  const raw = cfg.rawBaseUrl?.trim();
  if (raw) return raw.replace(/\/+$/, '');
  return guessBaseUrl(cfg.searchUrl ?? cfg.baseUrl ?? '');
}

export function guessBaseUrl(url: string): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

export function parseHeaderLines(text?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of (text ?? '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}
