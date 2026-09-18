// 统一媒体源引擎 —— 核心类型定义
// 与《媒体源引擎接口规范 v1》保持一致

export type SourceType = 'music-json' | 'alist' | 'mock' | 'tvbox' | 'js' | 'bundle';

export type MediaType = 'music' | 'video';

export interface SourceConfig {
  id: string;
  name: string;
  type: SourceType;
  baseUrl: string;
  token?: string;
  enabled: boolean;
  priority: number;
  extra?: Record<string, any>;
  // ── v2.4.0 A2：订阅元数据（可选 → 旧数据自动兼容，无需迁移）──
  subUrl?: string; // 订阅地址：有值即代表该源可刷新同步
  subUpdatedAt?: number; // 上次同步时间戳（毫秒）
}

// JS 脚本源（v2.3.0）：由统一 JS 引擎执行 spider 脚本驱动。
// 兼容影视仓/洛雪配置：api 字段可能是蜘蛛代号/远程蜘蛛脚本地址，
// spider 为内联脚本，spiderUrl 为远程脚本地址，三者至少其一。
export interface JsSourceConfig extends SourceConfig {
  type: 'js';
  api?: string;
  spider?: string;
  spiderUrl?: string;
  // v2.4.1 #G：外部工具导出的内联脚本字段，导入时由 sourceFetch.normalize
  // 归一化为 spider；此处声明是为了让引擎层在「未经导入路径直接构造」时也能兜底识别。
  code?: string;
  // TVBox csp 模型：站点代号与 ext 配置（JSON 字符串），传给 spider 构造器选路
  ext?: string;
}

export interface Episode {
  name: string;
  url: string;
}

export interface MediaItem {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  artist?: string;
  album?: string;
  genre?: string;
  cover?: string;
  year?: string;
  duration?: number;
  /** v2.5.0：付费/VIP 歌曲（源真实返回时才有） */
  vip?: boolean;
  /** v2.5.0：免费试听（如网易云 fee===8，仅试听 30 秒） */
  trial?: boolean;
  /** v2.5.0：原唱（源真实返回 isoriginal 等字段时才有，无标准字段的源不标） */
  original?: boolean;
  mediaType: MediaType;
  playUrl?: string;
  episodes?: Episode[];
  lyric?: LyricLine[]; // 逐行歌词（含时间轴）
  danmaku?: string[]; // 弹幕文本（来自源 API；无则播放器不渲染弹幕）
  subtitles?: SubtitleTrack[]; // 字幕轨（来自源 API；无则播放器不渲染字幕）
  raw?: any;
}

// 字幕轨：可内嵌 cues（行内时间轴文本），或仅给外链 url（外挂解析见后续版本）
export interface SubtitleTrack {
  lang: string; // 如 '原声' / '中文' / 'ENG'
  url?: string; // 外挂字幕文件地址（.srt/.vtt 等）
  cues?: { time: number; text: string }[]; // 内嵌时间轴文本
}

export interface LyricLine {
  time: number; // 秒
  text: string;
}

export interface PlayUrl {
  url: string;
  quality?: string;
  headers?: Record<string, string>;
}

export interface MediaSource {
  /**
   * v2.4.10 #2：第三参数 onPartial 为「子站级渐进渲染」通道（可选）。
   *
   * 只有聚合源（bundle）会用到：它内部并发 N 个子站，每个子站一回来就把
   * 「当前已收到的全部结果」推一次，让上层先渲染先到的子站，而不是干等最慢的。
   * 单源适配器忽略此参数即可（多数源本来就是一次请求出全部结果，渐进无意义）。
   *
   * 回调里给出的 items 是**累积快照**（不是增量 diff）—— 调用方直接整体替换即可，
   * 不需要自己做合并。
   */
  search(
    keyword: string,
    page?: number,
    onPartial?: (items: MediaItem[]) => void,
  ): Promise<MediaItem[]>;
  getPlayUrl(itemId: string): Promise<PlayUrl>;
  /**
   * v2.4.9 #2.2：歌手全曲（作者页数据源）。可选实现。
   * 与 aggregateSearch 拿「搜索结果冒充作品库」不同，这是源提供的真实歌手作品库
   * （酷狗 v2 源实测：许嵩 256 首 / 周杰伦 353 首，且封面 100%）。
   * 源未实现时上层回退为按歌手名聚合搜索。
   *
   * v2.6.1 A3：第二参数 onPartial 与 search 同语义 ——「子站级渐进渲染」通道。
   *
   * 补它的原因：搜索路径（search）早就有了这条通道，但歌手路径一直只有 Promise.all ——
   * 于是同样是 bundle 源，搜索能「谁快谁先上屏」，歌手页却必须干等**最慢的子站**
   * （酷我 / 咪咕常 8~15s）才出第一条。这就是「搜索还行、歌手页特别卡」的直接原因。
   *
   * 回调里给出的 items 同样是**累积快照**，调用方整体替换即可。
   * 单源适配器忽略此参数即可（它们本来一次请求就出全部结果）。
   */
  getArtistSongs?(
    artist: string,
    onPartial?: (items: MediaItem[]) => void,
  ): Promise<MediaItem[]>;
  /**
   * v2.4.9 #1.3/#1.5.6：详情通道（封面回填用）。
   * 参数兼容两种调用：传完整 MediaItem（**推荐**，源的 detail 常要靠歌名+歌手
   * 去别处兜底封面，如酷我 kgCover 走酷狗 union_cover），或只传 id 字符串。
   * 旧实现只认裸 id，导致酷我 / 网易云的封面兜底永远拿不到入参，cover 恒空。
   */
  getDetail?(item: MediaItem | string): Promise<MediaItem>;
  /**
   * v2.4.8 #1：歌词获取通道。
   * 返回 LRC 原文（含 [mm:ss.xx] 时间轴的字符串）、已解析好的 LyricLine[]，
   * 或纯文本行数组 string[]；无歌词时返回空字符串 / 空数组。
   * 由播放侧解析后写入 current.lyric。可选实现：源未提供时播放页回退「暂无歌词」。
   */
  getLyric?(item: MediaItem | string): Promise<string | string[] | LyricLine[]>;
  test(): Promise<boolean>;
}

export const SOURCE_TYPES: { value: SourceType; label: string; desc: string }[] = [
  { value: 'music-json', label: '音乐 JSON API', desc: '自定义音乐接口，填 URL 即可' },
  { value: 'alist', label: '云盘(alist)', desc: '阿里云盘/夸克/UC/115 等统一网关' },
  { value: 'tvbox', label: '影视仓聚合', desc: '粘贴影视仓/饭太硬式配置地址，自动解析多站点（蜘蛛源走 JS 引擎）' },
  { value: 'js', label: 'JS 脚本源', desc: '粘贴 spider 脚本或远程脚本地址，引擎执行（支持蜘蛛源/加密源）' },
  {
    value: 'bundle',
    label: '聚合订阅（一个地址多个子站）',
    desc: '填一个订阅地址（sources.json 数组），源管理只占 1 行，搜索时内部自动展开成多个子站',
  },
];

export function uuid(): string {
  return 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
