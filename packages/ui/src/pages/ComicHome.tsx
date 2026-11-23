import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookSection, Site, SiteCtx } from '@agg/core';
import Cover from '../components/Cover';
import { bridge } from '../bridge';
import { useSites } from '../sites';
import { loadViewState, saveViewState } from '../viewState';

interface Props {
  sites: Site[];
  ctxFor: (siteId: string) => SiteCtx | null;
  onOpenBook: (siteId: string, url: string) => void;
}

interface SiteState {
  status: 'loading' | 'done' | 'error';
  sections: BookSection[];
  error?: string;
}

export default function ComicHome({ sites, ctxFor, onOpenBook }: Props) {
  const { settings, allSites } = useSites();
  const comicSites = useMemo(() => sites.filter((s) => s.kind === 'comic'), [sites]);
  const [states, setStates] = useState<Record<string, SiteState>>({});
  const [filter, setFilter] = useState(() => loadViewState('agg.comic.source.v1', 'all'));
  const [reloadKey, setReloadKey] = useState(0);
  const runRef = useRef(0);

  useEffect(() => {
    saveViewState('agg.comic.source.v1', filter);
  }, [filter]);

  // 源被关闭/源列表变化时回到「全部」，避免停留在不存在的 tab
  useEffect(() => {
    if (filter !== 'all' && !comicSites.some((s) => s.id === filter)) setFilter('all');
  }, [comicSites, filter]);

  const load = useCallback(async () => {
    const id = ++runRef.current;
    setStates(
      Object.fromEntries(
        comicSites.map((s) => [s.id, { status: 'loading' as const, sections: [] }]),
      ),
    );
    await Promise.all(
      comicSites.map(async (site) => {
        const setOne = (state: SiteState) => {
          if (id === runRef.current) setStates((prev) => ({ ...prev, [site.id]: state }));
        };
        const ctx = ctxFor(site.id);
        if (!ctx || !site.home) {
          setOne({ status: 'error', sections: [], error: '站点未就绪' });
          return;
        }
        try {
          const sections = await site.home(ctx);
          setOne({ status: 'done', sections });
        } catch (e) {
          setOne({
            status: 'error',
            sections: [],
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }),
    );
  }, [comicSites, ctxFor]);

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  const visible = filter === 'all' ? comicSites : comicSites.filter((s) => s.id === filter);

  if (!comicSites.length) {
    const hidden = allSites.filter(
      (s) => s.kind === 'comic' && !sites.some((x) => x.id === s.id),
    ).length;
    return (
      <p className="empty">
        没有可用的漫画源。
        {!settings.flightMode && hidden > 0
          ? `飞行模式关闭时已隐藏 ${hidden} 个漫画源，可在设置中开启飞行模式。`
          : ''}
      </p>
    );
  }

  return (
    <div className="comic-home">
      <div className="home-tabs">
        <button className={'home-tab' + (filter === 'all' ? ' active' : '')} onClick={() => setFilter('all')}>
          全部
          <span className="tab-dot">{comicSites.length}</span>
        </button>
        {comicSites.map((s) => (
          <button
            key={s.id}
            className={'home-tab' + (filter === s.id ? ' active' : '')}
            onClick={() => setFilter(s.id)}
          >
            {s.name}
            {states[s.id]?.status === 'loading' && <span className="tab-dot">…</span>}
          </button>
        ))}
        <button className="text-btn" onClick={() => setReloadKey((k) => k + 1)}>
          刷新
        </button>
      </div>

      {visible.map((site) => {
        const st = states[site.id];
        return (
          <div key={site.id} className="comic-source">
            <h2 className="comic-source-title">
              {site.name}
              {st?.status === 'done' && (
                <span className="group-count">
                  {st.sections.reduce((n, s) => n + s.books.length, 0)}
                </span>
              )}
            </h2>

            {st?.status === 'loading' && (
              <div className="loading small">
                <span className="spinner" /> {site.name} 加载中…
              </div>
            )}

            {st?.status === 'error' && (
              <div className="error-box small">
                <p>
                  {site.name}：{st.error}
                </p>
                {site.id === 'mycomic' && (
                  <p className="muted small">
                    MYCOMIC 若提示「you have been blocked」，这是 IP 级拦截，自动验证不会生效；
                    请换一个可访问的网络后点「重试」。
                  </p>
                )}
                <div className="error-actions">
                  <button
                    className="text-btn"
                    onClick={async () => {
                      const ctx = ctxFor(site.id);
                      if (!ctx) return;
                      const ok = await ctx
                        .verify(site.referer || site.baseUrl)
                        .catch(() => false);
                      if (ok) load();
                    }}
                  >
                    验证
                  </button>
                  <button
                    className="text-btn"
                    onClick={() => {
                      bridge
                        .openWindow(site.id, site.referer || site.baseUrl)
                        .catch(() => undefined);
                    }}
                  >
                    打开站点
                  </button>
                  <button className="text-btn" onClick={() => load()}>
                    重试
                  </button>
                </div>
              </div>
            )}

            {st?.sections.map((section) => (
              <section className="section" key={site.id + section.title}>
                <div className="home-section-head">
                  <h3 className="section-title">
                    {filter === 'all' ? section.title : `${site.name} · ${section.title}`}
                    <span className="group-count">{section.books.length}</span>
                  </h3>
                </div>
                <div className="book-grid">
                  {section.books.map((book) => (
                    <button
                      key={book.url}
                      className="book-card"
                      onClick={() => onOpenBook(site.id, book.url)}
                    >
                      <Cover src={book.cover} title={book.title} className="book-cover" />
                      <span className="book-title">{book.title}</span>
                      {book.extra && <span className="book-author">{book.extra}</span>}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        );
      })}
    </div>
  );
}
