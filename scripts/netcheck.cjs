// 快速确认：渲染进程的 fetch 到底能不能出网
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, net, protocol } = require('electron');

protocol.registerSchemesAsPrivileged([
  { scheme: 'agg', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const OUT = path.resolve(process.cwd(), '..', '_probe');

app.whenReady().then(async () => {
  protocol.handle('agg', (request) => {
    const { pathname } = new URL(request.url);
    const rel = pathname === '/' ? '/index.html' : pathname;
    return net.fetch('file://' + path.join(__dirname, '..', 'apps', 'desktop', 'dist', rel).replace(/\\/g, '/'));
  });

  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  win.webContents.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  );
  await win.loadURL('agg://app/index.html').catch((e) => console.log('load', e.message));

  const result = await win.webContents
    .executeJavaScript(`(async () => {
      const urls = ['https://example.com/', 'https://api.ffzyapi.com/api.php/provide/vod/?ac=detail&pg=1'];
      const out = [];
      for (const u of urls) {
        try {
          const r = await fetch(u);
          out.push(u + ' -> ' + r.status);
        } catch (e) {
          out.push(u + ' -> ERR ' + e.message);
        }
      }
      return out.join('\\n');
    })()`)
    .catch((e) => 'eval err ' + e.message);

  fs.writeFileSync(path.join(OUT, 'netcheck.log'), result + '\n', 'utf8');
  app.exit(0);
});
