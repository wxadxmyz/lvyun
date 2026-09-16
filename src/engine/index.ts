// 引擎入口：跨源搜索聚合 + 源管理器（createSource 工厂已抽到 ./factory）
import { createSource } from './factory';
import { withTimeout } from './http';
import { MediaItem, MediaSource, SourceConfig, MediaType } from './types';

export * from './types';
export { createSource } from './factory';
export { clearBundleCache, peekBundleSubs } from './adapters/bundle';

// v2.4.0 A1-F1/F2：超时按源类型分层。
// 关键：js / tvbox 走 Rust 侧 reqwest（fetch 桥接超时 20s），
// 前端外层必须高于 20s，否则「超时抢跑」导致调试面板空白 + 误报「部分源失败」。
const TIMEOUT_BY_TYPE: Record<string, number> = {
  'music-json': 8000,
  alist: 8000,
  tvbox: 25000,
  js: 25000,
  // v2.4.9：聚合订阅要「先拉订阅 + 再并发 N 个子站（每个子站内部还翻多页）」，
  // 总耗时天然高于单源，外层给到 40s，避免正常的多子站搜索被判超时。
  bundle: 40000,
  mock: 5000,
};

// v2.4.9 #1.5.4：去重独立成函数（慕海 v3.5.0 同名实现）。
// 保持「先到先得」的原顺序，只丢同名同艺术家的后到者，避免列表顺序被响应速度打乱。
function dedupe(items: MediaItem[]): MediaItem[] {
  const map = new Map<string, MediaItem>();
  for (const it of items) {
    const key = `${it.title}|${it.artist ?? ''}`;
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

// 跨源搜索：并发请求所有启用源，按优先级合并。
// v2.4.9 #1.5.1/#1.5.3：加 onPartial —— 每完成一个源就把当前已有结果推给调用方，
// 谁快谁先上屏，不再干等最慢的源（旧实现 Promise.all 全部回来才一次性渲染，
// 只要有一个源慢/死，用户就得对着「跨源搜索中…」空转到最慢那个源超时为止）。
// 实现上按源下标（= 优先级）分桶，emit 时按下标顺序展开，
// 这样「谁快谁先上」的同时，最终列表顺序不会被响应速度打乱。
export async function aggregateSearch(
  sources: SourceConfig[],
  keyword: string,
  opts: {
    timeout?: number;
    mediaType?: MediaType;
    onPartial?: (items: MediaItem[]) => void;
  } = {}
): Promise<{ items: MediaItem[]; errors: { sourceId: string; message: string }[] }> {
  const active = sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority);

  const buckets: MediaItem[][] = active.map(() => []);
  const errors: { sourceId: string; message: string }[] = [];

  const emit = () => {
    if (!opts.onPartial) return;
    const list = buckets.flat();
    const shown = opts.mediaType ? list.filter((it) => it.mediaType === opts.mediaType) : list;
    opts.onPartial(dedupe(shown));
  };

  await Promise.all(
    active.map(async (s, i) => {
      try {
        // 未显式传 timeout 时按源类型取（js/tvbox 给 25s，高于 Rust 侧 reqwest 20s）。
        //
        // v2.4.9 #1.5.2 说明：慕海 v3.5.0 这里写死 `?? 10000`，律云**不照抄**。
        // 律云的 js 源跑在 QuickJS 里，每次 fetch 经 Rust 桥接（js_engine.rs / lib.rs
        // 均为 Duration::from_secs(20)），且源内部还要翻 3 页拿满 90 条——单次 search
        // 的理论上限本就在 20s 以上。前端外层若压到 10s，会在 Rust 还没放弃时先抢跑，
        // 把「慢但可用」的源报成失败 —— 这正是 v2.4.1 #A 修过的回归，不能重犯。
        // 因此保留分层超时（js/tvbox 25s），「源多就慢」改由 onPartial 渐进渲染 +
        // 10 分钟结果缓存解决（慢源不再阻塞首屏）。显式传 opts.timeout 时仍以调用方为准。
        const timeout = opts.timeout ?? TIMEOUT_BY_TYPE[s.type] ?? 8000;
        const items = await withTimeout(createSource(s).search(keyword, 1), timeout);
        buckets[i] = items;
        emit(); // 这个源一回来就先把它的结果推上去
      } catch (e: any) {
        // v2.4.1 #B：错误信息兜底链。此前只取 e?.message，遇到以下情况会退化成
        // 无信息的「搜索失败」，让用户与调试者都无从下手：
        //   1) Rust 侧 Err(String) 经 invoke 抛出的不是标准 Error 实例；
        //   2) QuickJS 异常对象经序列化后 message 丢失；
        //   3) 抛出的本就是字符串。
        // 逐级降级取值，保证「真实原因可见」——这是 A1-F3 把 message 渲染到 UI 的前提。
        const msg = e?.message || e?.toString?.() || String(e) || '未知错误';
        errors.push({ sourceId: s.id, message: msg });
      }
    })
  );

  let items = dedupe(buckets.flat());
  if (opts.mediaType) items = items.filter((it) => it.mediaType === opts.mediaType);
  // v2.4.9 #1.5：多源合并去重后只保留前 90 条（显示层截断，
  // 结果丰富度靠各源搜索返回量保证，截断只为控制渲染与内存）。
  // 注意：是**合并后总列表**截断 90，不是每源各 90。
  const MAX_RESULTS = 90;
  return { items: items.slice(0, MAX_RESULTS), errors };
}

/**
 * v2.4.9 #2.2：歌手全曲聚合（作者页数据源）。
 *
 * 与 aggregateSearch 的区别：搜索是「按关键词找歌」，拿歌手名去搜只会得到
 * 又少又脏的结果（混翻唱 / live / 别人标注）；这里是调源自己的 artist()，
 * 取该歌手的真实作品库（酷狗 v2 源实测许嵩 256 首、周杰伦 353 首，封面 100%）。
 *
 * 设计要点：
 *   - 源没实现 getArtistSongs（老式源）→ 静默跳过，**不计入 errors**，由上层回退搜索；
 *   - 歌手全曲要翻很多页（酷狗最多 12 页 × 30 条），默认超时给到 40s，
 *     高于普通搜索的分层值；同时支持 onPartial 让先回来的源先上屏；
 *   - 合并去重后截断 500 条，避免单个歌手上千首一次渲染卡死列表。
 */
export async function aggregateArtist(
  sources: SourceConfig[],
  artist: string,
  opts: { timeout?: number; onPartial?: (items: MediaItem[]) => void } = {}
): Promise<{ items: MediaItem[]; errors: { sourceId: string; message: string }[]; supported: number }> {
  const name = (artist ?? '').trim();
  if (!name) return { items: [], errors: [], supported: 0 };

  const active = sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority);

  const buckets: MediaItem[][] = active.map(() => []);
  const errors: { sourceId: string; message: string }[] = [];
  let supported = 0;

  const emit = () => {
    if (!opts.onPartial) return;
    opts.onPartial(dedupe(buckets.flat()));
  };

  await Promise.all(
    active.map(async (s, i) => {
      let src: MediaSource;
      try {
        src = createSource(s);
      } catch (e: any) {
        errors.push({ sourceId: s.id, message: e?.message ?? '源初始化失败' });
        return;
      }
      if (typeof src.getArtistSongs !== 'function') return; // 老源不支持：跳过，不算失败
      supported++;
      try {
        const items = await withTimeout(src.getArtistSongs(name), opts.timeout ?? 40000);
        buckets[i] = items;
        emit();
      } catch (e: any) {
        errors.push({
          sourceId: s.id,
          message: e?.message || e?.toString?.() || String(e) || '未知错误',
        });
      }
    })
  );

  // supported === 0 时返回空数组，调用方据 items.length 回退到聚合搜索。
  const ARTIST_MAX_RESULTS = 500;
  return {
    items: dedupe(buckets.flat()).slice(0, ARTIST_MAX_RESULTS),
    errors,
    supported,
  };
}

