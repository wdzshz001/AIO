// 探测 Bangumi API 在 Electron 网络栈下是否可用
const fs = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OUT = path.resolve(process.cwd(), '..', '_probe', 'bgm.log');

app.whenReady().then(async () => {
  const log = [];
  const ses = session.defaultSession;

  const legacy =
    'https://api.bgm.tv/search/subject/' + encodeURIComponent('炼金') + '?type=2&responseGroup=large';
  try {
    const r = await ses.fetch(legacy, { headers: { 'user-agent': UA, accept: 'application/json' } });
    const t = await r.text();
    log.push(`legacy ${r.status} len=${t.length}`);
    try {
      const j = JSON.parse(t);
      const list = j.list || [];
      log.push('items=' + list.length);
      log.push(
        JSON.stringify(
          list.slice(0, 3).map((x) => ({
            id: x.id,
            name: x.name,
            cn: x.name_cn,
            img: (x.images && x.images.large) || '',
          })),
        ),
      );
    } catch {
      log.push('not json: ' + t.slice(0, 120));
    }
  } catch (e) {
    log.push('legacy ERR ' + e.message);
  }

  try {
    const r = await ses.fetch('https://api.bgm.tv/v0/search/subjects?limit=5', {
      method: 'POST',
      headers: {
        'user-agent': 'agg-launcher/0.1 (https://example.com)',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ keyword: '炼金', filter: { type: [2] } }),
    });
    const t = await r.text();
    log.push(`v0 ${r.status} len=${t.length} head=${t.slice(0, 160)}`);
  } catch (e) {
    log.push('v0 ERR ' + e.message);
  }

  fs.writeFileSync(OUT, log.join('\n'), 'utf8');
  app.exit(0);
});
