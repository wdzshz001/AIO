import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppDef, BookRef, Site, SiteCtx } from '@agg/core';
import {
  channelCategories,
  getApp,
  getBangumiSeason,
  getBangumiTrending,
  hasRankChannels,
  loadCategoryChannels,
  loadRankChannels,
  loadRecommendChannels,
  sitesOfApp,
  type BangumiSubject,
  type ChannelMode,
  type SiteChannel,
} from '@agg/adapters';
import Cover from '../components/Cover';
import { displayText } from '../chinese';
import { bridge } from '../bridge';
import { loadViewState, saveViewState } from '../viewState';

interface Props {
  appId: string;
  sites: Site[];
  ctxFor: (siteId: string) => SiteCtx | null;
  onOpenBook: (siteId: string, url: string) => void;
  onOpenSubject: (subjectId: number) => void;
  onBack: () => void;
}

function BookRow({
  books,
  siteId,
  onOpen,
}: {
  books: BookRef[];
  siteId: string;
  onOpen: (siteId: string, url: string) => void;
}) {
  return (
    <div className="book-grid">
      {books.map((b) => (
        <button
          key={b.url}
          className="book-card"
          onClick={() => onOpen(siteId, b.url)}
          title={b.intro || displayText(b.title)}
        >
          <Cover src={b.cover} title={displayText(b.title)} className="book-cover" />
          <span className="book-title">{displayText(b.title)}</span>
          <span className="book-author">
            {[displayText(b.author), displayText(b.extra)].filter(Boolean).join(' · ') || ' '}
          </span>
        </button>
      ))}
    </div>
  );
}

function SubjectRow({
  subjects,
  onOpen,
}: {
  subjects: BangumiSubject[];
  onOpen: (id: number) => void;
}) {
  return (
    <div className="book-grid">
      {subjects.map((s) => (
        <button
          key={s.id}
          className="book-card"
          onClick={() => onOpen(s.id)}
          title={s.summary || s.name}
        >
          <Cover src={s.cover} title={displayText(s.nameCn || s.name)} className="book-cover" />
          <span className="book-title">{displayText(s.nameCn || s.name)}</span>
          <span className="book-author">{s.score ? `${s.score.toFixed(1)} 分` : '动画'}</span>
        </button>
      ))}
    </div>
  );
}

