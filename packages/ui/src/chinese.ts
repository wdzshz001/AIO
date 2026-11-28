import { Converter } from 'opencc-js';
import { loadPrefs } from './store';

let converter: ((text: string) => string) | null = null;
const memo = new Map<string, string>();

/** 繁體 → 简体（OpenCC t2s）。失败时原样返回，避免影响阅读。 */
export function toSimplified(text: string | undefined | null): string {
  if (!text) return text ?? '';
  const cached = memo.get(text);
  if (cached != null) return cached;
  try {
    converter ??= Converter({ from: 't', to: 'cn' });
    const converted = converter(text);
    if (memo.size > 4000) memo.clear();
    memo.set(text, converted);
    return converted;
  } catch {
    return text;
  }
}

/** 按当前阅读设置转换显示文本（卡片、列表、详情通用） */
export function displayText(text: string | undefined | null): string {
  const value = text ?? '';
  return loadPrefs().t2s ? toSimplified(value) : value;
}
