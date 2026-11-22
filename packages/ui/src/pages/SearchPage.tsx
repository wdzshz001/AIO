import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookRef, Site, SiteCtx } from '@agg/core';
import {
  apps,
  matchSubject,
  searchBangumi,
  type BangumiSubject,
} from '@agg/adapters';
import Cover from '../components/Cover';
import { bridge } from '../bridge';
import { useSites } from '../sites';

interface Props {
  initialQuery: string;
  /** 从应用内搜索进入时，默认只选该应用分类（novel / anime） */
  initialCategory?: string;
  ctxFor: (siteId: string) => SiteCtx | null;
  onOpenBook: (siteId: string, url: string) => void;
  onOpenSubject: (subjectId: number) => void;
  onBack: () => void;
}

interface SiteState {
  status: 'idle' | 'loading' | 'done' | 'error';
  books: BookRef[];
  error?: string;
}

interface MergedBook {
  key: string;
  book: BookRef;
  siteId: string;
  sourceCount: number;
}

const CACHE_TTL = 10 * 60_000;
const cache = new Map<string, { at: number; books: BookRef[] }>();

/** 同名合并用的归一化：去空白、标点、书名号 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s《》〈〉【】\[\]()（）:：·、,，.。!！?？\-—_/\\'"“”‘’]/g, '')
    .trim();
}

export default function SearchPage({
  initialQuery,
  initialCategory,
  ctxFor,
  onOpenBook,
  onOpenSubject,
  onBack,
}: Props) {
  const { sites } = useSites();
  const [input, setInput] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery.trim());
  const [states, setStates] = useState<Record<string, SiteState>>({});
  const [subjects, setSubjects] = useState<BangumiSubject[]>([]);
  const [subjectState, setSubjectState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [subjectError, setSubjectError] = useState('');
  const [category, setCategory] = useState<string>(initialCategory ?? 'all');
  const [siteFilter, setSiteFilter] = useState<string>('all');
  const runRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCategory(initialCategory ?? 'all');
    setSiteFilter('all');
  }, [initialCategory]);

  const searchable = useMemo(() => sites.filter((s) => !!s.search), [sites]);
  const animeSearchable = useMemo(() => searchable.filter((s) => s.kind === 'anime'), [searchable]);
  const novelSearchable = useMemo(() => searchable.filter((s) => s.kind === 'novel'), [searchable]);
  const comicSearchable = useMemo(() => searchable.filter((s) => s.kind === 'comic'), [searchable]);
  const categories = useMemo(
    () => apps.filter((a) => searchable.some((s) => a.kinds.includes(s.kind))),
    [searchable],
  );

  const sitesInCategory = useMemo(() => {
    if (category === 'all') return searchable;
    const app = apps.find((a) => a.id === category);
    return app ? searchable.filter((s) => app.kinds.includes(s.kind)) : searchable;
  }, [category, searchable]);

  const visibleSites = useMemo(
    () => (siteFilter === 'all' ? sitesInCategory : sitesInCategory.filter((s) => s.id === siteFilter)),
    [sitesInCategory, siteFilter],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = useCallback(
    async (raw: string) => {
      const keyword = raw.trim();
      if (!keyword) {
        setStates({});
        setSubjects([]);
        setSubjectState('idle');
        return;
      }
      const id = ++runRef.current;
      setSiteFilter('all');
      setStates(
        Object.fromEntries(searchable.map((s) => [s.id, { status: 'loading' as const, books: [] }])),
      );
      setSubjects([]);
      setSubjectState('loading');
      setSubjectError('');

      // Bangumi 条目：动画应用的主入口（不阻塞站点搜索）
      searchBangumi(bridge, keyword)
        .then((list) => {
          if (id !== runRef.current) return;
          setSubjects(list);
          setSubjectState('done');
        })
        .catch((e) => {
          if (id !== runRef.current) return;
          setSubjectState('error');
          setSubjectError(e instanceof Error ? e.message : String(e));
        });

      await Promise.all(
        searchable.map(async (site) => {
          const setOne = (state: SiteState) => {
            if (id === runRef.current) setStates((prev) => ({ ...prev, [site.id]: state }));
          };
          const key = `${site.id}:${keyword}`;
          const hit = cache.get(key);
          if (hit && Date.now() - hit.at < CACHE_TTL) {
            setOne({ status: 'done', books: hit.books });
            return;
          }
          const ctx = ctxFor(site.id);
          if (!ctx || !site.search) {
            setOne({ status: 'error', books: [], error: '站点未就绪' });
            return;
          }
          try {
            const books = await site.search(ctx, keyword);
            cache.set(key, { at: Date.now(), books });
            setOne({ status: 'done', books });
          } catch (e) {
            setOne({ status: 'error', books: [], error: e instanceof Error ? e.message : String(e) });
          }
        }),
      );
    },
    [ctxFor, searchable],
  );

  useEffect(() => {
    if (initialQuery.trim()) run(initialQuery);
  }, [initialQuery, run]);

  /** 同名合并：优先按 Bangumi 条目归并，封面用 Bangumi 的补齐 */
  const merge = (list: Site[]): MergedBook[] => {
    const map = new Map<string, MergedBook>();
    for (const site of list) {
      const st = states[site.id];
      if (!st || st.status !== 'done') continue;
      for (const book of st.books) {
        const subject = matchSubject(book.title, subjects);
        const key = subject ? `bgm:${subject.id}` : `t:${normalizeTitle(book.title)}`;
        if (!key || key === 't:') continue;

        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            key,
            book: { ...book, cover: book.cover ?? subject?.cover },
            siteId: site.id,
            sourceCount: 1,
          });
        } else {
          existing.sourceCount += 1;
          if (!existing.book.cover && (book.cover || subject?.cover)) {
            existing.book = { ...existing.book, cover: book.cover ?? subject?.cover };
          }
        }
      }
    }
    return [...map.values()];
  };

  const renderGrid = (list: MergedBook[]) => (
    <div className="book-grid">
      {list.map((item) => (
        <button
          key={item.key}
          className="book-card"
          onClick={() => onOpenBook(item.siteId, item.book.url)}
        >
          <Cover src={item.book.cover} title={item.book.title} className="book-cover" />
          <span className="book-title">{item.book.title}</span>
          {item.book.extra && <span className="book-author">{item.book.extra}</span>}
        </button>
      ))}
    </div>
  );

  const renderSubjects = (list: BangumiSubject[]) => (
    <div className="subject-grid">
      {list.map((s) => (
        <button key={s.id} className="subject-card" onClick={() => onOpenSubject(s.id)}>
          <Cover src={s.cover} title={s.nameCn || s.name} className="book-cover" />
          <span className="book-title">{s.nameCn || s.name}</span>
          <span className="book-author">
            {[s.date?.slice(0, 7), s.score ? `${s.score} 分` : ''].filter(Boolean).join(' · ') || '动画'}
          </span>
        </button>
      ))}
    </div>
  );

  const submit = () => {
    setQuery(input.trim());
    run(input);
  };

  const failed = visibleSites.filter((s) => states[s.id]?.status === 'error');
  const loadingCount = visibleSites.filter((s) => states[s.id]?.status === 'loading').length;
  const uniqueCount = (list: Site[]) => merge(list).length;
  const animeUnique = subjects.length + uniqueCount(animeSearchable);

  return (
    <div className="page">
      <header className="search-head">
        <button className="icon-btn" onClick={onBack} title="返回">
          ←
        </button>
        <div className="search-box">
          <input
            ref={inputRef}
            className="search-input-lg"
            value={input}
            placeholder="搜索小说、动画或漫画…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
            }}
          />
          <button className="primary-btn" onClick={submit}>
            搜索
          </button>
        </div>
      </header>

      {!query && <p className="empty">搜索你感兴趣的小说、动画或漫画。</p>}

      {query && (
        <>
          <div className="chips">
            <button
              className={'chip' + (category === 'all' ? ' active' : '')}
              onClick={() => {
                setCategory('all');
                setSiteFilter('all');
              }}
            >
              全部 <span className="chip-count">{subjects.length + uniqueCount(searchable)}</span>
            </button>
            {categories.map((app) => {
              const list = searchable.filter((s) => app.kinds.includes(s.kind));
              const count = app.kinds.includes('anime') ? subjects.length + uniqueCount(list) : uniqueCount(list);
              return (
                <button
                  key={app.id}
                  className={'chip' + (category === app.id ? ' active' : '')}
                  onClick={() => {
                    setCategory(app.id);
                    setSiteFilter('all');
                  }}
                >
                  {app.name} <span className="chip-count">{count}</span>
                </button>
              );
            })}
          </div>

          {(category === 'all' || category === 'anime') && (
            <section className="result-group">
              <h2 className="group-title">
                动画作品
                <span className="group-count">{subjectState === 'loading' ? '…' : subjects.length}</span>
              </h2>
              {subjectState === 'error' && (
                <div className="error-box small">
                  <p>动画搜索失败：{subjectError}</p>
                  <button className="text-btn" onClick={() => run(query)}>
                    重试
                  </button>
                </div>
              )}
              {subjects.length > 0 && renderSubjects(subjects)}
              {subjectState === 'done' && subjects.length === 0 && (
                <p className="empty">没有匹配的动画作品，可以看看下面的来源结果。</p>
              )}
            </section>
          )}

          {category === 'novel' && (
            <>
              {siteFilter === 'all' ? (
                categories
                  .filter((a) => a.kinds.includes('novel'))
                  .map((app) => {
                    const list = searchable.filter((s) => app.kinds.includes(s.kind));
                    const merged = merge(list);
                    if (!merged.length) return null;
                    return (
                      <div key={app.id} className="result-group">
                        <h2 className="group-title">
                          {app.name}
                          <span className="group-count">{merged.length}</span>
                        </h2>
                        {renderGrid(merged)}
                      </div>
                    );
                  })
              ) : (
                <div className="result-group">{renderGrid(merge(visibleSites))}</div>
              )}
            </>
          )}

          {category === 'comic' && (
            <div className="result-group">
              <h2 className="group-title">
                漫画
                <span className="group-count">{uniqueCount(comicSearchable)}</span>
              </h2>
              {(() => {
                const merged = merge(comicSearchable);
                return merged.length ? (
                  renderGrid(merged)
                ) : (
                  <p className="empty">没有找到漫画结果{loadingCount > 0 ? '，部分源还在搜索…' : ''}</p>
                );
              })()}
            </div>
          )}

          {category === 'anime' && (
            <details className="result-group raw-results" open={subjects.length === 0}>
              <summary>
                源站直搜结果
                <span className="group-count">{uniqueCount(animeSearchable)}</span>
              </summary>
              <div className="chips secondary">
                <button
                  className={'chip small' + (siteFilter === 'all' ? ' active' : '')}
                  onClick={() => setSiteFilter('all')}
                >
                  全部来源
                </button>
                {animeSearchable.map((s) => (
                  <button
                    key={s.id}
                    className={'chip small' + (siteFilter === s.id ? ' active' : '')}
                    onClick={() => setSiteFilter(s.id)}
                  >
                    {s.name}
                    <span className="chip-count">
                      {states[s.id]?.status === 'loading' ? '…' : (states[s.id]?.books.length ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
              {renderGrid(merge(category === 'anime' ? visibleSites : animeSearchable))}
            </details>
          )}

          {category === 'all' && (
            <>
              {categories
                .filter((a) => a.kinds.includes('novel'))
                .map((app) => {
                  const list = searchable.filter((s) => app.kinds.includes(s.kind));
                  const merged = merge(list);
                  if (!merged.length) return null;
                  return (
                    <div key={app.id} className="result-group">
                      <h2 className="group-title">
                        {app.name}
                        <span className="group-count">{merged.length}</span>
                      </h2>
                      {renderGrid(merged)}
                    </div>
                  );
                })}
              {comicSearchable.length > 0 &&
                (() => {
                  const merged = merge(comicSearchable);
                  if (!merged.length) return null;
                  return (
                    <div className="result-group">
                      <h2 className="group-title">
                        漫画
                        <span className="group-count">{merged.length}</span>
                      </h2>
                      {renderGrid(merged)}
                    </div>
                  );
                })()}
              <details className="result-group raw-results">
                <summary>
                  更多动画来源
                  <span className="group-count">{animeUnique - subjects.length}</span>
                </summary>
                {renderGrid(merge(animeSearchable))}
              </details>
            </>
          )}

          {(loadingCount > 0 || failed.length > 0) && (
            <div className="search-status">
              {loadingCount > 0 && (
                <span className="result-note">
                  <span className="spinner" /> 正在搜索更多来源…
                </span>
              )}
              {failed.map((site) => (
                <button
                  key={site.id}
                  className="chip small"
                  title={states[site.id]?.error}
                  onClick={async () => {
                    const ctx = ctxFor(site.id);
                    if (!ctx) return;
                    const ok = await ctx.verify(site.referer || site.baseUrl);
                    if (ok) run(query);
                  }}
                >
                  {site.name} · 重试
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
