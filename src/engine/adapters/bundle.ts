// v2.4.9：聚合订阅源（bundle）—— 一个地址进，N 个子站出。
//
// 背景：用户不想在「源管理」里看到 4 条配置（酷狗 / 酷我 / 网易云 / 咪咕各一条），
// 只想填一个订阅地址，搜索时 4 个子站照常工作。
//
// 范式来源：tvbox 类型本来就是这么做的 —— createTvboxSource 内部 collectSpiders()
// 把一份配置展开成 N 个 spider 子源，search() 里 Promise.all 并发合并。
// 本文件是它的「音乐版」：订阅内容是**完整的律云源配置数组**（不是 CatVod 的 sites[]），
// 所以可以直接用 createSource() 递归造子源，不需要重新实现脚本加载。
//
// ── 唯一的技术难点：播放/歌词/详情要路由回正确的子站 ──────────────────
// 引擎的 getPlayUrl(itemId) 只收一个 id 字符串，聚合源光看 id 并不知道这首歌
// 来自哪个子站。解决办法：搜索时把子站下标编码进 item.id（`__b<idx>__<原id>`），
// 后续所有调用先解前缀再转发给对应子源。
// 之所以选「编码进 id」而不是「运行时 Map 记住」：id 会跟着 item 一起持久化
// （队列 / 收藏 / 续听都存 item），重启 App 后依然能正确路由；Map 存在内存里，
// 重启即失效，那些「上次听到一半」的条目就播不了了。
import { invoke } from '@tauri-apps/api/core';
import { createSource } from '../factory';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

/** 子站 id 前缀：__b<子站下标>__<原 id> */
const SUB_PREFIX = /^__b(\d+)__([\s\S]*)$/;

function wrapId(idx: number, id: string): string {
  return `__b${idx}__${id}`;
}

function unwrapId(id: string): { idx: number; real: string } | null {
  const m = SUB_PREFIX.exec(id ?? '');
  if (!m) return null;
  return { idx: Number(m[1]), real: m[2] };
}

// ── 订阅内容缓存 ────────────────────────────────────────────────────
// 每次搜索都去拉一遍订阅会白白多一个 RTT（还可能是 302 跳 gitee CDN），
// 这里做「内存 + localStorage」两级缓存。改订阅后点「刷新订阅」会主动清掉。
const SUB_CACHE_TTL = 30 * 60 * 1000;
const LOCAL_KEY = 'lvyun_bundle_subs';
const memCache = new Map<string, { ts: number; list: SourceConfig[] }>();

function readLocal(url: string): { ts: number; list: SourceConfig[] } | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const hit = obj?.[url];
    if (hit && Date.now() - hit.ts < SUB_CACHE_TTL) return hit;
  } catch {
    /* 缓存损坏：当作没命中 */
  }
  return null;
}

function writeLocal(url: string, list: SourceConfig[]) {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    if (!obj || typeof obj !== 'object') return;
    obj[url] = { ts: Date.now(), list };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(obj));
  } catch {
    /* 配额/隐私模式：只影响缓存，不影响功能 */
  }
}

/** 清除聚合订阅的缓存。不传 url 则全部清除（「刷新订阅」用）。 */
export function clearBundleCache(url?: string) {
  if (url) memCache.delete(url);
  else memCache.clear();
  try {
    if (!url) localStorage.removeItem(LOCAL_KEY);
    else {
      const obj = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}');
      delete obj?.[url];
      localStorage.setItem(LOCAL_KEY, JSON.stringify(obj));
    }
  } catch {
    /* ignore */
  }
}

/** 优先走 Rust 代理抓取（绕开 CORS / 明文 HTTP 限制），失败回退前端 fetch。 */
async function fetchText(url: string): Promise<string> {
  try {
    const t = await invoke<string>('fetchsource', { url });
    if (t && String(t).trim()) return t;
  } catch {
    /* 不在 Tauri 环境或桥接失败 → 走前端 */
  }
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/** 归一化子源配置：对齐 sourceFetch.normalize 的规则 */
function normalizeList(arr: any[]): SourceConfig[] {
  return arr
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const o = { ...r };
      if (!o.baseUrl && o.api) o.baseUrl = o.api;
      // 社区工具常用 code 承载内联脚本，引擎只认 spider
      if (o.type === 'js' && !o.spider && typeof o.code === 'string' && o.code.trim()) {
        o.spider = o.code;
      }
      return o;
    })
    .filter((r) => r.type && (r.baseUrl || r.spider)) as SourceConfig[];
}

async function loadSubs(cfg: SourceConfig): Promise<SourceConfig[]> {
  const url = cfg.subUrl || cfg.baseUrl;
  if (!url) throw new Error('聚合订阅源缺少订阅地址');

  const mem = memCache.get(url);
  if (mem && Date.now() - mem.ts < SUB_CACHE_TTL) return mem.list;

  const local = readLocal(url);
  if (local) {
    memCache.set(url, local);
    return local.list;
  }

  const text = await fetchText(url);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 有些订阅页会返回 HTML（未登录 / 频控 / 防盗链），这里给出可判别的提示，
    // 而不是让上层统一显示「搜索失败」。
    throw new Error('订阅地址返回的不是 JSON（可能是登录页或频控页）');
  }
  // 兼容两种写法：裸数组 或 { sources: [...] }
  const raw = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.sources) ? parsed.sources : [];
  const list = normalizeList(raw);
  if (!list.length) throw new Error('订阅里没有可用源（需包含 type 与 baseUrl/api）');

  const entry = { ts: Date.now(), list };
  memCache.set(url, entry);
  writeLocal(url, list);
  return list;
}

