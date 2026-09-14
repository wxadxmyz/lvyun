import { useCallback, useEffect, useRef, useState } from 'react';
import { useLibrary } from '../../lib/library';
import { usePlayback } from '../../lib/playback';
import { SourceConfig } from '../../engine/types';
import { Icon } from '../../components/Icon';
import { fetchToplists, ToplistItem } from '../../lib/toplists';
import { ToplistDetail } from './ToplistDetail';

export function Discover({
  sources,
  library,
  playback,
  onSearch,
  onOpenSources,
  onOpenHistory,
  onOpenDebug,
  onOpenLocal,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onSearch: (q: string) => void;
  onOpenSources: () => void;
  onOpenHistory: () => void;
  onOpenDebug: () => void;
  onOpenLocal: () => void;
}) {
  // v2.4.0 I1：主页榜单（策展式静态数据，不含歌曲；点进用 keyword 搜用户自己的音源）
  const [toplists, setToplists] = useState<ToplistItem[] | null>(null);
  const [active, setActive] = useState<ToplistItem | null>(null);

  const [refreshing, setRefreshing] = useState(false);

  // v2.4.1 #F：抽成独立函数，供「首次挂载 / 源变化 / 手动刷新」三处复用。
  // force=true 时跳过 12h 缓存直连网络（手动刷新用）。
  const loadToplists = useCallback((force = false) => {
    // v2.4.5 #11：force 请求也给可见加载态（此前只有手动刷新按钮转圈，
    // 源变化触发的刷新是完全静默的 —— 用户以为「主页没刷新」）。
    if (force) setRefreshing(true);
    // 拉取失败一律返回 null，主页静默不渲染榜单区（不影响原有首页）
    return fetchToplists(force)
      .then((d) => setToplists(d?.toplists ?? null))
      .catch(() => setToplists(null))
      .finally(() => { if (force) setRefreshing(false); });
  }, []);

  // v2.4.5 #11（原 v2.5.0 #2）：加 / 删源时强制绕过 12h 榜单缓存。
  // 旧逻辑依赖 sources.length 会重跑 effect，但走的是缓存分支 —— 拿回完全相同的旧数据，
  // 页面零变化，用户只能「杀进程重开」才看到新榜。现在：源数量真的变了 → force。
  const lastSrcCount = useRef<number>(sources.length);
  useEffect(() => {
    const changed = lastSrcCount.current !== sources.length;
    lastSrcCount.current = sources.length;
    void loadToplists(changed);
  }, [loadToplists, sources.length]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void loadToplists(true).finally(() => setRefreshing(false));
  }, [loadToplists]);

  const homeTop = (
    <div className="home-top">
      <div className="ht-logo">律<span className="dot">云</span></div>
      <div className="ht-actions">
        <button className="ht-ico" onClick={onOpenLocal} title="本地音乐"><Icon name="folder" size={22} /></button>
        <button className="ht-ico" onClick={() => onSearch('')} title="搜索"><Icon name="search" size={22} /></button>
        {/* v2.4.1 #F：手动刷新榜单（force 绕过 12h 缓存，真去网络拉最新） */}
        <button
          className={'ht-ico' + (refreshing ? ' spinning' : '')}
          onClick={onRefresh}
          disabled={refreshing}
          title="刷新榜单"
          aria-label="刷新榜单"
        >
          <Icon name="refresh" size={22} />
        </button>
        <button className="ht-ico" onClick={onOpenHistory} title="历史"><Icon name="clock" size={22} /></button>
        <button className="ht-ico" onClick={onOpenDebug} title="调试"><Icon name="bug" size={22} /></button>
      </div>
    </div>
  );

  if (sources.length === 0) {
    return (
      <div className="view discover">
        {homeTop}
        <div className="blank-state">
          <div className="blank-art"><Icon name="music" size={44} /></div>
          <h2>导入音乐源发现音乐</h2>
          <p className="muted">在「设置 → 音源管理」里导入一个 JSON 音源，<br />榜单与搜索就会在这里出现。</p>
          <button className="import-fab" onClick={onOpenSources}>
            <Icon name="plus" size={18} /> 导入音源
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="view discover">
      {homeTop}

      {/* v2.4.0 I1：热门榜单 3×3 九宫格，正方形封面，整页上下滑 */}
      {toplists && toplists.length > 0 && (
        <section className="toplist-section">
          <div className="row-head"><h3>热门榜单</h3></div>
          <div className="toplist-grid">
            {toplists.map((t) => {
              const [c1, c2] = t.color && t.color.length === 2 ? t.color : ['#ff5e99', '#ff8a4c'];
              return (
                <button
                  key={t.id}
                  className="tl-card"
                  onClick={() => setActive(t)}
                  style={{ background: `linear-gradient(140deg, ${c1}, ${c2})` }}
                >
                  <span className="tl-rank">{t.initial ?? t.name.slice(0, 1)}</span>
                  <span className="tl-name">{t.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {active && (
        <ToplistDetail
          item={active}
          sources={sources}
          library={library}
          playback={playback}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}
