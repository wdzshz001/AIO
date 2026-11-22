import { useMemo, useState } from 'react';
import { effectiveNsfw } from '../store';
import { sourceGroups } from '../sourceGroups';
import { useSites } from '../sites';

interface Props {
  onBack: () => void;
}

export default function NsfwSourcesPage({ onBack }: Props) {
  const { allSites, settings, setSourceNsfw } = useSites();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => sourceGroups(allSites), [allSites]);

  const q = query.trim().toLowerCase();
  const visibleGroups = groups
    .map((g) => ({
      ...g,
      sites: q ? g.sites.filter((s) => s.name.toLowerCase().includes(q)) : g.sites,
    }))
    .filter((g) => g.sites.length > 0);

  return (
    <div className="page settings-page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <div>
            <h1>NSFW 标记</h1>
            <p className="muted">标记为 NSFW 的源，在飞行模式关闭时隐藏。</p>
          </div>
        </div>
      </header>

      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h2>源列表</h2>
            <p className="muted">打开开关表示该源属于 NSFW；关闭飞行模式后将不参与应用与搜索。</p>
          </div>
          <input
            className="search-input"
            value={query}
            placeholder="搜索源"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {visibleGroups.length === 0 && <p className="empty">没有匹配的源。</p>}

        {visibleGroups.map((group) => (
          <div className="settings-source-group" key={group.app.id}>
            <h3 className="settings-group-title">
              {group.app.name}
              <span className="group-count">{group.sites.length}</span>
            </h3>
            <div className="settings-source-list">
              {group.sites.map((site) => {
                const marked = effectiveNsfw(site, settings);
                const hidden = !settings.flightMode && marked;
                return (
                  <div
                    className={'settings-source-row' + (marked ? ' marked' : '') + (hidden ? ' hidden' : '')}
                    key={site.id}
                  >
                    <span className="settings-source-name">{site.name}</span>
                    <span className={'nsfw-badge' + (marked ? ' on' : '')}>
                      {marked ? 'NSFW' : '普通'}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={marked}
                      aria-label={`${site.name} NSFW 标记`}
                      data-source={site.id}
                      className={'switch small' + (marked ? ' on' : '')}
                      onClick={() => setSourceNsfw(site.id, !marked)}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
