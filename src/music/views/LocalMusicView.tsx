import { useEffect, useState } from 'react';
import { MediaItem } from '../../engine/types';
import { usePlayback } from '../../lib/playback';
import { useToast } from '../../lib/toast';
import { Icon } from '../../components/Icon';
import { pickAudioFiles, scanPublicDirs, toMediaItems } from '../../lib/localMusic';

// 扫描本地文件 → 独立界面。
// v2.3.10：主操作改为「全盘搜索」——居中一枚雷达波纹按钮，扫设备上的常见音乐目录。
// 造型为律云自绘（同心圆 + 扫描扇形 + 中心音符），配色沿用 #ff5c8a 霓虹渐变，
// 不参照任何第三方音乐产品的界面设计，规避版权风险。
const STORE_KEY = 'lvyun.localMusic.v1';
const STAT_KEY = 'lvyun.localMusic.stat.v1';

interface ScanStat {
  count: number;
  ts: number;
}

function fmtWhen(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function LocalMusicView({
  playback,
  onClose,
}: {
  playback: ReturnType<typeof usePlayback>;
  onClose: () => void;
}) {
  const [items, setItems] = useState<MediaItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(0);
  const [curDir, setCurDir] = useState('');
  const [stat, setStat] = useState<ScanStat | null>(null);
  const toast = useToast();

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) setItems(JSON.parse(raw));
    } catch {
      /* 忽略损坏的本地数据 */
    }
    try {
      const s = localStorage.getItem(STAT_KEY);
      if (s) setStat(JSON.parse(s));
    } catch {
      /* ignore */
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

  const saveStat = (count: number) => {
    const s: ScanStat = { count, ts: Date.now() };
    setStat(s);
    try {
      localStorage.setItem(STAT_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };

  const merge = (added: MediaItem[]) => {
    const map = new Map<string, MediaItem>();
    // playUrl 在 MediaItem 上是可选字段，缺时用 id 兜底，避免 Map 键为 undefined
    for (const m of [...items, ...added]) {
      const key = m.playUrl || m.id;
      if (key && !map.has(key)) map.set(key, m);
    }
    return [...map.values()];
  };

  /** 全盘搜索：递归扫描常见音乐目录（不申请「所有文件访问权」，用公共媒体目录覆盖） */
  const runFullScan = async () => {
    if (busy) return;
    setBusy(true);
    setFound(0);
    setCurDir('正在定位存储目录…');
    try {
      const files = await scanPublicDirs((p) => {
        setFound(p.found);
        if (!p.done && p.dir) setCurDir(p.dir);
      });
      if (files.length === 0) {
        setCurDir('');
        toast.push('没有扫描到音乐文件，可试试下方「选择文件夹」');
        return;
      }
      const added = toMediaItems(files, items.length);
      persist(merge(added));
      saveStat(added.length);
      setCurDir('');
      toast.push(`全盘搜索完成，导入 ${added.length} 首`);
    } catch (e: any) {
      setCurDir('');
      toast.push('扫描失败：' + (e?.message || String(e)));
    } finally {
      setBusy(false);
    }
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
      saveStat(added.length);
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
          saveStat(added.length);
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

      {/* 中央：全盘搜索主按钮（自绘雷达波纹） */}
      <div className="lm-scan">
        <button className={'lm-scan-btn' + (busy ? ' busy' : '')} onClick={runFullScan} disabled={busy} aria-label="全盘搜索">
          <svg className="lm-radar" viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <linearGradient id="lmRadar" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ff5c8a" />
                <stop offset="100%" stopColor="#7b5cff" />
              </linearGradient>
            </defs>
            {/* 三层同心圆波纹 */}
            <circle className="ring r3" cx="60" cy="60" r="52" />
            <circle className="ring r2" cx="60" cy="60" r="38" />
            <circle className="ring r1" cx="60" cy="60" r="24" />
            {/* 扫描扇形 */}
            <g className="sweep">
              <path d="M60 60 L60 8 A52 52 0 0 1 104 34 Z" fill="url(#lmRadar)" />
            </g>
            {/* 中心音符 */}
            <g className="note">
              <path d="M52 68V51l17-3.2V64" />
              <circle cx="46.5" cy="68" r="4.4" />
              <circle cx="64.5" cy="64" r="4.4" />
            </g>
          </svg>
          {busy ? (
            <span className="lm-scan-num">{found}</span>
          ) : (
            <span className="lm-scan-txt">全盘搜索</span>
          )}
        </button>

        <div className="lm-scan-sub">
          {busy ? (
            <span className="lm-scan-dir">{curDir || '扫描中…'}</span>
          ) : stat ? (
            <span>上次扫描 {stat.count} 首 · {fmtWhen(stat.ts)}</span>
          ) : (
            <span>扫描设备上的 Music / Download 等常见目录</span>
          )}
        </div>
      </div>

      {/* 次要入口：兜底与清理 */}
      <div className="lm-minor">
        <button className="lm-minor-btn" disabled={busy} onClick={() => pick('dir')}>
          <Icon name="folder" size={16} /> 按文件夹
        </button>
        <button className="lm-minor-btn" disabled={busy} onClick={() => pick('file')}>
          <Icon name="file" size={16} /> 按文件
        </button>
        {items.length > 0 && (
          <button className="lm-minor-btn danger" disabled={busy} onClick={() => { persist([]); toast.push('已清空本地音乐'); }}>
            <Icon name="trash" size={16} /> 清空
          </button>
        )}
      </div>

      {items.length > 0 && (
        <div className="lm-acts2">
          <button className="link" disabled={busy} onClick={() => playback.playList(items)}>
            <Icon name="play" size={14} /> 播放全部（{items.length}）
          </button>
        </div>
      )}

      <div className="lm-list">
        {items.length === 0 ? (
          <div className="muted sm lm-empty">还没有本地音乐。点上方雷达按钮开始全盘搜索。</div>
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
