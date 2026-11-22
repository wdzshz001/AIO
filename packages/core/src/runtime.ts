/** 运行时可调参数：由设置页写入，core/adapters 在请求时读取 */
export interface RuntimeConfig {
  /** HTML 缓存时长；0 表示不缓存 */
  htmlTtlMs: number;
  /** 动画选源并发数 */
  searchConcurrency: number;
  /** 漫画/图片预加载 */
  imagePreload: boolean;
}

export const runtime: RuntimeConfig = {
  htmlTtlMs: 5 * 60_000,
  searchConcurrency: 6,
  imagePreload: true,
};

export function configureRuntime(patch: Partial<RuntimeConfig>): void {
  if (patch.htmlTtlMs != null && Number.isFinite(patch.htmlTtlMs)) {
    runtime.htmlTtlMs = Math.max(0, patch.htmlTtlMs);
  }
  if (patch.searchConcurrency != null && Number.isFinite(patch.searchConcurrency)) {
    runtime.searchConcurrency = Math.max(1, Math.min(12, patch.searchConcurrency));
  }
  if (patch.imagePreload != null) runtime.imagePreload = !!patch.imagePreload;
}
