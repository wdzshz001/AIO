import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agg', {
  fetchHtml: (siteId: string, url: string, referer?: string) =>
    ipcRenderer.invoke('agg:fetch', siteId, url, referer),
  request: (siteId: string, url: string, opts?: unknown) =>
    ipcRenderer.invoke('agg:request', siteId, url, opts),
  renderHtml: (siteId: string, url: string, opts?: unknown) =>
    ipcRenderer.invoke('agg:render', siteId, url, opts),
  harvestLinks: (siteId: string, url: string, selector: string, limit?: number) =>
    ipcRenderer.invoke('agg:harvest', siteId, url, selector, limit),
  captureMedia: (siteId: string, url: string, opts?: unknown) =>
    ipcRenderer.invoke('agg:capture', siteId, url, opts),
  verifySite: (siteId: string, url: string) => ipcRenderer.invoke('agg:verify', siteId, url),
  submitForm: (
    siteId: string,
    pageUrl: string,
    actionUrl: string,
    fields: Record<string, string>,
    opts?: unknown,
  ) => ipcRenderer.invoke('agg:submit', siteId, pageUrl, actionUrl, fields, opts),
  openWindow: (siteId: string, url: string) => ipcRenderer.invoke('agg:open', siteId, url),
  openExternal: (url: string) => ipcRenderer.invoke('agg:external', url),
  clearSiteData: (siteId: string) => ipcRenderer.invoke('agg:clear-site', siteId),
  appInfo: () => ipcRenderer.invoke('agg:app-info'),
  openDataDir: () => ipcRenderer.invoke('agg:open-data'),
  setLoginItem: (enabled: boolean) => ipcRenderer.invoke('agg:login-item', enabled),
  setTray: (enabled: boolean) => ipcRenderer.invoke('agg:tray', enabled),
  proxyInfo: () => ipcRenderer.invoke('agg:proxy'),
  setNetworkConfig: (opts: { timeoutMs: number }) => ipcRenderer.invoke('agg:network', opts),
  platform: process.platform,
});
