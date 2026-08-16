// v2.3.0 tvbox / 影视仓聚合源适配器（重写版，已删除苹果CMS 协议）
//
// 旧版按苹果CMS 风格 GET {api}?ac=list&wd= 抓列表，对蜘蛛源/加密源全部失效。
// 新版：解析 tvbox 配置后，收集其中所有「带 spider 脚本」的源（顶层 spider /
// 各站点 spider / 远程脚本 api），全部委托 createJsSource 在统一 JS 引擎里执行。
// 抓取统一走 Rust 后端 fetchsource 代理，绕开 Android WebView 的 CORS 与明文 HTTP 限制。
import { invoke } from '@tauri-apps/api/core';
import { MediaItem, MediaSource, PlayUrl, SourceConfig } from '../types';
import { createJsSource } from './js';

async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// E5 加密源解密占位（同影流）：整体密文由 tryDecodeConfig 解密为 spider 代码
function tryDecodeConfig(text: string): string {
  return text.trim();
}

async function collectSpiders(cfg: SourceConfig): Promise<SourceConfig[]> {
  const text = await fetchText(cfg.baseUrl);
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return [{ ...cfg, type: 'js', name: cfg.name, spider: tryDecodeConfig(text) } as SourceConfig];
  }
  const out: SourceConfig[] = [];
  if (data.spider) {
    out.push({
      ...cfg,
      type: 'js',
      name: cfg.name,
      spider: typeof data.spider === 'string' ? data.spider : JSON.stringify(data.spider),
    } as SourceConfig);
  }
  if (Array.isArray(data.sites)) {
    for (const s of data.sites) {
      if (s.spider || (typeof s.api === 'string' && /^https?:\/\//.test(s.api))) {
        out.push({
          ...cfg,
          type: 'js',
          name: s.name || s.key || cfg.name,
          spider: s.spider,
          spiderUrl: s.spiderUrl,
          api: s.api,
        } as SourceConfig);
      }
    }
  }
  return out;
}

export function createTvboxSource(cfg: SourceConfig): MediaSource {
  async function spiders(): Promise<MediaSource[]> {
    return (await collectSpiders(cfg)).map((c) => createJsSource(c));
  }

  return {
    async search(keyword: string): Promise<MediaItem[]> {
      const srcs = await spiders();
      if (!srcs.length) {
        throw new Error('该 tvbox 配置无可用的 spider 脚本源（csp_* 蜘蛛代号需提供对应 spider 脚本）');
      }
      const results = await Promise.all(
        srcs.map(async (s) => {
          try {
            return await s.search(keyword);
          } catch {
            return [] as MediaItem[];
          }
        })
      );
      const items = results.flat();
      if (!items.length) throw new Error('未从任何 spider 源获取到结果');
      return items;
    },

    async getPlayUrl(itemId: string): Promise<PlayUrl> {
      const srcs = await spiders();
      for (const s of srcs) {
        try {
          const r = await s.getPlayUrl(itemId);
          if (r.url) return r;
        } catch {
          /* 尝试下一个源 */
        }
      }
      return { url: '' };
    },

    async getDetail(itemId: string) {
      const srcs = await spiders();
      for (const s of srcs) {
        try {
          const r = await s.getDetail!(itemId);
          if (r && r.title) return r;
        } catch {
          /* 尝试下一个源 */
        }
      }
      return {
        id: itemId,
        sourceId: cfg.id,
        sourceName: cfg.name,
        title: '',
        mediaType: 'music' as const,
      };
    },

    async test(): Promise<boolean> {
      const srcs = await spiders();
      return srcs.length > 0;
    },
  };
}
