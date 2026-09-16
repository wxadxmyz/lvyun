import { useEffect, useRef, useState } from 'react';
import { aggregateSearchCached, MediaItem, MediaType, SourceConfig } from '../engine';
import { useLibrary } from '../lib/library';
import { downloadStore } from '../lib/downloads';
import { player } from '../lib/playerStore';
import { Icon } from './Icon';
import { SearchTrackMenu } from './SearchTrackMenu';
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
  active = true,
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
  /**
   * v2.4.9 #5.1：本搜索页当前是否可见（播放页打开时为 false）。
   * 用于「从搜索点歌进播放页 → 返回 → 回到原来那条结果」时恢复滚动位置：
   * 宿主从 display:none 恢复时 scrollTop 会被浏览器重置为 0，需要自己记住。
   */
  active?: boolean;
}) {
  const [kw, setKw] = useState(initialQuery ?? '');
  const [items, setItems] = useState<MediaItem[]>([]);
  const [errors, setErrors] = useState<{ sourceId: string; message: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  // v2.4.10 #2：渐进渲染进度 —— 「已收到 N/M 个源」。
  // 子站级增量上来时用户会看到结果在「慢慢变多」，一个细字提示能解释这种变化，
  // 否则容易被当成「结果一直在跳」。
  const [srcProgress, setSrcProgress] = useState<{ got: number; total: number } | null>(null);
  // v2.4.9 #1.5.3：搜索请求令牌 —— onPartial 是异步回调，用户可能已经改了关键词
  // 或重搜，用令牌确保「上一次搜索的迟到增量」不会覆盖当前结果。
  const runToken = useRef(0);

  // v2.5.0 #6-2：当前打开「⋮」浮层的那一行（null = 浮层关闭）
  const [menuItem, setMenuItem] = useState<MediaItem | null>(null);

  // v2.4.9 #5.1：记住搜索结果列表的滚动位置。
  // 场景：搜「周杰伦」翻到第 40 条 → 点一首进播放页 → 按返回回到搜索页，
  // 旧实现会回到列表顶部，得重新翻一遍。这里在隐藏前记下 scrollTop，重新可见时还原。
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedTop = useRef(0);
  useEffect(() => {
    if (active && scrollRef.current) scrollRef.current.scrollTop = savedTop.current;
  }, [active]);

  const showHints = !searched && kw.trim() === '';

  const run = async (q?: string, opts: { force?: boolean } = {}) => {
    const query = (q ?? kw).trim();
    if (!query) return;
    const token = ++runToken.current;
    setKw(query);
    setLoading(true);
    setSearched(true);
    setItems([]);
    setErrors([]);
    setSrcProgress(null);
    library.addSearch(query);
    // v2.4.9 #1.5.3：onPartial —— 谁快谁先上屏，不等最慢的源。
    // v2.4.9 #1.5.5：走 aggregateSearchCached，同关键词同源 10 分钟内秒回。
    // v2.4.1 #A：不硬编码 timeout（此前写死 8000 会让按类型分层永远走不到，
    // JS/TVBox 源本该拿 25s 却只有 8s，频报「部分源失败」）。交由分层超时决定。
    const r = await aggregateSearchCached(sources, query, {
      mediaType,
      force: opts.force,
      onPartial: (partial) => {
        if (token !== runToken.current) return; // 已有更新的搜索，丢弃迟到增量
        // v2.4.1 #I：给每条结果盖上「产生时的源配置指纹」。
        // 之后播放时会比对指纹 —— 若期间换过源，则旧直链不再可信，强制用新源重新解析。
        setItems(partial.map((it) => markSourceRev(it, sources)));
        setLoading(false); // 已经有内容上屏，撤掉转圈，后续增量静默追加
        // v2.4.10 #2：统计「已经出结果的子站数 / 全部子站数」。
        // sourceName 在聚合源下就是子站名，按它去重即可得到已返回的子站集合。
        const enabledTotal = sources.filter((s) => s.enabled).length;
        const got = new Set(partial.map((it) => it.sourceName).filter(Boolean)).size;
        setSrcProgress(got > 0 && got < enabledTotal ? { got, total: enabledTotal } : null);
      },
    });
    if (token !== runToken.current) return;
    setItems(r.items.map((it) => markSourceRev(it, sources)));
    setErrors(r.errors);
    setLoading(false);
    setSrcProgress(null); // 全部到齐，撤掉进度提示
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
  //
  // v2.4.10 #7：加 active 守卫。
  //   本组件在播放页打开时并没有卸载（宿主只把它 display:none 藏起来），
  //   于是这条 handler 会一直留在返回栈上。虽然 MusicApp.handleBack 现在已把
  //   播放页分支提到最前（治本），这里再加一道保险：不可见时绝不出手，
  //   免得将来又有别的路径先问到栈上，返回被这个看不见的页面悄悄吃掉。
  useEffect(() => {
    if (!onClose) return;
    return pushBackHandler(() => {
      if (!active) return false; // 不可见 → 放行给外层（播放页/其他浮层）
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
  }, [onClose, kw, active]);

  return (
    <div
      className="view searchview"
      ref={scrollRef}
      onScroll={(e) => { if (active) savedTop.current = e.currentTarget.scrollTop; }}
    >
      <div className="searchtop">
        {onClose && (
          <button className="icon sback" onClick={onClose} aria-label="返回">
            <Icon name="arrow-left" size={22} />
          </button>
        )}
        <div className="sinput">
          <span className="search-ico"><Icon name="search" size={18} /></span>
          {/* v2.4.9 #5.6：双叉号修复 —— <input type="search"> 在 Chromium / Android
              WebView 会自动注入原生清除按钮，与右侧自定义 .sclear 功能重复，
              屏幕上同时出现两个「×」。改用 type="text"（键盘行为由 enterKeyHint /
              inputMode 保持），并从 DOM 侧根除，CSS 兜底见 styles.css。 */}
          <input
            type="text"
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

      {/* v2.4.10 #2：子站级渐进渲染的进度提示 —— 结果会随各子站陆续返回而变多，
          用一行细字把这个过程讲清楚，避免用户以为列表在乱跳。 */}
      {!loading && srcProgress && (
        <div className="src-progress">已收到 {srcProgress.got}/{srcProgress.total} 个源，正在补齐…</div>
      )}

      {/* v2.4.6 #2：结果分组标题（设计稿 .grp-head）。
          单源结果时显示「来自：xxx（N）」+ 整组加入，多源则由下方 tab 承担筛选。 */}
      {searched && !loading && shown.length > 0 && (
        <div className="row-head">
          <b>
            {srcFilter === '__all__'
              ? `全部结果（${items.length}）`
              : `${srcFilter}（${shown.length}）`}
          </b>
          {enableQueue && onQueue && (
            <button className="link" onClick={() => onQueue(shown)}>整组加入队列</button>
          )}
        </div>
      )}

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
                {/* v2.4.6 #2：来源改为行内小角标（设计稿 .rw-src），
                    不再用独立的 .tsrc 列 —— 那一列会吃掉标题可用宽度，长歌名被截断。 */}
                <span className="tsrc-inline">{it.sourceName}</span>
                {/* v2.5.0 #6-3：三色付费角标（VIP / 试听 / 原唱），仅字段为真时显示 */}
                {it.vip && <span className="tag tag-vip">VIP</span>}
                {it.trial && <span className="tag tag-trial">试听</span>}
                {it.original && <span className="tag tag-orig">原唱</span>}
              </span>
            </span>
            <span className="tactions" onClick={(e) => e.stopPropagation()}>
              {/* v2.5.0 #6-1：去掉播放/加入队列按钮（整行点击即播放）；
                  只留裸红心(喜欢) + 三点，无底色圆圈。 */}
              <button
                className={'ico' + (library.isFavorite(it) ? ' on' : '')}
                title="喜欢"
                aria-label="喜欢"
                onClick={() => library.toggleFavorite(it)}
              >
                <Icon name={library.isFavorite(it) ? 'heart-filled' : 'heart'} size={20} />
              </button>
              <button
                className="ico"
                title="更多"
                aria-label="更多"
                onClick={() => setMenuItem(it)}
              >
                <Icon name="more-vertical" size={20} />
              </button>
            </span>
          </div>
        ))}
      </div>

      {searched && !loading && items.length === 0 && <div className="empty">没有找到结果，换个关键词或检查音源。</div>}

      {/* v2.5.0 #6-2：搜索结果行「⋮」浮层 */}
      {menuItem && (
        <SearchTrackMenu
          item={menuItem}
          sources={sources}
          library={library}
          onPlay={onPlay}
          onClose={() => setMenuItem(null)}
        />
      )}
    </div>
  );
}
