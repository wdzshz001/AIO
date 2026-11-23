import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { BangumiEpisode, BangumiSubject, SourceCandidate } from '@agg/adapters';
import { episodeLabel } from '@agg/adapters';
import type { Chapter, SiteCtx } from '@agg/core';
import {
  createCtx,
  formatEpisodeSort,
  matchEpisodeSortFromName,
} from '@agg/core';
import { apps, findSourcesByTitle, getApp, getSite, sitesOfApp } from '@agg/adapters';
import { bridge } from './bridge';
import { useSites } from './sites';
import {
  cacheChapters,
  cachedChapters,
  loadShelf,
  patchShelf,
  shelfKey,
  upsertShelf,
  type ShelfEntry,
} from './store';
import Launcher from './pages/Launcher';
import AppPage from './pages/AppPage';
import BookPage from './pages/BookPage';
import Reader from './pages/Reader';
import SearchPage from './pages/SearchPage';
import SubjectPage from './pages/SubjectPage';
import SettingsPage from './pages/SettingsPage';
import NsfwSourcesPage from './pages/NsfwSourcesPage';
import SettingsSectionPage from './pages/SettingsSections';
import type { SettingsSection } from './settingsTypes';
import { loadSettings } from './store';

export type Route =
  | { name: 'home' }
  | { name: 'search'; query: string; category?: string }
  | { name: 'app'; appId: string }
  | { name: 'settings' }
  | { name: 'settings-nsfw' }
  | { name: 'settings-section'; section: SettingsSection }
  | { name: 'book'; siteId: string; url: string }
  | { name: 'subject'; subjectId: number; autoEpisodeSort?: string; autoPlay?: boolean }
  | {
      name: 'read';
      siteId: string;
      bookUrl: string;
      title: string;
      author?: string;
      cover?: string;
      chapters: Chapter[];
      index: number;
      /** 动画条目播放时记录，同一作品的不同源共用历史 */
      subjectId?: number;
      subjectTitle?: string;
      subjectCover?: string;
      subjectEpisodeSort?: string;
    };

function initialRoute(): Route {
  const settings = loadSettings();
  if (settings.startup.page === 'last') {
    try {
      const saved = JSON.parse(localStorage.getItem('agg.lastRoute.v1') || 'null') as Route | null;
      if (saved && ['home', 'app', 'book', 'subject', 'search'].includes(saved.name)) return saved;
    } catch {
      /* ignore */
    }
  }
  if (settings.startup.page === 'app') {
    const app = getApp(settings.startup.appId);
    if (app) return { name: 'app', appId: app.id };
  }
  return { name: 'home' };
}

const RESTORABLE_ROUTES = ['home', 'app', 'book', 'subject', 'search'];

function isRestorableRoute(value: unknown): value is Route {
  if (!value || typeof value !== 'object') return false;
  const name = (value as { name?: unknown }).name;
  return typeof name === 'string' && RESTORABLE_ROUTES.includes(name);
}

