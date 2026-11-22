/** 根据播放地址判断播放器类型（拿不到 Content-Type 时按经验判断） */
export function videoKindOf(url: string): 'hls' | 'mp4' {
  const u = (url || '').toLowerCase();
  if (/\.mp4(?:[?#]|$)/.test(u)) return 'mp4';
  if (/\.(?:flv|mkv|m4v|webm|mov)(?:[?#]|$)/.test(u)) return 'mp4';
  return 'hls';
}
