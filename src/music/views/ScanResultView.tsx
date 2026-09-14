import { useEffect, useMemo, useRef, useState } from 'react';
import { MediaItem } from '../../engine/types';
import { Icon } from '../../components/Icon';
import { pushBackHandler } from '../../lib/backStack';
import { useToast } from '../../lib/toast';
import { gradientFor, initial } from '../../lib/cover';
import type { useLibrary } from '../../lib/library';

/**
 * v2.3.11 #6：扫描结果确认页。
 *
 * 之前全盘搜索扫完只是一句 Toast，然后直接替换列表 —— 用户不知道扫到了什么、
 * 哪些是新的、哪些被当重复滤掉了，也没机会说「这几首我不要」。
 * 这个页面把「扫描 → 确认 → 入库」补上，三个数字先讲清楚发生了什么，
 * 再让用户勾选后一次性加入曲库。
 */

export interface ScanOutcome {
  /** 已按文件名/标签转好的条目（尚未入库） */
  items: MediaItem[];
  /** 本次去重滤掉的条数 */
  duplicates: number;
  /** 扩展名不在支持列表、被跳过的文件数（按目录遍历统计，仅作提示） */
  unsupported: number;
  /** 成功解析出 ID3 标签的条数 */
  tagged: number;
  /** 扫描是否因达到上限而提前收尾 */
  truncated: boolean;
}

export function ScanResultView({
  outcome,
  library,
  onClose,
}: {
  outcome: ScanOutcome;
  library: ReturnType<typeof useLibrary>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [picked, setPicked] = useState<Set<number>>(() => new Set(outcome.items.map((_, i) => i)));
  const listRef = useRef<HTMLDivElement>(null);

  // 返回键：先进结果页，再退出到本地音乐页
  useEffect(
    () => pushBackHandler(() => { onClose(); return true; }),
    [onClose],
  );

  const allOn = picked.size === outcome.items.length && outcome.items.length > 0;
  const toggleAll = () => {
    setPicked(allOn ? new Set() : new Set(outcome.items.map((_, i) => i)));
  };

  const chosen = useMemo(() => outcome.items.filter((_, i) => picked.has(i)), [outcome.items, picked]);

  const commit = () => {
    if (chosen.length === 0) {
      toast.push('请先勾选要加入的歌曲');
      return;
    }
    const added = library.addLocalMusic(chosen);
    if (added === 0) {
      toast.push('这些歌都已经在曲库里了');
    } else if (added < chosen.length) {
      toast.push(`加入 ${added} 首（${chosen.length - added} 首已在曲库中）`);
    } else {
      toast.push(`已加入 ${added} 首到本地音乐`);
    }
    onClose();
  };

  return (
    <div className="view scan-result">
      <div className="sr-top">
        <button className="icon" onClick={onClose} aria-label="返回">
          <Icon name="arrow-left" />
        </button>
        <span className="sr-title">扫描结果</span>
        <button className="sr-all" onClick={toggleAll}>
          {allOn ? '全不选' : '全选'}
        </button>
      </div>

      {/* 三个数字先讲清楚发生了什么 */}
      <div className="sr-stats">
        <div className="sr-stat c1">
          <b>{outcome.items.length}</b>
          <small>新发现</small>
        </div>
        <div className="sr-stat c2">
          <b>{outcome.duplicates}</b>
          <small>重复已滤除</small>
        </div>
        <div className="sr-stat c3">
          <b>{outcome.unsupported}</b>
          <small>不支持的格式</small>
        </div>
      </div>

      {outcome.items.length > 0 && (
        <div className="sr-hint">
          已读取标签信息：<b>{outcome.tagged} 首</b>识别出歌手 / 专辑，
          {outcome.items.length - outcome.tagged} 首沿用文件名
        </div>
      )}

      {outcome.truncated && (
        <div className="sr-hint warn">
          文件数量已达上限，本次只纳入了部分目录。可再次扫描，或在下方用「按文件夹」补充。
        </div>
      )}

      <div className="sr-list" ref={listRef}>
        {outcome.items.length === 0 ? (
          <div className="muted sm sr-empty">
            这次没有扫到新的音乐文件。
            <br />
            可试试下方「按文件夹 / 按文件」手动指定位置。
          </div>
        ) : (
          outcome.items.map((it, i) => {
            const on = picked.has(i);
            return (
              <div
                className={'sr-row' + (on ? ' on' : '')}
                key={it.id}
                onClick={() => {
                  setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  });
                }}
              >
                <span className={'sr-tick' + (on ? ' on' : '')} aria-hidden="true" />
                <span className="sr-cov" style={{ background: it.cover ? undefined : gradientFor(it.title) }}>
                  {it.cover ? <img src={it.cover} alt="" /> : initial(it.title)}
                </span>
                <span className="sr-meta">
                  <span className="sr-name">{it.title}</span>
                  <span className="sr-sub">
                    {it.artist}
                    {it.album ? ` · ${it.album}` : ''}
                  </span>
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="sr-actions">
        <button className="sr-ghost" onClick={() => setPicked(new Set())} disabled={picked.size === 0}>
          清空选择
        </button>
        <button className="sr-cta" onClick={commit} disabled={chosen.length === 0}>
          加入曲库（{chosen.length}）
        </button>
      </div>
    </div>
  );
}