// v2.4.9 #1.5.5：搜索结果缓存 —— 模块级内存缓存 + localStorage 带有效期(10min)。
// 同关键词 + 同源配置命中即秒回（回看/退回搜索页/切 Tab 回来不必重新跨源请求）。
const SEARCH_CACHE_TTL = 10 * 60 * 1000;
const SEARCH_CACHE_KEY = 'lvyun_search_cache';
const SEARCH_CACHE_MAX = 20; // 最多缓存 20 个关键词，防止 localStorage 无限膨胀
type SearchCacheEntry = {
  key: string;
  ts: number;
  data: { items: MediaItem[]; errors: { sourceId: string; message: string }[] };
};
const _searchCache = new Map<string, SearchCacheEntry>();

function searchCacheKey(
  sources: SourceConfig[],
  keyword: string,
  mediaType?: MediaType
): string {
  const fingerprint = sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.id)
    .join('|');
  return `${keyword.trim()}::${mediaType ?? ''}::${fingerprint}`;
}

function searchReadLocal(key: string): SearchCacheEntry['data'] | null {
  try {
    const raw = localStorage.getItem(SEARCH_CACHE_KEY);
    if (!raw) return null;
    const arr: SearchCacheEntry[] = JSON.parse(raw);
    const hit = arr.find((e) => e?.key === key);
    if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL) return hit.data;
  } catch {
    /* 缓存损坏/不可用：静默降级为不命中 */
  }
  return null;
}

