import { useCallback, useSyncExternalStore } from 'react';
import { createSource, SourceConfig, SourceType, uuid } from './engine';
import { fetchFromUrl } from './lib/sourceFetch';

const PREFIX = 'mps_sources_';

export interface SourceForm {
  name: string;
  type: SourceType;
  baseUrl: string;
  token?: string;
  mountPath?: string;
}

/* ============================================================================
 * v2.4.6 #1（最高优先级）：源存储改为「全局单例」。
 *
 * 旧实现是 `useState(() => load(appKey))` —— **每次调用 useSources 都各建一份 state**，
 * 而项目里有 4 个组件同时在用：
 *
 *   src/music/MusicApp.tsx:30           useSources('music')   ← 主页 / 搜索 / 播放全靠它
 *   src/music/SettingsPage.tsx:82       useSources('music')   ← 导入源写的是这个
 *   src/components/ImportSourcePage.tsx:19   useSources(mediaType)
 *   src/components/SourceListPage.tsx:19     useSources(mediaType)
 *
 * 于是在设置页导入音源后，只有「导入页那一份」和「设置页那一份」更新了，
 * **MusicApp 那份完全不知情** —— 主页榜单不刷新、搜索拿到空数组，必须退后台重进
 * （重新挂载 → load() 重读 localStorage）才恢复。v2.4.5 据此加的
 * `lastSrcCount` 强制刷新逻辑因为「源数组根本没变」而永远不触发，等于白写。
 *
 * 现在改为模块级单例 + useSyncExternalStore：
 *   - 同一 appKey 全局只有一份数据（cache）；
 *   - 任何组件写入 → write() → emit() → **所有订阅者同时重渲染**；
 *   - 内存与 localStorage 在同一个 write() 里落盘，保证两者一致；
 *   - 顺带修掉「两个组件同时挂载时后写覆盖先写」的数据竞争。
 *
 * appKey 仍区分 'music' / 'video'，两个 App 互不干扰。
 * ==========================================================================*/

const cache = new Map<string, SourceConfig[]>();
const listeners = new Map<string, Set<() => void>>();

function load(appKey: string): SourceConfig[] {
  try {
    const raw = localStorage.getItem(PREFIX + appKey);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* ignore */
  }
  // 无默认源：首次运行为干净的空态，由用户自行导入真实源
  return [];
}

/** 读取当前快照。useSyncExternalStore 要求「同一份未变更的数据返回同一引用」，
 *  否则会无限重渲染 —— 所以这里必须走 cache。 */
function getSnapshot(appKey: string): SourceConfig[] {
  let cur = cache.get(appKey);
  if (!cur) {
    cur = load(appKey);
    cache.set(appKey, cur);
  }
  return cur;
}

