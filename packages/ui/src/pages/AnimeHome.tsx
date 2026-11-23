import { useEffect, useMemo, useState } from 'react';
import type { BangumiCalendarItem, BangumiSubject } from '@agg/adapters';
import {
  currentAnimeSeason,
  getBangumiCalendar,
  getBangumiSeason,
  getBangumiTrending,
} from '@agg/adapters';
import Cover from '../components/Cover';
import { bridge } from '../bridge';
import { loadViewState, saveViewState } from '../viewState';

interface Props {
  onOpenSubject: (subjectId: number) => void;
}

const WEEKDAYS = [
  { id: 1, name: '周一' },
  { id: 2, name: '周二' },
  { id: 3, name: '周三' },
  { id: 4, name: '周四' },
  { id: 5, name: '周五' },
  { id: 6, name: '周六' },
  { id: 7, name: '周日' },
];

/** 热度/推荐/放送表三种数据共用的卡片字段 */
interface HomeSubject {
  id: number;
  name: string;
  nameCn?: string;
  cover?: string;
  date?: string;
  score?: number;
}

function seasonLabel(): string {
  const [start] = currentAnimeSeason();
  const [y, m] = start.split('-').map(Number);
  return `${y} 年 ${m} 月新番`;
}

function SubjectGrid({
  list,
  onOpenSubject,
  showScore,
}: {
  list: HomeSubject[];
  onOpenSubject: (id: number) => void;
  showScore?: boolean;
}) {
  return (
    <div className="book-grid">
      {list.map((s) => (
        <button
          key={s.id}
          className="book-card"
          onClick={() => onOpenSubject(s.id)}
          title="查看详情"
        >
          <div className="card-cover-wrap">
            <Cover src={s.cover} title={s.nameCn || s.name} className="book-cover" />
            {showScore && s.score ? <span className="score-badge">{s.score.toFixed(1)}</span> : null}
          </div>
          <span className="book-title">{s.nameCn || s.name}</span>
          <span className="book-author">
            {[s.date?.slice(0, 7), s.score ? `${s.score} 分` : ''].filter(Boolean).join(' · ') || '动画'}
          </span>
        </button>
      ))}
    </div>
  );
}

export default function AnimeHome({ onOpenSubject }: Props) {
  const [trending, setTrending] = useState<BangumiSubject[]>([]);
  const [season, setSeason] = useState<BangumiSubject[]>([]);
  const [calendar, setCalendar] = useState<BangumiCalendarItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [day, setDay] = useState(() => {
    const dow = new Date().getDay();
    const today = dow === 0 ? 7 : dow;
    const saved = loadViewState('agg.anime.day.v1', today);
    return saved >= 1 && saved <= 7 ? saved : today;
  });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    saveViewState('agg.anime.day.v1', day);
  }, [day]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErrors([]);
    Promise.allSettled([
      getBangumiTrending(bridge, 18),
      getBangumiSeason(bridge, 18),
      getBangumiCalendar(bridge),
    ]).then(([t, s, c]) => {
      if (!alive) return;
      const nextErrors: string[] = [];
      if (t.status === 'fulfilled') setTrending(t.value);
      else nextErrors.push('热度榜');
      if (s.status === 'fulfilled') setSeason(s.value);
      else nextErrors.push('本季推荐');
      if (c.status === 'fulfilled') setCalendar(c.value);
      else nextErrors.push('新番时间表');
      setErrors(nextErrors);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  const today = useMemo(() => {
    const dow = new Date().getDay();
    return dow === 0 ? 7 : dow;
  }, []);

  const dayItems = useMemo(
    () => calendar.filter((c) => (c.airWeekday ?? 0) === day),
    [calendar, day],
  );

  if (loading) {
    return (
      <div className="loading">
        <span className="spinner" />
        正在为你准备动画内容…
      </div>
    );
  }

  if (errors.length === 3) {
    return (
      <div className="error-box">
        <p>内容暂时加载失败，请检查网络后重试。</p>
        <button className="text-btn" onClick={() => setReloadKey((k) => k + 1)}>
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="anime-home">
      {errors.length > 0 && (
        <div className="source-status">
          {errors.join(' / ')} 暂时不可用
          <button className="text-btn" onClick={() => setReloadKey((k) => k + 1)}>
            重试
          </button>
        </div>
      )}

      <section className="section">
        <div className="home-section-head">
          <h2 className="section-title">
            热度榜
            <span className="group-count">{trending.length}</span>
          </h2>
          <span className="muted small">全站热度</span>
        </div>
        {trending.length ? (
          <SubjectGrid list={trending} onOpenSubject={onOpenSubject} showScore />
        ) : (
          <p className="empty">暂时没有热度数据。</p>
        )}
      </section>

      <section className="section">
        <div className="home-section-head">
          <h2 className="section-title">
            本季推荐
            <span className="group-count">{season.length}</span>
          </h2>
          <span className="muted small">{seasonLabel()}</span>
        </div>
        {season.length ? (
          <SubjectGrid list={season} onOpenSubject={onOpenSubject} showScore />
        ) : (
          <p className="empty">本季还没有可推荐的条目。</p>
        )}
      </section>

      <section className="section">
        <div className="home-section-head">
          <h2 className="section-title">
            新番时间表
            <span className="group-count">{dayItems.length}</span>
          </h2>
          <span className="muted small">每周更新</span>
        </div>

        <div className="home-tabs weekday-tabs">
          {WEEKDAYS.map((w) => (
            <button
              key={w.id}
              className={'home-tab' + (day === w.id ? ' active' : '')}
              onClick={() => setDay(w.id)}
            >
              {w.name}
              {w.id === today ? <span className="tab-dot">今天</span> : null}
            </button>
          ))}
        </div>

        {dayItems.length ? (
          <SubjectGrid list={dayItems} onOpenSubject={onOpenSubject} />
        ) : (
          <p className="empty">这一天没有放送条目。</p>
        )}
      </section>
    </div>
  );
}
