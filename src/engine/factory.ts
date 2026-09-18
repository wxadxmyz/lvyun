// 源适配器工厂：按 cfg.type 造对应适配器。
//
// v2.4.9：从 index.ts 抽出来的原因 —— 新增的「聚合订阅源」(bundle) 内部要按子源
// 配置递归造适配器，若它还 import index.ts 就会形成循环依赖（index → bundle → index）。
// 工厂独立后，index 与 bundle 都只依赖本文件，依赖方向单向。
import { createMusicJsonSource } from './adapters/musicJson';
import { createAlistSource } from './adapters/alist';
import { createMockSource } from './adapters/mock';
import { createTvboxSource } from './adapters/tvbox';
import { createJsSource } from './adapters/js';
import { createBundleSource } from './adapters/bundle';
import { MediaSource, SourceConfig } from './types';

// v2.6.1 A2：适配器实例缓存（方案 A 第 1 轮）。
//
// 为什么必须加：createSource() 的每个调用点（aggregateSearch / aggregateArtist /
// resolvePlay / SourceManager.test / bundle.route …）过去都是**每次新建实例**。
// 而 js.ts 的 loadCode() 把「预处理后的脚本」缓存在**实例字段** cachedCode 上 ——
// 实例一换，缓存就没了，于是：
//   · 源配置写的是 spiderUrl / api（远程脚本）时，**每次搜索都重新 fetchsource 拉一遍**
//   · tvbox 的 N 个子源、bundle 的 N 个子站同理，每次都要重建
// js.ts:60-65 的 codeKey() 注释里写着「一旦将来有人为了性能复用实例，旧实现会一直返回
// 换源前的脚本」—— 那条指纹校验就是为**现在这一步**预留的，这里直接复用即可。
//
// 缓存键必须是「影响适配器行为的一切字段」的指纹，只取 id 不够：
// 用户完全可能在源管理里改 baseUrl / spider / ext 而 id 不变（编辑同一个源）。
// 遗漏任何一项都会表现为「改了源却还在用老配置」。
function fingerprint(cfg: SourceConfig): string {
  const anyCfg = cfg as any;
  return [
    cfg.id,
    cfg.type,
    cfg.baseUrl ?? '',
    cfg.subUrl ?? '',
    cfg.token ?? '',
    anyCfg.spider ?? '',
    anyCfg.spiderUrl ?? '',
    anyCfg.api ?? '',
    // ext 可能是对象（TVBox csp），用 JSON 序列化保证内容参与指纹
    typeof anyCfg.ext === 'string' ? anyCfg.ext : JSON.stringify(anyCfg.ext ?? null),
  ].join('\u0000');
}

// 简易容量保护：源配置数量远小于此值，触发即整体清空。
// 不做 LRU 是因为实例本身很轻（只有闭包 + 一个脚本字符串），
// 而 LRU 的维护成本（每次读都要重排）反而高于它省下的内存。
const INST_CACHE_MAX = 64;
const _instCache = new Map<string, MediaSource>();

export function createSource(cfg: SourceConfig): MediaSource {
  const key = fingerprint(cfg);
  const hit = _instCache.get(key);
  if (hit) return hit;

  const src = buildSource(cfg);

  if (_instCache.size >= INST_CACHE_MAX) _instCache.clear();
  _instCache.set(key, src);
  return src;
}

/** 清除适配器实例缓存（源配置批量变更 / 刷新订阅时调用） */
export function clearSourceCache() {
  _instCache.clear();
}

function buildSource(cfg: SourceConfig): MediaSource {
  switch (cfg.type) {
    case 'music-json':
      return createMusicJsonSource(cfg);
    case 'alist':
      return createAlistSource(cfg);
    case 'tvbox':
      return createTvboxSource(cfg);
    case 'js':
      return createJsSource(cfg);
    case 'bundle':
      return createBundleSource(cfg);
    case 'mock':
      return createMockSource(cfg);
    default:
      throw new Error(`未知源类型: ${(cfg as any).type}`);
  }
}
