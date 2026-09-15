import { useEffect, useState } from 'react';
import { useLibrary } from '../lib/library';
import { usePlayback } from '../lib/playback';
import { gradientFor, initial } from '../lib/cover';
import { Icon } from '../components/Icon';
import { promptText } from '../components/PromptDialog';
import { useToast } from '../lib/toast';
// v2.3.11 #4：返回键栈式调度
import { pushBackHandler } from '../lib/backStack';

export function MyMusicModal({
  tab,
  library,
  playback,
  onClose,
}: {
  tab: 'favorites' | 'playlists';
  library: ReturnType<typeof useLibrary>;
  playback: ReturnType<typeof usePlayback>;
  onClose: () => void;
}) {
  const favs = library.lib.favorites.filter((i) => i.mediaType === 'music');
  const playlists = library.lib.playlists;
  const toast = useToast();

  // v2.4.5 #6：歌单详情子页。此前点歌单整行直接 playList 播整张，
  // 用户期望的是「进子页看歌单内容」；现在整行进详情，只有右侧 ▶ 才整张播放。
  const [openId, setOpenId] = useState<string | null>(null);
  const pl = playlists.find((p) => p.id === openId) ?? null;

  // v2.4.6 #10：行内 ⋮ 菜单（改名 / 删除），以及删除二次确认。
  // 此前 removePlaylist 虽然早就实现，但全项目没有任何 UI 调它 —— 用户建完歌单就删不掉。
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [confirmDel, setConfirmDel] = useState<{ id: string; name: string } | null>(null);
  const [headMenu, setHeadMenu] = useState(false);

  const newPlaylist = async () => {
    const name = await promptText({
      title: '新建歌单',
      placeholder: '给歌单起个名字',
      maxLength: 30,
      confirmText: '创建',
    });
    if (!name) return;
    library.createPlaylistWith(name);
    toast.push(`已创建「${name}」`);
  };

  const rename = async (id: string, old: string) => {
    setRowMenu(null);
    const name = await promptText({
      title: '重命名歌单',
      placeholder: '歌单名',
      defaultValue: old,
      maxLength: 30,
      confirmText: '保存',
    });
    if (!name || name === old) return;
    library.renamePlaylist(id, name);
    toast.push(`已重命名为「${name}」`);
  };

  const doDelete = (id: string, name: string) => {
    setRowMenu(null);
    setConfirmDel({ id, name });
  };

  // 详情子页纳入系统返回手势：先退出行内菜单，再退回列表，最后退出整个浮层
  useEffect(() => {
    if (!openId) return;
    return pushBackHandler(() => { setOpenId(null); return true; });
  }, [openId]);

  // 行内 ⋮ 菜单 / 头部菜单也纳入返回手势
  useEffect(() => {
    if (!rowMenu && !headMenu) return;
    return pushBackHandler(() => { setRowMenu(null); setHeadMenu(false); return true; });
  }, [rowMenu, headMenu]);

  // 删除确认框纳入返回手势（返回键 = 取消）
  useEffect(() => {
    if (!confirmDel) return;
    return pushBackHandler(() => { setConfirmDel(null); return true; });
  }, [confirmDel]);

  // 歌单被删掉（或切 tab）时自动收起详情，避免停在空白页
  useEffect(() => {
    if (openId && !playlists.some((p) => p.id === openId)) setOpenId(null);
  }, [playlists, openId]);

  return (
    <div className="fullpage">
      {pl ? (
        <>
          <div className="fullpage-head">
            <button className="icon" onClick={() => setOpenId(null)} aria-label="返回"><Icon name="arrow-left" /></button>
            <h3>{pl.name}</h3>
            <span className="muted sm" style={{ marginLeft: 'auto' }}>{pl.items.length} 首</span>
            {/* v2.4.6 #10：详情页 ⋮（改名 / 删除），与列表页行级 ⋮ 行为一致 */}
            <div className="head-more">
              <button className="icon" onClick={() => setHeadMenu((v) => !v)} aria-label="更多操作"><Icon name="more" /></button>
              {headMenu && (
                <>
                  <div className="rowmenu-mask" onClick={() => setHeadMenu(false)} />
                  <div className="rowmenu">
                    <button onClick={() => { setHeadMenu(false); void rename(pl.id, pl.name); }}>
                      <Icon name="edit" size={16} /> 重命名
                    </button>
                    <button className="danger" onClick={() => { setHeadMenu(false); doDelete(pl.id, pl.name); }}>
                      <Icon name="trash" size={16} /> 删除歌单
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="fullpage-body">
            {pl.items.length === 0 && <div className="empty">这个歌单还是空的。在播放页「加歌单」可以把当前歌曲收进来。</div>}
            <div className="track-list">
              {pl.items.length > 0 && (
                <div className="track-row tl2" onClick={() => playback.playList(pl.items)}>
                  <span className="tcover" style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent2))' }}><Icon name="play" size={18} /></span>
                  <span className="tmain">
                    <span className="ttitle">播放全部</span>
                    <span className="tsub">共 {pl.items.length} 首</span>
                  </span>
                </div>
              )}
              {pl.items.map((it, i) => (
                <div className="track-row tl2" key={it.sourceId + it.id} onClick={() => playback.play(it, pl.items, i)}>
                  <span className="tcover">{it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}</span>
                  <span className="tmain">
                    <span className="ttitle">{it.title}</span>
                    <span className="tsub">{it.artist ?? ''}</span>
                  </span>
                  <span className="tsrc">{it.sourceName}</span>
                  <span className="tactions">
                    <button
                      className="mini"
                      title="从歌单移除"
                      onClick={(e) => { e.stopPropagation(); library.removeFromPlaylist(pl.id, it); }}
                    ><Icon name="x" size={15} /></button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="fullpage-head">
            <button className="icon" onClick={onClose} aria-label="返回"><Icon name="arrow-left" /></button>
            <h3>{tab === 'favorites' ? '我的喜欢' : '创建的歌单'}</h3>
            <span className="muted sm" style={{ marginLeft: 'auto' }}>
              {tab === 'favorites' ? `${favs.length} 首` : `${playlists.length} 个`}
            </span>
            {/* v2.4.6 #10：歌单页头部 ⋮ —— 页级操作（新建 / 管理），
                与行级 ⋮（改名 / 删除）区分开，避免「一页一个 ⋮ 却要干两种事」。 */}
            {tab === 'playlists' && (
              <div className="head-more">
                <button className="icon" onClick={() => setHeadMenu((v) => !v)} aria-label="更多操作"><Icon name="more" /></button>
                {headMenu && (
                  <>
                    <div className="rowmenu-mask" onClick={() => setHeadMenu(false)} />
                    <div className="rowmenu">
                      <button onClick={() => { setHeadMenu(false); void newPlaylist(); }}>
                        <Icon name="plus" size={16} /> 新建歌单
                      </button>
                      <button
                        onClick={() => {
                          setHeadMenu(false);
                          if (!playlists.length) { toast.push('还没有歌单'); return; }
                          toast.push(`共 ${playlists.length} 个歌单，点歌单右侧 ⋮ 可改名或删除`);
                        }}
                      >
                        <Icon name="list" size={16} /> 管理歌单
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="fullpage-body">
            {tab === 'favorites' && (
              <>
                {favs.length === 0 && <div className="empty">还没有喜欢的歌曲。在播放页点亮 ♥ 即可加入这里。</div>}
                <div className="track-list">
                  {favs.map((it, i) => (
                    <div className="track-row tl2" key={it.sourceId + it.id} onClick={() => playback.play(it, favs, i)}>
                      <span className="tcover">{it.cover ? <img src={it.cover} alt="" /> : <span className="ph" style={{ background: gradientFor(it.title) }}>{initial(it.title)}</span>}</span>
                      <span className="tmain">
                        <span className="ttitle">{it.title}</span>
                        <span className="tsub">{it.artist ?? ''}</span>
                      </span>
                      <span className="tsrc">{it.sourceName}</span>
                      <span className={'mini fav' + (library.isFavorite(it) ? ' active' : '')} onClick={(e) => { e.stopPropagation(); library.toggleFavorite(it); }}><Icon name={library.isFavorite(it) ? 'heart-filled' : 'heart'} size={16} /></span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {tab === 'playlists' && (
              <>
                {playlists.length === 0 && (
                  <div className="empty-cta">
                    <div className="empty-cta-ico"><Icon name="list" size={30} /></div>
                    <div className="empty-cta-t">还没有创建歌单</div>
                    <div className="empty-cta-s">把喜欢的歌曲整理成歌单，随时随地开听。</div>
                    <button className="fs-pill primary2" onClick={() => { void newPlaylist(); }}>
                      <Icon name="plus" size={16} /> 新建歌单
                    </button>
                  </div>
                )}
                <div className="track-list">
                  {playlists.map((p) => (
                    <div className="track-row tl2" key={p.id} onClick={() => setOpenId(p.id)}>
                      <span className="tcover"><Icon name="list" size={18} /></span>
                      <span className="tmain">
                        <span className="ttitle">{p.name}</span>
                        <span className="tsub">{p.items.length} 首</span>
                      </span>
                      <button className="mini" title="播放全部" onClick={(e) => { e.stopPropagation(); playback.playList(p.items); }}><Icon name="play" size={14} /></button>
                      {/* v2.4.6 #10：行级 ⋮ —— 改名 / 删除（删除带二次确认） */}
                      <div className="rowmenu-wrap">
                        <button
                          className="mini"
                          title="更多"
                          aria-label="更多"
                          onClick={(e) => { e.stopPropagation(); setRowMenu(rowMenu === p.id ? null : p.id); }}
                        ><Icon name="more" size={16} /></button>
                        {rowMenu === p.id && (
                          <>
                            <div className="rowmenu-mask" onClick={(e) => { e.stopPropagation(); setRowMenu(null); }} />
                            <div className="rowmenu" onClick={(e) => e.stopPropagation()}>
                              <button onClick={() => { void rename(p.id, p.name); }}>
                                <Icon name="edit" size={16} /> 重命名
                              </button>
                              <button className="danger" onClick={() => doDelete(p.id, p.name)}>
                                <Icon name="trash" size={16} /> 删除歌单
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {/* v2.4.6 #10：删除歌单二次确认。用应用内浮层而非 window.confirm ——
          原生 confirm 在 Android WebView 里按钮文案是系统英文（CANCEL/OK），
          且宿主未实现 onJsConfirm 时直接返回 false，删除会静默失效。 */}
      {confirmDel && (
        <div className="modal-mask confirm-mask" onClick={() => setConfirmDel(null)}>
          <div className="confirm-box" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-t">删除歌单</div>
            <div className="confirm-s">确定要删除「{confirmDel.name}」吗？<br />歌单内的歌曲不会被删除。</div>
            <div className="confirm-acts">
              <button className="fs-pill ghost" onClick={() => setConfirmDel(null)}>取消</button>
              <button
                className="fs-pill danger"
                onClick={() => {
                  library.removePlaylist(confirmDel.id);
                  if (openId === confirmDel.id) setOpenId(null);
                  toast.push(`已删除「${confirmDel.name}」`);
                  setConfirmDel(null);
                }}
              >删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
