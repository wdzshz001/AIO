/**
 * 图片预取：只预取当前页附近的少量图片，使用 2 个并发，避免一次性拉完整话。
 * 图片最终仍由原生代理/浏览器缓存；这里只负责把网络请求提前。
 */
const preloaded = new Set<string>();
const queue: string[] = [];
let running = 0;
const MAX_CONCURRENT = 2;

function pump(): void {
  while (running < MAX_CONCURRENT && queue.length) {
    const src = queue.shift();
    if (!src) break;
    running++;
    const img = new Image();
    const done = () => {
      running--;
      pump();
    };
    img.onload = done;
    img.onerror = done;
    img.src = src;
  }
}

export function preloadImages(urls: string[]): void {
  for (const src of urls) {
    if (!src || preloaded.has(src)) continue;
    preloaded.add(src);
    queue.push(src);
  }
  pump();
}

export function preloadImageWindow(images: string[], page: number, ahead = 5, behind = 1): void {
  if (!images.length) return;
  const start = Math.max(0, page - 1 - behind);
  const end = Math.min(images.length, page + ahead);
  preloadImages(images.slice(start, end));
}
