import { useCallback, useEffect, useState } from 'react';
import { MediaItem } from '../engine/types';

const PREFIX = 'mps_lib_';

export interface Playlist {
  id: string;
  name: string;
  items: MediaItem[];
}

export interface LibraryState {
  history: MediaItem[]; // 最近播放/观看，最新在前
  favorites: MediaItem[]; // 收藏
  playlists: Playlist[];
  searchHistory: string[]; // 搜索历史
  watchProgress: Record<string, number>; // 影视观看进度（秒）
  localMusic: MediaItem[]; // 本地导入
}

function uid() {
  return 'p_' + Math.random().toString(36).slice(2, 9);
}

function keyOf(it: MediaItem) {
  return `${it.sourceId}:${it.id}`;
}

/**
 * v2.3.11 #6：本地音乐的去重键。
 * 优先用播放地址（同一文件被两条路径扫到也应视为一首）；
 * 没有地址时退回「歌名 + 歌手」组合，避免同一首歌重复入库。
 */
export function localKeyOf(it: MediaItem) {
  return it.playUrl || keyOf(it) || `${it.title} ${it.artist ?? ''}`;
}

function load(appKey: string): LibraryState {
  try {
    const raw = localStorage.getItem(PREFIX + appKey);
    if (raw) return { history: [], favorites: [], playlists: [], searchHistory: [], watchProgress: {}, localMusic: [], ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { history: [], favorites: [], playlists: [], searchHistory: [], watchProgress: {}, localMusic: [] };
}

export function useLibrary(appKey: string) {
  const [lib, setLib] = useState<LibraryState>(() => load(appKey));
  // v2.3.11 #6：localStorage 写入失败（配额超限）要让用户知道。
  // 此前 setItem 直接抛在 useEffect 里，既没提示也可能打断渲染，用户只看到列表空了。
  const [storageError, setStorageError] = useState<string | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(PREFIX + appKey, JSON.stringify(lib));
      setStorageError((prev) => (prev ? null : prev));
    } catch {
      setStorageError('本地存储空间不足，最新改动未能保存（多为本地音乐条目过多所致）');
    }
  }, [lib, appKey]);

  const addHistory = useCallback((item: MediaItem) => {
    setLib((l) => {
      const k = keyOf(item);
      const rest = l.history.filter((x) => keyOf(x) !== k);
      return { ...l, history: [item, ...rest].slice(0, 60) };
    });
  }, []);

  const addSearch = useCallback((kw: string) => {
    const t = kw.trim();
    if (!t) return;
    setLib((l) => ({ ...l, searchHistory: [t, ...l.searchHistory.filter((x) => x !== t)].slice(0, 20) }));
  }, []);

  const clearSearch = useCallback(() => setLib((l) => ({ ...l, searchHistory: [] })), []);

  const removeSearch = useCallback((kw: string) => {
    const t = kw.trim();
    if (!t) return;
    setLib((l) => ({ ...l, searchHistory: l.searchHistory.filter((x) => x !== t) }));
  }, []);

  const toggleFavorite = useCallback((item: MediaItem) => {
    setLib((l) => {
      const k = keyOf(item);
      const exists = l.favorites.some((x) => keyOf(x) === k);
      return exists
        ? { ...l, favorites: l.favorites.filter((x) => keyOf(x) !== k) }
        : { ...l, favorites: [item, ...l.favorites] };
    });
  }, []);

  const isFavorite = useCallback(
    (item: MediaItem) => lib.favorites.some((x) => keyOf(x) === keyOf(item)),
    [lib.favorites]
  );

  const createPlaylist = useCallback((name: string) => {
    setLib((l) => ({ ...l, playlists: [...l.playlists, { id: uid(), name: name || '我的歌单', items: [] }] }));
  }, []);

  const removePlaylist = useCallback((pid: string) => {
    setLib((l) => ({ ...l, playlists: l.playlists.filter((p) => p.id !== pid) }));
  }, []);

  const addToPlaylist = useCallback((pid: string, item: MediaItem) => {
    setLib((l) => ({
      ...l,
      playlists: l.playlists.map((p) =>
        p.id === pid && !p.items.some((x) => keyOf(x) === keyOf(item))
          ? { ...p, items: [...p.items, item] }
          : p
      ),
    }));
  }, []);

  const removeFromPlaylist = useCallback((pid: string, item: MediaItem) => {
    setLib((l) => ({
      ...l,
      playlists: l.playlists.map((p) =>
        p.id === pid ? { ...p, items: p.items.filter((x) => keyOf(x) !== keyOf(item)) } : p
      ),
    }));
  }, []);

  const setWatchProgress = useCallback((id: string, seconds: number) => {
    setLib((l) => ({ ...l, watchProgress: { ...l.watchProgress, [id]: Math.floor(seconds) } }));
  }, []);

  const clearHistory = useCallback(() => setLib((l) => ({ ...l, history: [] })), []);

  /* -----------------------------------------------------------------------
   * v2.3.11 #6：本地音乐成为「唯一写入口」。
   * 此前全盘搜索写自己的 localStorage['lvyun.localMusic.v1']，「我的音乐 → 本地音乐」
   * 写 library.lib.localMusic，两个列表互不可见，用户得在两个地方各管一遍。
   * 现在全盘搜索 / 选文件夹 / 选文件三条路都归到这里。
   * 去重键优先用文件地址；地址缺失时退回「歌名 + 歌手」组合，避免同一首歌重复入库。
   * --------------------------------------------------------------------- */
  const addLocalMusic = useCallback(
    (items: MediaItem[]) => {
      const key = (x: MediaItem) => localKeyOf(x);
      const seen = new Set(lib.localMusic.map(key));
      const fresh: MediaItem[] = [];
      for (const it of items) {
        const k = key(it);
        if (seen.has(k)) continue;
        seen.add(k);
        fresh.push(it);
      }
      if (fresh.length) setLib((l) => ({ ...l, localMusic: [...fresh, ...l.localMusic] }));
      return fresh.length; // 返回真正入库的条数，供 UI 显示「新增 N / 重复跳过 M」
    },
    [lib.localMusic],
  );

  const removeLocalMusic = useCallback((it: MediaItem) => {
    const k = localKeyOf(it);
    setLib((l) => ({ ...l, localMusic: l.localMusic.filter((x) => localKeyOf(x) !== k) }));
  }, []);

  const clearLocalMusic = useCallback(() => setLib((l) => ({ ...l, localMusic: [] })), []);

  return {
    lib,
    storageError,
    addHistory,
    addSearch,
    clearSearch,
    removeSearch,
    toggleFavorite,
    isFavorite,
    createPlaylist,
    removePlaylist,
    addToPlaylist,
    removeFromPlaylist,
    setWatchProgress,
    clearHistory,
    addLocalMusic,
    removeLocalMusic,
    clearLocalMusic,
  };
}
