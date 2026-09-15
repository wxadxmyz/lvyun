// 播放解析：若 item 已带 playUrl 直接用，否则经对应源适配器取直链
import { createSource, MediaItem, SourceConfig } from './engine';
import { parseLrc } from './lib/lrc';

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

/**
 * v2.4.8 #1：歌词解析。
 * 若 item 已带 lyric（如本地音乐内嵌）直接返回；否则向对应源请求歌词，
 * 把源返回的「LRC 原文 / base64 已解码文本 / 纯文本行数组」统一解析成 LyricLine[]。
 * 任何失败都静默返回空数组 —— 歌词是增强项，不该阻断播放。
 */
export async function resolveLyric(item: MediaItem, sources: SourceConfig[]): Promise<MediaItem> {
  if (Array.isArray(item.lyric) && item.lyric.length) return item;

  const cfg = sources.find((s) => s.id === item.sourceId);
  if (!cfg) return item;

  try {
    const src = createSource(cfg);
    if (typeof src.getLyric !== 'function') return item;
    const raw = await src.getLyric(item);

    // 源可能返回：LyricLine[] / 纯文本行数组 / LRC 原文字符串
    let lines: MediaItem['lyric'] = [];
    if (Array.isArray(raw)) {
      // 已是 {time,text} 直接用；否则按纯文本行处理（无时间轴）
      lines = raw.every((v: any) => v && typeof v === 'object' && 'text' in v)
        ? (raw as import('./engine/types').LyricLine[])
        : (raw as string[]).map((t) => ({ time: 0, text: String(t) }));
    } else if (typeof raw === 'string' && raw) {
      const parsed = parseLrc(raw);
      // 解析不出时间轴（纯文本歌词）时降级为无时间轴行，至少能显示
      lines = parsed.length ? parsed : raw.split(/\r?\n/).filter(Boolean).map((t) => ({ time: 0, text: t }));
    }
    if (!lines || !lines.length) return item;
    return { ...item, lyric: lines };
  } catch {
    return item; // 歌词失败不影响播放
  }
}
