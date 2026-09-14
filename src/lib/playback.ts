import { player, usePlayer } from './playerStore';
import { resolvePlay } from '../player';
import { MediaItem, SourceConfig } from '../engine/types';
import { useLibrary } from './library';

// 统一的「播放一个 / 播放一整列」逻辑，供音乐与影视两端复用
//
// v2.4.5 #6：新增第三参 onPlayed —— 「播完顺手跳到播放页」的钩子。
// 此前 play/playList 只负责播放、不含任何导航，于是「搜索结果点一首、没反应」
// （其实是播了但界面没动），10 个调用点各漏一遍。
// 现在由宿主（MusicApp）注入 goTab('player')，所有入口一处生效，
// 以后新增入口也不会再漏。
export function usePlayback(
  sources: SourceConfig[],
  library: ReturnType<typeof useLibrary>,
  onPlayed?: () => void,
) {
  // 订阅一次，保证组件在 player 状态变化时刷新
  usePlayer();

  const play = async (item: MediaItem, queue?: MediaItem[], index = 0) => {
    library.addHistory(item);
    if (queue && queue.length) player.playQueue(queue, index);
    else player.playItem(item);
    onPlayed?.();
  };

  const playList = (items: MediaItem[], index = 0) => {
    if (!items.length) return;
    library.addHistory(items[Math.max(0, Math.min(index, items.length - 1))]);
    player.playQueue(items, index);
    onPlayed?.();
  };

  return { play, playList };
}

// 媒体元素（audio/video）共用的解析逻辑：current 变化时按需取直链并播放
export function useMediaResolver(sources: SourceConfig[]) {
  const state = usePlayer();

  const ensureResolved = async (item: MediaItem) => {
    if (item.playUrl) return item;
    try {
      const r = await resolvePlay(item, sources);
      player.updateCurrent(r);
      return r;
    } catch {
      return item;
    }
  };

  return { state, ensureResolved };
}
