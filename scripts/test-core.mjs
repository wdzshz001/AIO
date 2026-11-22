import assert from 'node:assert/strict';
import {
  convertSpecialEpisode,
  episodeSortContains,
  formatEpisodeSort,
  matchEpisodeSortFromName,
  matchingEpisodeSortOf,
  parseEpisodeSort,
} from '../packages/core/src/episode.ts';
import {
  matchesAnyTitle,
  normalizeTitle,
  removeSpecials,
  titleMatchScore,
} from '../packages/core/src/match.ts';

const eq = (raw, kind, number, type) => {
  const s = parseEpisodeSort(raw);
  assert.equal(s.kind, kind, `parse(${raw}).kind`);
  if (number !== undefined) assert.equal(s.number, number, `parse(${raw}).number`);
  if (type) assert.equal(s.type, type, `parse(${raw}).type`);
};

// 集号
eq('01', 'normal', 1);
eq('1', 'normal', 1);
eq('1.5', 'normal', 1.5);
eq('SP01', 'special', 1, 'SP');
eq('OVA2', 'special', 2, 'OVA');
eq('第1集', 'unknown');
eq('', 'unknown');
assert.equal(formatEpisodeSort(parseEpisodeSort('1')), '01');
assert.equal(formatEpisodeSort(parseEpisodeSort('12')), '12');
assert.equal(formatEpisodeSort(parseEpisodeSort('1.5')), '1.5');
assert.equal(formatEpisodeSort(parseEpisodeSort('SP1')), 'SP01');

// 从标题里解析
const re = '第\\s*(?<ep>.+)\\s*[话集]';
assert.equal(formatEpisodeSort(matchEpisodeSortFromName('第12集', re)), '12');
assert.equal(formatEpisodeSort(matchEpisodeSortFromName('第3话 高清', re)), '03');
assert.equal(formatEpisodeSort(matchEpisodeSortFromName('12', '')), '12');
assert.equal(formatEpisodeSort(matchEpisodeSortFromName('正片', re)), '01');
assert.equal(formatEpisodeSort(convertSpecialEpisode('正片', null)), '01');
assert.equal(
  formatEpisodeSort(matchingEpisodeSortOf('HD高清国语版', parseEpisodeSort('HD高清国语版'))),
  '01',
);

// 跨源匹配：SP01 与 01 数字相同也能对上
assert.equal(episodeSortContains(parseEpisodeSort('1'), parseEpisodeSort('SP01')), true);
assert.equal(episodeSortContains(parseEpisodeSort('2'), parseEpisodeSort('1')), false);

// 标题归一化（匹配时故意保留「电影/剧场版」等标记词，靠包含/相似度对齐，见 ani #1794）
assert.equal(
  normalizeTitle('【电影】孤独摇滚！ 第二季'),
  '电影孤独摇滚第2季',
);
assert.ok(normalizeTitle('【电影】孤独摇滚！ 第二季').includes('孤独摇滚第2季'));
assert.ok(titleMatchScore('电影 孤独摇滚！第二季', '孤独摇滚 第2季') >= 80);
assert.equal(removeSpecials('剧场版 命运石之门', { removeMarkers: true, removeWhitespace: true }), '命运石之门');
assert.equal(titleMatchScore('孤独摇滚！第二季', '孤独摇滚 第2季'), 100);
assert.equal(matchesAnyTitle('孤独摇滚！第二季 第01集', ['孤独摇滚！第二季']), true);
assert.equal(matchesAnyTitle('进击的巨人', ['孤独摇滚！第二季']), false);

console.log('core tests OK');