function searchWriteLocal(entry: SearchCacheEntry) {
  try {
    const raw = localStorage.getItem(SEARCH_CACHE_KEY);
    let arr: SearchCacheEntry[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) arr = [];
    arr = arr.filter((e) => e?.key !== entry.key && Date.now() - (e?.ts ?? 0) < SEARCH_CACHE_TTL);
    arr.push(entry);
    // 超出上限丢最旧的
    arr = arr.sort((a, b) => b.ts - a.ts).slice(0, SEARCH_CACHE_MAX);
    localStorage.setItem(SEARCH_CACHE_KEY, JSON.stringify(arr));
  } catch {
    /* 写入失败（配额/隐私模式）不影响搜索 */
  }
}

/**
 * 带缓存的跨源搜索。force=true 跳过缓存强制刷新。
 * 注意：命中缓存时不再触发 onPartial（结果是一次性给出的，渐进无意义）。
 */
export async function aggregateSearchCached(
  sources: SourceConfig[],
  keyword: string,
  opts: {
    timeout?: number;
    mediaType?: MediaType;
    onPartial?: (items: MediaItem[]) => void;
    force?: boolean;
  } = {}
): Promise<{ items: MediaItem[]; errors: { sourceId: string; message: string }[]; fromCache: boolean }> {
  const key = searchCacheKey(sources, keyword, opts.mediaType);
  if (!opts.force) {
    const mem = _searchCache.get(key);
    if (mem && Date.now() - mem.ts < SEARCH_CACHE_TTL) {
      return { ...mem.data, fromCache: true };
    }
    const local = searchReadLocal(key);
    if (local) {
      _searchCache.set(key, { key, ts: Date.now(), data: local });
      return { ...local, fromCache: true };
    }
  }
  const r = await aggregateSearch(sources, keyword, opts);
  const entry: SearchCacheEntry = { key, ts: Date.now(), data: { items: r.items, errors: r.errors } };
  _searchCache.set(key, entry);
  searchWriteLocal(entry);
  return { ...r, fromCache: false };
}

// 源管理器：内存态，持久化由上层（localStorage / 文件）负责
export class SourceManager {
  private list: SourceConfig[] = [];

  setAll(list: SourceConfig[]) {
    this.list = [...list];
  }
  getAll(): SourceConfig[] {
    return [...this.list].sort((a, b) => a.priority - b.priority);
  }
  get(id: string): SourceConfig | undefined {
    return this.list.find((s) => s.id === id);
  }
  add(cfg: SourceConfig): void {
    this.list.push(cfg);
  }
  update(id: string, patch: Partial<SourceConfig>): void {
    const i = this.list.findIndex((s) => s.id === id);
    if (i >= 0) this.list[i] = { ...this.list[i], ...patch };
  }
  remove(id: string): void {
    this.list = this.list.filter((s) => s.id !== id);
  }
  toggle(id: string): void {
    const s = this.get(id);
    if (s) s.enabled = !s.enabled;
  }
  move(id: string, dir: -1 | 1): void {
    const sorted = this.getAll();
    const i = sorted.findIndex((s) => s.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= sorted.length) return;
    const a = sorted[i], b = sorted[j];
    const pa = a.priority;
    a.priority = b.priority;
    b.priority = pa;
  }

  async test(id: string): Promise<boolean> {
    const s = this.get(id);
    if (!s) return false;
    // v2.4.0 A1-F1：js/tvbox 走 Rust 20s 桥接，套一层略高的超时避免 UI 冻结
    const timeout = TIMEOUT_BY_TYPE[s.type] ?? 8000;
    try {
      return await withTimeout(createSource(s).test(), timeout + 2000);
    } catch {
      return false;
    }
  }

  export(): string {
    return JSON.stringify(this.getAll(), null, 2);
  }
  import(json: string): { added: number; errors: string[] } {
    const errors: string[] = [];
    let added = 0;
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) throw new Error('应为源数组');
      for (const raw of arr) {
        if (!raw?.type || !raw?.baseUrl) {
          errors.push(`跳过无效源: ${JSON.stringify(raw).slice(0, 60)}`);
          continue;
        }
        this.add({ enabled: true, priority: this.list.length + 1, name: '导入源', ...raw });
        added++;
      }
    } catch (e: any) {
      errors.push(e?.message ?? '解析失败');
    }
    return { added, errors };
  }
}
