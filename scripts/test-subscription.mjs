import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSite, normalizeKeyword } from '../packages/adapters/src/subscription/engine.ts';
import { jsonPath } from '../packages/adapters/src/subscription/jsonpath.ts';

const file = new URL('../_ref/subscription.json', import.meta.url);
if (!fs.existsSync(file)) {
  console.log('subscription.json 不存在，跳过');
  process.exit(0);
}

const json = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(json.schemaVersion, 2);
assert.ok(json.mediaSources.length >= 20);

const sites = json.mediaSources.map((src) => {
  const site = buildSite(src);
  assert.ok(site, `buildSite(${src.id}) 返回 null`);
  assert.ok(site.baseUrl, `${src.id} 没有 baseUrl`);
  assert.ok(site.id.startsWith('sub:'), `${src.id} id 前缀不对`);
  return site;
});

// girigiri 的搜索接口在 m3u8 域名，但详情页在 bg 域名（rawBaseUrl），这是旧实现 0 结果的根因
const girigiri = sites.find((s) => s.id === 'sub:girigiri-ai-dongman');
assert.ok(girigiri, '缺少 girigiri');
assert.equal(girigiri.baseUrl, 'https://bg.girigirilove.com');

// json-path 源应该被识别（2k / Anime7 / girigiri）
const twoK = sites.find((s) => s.id === 'sub:2k-dongman');
assert.ok(twoK);

// json-api 工厂（稀饭 Next）应该也能构建
const next = sites.find((s) => s.id === 'sub:xifan-dongman-next');
assert.ok(next, 'json-api 源没有构建出来');

// 关键词归一化：去特殊符号、去「剧场版」、取首词
const cfg = json.mediaSources.find((s) => s.id === 'fanqie-dongman').arguments.searchConfig;
assert.equal(normalizeKeyword('【剧场版】孤独摇滚！ 第二季', cfg), '孤独摇滚');

// 极简 JSONPath
const data = { list: [{ id: 11, name: 'A' }, { id: 12, name: 'B' }] };
assert.deepEqual(jsonPath(data, '$.list[*].id'), [11, 12]);
assert.deepEqual(jsonPath({ info: { rows: [{ vod_id: 'x' }] } }, '$.info.rows[*].vod_id'), ['x']);

console.log(`subscription tests OK (${sites.length} sources)`);
