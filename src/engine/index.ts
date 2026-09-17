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

// v2.4.10 #1：去重键加入「来源标识」—— 「同名同歌手的跨源结果」不再被丢掉。
//
// 旧实现键是 `title|artist`（不含来源），配合「先到先得」+ 末尾 slice(0,90)：
// 4 个子站一起搜时，**最快的那个源会独占全部名额**（实测酷狗 89 条、酷我 1 条、
// 网易云 0、咪咕 0）—— 因为酷狗先回来把 90 个坑占满，其余源的同名歌全部被判重。
//
// 现在按「歌 + 来源」去重：同一个来源内部的重复仍然去掉（真正的重复），
// 但 A 源的《青花瓷》与 B 源的《青花瓷》各自保留 —— 用户可在「来源 tab」里
// 看到每个子站各自的结果，也才有了换源重试的余地。
//
// ⚠️ 这里必须用 sourceToken() 而不是裸 it.sourceId。
//   聚合订阅源（bundle）会把 N 个子站的结果**全部标成同一个 sourceId**（即 bundle
//    自己的 id，播放路由需要它），四个子站的唯一区分是 sourceName（子站名）。
//    若用 sourceId 作键，四个子站又会被折叠成一个 —— 等于没修。
//    sourceToken() 的取值顺序：sourceName（子站级）→ sourceId（单源级）→ raw 兜底。
function sourceToken(it: MediaItem): string {
  const anyIt = it as any;
  // 子站名优先：聚合源下它就是「哪一路子站」的身份
  const sub = anyIt.sourceName || anyIt.raw?.__subName;
  if (sub) return String(sub);
  return String(it.sourceId ?? '');
}

/** 条目的唯一身份（去重 / 渐进累积都用它） */
function itemKey(it: MediaItem): string {
  return `${it.title}|${it.artist ?? ''}|${sourceToken(it)}`;
}

function dedupe(items: MediaItem[]): MediaItem[] {
  const map = new Map<string, MediaItem>();
  for (const it of items) {
    const key = itemKey(it);
    if (!map.has(key)) map.set(key, it);
  }
  return Array.from(map.values());
}

// v2.4.10 #1：按源「轮转」分配名额。
//
// 与上面的去重键配套 —— 光改键还不够。旧实现末尾那次 slice(0, 90) 是按「桶的先后
// 顺序」截断：热门关键词下第一个源动辄返回 90 条，混排后稳定占据列表前 90 位，
// 后面的源一条都露不出来（实测酷狗 89、酷我 1、网易云 0、咪咕 0）。
//
// ⚠️ 试过但**是错的**做法：每源先截 40 条再拼起来。
//    4 个源 × 40 = 160 个候选，而总上限只有 90 —— 前两个源就把名额吃满，
//    后两个源照样是 0（离线实测：kugou 40 / kuwo 40 / netease 10 / migu 0）。
//    配额必须**按最终名额分配**，不能先放宽再截断。
//
// 正确做法：轮转（round-robin）取。第 1 轮每源各取 1 条，第 2 轮再各取 1 条……
// 直到凑满 90 或所有源都取空。这样：
//   · 只要某个源有结果，它就一定能上屏（不会因为排在后面被饿死）；
//   · 队首依然是「优先级最高的源」的第一条（轮转从下标 0 开始）；
//   · 某源结果少时名额自动让给其它源（它取空后轮转自动跳过），不浪费总量。
//
// 90 / 4 ≈ 22，即每个源大约能拿到 22 条起，结果多的源在其它源取空后继续补。
const MAX_RESULTS = 90;

/**
 * 按**来源标识**（子站名 / 源 id）把结果轮转交错合并，最多取 limit 条。
 *
 * 关键：分桶不能按「源配置」分，必须按 sourceToken 分。
 * 因为聚合订阅源（bundle）把 4 个子站的结果打包成**一个源**返回，
 * 若按源配置分桶，这一个桶里依然是最快的子站占满前 90 位 —— 等于白改。
 * 按 token 分桶后，酷狗 / 酷我 / 网易云 / 咪咕 各是一个桶，轮转才真正生效。
 *
 * 取法：第 1 轮每桶各取 1 条，第 2 轮再各取 1 条……直到凑满 limit 或全部取空。
 * 这样只要某个来源有结果，它就一定能上屏；某个来源结果少时名额自动让给其它来源。
 */
