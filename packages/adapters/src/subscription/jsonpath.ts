/**
 * 极简 JSONPath：只支持订阅里实际出现过的写法
 *   $.list[*]['id']
 *   $.info.rows[*].vod_id
 *   $[*]['url', 'link']
 * 返回匹配到的原始值数组。
 */
export function jsonPath(data: unknown, path: string): unknown[] {
  const tokens = tokenize(path);
  let current: unknown[] = [data];

  for (const token of tokens) {
    const next: unknown[] = [];
    for (const node of current) {
      if (token === '*') {
        if (Array.isArray(node)) next.push(...node);
        else if (node && typeof node === 'object') next.push(...Object.values(node));
        continue;
      }
      if (Array.isArray(token)) {
        if (node && typeof node === 'object') {
          for (const key of token) {
            const v = (node as Record<string, unknown>)[key];
            if (v !== undefined) next.push(v);
          }
        }
        continue;
      }
      if (node && typeof node === 'object') {
        const v = (node as Record<string, unknown>)[token];
        if (v !== undefined) next.push(v);
      }
    }
    current = next;
  }

  return current;
}

function tokenize(path: string): (string | string[])[] {
  const p = path.trim().replace(/^\$/, '');
  const tokens: (string | string[])[] = [];
  let i = 0;

  while (i < p.length) {
    if (p[i] === '.') {
      i++;
      continue;
    }
    if (p[i] === '[') {
      const end = p.indexOf(']', i);
      if (end < 0) break;
      const inner = p.slice(i + 1, end).trim();
      if (inner === '*') {
        tokens.push('*');
      } else if (inner.startsWith("'") || inner.startsWith('"')) {
        const keys = inner
          .split(',')
          .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
        tokens.push(keys);
      } else {
        tokens.push(inner.replace(/^['"]|['"]$/g, ''));
      }
      i = end + 1;
      continue;
    }
    let j = i;
    while (j < p.length && p[j] !== '.' && p[j] !== '[') j++;
    const name = p.slice(i, j).trim();
    if (name) tokens.push(name);
    i = j;
  }

  return tokens;
}
