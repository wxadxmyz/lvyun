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

export function createSource(cfg: SourceConfig): MediaSource {
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
