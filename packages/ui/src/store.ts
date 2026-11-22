import type { Chapter, Site, SiteKind } from '@agg/core';

export interface ShelfEntry {
  siteId: string;
  url: string;
  title: string;
  author?: string;
  cover?: string;
  kind?: SiteKind;
  /** 来自 Bangumi 条目时记录，同一个条目的不同源共用一条历史 */
  subjectId?: number;
  chapter?: { title: string; url: string; sort?: string };
  /** 视频播放位置（秒） */
  position?: number;
  /** 视频总时长（秒） */
  duration?: number;
  /** 漫画当前页（1-based） */
  page?: number;
  /** 漫画总页数 */
  pageCount?: number;
  /** 小说滚动比例（0..1） */
  scroll?: number;
  at: number;
}

export interface ReaderPrefs {
  size: number;
  lineHeight: number;
  paragraphGap: number;
  pageWidth: number;
  theme: 'paper' | 'night' | 'green';
  /** 播完自动下一集（与 animeko 的 autoPlayNext 对齐，默认关） */
  autoNext: boolean;
  comicFit: 'width' | 'contain';
}

export interface AppearanceSettings {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  density: 'compact' | 'cozy';
  reduceMotion: boolean;
}

export interface StartupSettings {
  page: 'home' | 'last' | 'app';
  appId: string;
  launchAtLogin: boolean;
  tray: boolean;
}

export interface NetworkSettings {
  concurrency: number;
  timeoutMs: number;
  htmlTtlMin: number;
  imagePreload: boolean;
}

export interface PrivacySettings {
  incognito: boolean;
  blurCovers: boolean;
}

export interface PlaybackSettings {
  rate: number;
  muted: boolean;
  quality: 'auto' | '1080' | '720';
}

const SHELF_KEY = 'agg.shelf.v1';
const PREFS_KEY = 'agg.reader.v1';
const SETTINGS_KEY = 'agg.settings.v1';
const CHAPTERS_KEY = (bookUrl: string) => `agg.chapters.v2:${bookUrl}`;
const CHAPTERS_TTL = 12 * 60 * 60 * 1000;

/** 应用设置：flightMode 即 UI 上的「飞行模式」，关闭时隐藏被标记的源 */
export interface AppSettings {
  /** 设置 schema 版本；3 起默认关闭飞行模式 */
  settingsVersion: number;
  flightMode: boolean;
  sourceNsfw: Record<string, boolean>;
  /** 逐源启用；缺省为启用 */
  sourceEnabled: Record<string, boolean>;
  /** 逐源排序权重，越小越靠前 */
  sourceRank: Record<string, number>;
  /** 每个分类的首选源 */
  preferredSource: Partial<Record<SiteKind, string>>;
  searchCategory: 'all' | 'novel' | 'anime' | 'comic';
  appearance: AppearanceSettings;
  startup: StartupSettings;
  network: NetworkSettings;
  privacy: PrivacySettings;
  playback: PlaybackSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  settingsVersion: 4,
  flightMode: false,
  sourceNsfw: {},
  sourceEnabled: {},
  sourceRank: {},
  preferredSource: {
    comic: 'mangacopy',
    anime: 'sub:yinghua-dongman',
  },
  searchCategory: 'all',
  appearance: {
    theme: 'dark',
    accent: '#4f8cff',
    density: 'compact',
    reduceMotion: false,
  },
  startup: { page: 'home', appId: 'novel', launchAtLogin: false, tray: false },
  network: { concurrency: 6, timeoutMs: 30_000, htmlTtlMin: 5, imagePreload: true },
  privacy: { incognito: false, blurCovers: false },
  playback: { rate: 1, muted: false, quality: 'auto' },
};

function boolMap(value: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}

function numberMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
  }
  return out;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function loadSettings(): AppSettings {
  const raw = read<Partial<AppSettings>>(SETTINGS_KEY, {});
  const d = DEFAULT_SETTINGS;
  const rawVersion = Number(raw.settingsVersion) || 0;
  const appearance = { ...d.appearance, ...(raw.appearance ?? {}) };
  const startup = { ...d.startup, ...(raw.startup ?? {}) };
  const network = { ...d.network, ...(raw.network ?? {}) };
  const privacy = { ...d.privacy, ...(raw.privacy ?? {}) };
  const playback = { ...d.playback, ...(raw.playback ?? {}) };
  // v4：首次加入默认首选源（漫画=拷贝，动画=樱花动漫）。
  // 升级时只补缺失项；升级完成后用户仍可手动清空。
  const preferredSource =
    rawVersion < 4
      ? { ...d.preferredSource, ...(raw.preferredSource ?? {}) }
      : (raw.preferredSource ?? {});

  return {
    ...d,
    // v1 的 flightMode=true 表示“隐藏标记源”，v2 改成“显示全部”；
    // v3 起默认关闭，升级时重置一次，之后按用户选择持久化
    flightMode:
      raw.settingsVersion != null && raw.settingsVersion < 3
        ? false
        : raw.settingsVersion == null && typeof raw.flightMode === 'boolean'
          ? !raw.flightMode
          : raw.flightMode === true,
    settingsVersion: 4,
    sourceNsfw: boolMap(raw.sourceNsfw),
    sourceEnabled: boolMap(raw.sourceEnabled),
    sourceRank: numberMap(raw.sourceRank),
    preferredSource,
    searchCategory: (['all', 'novel', 'anime', 'comic'] as const).includes(
      raw.searchCategory as 'all',
    )
      ? (raw.searchCategory as AppSettings['searchCategory'])
      : 'all',
    appearance: {
      theme: appearance.theme === 'light' || appearance.theme === 'system' ? appearance.theme : 'dark',
      accent: typeof appearance.accent === 'string' ? appearance.accent : d.appearance.accent,
      density: appearance.density === 'cozy' ? 'cozy' : 'compact',
      reduceMotion: appearance.reduceMotion === true,
    },
    startup: {
      page: startup.page === 'last' || startup.page === 'app' ? startup.page : 'home',
      appId: typeof startup.appId === 'string' ? startup.appId : 'novel',
      launchAtLogin: startup.launchAtLogin === true,
      tray: startup.tray === true,
    },
    network: {
      concurrency: clamp(Number(network.concurrency), 1, 12, d.network.concurrency),
      timeoutMs: clamp(Number(network.timeoutMs), 5_000, 90_000, d.network.timeoutMs),
      htmlTtlMin: clamp(Number(network.htmlTtlMin), 0, 120, d.network.htmlTtlMin),
      imagePreload: network.imagePreload !== false,
    },
    privacy: {
      incognito: privacy.incognito === true,
      blurCovers: privacy.blurCovers === true,
    },
    playback: {
      rate: [1, 1.25, 1.5, 2].includes(Number(playback.rate)) ? Number(playback.rate) : 1,
      muted: playback.muted === true,
      quality:
        playback.quality === '1080' || playback.quality === '720'
          ? playback.quality
          : 'auto',
    },
  };
}

export function saveSettings(settings: AppSettings): void {
  write(SETTINGS_KEY, { ...settings, settingsVersion: 4 });
}

/** 源是否随飞行模式隐藏：用户逐源设置优先于源默认值 */
export function effectiveNsfw(site: Site, settings: AppSettings): boolean {
  return settings.sourceNsfw?.[site.id] ?? site.nsfw ?? false;
}

export function sourceEnabled(site: Site, settings: AppSettings): boolean {
  return settings.sourceEnabled?.[site.id] !== false;
}

/** 飞行模式开启显示全部（仅排除被手动禁用的源）；关闭时再隐藏 NSFW 源 */
export function filterSites(sites: Site[], settings: AppSettings): Site[] {
  const enabled = sites.filter((site) => sourceEnabled(site, settings));
  const list = settings.flightMode
    ? enabled
    : enabled.filter((site) => !effectiveNsfw(site, settings));

  const rankMap = settings.sourceRank ?? {};
  const rank = (s: Site) => rankMap[s.id] ?? 1_000_000;
  const preferred = settings.preferredSource ?? {};
  return list.slice().sort((a, b) => {
    if (a.kind !== b.kind) return 0;
    const pa = preferred[a.kind] === a.id ? 0 : 1;
    const pb = preferred[b.kind] === b.id ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return rank(a) - rank(b);
  });
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 配额满了就算了 */
  }
}

export function shelfKey(entry: Pick<ShelfEntry, 'url' | 'subjectId'>): string {
  return entry.subjectId ? `bgm:${entry.subjectId}` : entry.url;
}

