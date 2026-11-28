import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Chapter, ChapterContent, Site, SiteCtx } from '@agg/core';
import { formatDuration, loadPrefs, savePrefs, type ReaderPrefs } from '../store';
import { toSimplified } from '../chinese';
import {
  getContentCache,
  contentCacheKey,
  putContentCache,
  putMediaCache,
  readContentCache,
  readMediaCache,
  removeContentCache,
} from '../contentCache';
import { preloadImageWindow } from '../preload';
import { useSites } from '../sites';
import { bridge } from '../bridge';
import VideoPlayer from '../components/VideoPlayer';

interface Props {
  site: Site;
  ctx: SiteCtx;
  bookUrl: string;
  title: string;
  author?: string;
  cover?: string;
  chapters: Chapter[];
  index: number;
  /** 视频续播位置（秒） */
  initialPosition?: number;
  /** 漫画续读页（1-based） */
  initialPage?: number;
  /** 小说续读滚动比例（0..1） */
  initialScroll?: number;
  onBack: () => void;
  onNavigate: (index: number) => void;
  onProgress: (index: number) => void;
  onVideoProgress?: (index: number, position: number, duration: number) => void;
  onPageProgress?: (index: number, page: number, pageCount: number) => void;
  onScrollProgress?: (index: number, ratio: number) => void;
  /** 起点 VIP/APP 章节：交给上层寻找其他书源并替换当前阅读路由 */
  onAutoSwitch?: (chapterTitle: string) => Promise<boolean>;
  /** 正文首次渲染完成（用于换源后的提示） */
  onContentReady?: () => void;
  /** 动画：返回条目页换源 */
  onSwitchSource?: () => void;
}

const THEMES: { id: ReaderPrefs['theme']; name: string }[] = [
  { id: 'paper', name: '纸质' },
  { id: 'green', name: '护眼' },
  { id: 'night', name: '夜间' },
];

/** 站点标题常带「(1 / 1)」这种分页后缀 */
function prettyTitle(t: string): string {
  return t.replace(/\s*[（(]\d+\s*\/\s*\d+[）)]\s*$/, '').trim();
}

const TRANSPARENT_IMG =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />
    </svg>
  );
}

function SwitchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 7h13M14 4l3 3-3 3M20 17H7M10 14l-3 3 3 3" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    </svg>
  );
}

/** 漫画页按可视区域分批加载，避免进入一话时把全部图片请求出来 */
function ComicImage({ src, index }: { src: string; index: number }) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const root = el.closest('.reader-scroll');
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { root, rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  return (
    <img
      ref={ref}
      src={visible ? src : TRANSPARENT_IMG}
      data-src={src}
      alt={`第 ${index + 1} 页`}
      decoding="async"
      draggable={false}
      style={loaded ? undefined : { minHeight: '68vh' }}
      onLoad={() => {
        if (visible) setLoaded(true);
      }}
    />
  );
}

