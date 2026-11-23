import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Site, SiteCtx } from '@agg/core';
import { apps } from '@agg/adapters';
import { bridge, platform } from '../bridge';
import {
  clearChapterCaches,
  clearShelf,
  effectiveNsfw,
  exportBackup,
  importBackup,
  loadPrefs,
  savePrefs,
  sourceEnabled,
  storageUsage,
  type ReaderPrefs,
} from '../store';
import { sourceGroups } from '../sourceGroups';
import { contentCacheStats, clearContentCache } from '../contentCache';
import type { SettingsSection } from '../settingsTypes';
import { useSites } from '../sites';

type CtxFor = (siteId: string) => SiteCtx | null;

interface SectionProps {
  onBack: () => void;
  ctxFor: CtxFor;
}

function Shell({
  title,
  desc,
  onBack,
  children,
}: {
  title: string;
  desc: string;
  onBack: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="page settings-page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <div>
            <h1>{title}</h1>
            <p className="muted">{desc}</p>
          </div>
        </div>
      </header>
      {children}
    </div>
  );
}

function Card({ title, desc, children }: { title?: string; desc?: string; children: React.ReactNode }) {
  return (
    <section className="settings-card">
      {title && (
        <div className="settings-section-head">
          <h2>{title}</h2>
          {desc && <p className="muted">{desc}</p>}
        </div>
      )}
      {children}
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={'switch' + (checked ? ' on' : '')}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-knob" />
    </button>
  );
}

