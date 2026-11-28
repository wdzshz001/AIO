import { Converter } from 'opencc-js';

let converter: ((text: string) => string) | null = null;

/** 标题匹配用：繁体 → 简体，避免书源书名是繁体时误判为不同作品 */
export function toSimplified(text: string): string {
  if (!text) return text;
  try {
    converter ??= Converter({ from: 't', to: 'cn' });
    return converter(text);
  } catch {
    return text;
  }
}
