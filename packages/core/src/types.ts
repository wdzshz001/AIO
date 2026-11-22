export type SiteKind = 'novel' | 'forum' | 'comic' | 'anime';

/**
 * 「应用」是聚合层：一个应用把同一类站点合在一起展示，
 * 例如「小说」应用同时包含多个小说站。用户只需要面对应用，不用管站点。
 */
export interface AppDef {
  id: string;
  name: string;
  icon: string;
  color: string;
  kinds: SiteKind[];
  desc?: string;
}

export interface BookRef {
  /** 绝对地址 */
  url: string;
  title: string;
  author?: string;
  cover?: string;
  intro?: string;
  /** 附加信息，如「连载中」「已完结」 */
  extra?: string;
}

export interface BookSection {
  title: string;
  books: BookRef[];
  /** 「更多」入口：站点上该板块的完整列表页 */
  moreUrl?: string;
}

export interface Chapter {
  title: string;
  url: string;
  /** 解析出的集号，如 "01"、"SP01"（动画/分卷站点） */
  sort?: string;
  /** 线路 / 频道名（订阅源的多线路） */
  channel?: string;
  /** 集号排序键，越小越靠前 */
  order?: number;
  /** 需要登录/订阅/购买才能读（起点等） */
  locked?: boolean;
}

export interface BookDetail extends BookRef {
  status?: string;
  chapters: Chapter[];
  /** 站点提供的线路/频道列表 */
  channels?: string[];
}

export interface ChapterContent {
  title: string;
  paragraphs: string[];
  /** 图片内容（漫画）：按阅读顺序排列，值为可直接放入 <img> 的地址 */
  images?: string[];
  /** 视频内容（动画站）：有值时播放器优先于正文 */
  video?: VideoInfo;
  prev?: string;
  next?: string;
  /** 分页章节仍在后台加载后续内容 */
  streaming?: boolean;
}

export interface VideoInfo {
  url: string;
  kind: 'hls' | 'mp4';
  poster?: string;
  /** 播放时需要带的 Referer（CDN 防盗链） */
  referer?: string;
  /** 播放时需要带的 User-Agent（部分源要求与抓取时一致） */
  userAgent?: string;
  /** 播放时需要带的 Cookie，如 "quality=1080" */
  cookies?: string;
}

export interface FetchResult {
  /** 最终地址（可能被重定向） */
  url: string;
  status: number;
  html: string;
}

/** 通用 HTTP 请求（JSON API / Bangumi / 需要自定义 UA 与头的场景） */
export interface HttpRequestOpts {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  url: string;
  status: number;
  body: string;
  contentType?: string;
}

export interface HarvestLink {
  url: string;
  text: string;
}

/** 播放页嗅探到的媒体地址 */
export interface MediaCapture {
  url: string;
  referer?: string;
}

export interface RenderOpts {
  /** 等待该选择器出现后再取 HTML */
  waitFor?: string;
  timeoutMs?: number;
  /** 渲染前先滚动到底，触发懒加载 */
  scroll?: boolean;
}

/**
 * 平台桥。桌面端由 Electron 主进程实现，
 * 安卓端由 Capacitor 插件实现，上层代码不感知差异。
 */
export interface HostBridge {
  fetchHtml(siteId: string, url: string, referer?: string): Promise<FetchResult>;
  /** 带 method / headers / body 的通用请求 */
  request(siteId: string, url: string, opts?: HttpRequestOpts): Promise<HttpResponse>;
  renderHtml(siteId: string, url: string, opts?: RenderOpts): Promise<FetchResult>;
  /**
   * 页面里的"链接"是 JS 点击才能拿到的（服务端不输出 href）时，
   * 用真实输入事件依次点开并拦截跳转，把 URL 收回来。
   */
  harvestLinks(siteId: string, url: string, selector: string, limit?: number): Promise<HarvestLink[]>;
  /**
   * 在前台页面里构造并提交一个表单（搜索/登录/回帖这类只能 POST 的接口），
   * 提交动作交给浏览器的真实导航，能自动处理 JS 跳转与 Cookie。
   */
  submitForm(
    siteId: string,
    pageUrl: string,
    actionUrl: string,
    fields: Record<string, string>,
    opts?: FormOpts,
  ): Promise<FetchResult>;
  /**
   * 播放页的 iframe / 播放器是 JS 动态生成的，
   * 打开真实页面并监听网络请求，把 m3u8 / mp4 地址截下来。
   */
  captureMedia(
    siteId: string,
    pageUrl: string,
    opts?: CaptureOpts,
  ): Promise<MediaCapture | null>;
  /**
   * 打开可见窗口让用户过一次人机验证（Cloudflare 等），
   * 通过后 cookie 存在站点分区里，后续请求即可复用。
   */
  verifySite(siteId: string, url: string): Promise<boolean>;
  openWindow(siteId: string, url: string): Promise<void>;
  openExternal(url: string): Promise<void>;

