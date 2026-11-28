import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppDef, Site, SiteCtx } from '@agg/core';
import {
  DEFAULT_CHANNEL_TARGETS,
  appOfSite,
  getBangumiSeason,
  getBangumiTrending,
  loadRankChannels,
  loadRecommendChannels,
  sitesOfApp,
  type BangumiSubject,
  type SiteChannel,
} from '@agg/adapters';
import Cover from '../components/Cover';
import { displayText } from '../chinese';
import { bridge } from '../bridge';
import { loadViewState, saveViewState } from '../viewState';

interface Props {
  sites: Site[];
  ctxFor: (siteId: string) => SiteCtx | null;
  onOpenBook: (siteId: string, url: string) => void;
  onOpenSubject: (subjectId: number) => void;
  onOpenChannels: (appId: string) => void;
  onBack: () => void;
}

function ChannelBook({ book, siteId, onOpen }: {
  book: { url: string; title: string; author?: string; cover?: string; extra?: string };
  siteId: string;
  onOpen: (siteId: string, url: string) => void;
}) {
  return (
    <button className="book-card channel-book" onClick={() => onOpen(siteId, book.url)} title={displayText(book.title)}>
      <Cover src={book.cover} title={displayText(book.title)} className="book-cover" />
      <span className="book-title">{displayText(book.title)}</span>
      <span className="book-author">{displayText(book.author || book.extra) || ' '}</span>
    </button>
  );
}

function SubjectCard({ subject, onOpen }: { subject: BangumiSubject; onOpen: (id: number) => void }) {
  return (
    <button className="book-card channel-book" onClick={() => onOpen(subject.id)}>
      <Cover src={subject.cover} title={displayText(subject.nameCn || subject.name)} className="book-cover" />
      <span className="book-title">{displayText(subject.nameCn || subject.name)}</span>
      <span className="book-author">{subject.score ? `${subject.score.toFixed(1)} 分` : '动画'}</span>
    </button>
  );
}

