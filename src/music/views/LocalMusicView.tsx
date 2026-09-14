import { useEffect, useMemo, useState } from 'react';
import { usePlayback } from '../../lib/playback';
import { useToast } from '../../lib/toast';
import { Icon } from '../../components/Icon';
import { gradientFor, initial } from '../../lib/cover';
import { pickAudioFiles, scanPublicDirs, toMediaItemsWithTags } from '../../lib/localMusic';
import { pushBackHandler } from '../../lib/backStack';
import type { useLibrary } from '../../lib/library';
import { ScanResultView, type ScanOutcome } from './ScanResultView';

// 扫描本地文件 → 独立界面。
//
// v2.3.11 三项改动：
//   #3 主按钮由「雷达」换成 A 方案「波环扩散」：132px 渐变实心圆 + 放大镜 + 三层延迟波纹。
//      刻意不画同心圆 + 扇形扫描 + 目标点那一套 —— 那是军事/工具隐喻，与音乐 App 气质冲突。
//   #6 数据源由自己的 localStorage 键改为 library.lib.localMusic，
//      与「我的音乐 → 本地音乐」打通；扫描完先进结果确认页，不再一句 Toast 直接灌进列表。
//   #6b 入库前解析 ID3 标签，歌名/歌手/专辑不再靠文件名硬凑。

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
  library,
  onClose,
}: {
  playback: ReturnType<typeof usePlayback>;
  library: ReturnType<typeof useLibrary>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'scan' | 'tag'>('scan');
  const [found, setFound] = useState(0);
  const [tagDone, setTagDone] = useState(0);
  const [tagTotal, setTagTotal] = useState(0);
  const [curDir, setCurDir] = useState('');
  const [stat, setStat] = useState<ScanStat | null>(null);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);
  const toast = useToast();

  const items = library.lib.localMusic;

  // 返回键：先退出结果页 → 再退出本地音乐页（扫描途中先提示，避免把正在跑的扫描吞掉）
  useEffect(
    () =>
      pushBackHandler(() => {
        if (outcome) {
          setOutcome(null);
          return true;
        }
        if (busy) {
          toast.push('正在扫描，请稍候…');
          return true;
        }
        onClose();
        return true;
      }),
    [outcome, busy, onClose, toast],
  );

  // 存储失败（多因本地音乐过多超出配额）必须让用户知道，
  // 否则只会看到列表莫名其妙少内容，完全不知道为什么。
  useEffect(() => {
    if (library.storageError) toast.push(library.storageError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.storageError]);

  useEffect(() => {
    try {
      const s = localStorage.getItem(STAT_KEY);
      if (s) setStat(JSON.parse(s));
    } catch {
      /* ignore */
    }
  }, []);

  const saveStat = (count: number) => {
    const s: ScanStat = { count, ts: Date.now() };
    setStat(s);
    try {
      localStorage.setItem(STAT_KEY, JSON.stringify(s));
    } catch {
      /* ignore */
    }
  };

  /** 把一批文件转成带标签的 MediaItem，并算出「重复 / 新增」——进结果页前完成 */
  const buildOutcome = async (
    files: { path: string; name: string }[],
    extra: { unsupported: number; truncated: boolean },
  ) => {
    setPhase('tag');
    setTagTotal(files.length);
    setTagDone(0);
    const { items: all, tagged } = await toMediaItemsWithTags(files, 0, (d) => setTagDone(d));

    // 与已有曲库比对，提前算出去重数字，让用户看到的是「真实会新增多少」
    const existing = new Set(items.map((m) => m.playUrl || m.id));
    const fresh = all.filter((m) => !existing.has(m.playUrl || m.id));
    setOutcome({
      items: fresh,
      duplicates: all.length - fresh.length,
      unsupported: extra.unsupported,
      tagged,
      truncated: extra.truncated,
    });
    saveStat(fresh.length);
    setPhase('scan');
  };

  /** 全盘搜索：递归扫描常见音乐目录（不申请「所有文件访问权」，用公共媒体目录覆盖） */
  const runFullScan = async () => {
    if (busy) return;
    setBusy(true);
    setFound(0);
    setPhase('scan');
    setCurDir('正在定位存储目录…');
    try {
      const res = await scanPublicDirs((p) => {
        setFound(p.found);
        if (!p.done && p.dir) setCurDir(p.dir);
      });
      setCurDir('');
      if (res.files.length === 0) {
        toast.push('没有扫描到音乐文件，可试试下方「按文件夹」');
        return;
      }
      await buildOutcome(res.files, { unsupported: res.unsupported, truncated: res.truncated });
    } catch (e: any) {
      setCurDir('');
      toast.push('扫描失败：' + (e?.message || String(e)));
    } finally {
      setBusy(false);
    }
  };

  /** 手动指定位置（安卓不支持目录选择器时自动降级为选文件） */
  const pick = async (mode: 'dir' | 'file') => {
    if (busy) return;
    setBusy(true);
    const handle = async (m: 'dir' | 'file') => {
      const files = await pickAudioFiles(m);
      if (files.length === 0) {
        toast.push('未选择音乐文件');
        return;
      }
      await buildOutcome(files, { unsupported: 0, truncated: false });
    };
    try {
      await handle(mode);
    } catch (e: any) {
      if (e?.noDirPicker) {
        toast.push('此设备不支持选择文件夹，正在改用「选择文件」…');
        try {
          await handle('file');
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

  const subText = useMemo(() => {
    if (busy && phase === 'tag') return `正在读取标签 ${tagDone}/${tagTotal}`;
    if (busy) return curDir || '扫描中…';
    if (stat) return `上次新增 ${stat.count} 首 · ${fmtWhen(stat.ts)}`;
    return '扫描设备上的 Music / Download 等常见目录';
  }, [busy, phase, tagDone, tagTotal, curDir, stat]);

  // 结果确认页独立成屏（它是「扫描 → 入库」之间缺失的那一步）
  if (outcome) {
    return <ScanResultView outcome={outcome} library={library} onClose={() => setOutcome(null)} />;
  }

  return (
    <div className="view local-music">
      <div className="lm-top">
        <button className="icon" onClick={onClose} aria-label="返回">
          <Icon name="arrow-left" />
        </button>
        <span className="lm-title">本地音乐</span>
        <span className="lm-spacer" />
      </div>

      {/* 中央主按钮：A 方案 · 波环扩散（纯图形，按钮上无文字） */}
      <div className="lm-scan">
        <div className={'lm-pulse' + (busy ? ' busy' : '')}>
          <span className="lm-wave w3" />
          <span className="lm-wave w2" />
          <span className="lm-wave w1" />
          <button className="lm-pulse-core" onClick={runFullScan} disabled={busy} aria-label="全盘搜索">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="7" />
              <path d="M16 16l5 5" />
            </svg>
            {/* 扫描中隐去放大镜，改显示已找到的数量 —— 数字是有效信息，不是装饰 */}
            {busy && <span className="lm-count">{phase === 'tag' ? tagDone : found}</span>}
          </button>
        </div>

        <div className="lm-scan-sub">
          <span>{subText}</span>
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
          <button
            className="lm-minor-btn danger"
            disabled={busy}
            onClick={() => {
              library.clearLocalMusic();
              toast.push('已清空本地音乐');
            }}
          >
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
          <div className="muted sm lm-empty">还没有本地音乐。点上方按钮开始全盘搜索。</div>
        ) : (
          items.map((it, i) => (
            <div className="lm-item" key={it.playUrl || it.id} onClick={() => playback.play(it, items, i)}>
              <span className="lm-cov" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
                {it.cover ? <img src={it.cover} alt="" /> : initial(it.title)}
              </span>
              <span className="lm-meta">
                <span className="lm-name">{it.title}</span>
                <span className="lm-sub">
                  {it.artist}
                  {it.album ? ` · ${it.album}` : ''}
                </span>
              </span>
              <button
                className="mini"
                title="移除"
                onClick={(e) => {
                  e.stopPropagation();
                  library.removeLocalMusic(it);
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