function interleave(buckets: MediaItem[][], limit = MAX_RESULTS): MediaItem[] {
  // 先按 token 重新分桶，保持「首次出现顺序」= 源优先级顺序（buckets 已按 priority 排序）
  const order: string[] = [];
  const byToken = new Map<string, MediaItem[]>();
  for (const b of buckets) {
    for (const it of b) {
      const t = sourceToken(it);
      let arr = byToken.get(t);
      if (!arr) { arr = []; byToken.set(t, arr); order.push(t); }
      arr.push(it);
    }
  }

  const out: MediaItem[] = [];
  const cursor = order.map(() => 0);
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (let i = 0; i < order.length && out.length < limit; i++) {
      const b = byToken.get(order[i])!;
      const c = cursor[i];
      if (c >= b.length) continue;
      out.push(b[c]);
      cursor[i] = c + 1;
      progressed = true;
    }
  }
  return out;
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

  // v2.4.10 #2：渐进渲染的「只增不减」累积容器。
  //
  // 为什么要它：bundle 源内部每个子站回来会推一次快照，而它的快照是**累积**的，
  // 但 aggregateSearch 这一层在源真正 resolve 时会把 buckets[i] 换成最终结果；
  // 两次 emit 之间条数若出现回落，用户的列表就会"缩水"（已出现的条目凭空消失）。
  // 这个 Set 记的是「已经推给 UI 的条目身份」，每次取并集，保证列表单调增长。
  const emittedKeys = new Set<string>();
  const emitKeep: MediaItem[] = [];

  const emit = () => {
    if (!opts.onPartial) return;
    // v2.4.10 #2：渐进渲染也走轮转合并 —— 否则「第一个源先回来」时它照样独占整个列表，
    // 虽然不是最终结果，但会让用户先看到一大片单一来源的内容再被替换（闪屏感）。
    const list = interleave(buckets);
    const shown = opts.mediaType ? list.filter((it) => it.mediaType === opts.mediaType) : list;

    // v2.4.10 #2：**只增不减**。
    // bundle 源的子站快照是累积推的，但 aggregateSearch 在源真正 resolve 时会用
    // 最终结果覆盖 buckets[i] —— 两次 emit 之间条数若回落，用户的列表就会"缩水"
    //（已出现的条目凭空消失）。这里用 emittedKeys 记「已推给 UI 的身份」，只追加，
    // 保证列表单调增长。
    for (const it of shown) {
      const k = itemKey(it);
      if (emittedKeys.has(k)) continue;
      emittedKeys.add(k);
      emitKeep.push(it);
    }
    opts.onPartial([...emitKeep]);
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
        // v2.4.10 #2：把 onPartial 透传给源。
        // 目前只有聚合源（bundle）会用 —— 它内部有 N 个子站，可以「子站级」渐进上屏；
        // 单源适配器忽略第三个参数，行为不变（它们本来就是一次请求出全部结果）。
        // 源内部推的增量同样要先过配额 + 去重，避免绕过上面的统一口径。
        const items = await withTimeout(
          createSource(s).search(keyword, 1, (partialItems) => {
            if (!opts.onPartial) return;
            // 子站快照是「本源的累积结果」，直接覆盖本桶即可（不是增量拼接）
            buckets[i] = partialItems;
            emit();
          }),
          timeout,
        );
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

  // v2.4.10 #1：轮转合并 → 去重 → 截断。
  //
  // 旧实现的注释写「结果丰富度靠各源搜索返回量保证」，实际并没有保证：
  // 去重键不含来源 + 末尾直接 slice(0,90)，等于让最快的源独占。
  // 现在轮转交错 → 去重 → 截断，每个有结果的源都能稳定上屏。
  let items = dedupe(interleave(buckets));
  if (opts.mediaType) items = items.filter((it) => it.mediaType === opts.mediaType);
  items = items.slice(0, MAX_RESULTS);

  // v2.4.10 #2：最终结果必须**包住**已经渐进推给 UI 的条目。
  // 渐进渲染期间推过、而最终结果里没有的（源内部快照与最终值有出入时可能出现），
  // 如果直接丢掉，用户就会看到「已经在屏幕上的歌突然消失」。
  // 这里把已上屏的条目补回末尾，保证「最终列表 ⊇ 渐进列表」。
  if (opts.onPartial && emitKeep.length) {
    const finalKeys = new Set(items.map((it) => itemKey(it)));
    for (const it of emitKeep) {
      if (items.length >= MAX_RESULTS) break;
      const k = itemKey(it);
      if (finalKeys.has(k)) continue;
      finalKeys.add(k);
      items.push(it);
    }
  }

  return { items, errors };
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

// v2.5.5 #6：歌手全曲缓存 —— 仿搜索缓存（模块级内存 + localStorage，TTL 10min）。
// 同一歌手二次进入秒回，避免反复 4-5s 空等首响（首次慢源不再阻塞后续进入）。
const ARTIST_CACHE_TTL = 10 * 60 * 1000;
const ARTIST_CACHE_KEY = 'lvyun_artist_cache';
const ARTIST_CACHE_MAX = 30;
type ArtistCacheEntry = {
  key: string;
  ts: number;
  data: { items: MediaItem[]; errors: { sourceId: string; message: string }[]; supported: number };
};
const _artistCache = new Map<string, ArtistCacheEntry>();

function artistCacheKey(sources: SourceConfig[], artist: string): string {
  const fingerprint = sources
    .filter((s) => s.enabled)
    .sort((a, b) => a.priority - b.priority)
    .map((s) => s.id)
    .join('|');
  return `${artist.trim()}::${fingerprint}`;
}

function artistReadLocal(key: string): ArtistCacheEntry['data'] | null {
  try {
    const raw = localStorage.getItem(ARTIST_CACHE_KEY);
    if (!raw) return null;
    const arr: ArtistCacheEntry[] = JSON.parse(raw);
    const hit = arr.find((e) => e?.key === key);
    if (hit && Date.now() - hit.ts < ARTIST_CACHE_TTL) return hit.data;
  } catch {
    /* 缓存损坏/不可用：静默降级为不命中 */
  }
  return null;
}

function artistWriteLocal(entry: ArtistCacheEntry) {
  try {
    const raw = localStorage.getItem(ARTIST_CACHE_KEY);
    let arr: ArtistCacheEntry[] = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) arr = [];
    arr = arr.filter((e) => e?.key !== entry.key && Date.now() - (e?.ts ?? 0) < ARTIST_CACHE_TTL);
    arr.push(entry);
    arr = arr.sort((a, b) => b.ts - a.ts).slice(0, ARTIST_CACHE_MAX);
    localStorage.setItem(ARTIST_CACHE_KEY, JSON.stringify(arr));
  } catch {
    /* 写入失败（配额/隐私模式）不影响取数 */
  }
}

/**
 * v2.5.5 #6：带缓存的歌手全曲聚合。force=true 跳过缓存强制刷新。
 * 命中缓存时不再触发 onPartial（整批返回，渐进无意义）。
 */
export async function aggregateArtistCached(
  sources: SourceConfig[],
  artist: string,
  opts: { timeout?: number; onPartial?: (items: MediaItem[]) => void; force?: boolean } = {}
): Promise<{ items: MediaItem[]; errors: { sourceId: string; message: string }[]; supported: number; fromCache: boolean }> {
  const key = artistCacheKey(sources, artist);
  if (!opts.force) {
    const mem = _artistCache.get(key);
    if (mem && Date.now() - mem.ts < ARTIST_CACHE_TTL) {
      return { ...mem.data, fromCache: true };
    }
    const local = artistReadLocal(key);
    if (local) {
      _artistCache.set(key, { key, ts: Date.now(), data: local });
      return { ...local, fromCache: true };
    }
  }
  const r = await aggregateArtist(sources, artist, opts);
  const entry: ArtistCacheEntry = { key, ts: Date.now(), data: { items: r.items, errors: r.errors, supported: r.supported } };
  _artistCache.set(key, entry);
  artistWriteLocal(entry);
  return { ...r, fromCache: false };
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
