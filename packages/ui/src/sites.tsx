import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Site } from '@agg/core';
import { configureRuntime } from '@agg/core';
import { loadSubscription, sites as staticSites } from '@agg/adapters';
import { bridge } from './bridge';
import {
  DEFAULT_SETTINGS,
  filterSites,
  loadSettings,
  saveSettings,
  type AppSettings,
} from './store';

interface SiteState {
  /** 应用实际使用的源（已按启用/NSFW/排序过滤） */
  sites: Site[];
  /** 设置页使用：包含被隐藏的源 */
  allSites: Site[];
  settings: AppSettings;
  loading: boolean;
  error?: string;
  /** 订阅最近一次成功加载的时间 */
  subscriptionUpdatedAt?: number;
  reload: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  setSourceNsfw: (siteId: string, value: boolean) => void;
}

const Ctx = createContext<SiteState>({
  sites: staticSites,
  allSites: staticSites,
  settings: DEFAULT_SETTINGS,
  loading: false,
  reload: () => undefined,
  updateSettings: () => undefined,
  setSourceNsfw: () => undefined,
});

export function SitesProvider({ children }: { children: ReactNode }) {
  const [subSites, setSubSites] = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [nonce, setNonce] = useState(0);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [subscriptionUpdatedAt, setSubscriptionUpdatedAt] = useState<number>();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadSubscription(bridge)
      .then((list) => {
        if (!alive) return;
        setSubSites(list);
        setSubscriptionUpdatedAt(Date.now());
        setError(undefined);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [nonce]);

  useEffect(() => {
    configureRuntime({
      htmlTtlMs: settings.network.htmlTtlMin * 60_000,
      searchConcurrency: settings.network.concurrency,
      imagePreload: settings.network.imagePreload,
    });
    bridge.setNetworkConfig?.({ timeoutMs: settings.network.timeoutMs }).catch(() => undefined);
  }, [settings.network]);

  const allSites = useMemo(() => {
    const seen = new Set(staticSites.map((s) => s.baseUrl));
    return [...staticSites, ...subSites.filter((s) => !seen.has(s.baseUrl))];
  }, [subSites]);

  const sites = useMemo(() => filterSites(allSites, settings), [allSites, settings]);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next: AppSettings = {
        ...prev,
        ...patch,
        appearance: { ...prev.appearance, ...(patch.appearance ?? {}) },
        startup: { ...prev.startup, ...(patch.startup ?? {}) },
        network: { ...prev.network, ...(patch.network ?? {}) },
        privacy: { ...prev.privacy, ...(patch.privacy ?? {}) },
        playback: { ...prev.playback, ...(patch.playback ?? {}) },
      };
      saveSettings(next);
      return next;
    });
  }, []);

  const setSourceNsfw = useCallback((siteId: string, value: boolean) => {
    setSettings((prev) => {
      const next = {
        ...prev,
        sourceNsfw: { ...prev.sourceNsfw, [siteId]: value },
      };
      saveSettings(next);
      return next;
    });
  }, []);

  return (
    <Ctx.Provider
      value={{
        sites,
        allSites,
        settings,
        loading,
        error,
        subscriptionUpdatedAt,
        reload: () => setNonce((n) => n + 1),
        updateSettings,
        setSourceNsfw,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useSites(): SiteState {
  return useContext(Ctx);
}
