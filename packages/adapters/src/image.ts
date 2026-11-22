/**
 * 图片代理：漫画站（云漫画、MYCOMIC）的图片 CDN 校验 Referer，
 * 不能让渲染进程直接加载，统一走主进程 aggmedia 代理。
 */
export function proxyImage(
  url: string | null | undefined,
  referer: string,
): string | undefined {
  if (!url) return undefined;
  let abs = url.trim();
  if (!abs) return undefined;
  if (abs.startsWith('aggmedia://')) return abs;
  if (abs.startsWith('//')) abs = 'https:' + abs;
  if (!/^https?:\/\//i.test(abs)) return abs;
  const agg = (globalThis as { agg?: { platform?: string; proxyUrl?: (u: string, r: string) => string } }).agg;
  if (agg?.platform === 'android' && typeof agg.proxyUrl === 'function') {
    return agg.proxyUrl(abs, referer) || abs;
  }
  const p = new URLSearchParams({ u: abs });
  if (referer) p.set('r', referer);
  return `aggmedia://stream/?${p.toString()}`;
}
