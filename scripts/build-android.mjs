import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll, OUT, ROOT } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ANDROID_ROOT = path.join(ROOT, 'apps/android');
const WWW = path.join(ANDROID_ROOT, 'app/src/main/assets/www');

await buildAll();
fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

for (const name of ['index.html', 'renderer.js', 'renderer.css']) {
  fs.copyFileSync(path.join(OUT, name), path.join(WWW, name));
}
fs.copyFileSync(path.join(ANDROID_ROOT, 'android-bridge.js'), path.join(WWW, 'android-bridge.js'));

const indexPath = path.join(WWW, 'index.html');
let html = fs.readFileSync(indexPath, 'utf8');
html = html.replace(
  '<script defer src="./renderer.js"></script>',
  '<script src="./android-bridge.js"></script>\n    <script defer src="./renderer.js"></script>',
);
// 手机布局：让 WebView 使用安全区并禁止双击缩放
html = html.replace(
  '<meta name="viewport" content="width=device-width, initial-scale=1" />',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />',
);
fs.writeFileSync(indexPath, html);
console.log('android www ready:', WWW);
