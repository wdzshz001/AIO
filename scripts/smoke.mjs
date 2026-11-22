import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import electronPath from 'electron';
import { buildAll, ROOT } from './build.mjs';

// 冒烟测试：自动走完 首页 → 站点 → 书籍 → 阅读 → 翻章，并截图到 _probe/
await buildAll();

const out = process.env.AGG_SMOKE_OUT || path.join(ROOT, '_probe');
fs.mkdirSync(out, { recursive: true });

const env = { ...process.env, AGG_SMOKE: '1', AGG_SMOKE_OUT: out };
if (process.env.AGG_SMOKE_INDEX) env.AGG_SMOKE_INDEX = process.env.AGG_SMOKE_INDEX;
delete env.ELECTRON_RUN_AS_NODE;

const r = spawnSync(electronPath, ['.'], {
  cwd: path.join(ROOT, 'apps/desktop'),
  stdio: 'ignore',
  env,
  timeout: 300_000,
});

const logFile = path.join(out, 'smoke.log');
if (fs.existsSync(logFile)) {
  console.log(fs.readFileSync(logFile, 'utf8'));
} else {
  console.log('没有产生 smoke.log，Electron 可能没有正常启动');
}

process.exit(r.status ?? 0);
