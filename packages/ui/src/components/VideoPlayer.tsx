import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

interface Props {
  src: string;
  kind: 'hls' | 'mp4';
  poster?: string;
  referer?: string;
  userAgent?: string;
  cookies?: string;
  /** 续播位置（秒） */
  startAt?: number;
  /** 默认倍速 */
  rate?: number;
  /** 默认静音 */
  muted?: boolean;
  /** 进入页面自动播放（默认开启） */
  autoPlay?: boolean;
  /** HLS 首选高度（720 / 1080） */
  preferredHeight?: number;
  onEnded?: () => void;
  onProgress?: (currentTime: number, duration: number) => void;
  onError?: (message: string) => void;
}

/**
 * 所有请求都走主进程的 aggmedia 代理：
 * 渲染进程直连 CDN 会被 CORS / 防盗链挡住，代理负责补 UA、Referer、Cookie 和 Range。
 */
function proxy(
  src: string,
  referer?: string,
  userAgent?: string,
  cookies?: string,
  bust?: number,
): string {
  const agg = (globalThis as {
    agg?: { platform?: string; proxyUrl?: (u: string, r: string, ua: string, ck: string) => string };
  }).agg;
  if (agg?.platform === 'android' && typeof agg.proxyUrl === 'function') {
    return agg.proxyUrl(src, referer ?? '', userAgent ?? '', cookies ?? '') || src;
  }
  const p = new URLSearchParams({ u: src });
  if (referer) p.set('r', referer);
  if (userAgent) p.set('ua', userAgent);
  if (cookies) p.set('ck', cookies);
  if (bust) p.set('cb', String(bust));
  return `aggmedia://stream/?${p.toString()}`;
}

export default function VideoPlayer({
  src,
  kind,
  poster,
  referer,
  userAgent,
  cookies,
  startAt,
  rate,
  muted,
  autoPlay = true,
  preferredHeight,
  onEnded,
  onProgress,
  onError,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const startRef = useRef(startAt);
  startRef.current = startAt;
  /**
   * 0: 正常代理；1: 代理 + 缓存参数重试；2: mp4 直连（不再经过代理）。
   * CDN 偶发返回不完整 Range / Chromium 缓存坏响应时，自动降级而不是黑屏。
   */
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const isAndroid =
    (globalThis as { agg?: { platform?: string } }).agg?.platform === 'android';

  // Android：进入视频页默认横屏全屏，离开时恢复
  useEffect(() => {
    const agg = (globalThis as {
      agg?: { platform?: string; setVideoFullscreen?: (on: boolean) => unknown };
    }).agg;
    if (agg?.platform === 'android' && typeof agg.setVideoFullscreen === 'function') {
      void agg.setVideoFullscreen(true);
      return () => {
        void agg.setVideoFullscreen?.(false);
      };
    }
    return undefined;
  }, []);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let alive = true;

    const useDirect = attempt >= 2 && kind === 'mp4';
    const url = useDirect
      ? src
      : proxy(src, referer, userAgent, cookies, attempt > 0 ? Date.now() : undefined);
    const useHls = kind === 'hls' && !useDirect && Hls.isSupported();

    const retry = (reason: string) => {
      if (!alive) return;
      if (attemptRef.current < 2) {
        setAttempt(attemptRef.current + 1);
        return;
      }
      onError?.(reason);
    };

    const seekToStart = () => {
      const at = startRef.current;
      if (at && at > 3 && Number.isFinite(video.duration) && at < video.duration - 5) {
        video.currentTime = at;
      }
    };
    const startPlayback = () => {
      if (!alive || !autoPlay) return;
      const p = video.play();
      if (p && typeof p.catch === 'function') p.catch(() => undefined);
    };
    const onMeta = () => {
      seekToStart();
      startPlayback();
    };
    video.addEventListener('loadedmetadata', onMeta, { once: true });
    video.addEventListener('canplay', startPlayback, { once: true });

    let hls: Hls | null = null;
    const onNativeError = () => {
      const err = video.error;
      retry(`视频加载失败${err ? `（code ${err.code}${err.message ? `：${err.message}` : ''}）` : ''}`);
    };
    video.addEventListener('error', onNativeError);

    if (!useHls) {
      video.dataset.hlsState = useDirect ? 'direct' : 'native';
      video.src = url;
    } else {
      video.dataset.hlsState = 'hls-init';
      // Android WebView 的 file:// 页面里 hls.js Worker 容易失败，关闭 Worker 走主线程
      hls = new Hls({ enableWorker: !isAndroid, lowLatencyMode: false });
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.dataset.hlsState = 'manifest-parsed';
        if (preferredHeight && hls && hls.levels.length) {
          let best = 0;
          let diff = Number.POSITIVE_INFINITY;
          hls.levels.forEach((lvl, i) => {
            const d = Math.abs((lvl.height || 0) - preferredHeight);
            if (d < diff) {
              diff = d;
              best = i;
            }
          });
          hls.currentLevel = best;
        }
        seekToStart();
        startPlayback();
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        video.dataset.hlsState = `${data.type}/${data.details}/fatal=${data.fatal}`;
        if (data.fatal) retry(`播放失败：${data.details}`);
      });
    }

    return () => {
      alive = false;
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('canplay', startPlayback);
      video.removeEventListener('error', onNativeError);
      if (hls) hls.destroy();
      else {
        video.removeAttribute('src');
        video.load();
      }
    };
  }, [src, kind, referer, userAgent, cookies, attempt, onError, preferredHeight, autoPlay, isAndroid]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.playbackRate = rate && rate > 0 ? rate : 1;
    video.muted = !!muted;
  }, [rate, muted]);

  return (
    <video
      ref={ref}
      className="player"
      controls
      playsInline
      autoPlay={autoPlay}
      poster={poster}
      data-src-url={src}
      data-referer={referer ?? ''}
      data-ua={userAgent ?? ''}
      data-cookies={cookies ?? ''}
      data-attempt={attempt}
      onEnded={() => onEnded?.()}
      onTimeUpdate={(e) => {
        const v = e.currentTarget;
        if (v.duration && Number.isFinite(v.duration)) onProgress?.(v.currentTime, v.duration);
      }}
    />
  );
}