export default function Reader({
  site,
  ctx,
  bookUrl,
  title,
  cover,
  chapters,
  index,
  initialPosition,
  initialPage,
  initialScroll,
  onBack,
  onNavigate,
  onProgress,
  onVideoProgress,
  onPageProgress,
  onScrollProgress,
  onAutoSwitch,
  onContentReady,
  onSwitchSource,
}: Props) {
  const { settings } = useSites();
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());
  const [fullscreen, setFullscreen] = useState(site.kind === 'comic');
  const [videoUiVisible, setVideoUiVisible] = useState(false);
  const videoUiTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [playError, setPlayError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstIndexRef = useRef(index);
  const lastSavedRef = useRef(0);
  const lastPageSavedRef = useRef(0);
  const lastScrollSavedRef = useRef(0);
  const pageRef = useRef(1);
  const scrollRatioRef = useRef(0);
  const userScrolledRef = useRef(false);
  const restoringScrollRef = useRef(false);
  const [page, setPage] = useState(1);

  const chapter = chapters[index];
  const startAt = index === firstIndexRef.current ? initialPosition : undefined;
  const tr = (value: string | undefined | null) =>
    prefs.t2s ? toSimplified(value ?? '') : (value ?? '');

  // 漫画/全屏阅读时隐藏系统栏（Android 由原生桥实现，桌面端忽略）
  useEffect(() => {
    void bridge.setImmersive?.(fullscreen);
    return () => {
      if (fullscreen) void bridge.setImmersive?.(false);
    };
  }, [fullscreen]);

  const isAndroid =
    (globalThis as { agg?: { platform?: string } }).agg?.platform === 'android';

  const showVideoUi = (ms = 3200) => {
    setVideoUiVisible(true);
    clearTimeout(videoUiTimer.current);
    videoUiTimer.current = setTimeout(() => setVideoUiVisible(false), ms);
  };

  const enterVideoFullscreenRef = useRef<() => void>(() => undefined);

  // 离开阅读器时恢复竖屏/系统方向
  useEffect(() => {
    return () => {
      clearTimeout(videoUiTimer.current);
      void bridge.setVideoFullscreen?.(false);
      void bridge.setImmersive?.(false);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setPlayError('');
    setCountdown(null);
    setContent(null);
    let announced = false;
    const announce = () => {
      if (announced) return;
      announced = true;
      onProgress(index);
      onContentReady?.();
    };
    const applyContent = (c: ChapterContent) => {
      setContent(c);
      setLoading(false);
      announce();
      if (c.images?.length) {
        const p = Math.min(Math.max(1, initialPage ?? 1), c.images.length);
        pageRef.current = p;
        setPage(p);
        onPageProgress?.(index, p, c.images.length);
      } else {
        pageRef.current = 1;
        setPage(1);
      }
    };
    const autoSwitchTried = new Set<string>();
    (async () => {
      try {
        if (!chapter) throw new Error('章节不存在');
        const cacheKey = contentCacheKey(site.id, chapter.url);
        const canAutoSwitch = !!onAutoSwitch && !autoSwitchTried.has(chapter.url);
        if (canAutoSwitch && chapter.locked) {
          autoSwitchTried.add(chapter.url);
          setLoading(true);
          const switched = await onAutoSwitch!(chapter.title);
          if (!alive) return;
          if (switched) return;
        }

        // 先读本地持久化缓存：重复打开/重启后也能秒开
        let cached = readContentCache(cacheKey) ?? readMediaCache(cacheKey);
        if (!cached) cached = await getContentCache(cacheKey);
        if (cached && alive) {
          applyContent(cached);
          if (cached.images?.length && settings.network.imagePreload) {
            preloadImageWindow(cached.images, pageRef.current, 3, 1);
          }
          return;
        }

        const c = await ctx.site.chapter(ctx, chapter.url, (partial) => {
          if (!alive) return;
          setContent(partial);
          setLoading(false);
          announce();
        });
        if (!alive) return;
        applyContent(c);
        if (c.video) putMediaCache(cacheKey, c);
        else if (!c.streaming) void putContentCache(cacheKey, c);

        // 预取：小说下一章正文、动画下一集页面；漫画预热当前页附近图片
        if (!c.video && !c.images?.length) {
          const next = chapters[index + 1];
          if (next) {
            setTimeout(() => {
              const nextKey = contentCacheKey(site.id, next.url);
              ctx.site
                .chapter(ctx, next.url)
                .then((nextContent) => {
                  if (nextContent && !nextContent.streaming) {
                    if (nextContent.video) putMediaCache(nextKey, nextContent);
                    else void putContentCache(nextKey, nextContent);
                  }
                })
                .catch(() => undefined);
            }, 800);
          }
        } else if (c.video && !isAndroid) {
          const next = chapters[index + 1];
          if (next) {
            setTimeout(() => {
              const nextKey = contentCacheKey(site.id, next.url);
              ctx.site
                .chapter(ctx, next.url)
                .then((nextContent) => {
                  if (nextContent?.video) putMediaCache(nextKey, nextContent);
                })
                .catch(() => undefined);
            }, 1500);
          }
        } else if (c.images?.length && settings.network.imagePreload) {
          preloadImageWindow(c.images, pageRef.current, 3, 1);
        }
      } catch (e) {
        if (!alive) return;
        const message = e instanceof Error ? e.message : String(e);
        const paidOrApp = /登录|订阅|付费|购买|起点App|起点APP|客户端/i.test(message);
        if (onAutoSwitch && paidOrApp && !autoSwitchTried.has(chapter?.url ?? '')) {
          autoSwitchTried.add(chapter?.url ?? '');
          setLoading(true);
          const switched = await onAutoSwitch(chapter?.title ?? '');
          if (!alive) return;
          if (switched) return;
        }
        setError(message);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, chapter?.url, index, reloadNonce]);

  // 漫画滚动到新页时，继续向前预取几页
  useEffect(() => {
    if (!settings.network.imagePreload || !content?.images?.length) return;
    preloadImageWindow(content.images, page, 3, 1);
  }, [page, content?.images, settings.network.imagePreload]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [chapter?.url]);

  // 漫画续读：图片布局完成后跳到保存页
  useEffect(() => {
    if (!content?.images?.length) return;
    const target = Math.min(Math.max(1, initialPage ?? 1), content.images.length);
    if (target <= 1) return;
    const jump = () => {
      const img = scrollRef.current?.querySelectorAll<HTMLImageElement>('.comic-pages img')[target - 1];
      img?.scrollIntoView({ block: 'start' });
      setPage(target);
      pageRef.current = target;
    };
    const t1 = setTimeout(jump, 350);
    const t2 = setTimeout(jump, 1400);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [content?.images]);

  useEffect(() => {
    userScrolledRef.current = false;
  }, [chapter?.url]);

  // 小说续读：恢复滚动比例。
  // 流式章节先按当前页高度恢复一次，后续内容合并时再对齐；用户一旦自己滚动就不再抢位置。
  useEffect(() => {
    if (!content || content.video || content.images?.length) return;
    if (initialScroll == null || initialScroll <= 0) return;
    if (userScrolledRef.current) return;
    const t = setTimeout(() => {
      const el = scrollRef.current;
      if (!el) return;
      restoringScrollRef.current = true;
      el.scrollTop = initialScroll * Math.max(0, el.scrollHeight - el.clientHeight);
      scrollRatioRef.current = initialScroll;
      setTimeout(() => {
        restoringScrollRef.current = false;
      }, 120);
    }, content.streaming ? 40 : 80);
    return () => clearTimeout(t);
  }, [content, initialScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (restoringScrollRef.current) return;
    if (!content?.images?.length && !content?.video) userScrolledRef.current = true;

    if (content?.images?.length) {
      const now = Date.now();
      if (now - lastPageSavedRef.current < 500) return;
      const imgs = [...el.querySelectorAll<HTMLImageElement>('.comic-pages img')];
      if (!imgs.length) return;
      const rootTop = el.getBoundingClientRect().top;
      const threshold = rootTop + Math.min(180, el.clientHeight * 0.25);
      let next = 1;
      for (let i = 0; i < imgs.length; i++) {
        if (imgs[i].getBoundingClientRect().top <= threshold) next = i + 1;
        else break;
      }
      if (next !== pageRef.current) {
        pageRef.current = next;
        setPage(next);
        lastPageSavedRef.current = now;
        onPageProgress?.(index, next, imgs.length);
      }
      return;
    }

    if (content && !content.video) {
      const now = Date.now();
      if (now - lastScrollSavedRef.current < 1200) return;
      const max = el.scrollHeight - el.clientHeight;
      const ratio = max > 0 ? el.scrollTop / max : 0;
      if (Math.abs(ratio - scrollRatioRef.current) < 0.01) return;
      scrollRatioRef.current = ratio;
      lastScrollSavedRef.current = now;
      onScrollProgress?.(index, ratio);
    }
  };

  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) {
      setCountdown(null);
      if (index < chapters.length - 1) onNavigate(index + 1);
      return;
    }
    const timer = setTimeout(() => setCountdown((n) => (n == null ? null : n - 1)), 1000);
    return () => clearTimeout(timer);
  }, [countdown, index, chapters.length, onNavigate]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowLeft' && index > 0) onNavigate(index - 1);
      else if (e.key === 'ArrowRight' && index < chapters.length - 1) onNavigate(index + 1);
      else if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, chapters.length, onNavigate, onBack]);

  const updatePrefs = (patch: Partial<ReaderPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  const percent = chapters.length > 1 ? Math.round(((index + 1) / chapters.length) * 100) : 0;

  const handleTime = (pos: number, duration: number) => {
    const now = Date.now();
    if (now - lastSavedRef.current > 4000) {
      lastSavedRef.current = now;
      onVideoProgress?.(index, pos, duration);
    }
  };

  const handleEnded = () => {
    if (prefs.autoNext && index < chapters.length - 1) setCountdown(5);
  };
  const enterVideoFullscreen = () => {
    setFullscreen(true);
    if (isAndroid) void bridge.setVideoFullscreen?.(true);
    // 进入全屏先露出控制层几秒，避免用户找不到上下集/退出
    showVideoUi(4000);
  };
  enterVideoFullscreenRef.current = enterVideoFullscreen;

  const exitVideoFullscreenRef = useRef<() => void>(() => undefined);
  exitVideoFullscreenRef.current = () => {
    setFullscreen(false);
    setVideoUiVisible(false);
    clearTimeout(videoUiTimer.current);
    if (isAndroid) void bridge.setVideoFullscreen?.(false);
  };

  // Android 原生全屏按钮：转成应用内全屏切换；再按一次直接退出
  useEffect(() => {
    const w = window as unknown as {
      __aggEnterVideoFullscreen?: () => void;
      __aggToggleVideoFullscreen?: () => void;
    };
    w.__aggEnterVideoFullscreen = () => enterVideoFullscreenRef.current();
    w.__aggToggleVideoFullscreen = () => {
      if (fullscreen) exitVideoFullscreenRef.current();
      else enterVideoFullscreenRef.current();
    };
    return () => {
      delete w.__aggEnterVideoFullscreen;
      delete w.__aggToggleVideoFullscreen;
    };
  }, [fullscreen]);

  const exitVideoFullscreen = () => {
    setFullscreen(false);
    setVideoUiVisible(false);
    clearTimeout(videoUiTimer.current);
    if (isAndroid) void bridge.setVideoFullscreen?.(false);
  };
  /** 点击正文/漫画中心区域切换工具栏；全屏视频中点击中心短暂唤出上下集按钮 */
  const toggleFullscreen = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, .video-fs-controls')) return;
    if (window.getSelection()?.toString()) return;
    if (content?.video) {
      if (fullscreen) {
        // 全屏视频：点视频/空白都只唤出控制层，不退出全屏
        showVideoUi();
        return;
      }
      if (target.closest('video, .player')) return;
      enterVideoFullscreen();
      return;
    }
    // 小说不做全屏阅读
    if (site.kind === 'novel') return;
    setFullscreen((v) => !v);
  };

  const refreshChapter = () => {
    if (!chapter) return;
    removeContentCache(contentCacheKey(site.id, chapter.url));
    ctx.clearCache?.();
    setError('');
    setReloadNonce((n) => n + 1);
  };

  return (
    <div className={'reader theme-' + prefs.theme + (fullscreen ? ' focus' : '')}>
      {!fullscreen && (
        <header className="reader-head">
          <button className="icon-btn" onClick={onBack} title="返回目录">
            ←
          </button>
          <div className="reader-head-title">
            <span className="reader-book">{tr(title)}</span>
            <span className="reader-chapter">{prettyTitle(tr(chapter?.title ?? ''))}</span>
          </div>
          {site.kind === 'comic' && (
            <button
              className="icon-btn fullscreen-btn"
              onClick={() => setFullscreen(true)}
              title="全屏阅读"
              aria-label="全屏阅读"
            >
              <ExpandIcon />
            </button>
          )}
          {content?.video && !fullscreen && (
            <button
              className="icon-btn fullscreen-btn"
              onClick={enterVideoFullscreen}
              title="全屏播放"
              aria-label="全屏播放"
            >
              <ExpandIcon />
            </button>
          )}
          {onSwitchSource && (
            <button className="icon-btn switch-btn" onClick={onSwitchSource} title="换源" aria-label="换源">
              <SwitchIcon />
            </button>
          )}
          <button
            className="icon-btn"
            onClick={refreshChapter}
            title="刷新当前章节"
            aria-label="刷新当前章节"
            disabled={loading}
          >
            <RefreshIcon />
          </button>
          <button
            className={'icon-btn' + (settingsOpen ? ' active' : '')}
            onClick={() => setSettingsOpen((v) => !v)}
            title="阅读设置"
            style={content?.video || content?.images?.length ? { visibility: 'hidden' } : undefined}
          >
            Aa
          </button>
        </header>
      )}

      {fullscreen && (
        <div className="reader-focus-hint">点击中间显示/隐藏工具栏</div>
      )}

      {fullscreen && content?.video && (
        <button className="video-fs-close" onClick={exitVideoFullscreen} title="退出全屏" aria-label="退出全屏">
          ×
        </button>
      )}

      {fullscreen && content?.video && (
        <div className={'video-fs-controls' + (videoUiVisible ? ' show' : '')}>
          <button
            disabled={index <= 0}
            onClick={() => {
              setCountdown(null);
              onNavigate(index - 1);
              showVideoUi();
            }}
          >
            上一集
          </button>
          <div className="video-fs-meta">
            <span>{title}</span>
            <span>{prettyTitle(tr(chapter?.title ?? ''))}</span>
          </div>
          <button
            disabled={index >= chapters.length - 1}
            onClick={() => {
              setCountdown(null);
              onNavigate(index + 1);
              showVideoUi();
            }}
          >
            下一集
          </button>
          <button className="video-fs-exit" onClick={exitVideoFullscreen}>
            退出全屏
          </button>
        </div>
      )}

      {settingsOpen && (
        <div className="settings-panel">
          <div className="setting-row">
            <span>字号</span>
            <div className="setting-btns">
              <button onClick={() => updatePrefs({ size: Math.max(14, prefs.size - 1) })}>A-</button>
              <span className="setting-value">{prefs.size}px</span>
              <button onClick={() => updatePrefs({ size: Math.min(28, prefs.size + 1) })}>A+</button>
            </div>
          </div>
          <div className="setting-row">
            <span>背景</span>
            <div className="setting-btns">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={prefs.theme === t.id ? 'active' : ''}
                  onClick={() => updatePrefs({ theme: t.id })}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-row">
            <span>连播</span>
            <div className="setting-btns">
              <button
                className={prefs.autoNext ? 'active' : ''}
                onClick={() => updatePrefs({ autoNext: !prefs.autoNext })}
              >
                {prefs.autoNext ? '自动下一集' : '关闭'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className={
          'reader-scroll' +
          (content?.video ? ' has-video' : '') +
          (!fullscreen && !content?.video ? ' has-fixed-nav' : '')
        }
        ref={scrollRef}
        onScroll={handleScroll}
        onClick={toggleFullscreen}
      >
        {loading && (
          <div className="loading">
            <span className="spinner" />
            {chapter && !content ? '正在准备播放…' : '正在加载…'}
          </div>
        )}

        {error && (
          <div className="error-box">
            <p>{error}</p>
            <button className="text-btn" onClick={() => onNavigate(index)}>
              重试
            </button>
          </div>
        )}

        {content && !loading && content.video && (
          <div className="reader-video">
            {playError && <div className="error-box small">{playError}</div>}
            <VideoPlayer
              key={content.video.url}
              src={content.video.url}
              kind={content.video.kind}
              rate={settings.playback.rate}
              muted={settings.playback.muted}
              preferredHeight={
                settings.playback.quality === '1080'
                  ? 1080
                  : settings.playback.quality === '720'
                    ? 720
                    : undefined
              }
              poster={cover}
              referer={content.video.referer}
              userAgent={content.video.userAgent}
              cookies={content.video.cookies}
              startAt={startAt}
              onEnded={handleEnded}
              onProgress={handleTime}
              onError={setPlayError}
            />
            <p className="reader-video-title">
              {prettyTitle(tr(chapter?.title || content.title || ''))}
              {startAt && startAt > 3 ? ` · 从 ${formatDuration(startAt)} 续播` : ''}
            </p>

            {countdown != null && (
              <div className="autonext">
                <span>{countdown} 秒后播放下一集</span>
                <button className="primary-btn" onClick={() => setCountdown(null)}>
                  取消
                </button>
              </div>
            )}
          </div>
        )}

        {content && !loading && content.images && content.images.length > 0 && (
          <div className={'comic-pages comic-' + prefs.comicFit}>
            {content.images.map((src, i) => (
              <ComicImage key={i} src={src} index={i} />
            ))}
            <p className="comic-end">已显示全部 {content.images.length} 页</p>
          </div>
        )}

        {content && !loading && !content.video && !content.images?.length && (
          <article
            className="reader-body"
            style={{
              fontSize: prefs.size + 'px',
              lineHeight: prefs.lineHeight,
              maxWidth: prefs.pageWidth + 'px',
              ['--para-gap' as string]: prefs.paragraphGap + 'px',
            }}
          >
            <h1 className="reader-h1">{prettyTitle(tr(content.title || chapter?.title || ''))}</h1>
            {content.paragraphs.map((p, i) => (
              <p key={i}>{tr(p)}</p>
            ))}
            {content.streaming && <p className="reader-streaming">正在加载后续内容…</p>}
          </article>
        )}

        {!loading && content && !content.video && (
          <nav className={'reader-nav' + (!fullscreen ? ' reader-nav-fixed' : '')}>
            <button className="ghost-btn" disabled={index <= 0} onClick={() => onNavigate(index - 1)}>
              {site.kind === 'comic' ? '上一话' : '上一章'}
            </button>
            <span className="reader-pos">
              {index + 1} / {chapters.length} ·{' '}
              {content?.images?.length ? `P${page}/${content.images.length}` : `${percent}%`}
            </span>
            <button
              className="ghost-btn"
              disabled={index >= chapters.length - 1}
              onClick={() => onNavigate(index + 1)}
            >
              {site.kind === 'comic' ? '下一话' : '下一章'}
            </button>
          </nav>
        )}
      </div>
    </div>
  );
}
