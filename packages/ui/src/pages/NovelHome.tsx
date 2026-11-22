import { useEffect, useState } from 'react';
import type { BookRef, BookSection, SiteCtx } from '@agg/core';
import {
  QIDIAN_CATEGORIES,
  loadQidianCategory,
  loadQidianHome,
  loadQidianList,
  loadQidianRank,
} from '@agg/adapters';
import Cover from '../components/Cover';

interface Props {
  ctxFor: (siteId: string) => SiteCtx | null;
  onOpenBook: (siteId: string, url: string) => void;
}

type Tab = 'recommend' | 'category' | 'rank';

interface ListState {
  title: string;
  url: string;
  books: BookRef[];
  loading: boolean;
  error: string;
}

function BookGrid({
  books,
  onOpen,
}: {
  books: BookRef[];
  onOpen: (siteId: string, url: string) => void;
}) {
  return (
    <div className="book-grid">
      {books.map((b) => (
        <button
          key={b.url}
          className="book-card"
          onClick={() => onOpen('qidian', b.url)}
          title={b.intro || b.title}
        >
          <Cover src={b.cover} title={b.title} className="book-cover" />
          <span className="book-title">{b.title}</span>
          <span className="book-author">
            {[b.author, b.extra].filter(Boolean).join(' · ') || '起点中文网'}
          </span>
        </button>
      ))}
    </div>
  );
}

function Sections({
  sections,
  onOpen,
  onMore,
}: {
  sections: BookSection[];
  onOpen: (siteId: string, url: string) => void;
  onMore: (section: BookSection) => void;
}) {
  return (
    <>
      {sections.map((s) => (
        <section className="section" key={s.title}>
          <div className="home-section-head">
            <h2 className="section-title">
              {s.title}
              <span className="group-count">{s.books.length}</span>
            </h2>
            {s.moreUrl && (
              <button className="text-btn" onClick={() => onMore(s)}>
                更多
              </button>
            )}
          </div>
          <BookGrid books={s.books} onOpen={onOpen} />
        </section>
      ))}
    </>
  );
}

