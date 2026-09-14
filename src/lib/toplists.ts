// v2.4.0 I1：主页榜单数据层。
// 榜单为「策展式」静态数据（仅榜单名 + 视觉元素），不含任何歌曲/封面图。
// 点击榜单后用其 keyword 去搜「用户自己的音源」，App 零版权负担。
import { getSettingsValue } from './settings';

export interface ToplistItem {
  id: string;
  name: string; // 榜单名，如「热歌榜」
  keyword: string; // ⭐ 点击后用此词搜「用户自己的音源」
  desc?: string; // 副标题
  color?: [string, string]; // 封面渐变起止色
  initial?: string; // 封面首字（无图时占位）
  cover?: string; // 可选图片 URL（当前不使用，保留字段）
}

export interface ToplistData {
  updated: string;
  refresh?: { toplists?: string };
  note?: string;
  version?: number;
  toplists: ToplistItem[];
}

const DEFAULT_TOPLIST_URL = 'https://wu2000.top/lvyun/toplists.json';
// 备链（gitee raw）按用户安排「等软件改好后再建」，此处留位，暂不使用。
// ⚠️ 慕海部署指南记录 gitee raw 在 App 内可能被拦截（Failed to fetch），故主链必须是 Cloudflare。
// const FALLBACK_TOPLIST_URL = 'https://gitee.com/<用户名>/<仓库>/raw/master/toplists.json';

const CACHE_KEY = 'lvyun_toplists_cache';
const TTL = 12 * 60 * 60 * 1000; // 12h，对齐慕海 hot.ts

function toplistUrl(): string {
  const override = getSettingsValue('toplistUrl');
  return override && override.trim() ? override.trim() : DEFAULT_TOPLIST_URL;
}

function cacheRead(): ToplistData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (Date.now() - (c.ts ?? 0) > TTL) return null;
    return c.data as ToplistData;
  } catch {
    return null;
  }
}

function cacheWrite(data: ToplistData): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    /* ignore */
  }
}

async function fetchOnce(url: string, timeoutMs = 15000): Promise<ToplistData> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as ToplistData;
    if (!json || !Array.isArray(json.toplists)) throw new Error('非法榜单数据');
    return json;
  } finally {
    clearTimeout(t);
  }
}

// 三级兜底：主链 → 本地缓存；拉取全失败时回退缓存，缓存也没有则静默返回 null。
// 对齐慕海 hot.ts：「拉取失败不影响原聚合首页」，调用方对 null 静默不渲染榜单区。
export async function fetchToplists(force = false): Promise<ToplistData | null> {
  if (!force) {
    const cached = cacheRead();
    if (cached) return cached;
  }
  try {
    const data = await fetchOnce(toplistUrl());
    cacheWrite(data);
    return data;
  } catch {
    // 主链失败：回退缓存（即使过期也先顶上，保证榜单不消失）
    const cached = cacheRead();
    if (cached) return cached;
    try {
      const data = await fetchOnce(DEFAULT_TOPLIST_URL);
      cacheWrite(data);
      return data;
    } catch {
      return null;
    }
  }
}
