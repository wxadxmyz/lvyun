// 统一媒体源引擎 —— 核心类型定义
// 与《媒体源引擎接口规范 v1》保持一致

export type SourceType = 'music-json' | 'alist' | 'mock' | 'tvbox' | 'js';

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
  search(keyword: string, page?: number): Promise<MediaItem[]>;
  getPlayUrl(itemId: string): Promise<PlayUrl>;
  getDetail?(itemId: string): Promise<MediaItem>;
  test(): Promise<boolean>;
}

export const SOURCE_TYPES: { value: SourceType; label: string; desc: string }[] = [
  { value: 'music-json', label: '音乐 JSON API', desc: '自定义音乐接口，填 URL 即可' },
  { value: 'alist', label: '云盘(alist)', desc: '阿里云盘/夸克/UC/115 等统一网关' },
  { value: 'tvbox', label: '影视仓聚合', desc: '粘贴影视仓/饭太硬式配置地址，自动解析多站点（蜘蛛源走 JS 引擎）' },
  { value: 'js', label: 'JS 脚本源', desc: '粘贴 spider 脚本或远程脚本地址，引擎执行（支持蜘蛛源/加密源）' },
];

export function uuid(): string {
  return 's_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
