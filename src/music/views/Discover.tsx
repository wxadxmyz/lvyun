import { useCallback, useEffect, useRef, useState } from 'react';
import { useLibrary } from '../../lib/library';
import { usePlayback } from '../../lib/playback';
import { SourceConfig } from '../../engine/types';
import { Icon } from '../../components/Icon';
import { fetchToplists, ToplistItem } from '../../lib/toplists';
import { ToplistDetail } from './ToplistDetail';

// v2.6.0：把榜单主色提亮，派生出 2×2 拼图的另外两块色（无真实封面图，用色块拼出 UI.html 拼图感）
function lighten(hex: string, amt: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.min(255, ((n >> 16) & 255) + amt);
  const g = Math.min(255, ((n >> 8) & 255) + amt);
  const b = Math.min(255, (n & 255) + amt);
  return `rgb(${r}, ${g}, ${b})`;
}

export function Discover({
  sources,
  library,
  playback,
  onSearch,
  onOpenSources,
  onOpenHistory,
  onOpenLocal,
}: {
  sources: SourceConfig[];
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onSearch: (q: string) => void;
  onOpenSources: () => void;
  onOpenHistory: () => void;
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

  // v2.4.6 #1：加 / 删源时强制绕过 12h 榜单缓存。
  //
  // ⚠️ v2.4.5 这段是**死代码**：当时 useSources 每次调用各建一份 state，
  //    在设置页导入源只更新了设置页那份，Discover 收到的 sources.length 从没变过，
  //    `changed` 恒为 false，force 分支永不执行。现在 store 已改全局单例（见 store.ts），
  //    导入 / 删除源会真正传播到这里，这段逻辑才第一次真正生效。
  //
  // 另外把「只看数量」升级为「看源集合指纹」：编辑同一源的 baseUrl 或换掉一个源
  // 但数量不变时，也应该刷新。
  const srcKey = sources.map((s) => s.id + ':' + (s.enabled ? '1' : '0')).join('|');
  const lastSrcKey = useRef<string>(srcKey);
  useEffect(() => {
    const changed = lastSrcKey.current !== srcKey;
    lastSrcKey.current = srcKey;
    void loadToplists(changed);
  }, [loadToplists, srcKey]);

  // v2.4.9 #5.5：手动刷新入口已移除，onRefresh 随之删除。
  // 榜单刷新现在只在「首次挂载 + 源集合变化」时自动触发（见下方 useEffect）。

  const homeTop = (
    <div className="home-top">
      <div className="ht-logo">律<span className="dot">云</span></div>
      <div className="ht-actions">
        <button className="ht-ico" onClick={onOpenLocal} title="本地音乐"><Icon name="folder" size={22} /></button>
        <button className="ht-ico" onClick={() => onSearch('')} title="搜索"><Icon name="search" size={22} /></button>
        {/* v2.4.9 #5.5：主页刷新按钮已删除（用户拍板）。
            理由：它只拉榜单（force 绕过 12h 缓存），与音源无关；
            且它是当初「源不能用了」误判的元凶 —— 用户按了刷新后搜索失败，
            容易归咎于按钮把源清掉了（见问题调查报告 §2）。
            榜单本身在「加/删/改源」时会自动强制刷新，无需手动入口。 */}
        <button className="ht-ico" onClick={onOpenHistory} title="历史"><Icon name="clock" size={22} /></button>
        {/* v2.4.6 #12（方案 A）：主页「调试」虫图标已移除。
            新入口 = 设置 → 关于 → 连点版本号 7 次。 */}
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
          <div className="row-head">
            <h3>热门榜单</h3>
            {/* v2.4.9 #5.5：刷新按钮删除后，把「正在更新」的可见反馈挪到这里。
                保持 v2.4.5 #11 的可见加载态（源变化时榜单会强制刷新），
                只是触发方式从手动按钮变成自动。 */}
            {refreshing && <span className="muted sm">更新中…</span>}
          </div>
          <div className="toplist-grid">
            {toplists.map((t) => {
              const [c1, c2] = t.color && t.color.length === 2 ? t.color : ['#ff5e99', '#ff8a4c'];
              return (
                <button
                  key={t.id}
                  className="tl-card"
                  onClick={() => setActive(t)}
                >
                  {/* v2.6.0：2×2 封面拼图（色块由榜单主色派生） */}
                  <span className="tg">
                    <i style={{ background: c1 }} />
                    <i style={{ background: lighten(c1, 38) }} />
                    <i style={{ background: lighten(c2, 38) }} />
                    <i style={{ background: c2 }} />
                  </span>
                  <span className="ti">
                    <span className="tn">{t.name}</span>
                    {t.desc && <span className="ts">{t.desc}</span>}
                  </span>
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