export default function NovelHome({ ctxFor, onOpenBook }: Props) {
  const [tab, setTab] = useState<Tab>('recommend');
  const [home, setHome] = useState<BookSection[]>([]);
  const [homeLoading, setHomeLoading] = useState(true);
  const [homeError, setHomeError] = useState('');

  const [rank, setRank] = useState<BookSection[]>([]);
  const [rankLoading, setRankLoading] = useState(false);
  const [rankLoaded, setRankLoaded] = useState(false);
  const [rankError, setRankError] = useState('');

  const [catId, setCatId] = useState<string>(QIDIAN_CATEGORIES[0].id);
  const [catSections, setCatSections] = useState<BookSection[]>([]);
  const [catLoading, setCatLoading] = useState(false);
  const [catError, setCatError] = useState('');

  const [reloadKey, setReloadKey] = useState(0);
  const [listView, setListView] = useState<ListState | null>(null);

  const openMore = (section: BookSection) => {
    if (!section.moreUrl) return;
    const ctx = ctxFor('qidian');
    const state: ListState = {
      title: section.title,
      url: section.moreUrl,
      books: [],
      loading: true,
      error: '',
    };
    setListView(state);
    if (!ctx) {
      setListView({ ...state, loading: false, error: '书源暂时不可用' });
      return;
    }
    loadQidianList(ctx, section.moreUrl)
      .then((books) => setListView((prev) => (prev ? { ...prev, books, loading: false } : prev)))
      .catch((e) =>
        setListView((prev) =>
          prev ? { ...prev, loading: false, error: e instanceof Error ? e.message : String(e) } : prev,
        ),
      );
  };

  useEffect(() => {
    const ctx = ctxFor('qidian');
    if (!ctx) {
      setHomeError('书源暂时不可用');
      setHomeLoading(false);
      return;
    }
    let alive = true;
    setHomeLoading(true);
    setHomeError('');
    loadQidianHome(ctx)
      .then((list) => {
        if (alive) setHome(list);
      })
      .catch((e) => {
        if (alive) setHomeError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setHomeLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ctxFor, reloadKey]);

  useEffect(() => {
    if (tab !== 'rank' || rankLoaded) return;
    const ctx = ctxFor('qidian');
    if (!ctx) {
      setRankError('书源暂时不可用');
      return;
    }
    let alive = true;
    setRankLoading(true);
    setRankError('');
    loadQidianRank(ctx)
      .then((list) => {
        if (!alive) return;
        setRank(list);
        setRankLoaded(true);
      })
      .catch((e) => {
        if (alive) setRankError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setRankLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [tab, rankLoaded, ctxFor, reloadKey]);

  const loadCategory = (id: string) => {
    const cat = QIDIAN_CATEGORIES.find((c) => c.id === id);
    if (!cat) return;
    setCatId(id);
    const ctx = ctxFor('qidian');
    if (!ctx) {
      setCatError('书源暂时不可用');
      return;
    }
    setCatLoading(true);
    setCatError('');
    loadQidianCategory(ctx, id, cat.name)
      .then(setCatSections)
      .catch((e) => setCatError(e instanceof Error ? e.message : String(e)))
      .finally(() => setCatLoading(false));
  };

  useEffect(() => {
    if (tab !== 'category' || catSections.length) return;
    loadCategory(catId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  if (listView) {
    return (
      <div className="novel-home novel-list-view">
        <div className="list-head">
          <button className="icon-btn" onClick={() => setListView(null)} title="返回">
            ←
          </button>
          <h2>{listView.title}</h2>
          <span className="muted small">{listView.books.length} 本</span>
        </div>
        {listView.loading && (
          <div className="loading">
            <span className="spinner" /> 正在读取更多…
          </div>
        )}
        {listView.error && (
          <div className="error-box">
            <p>加载失败：{listView.error}</p>
            <button
              className="text-btn"
              onClick={() => openMore({ title: listView.title, books: [], moreUrl: listView.url })}
            >
              重试
            </button>
          </div>
        )}
        {!listView.loading && !listView.error && (
          <BookGrid books={listView.books} onOpen={onOpenBook} />
        )}
      </div>
    );
  }

  return (
    <div className="novel-home">
      <p className="home-note">来自起点中文网，可在详情页切换更多书源。</p>

      <div className="home-tabs">
        <button className={'home-tab' + (tab === 'recommend' ? ' active' : '')} onClick={() => setTab('recommend')}>
          推荐
        </button>
        <button className={'home-tab' + (tab === 'category' ? ' active' : '')} onClick={() => setTab('category')}>
          分类
        </button>
        <button className={'home-tab' + (tab === 'rank' ? ' active' : '')} onClick={() => setTab('rank')}>
          排行
        </button>
      </div>

      {tab === 'recommend' && (
        <>
          {homeLoading && (
            <div className="loading">
              <span className="spinner" /> 正在加载推荐…
            </div>
          )}
          {homeError && (
            <div className="error-box">
              <p>推荐加载失败：{homeError}</p>
              <button className="text-btn" onClick={() => setReloadKey((k) => k + 1)}>
                重试
              </button>
            </div>
          )}
          {!homeLoading && !homeError && <Sections sections={home} onOpen={onOpenBook} onMore={openMore} />}
        </>
      )}

      {tab === 'category' && (
        <>
          <div className="category-chips">
            {QIDIAN_CATEGORIES.map((c) => (
              <button
                key={c.id}
                className={'home-tab category-tab' + (catId === c.id ? ' active' : '')}
                onClick={() => loadCategory(c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
          {catLoading && (
            <div className="loading">
              <span className="spinner" /> 正在读取分类…
            </div>
          )}
          {catError && (
            <div className="error-box">
              <p>分类加载失败：{catError}</p>
              <button className="text-btn" onClick={() => loadCategory(catId)}>
                重试
              </button>
            </div>
          )}
          {!catLoading && !catError && <Sections sections={catSections} onOpen={onOpenBook} onMore={openMore} />}
        </>
      )}

      {tab === 'rank' && (
        <>
          {rankLoading && (
            <div className="loading">
              <span className="spinner" /> 正在加载排行榜…
            </div>
          )}
          {rankError && (
            <div className="error-box">
              <p>排行榜加载失败：{rankError}</p>
              <button className="text-btn" onClick={() => setReloadKey((k) => k + 1)}>
                重试
              </button>
            </div>
          )}
          {!rankLoading && !rankError && <Sections sections={rank} onOpen={onOpenBook} onMore={openMore} />}
        </>
      )}
    </div>
  );
}

