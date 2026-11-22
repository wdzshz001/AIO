// 临时探测脚本：用真实 Chromium 打开页面，等验证/选择器就绪后 dump HTML
// 只接收 URL 和选择器，输出固定写到 cwd/_probe/probe.html（避免中文路径经 argv 传参乱码）
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const url = args[0];
const waitFor = args[1] || '';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 1600,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setUserAgent(UA);

  try {
    await win.loadURL(url).catch((e) => console.error('loadURL:', e.message));
    const started = Date.now();
    const sel = JSON.stringify(waitFor);
    let state = { ok: false, blocked: true, title: '' };
    while (Date.now() - started < 60000) {
      state = await win.webContents
        .executeJavaScript(
          `(() => {
            const sel = ${sel};
            const blocked = /altcha|aegis_altcha|cf-challenge|Just a moment|Checking your browser/i
              .test(document.title + (document.body ? document.body.innerHTML.slice(0, 3000) : ''));
            const found = sel ? !!document.querySelector(sel) : true;
            return { ok: found && !blocked && document.readyState === 'complete', blocked,
                     title: document.title };
          })()`,
        )
        .catch(() => ({ ok: false, blocked: true }));
      if (state.ok) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');
    const dir = path.resolve(process.cwd(), '..', '_probe');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'probe.html'), html, 'utf8');
    const log = [
      'INPUT ' + url,
      'FINAL_URL ' + win.webContents.getURL(),
      'TITLE ' + state.title,
      'BLOCKED ' + state.blocked + ' READY ' + state.ok,
      'LEN ' + html.length,
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'probe.log'), log, 'utf8');
    console.log(log);
  } catch (e) {
    console.error('FATAL', e);
  } finally {
    app.exit(0);
  }
});
