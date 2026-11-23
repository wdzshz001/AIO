import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BangumiEpisode, BangumiSubject, SourceCandidate, SourceLookup } from '@agg/adapters';
import {
  episodeLabel,
  findEpisodeSources,
  loadBangumiSubject,
  rankLookups,
} from '@agg/adapters';
import type { Site, SiteCtx } from '@agg/core';
import { normalizeTitle } from '@agg/core';
import Cover from '../components/Cover';
import { bridge } from '../bridge';
import type { ShelfEntry } from '../store';

interface Props {
  subjectId: number;
  sites: Site[];
  ctxFor: (siteId: string) => SiteCtx | null;
  shelf: ShelfEntry[];
  onBack: () => void;
  onPlay: (candidate: SourceCandidate, episode: BangumiEpisode, subject: BangumiSubject) => void;
  /** 从播放页返回时自动打开该集的选源面板 */
  autoEpisodeSort?: string;
  /** 设置里的动画首选源；有就优先等它，超时后仍用最先返回的源 */
  defaultPreferredSource?: string;
}

function episodeCode(ep: BangumiEpisode): string {
  return episodeLabel(ep);
}

function episodeName(ep: BangumiEpisode): string {
  return ep.nameCn || ep.name || '';
}

const PREF_KEY = 'agg.preferredSource.v1';

