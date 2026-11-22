import type { HostBridge } from '@agg/core';

declare global {
  interface Window {
    agg: HostBridge & { platform: string };
  }
}

export const bridge: HostBridge = window.agg;

export const platform: string = window.agg?.platform ?? 'web';
