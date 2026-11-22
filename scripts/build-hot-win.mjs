import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildAll, OUT, ROOT } from './build.mjs';

const release = path.join(ROOT, 'release');
const stage = path.join(release, 'hot-win');
const version = (process.env.HOT_VERSION || process.env.GITHUB_REF_NAME || '0.0.1')
  .replace(/^v/i, '')
  .trim();

await buildAll();
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

const files = {};
for (const name of ['index.html', 'renderer.js', 'renderer.css']) {
  const from = path.join(OUT, name);
  const to = path.join(stage, name);
  fs.copyFileSync(from, to);
  files[name] = crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex');
  // GitHub Release 资产名统一用 hot-win- 前缀
  fs.copyFileSync(to, path.join(release, `hot-win-${name}`));
}

const manifest = {
  version,
  builtAt: new Date().toISOString(),
  files,
};
const text = JSON.stringify(manifest, null, 2);
fs.writeFileSync(path.join(stage, 'hot-win.json'), text);
fs.writeFileSync(path.join(release, 'hot-win.json'), text);
console.log(`hot-win bundle ${version} -> ${stage}`);
