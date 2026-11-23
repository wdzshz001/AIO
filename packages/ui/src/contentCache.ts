import type { ChapterContent } from '@agg/core';

const DB_NAME = 'agg-content-cache';
const DB_VERSION = 1;
const STORE = 'chapters';
const TTL_MS = 12 * 60 * 60_000;
const MAX_ENTRIES = 80;

interface CacheRecord {
  key: string;
  at: number;
  bytes: number;
  content: ChapterContent;
}

const memory = new Map<string, { at: number; content: ChapterContent }>();
/** 视频页只在本次会话短缓存，避免使用过期签名地址 */
const mediaMemory = new Map<string, { at: number; content: ChapterContent }>();
const MEDIA_TTL_MS = 10 * 60_000;
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') {
        resolve(null);
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('at', 'at');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function requestDone<T>(req: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export function contentCacheKey(siteId: string, url: string): string {
  return `${siteId}|${url}`;
}

/** 视频页短缓存：预取下一集后，自动连播无需重新解析页面 */
export function readMediaCache(key: string): ChapterContent | null {
  const hit = mediaMemory.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > MEDIA_TTL_MS) {
    mediaMemory.delete(key);
    return null;
  }
  return hit.content;
}

export function putMediaCache(key: string, content: ChapterContent): void {
  if (!content.video) return;
  mediaMemory.set(key, { at: Date.now(), content });
}

/** 同步内存命中，阅读器切回同一章时无需等 IndexedDB */
export function readContentCache(key: string): ChapterContent | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    memory.delete(key);
    return null;
  }
  return hit.content;
}

export async function getContentCache(key: string): Promise<ChapterContent | null> {
  const local = readContentCache(key);
  if (local) return local;
  const db = await openDb();
  if (!db) return null;
  const record = await new Promise<CacheRecord | null>((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as CacheRecord | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  if (!record || !record.content || Date.now() - record.at > TTL_MS) return null;
  memory.set(key, { at: record.at, content: record.content });
  return record.content;
}

export async function putContentCache(key: string, content: ChapterContent): Promise<void> {
  // 视频地址通常带时效，漫画/正文才做持久化
  if (content.video || content.streaming || !content) return;
  const record: CacheRecord = {
    key,
    at: Date.now(),
    bytes: JSON.stringify(content).length * 2,
    content,
  };
  memory.set(key, { at: record.at, content });
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(record);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const over = countReq.result - MAX_ENTRIES;
      if (over <= 0) return;
      const cursorReq = store.index('at').openCursor();
      let toDelete = over;
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || toDelete <= 0) return;
        cursor.delete();
        toDelete--;
        cursor.continue();
      };
    };
  } catch {
    /* quota / 私密模式失败就忽略 */
  }
}

export async function contentCacheStats(): Promise<{ count: number; bytes: number }> {
  const db = await openDb();
  if (!db) return { count: 0, bytes: 0 };
  try {
    const count =
      (await requestDone(db.transaction(STORE, 'readonly').objectStore(STORE).count())) ?? 0;
    const all =
      (await requestDone(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) ?? [];
    const bytes = (all as CacheRecord[]).reduce((n, r) => n + (r.bytes || 0), 0);
    return { count, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export async function clearContentCache(): Promise<number> {
  memory.clear();
  mediaMemory.clear();
  const stats = await contentCacheStats();
  const db = await openDb();
  if (!db) return 0;
  try {
    db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    return stats.count;
  } catch {
    return 0;
  }
}