function AnimeChannels({ onOpenSubject }: { onOpenSubject: (id: number) => void }) {
  const [trending, setTrending] = useState<BangumiSubject[]>([]);
  const [season, setSeason] = useState<BangumiSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    Promise.allSettled([getBangumiTrending(bridge, 18), getBangumiSeason(bridge, 18)])
      .then(([t, s]) => {
        if (!alive) return;
        if (t.status === 'fulfilled') setTrending(t.value);
        if (s.status === 'fulfilled') setSeason(s.value);
        if (t.status === 'rejected' && s.status === 'rejected') setError('动画频道加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="loading">
        <span className="spinner" /> 正在加载动画频道…
      </div>
    );
  }
  return (
    <div className="channel-list">
      {error && <p className="error-box small">{error}</p>}
      {trending.length > 0 && (
        <section className="channel-block">
          <div className="channel-block-head">
            <h2>Bangumi · 热度榜</h2>
            <span className="muted small">源站频道</span>
          </div>
          <SubjectRow subjects={trending} onOpen={onOpenSubject} />
        </section>
      )}
      {season.length > 0 && (
        <section className="channel-block">
          <div className="channel-block-head">
            <h2>Bangumi · 本季推荐</h2>
            <span className="muted small">源站频道</span>
          </div>
          <SubjectRow subjects={season} onOpen={onOpenSubject} />
        </section>
      )}
    </div>
  );
}

export default function ChannelPage({
  appId,
  sites,
  ctxFor,
  onOpenBook,
  onOpenSubject,
  onBack,
}: Props) {
  const app = getApp(appId);
  const isAnime = app?.kinds.includes('anime') ?? false;
  const appSites = useMemo(
    () => (app ? sitesOfApp(app, sites).filter((s) => !!s.home) : []),
    [app, sites],
  );
  const [siteId, setSiteId] = useState('');
  const [mode, setMode] = useState<ChannelMode>(() => {
    const saved = loadViewState<ChannelMode>(`agg.channels.mode.${appId}`, 'recommend');
    return saved === 'rank' || saved === 'category' ? saved : 'recommend';
  });
  const [categoryId, setCategoryId] = useState('');
  const [channels, setChannels] = useState<SiteChannel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const mainScrollRef = useRef(0);

  const site = appSites.find((s) => s.id === siteId);
  const categories = site ? channelCategories(site) : [];
  const canRank = site ? hasRankChannels(site) : false;
  const canCategory = categories.length > 0;

  // 从书籍/阅读页返回时恢复频道页选择的源
  useEffect(() => {
    if (siteId && appSites.some((s) => s.id === siteId)) return;
    const saved = loadViewState(`agg.channels.site.${appId}`, '');
    setSiteId(appSites.some((s) => s.id === saved) ? saved : (appSites[0]?.id ?? ''));
  }, [appId, appSites, siteId]);

  useEffect(() => {
    if (siteId) saveViewState(`agg.channels.site.${appId}`, siteId);
  }, [appId, siteId]);

  useEffect(() => {
    saveViewState(`agg.channels.mode.${appId}`, mode);
  }, [appId, mode]);

  useEffect(() => {
    if (!site) return;
    if (!canRank && mode === 'rank') setMode('recommend');
    if (!canCategory && mode === 'category') setMode('recommend');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, canRank, canCategory]);

  useEffect(() => {
    if (!site || mode !== 'category') return;
    const saved = loadViewState(`agg.channels.category.${appId}.${site.id}`, '');
    const next = categories.some((c) => c.id === saved) ? saved : (categories[0]?.id ?? '');
    if (next && next !== categoryId) setCategoryId(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteId, mode]);

  useEffect(() => {
    if (site && categoryId) {
      saveViewState(`agg.channels.category.${appId}.${site.id}`, categoryId);
    }
  }, [appId, site, categoryId]);

  // 从阅读页返回时恢复频道列表滚动位置
  useEffect(() => {
    const main = document.querySelector('.main');
    if (!main) return;
    const key = `agg.scroll.channels.${appId}`;
    const saved = Number(loadViewState(key, 0)) || 0;
    mainScrollRef.current = saved;
    let userScrolled = false;
    const mark = () => {
      userScrolled = true;
    };
    const restore = () => {
      if (saved > 0 && !userScrolled) main.scrollTop = saved;
    };
    const timers = [250, 900, 1800].map((ms) => setTimeout(restore, ms));
    main.addEventListener('wheel', mark, { passive: true });
    main.addEventListener('touchstart', mark, { passive: true });
    main.addEventListener('pointerdown', mark);
    const onScroll = () => {
      mainScrollRef.current = main.scrollTop;
      saveViewState(key, main.scrollTop);
    };
    main.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      timers.forEach(clearTimeout);
      main.removeEventListener('wheel', mark);
      main.removeEventListener('touchstart', mark);
      main.removeEventListener('pointerdown', mark);
      main.removeEventListener('scroll', onScroll);
      saveViewState(key, mainScrollRef.current);
    };
  }, [appId]);

  useEffect(() => {
    if (isAnime || !site) return;
    let alive = true;
    setLoading(true);
    setError('');
    setChannels([]);
    const ctx = ctxFor(site.id);
    if (!ctx) {
      setError('站点未就绪');
      setLoading(false);
      return;
    }
    const task =
      mode === 'rank'
        ? loadRankChannels(site, ctx)
        : mode === 'category'
          ? loadCategoryChannels(site, ctx, categoryId)
          : loadRecommendChannels(site, ctx);
    task
      .then((list) => {
        if (alive) setChannels(list);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [isAnime, site, mode, categoryId, ctxFor]);

  return (
    <div className="page channel-page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <div>
            <h1>{app?.name ?? '应用'} · 频道</h1>
            <p className="muted">按源站浏览推荐、排行与分类</p>
          </div>
        </div>
      </header>

      {isAnime ? (
        <AnimeChannels onOpenSubject={onOpenSubject} />
      ) : (
        <>
          <div className="channel-source-tabs">
            {appSites.map((s) => (
              <button
                key={s.id}
                className={'home-tab' + (s.id === siteId ? ' active' : '')}
                onClick={() => setSiteId(s.id)}
              >
                {s.name}
              </button>
            ))}
          </div>

          <div className="channel-mode-tabs">
            <button className={'home-tab' + (mode === 'recommend' ? ' active' : '')} onClick={() => setMode('recommend')}>
              推荐
            </button>
            {canRank && (
              <button className={'home-tab' + (mode === 'rank' ? ' active' : '')} onClick={() => setMode('rank')}>
                排行
              </button>
            )}
            {canCategory && (
              <button className={'home-tab' + (mode === 'category' ? ' active' : '')} onClick={() => setMode('category')}>
                分类
              </button>
            )}
          </div>

          {mode === 'category' && categories.length > 0 && (
            <div className="category-chips">
              {categories.map((c) => (
                <button
                  key={c.id}
                  className={'home-tab category-tab' + (c.id === categoryId ? ' active' : '')}
                  onClick={() => setCategoryId(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}

          {loading && (
            <div className="loading">
              <span className="spinner" /> 正在读取{site?.name ?? ''}频道…
            </div>
          )}
          {error && <p className="error-box small">{error}</p>}

          <div className="channel-list">
            {!loading &&
              channels.map((ch) => (
                <section className="channel-block" key={ch.id}>
                  <div className="channel-block-head">
                    <h2>{displayText(ch.title)}</h2>
                    <span className="muted small">{ch.books.length} 本 · {ch.siteName}</span>
                  </div>
                  <BookRow books={ch.books} siteId={ch.siteId} onOpen={onOpenBook} />
                </section>
              ))}
            {!loading && !error && channels.length === 0 && (
              <p className="empty">这个源暂时没有可展示的频道。</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
