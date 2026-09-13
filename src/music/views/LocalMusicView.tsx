import { useEffect, useState } from 'react';
import { MediaItem } from '../../engine/types';
import { usePlayback } from '../../lib/playback';
import { useToast } from '../../lib/toast';
import { Icon } from '../../components/Icon';
import { pickAudioFiles, toMediaItems } from '../../lib/localMusic';

// #7：扫描本地文件 → 跳转独立界面。
// 原来首页 📁 直接弹系统目录选择器，安卓上报 "Folder picker not implemented on mobile"；
// 现在改为进入本界面，支持「选择文件夹 / 选择文件」，并保留已导入列表（localStorage 持久化）。
const STORE_KEY = 'lvyun.localMusic.v1';

export function LocalMusicView({
  playback,
  onClose,
}: {
  playback: ReturnType<typeof usePlayback>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setItems(JSON.parse(raw));
    } catch {
      /* 忽略损坏的本地数据 */
    }
  }, []);

  const persist = (list: MediaItem[]) => {
    setItems(list);
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(list));
    } catch {
      /* 忽略存储失败 */
    }
  };

  const merge = (added: MediaItem[]) => {
    const map = new Map<string, MediaItem>();
    for (const m of [...items, ...added]) if (!map.has(m.playUrl)) map.set(m.playUrl, m);
    return [...map.values()];
  };

  const pick = async (mode: 'dir' | 'file') => {
    if (busy) return;
    setBusy(true);
    try {
      const files = await pickAudioFiles(mode);
      if (files.length === 0) {
        toast.push('未选择音乐文件');
        return;
      }
      const added = toMediaItems(files, items.length);
      persist(merge(added));
      toast.push(`已导入 ${added.length} 首本地音乐`);
    } catch (e: any) {
      // 安卓不支持目录选择器：提示后自动改用「选择文件」
      if (e?.noDirPicker) {
        toast.push('此设备不支持选择文件夹，正在改用「选择文件」…');
        try {
          const files = await pickAudioFiles('file');
          if (files.length === 0) {
            toast.push('未选择音乐文件');
            return;
          }
          const added = toMediaItems(files, items.length);
          persist(merge(added));
          toast.push(`已导入 ${added.length} 首本地音乐`);
        } catch (e2: any) {
          toast.push('导入失败：' + (e2?.message || String(e2)));
        }
      } else {
        toast.push('导入失败：' + (e?.message || String(e)));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="view local-music">
      <div className="lm-top">
        <button className="icon" onClick={onClose} aria-label="返回">
          <Icon name="arrow-left" />
        </button>
        <span className="lm-title">本地音乐</span>
        <span className="lm-spacer" />
      </div>

      <p className="lm-desc muted sm">
        从设备里选择音乐文件。部分安卓机型不支持直接选择文件夹，点「选择文件夹」时会自动切换为「选择文件」。
      </p>

      <div className="lm-acts">
        <button className="lm-btn primary" disabled={busy} onClick={() => pick('dir')}>
          <Icon name="folder" size={18} /> 选择文件夹
        </button>
        <button className="lm-btn" disabled={busy} onClick={() => pick('file')}>
          <Icon name="file" size={18} /> 选择文件
        </button>
      </div>

      {items.length > 0 && (
        <div className="lm-acts2">
          <button className="link" disabled={busy} onClick={() => playback.playList(items)}>
            <Icon name="play" size={14} /> 播放全部（{items.length}）
          </button>
          <button
            className="link danger"
            disabled={busy}
            onClick={() => {
              persist([]);
              toast.push('已清空本地音乐');
            }}
          >
            清空
          </button>
        </div>
      )}

      <div className="lm-list">
        {items.length === 0 ? (
          <div className="muted sm lm-empty">还没有导入本地音乐。点上方「选择文件夹」或「选择文件」开始。</div>
        ) : (
          items.map((it, i) => (
            <div className="lm-item" key={it.id} onClick={() => playback.play(it, items, i)}>
              <span className="lm-cov">
                <Icon name="music" size={16} />
              </span>
              <span className="lm-meta">
                <span className="lm-name">{it.title}</span>
                <span className="lm-sub">{it.artist}</span>
              </span>
              <button
                className="mini"
                title="移除"
                onClick={(e) => {
                  e.stopPropagation();
                  persist(items.filter((_, idx) => idx !== i));
                }}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
