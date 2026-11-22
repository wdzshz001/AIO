import { useState } from 'react';
import type { AppDef } from '@agg/core';
import { formatDuration, formatTime, type ShelfEntry } from '../store';
import { addSearchHistory, clearSearchHistory, loadSearchHistory } from '../searchHistory';
import Cover from '../components/Cover';

interface Props {
  apps: AppDef[];
  shelf: ShelfEntry[];
  blurCovers?: boolean;
  onOpenApp: (appId: string) => void;
  onOpenEntry: (entry: ShelfEntry) => void;
  onSearch: (query: string) => void;
}

function kindLabel(entry: ShelfEntry): string {
  return entry.subjectId || entry.kind === 'anime' ? '观看' : '阅读';
}

function progressOf(entry: ShelfEntry): { ratio: number; text: string } {
  if (entry.duration && entry.position) {
    const ratio = Math.min(1, entry.position / entry.duration);
    return {
      ratio,
      text: `${Math.round(ratio * 100)}% · ${formatDuration(entry.position)} / ${formatDuration(entry.duration)}`,
    };
  }
  if (entry.page != null) {
    const ratio = entry.pageCount ? Math.min(1, entry.page / entry.pageCount) : 0;
    return {
      ratio,
      text: `第 ${entry.page} 页${entry.pageCount ? ` / ${entry.pageCount}` : ''}`,
    };
  }
  if (entry.scroll != null) {
    return { ratio: Math.min(1, entry.scroll), text: `已读 ${Math.round(entry.scroll * 100)}%` };
  }
  return { ratio: 0, text: entry.chapter ? '刚刚开始' : '未开始' };
}

function chapterText(entry: ShelfEntry): string {
  const title = entry.chapter?.title;
  if (!title) return '未开始';
  if ((entry.subjectId || entry.kind === 'anime') && /^\d+$/.test(title)) {
    return `第 ${Number(title)} 集`;
  }
  return title;
}

export default function Launcher({ apps, shelf, blurCovers, onOpenApp, onOpenEntry, onSearch }: Props) {
  const [keyword, setKeyword] = useState('');
  const [history, setHistory] = useState<string[]>(() => loadSearchHistory());
  const [focused, setFocused] = useState(false);
  const latest = shelf[0];
  const latestProgress = latest ? progressOf(latest) : null;
  const recent = shelf.slice(1, 9);

  const submit = () => {
    const q = keyword.trim();
    if (!q) return;
    setHistory(addSearchHistory(q));
    setFocused(false);
    onSearch(q);
  };

  return (
    <div className="page launcher">
      <header className="home-header">
        <div className="home-brand">
          <span className="brand-orb">聚</span>
          <div>
            <h1>聚合阅读</h1>
            <p className="home-tagline">小说、动画、漫画，都在这里</p>
          </div>
        </div>
        <div className="launcher-search">
          <div className="search-shell">
            <input
              className="search-input-lg"
              value={keyword}
              placeholder="搜索小说、动画或漫画…"
              onChange={(e) => setKeyword(e.target.value)}
              onFocus={() => {
                setHistory(loadSearchHistory());
                setFocused(true);
              }}
              onBlur={() => window.setTimeout(() => setFocused(false), 140)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
            {focused && history.length > 0 && (
              <div className="search-history">
                <div className="search-history-head">
                  <span>搜索历史</span>
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      clearSearchHistory();
                      setHistory([]);
                    }}
                  >
                    清除
                  </button>
                </div>
                {history.map((item) => (
                  <button
                    key={item}
                    className="search-history-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setKeyword(item);
                      setHistory(addSearchHistory(item));
                      setFocused(false);
                      onSearch(item);
                    }}
                  >
                    <span>{item}</span>
                    <span className="search-history-arrow">↗</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="primary-btn" onClick={submit}>
            搜索
          </button>
        </div>
      </header>

      {latest ? (
        <button className="continue-hero" onClick={() => onOpenEntry(latest)}>
          <span
            className={'continue-backdrop' + (blurCovers ? ' blurred' : '')}
            style={latest.cover ? { backgroundImage: `url("${latest.cover}")` } : undefined}
          />
          <span className="continue-fade" />
          <Cover
            src={latest.cover}
            title={latest.title}
            className={'continue-cover' + (blurCovers ? ' blurred' : '')}
          />
          <span className="continue-copy">
            <span className="continue-kicker">继续{kindLabel(latest)}</span>
            <span className="continue-title">{latest.title}</span>
            <span className="continue-chapter">
              {chapterText(latest)}
            </span>
            <span className="continue-progress">
              <span style={{ width: `${Math.max(3, latestProgress!.ratio * 100)}%` }} />
            </span>
            <span className="continue-meta">
              {latestProgress!.text}
              <span className="continue-dot">·</span>
              {formatTime(latest.at)}
            </span>
          </span>
          <span className="continue-cta">继续 →</span>
        </button>
      ) : (
        <div className="continue-empty">
          <span className="continue-empty-icon">◐</span>
          <div>
            <strong>还没有阅读记录</strong>
            <p>从下面选一个应用，找一部想看的作品。</p>
          </div>
        </div>
      )}

      <section className="section home-apps">
        <div className="home-section-head">
          <h2 className="section-title">开始探索</h2>
        </div>
        <div className="app-grid">
          {apps.map((a) => (
            <button key={a.id} className="app-card" onClick={() => onOpenApp(a.id)}>
              <span className="app-icon" style={{ background: a.color }}>
                {a.icon}
              </span>
              <span className="app-meta">
                <span className="app-name">{a.name}</span>
                <span className="app-kind">{a.desc}</span>
              </span>
              <span className="app-arrow">›</span>
            </button>
          ))}
        </div>
      </section>

      {recent.length > 0 && (
        <section className="section recent-section">
          <div className="home-section-head">
            <h2 className="section-title">最近</h2>
          </div>
          <div className="recent-strip">
            {recent.map((item) => {
              const p = progressOf(item);
              return (
                <button
                  key={item.subjectId ? `bgm:${item.subjectId}` : item.url}
                  className="recent-card"
                  onClick={() => onOpenEntry(item)}
                >
                  <Cover
                    src={item.cover}
                    title={item.title}
                    className={'recent-cover' + (blurCovers ? ' blurred' : '')}
                  />
                  <span className="recent-title">{item.title}</span>
                  <span className="recent-chapter">{chapterText(item)}</span>
                  <span className="recent-bar">
                    <span style={{ width: `${Math.max(3, p.ratio * 100)}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
