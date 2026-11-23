import { useEffect, useMemo, useState } from 'react';
import type { BookDetail, Chapter, Site, SiteCtx } from '@agg/core';
import { findSourcesByTitle } from '@agg/adapters';
import Cover from '../components/Cover';
import { cacheChapters, cachedChapters, loadShelf } from '../store';

interface Props {
  site: Site;
  ctx: SiteCtx;
  url: string;
  sites: Site[];
  ctxFor: (siteId: string) => SiteCtx | null;
  onBack: () => void;
  onSwitchSource: (siteId: string, url: string) => void;
  onRead: (detail: BookDetail, chapters: Chapter[], index: number) => void;
}

const PAGE = 300;

export default function BookPage({
  site,
  ctx,
  url,
  sites,
  ctxFor,
  onBack,
  onSwitchSource,
  onRead,
}: Props) {
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [chapters, setChapters] = useState<Chapter[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [chaptersLoading, setChaptersLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [introOpen, setIntroOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchLoading, setSwitchLoading] = useState(false);
  const [switchState, setSwitchState] = useState<
    Record<string, { status: 'pending' | 'ok' | 'empty' | 'error'; title?: string; target?: string; error?: string }>
  >({});

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setChapters(null);
    setError('');
    setNote('');
    setFilter('');
    setShown(PAGE);
    setChaptersLoading(false);

    (async () => {
      try {
        const d = await site.detail(ctx, url);
        if (!alive) return;
        setDetail(d);

        // 详情接口自带的目录优先于旧缓存：CloudWN 合集从“1话”升级为多话时，
        // 不能让上一版缓存的一话目录继续覆盖新目录。
        if (d.chapters.length) {
          setChapters(d.chapters);
          if (d.chapters.length <= 2000) cacheChapters(url, d.chapters);
          return;
        }

        const cached = cachedChapters(url);
        if (cached) {
          setChapters(cached);
          return;
        }

        if (!site.chapters) {
          setChapters(d.chapters);
          if (d.chapters.length && d.chapters.length <= 2000) cacheChapters(url, d.chapters);
          return;
        }

        setNote('正在读取目录…');
        setChaptersLoading(true);
        const list = await site.chapters(ctx, url, (partial) => {
          if (!alive) return;
          setChapters(partial.slice());
          setNote(`正在读取目录… 已获取 ${partial.length} 章`);
        });
        if (!alive) return;
        cacheChapters(url, list);
        setChapters(list);
        setNote('');
        setChaptersLoading(false);
      } catch (e) {
        if (alive) {
          setError(e instanceof Error ? e.message : String(e));
          setChaptersLoading(false);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [site, ctx, url, reloadKey]);

  const unit = site.kind === 'anime' ? '集' : site.kind === 'comic' ? '话' : '章';
  const progressVerb = site.kind === 'anime' ? '继续播放' : '继续阅读';
  const startVerb = site.kind === 'anime' ? '开始观看' : '开始阅读';

  const progress = useMemo(() => {
    const entry = loadShelf().find((x) => x.url === url);
    if (!entry || !entry.chapter || !chapters) return null;
    const idx = chapters.findIndex((c) => c.url === entry.chapter!.url);
    return idx >= 0 ? { index: idx, chapter: chapters[idx] } : null;
  }, [url, chapters]);

  const filtered = useMemo(() => {
    if (!chapters) return [];
    const q = filter.trim();
    if (!q) return chapters;
    return chapters.filter((c) => c.title.includes(q));
  }, [chapters, filter]);

  const visible = filtered.slice(0, shown);
  const indexMap = useMemo(
    () => new Map((chapters ?? []).map((c, i) => [c, i] as const)),
    [chapters],
  );

  const openSwitch = async () => {
    setSwitchOpen(true);
    setSwitchLoading(true);
    const options = sites.filter((s) => s.kind === site.kind && !!s.search && s.id !== site.id);
    setSwitchState(
      Object.fromEntries(options.map((s) => [s.id, { status: 'pending' as const }])),
    );
    try {
      const found = await findSourcesByTitle(
        ctxFor,
        options,
        detail?.title ?? '',
        site.kind,
        (siteId, state) =>
          setSwitchState((prev) => ({
            ...prev,
            [siteId]: {
              status: state.status,
              title: state.ref?.title,
              target: state.ref?.url,
              error: state.error,
            },
          })),
      );
      // 把成功的链接补进状态（onUpdate 已写入，这里兜底）
      setSwitchState((prev) => {
        const next = { ...prev };
        for (const f of found) {
          next[f.siteId] = { status: 'ok', title: f.title, target: f.url };
        }
        return next;
      });
    } finally {
      setSwitchLoading(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <div className="head-title-wrap">
            <h1>{detail?.title ?? '加载中…'}</h1>
            {detail?.author && <p className="muted">{detail.author}</p>}
          </div>
        </div>
        <div className="head-actions">
          <button className="text-btn" onClick={openSwitch} disabled={!detail}>
            换源
          </button>
          <button className="icon-btn" onClick={() => setReloadKey((k) => k + 1)} title="刷新">
            ↻
          </button>
        </div>
      </header>

      {switchOpen && (
        <section className="section switch-panel">
          <div className="chapter-head">
            <h2 className="section-title">
              同名来源
              <span className="group-count">
                {Object.values(switchState).filter((s) => s.status === 'ok').length}
              </span>
            </h2>
            <button className="text-btn" onClick={() => setSwitchOpen(false)}>
              收起
            </button>
          </div>
          <p className="muted small">按标题在其他同类站点搜索；选一个源切换，目录与进度会重新匹配。</p>
          <div className="source-list">
            {Object.entries(switchState).map(([siteId, st]) => {
              const target = sites.find((s) => s.id === siteId);
              if (!target) return null;
              if (st.status === 'ok' && st.target) {
                return (
                  <button
                    key={siteId}
                    className="source-item"
                    onClick={() => onSwitchSource(siteId, st.target!)}
                  >
                    <span className="source-main">
                      <span className="source-name">{target.name}</span>
                      <span className="source-title">{st.title}</span>
                    </span>
                    <span className="source-meta">切换</span>
                  </button>
                );
              }
              return (
                <div key={siteId} className="source-failed-item">
                  <span>{target.name}</span>
                  <span className="muted">
                    {st.status === 'pending'
                      ? '搜索中…'
                      : st.status === 'empty'
                        ? '没有同名作品'
                        : st.error ?? '失败'}
                  </span>
                </div>
              );
            })}
          </div>
          {switchLoading && (
            <div className="loading small">
              <span className="spinner" /> 正在其他站点搜索同名作品…
            </div>
          )}
        </section>
      )}

      {note && <div className="loading small">{note}</div>}

      {error && (
        <div className="error-box">
          <p>{error}</p>
          <button className="text-btn" onClick={() => setReloadKey((k) => k + 1)}>
            重试
          </button>
        </div>
      )}

      {detail && (
        <section className="book-hero">
          {detail.cover ? (
            <Cover src={detail.cover} title={detail.title} className="hero-cover" />
          ) : (
            <span className="hero-cover placeholder">{detail.title.slice(0, 1)}</span>
          )}
          <div className="hero-info">
            <h2>{detail.title}</h2>
            <p className="muted">
              {detail.author ?? '佚名'}
              {detail.status ? ` · ${detail.status}` : ''}
              {chapters && !chaptersLoading ? ` · 共 ${chapters.length} ${unit}` : ''}
            </p>
            {detail.intro && (
              <p className={'hero-intro' + (introOpen ? ' open' : '')} onClick={() => setIntroOpen((v) => !v)}>
                {detail.intro}
              </p>
            )}
            {site.id === 'qidian' && (
              <p className="muted small qidian-hint">
                部分章节需登录或订阅，可点右上角「换源」继续阅读。
              </p>
            )}
            <div className="hero-actions">
              {chapters && chapters.length > 0 && (
                <>
                  <button
                    className="primary-btn"
                    onClick={() => onRead(detail, chapters, progress ? progress.index : 0)}
                  >
                    {progress ? progressVerb : startVerb}
                  </button>
                  <button className="ghost-btn" onClick={() => onRead(detail, chapters, 0)}>
                    {site.kind === 'anime' ? '从第一集' : '从头开始'}
                  </button>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {chapters && chapters.length === 0 && (
        <div className="error-box">
          <p>
            {site.kind === 'comic'
              ? '暂时没有可看的章节，换一个来源试试。'
              : site.kind === 'anime'
                ? '暂时没有可播放的剧集，换一个来源试试。'
                : '暂时没有可读的章节，换一个来源试试。'}
          </p>
          <button className="text-btn" onClick={onBack}>
            返回换源
          </button>
        </div>
      )}

      {chapters && chapters.length > 0 && (
        <section className="section">
          <div className="chapter-head">
            <h2 className="section-title">目录</h2>
            <input
              className="search-input"
              placeholder="搜索章节"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setShown(PAGE);
              }}
            />
          </div>

          {filtered.length === 0 ? (
            <p className="empty">没有匹配的章节</p>
          ) : (
            <div className="chapter-grid">
              {visible.map((c) => {
                const idx = indexMap.get(c) ?? -1;
                return (
                  <button
                    key={c.url}
                    className={
                      'chapter-item' +
                      (progress?.index === idx ? ' current' : '') +
                      (c.locked ? ' locked' : '')
                    }
                    onClick={() => onRead(detail!, chapters, idx)}
                    title={c.locked ? '起点付费章节，建议换源阅读' : undefined}
                  >
                    {c.title}
                    {c.locked && <span className="chapter-vip">VIP</span>}
                  </button>
                );
              })}
            </div>
          )}

          {filtered.length > shown && (
            <button className="more-btn" onClick={() => setShown((n) => n + PAGE)}>
              显示更多（剩余 {filtered.length - shown}）
            </button>
          )}
        </section>
      )}
    </div>
  );
}