export default function DiscoverPage({
  sites,
  ctxFor,
  onOpenBook,
  onOpenSubject,
  onOpenChannels,
  onBack,
}: Props) {
  const [channels, setChannels] = useState<SiteChannel[]>([]);
  const [trending, setTrending] = useState<BangumiSubject[]>([]);
  const [season, setSeason] = useState<BangumiSubject[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const mainScrollRef = useRef(0);

  // 从书籍/阅读页返回时恢复发现页滚动位置
  useEffect(() => {
    const main = document.querySelector('.main');
    if (!main) return;
    const key = 'agg.scroll.discover';
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
  }, []);

  const targets = useMemo(() => {
    const list = [...DEFAULT_CHANNEL_TARGETS];
    const covered = new Set(list.map((t) => t.siteId));
    for (const site of sites) {
      if ((site.kind === 'novel' || site.kind === 'comic') && site.home && !covered.has(site.id)) {
        list.push({ siteId: site.id, mode: 'recommend', limit: 1 });
      }
    }
    return list;
  }, [sites]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErrors([]);
    setChannels([]);
    const jobs = targets.map(async (target) => {
      const site = sites.find((s) => s.id === target.siteId);
      if (!site) return [];
      const ctx = ctxFor(site.id);
      if (!ctx) throw new Error(`${site.name} 未就绪`);
      const list =
        target.mode === 'rank'
          ? await loadRankChannels(site, ctx)
          : await loadRecommendChannels(site, ctx);
      return list.slice(0, target.limit);
    });
    let pending = jobs.length;
    jobs.forEach((job) => {
      job
        .then((list) => {
          if (!alive || !list.length) return;
          // 每个频道独立到达就立即展示，不等待慢源（如 Cloudflare 校验）
          setChannels((prev) => {
            const seen = new Set(prev.map((c) => c.id));
            return [...prev, ...list.filter((c) => !seen.has(c.id))];
          });
        })
        .catch((e) => {
          if (!alive) return;
          const message = e instanceof Error ? e.message : String(e);
          setErrors((prev) => (prev.includes(message) ? prev : [...prev, message].slice(0, 2)));
        })
        .finally(() => {
          pending -= 1;
          if (alive && pending === 0) setLoading(false);
        });
    });
    if (!jobs.length) setLoading(false);
    Promise.allSettled([getBangumiTrending(bridge, 12), getBangumiSeason(bridge, 12)]).then(([t, s]) => {
      if (!alive) return;
      if (t.status === 'fulfilled') setTrending(t.value);
      if (s.status === 'fulfilled') setSeason(s.value);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targets, sites, ctxFor, reload]);

  const groups = useMemo(() => {
    const map = new Map<string, { app: AppDef; site: Site; channels: SiteChannel[] }>();
    for (const ch of channels) {
      const site = sites.find((s) => s.id === ch.siteId);
      const app = site ? appOfSite(site.id, sites) : undefined;
      if (!site || !app) continue;
      const entry = map.get(app.id + site.id) ?? { app, site, channels: [] };
      entry.channels.push(ch);
      map.set(app.id + site.id, entry);
    }
    return [...map.values()];
  }, [channels, sites]);

  return (
    <div className="page discover-page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <div>
            <h1>发现</h1>
            <p className="muted">按源站频道浏览推荐、排行与分类</p>
          </div>
        </div>
        <button className="icon-btn" onClick={() => setReload((n) => n + 1)} title="刷新频道">
          ↻
        </button>
      </header>

      {errors.length > 0 && (
        <p className="source-status">部分频道暂时不可用：{errors.join(' / ')}</p>
      )}
      {loading && channels.length === 0 && trending.length === 0 && season.length === 0 && (
        <div className="loading">
          <span className="spinner" /> 正在加载源站频道…
        </div>
      )}

      {(trending.length > 0 || season.length > 0) && (
        <section className="discover-source-group">
          <div className="discover-source-head">
            <h2>动画 · Bangumi</h2>
            <button className="text-btn" onClick={() => onOpenChannels('anime')}>
              频道浏览 →
            </button>
          </div>
          {trending.length > 0 && (
            <div className="discover-channel">
              <div className="discover-channel-head">
                <h3>热度榜</h3>
                <span>源站频道</span>
              </div>
              <div className="channel-scroll">
                {trending.slice(0, 12).map((s) => (
                  <SubjectCard key={s.id} subject={s} onOpen={onOpenSubject} />
                ))}
              </div>
            </div>
          )}
          {season.length > 0 && (
            <div className="discover-channel">
              <div className="discover-channel-head">
                <h3>本季推荐</h3>
                <span>源站频道</span>
              </div>
              <div className="channel-scroll">
                {season.slice(0, 12).map((s) => (
                  <SubjectCard key={s.id} subject={s} onOpen={onOpenSubject} />
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {groups.map((group) => (
        <section className="discover-source-group" key={group.app.id + group.site.id}>
          <div className="discover-source-head">
            <div>
              <h2>{group.site.name}</h2>
              <p className="muted small">{group.app.name} · 源站频道</p>
            </div>
            <button className="text-btn" onClick={() => onOpenChannels(group.app.id)}>
              频道浏览 →
            </button>
          </div>
          {group.channels.map((ch) => (
            <div className="discover-channel" key={ch.id}>
              <div className="discover-channel-head">
                <h3>{displayText(ch.title)}</h3>
                <span>{ch.books.length} 本</span>
              </div>
              <div className="channel-scroll">
                {ch.books.slice(0, 12).map((b) => (
                  <ChannelBook key={b.url} book={b} siteId={ch.siteId} onOpen={onOpenBook} />
                ))}
              </div>
            </div>
          ))}
        </section>
      ))}

      {!loading && groups.length === 0 && (
        <p className="empty">暂时没有可展示的源站频道。</p>
      )}
    </div>
  );
}