export function loadShelf(): ShelfEntry[] {
  const list = read<ShelfEntry[]>(SHELF_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function upsertShelf(entry: ShelfEntry): ShelfEntry[] {
  const key = shelfKey(entry);
  const list = loadShelf().filter((x) => shelfKey(x) !== key);
  const next = [entry, ...list].slice(0, 200);
  return persistShelf(next);
}

function persistShelf(next: ShelfEntry[]): ShelfEntry[] {
  // 无痕模式：内存里保留当前会话，但不落盘
  if (!loadSettings().privacy.incognito) write(SHELF_KEY, next);
  return next;
}

export function patchShelf(
  key: string,
  patch: Partial<ShelfEntry>,
): ShelfEntry[] {
  const list = loadShelf();
  const idx = list.findIndex((x) => shelfKey(x) === key);
  if (idx < 0) return list;
  const next = list.slice();
  next[idx] = { ...next[idx], ...patch };
  return persistShelf(next);
}

export function removeShelf(key: string): ShelfEntry[] {
  const next = loadShelf().filter((x) => shelfKey(x) !== key);
  write(SHELF_KEY, next);
  return next;
}

export function clearShelf(): ShelfEntry[] {
  write(SHELF_KEY, []);
  return [];
}

export function shelfEntryFor(
  entries: ShelfEntry[],
  opts: { url?: string; subjectId?: number },
): ShelfEntry | undefined {
  if (opts.subjectId) {
    const bySubject = entries.find((e) => e.subjectId === opts.subjectId);
    if (bySubject) return bySubject;
  }
  if (opts.url) return entries.find((e) => e.url === opts.url);
  return undefined;
}

export function loadPrefs(): ReaderPrefs {
  const d: ReaderPrefs = {
    size: 19,
    lineHeight: 1.9,
    paragraphGap: 18,
    pageWidth: 760,
    theme: 'paper',
    autoNext: false,
    comicFit: 'width',
  };
  const p = read<Partial<ReaderPrefs>>(PREFS_KEY, {});
  return {
    size: clamp(Number(p.size), 14, 28, d.size),
    lineHeight: clamp(Number(p.lineHeight), 1.4, 2.6, d.lineHeight),
    paragraphGap: clamp(Number(p.paragraphGap), 8, 36, d.paragraphGap),
    pageWidth: clamp(Number(p.pageWidth), 560, 1000, d.pageWidth),
    theme: p.theme === 'night' || p.theme === 'green' ? p.theme : 'paper',
    autoNext: p.autoNext === true,
    comicFit: p.comicFit === 'contain' ? 'contain' : 'width',
  };
}

export function savePrefs(p: ReaderPrefs): void {
  write(PREFS_KEY, p);
}

export interface StorageItem {
  key: string;
  bytes: number;
}

/** localStorage 中 agg.* 的占用（UTF-16 近似） */
export function storageUsage(): StorageItem[] {
  const out: StorageItem[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith('agg.')) continue;
      const value = localStorage.getItem(key) ?? '';
      out.push({ key, bytes: (key.length + value.length) * 2 });
    }
  } catch {
    /* ignore */
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

export function clearChapterCaches(): number {
  let n = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('agg.chapters.')) keys.push(key);
    }
    for (const key of keys) {
      localStorage.removeItem(key);
      n++;
    }
  } catch {
    /* ignore */
  }
  return n;
}

export function exportBackup(): string {
  return JSON.stringify(
    {
      app: 'agg',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings: loadSettings(),
      reader: loadPrefs(),
      shelf: loadShelf(),
    },
    null,
    2,
  );
}

export function importBackup(text: string): boolean {
  try {
    const data = JSON.parse(text) as {
      settings?: AppSettings;
      reader?: ReaderPrefs;
      shelf?: ShelfEntry[];
    };
    if (data.settings) saveSettings({ ...DEFAULT_SETTINGS, ...data.settings });
    if (data.reader) savePrefs({ ...loadPrefs(), ...data.reader });
    if (Array.isArray(data.shelf)) write(SHELF_KEY, data.shelf.slice(0, 200));
    return true;
  } catch {
    return false;
  }
}

export function cachedChapters(bookUrl: string): Chapter[] | null {
  const v = read<{ at: number; chapters: Chapter[] } | null>(CHAPTERS_KEY(bookUrl), null);
  if (!v || !Array.isArray(v.chapters) || !v.chapters.length) return null;
  if (Date.now() - v.at > CHAPTERS_TTL) return null;
  return v.chapters;
}

export function cacheChapters(bookUrl: string, chapters: Chapter[]): void {
  write(CHAPTERS_KEY(bookUrl), { at: Date.now(), chapters });
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (sameDay) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return '';
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
