import { useEffect, useState } from 'react';
import { aggregateSearch, MediaItem, MediaType, SourceConfig } from '../engine';
import { useLibrary } from '../lib/library';
import { downloadStore } from '../lib/downloads';
import { Icon } from './Icon';
// v2.4.5 #9：紧凑列表用封面色块占位
import { gradientFor, initial } from '../lib/cover';
// v2.3.11 #4：返回键栈式调度
import { pushBackHandler } from '../lib/backStack';
// v2.4.1 #I：搜索结果标记源配置指纹，供换源后判断旧直链是否仍可信
import { markSourceRev } from '../player';

export function SearchView({
  sources,
  onPlay,
  onQueue,
  library,
  mediaType,
  placeholder = '搜索…',
  enableQueue = true,
  initialQuery,
  onClose,
}: {
  sources: SourceConfig[];
  onPlay: (item: MediaItem) => void;
  onQueue?: (items: MediaItem[]) => void;
  library: ReturnType<typeof useLibrary>;
  mediaType?: MediaType;
  placeholder?: string;
  enableQueue?: boolean;
  initialQuery?: string;
  onClose?: () => void;
}) {
  const [kw, setKw] = useState(initialQuery ?? '');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [errors, setErrors] = useState<{ sourceId: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const showHints = !searched && kw.trim() === '';

  const run = async (q?: string) => {
    const query = (q ?? kw).trim();
    if (!query) return;
    setKw(query);
    setLoading(true);
    setSearched(true);
    library.addSearch(query);
    // v2.4.1 #A：不再硬编码 timeout。此前写死 8000，会让 aggregateSearch 里
    // `opts.timeout ?? TIMEOUT_BY_TYPE[s.type]` 的按类型分层永远走不到——
    // JS/TVBox 源本该拿 25s（高于 Rust 侧 reqwest 20s），实际只有 8s，
    // 叠加 QuickJS 沙箱初始化 + 每次 fetch 新建 reqwest 客户端 + TLS 握手后
    // 频频超时，表现为「部分源失败：xxx（搜索失败）」。交由分层超时决定。
    const r = await aggregateSearch(sources, query, { mediaType });
    // v2.4.1 #I：给每条结果盖上「产生时的源配置指纹」。
    // 之后播放时会比对指纹 —— 若期间换过源，则旧直链不再可信，强制用新源重新解析。
    setItems(r.items.map((it) => markSourceRev(it, sources)));
    setErrors(r.errors);
    setLoading(false);
  };

  const groups = items.reduce<Record<string, MediaItem[]>>((acc, it) => {
    (acc[it.sourceName] ??= []).push(it);
    return acc;
  }, {});

  // v2.4.5 #9：来源筛选 tab（全部 / 各音源）。跨源搜索一次能回几十条混排结果，
  // 之前只能整屏翻，现在可以只看某一个源的结果。
  const [srcFilter, setSrcFilter] = useState<string>('__all__');
  const srcNames = Object.keys(groups);
  const shown = srcFilter === '__all__' ? items : (groups[srcFilter] ?? []);
  useEffect(() => { setSrcFilter('__all__'); }, [items]);

  useEffect(() => {
    if (initialQuery && initialQuery.trim()) run(initialQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v2.3.11 #4：注册到返回栈。输入框里有内容时先清空（用户的心理预期是「退一步」），
  // 已经是空输入才真正关闭搜索页，避免一次返回把整个页面带走。
  useEffect(() => {
    if (!onClose) return;
    return pushBackHandler(() => {
      if (kw.trim() !== '') {
        setKw('');
        setSearched(false);
        setItems([]);
        setErrors([]);
        return true;
      }
      onClose();
      return true;
    });
  }, [onClose, kw]);

  return (
    <div className="view searchview">
      <div className="searchtop">
        {onClose && (
          <button className="icon sback" onClick={onClose} aria-label="返回">
            <Icon name="arrow-left" size={22} />
          </button>
        )}
        <div className="sinput">
          <span className="search-ico"><Icon name="search" size={18} /></span>
          <input
            type="search"
            enterKeyHint="search"
            inputMode="search"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            value={kw}
            onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => {
              // isComposing 在 KeyboardEvent 上同样存在（Web 标准），直接读即可；
              // 原先转成 InputEvent 属于类型误用（TS2352），且运行时等价。
              if (e.nativeEvent.isComposing) return; // 中文拼音组字中：放行上屏，不搜索
              if (e.key !== 'Enter') return;
              e.preventDefault();
              (e.target as HTMLInputElement).blur(); // 收起软键盘
              run();
            }}
            placeholder={placeholder}
          />
          {kw ? <span className="sclear" onClick={() => setKw('')}>×</span> : null}
        </div>
        <button className="primary" onClick={() => run()}>搜索</button>
      </div>

      {showHints && (
        <>
          {library.lib.searchHistory.length > 0 && (
            <div className="search-history">
              <div className="sh-head">
                <span>搜索历史</span>
                <button className="link" onClick={() => library.clearSearch()}>清空</button>
              </div>
              <div className="bubbles">
                {library.lib.searchHistory.map((h) => (
                  <span key={h} className="bub" onClick={() => run(h)}>
                    {h}
                    <span className="bub-x" onClick={(e) => { e.stopPropagation(); library.removeSearch(h); }}><Icon name="x" size={12} /></span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {errors.length > 0 && (
        <div className="err">
          部分源失败：
          {errors
            .map((e) => e.sourceId + (e.message ? `（${e.message}）` : ''))
            .join('、')}
        </div>
      )}

      {loading && <div className="loading">跨源搜索中…</div>}

      {/* v2.4.5 #9：来源筛选 tab —— 多源混排时可只看某一个源 */}
      {srcNames.length > 1 && (
        <div className="src-tabs">
          <button className={'src-tab' + (srcFilter === '__all__' ? ' on' : '')} onClick={() => setSrcFilter('__all__')}>
            全部 {items.length}
          </button>
          {srcNames.map((n) => (
            <button key={n} className={'src-tab' + (srcFilter === n ? ' on' : '')} onClick={() => setSrcFilter(n)}>
              {n} {groups[n].length}
            </button>
          ))}
        </div>
      )}

      {/* v2.4.5 #9：结果由「大卡片网格」改为「紧凑单行列表」。
          卡片一屏只能放 5~6 条、每行占 3 行高，翻十条要滑很久；
          单行紧凑列表一屏 10+ 条，歌名+歌手两行，来源变小标签。 */}
      <div className="track-list">
        {shown.map((it, i) => (
          <div
            className="track-row tl2"
            key={it.sourceId + it.id + i}
            onClick={() => onPlay(it)}
          >
            <span className="tcover">
              {it.cover
                ? <img src={it.cover} alt="" />
                : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}
            </span>
            <span className="tmain">
              <span className="ttitle">{it.title}</span>
              <span className="tsub">
                {[it.artist, it.album, it.year].filter(Boolean).join(' · ') || '未知'}
              </span>
            </span>
            {it.episodes && it.episodes.length > 1 && <span className="tsrc">{it.episodes.length}集</span>}
            <span className="tsrc">{it.sourceName}</span>
            <span className="tactions" onClick={(e) => e.stopPropagation()}>
              <button className="mini" title="播放" onClick={() => onPlay(it)}><Icon name="play" size={16} /></button>
              {enableQueue && onQueue && (
                <button className="mini" title="加入队列" onClick={() => onQueue([it])}><Icon name="plus" size={15} /></button>
              )}
              <button
                className={'mini' + (library.isFavorite(it) ? ' fav' : '')}
                title="收藏"
                onClick={() => library.toggleFavorite(it)}
              >
                <Icon name={library.isFavorite(it) ? 'heart-filled' : 'heart'} size={15} />
              </button>
              <button className="mini" title="下载" onClick={() => downloadStore.start(it)}><Icon name="download" size={15} /></button>
            </span>
          </div>
        ))}
      </div>

      {searched && srcNames.length > 1 && srcFilter !== '__all__' && enableQueue && onQueue && (
        <div className="row-head" style={{ padding: '4px 2px' }}>
          <button className="link" onClick={() => onQueue(shown)}>把当前 {shown.length} 条加入队列</button>
        </div>
      )}

      {searched && !loading && items.length === 0 && <div className="empty">没有找到结果，换个关键词或检查音源。</div>}
    </div>
  );
}