export function createBundleSource(cfg: SourceConfig): MediaSource {
  /** 取出子源；带缓存 */
  const subs = () => loadSubs(cfg);

  /**
   * v2.4.10 #2：把子站结果包成「聚合源视角」的 item。
   *
   * 抽成函数是因为渐进渲染要**重复调用**（每个子站落地一次），
   * 内联在 forEach 里会导致同一段编码逻辑写两遍、日后改一处漏一处。
   */
  function wrapItem(it: MediaItem, idx: number, list: SourceConfig[], own: SourceConfig): MediaItem {
    return {
      ...it,
      // id 编码子站下标 → 播放/歌词/详情能路由回去（见文件头说明）
      id: wrapId(idx, it.id),
      // sourceId 必须是 bundle 自己的 id，否则 resolvePlay 找不到配置
      sourceId: own.id,
      // sourceName 保留子站名 → 搜索页「来源 tab」按子站分组展示
      sourceName: it.sourceName || list[idx].name || own.name,
      raw: { ...(it.raw ?? {}), __subIdx: idx, __subName: list[idx].name },
    };
  }

  /** 按 item.id 里的子站下标取子源，顺带把 id 还原成子源认识的原 id */
  async function route(idOrItem: MediaItem | string) {
    const raw = typeof idOrItem === 'string' ? idOrItem : String(idOrItem?.id ?? '');
    const u = unwrapId(raw);
    if (!u) throw new Error('该歌曲缺少子站标记，无法定位来源（请重新搜索一次）');
    const list = await subs();
    const sub = list[u.idx];
    if (!sub) throw new Error('子站不存在，订阅可能已更新 —— 请在源管理里刷新订阅');
    return { src: createSource(sub), realId: u.real, subName: sub.name };
  }

  /** 把 item 还原成「子源视角」的 item（id 去前缀） */
  function denormalize(item: MediaItem, realId: string): MediaItem {
    return { ...item, id: realId, raw: item.raw };
  }

  return {
    async search(
      keyword: string,
      page?: number,
      onPartial?: (items: MediaItem[]) => void,
    ): Promise<MediaItem[]> {
      const list = await subs();

      // v2.4.10 #2：子站级渐进渲染。
      //
      // 旧实现是 Promise.all 四个子站，**全部回来才 return** —— 于是「谁快」毫无意义，
      // 用户始终要等最慢的那个子站（酷我/咪咕动辄 8~15s）才能看到任何结果。
      //
      // 现在每个子站一回来就通过 onPartial 推一次「当前已收到的全部结果」。
      // 上层（engine/index.ts → SearchView）的 onPartial 已经就绪，
      // 这里只需要在 MediaSource 上加一条可选通道把信号透传出去。
      //
      // 兼容性：onPartial 可选，老调用方（只传 2 个参数）行为完全不变。
      const buckets: MediaItem[][] = list.map(() => []);

      /** 把当前 buckets 展开成「已上屏」的列表（含 id 编码与 sourceId 改写） */
      const collect = (): MediaItem[] => {
        const out: MediaItem[] = [];
        buckets.forEach((items, idx) => {
          for (const it of items) out.push(wrapItem(it, idx, list, cfg));
        });
        return out;
      };

      const results = await Promise.all(
        list.map(async (sub, idx) => {
          try {
            buckets[idx] = await createSource(sub).search(keyword, page ?? 1);
          } catch {
            buckets[idx] = []; // 单个子站挂了不影响其它子站
          }
          // 每个子站落地就推一次增量 —— 先回来的子站先上屏
          if (onPartial) {
            try { onPartial(collect()); } catch { /* 回调异常不该影响搜索 */ }
          }
          return buckets[idx];
        })
      );

      const out = collect();
      const failed = results.filter((r) => !r.length).length;
      if (!out.length && failed === list.length) {
        throw new Error(`订阅下 ${list.length} 个子站全部搜索失败`);
      }
      return out;
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const { src, realId } = await route(itemId);
      return src.getPlayUrl(realId);
    },

    async getDetail(item: MediaItem | string) {
      const { src, realId } = await route(item);
      if (typeof src.getDetail !== 'function') {
        throw new Error('子站不支持详情接口');
      }
      return src.getDetail(typeof item === 'string' ? realId : denormalize(item, realId));
    },

    async getLyric(item: MediaItem | string) {
      const { src, realId } = await route(item);
      if (typeof src.getLyric !== 'function') return '';
      return src.getLyric(typeof item === 'string' ? realId : denormalize(item, realId));
    },

    async getArtistSongs(artist: string) {
      const list = await subs();
      const results = await Promise.all(
        list.map(async (sub, idx) => {
          const s = createSource(sub);
          if (typeof s.getArtistSongs !== 'function') return [] as MediaItem[];
          try {
            const items = await s.getArtistSongs(artist);
            return items.map((it) => ({ ...it, id: wrapId(idx, it.id), sourceId: cfg.id }));
          } catch {
            return [] as MediaItem[];
          }
        })
      );
      return results.flat();
    },

    async test() {
      const list = await subs();
      return list.length > 0;
    },
  };
}

/**
 * 供 UI 用：预览一个订阅地址里有多少个子站（源管理显示「N 个子站」）。
 * 失败返回 null，不抛 —— UI 不该因为订阅临时不可用就崩。
 */
export async function peekBundleSubs(cfg: SourceConfig): Promise<SourceConfig[] | null> {
  try {
    return await loadSubs(cfg);
  } catch {
    return null;
  }
}