  /** 清理单个站点会话（Cookie / localStorage / cache） */
  clearSiteData?(siteId: string): Promise<void>;
  /** 清理所有站点分区；UI 会逐个站点调用 clearSiteData，保留此接口给将来的批量实现 */
  clearAllSiteData?(): Promise<void>;
  appInfo?(): Promise<AppInfo>;
  openDataDir?(): Promise<void>;
  setLoginItem?(enabled: boolean): Promise<void>;
  setTray?(enabled: boolean): Promise<void>;
  proxyInfo?(): Promise<string>;
  setNetworkConfig?(opts: { timeoutMs: number }): Promise<void>;
  /** 仅桌面端：检查/应用 Windows Web Bundle 热更新 */
  hotCheck?(): Promise<{ available: boolean; version?: string; current?: string; error?: string }>;
  hotApply?(version: string): Promise<{ ok: boolean; error?: string; version?: string }>;
}

export interface AppInfo {
  version: string;
  electron: string;
  chrome: string;
  platform: string;
}

export interface SiteCtx {
  site: Site;
  /** 取文档：静态优先，遇 WAF / 失败自动切真实浏览器渲染 */
  doc(url: string, opts?: DocOpts): Promise<Document>;
  html(url: string, opts?: DocOpts): Promise<string>;
  /** 通用 HTTP 请求（自定义 method / headers / body） */
  request(url: string, opts?: HttpRequestOpts): Promise<HttpResponse>;
  /** 请求并解析 JSON，非 2xx 或非 JSON 时抛错 */
  json<T = unknown>(url: string, opts?: HttpRequestOpts): Promise<T>;
  /** 采集 JS 点击式链接 */
  harvest(url: string, selector: string, limit?: number): Promise<HarvestLink[]>;
  /** 提交表单并取回结果页 */
  submit(
    pageUrl: string,
    actionUrl: string,
    fields: Record<string, string>,
    opts?: FormOpts,
  ): Promise<Document>;
  /** 打开播放页并嗅探媒体地址 */
  capture(pageUrl: string, opts?: CaptureOpts): Promise<MediaCapture | null>;
  /** 弹可见窗口让用户过人机验证，成功后清空 HTML 缓存 */
  verify(url: string): Promise<boolean>;
  /** 相对地址转绝对地址（基于站点 baseUrl） */
  abs(href: string | null | undefined): string | undefined;
}

export interface DocOpts {
  /** 强制用真实浏览器渲染（有些站静态返回的内容是残缺的） */
  render?: boolean;
  /** 渲染后滚动页面，触发懒加载/分块加载 */
  scroll?: boolean;
}

export interface FormOpts {
  /** 提交后等待该选择器出现 */
  waitFor?: string;
  timeoutMs?: number;
}

export interface CaptureOpts {
  timeoutMs?: number;
  /** 判定媒体地址的正则（订阅里的 matchVideoUrl） */
  pattern?: string;
  /** 嵌套播放页的匹配正则（订阅里的 matchNestedUrl） */
  nestedPattern?: string;
  /** 播放请求要带的 UA（订阅里的 userAgent / addHeadersToVideo.userAgent） */
  userAgent?: string;
  /** 播放页 Cookie，如 "quality=1080" */
  cookies?: string;
  /** 在页面 DOM 的 video/source 标签里找地址 */
  scanDomMediaUrls?: boolean;
  /** 在内联脚本文本里找地址 */
  scanInlineScriptUrls?: boolean;
}

export interface Site {
  id: string;
  name: string;
  /** 图标字符（宫格/侧栏） */
  icon?: string;
  baseUrl: string;
  kind: SiteKind;
  /** 主题色，用于宫格图标 */
  color?: string;
  /** 源本身属于成人内容；用户可在设置里覆盖 */
  nsfw?: boolean;
  /** 直接走浏览器渲染，跳过静态请求 */
  needsRender?: boolean;
  /** 渲染时等待的选择器 */
  renderWait?: string;
  referer?: string;
  /** 数据源阶级，数字越小越优先（订阅里的 tier） */
  sourceTier?: number;
  /** 线路级阶级覆盖（订阅里的 channelTiers） */
  channelTiers?: Record<string, number>;
  /** 自动匹配配置（订阅里的 autoMatch，缺失时用默认值） */
  autoMatch?: AutoMatchConfig;
  /** 订阅源默认清晰度，仅用于展示 */
  defaultResolution?: string;
  home?(ctx: SiteCtx): Promise<BookSection[]>;
  search?(ctx: SiteCtx, keyword: string): Promise<BookRef[]>;
  detail(ctx: SiteCtx, url: string): Promise<BookDetail>;
  /** 目录单独拉取（小说站目录可能很多页 / 需要特殊采集），支持边采边回调 */
  chapters?(
    ctx: SiteCtx,
    bookUrl: string,
    onProgress?: (chapters: Chapter[]) => void,
  ): Promise<Chapter[]>;
  chapter(ctx: SiteCtx, url: string, onPartial?: (content: ChapterContent) => void): Promise<ChapterContent>;
}

/** 订阅源自动匹配配置，字段与 animeko `SelectorAutoMatchConfig` 对齐 */
export interface AutoMatchConfig {
  enabled: boolean;
  searchUseOnlyFirstWord: boolean;
  searchRemoveSpecial: boolean;
  searchUseSubjectNamesCount: number;
  preferShorterName: boolean;
  filterByEpisodeSort: boolean;
}