function subscribe(appKey: string, cb: () => void): () => void {
  let set = listeners.get(appKey);
  if (!set) {
    set = new Set();
    listeners.set(appKey, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(appKey);
  };
}

function emit(appKey: string): void {
  const set = listeners.get(appKey);
  if (set) for (const cb of Array.from(set)) cb();
}

/** 唯一写入口：更新 cache → 落盘 → 通知全部订阅者。 */
function write(appKey: string, next: SourceConfig[]): void {
  cache.set(appKey, next);
  try {
    localStorage.setItem(PREFIX + appKey, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  emit(appKey);
}

/** 读到最新数组再算新值（避免闭包里拿到过期 sources）。 */
function mutate(appKey: string, fn: (cur: SourceConfig[]) => SourceConfig[]): void {
  write(appKey, fn(getSnapshot(appKey)));
}

export function useSources(appKey: string) {
  const sources = useSyncExternalStore(
    useCallback((cb: () => void) => subscribe(appKey, cb), [appKey]),
    useCallback(() => getSnapshot(appKey), [appKey]),
  );

  const add = useCallback((form: SourceForm) => {
    mutate(appKey, (s) => [
      ...s,
      {
        id: uuid(),
        name: form.name,
        type: form.type,
        baseUrl: form.baseUrl,
        token: form.token,
        enabled: true,
        priority: s.length,
        extra: form.mountPath ? { mountPath: form.mountPath } : undefined,
      },
    ]);
  }, [appKey]);

  const update = useCallback((id: string, patch: Partial<SourceConfig>) => {
    mutate(appKey, (s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }, [appKey]);

  const remove = useCallback((id: string) => {
    mutate(appKey, (s) => s.filter((x) => x.id !== id));
  }, [appKey]);

  const toggle = useCallback((id: string) => {
    mutate(appKey, (s) => s.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));
  }, [appKey]);

  const move = useCallback((id: string, dir: -1 | 1) => {
    mutate(appKey, (s) => {
      const sorted = [...s].sort((a, b) => a.priority - b.priority);
      const i = sorted.findIndex((x) => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= sorted.length) return s;
      const pa = sorted[i].priority;
      sorted[i].priority = sorted[j].priority;
      sorted[j].priority = pa;
      return sorted;
    });
  }, [appKey]);

  const importSources = useCallback((json: string): { added: number; errors: string[] } => {
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return { added: 0, errors: ['应为源数组 JSON'] };
      const valid = arr.filter((r: any) => r?.type && r?.baseUrl);
      mutate(appKey, (s) => [
        ...s,
        ...valid.map((r: any) => ({ id: uuid(), enabled: true, priority: s.length, ...r })),
      ]);
      const errors = arr.length - valid.length > 0 ? ['已跳过无效条目'] : [];
      return { added: valid.length, errors };
    } catch (e: any) {
      return { added: 0, errors: [e?.message ?? '解析失败'] };
    }
  }, [appKey]);

  const exportSources = useCallback((): string => {
    return JSON.stringify(getSnapshot(appKey), null, 2);
  }, [appKey]);

  // v2.4.0 A2：刷新某个订阅地址。按 baseUrl 去重；已存在则同步元信息（本地手改优先，不覆盖 baseUrl/token/extra），
  // 不存在则新增，统一打上 subUrl + subUpdatedAt。
  const refreshSubscription = useCallback(async (subUrl: string): Promise<{ ok: number; errors: string[] }> => {
    try {
      const res = await fetchFromUrl(subUrl);
      if (res.kind !== 'sources') {
        return { ok: 0, errors: [res.kind === 'error' ? res.message : '订阅未返回可用源'] };
      }
      mutate(appKey, (s) => {
        const next = [...s];
        const byBase = new Map(next.map((x) => [x.baseUrl, x]));
        for (const src of res.sources) {
          const existing = byBase.get(src.baseUrl);
          if (existing) {
            existing.name = src.name || existing.name; // 本地为准：仅同步名字
            existing.subUpdatedAt = Date.now();
          } else {
            next.push({
              id: uuid(),
              name: src.name || src.api || src.baseUrl || '订阅源',
              type: src.type,
              baseUrl: src.baseUrl,
              token: src.token,
              enabled: true,
              priority: next.length,
              subUrl,
              subUpdatedAt: Date.now(),
              extra: src.mountPath ? { mountPath: src.mountPath } : undefined,
            });
          }
        }
        return next;
      });
      return { ok: res.sources.length, errors: [] };
    } catch (e: any) {
      return { ok: 0, errors: [e?.message ?? '订阅刷新失败'] };
    }
  }, [appKey]);

  const test = useCallback(async (cfg: SourceConfig): Promise<boolean> => {
    try {
      return await createSource(cfg).test();
    } catch {
      return false;
    }
  }, []);

  return { sources, add, update, remove, toggle, move, importSources, exportSources, refreshSubscription, test };
}

/** 测试/调试用：重置某个 appKey 的内存缓存（不影响 localStorage）。 */
export function __resetSourceCache(appKey?: string): void {
  if (appKey) cache.delete(appKey);
  else cache.clear();
}
