/**
 * Android WebView 注入桥：把 window.agg 适配成 NativeAgg 的异步调用。
 * 必须在 renderer.js 之前加载。
 */
(function () {
  'use strict';

  const pending = new Map();
  let seq = 0;

  window.__aggResolve = function (id, json) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    try {
      p.resolve(JSON.parse(json));
    } catch (e) {
      p.reject(e);
    }
  };

  window.__aggReject = function (id, message) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p.reject(new Error(message || 'Android bridge error'));
  };

  function call(method, args) {
    return new Promise(function (resolve, reject) {
      if (!window.NativeAgg) {
        reject(new Error('Android bridge unavailable'));
        return;
      }
      const id = 'c' + ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.NativeAgg.invoke(method, JSON.stringify(args || []), id);
      } catch (e) {
        pending.delete(id);
        reject(e);
      }
    });
  }

  function syncProxy(url, referer, ua, cookies) {
    if (!window.NativeAgg || !url) return url || '';
    try {
      return window.NativeAgg.proxyUrl(url, referer || '', ua || '', cookies || '') || url;
    } catch (e) {
      return url;
    }
  }

  window.agg = {
    platform: 'android',
    fetchHtml: function (siteId, url, referer) {
      return call('fetchHtml', [siteId, url, referer]);
    },
    request: function (siteId, url, opts) {
      return call('request', [siteId, url, opts]);
    },
    renderHtml: function (siteId, url, opts) {
      return call('renderHtml', [siteId, url, opts]);
    },
    harvestLinks: function (siteId, url, selector, limit) {
      return call('harvestLinks', [siteId, url, selector, limit]);
    },
    captureMedia: function (siteId, url, opts) {
      return call('captureMedia', [siteId, url, opts]);
    },
    verifySite: function (siteId, url) {
      return call('verifySite', [siteId, url]);
    },
    submitForm: function (siteId, pageUrl, actionUrl, fields, opts) {
      return call('submitForm', [siteId, pageUrl, actionUrl, fields, opts]);
    },
    openWindow: function (siteId, url) {
      return call('openWindow', [siteId, url]);
    },
    openExternal: function (url) {
      return call('openExternal', [url]);
    },
    clearSiteData: function (siteId) {
      return call('clearSiteData', [siteId]);
    },
    appInfo: function () {
      return call('appInfo', []);
    },
    openDataDir: function () {
      return Promise.resolve();
    },
    setLoginItem: function () {
      return Promise.resolve();
    },
    setTray: function () {
      return Promise.resolve();
    },
    proxyInfo: function () {
      return call('proxyInfo', []);
    },
    setNetworkConfig: function () {
      return Promise.resolve();
    },
    // Android 当前不参与 Web Bundle 热更新；走 APK 下载更新
    hotCheck: undefined,
    hotApply: undefined,
    appUpdateCheck: function () {
      return call('appUpdateCheck', []);
    },
    appUpdateInstall: function (url) {
      return call('appUpdateInstall', [url]);
    },
    setImmersive: function (on) {
      return call('setImmersive', [!!on]);
    },
    setVideoFullscreen: function (on) {
      return call('setVideoFullscreen', [!!on]);
    },
    proxyUrl: syncProxy,
  };
})();
