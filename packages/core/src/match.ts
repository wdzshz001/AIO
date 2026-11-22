/**
 * 标题归一化与匹配，移植自 animeko 的 `MediaListFilters.removeSpecials` /
 * `StringMatcher`（Levenshtein 相似度 80%）。
 *
 * 站点标题和 Bangumi 条目名经常差在：书名号、标点、空格、「剧场版」等标记、
 * 中文数字/罗马数字。归一化后做包含或相似度匹配，才能把同一个作品对齐。
 */

const KEEP_WORDS = ['Re：'];

const REPLACE_WITH_SPACE = new Set(
  Array.from('。、，·・[]～“”~—-!@#$%^&*()_+{}|\\;:\'",.<>/?【】：「」！《》〈〉'),
);

const MARKERS: { word: string; prefixOnly?: boolean }[] = [
  { word: '电影' },
  { word: '剧场版' },
  { word: 'OVA' },
  { word: 'OAD', prefixOnly: false },
  { word: '总集篇' },
];

const CHINESE_DIGITS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const ROMAN: Record<string, number> = {
  X: 10,
  IX: 9,
  VIII: 8,
  VII: 7,
  VI: 6,
  V: 5,
  IV: 4,
  III: 3,
  II: 2,
  I: 1,
};

function chineseToNumber(text: string): number | null {
  if (!text) return null;
  if (text.length === 1) return CHINESE_DIGITS[text] ?? null;
  // 十一 ~ 十九、二十 ~ 九十九
  if (text.startsWith('十') && text.length === 2) {
    return 10 + (CHINESE_DIGITS[text[1]] ?? 0);
  }
  if (text.endsWith('十') && text.length === 2) {
    return (CHINESE_DIGITS[text[0]] ?? 0) * 10;
  }
  if (text.length === 3 && text[1] === '十') {
    return (CHINESE_DIGITS[text[0]] ?? 0) * 10 + (CHINESE_DIGITS[text[2]] ?? 0);
  }
  return null;
}

/**
 * @param removeWhitespace 删除所有空白
 * @param replaceNumbers 中文数字/罗马数字转阿拉伯数字
 * @param removeMarkers 删除「电影」「剧场版」等仅有标记作用的词
 */
export function removeSpecials(
  input: string,
  opts: { removeWhitespace?: boolean; replaceNumbers?: boolean; removeMarkers?: boolean } = {},
): string {
  const { removeWhitespace = false, replaceNumbers = false, removeMarkers = false } = opts;
  let s = input ?? '';

  // 1. 保护必须原样保留的词
  const masks = new Map<string, string>();
  KEEP_WORDS.forEach((word, i) => {
    const mask = `\uE001${i}\uE002`;
    if (s.includes(word)) {
      masks.set(mask, word);
      s = s.split(word).join(mask);
    }
  });

  // 2. 删除标记词
  if (removeMarkers) {
    for (const { word } of MARKERS) {
      s = s.split(word).join('');
    }
  }

  // 3. 特殊字符替换为空格
  let out = '';
  for (const ch of s) {
    out += REPLACE_WITH_SPACE.has(ch) ? ' ' : ch;
  }
  s = out;

  // 4. 中文数字 / 罗马数字
  if (replaceNumbers) {
    s = s.replace(/第([一二三四五六七八九十]{1,3})/g, (m, n: string) => {
      const v = chineseToNumber(n);
      return v == null ? m : `第${v}`;
    });
    s = s.replace(/([一二三四五六七八九十]{1,3})(?=[季期话話集章部卷])/g, (m, n: string) => {
      const v = chineseToNumber(n);
      return v == null ? m : String(v);
    });
    // 结尾的罗马数字：ソードアート・オンラインII / 第二季 II
    s = s.replace(/(^|[\s\u4e00-\u9fff])(X|IX|VIII|VII|VI|IV|III|II|V|I)(?=\s|$)/g, (m, pre: string, r: string) => {
      return `${pre}${ROMAN[r] ?? r}`;
    });
  }

  // 5. 空白
  if (removeWhitespace) {
    s = s.replace(/\s+/g, '');
  } else {
    s = s.replace(/[ \t\u3000]+/g, ' ').trim();
  }

  for (const [mask, word] of masks) s = s.split(mask).join(word);
  return s.trim();
}

/** 参与比较的归一化形式 */
export function normalizeTitle(title: string): string {
  return removeSpecials(title, { removeWhitespace: true, replaceNumbers: true });
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** 0..100，与 ani 的 StringMatcher.calculateMatchRate 一致 */
export function titleMatchScore(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na && !nb) return 100;
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  if ((na.includes(nb) || nb.includes(na)) && Math.min(na.length, nb.length) >= 2) {
    return 100;
  }
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return Math.max(0, Math.min(100, Math.trunc((1 - dist / maxLen) * 100)));
}

/** 站点标题是否命中条目的任意一个名字 */
export function matchesAnyTitle(
  candidate: string,
  names: string[],
  threshold = 80,
): boolean {
  return names.some((name) => {
    const n = normalizeTitle(name);
    if (!n) return false;
    return titleMatchScore(candidate, name) >= threshold;
  });
}

/**
 * 在候选标题里挑出与条目最像的一个。
 * 先看分数，再看标题长度（ani 的 preferShorterName：搜索「第一季」时避免先匹配到「第二季」）。
 */
export function pickBestTitle(
  candidates: { title: string }[],
  names: string[],
  opts: { preferShorterName?: boolean; threshold?: number } = {},
): { index: number; score: number } | null {
  const { preferShorterName = true, threshold = 80 } = opts;
  let bestIndex = -1;
  let bestScore = 0;
  let bestLen = Infinity;
  for (let index = 0; index < candidates.length; index++) {
    const title = candidates[index].title;
    let score = 0;
    for (const name of names) {
      const s = titleMatchScore(title, name);
      if (s > score) score = s;
    }
    if (score < threshold) continue;
    const len = normalizeTitle(title).length;
    if (
      bestIndex < 0 ||
      score > bestScore ||
      (score === bestScore && preferShorterName && len < bestLen)
    ) {
      bestIndex = index;
      bestScore = score;
      bestLen = len;
    }
  }
  return bestIndex >= 0 ? { index: bestIndex, score: bestScore } : null;
}
