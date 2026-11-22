import { useMemo } from 'react';
import { effectiveNsfw, loadPrefs } from '../store';
import { useSites } from '../sites';
import type { SettingsSection } from '../settingsTypes';

interface Props {
  onBack: () => void;
  onOpenNsfw: () => void;
  onOpenSection: (section: SettingsSection) => void;
}

interface RowProps {
  title: string;
  desc: string;
  value?: string;
  onClick: () => void;
}

function SettingLink({ title, desc, value, onClick }: RowProps) {
  return (
    <button className="settings-link" onClick={onClick}>
      <span className="settings-link-main">
        <span className="settings-link-title">{title}</span>
        <span className="muted small">{desc}</span>
      </span>
      <span className="settings-link-value">
        {value && <span className="muted small">{value}</span>}
        <span className="settings-chevron">›</span>
      </span>
    </button>
  );
}

export default function SettingsPage({ onBack, onOpenNsfw, onOpenSection }: Props) {
  const { allSites, settings, updateSettings } = useSites();
  const prefs = useMemo(() => loadPrefs(), [settings]);

  const markedCount = useMemo(
    () => allSites.filter((s) => effectiveNsfw(s, settings)).length,
    [allSites, settings],
  );
  const readerTheme =
    prefs.theme === 'night' ? '夜间' : prefs.theme === 'green' ? '护眼' : '纸白';

  return (
    <div className="page settings-page">
      <header className="page-head sticky">
        <div className="head-left">
          <button className="icon-btn" onClick={onBack} title="返回">
            ←
          </button>
          <div>
            <h1>设置</h1>
            <p className="muted">按你的习惯调整阅读体验</p>
          </div>
        </div>
      </header>

      <section className="settings-card">
        <div className="settings-row">
          <div className="settings-row-main">
            <h2>飞行模式</h2>
            <p className="muted">开启后显示全部内容；关闭时隐藏已标记的内容。</p>
          </div>
          <div className="settings-row-actions">
            <button
              type="button"
              className="icon-btn subtle settings-nsfw-entry"
              title="NSFW 标记"
              aria-label="NSFW 标记"
              onClick={onOpenNsfw}
            >
              ⋯
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={settings.flightMode}
              aria-label="飞行模式"
              data-setting="flight-mode"
              className={'switch' + (settings.flightMode ? ' on' : '')}
              onClick={() => updateSettings({ flightMode: !settings.flightMode })}
            >
              <span className="switch-knob" />
            </button>
          </div>
        </div>
        <p className={'settings-hidden-count' + (settings.flightMode ? ' active' : '')}>
          {settings.flightMode
            ? `飞行模式开启 · 显示全部内容（含 ${markedCount} 个标记源）`
            : `飞行模式关闭 · 隐藏 ${markedCount} 个标记源`}
        </p>
      </section>

      <section className="settings-card settings-links">
        <SettingLink
          title="内容源"
          desc="排序、首选与连接状态"
          onClick={() => onOpenSection('sources')}
        />
        <SettingLink
          title="阅读与播放"
          desc="字号、行距、主题、漫画适配、倍速与清晰度"
          value={`${prefs.size}px · ${readerTheme}`}
          onClick={() => onOpenSection('reader')}
        />
        <SettingLink
          title="外观"
          desc="深浅色、强调色、界面密度与动效"
          value={`${settings.appearance.theme === 'system' ? '跟随系统' : settings.appearance.theme === 'light' ? '浅色' : '深色'} · ${settings.appearance.density === 'cozy' ? '舒适' : '紧凑'}`}
          onClick={() => onOpenSection('appearance')}
        />
        <SettingLink
          title="启动与搜索"
          desc="起始页、恢复位置、开机启动、托盘、默认搜索分类"
          value={
            settings.startup.page === 'last'
              ? '恢复上次'
              : settings.startup.page === 'app'
                ? '指定应用'
                : '首页'
          }
          onClick={() => onOpenSection('startup')}
        />
        <SettingLink
          title="存储与隐私"
          desc="缓存占用、清理、无痕、封面模糊、导入导出"
          value={settings.privacy.incognito ? '无痕' : undefined}
          onClick={() => onOpenSection('storage')}
        />
        <SettingLink
          title="网络与缓存"
          desc="加载速度、缓存与图片"
          onClick={() => onOpenSection('network')}
        />
        <SettingLink
          title="关于"
          desc="版本与运行信息"
          onClick={() => onOpenSection('about')}
        />
      </section>
    </div>
  );
}
