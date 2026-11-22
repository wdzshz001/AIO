import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const release = path.join(root, 'release');
const version = (process.env.HOT_VERSION || process.env.GITHUB_REF_NAME || '0.1.4')
  .replace(/^v/i, '')
  .trim();

fs.mkdirSync(release, { recursive: true });
const manifest = {
  version,
  apkUrl: 'https://github.com/wdzshz001/AIO/releases/latest/download/agg-reader-android.apk',
  publishedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(release, 'android-latest.json'), JSON.stringify(manifest, null, 2));
console.log(`android update manifest ${version}`);