function Field({
  label,
  desc,
  children,
}: {
  label: string;
  desc?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field-main">
        <span>{label}</span>
        {desc && <span className="muted small">{desc}</span>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button
          key={o.value}
          className={'seg-btn' + (value === o.value ? ' active' : '')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Range({
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="range-wrap">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="range-value">
        {value}
        {suffix}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 源管理                                                              */
/* ------------------------------------------------------------------ */

type Health = {
  state: 'idle' | 'checking' | 'ok' | 'fail';
  ms?: number;
  note?: string;
  error?: string;
};

function probeUrl(site: Site): string {
  try {
    const url = new URL(site.baseUrl);
    url.searchParams.set('agg_probe', String(Date.now()));
    return url.toString();
  } catch {
    return site.baseUrl;
  }
}

function SourceManager({ onBack, ctxFor }: SectionProps) {
  const { allSites, settings, updateSettings } = useSites();
  const [health, setHealth] = useState<Record<string, Health>>({});
  const groups = useMemo(() => sourceGroups(allSites), [allSites]);

  const ordered = (sites: Site[]) =>
    sites.slice().sort((a, b) => {
      const pa = settings.preferredSource[a.kind] === a.id ? 0 : 1;
      const pb = settings.preferredSource[b.kind] === b.id ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (settings.sourceRank[a.id] ?? 1e6) - (settings.sourceRank[b.id] ?? 1e6);
    });

  const setEnabled = (id: string, value: boolean) => {
    updateSettings({ sourceEnabled: { ...settings.sourceEnabled, [id]: value } });
  };

  const move = (groupSites: Site[], id: string, dir: -1 | 1) => {
    const list = ordered(groupSites);
    const i = list.findIndex((s) => s.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const ranks = { ...settings.sourceRank };
    list.forEach((s, idx) => {
      ranks[s.id] = idx;
    });
    updateSettings({ sourceRank: ranks });
  };

  const check = useCallback(
    async (site: Site) => {
      const ctx = ctxFor(site.id);
      setHealth((prev) => ({ ...prev, [site.id]: { state: 'checking' } }));
      if (!ctx) {
        setHealth((prev) => ({ ...prev, [site.id]: { state: 'fail', error: '站点未就绪' } }));
        return;
      }
      const t = Date.now();
      try {
        let note = '';
        if (site.kind === 'anime' && site.search) {
          // 订阅源的 home() 是空实现，必须走真实搜索接口
          const list = await site.search(ctx, 'agg-probe');
          note = `搜索可达${list.length ? ` · ${list.length} 条` : ''}`;
        } else {
          // 小说/漫画：先请求带防缓存参数的首页，验证的是网络可达而不是解析结果
          try {
            await ctx.html(probeUrl(site));
            note = '首页可达';
          } catch (homeError) {
            if (site.home) {
              await site.home(ctx);
              note = '首页解析可达';
            } else if (site.search) {
              await site.search(ctx, 'agg-probe');
              note = '搜索可达';
            } else {
              throw homeError;
            }
          }
        }
        setHealth((prev) => ({
          ...prev,
          [site.id]: { state: 'ok', ms: Date.now() - t, note },
        }));
      } catch (e) {
        setHealth((prev) => ({
          ...prev,
          [site.id]: {
            state: 'fail',
            ms: Date.now() - t,
            error: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [ctxFor],
  );

  const checkAll = async () => {
    const list = allSites.filter((s) => sourceEnabled(s, settings));
    let cursor = 0;
    const worker = async () => {
      while (cursor < list.length) await check(list[cursor++]);
    };
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
  };

  const clearCookies = async () => {
    for (const site of allSites) await bridge.clearSiteData?.(site.id).catch(() => undefined);
  };

  return (
    <Shell
      title="内容源"
      desc="启用、排序、首选与连接状态"
      onBack={onBack}
    >
      <div className="settings-inline-actions">
        <button className="primary-btn" onClick={checkAll}>
          检测全部
        </button>
        <button className="ghost-btn" onClick={clearCookies}>
          清空全部 Cookie
        </button>
      </div>

      {groups.map((group) => {
        const kind = group.sites[0]?.kind;
        const pref = kind ? settings.preferredSource[kind] : undefined;
        const list = ordered(group.sites);
        return (
          <Card
            key={group.app.id}
            title={group.app.name}
            desc={`${group.sites.length} 个源${kind ? ' · 可设置首选源' : ''}`}
          >
            {kind && (
              <Field label="首选源" desc="搜索/自动选源时优先展示；自动选源最多等它 900ms">
                <select
                  className="select"
                  value={pref ?? ''}
                  onChange={(e) =>
                    updateSettings({
                      preferredSource: {
                        ...settings.preferredSource,
                        [kind]: e.target.value || undefined,
                      },
                    })
                  }
                >
                  <option value="">不指定</option>
                  {group.sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <div className="source-manage-list">
              {list.map((site, idx) => {
                const enabled = sourceEnabled(site, settings);
                const h = health[site.id];
                return (
                  <div className={'source-manage-row' + (enabled ? '' : ' disabled')} key={site.id}>
                    <div className="source-manage-main">
                      <span className="source-manage-name">{site.name}</span>
                      <div className="source-manage-meta">
                        {settings.preferredSource[site.kind] === site.id && (
                          <span className="mini-badge">首选</span>
                        )}
                        {effectiveNsfw(site, settings) && <span className="mini-badge nsfw">NSFW</span>}
                        {h?.state === 'checking' && <span className="mini-badge">检测中…</span>}
                        {h?.state === 'ok' && (
                          <span className="mini-badge ok" title={h.note}>
                            {h.ms}ms
                          </span>
                        )}
                        {h?.state === 'fail' && (
                          <span className="mini-badge fail" title={h.error}>
                            失败
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="source-manage-actions">
                      <button
                        className="icon-btn tiny"
                        disabled={idx === 0}
                        onClick={() => move(group.sites, site.id, -1)}
                        title="上移"
                      >
                        ↑
                      </button>
                      <button
                        className="icon-btn tiny"
                        disabled={idx === list.length - 1}
                        onClick={() => move(group.sites, site.id, 1)}
                        title="下移"
                      >
                        ↓
                      </button>
                      <button className="text-btn" onClick={() => check(site)}>
                        检测
                      </button>
                      <button
                        className="text-btn"
                        onClick={() =>
                          ctxFor(site.id)?.verify(site.referer || site.baseUrl).catch(() => undefined)
                        }
                      >
                        验证
                      </button>
                      <button
                        className="text-btn"
                        onClick={() => bridge.clearSiteData?.(site.id).catch(() => undefined)}
                      >
                        清 Cookie
                      </button>
                      <Toggle
                        checked={enabled}
                        onChange={(v) => setEnabled(site.id, v)}
                        label={`${site.name} 启用`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 阅读与播放                                                          */
/* ------------------------------------------------------------------ */

function ReaderSettings({ onBack }: SectionProps) {
  const { allSites, settings, updateSettings } = useSites();
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs());
  const animeSources = useMemo(
    () => allSites.filter((s) => s.kind === 'anime' && !!s.search && !!s.detail),
    [allSites],
  );

  const patchPrefs = (patch: Partial<ReaderPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(next);
      return next;
    });
  };

  return (
    <Shell title="阅读与播放" desc="小说、漫画与动画的默认偏好" onBack={onBack}>
      <Card title="小说阅读" desc="阅读器里仍可临时调整字号">
        <Field label="字号">
          <Range value={prefs.size} min={14} max={28} step={1} suffix="px" onChange={(v) => patchPrefs({ size: v })} />
        </Field>
        <Field label="行距">
          <Range value={prefs.lineHeight} min={1.4} max={2.6} step={0.1} onChange={(v) => patchPrefs({ lineHeight: v })} />
        </Field>
        <Field label="段间距">
          <Range value={prefs.paragraphGap} min={8} max={36} step={1} suffix="px" onChange={(v) => patchPrefs({ paragraphGap: v })} />
        </Field>
        <Field label="正文宽度">
          <Range value={prefs.pageWidth} min={560} max={1000} step={20} suffix="px" onChange={(v) => patchPrefs({ pageWidth: v })} />
        </Field>
        <Field label="阅读主题">
          <Segmented
            value={prefs.theme}
            onChange={(v) => patchPrefs({ theme: v })}
            options={[
              { value: 'paper', label: '纸白' },
              { value: 'night', label: '夜间' },
              { value: 'green', label: '护眼' },
            ]}
          />
        </Field>
      </Card>

      <Card title="漫画">
        <Field label="图片适配" desc="宽度铺满适合条漫；完整显示适合单页">
          <Segmented
            value={prefs.comicFit}
            onChange={(v) => patchPrefs({ comicFit: v })}
            options={[
              { value: 'width', label: '铺满宽度' },
              { value: 'contain', label: '完整显示' },
            ]}
          />
        </Field>
      </Card>

      <Card title="动画播放">
        <Field label="默认优先源" desc="自动选源时优先等它；最多等 900ms，超时改用最先返回的可用源">
          <select
            className="select"
            value={settings.preferredSource.anime ?? ''}
            onChange={(e) =>
              updateSettings({
                preferredSource: {
                  ...settings.preferredSource,
                  anime: e.target.value || undefined,
                },
              })
            }
          >
            <option value="">自动（谁先返回用谁）</option>
            {animeSources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="自动连播" desc="播完自动下一集">
          <Toggle
            checked={prefs.autoNext}
            onChange={(v) => patchPrefs({ autoNext: v })}
            label="自动连播"
          />
        </Field>
        <Field label="默认倍速">
          <Segmented
            value={String(settings.playback.rate)}
            onChange={(v) => updateSettings({ playback: { ...settings.playback, rate: Number(v) } })}
            options={[
              { value: '1', label: '1x' },
              { value: '1.25', label: '1.25x' },
              { value: '1.5', label: '1.5x' },
              { value: '2', label: '2x' },
            ]}
          />
        </Field>
        <Field label="默认静音">
          <Toggle
            checked={settings.playback.muted}
            onChange={(v) => updateSettings({ playback: { ...settings.playback, muted: v } })}
            label="默认静音"
          />
        </Field>
        <Field label="默认清晰度" desc="HLS 有多档时自动选择接近的档位">
          <Segmented
            value={settings.playback.quality}
            onChange={(v) => updateSettings({ playback: { ...settings.playback, quality: v } })}
            options={[
              { value: 'auto', label: '自动' },
              { value: '1080', label: '1080P' },
              { value: '720', label: '720P' },
            ]}
          />
        </Field>
      </Card>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 外观                                                                */
/* ------------------------------------------------------------------ */

function AppearanceSettings({ onBack }: SectionProps) {
  const { settings, updateSettings } = useSites();
  const a = settings.appearance;
  const accents = ['#4f8cff', '#e0567a', '#3fbf8f', '#e0a13c', '#9a7bff'];

  return (
    <Shell title="外观" desc="主题、强调色、密度与动效" onBack={onBack}>
      <Card title="主题">
        <Field label="颜色模式">
          <Segmented
            value={a.theme}
            onChange={(v) => updateSettings({ appearance: { ...a, theme: v } })}
            options={[
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' },
            ]}
          />
        </Field>
        <Field label="强调色">
          <div className="swatches">
            {accents.map((c) => (
              <button
                key={c}
                className={'swatch' + (a.accent === c ? ' active' : '')}
                style={{ background: c }}
                onClick={() => updateSettings({ appearance: { ...a, accent: c } })}
                aria-label={`强调色 ${c}`}
              />
            ))}
          </div>
        </Field>
      </Card>

      <Card title="布局">
        <Field label="界面密度">
          <Segmented
            value={a.density}
            onChange={(v) => updateSettings({ appearance: { ...a, density: v } })}
            options={[
              { value: 'compact', label: '紧凑' },
              { value: 'cozy', label: '舒适' },
            ]}
          />
        </Field>
        <Field label="减少动画" desc="关闭过渡与加载动画">
          <Toggle
            checked={a.reduceMotion}
            onChange={(v) => updateSettings({ appearance: { ...a, reduceMotion: v } })}
            label="减少动画"
          />
        </Field>
      </Card>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 启动与搜索                                                          */
/* ------------------------------------------------------------------ */

function StartupSettings({ onBack }: SectionProps) {
  const { settings, updateSettings } = useSites();
  const st = settings.startup;

  return (
    <Shell title="启动与搜索" desc="起始页、系统行为与默认搜索分类" onBack={onBack}>
      <Card title="启动">
        <Field label="启动页面">
          <Segmented
            value={st.page}
            onChange={(v) => updateSettings({ startup: { ...st, page: v } })}
            options={[
              { value: 'home', label: '首页' },
              { value: 'last', label: '上次页面' },
              { value: 'app', label: '指定应用' },
            ]}
          />
        </Field>
        {st.page === 'app' && (
          <Field label="启动应用">
            <select
              className="select"
              value={st.appId}
              onChange={(e) => updateSettings({ startup: { ...st, appId: e.target.value } })}
            >
              {apps.map((app) => (
                <option key={app.id} value={app.id}>
                  {app.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="开机启动" desc="使用系统登录项启动">
          <Toggle
            checked={st.launchAtLogin}
            onChange={(v) => {
              updateSettings({ startup: { ...st, launchAtLogin: v } });
              bridge.setLoginItem?.(v).catch(() => undefined);
            }}
            label="开机启动"
          />
        </Field>
        <Field label="最小化到托盘" desc="关闭窗口时隐藏到系统托盘">
          <Toggle
            checked={st.tray}
            onChange={(v) => {
              updateSettings({ startup: { ...st, tray: v } });
              bridge.setTray?.(v).catch(() => undefined);
            }}
            label="最小化到托盘"
          />
        </Field>
      </Card>

      <Card title="搜索">
        <Field label="默认搜索分类" desc="首页/启动器搜索打开时默认选中的分类">
          <select
            className="select"
            value={settings.searchCategory}
            onChange={(e) =>
              updateSettings({
                searchCategory: e.target.value as typeof settings.searchCategory,
              })
            }
          >
            <option value="all">全部</option>
            <option value="novel">小说</option>
            <option value="anime">动画</option>
            <option value="comic">漫画</option>
          </select>
        </Field>
      </Card>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 存储与隐私                                                          */
/* ------------------------------------------------------------------ */

function StorageSettings({ onBack }: SectionProps) {
  const { allSites, settings, updateSettings } = useSites();
  const [stats, setStats] = useState(() => storageUsage());
  const [contentStats, setContentStats] = useState({ count: 0, bytes: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const refresh = () => {
    setStats(storageUsage());
    void contentCacheStats().then(setContentStats);
  };
  useEffect(() => {
    void contentCacheStats().then(setContentStats);
  }, []);
  const total = stats.reduce((n, x) => n + x.bytes, 0);

  const clearChapters = () => {
    clearChapterCaches();
    refresh();
  };
  const clearContent = async () => {
    await clearContentCache();
    refresh();
  };
  const clearHistory = () => {
    clearShelf();
    refresh();
    window.location.reload();
  };
  const clearCookies = async () => {
    for (const site of allSites) await bridge.clearSiteData?.(site.id).catch(() => undefined);
  };
  const resetAll = () => {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('agg.')) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    void clearContentCache();
    window.location.reload();
  };
  const exportFile = () => {
    const blob = new Blob([exportBackup()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `agg-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const doImport = async (file: File) => {
    const ok = importBackup(await file.text());
    if (ok) window.location.reload();
    else window.alert('导入失败：不是有效的备份文件');
  };

  return (
    <Shell title="存储与隐私" desc="缓存、历史、无痕与数据备份" onBack={onBack}>
      <Card title="占用" desc={`共 ${(total / 1024).toFixed(1)} KB`}>
        <div className="storage-list">
          {stats.length === 0 && <p className="muted small">暂无本地数据。</p>}
          {stats.map((s) => (
            <div className="storage-row" key={s.key}>
              <span className="storage-key">{s.key}</span>
              <span className="muted small">{(s.bytes / 1024).toFixed(1)} KB</span>
            </div>
          ))}
        </div>
        <div className="settings-inline-actions">
          <button className="ghost-btn" onClick={refresh}>
            刷新
          </button>
          <button className="ghost-btn" onClick={clearChapters}>
            清理章节缓存
          </button>
          <button className="ghost-btn" onClick={() => void clearContent()}>
            清理内容缓存
          </button>
          <button className="ghost-btn" onClick={clearHistory}>
            清空最近记录
          </button>
          <button className="ghost-btn" onClick={clearCookies}>
            清空站点 Cookie
          </button>
        </div>
        <p className="muted small">
          内容缓存：{contentStats.count} 条 · {(contentStats.bytes / 1024).toFixed(1)} KB
          （小说正文/漫画章节，12 小时有效；图片由系统/原生缓存）
        </p>
      </Card>

      <Card title="隐私">
        <Field label="无痕模式" desc="不写入最近记录/书架">
          <Toggle
            checked={settings.privacy.incognito}
            onChange={(v) => updateSettings({ privacy: { ...settings.privacy, incognito: v } })}
            label="无痕模式"
          />
        </Field>
        <Field label="模糊最近封面" desc="首页最近记录封面打码">
          <Toggle
            checked={settings.privacy.blurCovers}
            onChange={(v) => updateSettings({ privacy: { ...settings.privacy, blurCovers: v } })}
            label="模糊最近封面"
          />
        </Field>
      </Card>

      <Card title="备份与重置">
        <div className="settings-inline-actions">
          <button className="ghost-btn" onClick={exportFile}>
            导出设置与书架
          </button>
          <button className="ghost-btn" onClick={() => fileRef.current?.click()}>
            导入备份
          </button>
          <button className="danger-btn" onClick={resetAll}>
            恢复默认
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) doImport(f).catch(() => undefined);
            e.target.value = '';
          }}
        />
      </Card>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 高级网络                                                            */
/* ------------------------------------------------------------------ */

function NetworkSettings({ onBack }: SectionProps) {
  const { settings, updateSettings } = useSites();
  const n = settings.network;
  const [proxy, setProxy] = useState('检测中…');

  const loadProxy = useCallback(() => {
    bridge
      .proxyInfo?.()
      .then((p) => setProxy(p || 'DIRECT'))
      .catch(() => setProxy('不可用'));
  }, []);

  useEffect(() => {
    loadProxy();
  }, [loadProxy]);

  return (
    <Shell title="网络与缓存" desc="加载速度、缓存与图片" onBack={onBack}>
      <Card title="请求">
        <Field label="搜索并发" desc="同时查询多少个动画源">
          <Range
            value={n.concurrency}
            min={1}
            max={12}
            step={1}
            onChange={(v) => updateSettings({ network: { ...n, concurrency: v } })}
          />
        </Field>
        <Field label="请求超时" desc="单次静态请求的超时时间">
          <Range
            value={Math.round(n.timeoutMs / 1000)}
            min={5}
            max={90}
            step={5}
            suffix="s"
            onChange={(v) => updateSettings({ network: { ...n, timeoutMs: v * 1000 } })}
          />
        </Field>
        <Field label="HTML 缓存" desc="0 表示每次重新抓取">
          <Range
            value={n.htmlTtlMin}
            min={0}
            max={120}
            step={5}
            suffix="min"
            onChange={(v) => updateSettings({ network: { ...n, htmlTtlMin: v } })}
          />
        </Field>
        <Field label="图片预加载" desc="漫画优先加载前几张">
          <Toggle
            checked={n.imagePreload}
            onChange={(v) => updateSettings({ network: { ...n, imagePreload: v } })}
            label="图片预加载"
          />
        </Field>
      </Card>

      <Card title="网络出口">
        <Field label="系统代理" desc="Electron 跟随系统代理设置">
          <span className="mono small">{proxy}</span>
        </Field>
        <div className="settings-inline-actions">
          <button className="ghost-btn" onClick={loadProxy}>
            重新检测
          </button>
        </div>
      </Card>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 关于                                                                */
/* ------------------------------------------------------------------ */

function AboutSettings({ onBack }: SectionProps) {
  const { allSites, sites, settings, subscriptionUpdatedAt, error } = useSites();
  const [info, setInfo] = useState<{ version?: string; hotVersion?: string; electron?: string; chrome?: string; platform?: string }>({});
  const [copied, setCopied] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [hotBusy, setHotBusy] = useState(false);

  const checkUpdate = async () => {
    setHotBusy(true);
    setUpdateMsg('正在检查更新…');
    try {
      if (bridge.appUpdateCheck) {
        const info = await bridge.appUpdateCheck();
        if (!info.available) {
          setUpdateMsg(info.error ? `检查失败：${info.error}` : '已是最新版本');
          return;
        }
        setUpdateMsg(`发现 ${info.version}，正在下载安装包…`);
        if (!bridge.appUpdateInstall || !info.url) {
          setUpdateMsg('当前构建不支持应用更新');
          return;
        }
        const result = await bridge.appUpdateInstall(info.url);
        setUpdateMsg(
          result.ok
            ? `已开始下载 ${info.version}，完成后会自动打开安装器`
            : `更新失败：${result.error ?? '未知错误'}`,
        );
        return;
      }
      if (!bridge.hotCheck) {
        setUpdateMsg('当前构建不支持热更新');
        return;
      }
      const info = await bridge.hotCheck();
      if (!info.available) {
        setUpdateMsg(info.error ? `检查失败：${info.error}` : '已是最新版本');
        return;
      }
      setUpdateMsg(`发现 ${info.version}，正在下载…`);
      if (!bridge.hotApply) {
        setUpdateMsg('当前构建不支持应用更新');
        return;
      }
      const result = await bridge.hotApply(info.version!);
      setUpdateMsg(
        result.ok
          ? `已更新到 ${info.version}，界面即将刷新…`
          : `更新失败：${result.error ?? '未知错误'}`,
      );
    } catch (e) {
      setUpdateMsg(`更新失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setHotBusy(false);
    }
  };

  useEffect(() => {
    bridge.appInfo?.().then(setInfo).catch(() => undefined);
  }, []);

  const counts = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of allSites) map[s.kind] = (map[s.kind] || 0) + 1;
    return map;
  }, [allSites]);

  const diagnostics = [
    `聚合阅读 ${info.version ?? 'dev'}`,
    `Electron ${info.electron ?? '?'} / Chrome ${info.chrome ?? '?'}`,
    `平台 ${info.platform ?? platform}`,
    `源 ${allSites.length} 个，当前可用 ${sites.length} 个`,
    `小说 ${counts.novel ?? 0} / 动画 ${counts.anime ?? 0} / 漫画 ${counts.comic ?? 0}`,
    `订阅更新 ${subscriptionUpdatedAt ? new Date(subscriptionUpdatedAt).toLocaleString() : '未加载'}`,
    `飞行模式 ${settings.flightMode ? '开' : '关'}`,
    `并发 ${settings.network.concurrency} / 超时 ${settings.network.timeoutMs}ms`,
    `订阅错误 ${error ?? '无'}`,
  ].join('\n');

  return (
    <Shell title="关于" desc="版本与运行信息" onBack={onBack}>
      <Card title="应用">
        <Field label="版本">
          <span className="mono small">
            {info.hotVersion && info.hotVersion !== info.version
              ? info.hotVersion
              : (info.version ?? 'dev')}
            {info.hotVersion && info.hotVersion !== info.version
              ? `（壳 ${info.version ?? 'dev'}）`
              : ''}
          </span>
        </Field>
        <Field label="运行环境">
          <span className="mono small">
            Electron {info.electron ?? '?'} · {info.platform ?? platform}
          </span>
        </Field>
        <div className="settings-inline-actions">
          <button className="ghost-btn" disabled={hotBusy} onClick={() => void checkUpdate()}>
            {hotBusy ? '检查中…' : '检查更新'}
          </button>
        </div>
        {updateMsg && <p className="muted small">{updateMsg}</p>}
      </Card>

      <details className="settings-details">
        <summary>运行信息</summary>
        <pre className="diagnostics">{diagnostics}</pre>
        <div className="settings-inline-actions">
          <button
            className="ghost-btn"
            onClick={() => {
              navigator.clipboard
                .writeText(diagnostics)
                .then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => undefined);
            }}
          >
            {copied ? '已复制' : '复制运行信息'}
          </button>
          <button className="ghost-btn" onClick={() => bridge.openDataDir?.().catch(() => undefined)}>
            打开数据目录
          </button>
        </div>
      </details>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */

export default function SettingsSectionPage({
  section,
  onBack,
  ctxFor,
}: {
  section: SettingsSection;
  onBack: () => void;
  ctxFor: CtxFor;
}) {
  const props = { onBack, ctxFor };
  switch (section) {
    case 'sources':
      return <SourceManager {...props} />;
    case 'reader':
      return <ReaderSettings {...props} />;
    case 'appearance':
      return <AppearanceSettings {...props} />;
    case 'startup':
      return <StartupSettings {...props} />;
    case 'storage':
      return <StorageSettings {...props} />;
    case 'network':
      return <NetworkSettings {...props} />;
    case 'about':
      return <AboutSettings {...props} />;
    default:
      return <SettingsPageFallback onBack={onBack} />;
  }
}

function SettingsPageFallback({ onBack }: { onBack: () => void }) {
  return (
    <Shell title="设置" desc="未知设置页" onBack={onBack}>
      <p className="empty">没有这个设置项。</p>
    </Shell>
  );
}
