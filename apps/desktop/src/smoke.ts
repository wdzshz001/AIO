import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 冒烟测试：用真实窗口走一遍核心链路并截图到 _probe/。
 *
 * 覆盖两条路径：
 * - 动画（ani 模型）：搜索 → Bangumi 条目页 → 选集 → 选源 → 播放
 * - 小说/直连站点：应用首页 → 详情 → 目录 → 阅读 → 翻章
 *
 * 仅在 AGG_SMOKE=1 时启用。
 */
export async function runSmoke(win: BrowserWindow): Promise<void> {
  const out = process.env.AGG_SMOKE_OUT || path.resolve(process.cwd(), '..', '..', '_probe');
  fs.mkdirSync(out, { recursive: true });

  const log: string[] = [];
  const note = (s: string) => {
    log.push(s);
    fs.writeFileSync(path.join(out, 'smoke.log'), log.join('\n'), 'utf8');
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const js = (code: string) => win.webContents.executeJavaScript(code);
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name + '.png'), img.toPNG());
    note('shot ' + name);
  };
  const until = async (code: string, timeoutMs: number, label: string) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ok = await js(code).catch(() => false);
      if (ok) {
        note(`${label} ready in ${Date.now() - started}ms`);
        return true;
      }
      await wait(500);
    }
    note(`${label} TIMEOUT after ${timeoutMs}ms`);
    return false;
  };

  const clickFirst = (selector: string) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`).catch(
      () => false,
    );

  /** 条目页：选集 → 选源 → 播放 */
  const playSubject = async (prefix: string): Promise<boolean> => {
    const epOk = await until(`document.querySelectorAll('.episode-item').length > 0`, 45_000, `${prefix}-episodes`);
    await shot(`${prefix}-subject`);
    if (!epOk) return false;

    const epInfo = await js(
      `(() => { const e = document.querySelector('.episode-item'); return { text: e.textContent.trim(), count: document.querySelectorAll('.episode-item').length }; })()`,
    ).catch(() => null);
    note(`${prefix} episodes: ` + JSON.stringify(epInfo));

    const autoStarted = Date.now();
    await clickFirst('.episode-item');
    // 新逻辑会先自动选源：等「播放器出现」或「选源面板结束 pending」
    let autoPicked = false;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const st = await js(`(() => ({
        player: !!document.querySelector('.player'),
        reader: !!document.querySelector('.reader-head'),
        modal: !!document.querySelector('.source-modal'),
        items: document.querySelectorAll('.source-item').length,
        pending: !!document.querySelector('.source-pending'),
      }))()`).catch(() => null);
      if (st?.player || (st?.reader && !st?.modal)) {
        autoPicked = true;
        break;
      }
      if (st?.modal && !st.pending) break;
      await wait(500);
    }
    note(`${prefix} auto source: ${autoPicked} in ${Date.now() - autoStarted}ms`);
    if (autoPicked) {
      await shot(`${prefix}-auto`);
    } else {
      await wait(500);
      await shot(`${prefix}-sources`);
      const stats = await js(
        `(() => ({
          ok: document.querySelectorAll('.source-item').length,
          failed: document.querySelectorAll('.source-failed-item').length,
          head: document.querySelector('.source-modal h2')?.textContent || '',
        }))()`,
      ).catch(() => null);
      note(`${prefix} sources: ` + JSON.stringify(stats));
      if ((stats?.ok ?? 0) > 0) {
        await clickFirst('.source-item');
      }
    }

    const playOk = await until(
      `document.querySelectorAll('.reader-body p').length > 3 || !!document.querySelector('.player')`,
      90_000,
      `${prefix}-play`,
    );
    await wait(1500);
    await shot(`${prefix}-play`);
    const autoState = await js(
      `(() => { const v = document.querySelector('.player'); return v ? { paused: v.paused, t: Math.round(v.currentTime), ready: v.readyState, w: v.videoWidth } : null; })()`,
    ).catch(() => null);
    note(`${prefix} autoplay state: ` + JSON.stringify(autoState));
    const hasVideo = await js(`!!document.querySelector('.player')`).catch(() => false);
    note(`${prefix} video player: ` + hasVideo);
    if (hasVideo) {
      const fsClicked = await js(
        `(() => { const b = [...document.querySelectorAll('.reader-head button')].find((x) => x.title === '全屏播放' || x.getAttribute('aria-label') === '全屏播放'); if (!b) return false; b.click(); return true; })()`,
      ).catch(() => false);
      await js(`document.querySelector('.reader-scroll')?.click()`);
      await wait(500);
      const fsState = await js(
        `(() => ({
          fullscreen: !!document.querySelector('.reader.focus'),
          controls: !!document.querySelector('.video-fs-controls.show'),
          buttons: [...document.querySelectorAll('.video-fs-controls button')].map((x) => x.textContent.trim()),
        }))()`,
      ).catch(() => null);
      note(`${prefix} video fullscreen: ` + JSON.stringify({ fsClicked, fsState }));
      if (fsClicked) await shot(`${prefix}-fullscreen`);
      await js(`document.querySelector('.video-fs-exit')?.click()`);
      await wait(300);
      await js(
        `(() => { const v = document.querySelector('.player'); v.muted = true; v.play().catch(() => {}); return 'ok'; })()`,
      ).catch(() => undefined);
      await wait(6000);
      const state = await js(
        `(() => { const v = document.querySelector('.player'); return { src: (v.currentSrc || v.src || '').slice(0, 120), dataSrc: (v.dataset.srcUrl || '').slice(0, 120), ready: v.readyState, network: v.networkState, w: v.videoWidth, h: v.videoHeight, t: Math.round(v.currentTime), hls: v.dataset.hlsState || 'none', err: v.error ? { code: v.error.code, msg: v.error.message } : null }; })()`,
      ).catch(() => null);
      note(`${prefix} video state: ` + JSON.stringify(state));
      const proxyInfo = await js(
        `(() => { const v = document.querySelector('.player'); return { current: v.currentSrc, referer: v.dataset.referer, ua: v.dataset.ua, ck: v.dataset.cookies }; })()`,
      ).catch(() => null);
      note(`${prefix} proxy info: ` + JSON.stringify(proxyInfo));
      const proxyTest = await js(
        `(async () => {
          const v = document.querySelector('.player');
          const u = v && v.dataset.srcUrl;
          if (!u) return null;
          try {
            const p = 'aggmedia://stream/?u=' + encodeURIComponent(u);
            const r = await fetch(p, { headers: { range: 'bytes=0-1023' } });
            const b = await r.arrayBuffer();
            return { status: r.status, bytes: b.byteLength, type: r.headers.get('content-type'), cr: r.headers.get('content-range') };
          } catch (e) { return { error: String(e) }; }
        })()`,
      ).catch(() => null);
      note(`${prefix} proxy test: ` + JSON.stringify(proxyTest));
      // 对照：同一窗口里直接用原始 https 地址播放，区分「代理问题」和「站点/解码问题」
      const directTest = await js(
        `(async () => {
          const src = document.querySelector('.player')?.dataset.srcUrl;
          if (!src) return null;
          const v = document.createElement('video');
          v.muted = true;
          v.style.display = 'none';
          v.src = src;
          document.body.appendChild(v);
          const r = await new Promise((resolve) => {
            const t = setTimeout(() => resolve({ timeout: true }), 10000);
            v.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve({ ok: true, w: v.videoWidth, h: v.videoHeight }); }, { once: true });
            v.addEventListener('error', () => { clearTimeout(t); resolve({ err: v.error && { code: v.error.code, msg: v.error.message } }); }, { once: true });
          });
          v.remove();
          return r;
        })()`,
      ).catch(() => null);
      note(`${prefix} direct test: ` + JSON.stringify(directTest));
      await shot(`${prefix}-video`);
    }
    return playOk;
  };

  /** 书籍页：目录 → 阅读/播放 */
  const readBook = async (prefix: string): Promise<boolean> => {
    const bookOk = await until(`!!document.querySelector('.chapter-item')`, 90_000, `${prefix}-book`);
    await wait(900);
    await shot(`${prefix}-book`);
    if (!bookOk) return false;

    const chapterCount = await js(`document.querySelectorAll('.chapter-item').length`);
    note(`${prefix} chapters rendered: ` + chapterCount);

    await clickFirst('.chapter-item');
    const readOk = await until(
      `document.querySelectorAll('.reader-body p').length > 3 || !!document.querySelector('.player') || document.querySelectorAll('.comic-pages img').length > 0`,
      60_000,
      `${prefix}-reader`,
    );
    await wait(1200);
    await shot(`${prefix}-reader`);
    if (!readOk) return false;

    const hasVideo = await js(`!!document.querySelector('.player')`).catch(() => false);
    const comicCount = await js(`document.querySelectorAll('.comic-pages img').length`).catch(() => 0);
    note(`${prefix} video player: ` + hasVideo);
    if (comicCount > 0) {
      await wait(2500);
      const comicState = await js(`(() => {
        const imgs = [...document.querySelectorAll('.comic-pages img')];
        const first = imgs[0];
        return { count: imgs.length, firstLoaded: first ? first.naturalWidth : 0, firstSrc: first ? (first.currentSrc || first.src || '').slice(0, 100) : '' };
      })()`).catch(() => null);
      note(`${prefix} comic pages: ` + JSON.stringify(comicState));
      await shot(`${prefix}-comic`);
    }
    if (hasVideo) {
      await js(
        `(() => { const v = document.querySelector('.player'); v.muted = true; v.play().catch(() => {}); return 'ok'; })()`,
      ).catch(() => undefined);
      await wait(5000);
      const videoState = await js(`(() => {
        const v = document.querySelector('.player');
        return { src: (v.currentSrc || v.src || '').slice(0, 70), ready: v.readyState, w: v.videoWidth, h: v.videoHeight, t: Math.round(v.currentTime * 10) / 10, hls: v.dataset.hlsState || 'none' };
      })()`).catch(() => null);
      note(`${prefix} video state: ` + JSON.stringify(videoState));
      await shot(`${prefix}-video-playing`);
    } else {
      const paraCount = await js(`document.querySelectorAll('.reader-body p').length`);
      const textSample = await js(
        `document.querySelectorAll('.reader-body p')[1]?.textContent.slice(0, 60) || ''`,
      );
      note(`${prefix} paragraphs: ` + paraCount);
      note(`${prefix} sample: ` + textSample);
    }

    await js(`document.querySelector('.reader-scroll')?.click()`);
    await wait(300);
    const nav = await js(`(() => {
      const btns = [...document.querySelectorAll('.reader-nav .ghost-btn')];
      const next = btns.find(b => b.textContent.includes('下一章') || b.textContent.includes('下一话'));
      if (!next || next.disabled) return false;
      next.click();
      return true;
    })()`);
    note(`${prefix} next clicked: ` + nav);
    await wait(2500);
    await shot(`${prefix}-reader-next`);
    note(`${prefix} after next: ` + (await js(`document.querySelector('.reader-chapter').textContent`)));
    return true;
  };

  try {
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) note('console[' + level + '] ' + String(message).slice(0, 300));
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      note('RENDER GONE ' + JSON.stringify(details));
    });

    win.show();
    if (process.env.AGG_SMOKE_FRESH) {
      await js(`Object.keys(localStorage).filter(k => k.startsWith('agg.chapters')).forEach(k => localStorage.removeItem(k))`);
      note('cleared chapter cache');
    }
    if (process.env.AGG_SMOKE_KEEP_ROUTE !== '1') {
      await js(`(() => {
        const s = JSON.parse(localStorage.getItem('agg.settings.v1') || '{}');
        s.settingsVersion = 2;
        s.startup = { ...(s.startup || {}), page: 'home' };
        localStorage.setItem('agg.settings.v1', JSON.stringify(s));
        localStorage.removeItem('agg.lastRoute.v1');
        location.reload();
      })()`);
      await until(`!!document.querySelector('.launcher')`, 20_000, 'home-reset');
    }
    await wait(1200);
    await shot('01-home');

    if (process.env.AGG_SMOKE_HOT === '1') {
      const check = await js(`(async () => {
        try { return await window.agg.hotCheck(); } catch (e) { return { error: String(e) }; }
      })()`);
      note('hot check: ' + JSON.stringify(check));
      if (check?.version) {
        const applied = await js(`(async () => {
          try { return await window.agg.hotApply(${JSON.stringify(check.version)}); } catch (e) { return { error: String(e) }; }
        })()`);
        note('hot apply: ' + JSON.stringify(applied));
      }
      await wait(2500);
      const hotInfo = await js(`window.agg.appInfo().catch((e) => ({ error: String(e) }))`);
      note('hot appinfo: ' + JSON.stringify(hotInfo));
      await shot('hot-result');
      note('HOT DONE');
      return;
    }

    if (process.env.AGG_SMOKE_ANIME_HEALTH === '1') {
      await js(`document.querySelector('.rail-settings')?.click()`);
      await until(`!!document.querySelector('.settings-page')`, 20_000, 'health-settings');
      await js(`(() => {
        const b = [...document.querySelectorAll('.settings-link')].find((x) => x.innerText.includes('内容源'));
        b?.click();
        return !!b;
      })()`);
      await until(`!!document.querySelector('.source-manage-list')`, 30_000, 'health-sources');
      await js(`(() => {
        const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '检测全部');
        b?.click();
        return !!b;
      })()`);
      const deadline = Date.now() + 150_000;
      while (Date.now() < deadline) {
        const checking = await js(`[...document.querySelectorAll('.mini-badge')].some((x) => x.innerText.includes('检测中'))`);
        if (!checking) break;
        await wait(1000);
      }
      const health = await js(`(() => [...document.querySelectorAll('.source-manage-row')].map((row) => {
        const name = row.querySelector('.source-manage-name')?.innerText || '';
        const badges = [...row.querySelectorAll('.mini-badge')].map((x) => ({ text: x.innerText, title: x.title || '' }));
        return { name, badges };
      }))()`);
      note('anime source health: ' + JSON.stringify(health));
      await shot('anime-source-health');
      note('ANIME HEALTH DONE');
      return;
    }

    if (process.env.AGG_SMOKE_CACHE_STATS === '1') {
      const stats = await js(`new Promise((resolve) => {
        const req = indexedDB.open('agg-content-cache');
        req.onerror = () => resolve({ error: 'open' });
        req.onsuccess = () => {
          try {
            const store = req.result.transaction('chapters', 'readonly').objectStore('chapters');
            const count = store.count();
            const all = store.getAll();
            all.onsuccess = () => resolve({ count: count.result, entries: all.result.map((r) => ({ key: r.key, bytes: r.bytes })) });
            all.onerror = () => resolve({ error: 'getAll' });
          } catch (e) { resolve({ error: String(e) }); }
        };
      })`);
      note('content cache stats: ' + JSON.stringify(stats));
      await shot('cache-stats');
      return;
    }

    if (process.env.AGG_SMOKE_SEARCH_HISTORY === '1') {
      await js(`localStorage.removeItem('agg.searchHistory.v1')`);
      await js(`(() => {
        const input = document.querySelector('.launcher-search input');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(input, '测试历史');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.launcher-search .primary-btn')?.click();
        return true;
      })()`);
      await until(`!!document.querySelector('.search-head')`, 20_000, 'history-search');
      await js(`document.querySelector('.search-head .icon-btn')?.click()`);
      await until(`!!document.querySelector('.launcher')`, 20_000, 'history-home');
      await wait(400);
      await js(`document.querySelector('.launcher-search input')?.focus()`);
      await wait(300);
      const before = await js(`({ count: document.querySelectorAll('.search-history-item').length, text: document.querySelector('.search-history')?.innerText || '' })`);
      note('search history before clear: ' + JSON.stringify(before));
      await shot('search-history');
      await js(`document.querySelector('.search-history-head button')?.click()`);
      await wait(300);
      const after = await js(`document.querySelectorAll('.search-history-item').length`);
      note('search history after clear: ' + after);
      note('SEARCH HISTORY DONE');
      return;
    }

    if (process.env.AGG_SMOKE_AUTOQI === '1') {
      await js(`document.querySelectorAll('.app-card')[0].click()`);
      await until(`document.querySelectorAll('.book-card').length > 0`, 60_000, 'autoqi-home');
      await js(`(() => {
        const el = document.querySelector('.app-search input');
        if (!el) return false;
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, '诡秘之主');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('.app-search .primary-btn')?.click();
        return true;
      })()`);
      await until(`!!document.querySelector('.search-head')`, 30_000, 'autoqi-search');
      await until(`document.querySelectorAll('.book-card').length > 0`, 60_000, 'autoqi-results');
      await clickFirst('.book-card');
      await until(`!!document.querySelector('.chapter-item')`, 60_000, 'autoqi-book');
      const clicked = await js(`(() => {
        const items = [...document.querySelectorAll('.chapter-item')];
        const vip = items.find(x => x.querySelector('.chapter-vip') || x.innerText.includes('VIP'));
        const locked = document.querySelector('.chapter-item.locked');
        const el = locked || vip || items[items.length - 1] || items[0];
        if (!el) return null;
        const text = el.innerText;
        el.click();
        return { text, locked: !!locked, vip: !!vip, index: items.indexOf(el) };
      })()`);
      note('autoqi clicked: ' + JSON.stringify(clicked));
      let result = null;
      for (let i = 0; i < 120; i++) {
        await wait(500);
        result = await js(`(() => {
          const toast = document.querySelector('.app-toast')?.innerText || '';
          const paragraphs = document.querySelectorAll('.reader-body p').length;
          const err = document.querySelector('.error-box')?.innerText || '';
          const list = JSON.parse(localStorage.getItem('agg.shelf.v1') || '[]');
          const e = list.find(x => x.kind === 'novel');
          return { toast, paragraphs, err, siteId: e?.siteId, chapter: e?.chapter?.title };
        })()`).catch(() => null);
        if (result && (result.paragraphs > 3 || result.err)) {
          await wait(900);
          result.toast = await js(`document.querySelector('.app-toast')?.innerText || ''`).catch(() => '');
          break;
        }
      }
      note('autoqi result: ' + JSON.stringify(result));
      await shot('autoqi-result');
      note('AUTOQI DONE');
      return;
    }

    if (process.env.AGG_SMOKE_NOVEL_PROGRESS === '1') {
      await js(`document.querySelectorAll('.app-card')[0].click()`);
      await until(`document.querySelectorAll('.book-card').length > 0`, 60_000, 'novel-progress-home');
      await clickFirst('.book-card');
      await until(`!!document.querySelector('.chapter-item')`, 60_000, 'novel-progress-book');
      await clickFirst('.chapter-item');
      const ok = await until(
        `document.querySelectorAll('.reader-body p').length > 3`,
        60_000,
        'novel-progress-reader',
      );
      if (ok) {
        await js(`(() => { const el = document.querySelector('.reader-scroll'); if (el) el.scrollTop = (el.scrollHeight - el.clientHeight) * 0.5; })()`);
        await wait(1500);
        const saved = await js(`(() => {
          const list = JSON.parse(localStorage.getItem('agg.shelf.v1') || '[]');
          const e = list.find(x => x.kind === 'novel');
          return e ? { scroll: e.scroll, chapter: e.chapter && e.chapter.title } : null;
        })()`);
        note('novel saved scroll: ' + JSON.stringify(saved));
        await js(`document.querySelector('.reader-head .icon-btn')?.click()`);
        await until(`!!document.querySelector('.chapter-item')`, 20_000, 'novel-progress-back');
        await js(`document.querySelector('.hero-actions .primary-btn')?.click()`);
        await until(`document.querySelectorAll('.reader-body p').length > 3`, 30_000, 'novel-progress-resume');
        await wait(1200);
        const ratio = await js(`(() => {
          const el = document.querySelector('.reader-scroll');
          return el ? el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight) : 0;
        })()`);
        note('novel resume ratio: ' + Number(ratio).toFixed(3));
      }
      note('NOVEL PROGRESS OK');
      return;
    }

    if (process.env.AGG_SMOKE_CLOUDWN === '1') {
      await js(`(() => {
        const s = JSON.parse(localStorage.getItem('agg.settings.v1') || '{}');
        s.flightMode = true;
        s.settingsVersion = 3;
        localStorage.setItem('agg.settings.v1', JSON.stringify(s));
        location.reload();
      })()`);
      await until(`!!document.querySelector('.app-card')`, 30_000, 'cloudwn-home');
      await js(`document.querySelectorAll('.app-card')[2].click()`);
      await until(`!!document.querySelector('.comic-home')`, 30_000, 'cloudwn-app');
      const picked = await js(`(() => {
        const b = [...document.querySelectorAll('.home-tab')].find(x => x.innerText.includes('CloudWN'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      note('cloudwn source tab: ' + picked);
      await until(`document.querySelectorAll('.book-card').length > 0`, 60_000, 'cloudwn-books');
      if (process.env.AGG_SMOKE_CLOUDWN_SERIES === '1') {
        const found = await js(`(() => {
          const b = [...document.querySelectorAll('.book-card')].find((x) => x.innerText.includes('アオヒモファミリア'));
          if (!b) return false;
          b.click();
          return true;
        })()`);
        note('cloudwn series card found: ' + found);
        if (!found) await clickFirst('.book-card');
      } else {
        await clickFirst('.book-card');
      }
      await until(`!!document.querySelector('.chapter-item')`, 60_000, 'cloudwn-book');
      const chapterCount = await js(`document.querySelectorAll('.chapter-item').length`);
      const coverInfo = await js(`(() => {
        const img = document.querySelector('.book-hero img, .book-cover img, .book-cover');
        if (!img) return null;
        return { tag: img.tagName, w: img.naturalWidth || 0, src: (img.currentSrc || img.src || '').slice(0, 100) };
      })()`);
      note('cloudwn chapters: ' + chapterCount);
      note('cloudwn cover: ' + JSON.stringify(coverInfo));
      await clickFirst('.chapter-item');
      await until(`document.querySelectorAll('.comic-pages img').length > 0`, 90_000, 'cloudwn-reader');
      await wait(6000);
      const info = await js(`(() => {
        const imgs = [...document.querySelectorAll('.comic-pages img')].slice(0, 3);
        return imgs.map(img => ({ w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 180) }));
      })()`);
      note('cloudwn images: ' + JSON.stringify(info));
      await shot('cloudwn-reader');
      note('CLOUDWN OK');
      return;
    }

    if (process.env.AGG_SMOKE_MANGA === '1') {
      await js(`(() => {
        const s = JSON.parse(localStorage.getItem('agg.settings.v1') || '{}');
        s.flightMode = true;
        s.settingsVersion = 2;
        localStorage.setItem('agg.settings.v1', JSON.stringify(s));
        location.reload();
      })()`);
      await wait(1800);
      await until(`!!document.querySelector('.app-card')`, 30_000, 'manga-home');
      await js(`document.querySelectorAll('.app-card')[2].click()`);
      await until(`!!document.querySelector('.comic-home')`, 30_000, 'manga-app');
      const picked = await js(`(() => {
        const b = [...document.querySelectorAll('.home-tab')].find(x => x.innerText.includes('拷贝漫画'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      note('manga source tab: ' + picked);
      await until(`document.querySelectorAll('.book-card').length > 0`, 60_000, 'manga-books');
      await wait(800);
      await js(`document.querySelector('.main').scrollTop = 300`);
      await wait(200);
      const appScrollBefore = await js(`document.querySelector('.main').scrollTop`);
      note('manga app scroll before book: ' + appScrollBefore);
      await shot('manga-list');
      await clickFirst('.book-card');
      await until(`!!document.querySelector('.chapter-item')`, 60_000, 'manga-book-scroll');
      await js(`document.querySelector('.main').scrollTop = 240`);
      await wait(200);
      const bookScrollBefore = await js(`document.querySelector('.main').scrollTop`);
      note('manga book scroll before read: ' + bookScrollBefore);
      await readBook('manga');

      // 漫画页码记录与续读
      await js(`document.querySelectorAll('.comic-pages img')[3]?.scrollIntoView({block:'start'})`);
      await wait(1400);
      const shelfPage = await js(`(() => {
        const list = JSON.parse(localStorage.getItem('agg.shelf.v1') || '[]');
        const e = list.find(x => x.siteId === 'mangacopy');
        return e ? { page: e.page, pageCount: e.pageCount } : null;
      })()`);
      note('manga saved page: ' + JSON.stringify(shelfPage));
      await js(`document.querySelector('.reader-head .icon-btn')?.click()`);
      await until(`!!document.querySelector('.chapter-item')`, 20_000, 'manga-back');
      await wait(300);
      const bookScrollAfter = await js(`document.querySelector('.main').scrollTop`);
      note('manga book scroll after read: ' + bookScrollAfter);
      await js(`document.querySelector('.hero-actions .primary-btn')?.click()`);
      await until(`document.querySelectorAll('.comic-pages img').length > 0`, 30_000, 'manga-resume');
      await wait(1800);
      await js(`document.querySelector('.reader-scroll')?.click()`);
      await wait(300);
      const resumePos = await js(`document.querySelector('.reader-pos')?.textContent || ''`);
      note('manga resume pos: ' + resumePos.replace(/\\s+/g, ' '));
      await shot('manga-resume');
      await js(`document.querySelector('.reader-head .icon-btn')?.click()`);
      await until(`!!document.querySelector('.chapter-item')`, 20_000, 'manga-book-again');
      await js(`document.querySelector('.page-head .head-left .icon-btn')?.click()`);
      await until(`!!document.querySelector('.comic-home')`, 20_000, 'manga-app-again');
      const activeTab = await js(`document.querySelector('.comic-home .home-tab.active')?.innerText || ''`);
      note('manga source after back: ' + activeTab.replace(/\\s+/g, ' '));
      await wait(500);
      const appScrollAfter = await js(`document.querySelector('.main').scrollTop`);
      note('manga app scroll after back: ' + appScrollAfter);
      note('MANGA OK');
      return;
    }

    if (process.env.AGG_SMOKE_SETTINGS_ONLY === '1') {
      await js(`document.querySelector('.rail-settings').click()`);
      await until(`!!document.querySelector('.settings-page')`, 15_000, 'settings-only');
      await wait(500);
      await shot('settings-root');
      const sections: [string, string][] = [
        ['内容源', 'sources'],
        ['阅读与播放', 'reader'],
        ['外观', 'appearance'],
        ['启动与搜索', 'startup'],
        ['存储与隐私', 'storage'],
        ['网络与缓存', 'network'],
        ['关于', 'about'],
      ];
      for (const [label, id] of sections) {
        await js(`(() => {
          const b = [...document.querySelectorAll('.settings-link')].find(x => x.innerText.includes(${JSON.stringify(label)}));
          if (b) b.click();
        })()`);
        await until(
          `document.querySelector('.settings-page h1')?.textContent.includes(${JSON.stringify(label)})`,
          15_000,
          `settings-only-${id}`,
        );
        await wait(600);
        if (id === 'sources') {
          await until(`document.querySelectorAll('.source-manage-row').length > 0`, 15_000, 'settings-only-rows');
          const checkSite = async (name: string) => {
            await js(`(() => {
              const row = [...document.querySelectorAll('.source-manage-row')].find(r => r.innerText.includes(${JSON.stringify(name)}));
              const btn = row && [...row.querySelectorAll('.text-btn')].find(b => b.textContent.trim() === '检测');
              if (btn) btn.click();
            })()`);
            await until(
              `(() => {
                const row = [...document.querySelectorAll('.source-manage-row')].find(r => r.innerText.includes(${JSON.stringify(name)}));
                return !!(row && row.querySelector('.mini-badge.ok, .mini-badge.fail'));
              })()`,
              45_000,
              `health-${name}`,
            );
            return js(`(() => {
              const row = [...document.querySelectorAll('.source-manage-row')].find(r => r.innerText.includes(${JSON.stringify(name)}));
              const fail = row && row.querySelector('.mini-badge.fail');
              return row ? row.innerText.replace(/\\s+/g, ' ') + (fail ? ' | ' + fail.getAttribute('title') : '') : '';
            })()`);
          };
          note('health trxs: ' + (await checkSite('同人小说网')));
          note('health anime: ' + (await checkSite('稀饭动漫')));
        }
        await shot(`settings-only-${id}`);
        await js(`document.querySelector('.settings-page .head-left .icon-btn')?.click()`);
        await until(`!!document.querySelector('[data-setting="flight-mode"]')`, 15_000, `settings-only-${id}-back`);
      }
      note('SETTINGS OK');
      return;
    }

    // ---------- 聚合搜索（Bangumi 优先） ----------
    const keyword = process.env.AGG_SMOKE_QUERY || '孤独摇滚';
    note('search keyword: ' + keyword);
    await clickFirst('.rail-app[title="聚合搜索"]');
    await wait(600);
    await js(`(() => {
      const input = document.querySelector('.search-input-lg');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(keyword)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);

    const searchOk = await until(
      `document.querySelectorAll('.book-card, .subject-card').length > 0`,
      90_000,
      'search',
    );
    await wait(2500);
    await shot('06-search');

    const searchStats = await js(
      `(() => ({ subjects: document.querySelectorAll('.subject-card').length, books: document.querySelectorAll('.book-card').length, sections: [...document.querySelectorAll('.group-title')].map(e => e.textContent.trim()) }))()`,
    ).catch(() => null);
    note('search stats: ' + JSON.stringify(searchStats));

    if (searchOk) {
      const hasSubject = await js(`document.querySelectorAll('.subject-card').length > 0`).catch(() => false);
      if (hasSubject) {
        await clickFirst('.subject-card');
        await playSubject('09-search');
      } else {
        await clickFirst('.book-card');
        await readBook('07-search-open');
      }
    } else {
      note('WARN 搜索没有出结果');
    }

    // 回到首页（播放页没有侧栏，直接重载最稳）
    await js('location.reload()').catch(() => undefined);
    await wait(1800);
    await until(`!!document.querySelector('.app-card, .launcher')`, 30_000, 'home-reset');

    // ---------- 应用首页 → 详情/条目 → 阅读/播放 ----------
    const siteIndex = Number(process.env.AGG_SMOKE_INDEX || 0);
    note('site index: ' + siteIndex);
    await js(`document.querySelectorAll('.app-card')[${siteIndex}].click()`);
    const siteOk = await until(`document.querySelectorAll('.book-card').length > 0`, 90_000, 'site');
    await wait(1500);
    await shot('02-site');
    if (!siteOk) throw new Error('应用首页没有出现内容');

    // 小说首页：验证「分类 / 排行」两个找书模块
    const isNovelHome = await js(`!!document.querySelector('.novel-home')`).catch(() => false);
    if (isNovelHome) {
      const tabs = await js(
        `[...document.querySelectorAll('.novel-home .home-tab')].map(t => t.textContent.trim())`,
      ).catch(() => []);
      note('novel home tabs: ' + JSON.stringify(tabs));

      await js(
        `[...document.querySelectorAll('.novel-home .home-tab')].find(t => t.textContent.includes('排行'))?.click()`,
      );
      await until(`document.querySelectorAll('.novel-home .book-card').length > 0`, 45_000, 'novel-rank');
      await wait(700);
      await shot('02b-novel-rank');
      note(
        'novel rank sections: ' +
          (await js(
            `[...document.querySelectorAll('.novel-home .section-title')].map(e => e.textContent.trim()).slice(0, 12)`,
          ).catch(() => [])),
      );

      const rankMoreClicked = await js(
        `(() => { const b = [...document.querySelectorAll('.novel-home .text-btn')].find(x => x.textContent.trim() === '更多'); if (!b) return false; b.click(); return true; })()`,
      ).catch(() => false);
      if (rankMoreClicked) {
        await until(
          `document.querySelectorAll('.novel-list-view .book-card').length > 0`,
          45_000,
          'novel-rank-more',
        );
        await wait(600);
        await shot('02b2-novel-rank-more');
        note(
          'novel rank more books: ' +
            (await js(`document.querySelectorAll('.novel-list-view .book-card').length`).catch(() => 0)),
        );
        await js(`document.querySelector('.novel-list-view .list-head .icon-btn')?.click()`);
        await until(
          `document.querySelectorAll('.novel-home .book-card').length > 0`,
          30_000,
          'novel-rank-more-back',
        );
        await wait(400);
      }

      await js(
        `[...document.querySelectorAll('.novel-home .home-tab')].find(t => t.textContent.includes('分类'))?.click()`,
      );
      await until(`!!document.querySelector('.category-chips')`, 15_000, 'novel-category');
      await js(`document.querySelector('.category-chips .category-tab')?.click()`);
      await until(`document.querySelectorAll('.novel-home .book-card').length > 0`, 45_000, 'novel-category-books');
      await wait(700);
      await shot('02c-novel-category');
      note(
        'novel category books: ' +
          (await js(`document.querySelectorAll('.novel-home .book-card').length`).catch(() => 0)),
      );

      await js(
        `[...document.querySelectorAll('.novel-home .home-tab')].find(t => t.textContent.trim() === '推荐')?.click()`,
      );
      await until(`document.querySelectorAll('.novel-home .book-card').length > 0`, 45_000, 'novel-recommend');
      await wait(500);
    }

    // 起点「更多」：打开完整列表
    if (isNovelHome) {
      const moreClicked = await js(
        `(() => { const b = [...document.querySelectorAll('.novel-home .text-btn')].find(x => x.textContent.trim() === '更多'); if (!b) return false; b.click(); return true; })()`,
      ).catch(() => false);
      if (moreClicked) {
        await until(
          `document.querySelectorAll('.novel-list-view .book-card').length > 0`,
          45_000,
          'novel-more',
        );
        await wait(700);
        await shot('02d-novel-more');
        note(
          'novel more books: ' +
            (await js(`document.querySelectorAll('.novel-list-view .book-card').length`).catch(() => 0)),
        );
        await js(`document.querySelector('.novel-list-view .list-head .icon-btn')?.click()`);
        await until(
          `document.querySelectorAll('.novel-home .book-card').length > 0`,
          30_000,
          'novel-more-back',
        );
        await wait(500);
      }
    }

    // 应用内搜索：默认只勾选本应用分类
    const isComicHome = await js(`!!document.querySelector('.comic-home')`).catch(() => false);
    const appQuery = isNovelHome ? '诡秘之主' : isComicHome ? '同人' : '孤独摇滚';
    const expectedCategory = isNovelHome ? '小说' : isComicHome ? '漫画' : '动画';
    const searchStarted = await js(`(() => {
      const input = document.querySelector('.app-search input');
      const btn = document.querySelector('.app-search button');
      if (!input || !btn) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(appQuery)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return true;
    })()`).catch(() => false);

    if (searchStarted) {
      const pageOk = await until(`!!document.querySelector('.search-head')`, 15_000, 'app-search-page');
      if (pageOk) {
        await until(
          `document.querySelectorAll('.book-card, .subject-card').length > 0`,
          60_000,
          'app-search-results',
        );
        await wait(700);
        const active = await js(
          `document.querySelector('.chips .chip.active')?.textContent || ''`,
        ).catch(() => '');
        note(`app search category: ${active} (expected ${expectedCategory})`);
        await shot('02e-app-search');
        await clickFirst('.search-head .icon-btn');
        await until(`!!document.querySelector('.app-search')`, 15_000, 'app-search-back');
        await until(`document.querySelectorAll('.book-card').length > 0`, 45_000, 'app-search-back-content');
        await wait(500);
      }
    }

    await clickFirst('.book-card');
    const isSubjectPage = await until(`!!document.querySelector('.episode-item')`, 20_000, 'landing-subject');
    if (isSubjectPage) {
      await playSubject('03-app');
    } else {
      await readBook('03-app');
    }

    // ---------- 设置 / 飞行模式 ----------
    await js('location.reload()').catch(() => undefined);
    await wait(1800);
    await until(`!!document.querySelector('.rail-settings')`, 30_000, 'settings-home');
    await js(`document.querySelector('.rail-settings').click()`);
    await until(`!!document.querySelector('.settings-page')`, 15_000, 'settings-page');
    const flightLabel = await js(`document.body.innerText.includes('飞行模式')`);
    const nsfwWord = await js(`document.body.innerText.includes('NSFW')`);
    note(`settings flight label: ${flightLabel}, nsfw word (root): ${nsfwWord}`);

    // 三级页：设置 → NSFW 标记；飞行模式关闭时应隐藏已标记源
    await js(`document.querySelector('.settings-nsfw-entry')?.click()`);
    await until(`document.body.innerText.includes('NSFW 标记')`, 15_000, 'settings-nsfw');
    const nsfwTitle = await js(`document.querySelector('.settings-page h1')?.textContent || ''`);
    const markedBefore = await js(`document.querySelectorAll('.nsfw-badge.on').length`);
    const hiddenBefore = await js(`document.querySelectorAll('.settings-source-row.hidden').length`);
    note(`nsfw page off: ${nsfwTitle}, marked: ${markedBefore}, hidden: ${hiddenBefore}`);
    await shot('04-settings-nsfw-off');

    await js(`document.querySelector('.settings-page .head-left .icon-btn')?.click()`);
    await until(`!!document.querySelector('[data-setting="flight-mode"]')`, 15_000, 'settings-back');
    await js(`document.querySelector('[data-setting="flight-mode"]')?.click()`);
    await wait(600);
    const hiddenText = await js(`document.querySelector('.settings-hidden-count')?.textContent || ''`);
    note(`settings flight on: ${hiddenText}`);
    await shot('04-settings-flight');

    await js(`document.querySelector('.settings-nsfw-entry')?.click()`);
    await until(`document.body.innerText.includes('NSFW 标记')`, 15_000, 'settings-nsfw-on');
    const hiddenAfter = await js(`document.querySelectorAll('.settings-source-row.hidden').length`);
    const markedAfter = await js(`document.querySelectorAll('.nsfw-badge.on').length`);
    note(`nsfw page on: marked: ${markedAfter}, hidden: ${hiddenAfter}`);
    await shot('04-settings-nsfw-on');

    await js(`document.querySelector('.settings-page .head-left .icon-btn')?.click()`);
    await until(`!!document.querySelector('[data-setting="flight-mode"]')`, 15_000, 'settings-back2');

    // 设置各子页
    const sections: [string, string][] = [
      ['内容源', 'sources'],
      ['阅读与播放', 'reader'],
      ['外观', 'appearance'],
      ['启动与搜索', 'startup'],
      ['存储与隐私', 'storage'],
      ['网络与缓存', 'network'],
      ['关于', 'about'],
    ];
    for (const [label, id] of sections) {
      const clicked = await js(`(() => {
        const b = [...document.querySelectorAll('.settings-link')].find(x => x.innerText.includes(${JSON.stringify(label)}));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      const ok = clicked
        ? await until(
            `document.querySelector('.settings-page h1')?.textContent.includes(${JSON.stringify(label)})`,
            20_000,
            `settings-${id}`,
          )
        : false;
      note(`settings section ${id}: ${ok}`);
      await wait(600);
      await shot(`05-settings-${id}`);
      if (id === 'appearance') {
        await js(`(() => { const b = [...document.querySelectorAll('.seg-btn')].find(x => x.textContent.trim() === '浅色'); if (b) b.click(); })()`);
        await wait(300);
        const theme = await js(`document.documentElement.dataset.theme || ''`);
        note(`appearance theme: ${theme}`);
        await shot('05-settings-light');
        await js(`(() => { const b = [...document.querySelectorAll('.seg-btn')].find(x => x.textContent.trim() === '深色'); if (b) b.click(); })()`);
        await wait(200);
      }
      await js(`document.querySelector('.settings-page .head-left .icon-btn')?.click()`);
      await until(`!!document.querySelector('[data-setting="flight-mode"]')`, 15_000, `settings-${id}-back`);
    }

    await js(`document.querySelector('[data-setting="flight-mode"]')?.click()`);
    await wait(300);

    note('SMOKE OK');
  } catch (e) {
    note('SMOKE FAIL ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    await wait(500);
    const { app } = await import('electron');
    app.exit(0);
  }
}
