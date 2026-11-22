/** 折叠空白、去零宽字符 */
export function clean(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

/** 元素文本 */
export function text(el: Element | null | undefined): string {
  return clean(el?.textContent ?? '');
}

export function attr(el: Element | null | undefined, name: string): string {
  if (!el) return '';
  const v = el.getAttribute(name);
  if (!v) return '';
  if (name === 'href' || name === 'src') {
    // 懒加载常见写法
    return (
      v ||
      el.getAttribute('data-src') ||
      el.getAttribute('data-original') ||
      el.getAttribute('data-echo') ||
      ''
    );
  }
  return v;
}

export function absUrl(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  if (!h || h.startsWith('#') || h.startsWith('javascript:')) return undefined;
  try {
    return new URL(h, base).toString();
  } catch {
    return undefined;
  }
}

export function qs<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T | null {
  return root.querySelector<T>(selector);
}

export function qsa<T extends Element = Element>(
  root: ParentNode,
  selector: string,
): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** 在候选选择器里取第一个命中的元素 */
export function first(root: ParentNode, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** 按链接文字找链接 */
export function linkByText(root: ParentNode, re: RegExp): HTMLAnchorElement | null {
  for (const a of qsa<HTMLAnchorElement>(root, 'a[href]')) {
    if (re.test(text(a))) return a;
  }
  return null;
}

/**
 * 把一块富文本转成段落数组。
 * 同时兼容 <br> 分行、<p> 分行、纯文本换行。
 */
export function toParagraphs(el: Element | null): string[] {
  if (!el) return [];
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('script,style,noscript,iframe,ins,.adsbygoogle').forEach((n) => n.remove());
  // <br> 统一变成换行符
  clone.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  // 块级元素之间补换行，避免段落粘连
  clone.querySelectorAll('p,div,h1,h2,h3,h4,li,tr').forEach((b) => b.append('\n'));
  const raw = (clone.textContent ?? '').replace(/\u00a0/g, ' ');
  return raw
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[\u200b-\u200f\ufeff]/g, '')
        .replace(/^[\s\u3000]+|[\s\u3000]+$/g, ''),
    )
    .filter((line) => line.length > 0);
}

/** 删掉拦在内容前面的遮罩层 / 拦截页 */
export function stripOverlays(doc: Document): void {
  const junk = [
    '.modal-backdrop',
    '.popup-mask',
    '.app-download',
    '.download-app',
    '.open-app',
    '#app-download',
    '.layui-layer-shade',
  ];
  for (const sel of junk) {
    doc.querySelectorAll(sel).forEach((n) => n.remove());
  }
}

export function parseHtml(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

/** 统一章节名，去掉末尾多余符号 */
export function normalizeChapterTitle(s: string): string {
  return clean(s).replace(/[（(]\d+[）)]$/, '');
}
