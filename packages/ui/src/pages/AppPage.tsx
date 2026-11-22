import { useEffect, useState } from 'react';
import type { AppDef, BookSection, Site, SiteCtx } from '@agg/core';
import Cover from '../components/Cover';
import AnimeHome from './AnimeHome';
import NovelHome from './NovelHome';
import ComicHome from './ComicHome';

interface Props {
  app: AppDef;
  sites: Site[];
  ctxFor: (siteId: string) => SiteCtx | null;
  onOpenBook: (siteId: string, url: string) => void;
  onOpenSubject?: (subjectId: number) => void;
  onSearch?: (query: string, category: string) => void;
  onBack: () => void;
  loadingSources?: boolean;
  sourcesError?: string;
  onReloadSources?: () => void;
}

interface OtherState {
  status: 'loading' | 'done' | 'error';
  sections: BookSection[];
  error?: string;
}

export default function AppPage({
  app,
  sites,
  ctxFor,
  onOpenBook,
  onOpenSubject,
  onSearch,
  onBack,
  loadingSources,
  sourcesError,
  onReloadSources,
}: Props) {
  const isAnime = app.kinds.includes('anime');
  const isNovel = app.kinds.includes('novel');
  const isComic = app.kinds.includes('comic');
  const [reloadKey, setReloadKey] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [otherStates, setOtherStates] = useState<Record<string, OtherState>>({});

  /** 小说首页以起点为主，其余书源只在「其他书源」里加载 */
  const otherSites = sites.filter((s) => app.kinds.includes(s.kind) && s.id !== 'qidian');

  useEffect(() => {
    if (!isNovel) return;
    let alive = true;
    setOtherStates(
      Object.fromEntries(
        otherSites.map((s) => [s.id, { status: 'loading' as const, sections: [] }]),
      ),
    );
    for (const site of otherSites) {
      const ctx = ctxFor(site.id);
      if (!ctx || !site.home) {
        if (alive) {
          setOtherStates((prev) => ({
            ...prev,
            [site.id]: { status: 'error', sections: [], error: '站点未就绪' },
          }));
        }
        continue;
      }
      site
        .home(ctx)
        .then((sections) => {
          if (alive) setOtherStates((prev) => ({ ...prev, [site.id]: { status: 'done', sections } }));
        })
        .catch((e) => {
          if (alive) {
            setOtherStates((prev) => ({
              ...prev,
              [site.id]: {
                status: 'error',
                sections: [],
                error: e instanceof Error ? e.message : String(e),
              },
            }));
          }
        });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNovel, reloadKey, ctxFor, sites]);

  const subtitle = isAnime
    ? '新番、热度与追番'
    : isNovel
      ? '发现下一本好书'
      : isComic
        ? '找一部想看的漫画'
        : '发现新内容';

  return (
    <div className="page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <span className="app-icon small" style={{ background: app.color }}>
            {app.icon}
          </span>
          <div>
            <h1>{app.name}</h1>
            <p className="muted">{subtitle}</p>
          </div>
        </div>
        <button className="icon-btn" onClick={() => setReloadKey((k) => k + 1)} title="刷新">
          ↻
        </button>
      </header>

      <div className="app-search">
        <input
          className="search-input-lg"
          value={keyword}
          placeholder={
            isNovel
              ? '搜索小说、作者…'
              : isComic
                ? '搜索漫画…'
                : '搜索动画…'
          }
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const q = keyword.trim();
              if (q) onSearch?.(q, app.id);
            }
          }}
        />
        <button
          className="primary-btn"
          onClick={() => {
            const q = keyword.trim();
            if (q) onSearch?.(q, app.id);
          }}
        >
          搜索
        </button>
      </div>

      {sites.length === 0 && (loadingSources || sourcesError) && (
        <div className="source-status">
          {loadingSources && (
            <>
              <span className="spinner" />
              正在准备内容…
            </>
          )}
          {sourcesError && !loadingSources && (
            <>
              内容源暂时不可用
              {onReloadSources && (
                <button className="text-btn" onClick={onReloadSources}>
                  重试
                </button>
              )}
            </>
          )}
        </div>
      )}

      {isAnime && (
        <AnimeHome key={reloadKey} onOpenSubject={(id) => onOpenSubject?.(id)} />
      )}

      {isNovel && (
        <>
          <NovelHome key={reloadKey} ctxFor={ctxFor} onOpenBook={onOpenBook} />

          <details className="other-sources">
            <summary>更多书源</summary>
            {otherSites.map((site) => {
              const st = otherStates[site.id];
              return (
                <div key={site.id}>
                  <h3 className="other-source-title">{site.name}</h3>
                  {st?.status === 'loading' && (
                    <div className="loading small">
                      <span className="spinner" /> 加载中…
                    </div>
                  )}
                  {st?.status === 'error' && (
                    <p className="source-status">
                      {site.name} 暂时无法加载
                    </p>
                  )}
                  {st?.sections.map((section) => (
                    <section className="section" key={site.id + section.title}>
                      <h4 className="section-title">{section.title}</h4>
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
          </details>
        </>
      )}

      {isComic && (
        <ComicHome key={reloadKey} sites={sites} ctxFor={ctxFor} onOpenBook={onOpenBook} />
      )}

      {!isAnime && !isNovel && !isComic && <p className="empty">这个应用还没有首页内容。</p>}
    </div>
  );
}