function loadPreferredSources(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

function savePreferredSource(subjectId: number, siteId: string): void {
  try {
    const map = loadPreferredSources();
    map[String(subjectId)] = siteId;
    localStorage.setItem(PREF_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

export default function SubjectPage({
  subjectId,
  sites,
  ctxFor,
  shelf,
  onBack,
  onPlay,
  autoEpisodeSort,
  defaultPreferredSource,
}: Props) {
  const [subject, setSubject] = useState<BangumiSubject | null>(null);
  const [episodes, setEpisodes] = useState<BangumiEpisode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [introOpen, setIntroOpen] = useState(false);
  const [epFilter, setEpFilter] = useState('');
  const [epShown, setEpShown] = useState(120);

  const [pickerEpisode, setPickerEpisode] = useState<BangumiEpisode | null>(null);
  const [lookups, setLookups] = useState<Record<string, SourceLookup>>({});
  const [pickerError, setPickerError] = useState('');
  const [pickerRunning, setPickerRunning] = useState(false);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [preferred, setPreferred] = useState<Record<string, string>>(() => loadPreferredSources());
  const playSeq = useRef(0);

  const animeSites = useMemo(
    () => sites.filter((s) => s.kind === 'anime' && !!s.search && !!s.detail),
    [sites],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setSubject(null);
    setEpisodes([]);
    setEpFilter('');
    setEpShown(120);
    (async () => {
      try {
        const data = await loadBangumiSubject(bridge, subjectId);
        if (!alive) return;
        setSubject(data.subject);
        let eps = data.episodes;
        if (!eps.length && (data.subject.eps ?? data.subject.totalEpisodes ?? 0) >= 1) {
          eps = [
            {
              id: 0,
              sort: 1,
              ep: 1,
              name: data.subject.name,
              nameCn: data.subject.nameCn,
            },
          ];
        }
        setEpisodes(eps);
        if (!data.subject.name) throw new Error('没有找到这个作品');
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [subjectId, reloadKey]);

  /** 该条目的观看历史：同一个 Bangumi 条目只保留一条（按 subjectId 归并） */
  const history = useMemo(() => {
    return shelf
      .filter((e) => e.subjectId === subjectId)
      .sort((a, b) => b.at - a.at);
  }, [shelf, subjectId]);

  const watched = useMemo(() => {
    const set = new Set<string>();
    for (const h of history) {
      // 动画只有真正播放过（有播放位置）才算看过；打开选集页不算
      if (h.kind === 'anime' && h.position == null) continue;
      const s = h.chapter?.sort;
      if (s) set.add(s);
    }
    return set;
  }, [history]);

  const latest = history[0];
  const latestEpisode = useMemo(() => {
    if (!latest?.chapter) return null;
    const bySort = episodes.find(
      (ep) =>
        episodeCode(ep) === latest.chapter!.sort ||
        normalizeTitle(episodeName(ep)) === normalizeTitle(latest.chapter!.title),
    );
    if (bySort) return bySort;
    return null;
  }, [episodes, latest]);

  const nextEpisode = useMemo(() => {
    if (latestEpisode) {
      const idx = episodes.indexOf(latestEpisode);
      return episodes[idx + 1] ?? latestEpisode;
    }
    return episodes.find((ep) => !watched.has(episodeCode(ep))) ?? episodes[0] ?? null;
  }, [episodes, latestEpisode, watched]);

  const openPicker = useCallback(
    async (episode: BangumiEpisode, force = false) => {
      if (!subject) return;
      setPickerEpisode(episode);
      setPickerError('');
      setPickerRunning(true);
      const initial: Record<string, SourceLookup> = {};
      for (const s of animeSites) {
        initial[s.id] = { siteId: s.id, siteName: s.name, status: 'pending' };
      }
      setLookups(initial);
      try {
        const result = await findEpisodeSources(
          ctxFor,
          animeSites,
          subject,
          episode,
          (lookup) => setLookups((prev) => ({ ...prev, [lookup.siteId]: lookup })),
        );
        setLookups(Object.fromEntries(result.map((l) => [l.siteId, l])));
      } catch (e) {
        setPickerError(e instanceof Error ? e.message : String(e));
      } finally {
        setPickerRunning(false);
      }
      if (force) setVerified((v) => ({ ...v, [episode.id]: true }));
    },
    [animeSites, ctxFor, subject],
  );

  /**
   * 选集后自动匹配并进入播放页：不等所有源都返回。
   * - 没有首选源：第一个 ok 的源直接播
   * - 有首选源：最多等 900ms 首选源，超时就用最先返回的可用源
   */
  const playEpisode = useCallback(
    async (episode: BangumiEpisode) => {
      if (!subject) return;
      const seq = ++playSeq.current;
      setPickerEpisode(episode);
      setPickerError('');
      setPickerRunning(true);
      const initial: Record<string, SourceLookup> = {};
      for (const s of animeSites) {
        initial[s.id] = { siteId: s.id, siteName: s.name, status: 'pending' };
      }
      setLookups(initial);

      const preferredSite = defaultPreferredSource || preferred[String(subject.id)] || '';
      // 分批请求：首选源和当前排序靠前的源先查，避免一次性请求全部源
      const lookupSites = preferredSite
        ? [...animeSites].sort((a, b) => (a.id === preferredSite ? -1 : 0) - (b.id === preferredSite ? -1 : 0))
        : animeSites;
      let settled = false;
      let stopped = false;
      let firstCandidate: SourceCandidate | null = null;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      let resolvePick!: (candidate: SourceCandidate | null) => void;
      const picked = new Promise<SourceCandidate | null>((resolve) => {
        resolvePick = resolve;
      });

      const finish = (candidate: SourceCandidate | null) => {
        if (settled) return;
        settled = true;
        stopped = true;
        clearTimeout(graceTimer);
        resolvePick(candidate);
      };

      const consider = (lookup: SourceLookup) => {
        if (settled || seq !== playSeq.current || !lookup.candidate) return;
        if (!preferredSite || lookup.siteId === preferredSite) {
          finish(lookup.candidate);
          return;
        }
        // 非首选源先返回：再给首选源 900ms，等不到就直接用这个
        if (!firstCandidate) {
          firstCandidate = lookup.candidate;
          graceTimer = setTimeout(() => finish(firstCandidate), 900);
        }
      };

      const task = findEpisodeSources(
        ctxFor,
        lookupSites,
        subject,
        episode,
        (lookup) => {
          if (settled || seq !== playSeq.current) return;
          setLookups((prev) => ({ ...prev, [lookup.siteId]: lookup }));
          consider(lookup);
        },
        // 每批最多 6 个；Android WebView 解析详情页更慢，给更宽松的单源超时
        {
          shouldStop: () => stopped,
          concurrency: 6,
          timeoutMs:
            (globalThis as { agg?: { platform?: string } }).agg?.platform === 'android'
              ? 18_000
              : 12_000,
        },
      );

      void task
        .then((result) => {
          if (settled || seq !== playSeq.current) return;
          const rank = rankLookups(result, animeSites);
          const byPreferred = preferredSite
            ? rank.find((l) => l.siteId === preferredSite)?.candidate
            : undefined;
          finish(firstCandidate ?? byPreferred ?? rank[0]?.candidate ?? null);
        })
        .catch((e: unknown) => {
          if (settled || seq !== playSeq.current) return;
          setPickerError(e instanceof Error ? e.message : String(e));
          finish(firstCandidate);
        });

      const candidate = await picked;
      if (seq !== playSeq.current) return;
      if (!candidate) {
        setPickerRunning(false);
        return;
      }
      savePreferredSource(subject.id, candidate.siteId);
      setPreferred(loadPreferredSources());
      setPickerEpisode(null);
      setLookups({});
      setPickerRunning(false);
      setPickerError('');
      onPlay(candidate, episode, subject);
    },
    [animeSites, ctxFor, defaultPreferredSource, onPlay, preferred, subject],
  );

  /** 从播放页返回时自动打开当前集的选源面板 */
  useEffect(() => {
    if (!autoEpisodeSort || !subject || !episodes.length) return;
    const ep = episodes.find((e) => episodeCode(e) === autoEpisodeSort);
    if (ep) void openPicker(ep);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEpisodeSort, subject, episodes]);

  const closePicker = () => {
    setPickerEpisode(null);
    setLookups({});
    setPickerRunning(false);
    setPickerError('');
  };

  const verify = async (siteId: string) => {
    const site = animeSites.find((s) => s.id === siteId);
    const ctx = ctxFor(siteId);
    if (!site || !ctx) return;
    setVerified((v) => ({ ...v, [siteId]: true }));
    try {
      // 验证要开在搜索域（订阅源的 baseUrl 可能是详情域）
      await ctx.verify(site.referer || site.baseUrl);
    } catch {
      /* 用户可能取消了验证 */
    }
  };

  const ranked = useMemo(() => {
    const list = rankLookups(Object.values(lookups), animeSites);
    const pid = defaultPreferredSource || preferred[String(subjectId)];
    if (!pid) return list;
    // 上次为该条目选的源排第一（对齐 ani 的选源偏好记忆）
    return [...list].sort((a, b) => (a.siteId === pid ? -1 : 0) - (b.siteId === pid ? -1 : 0));
  }, [lookups, animeSites, preferred, subjectId, defaultPreferredSource]);
  const pending = useMemo(
    () => Object.values(lookups).filter((l) => l.status === 'pending'),
    [lookups],
  );
  const failed = useMemo(
    () => Object.values(lookups).filter((l) => l.status !== 'ok' && l.status !== 'pending'),
    [lookups],
  );

  const filteredEpisodes = useMemo(() => {
    const q = epFilter.trim().toLowerCase();
    if (!q) return episodes;
    return episodes.filter(
      (ep) => episodeCode(ep).includes(q) || episodeName(ep).toLowerCase().includes(q),
    );
  }, [episodes, epFilter]);
  const visibleEpisodes = filteredEpisodes.slice(0, epShown);

  if (loading) {
    return (
      <div className="page">
        <header className="page-head">
          <div className="head-left">
            <button className="icon-btn" onClick={onBack} title="返回">
              ←
            </button>
            <h1>条目</h1>
          </div>
        </header>
        <div className="loading">
          <span className="spinner" />
          正在加载动画详情…
        </div>
      </div>
    );
  }

  if (error || !subject) {
    return (
      <div className="page">
        <header className="page-head">
          <div className="head-left">
            <button className="icon-btn" onClick={onBack} title="返回">
              ←
            </button>
            <h1>条目</h1>
          </div>
        </header>
        <div className="error-box">
          <p>{error || '没有找到这个作品'}</p>
          <button className="text-btn" onClick={() => setReloadKey((k) => k + 1)}>
            重试
          </button>
        </div>
      </div>
    );
  }

  const title = subject.nameCn || subject.name;
  const subtitle = subject.nameCn && subject.name !== subject.nameCn ? subject.name : '';

  return (
    <div className="page subject-page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <div className="head-title-wrap">
            <h1>{title}</h1>
            <p className="muted">共 {episodes.length} 集</p>
          </div>
        </div>
        <button className="icon-btn" onClick={() => setReloadKey((k) => k + 1)} title="刷新">
          ↻
        </button>
      </header>

      <section className="book-hero subject-hero">
        <Cover src={subject.cover} title={title} className="hero-cover" />
        <div className="hero-info">
          <h2>{title}</h2>
          {subtitle && <p className="muted subject-original">{subtitle}</p>}
          <p className="muted">
            {[subject.date, subject.score ? `${subject.score} 分` : '', subject.eps ? `${subject.eps} 集` : '']
              .filter(Boolean)
              .join(' · ')}
          </p>
          {subject.tags.length > 0 && (
            <div className="subject-tags">
              {subject.tags.slice(0, 8).map((t) => (
                <span className="tag" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}
          {subject.summary && (
            <p
              className={'hero-intro' + (introOpen ? ' open' : '')}
              onClick={() => setIntroOpen((v) => !v)}
            >
              {subject.summary}
            </p>
          )}
          <div className="hero-actions">
            {nextEpisode && (
              <button className="primary-btn" onClick={() => void playEpisode(nextEpisode)}>
                {latestEpisode ? `继续观看 · 第${episodeCode(nextEpisode)}集` : '开始观看'}
              </button>
            )}
            <button
              className="ghost-btn"
              onClick={() => void openPicker(episodes[0])}
              disabled={!episodes.length}
            >
              从头选择来源
            </button>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="chapter-head">
          <h2 className="section-title">
            剧集
            <span className="group-count">{episodes.length}</span>
          </h2>
          {episodes.length > 40 && (
            <input
              className="search-input"
              placeholder="搜索集号/标题"
              value={epFilter}
              onChange={(e) => {
                setEpFilter(e.target.value);
                setEpShown(120);
              }}
            />
          )}
        </div>
        {episodes.length === 0 ? (
          <p className="empty">暂时没有收录剧集信息，换个作品试试。</p>
        ) : (
          <>
            <div className="episode-grid">
              {visibleEpisodes.map((ep) => {
                const code = episodeCode(ep);
                const seen = watched.has(code);
                const name = episodeName(ep);
                return (
                  <button
                    key={`${ep.id}:${code}`}
                    className={'episode-item' + (seen ? ' seen' : '') + (latestEpisode === ep ? ' current' : '')}
                    onClick={() => void playEpisode(ep)}
                    title={name ? `第${code}集 ${name}` : `第${code}集`}
                  >
                    <span className="episode-num">{code}</span>
                    {name && <span className="episode-name">{name}</span>}
                    {seen && <span className="episode-seen">✓</span>}
                  </button>
                );
              })}
            </div>
            {filteredEpisodes.length === 0 && <p className="empty">没有匹配的剧集</p>}
            {filteredEpisodes.length > epShown && (
              <button className="more-btn" onClick={() => setEpShown((n) => n + 200)}>
                显示更多（剩余 {filteredEpisodes.length - epShown}）
              </button>
            )}
          </>
        )}
      </section>

      {pickerEpisode && (
        <div className="modal-mask" onClick={closePicker}>
          <div className="modal source-modal" onClick={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <div>
                <h2>
                  第{pickerEpisode ? episodeCode(pickerEpisode) : ''}集
                  {pickerEpisode && episodeName(pickerEpisode)
                    ? ` · ${episodeName(pickerEpisode)}`
                    : ''}
                </h2>
                <p className="muted">
                  正在寻找可用线路…
                </p>
              </div>
              <button className="icon-btn" onClick={closePicker} title="关闭">
                ×
              </button>
            </header>

            {pickerError && <div className="error-box small">{pickerError}</div>}

            {ranked.length > 0 && (
              <div className="source-list">
                {ranked.map((lookup) => {
                  const c = lookup.candidate!;
                  return (
                    <button
                      key={lookup.siteId}
                      className="source-item"
                      onClick={() => {
                        savePreferredSource(subject.id, c.siteId);
                        setPreferred(loadPreferredSources());
                        closePicker();
                        onPlay(c, pickerEpisode!, subject);
                      }}
                    >
                      <span className="source-main">
                        <span className="source-name">{c.siteName}</span>
                        {c.channel && <span className="source-channel">{c.channel}</span>}
                        <span className="source-title">{c.title}</span>
                      </span>
                      <span className="source-meta">
                        {c.sort ? `第${c.sort}集` : c.chapters[c.index]?.title}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {pending.length > 0 && (
              <div className="source-pending">
                <span className="spinner" />
                正在查找更多线路…
              </div>
            )}

            {!pickerRunning && ranked.length === 0 && (
              <p className="empty">暂时没有可用线路，可以换一集或稍后重试。</p>
            )}

            {failed.length > 0 && (
              <details className="source-failed">
                <summary>部分来源没有结果</summary>
                <div className="source-failed-list">
                  {failed.map((f) => (
                    <div key={f.siteId} className="source-failed-item">
                      <span>{f.siteName}</span>
                      <span className="muted">{f.error ?? (f.status === 'empty' ? '没有匹配到条目/剧集' : '')}</span>
                      {f.status === 'error' && (
                        <button
                          className="chip small"
                          disabled={verified[f.siteId]}
                          onClick={() => void verify(f.siteId)}
                        >
                          重试
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button className="text-btn" onClick={() => void openPicker(pickerEpisode!, true)}>
                  重新匹配
                </button>
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
