import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const [url, waitFor, ua, tag] = process.argv.slice(2);
if (!url) {
  console.error('usage: node scripts/probe.mjs <url> [waitForSelector] [ua] [tag]');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (ua) env.AGG_UA = ua;
if (tag) env.AGG_TAG = tag;

const args = ['probe-main.cjs', url];
if (waitFor) args.push(waitFor);
const r = spawnSync(electronPath, args, { cwd: here, env, stdio: 'ignore', timeout: 120_000 });
process.exit(r.status ?? 0);
