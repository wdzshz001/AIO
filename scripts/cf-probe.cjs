// 实验：Cloudflare 挑战在「隐藏 vs 可见」以及「伪装 UA-CH」下的通过情况
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');

// 注意：URL 不能从命令行传，带 ? 的参数会让 Electron 直接退出
const URL = 'https://www.eacg1.com/vodsearch/-------------.html?wd=%E6%96%97%E7%BD%97';
const MODE = process.argv[2] || 'hidden'; // hidden | visible | visible-ua
const OUT = path.resolve(process.cwd(), '..', '_probe', `cf-${MODE}.log`);

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const log = [];
  const ses = session.fromPartition(`persist:cf-${MODE}`);
  ses.setUserAgent(CHROME_UA);

  const win = new BrowserWindow({
    show: MODE !== 'hidden',
    width: 1200,
    height: 900,
    webPreferences: { session: ses, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.webContents.setUserAgent(CHROME_UA);

  if (MODE === 'visible-ua') {
    try {
      const dbg = win.webContents.debugger;
      dbg.attach('1.3');
      await dbg.sendCommand('Network.setUserAgentOverride', {
        userAgent: CHROME_UA,
        acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
        platform: 'Win32',
        userAgentMetadata: {
          brands: [
            { brand: 'Google Chrome', version: '131' },
            { brand: 'Chromium', version: '131' },
            { brand: 'Not_A Brand', version: '24' },
          ],
          fullVersion: '131.0.0.0',
          platform: 'Windows',
          platformVersion: '15.0.0',
          architecture: 'x86',
          model: '',
          mobile: false,
        },
      });
      await dbg.sendCommand('Emulation.setLocaleOverride', { locale: 'zh-CN' });
      await dbg.sendCommand('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' });
      log.push('UA-CH override applied');
    } catch (e) {
      log.push('UA-CH override failed: ' + e.message);
    }
  }

  await win.loadURL(URL).catch(() => {});
  for (let i = 0; i < 20; i++) {
    await delay(1500);
    const state = await win.webContents
      .executeJavaScript(
        `({ title: document.title, text: (document.body?document.body.innerText:'').slice(0,80).replace(/\\s+/g,' '), href: location.href, webdriver: navigator.webdriver })`,
      )
      .catch(() => null);
    const cookies = await ses.cookies.get({ name: 'cf_clearance' }).catch(() => []);
    log.push(`t=${(i + 1) * 1.5}s title="${state?.title}" text="${state?.text}" wd=${state?.webdriver} clearance=${cookies.length}`);
    if (state && !/请稍候|Just a moment|Checking/i.test(state.title)) break;
  }

  const brands = await win.webContents
    .executeJavaScript('navigator.userAgentData ? JSON.stringify(navigator.userAgentData.brands) : "none"')
    .catch(() => 'err');
  log.push('brands=' + brands);

  fs.writeFileSync(OUT, log.join('\n'), 'utf8');
  app.exit(0);
});
