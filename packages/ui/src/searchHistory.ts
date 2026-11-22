const KEY = 'agg.searchHistory.v1';
const MAX = 12;

export function loadSearchHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, MAX);
  } catch {
    return [];
  }
}

export function addSearchHistory(query: string): string[] {
  const q = query.trim();
  if (!q) return loadSearchHistory();
  const list = [q, ...loadSearchHistory().filter((x) => x !== q)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}

export function clearSearchHistory(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
