import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, effectiveNsfw, filterSites } from '../packages/ui/src/store.ts';

const safe = { id: 'safe', name: 'Safe', baseUrl: 'https://safe', kind: 'novel' };
const adult = { id: 'adult', name: 'Adult', baseUrl: 'https://adult', kind: 'comic', nsfw: true };
const sites = [safe, adult];

// 默认飞行模式关闭（升级 v2 时也重置一次）
assert.equal(DEFAULT_SETTINGS.flightMode, false);
assert.equal(DEFAULT_SETTINGS.settingsVersion, 3);

const off = { flightMode: false, sourceNsfw: {} };
const on = { flightMode: true, sourceNsfw: {} };

// 飞行模式关闭：隐藏被标记的源
assert.equal(filterSites(sites, off).length, 1);
assert.equal(filterSites(sites, off)[0].id, 'safe');
assert.equal(effectiveNsfw(adult, off), true);

// 飞行模式开启：显示全部源（含已标记）
assert.equal(filterSites(sites, on).length, 2);

// 用户可以把安全源也标记为 NSFW，关闭时一并隐藏
assert.equal(filterSites(sites, { flightMode: false, sourceNsfw: { safe: true } }).length, 0);

// 用户也可以把默认成人源放出来
assert.equal(
  filterSites(sites, { flightMode: false, sourceNsfw: { adult: false } }).length,
  2,
);

// 开启时无论怎么标记都显示
assert.equal(filterSites(sites, { flightMode: true, sourceNsfw: { safe: true, adult: true } }).length, 2);

// 手动禁用的源在飞行模式开启时也不出现
assert.deepEqual(
  filterSites(sites, {
    flightMode: true,
    sourceNsfw: {},
    sourceEnabled: { adult: false },
  }).map((s) => s.id),
  ['safe'],
);

// 首选源排到同分类最前
const ranked = filterSites(
  [
    { id: 'a', name: 'A', baseUrl: 'https://a', kind: 'anime' },
    { id: 'b', name: 'B', baseUrl: 'https://b', kind: 'anime' },
  ],
  {
    flightMode: true,
    sourceNsfw: {},
    preferredSource: { anime: 'b' },
  },
);
assert.deepEqual(ranked.map((s) => s.id), ['b', 'a']);

// 排序权重
const byRank = filterSites(
  [
    { id: 'a', name: 'A', baseUrl: 'https://a', kind: 'novel' },
    { id: 'b', name: 'B', baseUrl: 'https://b', kind: 'novel' },
  ],
  {
    flightMode: true,
    sourceNsfw: {},
    sourceRank: { a: 2, b: 1 },
  },
);
assert.deepEqual(byRank.map((s) => s.id), ['b', 'a']);

console.log('settings tests OK');
