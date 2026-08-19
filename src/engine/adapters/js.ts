import { invoke } from '@tauri-apps/api/core';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';

// v2.3.0 统一 JS 引擎源适配器（律云版）
// 执行 spider 脚本驱动任意音乐源（洛雪风格 / 网上各种 JS 音乐蜘蛛）。脚本经 Rust
// run_spider 命令在 QuickJS 沙箱内运行，网络请求由 fetch 桥接回 Rust 代理。
// spider 约定函数：search(key) / detail(id) / play(url)
// 返回遵循常见音乐蜘蛛格式：{ list:[{ id, name, artist, album, pic }] }

export function createJsSource(cfg: SourceConfig): MediaSource {
  const jsCfg = cfg as any;
  let cachedCode: string | null = null;

  async function loadCode(): Promise<string> {
    if (cachedCode) return cachedCode;
    if (jsCfg.spider) {
      cachedCode = jsCfg.spider;
      return cachedCode;
    }
    if (jsCfg.spiderUrl) {
      cachedCode = await invoke<string>('fetchsource', { url: jsCfg.spiderUrl });
      return cachedCode;
    }
    if (jsCfg.api) {
      cachedCode = await invoke<string>('fetchsource', { url: jsCfg.api });
      return cachedCode;
    }
    throw new Error('JS 源缺少 spider 脚本（需提供 spider / spiderUrl / api 之一）');
  }

  async function call(func: string, args: string[]): Promise<any> {
    const code = await loadCode();
    const raw = await invoke<string>('run_spider', {
      payload: { code, func, args, api: jsCfg.api, ext: jsCfg.ext },
    });
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function toItems(list: any[]): MediaItem[] {
    if (!Array.isArray(list)) return [];
    return list.map((v: any) => ({
      id: String(v.id ?? v.vod_id ?? ''),
      sourceId: cfg.id,
      sourceName: cfg.name,
      title: v.name ?? v.title ?? v.vod_name ?? '未命名',
      artist: v.artist ?? v.singer ?? v.vod_actor ?? '',
      album: v.album ?? '',
      cover: v.pic ?? v.cover ?? v.vod_pic ?? '',
      mediaType: 'music' as const,
      raw: v,
    }));
  }

  return {
    async search(keyword: string) {
      const data = await call('search', [keyword]);
      const list = data?.list ?? (Array.isArray(data) ? data : []);
      return toItems(list);
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const data = await call('play', [itemId]);
      const url = typeof data === 'string' ? data : data?.url ?? '';
      return { url };
    },

    async getDetail(itemId: string) {
      try {
        const data = await call('detail', [itemId]);
        const list = data?.list ?? (Array.isArray(data) ? data : []);
        const items = toItems(list);
        return (
          items[0] ??
          {
            id: itemId,
            sourceId: cfg.id,
            sourceName: cfg.name,
            title: '',
            mediaType: 'music' as const,
          }
        );
      } catch {
        return {
          id: itemId,
          sourceId: cfg.id,
          sourceName: cfg.name,
          title: '',
          mediaType: 'music' as const,
        };
      }
    },

    async test() {
      try {
        await loadCode();
        return true;
      } catch {
        return false;
      }
    },
  };
}
