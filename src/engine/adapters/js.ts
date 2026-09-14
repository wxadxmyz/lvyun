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
  // v2.4.1 #I：缓存要跟「脚本来源」绑定。
  // 当前所有调用点（aggregateSearch / test / resolvePlay）都是每次新建适配器实例，
  // 正常用不到这层校验；但一旦将来有人为了性能复用实例，旧实现会一直返回换源前的脚本，
  // 表现为「换了源却还在用老脚本」。加指纹是低成本的长期防御。
  let cachedKey: string | null = null;

  /** 脚本来源指纹：spider 内联内容 + 两个远程地址，任一变化即视为换源 */
  function codeKey(): string {
    return [jsCfg.spider ?? '', jsCfg.spiderUrl ?? '', jsCfg.api ?? '', jsCfg.code ?? ''].join('\u0000');
  }

  async function loadCode(): Promise<string> {
    // 来源变了 → 丢弃旧缓存重新加载
    if (cachedCode && cachedKey === codeKey()) return cachedCode;
    if (cachedCode) {
      cachedCode = null;
      cachedKey = null;
    }
    if (jsCfg.spider) {
      // 显式断言：上一行的 if 已保证非空，但 cachedCode 的类型是 string | null，
      // TS 不跨语句收窄，所以这里直接返回字面量来源。
      cachedCode = jsCfg.spider as string;
      cachedKey = codeKey();
      return jsCfg.spider as string;
    }
    if (jsCfg.spiderUrl) {
      cachedCode = await invoke<string>('fetchsource', { url: jsCfg.spiderUrl });
      cachedKey = codeKey();
      return cachedCode;
    }
    if (jsCfg.api) {
      cachedCode = await invoke<string>('fetchsource', { url: jsCfg.api });
      cachedKey = codeKey();
      return cachedCode;
    }
    // v2.4.1 #G：兜底识别 `code` 字段。正常导入路径已由 sourceFetch.normalize 归一化为
    // spider，这里再兜一层，覆盖「绕过导入路径直接构造配置」的场景（如手动编辑 localStorage）。
    if (jsCfg.code) {
      cachedCode = jsCfg.code as string;
      cachedKey = codeKey();
      return jsCfg.code as string;
    }
    throw new Error('JS 源缺少 spider 脚本（需提供 spider / spiderUrl / api / code 之一）');
  }

  async function call(func: string, args: string[]): Promise<any> {
    const code = await loadCode();
    const raw = await invoke<string>('run_spider', {
      // v2.3.11：name 供 Rust 侧标注日志归属（调试面板能看出是哪个源在请求）
      payload: { code, func, args, api: jsCfg.api, ext: jsCfg.ext, name: cfg.name },
    });
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
    // v2.3.11 #5：不少 CatVod / drpy 蜘蛛返回的是「JSON 字符串」而非对象，
    // 不再二次解析就会把整串 JSON 当成结果传下去，最终 list 取不到、表现为搜索全空。
    if (typeof parsed === 'string') {
      try {
        const again = JSON.parse(parsed);
        if (again && typeof again === 'object') return again;
      } catch {
        /* 本来就是普通字符串结果（如 play 返回的裸 URL），保持原样 */
      }
    }
    return parsed;
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
        if (items[0]) return items[0];
        // v2.4.1 #I：详情拿不到内容时明确抛错，不再静默返回空 title 占位对象。
        // 此前返回 { title: '' } 会让上层拿到一个「没有歌名的歌」，
        // 换源后播放旧结果时表现为「歌名莫名消失」，极难定位。
        throw new Error('该歌曲在当前源中已不可用（可能已换源或下架）');
      } catch (e: any) {
        // 只透传我们自己抛的语义化错误；其余（网络/解析失败）也统一升级为可见错误
        throw new Error(e?.message || '获取歌曲详情失败');
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
