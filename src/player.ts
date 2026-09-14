// 播放解析：若 item 已带 playUrl 直接用，否则经对应源适配器取直链
import { createSource, MediaItem, SourceConfig } from './engine';

// v2.4.1 #I：源配置指纹。
// 用于判断「搜索结果产生之后，该源的配置是否已被改动（换源 / 更新订阅）」。
// 一旦指纹变化，旧结果携带的 playUrl 不再可信 —— 它可能指向旧源解析出的直链
// （CDN 签名过期 / 源已切换），表现为「点了放不出来」。
// 只取影响解析结果的关键字段，避免把 name 之类无关改动也算进去导致频繁重解析。
function sourceFingerprint(s: SourceConfig | undefined): string {
  if (!s) return '';
  const js = s as any;
  return [s.type, s.baseUrl ?? '', js.spider ?? js.code ?? '', js.spiderUrl ?? '', js.api ?? s.token ?? ''].join('\u0000');
}

/** 搜索结果里记录的指纹，供后续比对（写进 raw，无需改动 MediaItem 类型） */
export function markSourceRev(item: MediaItem, sources: SourceConfig[]): MediaItem {
  const cfg = sources.find((s) => s.id === item.sourceId);
  return { ...item, raw: { ...(item.raw ?? {}), __srcRev: sourceFingerprint(cfg) } };
}

export async function resolvePlay(item: MediaItem, sources: SourceConfig[]): Promise<MediaItem> {
  const cfg = sources.find((s) => s.id === item.sourceId);

  // v2.4.1 #I：仅当「源配置未变」时才信任已有 playUrl。
  // 此前是无条件 `if (item.playUrl) return item` —— 换源后播放旧搜索结果，
  // 会直接复用旧直链而完全不走新源配置。
  const revNow = sourceFingerprint(cfg);
  const revThen = item.raw?.__srcRev as string | undefined;
  const sameSource = revThen === undefined || revThen === revNow;

  if (item.playUrl && sameSource) return item;
  if (!cfg) return item;

  try {
    const { url, headers } = await createSource(cfg).getPlayUrl(item.id);
    return {
      ...item,
      playUrl: url,
      raw: { ...item.raw, headers, __srcRev: revNow },
    };
  } catch {
    // v2.4.1 #I：带上可判别的原因，避免一律「获取播放地址失败」让人无从下手
    throw new Error(
      revThen !== undefined && revThen !== revNow
        ? '该源配置已变更，且此歌曲在新源中不可用'
        : '获取播放地址失败',
    );
  }
}
