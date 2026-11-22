/**
 * 剧集序号，移植自 animeko 的 `EpisodeSort`。
 *
 * - normal：普通正片，如 "01"、"24.5"（只接受整数与 .5）
 * - special：特殊剧集，如 "SP01"、"OVA1"
 * - unknown：解析不了的原字符串
 *
 * 站点上的标题往往写作「第12集」「12」「SP1」，统一解析后就能跨源匹配同一集。
 */
export type EpisodeKind = 'main' | 'SP' | 'OP' | 'ED' | 'PV' | 'MAD' | 'OVA' | 'OAD';

export interface NormalEpisodeSort {
  kind: 'normal';
  number: number;
  raw: string;
}

export interface SpecialEpisodeSort {
  kind: 'special';
  type: EpisodeKind;
  number: number | null;
  raw: string;
}

export interface UnknownEpisodeSort {
  kind: 'unknown';
  raw: string;
}

export type EpisodeSort = NormalEpisodeSort | SpecialEpisodeSort | UnknownEpisodeSort;

/** 与 Kotlin 枚举顺序一致，用于排序 */
const SPECIAL_TYPES: EpisodeKind[] = ['main', 'SP', 'OP', 'ED', 'PV', 'MAD', 'OVA', 'OAD'];

export const DEFAULT_EPISODE_SORT_PATTERN = '第\\s*(?<ep>.+)\\s*[话集]';

export function normalEpisode(number: number): NormalEpisodeSort {
  return { kind: 'normal', number, raw: String(number) };
}

function isHalfStep(n: number): boolean {
  return Number.isInteger(n) || Math.abs(n % 1 - 0.5) < 1e-9;
}

export function parseEpisodeSort(rawInput: string): EpisodeSort {
  const raw = (rawInput ?? '').trim();
  if (!raw) return { kind: 'unknown', raw: '' };

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (n >= 0 && isHalfStep(n)) return { kind: 'normal', number: n, raw };
    return { kind: 'unknown', raw };
  }

  const upper = raw.toUpperCase();
  for (const type of SPECIAL_TYPES) {
    if (type === 'main') continue;
    if (!upper.startsWith(type)) continue;
    const rest = raw.slice(type.length).trim();
    const n = Number(rest);
    if (rest && Number.isFinite(n) && n >= 0 && isHalfStep(n)) {
      return { kind: 'special', type, number: n, raw };
    }
    return { kind: 'unknown', raw };
  }

  return { kind: 'unknown', raw };
}

function padNumber(n: number): string {
  if (Number.isInteger(n) && n < 10 && n >= 0) return '0' + n;
  return String(n);
}

export function formatEpisodeSort(sort: EpisodeSort): string {
  if (sort.kind === 'normal') return padNumber(sort.number);
  if (sort.kind === 'special') return sort.type + (sort.number == null ? '' : padNumber(sort.number));
  return sort.raw;
}

/** 用于比较/排序的标量。normal 0..，special 10000+，unknown 最大 */
export function episodeSortKey(sort: EpisodeSort): number {
  if (sort.kind === 'normal') return sort.number;
  if (sort.kind === 'special') {
    const typeIndex = Math.max(1, SPECIAL_TYPES.indexOf(sort.type));
    return 10000 + typeIndex * 1000 + (sort.number ?? -1);
  }
  return 1e9;
}

export function compareEpisodeSort(a: EpisodeSort, b: EpisodeSort): number {
  if (a.kind === 'normal' && b.kind === 'normal') return a.number - b.number;
  const ka = episodeSortKey(a);
  const kb = episodeSortKey(b);
  if (ka !== kb) return ka - kb;
  return a.raw.localeCompare(b.raw);
}

export function sameEpisodeSort(a: EpisodeSort, b: EpisodeSort): boolean {
  if (a.kind === 'normal' && b.kind === 'normal') return a.number === b.number;
  if (a.kind === 'special' && b.kind === 'special') {
    return a.type === b.type && a.number === b.number;
  }
  return a.raw === b.raw;
}

/**
 * 判断「站点给出的这一集」是否覆盖「请求的这一集」。
 * 对齐 ani `EpisodeRange.single(candidate).contains(expected)`：
 * 特殊集允许只按数字匹配（SP01 ↔ 01）。
 */
export function episodeSortContains(candidate: EpisodeSort, expected: EpisodeSort): boolean {
  if (sameEpisodeSort(candidate, expected)) return true;
  if (expected.kind === 'special' && expected.number != null) {
    return candidate.kind !== 'unknown' && candidate.number === expected.number;
  }
  return false;
}

/** 站点的这一条是否只是「整部作品」的标签（只有画质/语言，没有集号） */
const WHOLE_WORK_TOKENS =
  /HD|BD|TC|HC|4K|2K|2160P|1440P|1080P|720P|超清|高清|清晰|流畅|标准|抢先|正片|全片|原声|原版|国语|日语|粤语|普通话|中字|中文|双语|字幕|版/gi;
const WHOLE_WORK_SEPARATORS = /[ \t·・\-—_/|＋+（）()【】[\]]/g;

function isWholeWorkLabel(name: string): boolean {
  if (!name.trim()) return false;
  return name.replace(WHOLE_WORK_TOKENS, '').replace(WHOLE_WORK_SEPARATORS, '') === '';
}

/** 解析站点标题里的集号；pattern 为空表示整个标题就是集号文本 */
export function matchEpisodeSortFromName(name: string, pattern?: string): EpisodeSort {
  let re: RegExp | null = null;
  if (pattern && pattern.trim()) {
    re = compilePattern(pattern);
    if (!re) return convertSpecialEpisode(name, null);
  }
  if (!re) return convertSpecialEpisode(name, null);

  const m = re.exec(name);
  if (!m) return convertSpecialEpisode(name, null);
  const ep = readGroup(m, 'ep');
  return convertSpecialEpisode(name, ep && ep.trim() ? ep : name);
}

/** 电影类资源常被写成「正片」「HD高清」等，统一当作第 1 集 */
export function convertSpecialEpisode(name: string, raw?: string | null): EpisodeSort {
  const parsed = parseEpisodeSort(raw && raw.trim() ? raw : name);
  if (parsed.kind !== 'normal' && isPossiblyMovie(name)) return normalEpisode(1);
  return parsed;
}

function isPossiblyMovie(name: string): boolean {
  if (name === '正片' || name === '高清版') return true;
  return /2160P|1440P|2K|4K|1080P|720P/i.test(name);
}

/** 参与匹配的集号：解析不出时，若整条只有画质/语言标签，则视为第 1 集 */
export function matchingEpisodeSortOf(name: string, sort: EpisodeSort): EpisodeSort {
  if (sort.kind !== 'unknown') return sort;
  if (isWholeWorkLabel(name)) return normalEpisode(1);
  return sort;
}

function readGroup(m: RegExpExecArray, name: string): string | undefined {
  const groups = m.groups as Record<string, string | undefined> | undefined;
  return groups?.[name];
}

/** 把 Java 风格正则（内联 (?i)）转成 JS RegExp */
export function compilePattern(pattern?: string): RegExp | null {
  if (!pattern) return null;
  let src = pattern.trim();
  let flags = '';
  const inline = /^\(\?([ims]+)\)/.exec(src);
  if (inline) {
    flags = inline[1].replace(/[^ims]/g, '');
    src = src.slice(inline[0].length);
  }
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}