function initialStack(): Route[] {
  const settings = loadSettings();
  if (settings.startup.page === 'last') {
    try {
      const raw = JSON.parse(localStorage.getItem('agg.routeStack.v1') || 'null') as unknown;
      if (Array.isArray(raw) && raw.length && raw.every(isRestorableRoute)) {
        return raw;
      }
    } catch {
      /* ignore */
    }
  }
  return [initialRoute()];
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10.5 12 3l8 7.5" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5.5h4V20" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function chapterKey(title: string): string {
  return title
    .replace(/^第?\s*\d+\s*[章节话集回]?\s*/g, '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '')
    .toLowerCase();
}

const CN_DIGIT: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

function chapterNumber(title: string): number | null {
  const m = /^\s*(?:第\s*)?([零一二两三四五六七八九十百千\d]+)\s*[.、章节话集回]/.exec(title);
  if (!m) return null;
  const raw = m[1];
  if (/^\d+$/.test(raw)) return Number(raw);
  let total = 0;
  let current = 0;
  for (const ch of raw) {
    if (ch === '百') {
      total += (current || 1) * 100;
      current = 0;
    } else if (ch === '十') {
      total += (current || 1) * 10;
      current = 0;
    } else if (ch === '千') {
      total += (current || 1) * 1000;
      current = 0;
    } else if (ch in CN_DIGIT) {
      current = CN_DIGIT[ch];
    }
  }
  total += current;
  return total > 0 ? total : null;
}

function findTargetChapterIndex(list: Chapter[], title: string, fallback: number): number {
  // 先按章节号对齐，避免「第八十五章」误配到同名的第 299 章
  const targetNo = chapterNumber(title);
  if (targetNo != null) {
    const byNo = list.findIndex((c) => chapterNumber(c.title) === targetNo);
    if (byNo >= 0) return byNo;
  }
  const key = chapterKey(title);
  if (!key) return -1;
  let idx = list.findIndex((c) => chapterKey(c.title) === key);
  if (idx >= 0) return idx;
  idx = list.findIndex((c) => {
    const k = chapterKey(c.title);
    return k.length > 3 && (k.includes(key) || key.includes(k));
  });
  if (idx >= 0) return idx;
  return list.length ? Math.min(Math.max(0, fallback), list.length - 1) : -1;
}

export default function App() {
  const [stack, setStack] = useState<Route[]>(() => initialStack());
  const [shelf, setShelf] = useState<ShelfEntry[]>(() => loadShelf());
  const [toast, setToast] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const autoNoticeRef = useRef('');
  const { sites, allSites, settings, loading: sitesLoading, error: sitesError, reload: reloadSites } = useSites();

  const showToast = useCallback((text: string, ms = 4000) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), ms);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);
  const toastNode = toast ? (
    <div className="app-toast" role="status">
      {toast}
    </div>
  ) : null;

  useEffect(() => {
    if (!bridge.hotCheck) return;
    let alive = true;
    bridge
      .hotCheck()
      .then((info) => {
        if (alive && info?.available) {
          showToast(`发现新版本 ${info.version}，可在「设置 → 关于」中手动更新`, 6500);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [showToast]);

  const route = stack[stack.length - 1];
  const visibleShelf = shelf.filter(
    // 动画历史属于 Bangumi 条目，不随某个源禁用而消失
    (e) => !!e.subjectId || !e.siteId || sites.some((s) => s.id === e.siteId),
  );

  // 外观设置：主题 / 强调色 / 密度 / 动效
  useEffect(() => {
    const root = document.documentElement;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const theme =
        settings.appearance.theme === 'system'
          ? mq.matches
            ? 'dark'
            : 'light'
          : settings.appearance.theme;
      root.dataset.theme = theme;
      root.dataset.density = settings.appearance.density;
      root.dataset.motion = settings.appearance.reduceMotion ? 'off' : 'on';
      root.style.setProperty('--accent', settings.appearance.accent);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [settings.appearance]);

  // 系统级启动项与托盘
  useEffect(() => {
    bridge.setTray?.(settings.startup.tray).catch(() => undefined);
    bridge.setLoginItem?.(settings.startup.launchAtLogin).catch(() => undefined);
  }, [settings.startup.tray, settings.startup.launchAtLogin]);

  // 记录可恢复的页面
  useEffect(() => {
    if (['home', 'app', 'book', 'subject', 'search'].includes(route.name)) {
      localStorage.setItem('agg.lastRoute.v1', JSON.stringify(route));
    }
    // 保存整条返回栈；阅读器路由不落盘（内容/章节表太大，进度由书架负责）
    const persistable = stack.filter(isRestorableRoute);
    if (persistable.length) {
      localStorage.setItem('agg.routeStack.v1', JSON.stringify(persistable));
    }
  }, [route, stack]);

  const push = useCallback((r: Route) => setStack((s) => [...s, r]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const replace = useCallback((r: Route) => setStack((s) => [...s.slice(0, -1), r]), []);

  useEffect(() => {
    (window as unknown as { __aggDepth?: number }).__aggDepth = stack.length;
  }, [stack.length]);

  const ctxCache = useRef(new Map<string, SiteCtx>());
  const ctxFor = useCallback(
    (siteId: string): SiteCtx | null => {
      const site = getSite(siteId, sites);
      if (!site) return null;
      let ctx = ctxCache.current.get(siteId);
      if (!ctx) {
        ctx = createCtx(bridge, site);
        ctxCache.current.set(siteId, ctx);
      }
      return ctx;
    },
    [sites],
  );

  // 设置页要管理被隐藏/禁用的源，因此用全集建 ctx
  const ctxForAll = useCallback(
    (siteId: string): SiteCtx | null => {
      const site = getSite(siteId, allSites);
      if (!site) return null;
      let ctx = ctxCache.current.get(siteId);
      if (!ctx) {
        ctx = createCtx(bridge, site);
        ctxCache.current.set(siteId, ctx);
      }
      return ctx;
    },
    [allSites],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [route.name, back]);

  const openEntry = useCallback(
    (entry: ShelfEntry) => {
      if (entry.subjectId) {
        let sort = entry.chapter?.sort;
        // 旧版本书架可能没有 sort，从章节标题补一次，避免最近观看进动画不自动选源
        if (!sort && entry.chapter?.title) {
          const parsed = matchEpisodeSortFromName(
            entry.chapter.title,
            '第\\s*(?<ep>.+)\\s*[话集]',
          );
          if (parsed.kind !== 'unknown') sort = formatEpisodeSort(parsed);
        }
        push({
          name: 'subject',
          subjectId: entry.subjectId,
          autoEpisodeSort: sort,
          autoPlay: true,
        });
        return;
      }
      const cached = cachedChapters(entry.url);
      if (cached?.length && entry.chapter?.url) {
        const idx = cached.findIndex((c) => c.url === entry.chapter!.url);
        if (idx >= 0) {
          push({
            name: 'read',
            siteId: entry.siteId,
            bookUrl: entry.url,
            title: entry.title,
            author: entry.author,
            cover: entry.cover,
            chapters: cached,
            index: idx,
          });
          return;
        }
      }
      push({ name: 'book', siteId: entry.siteId, url: entry.url });
    },
    [push],
  );

  let readerNode: ReactNode = null;
  if (route.name === 'read') {
    const site = getSite(route.siteId, sites);
    const ctx = ctxFor(route.siteId);
    if (!site || !ctx) {
      readerNode = <div className="fatal">站点不存在</div>;
    } else {
    const entry = shelf.find((x) =>
      route.subjectId ? x.subjectId === route.subjectId : x.url === route.bookUrl,
    );
    const sortOf = (chapter: Chapter | undefined): string | undefined => {
      if (!chapter) return undefined;
      if (chapter.sort) return chapter.sort;
      if (site.kind !== 'anime') return undefined;
      const sort = matchEpisodeSortFromName(chapter.title, '第\\s*(?<ep>.+)\\s*[话集]');
      return sort.kind === 'unknown' ? undefined : formatEpisodeSort(sort);
    };

    // 同一集换了源也能续播：优先按集号对齐，其次按章节 URL
    const current = route.chapters[route.index];
    const currentSort = sortOf(current);
    const sameEpisode = route.subjectId
      ? !!entry?.chapter?.sort && entry.chapter.sort === currentSort
      : entry?.chapter?.url === current?.url;
    const resume = sameEpisode ? entry?.position : undefined;
    const resumePage = sameEpisode ? entry?.page : undefined;
    const resumeScroll = sameEpisode ? entry?.scroll : undefined;
    const resumePageCount = sameEpisode ? entry?.pageCount : undefined;
    const key = shelfKey({
      url: route.bookUrl,
      subjectId: route.subjectId,
    });

    const saveProgress = (index: number) => {
      const chapter = route.chapters[index];
      if (!chapter) return;
      setShelf(
        upsertShelf({
          siteId: route.siteId,
          url: route.bookUrl,
          title: route.subjectTitle ?? route.title,
          author: route.author,
          cover: route.subjectCover ?? route.cover,
          kind: site.kind,
          subjectId: route.subjectId,
          chapter: { title: chapter.title, url: chapter.url, sort: sortOf(chapter) },
          position: index === route.index ? resume : undefined,
          page: index === route.index ? resumePage : undefined,
          pageCount: index === route.index ? resumePageCount : undefined,
          scroll: index === route.index ? resumeScroll : undefined,
          at: Date.now(),
        }),
      );
    };

    /** 起点 VIP/APP 章节：自动在其他小说源里找同名书并跳到同名章节 */
    const autoSwitchQidian = async (currentTitle: string): Promise<boolean> => {
      if (site.id !== 'qidian') return false;
      showToast('起点本章需要订阅，正在寻找可用书源…');
      const options = sites.filter((s) => s.kind === 'novel' && s.id !== 'qidian' && !!s.search);
      if (!options.length) {
        showToast('没有其他可用书源');
        return false;
      }
      let found: { siteId: string; url: string; title: string }[] = [];
      try {
        found = await findSourcesByTitle(ctxFor, options, route.title, 'novel');
      } catch {
        found = [];
      }
      const preferredSite = settings.preferredSource?.novel;
      found.sort((a, b) => {
        const pa = a.siteId === preferredSite ? 0 : 1;
        const pb = b.siteId === preferredSite ? 0 : 1;
        return pa - pb;
      });
      for (const f of found) {
        const targetSite = getSite(f.siteId, sites);
        const targetCtx = ctxFor(f.siteId);
        if (!targetSite || !targetCtx) continue;
        try {
          const detail = await targetSite.detail(targetCtx, f.url);
          let list = detail.chapters;
          if (!list.length && targetSite.chapters) {
            list = await targetSite.chapters(targetCtx, f.url);
          }
          const idx = findTargetChapterIndex(list, currentTitle, route.index);
          if (idx < 0 || list[idx]?.locked) continue;
          cacheChapters(f.url, list);
          setShelf((prev) =>
            prev.filter((e) => !(e.siteId === 'qidian' && e.url === route.bookUrl)),
          );
          autoNoticeRef.current = `已自动切换到 ${targetSite.name} · ${list[idx]?.title ?? currentTitle}`;
          replace({
            name: 'read',
            siteId: targetSite.id,
            bookUrl: f.url,
            title: detail.title || route.title,
            author: detail.author ?? route.author,
            cover: detail.cover ?? route.cover,
            chapters: list,
            index: idx,
          });
          return true;
        } catch {
          // 换下一个源
        }
      }
      showToast('没有找到可用的免费书源，可在详情页手动换源');
      return false;
    };

    readerNode = (
      <>
        <Reader
          site={site}
          ctx={ctx}
          bookUrl={route.bookUrl}
          title={route.subjectTitle ?? route.title}
          author={route.author}
          cover={route.subjectCover ?? route.cover}
          chapters={route.chapters}
          index={route.index}
          initialPosition={resume}
          initialPage={resumePage}
          initialScroll={resumeScroll}
          onBack={back}
          onNavigate={(index) => replace({ ...route, index })}
          onProgress={saveProgress}
          onAutoSwitch={autoSwitchQidian}
          onContentReady={() => {
            const notice = autoNoticeRef.current;
            if (notice) {
              autoNoticeRef.current = '';
              showToast(notice, 6000);
            }
          }}
        onPageProgress={(index, page, pageCount) => {
          const chapter = route.chapters[index];
          if (!chapter) return;
          setShelf(
            patchShelf(key, {
              chapter: { title: chapter.title, url: chapter.url, sort: sortOf(chapter) },
              page,
              pageCount,
              at: Date.now(),
            }),
          );
        }}
        onScrollProgress={(index, scroll) => {
          const chapter = route.chapters[index];
          if (!chapter) return;
          setShelf(
            patchShelf(key, {
              chapter: { title: chapter.title, url: chapter.url, sort: sortOf(chapter) },
              scroll,
              at: Date.now(),
            }),
          );
        }}
        onVideoProgress={(index, position, duration) => {
          const chapter = route.chapters[index];
          if (!chapter) return;
          setShelf(
            patchShelf(key, {
              chapter: { title: chapter.title, url: chapter.url, sort: sortOf(chapter) },
              position,
              duration,
              at: Date.now(),
            }),
          );
        }}
        onSwitchSource={
          route.subjectId
            ? () =>
                replace({
                  name: 'subject',
                  subjectId: route.subjectId!,
                  autoEpisodeSort: route.subjectEpisodeSort,
                })
            : undefined
        }
        />
      </>
    );
    }
  }

  // 阅读器是覆盖层：底层页面保持挂载，返回时数据和滚动位置都不会丢
  const pageRoute: Route =
    route.name === 'read'
      ? (stack[stack.length - 2] ?? ({ name: 'home' } as Route))
      : route;

  const activeAppId = 'appId' in pageRoute ? pageRoute.appId : undefined;

  return (
    <div className={'app' + (route.name === 'read' ? ' app-reading' : '')}>
      <aside className="rail">
        <button
          className="rail-logo"
          onClick={() => setStack([{ name: 'home' }])}
          title="首页"
          aria-label="首页"
        >
          <HomeIcon />
        </button>
        <div className="rail-apps">
          <button
            className={'rail-app' + (pageRoute.name === 'search' ? ' rail-search-active' : '')}
            title="聚合搜索"
            onClick={() => push({ name: 'search', query: '', category: settings.searchCategory })}
          >
            搜
          </button>
          <span className="rail-divider" />
          {apps.map((a) => (
            <button
              key={a.id}
              className="rail-app"
              style={activeAppId === a.id ? { background: a.color, borderColor: 'transparent', color: '#fff' } : undefined}
              title={a.name}
              onClick={() => push({ name: 'app', appId: a.id })}
            >
              {a.icon}
            </button>
          ))}
        </div>
        <button
          className={
            'rail-settings' +
            (pageRoute.name === 'settings' ||
            pageRoute.name === 'settings-nsfw' ||
            pageRoute.name === 'settings-section'
              ? ' active'
              : '')
          }
          title="设置"
          aria-label="设置"
          onClick={() => push({ name: 'settings' })}
        >
          <GearIcon />
        </button>
      </aside>

      <main className="main">
        {pageRoute.name === 'home' && (
          <Launcher
            apps={apps}
            shelf={visibleShelf}
            blurCovers={settings.privacy.blurCovers}
            onOpenApp={(appId) => push({ name: 'app', appId })}
            onOpenEntry={openEntry}
            onSearch={(query) => push({ name: 'search', query, category: settings.searchCategory })}
          />
        )}

        {pageRoute.name === 'search' && (
          <SearchPage
            initialQuery={pageRoute.query}
            initialCategory={pageRoute.category}
            ctxFor={ctxFor}
            onOpenBook={(siteId, url) => push({ name: 'book', siteId, url })}
            onOpenSubject={(subjectId) => push({ name: 'subject', subjectId })}
            onBack={back}
          />
        )}

        {pageRoute.name === 'settings' && (
          <SettingsPage
            onBack={back}
            onOpenNsfw={() => push({ name: 'settings-nsfw' })}
            onOpenSection={(section) => push({ name: 'settings-section', section })}
          />
        )}

        {pageRoute.name === 'settings-nsfw' && <NsfwSourcesPage onBack={back} />}

        {pageRoute.name === 'settings-section' && (
          <SettingsSectionPage section={pageRoute.section} onBack={back} ctxFor={ctxForAll} />
        )}

        {pageRoute.name === 'app' &&
          (() => {
            const app = getApp(pageRoute.appId);
            if (!app) return <div className="fatal">应用不存在</div>;
            return (
              <AppPage
                app={app}
                sites={sitesOfApp(app, sites)}
                loadingSources={sitesLoading}
                sourcesError={sitesError}
                onReloadSources={reloadSites}
                ctxFor={ctxFor}
                onOpenBook={(siteId, url) => push({ name: 'book', siteId, url })}
                onOpenSubject={(subjectId) => push({ name: 'subject', subjectId })}
                onSearch={(query, category) => push({ name: 'search', query, category })}
                onBack={back}
              />
            );
          })()}

        {pageRoute.name === 'subject' && (
          <SubjectPage
            subjectId={pageRoute.subjectId}
            sites={sites}
            ctxFor={ctxFor}
            shelf={shelf}
            autoEpisodeSort={pageRoute.autoEpisodeSort}
            autoPlay={pageRoute.autoPlay}
            defaultPreferredSource={settings.preferredSource?.anime}
            onBack={back}
            onPlay={(candidate: SourceCandidate, episode: BangumiEpisode, subject: BangumiSubject) => {
              push({
                name: 'read',
                siteId: candidate.siteId,
                bookUrl: candidate.url,
                title: subject.nameCn || subject.name,
                author: subject.date,
                cover: subject.cover,
                chapters: candidate.chapters,
                index: candidate.index,
                subjectId: subject.id,
                subjectTitle: subject.nameCn || subject.name,
                subjectCover: subject.cover,
                subjectEpisodeSort: episodeLabel(episode),
              });
            }}
          />
        )}

        {pageRoute.name === 'book' &&
          (() => {
            const site = getSite(pageRoute.siteId, sites);
            const ctx = ctxFor(pageRoute.siteId);
            if (!site || !ctx) return <div className="fatal">站点不存在</div>;
            return (
              <BookPage
                site={site}
                ctx={ctx}
                url={pageRoute.url}
                sites={sites}
                ctxFor={ctxFor}
                onBack={back}
                onSwitchSource={(siteId, url) => replace({ name: 'book', siteId, url })}
                onRead={(detail, chapters, index) =>
                  push({
                    name: 'read',
                    siteId: site.id,
                    bookUrl: pageRoute.url,
                    title: detail.title,
                    author: detail.author,
                    cover: detail.cover,
                    chapters,
                    index,
                  })
                }
              />
            );
          })()}
      </main>
      {readerNode}
      {toastNode}
    </div>
  );
}
