import { useState } from 'react';
import { useSources } from '../store';
import { SubPage } from './SubPage';
import { AddSourceModal } from './AddSourceModal';
import { Icon } from './Icon';
import { SourceConfig } from '../engine';

// 「仓库管理 / 源列表 / 切换站点」全屏子页：卡片式列表，显示名称 + 截断地址，
// 操作：[上移][下移][删除][调试]，点击卡片切换启用。
export function SourceListPage({
  mediaType,
  onClose,
  title = '仓库管理',
}: {
  mediaType: 'video' | 'music';
  onClose: () => void;
  title?: string;
}) {
  const store = useSources(mediaType);
  const [editTarget, setEditTarget] = useState<SourceConfig | null>(null);
  const [status, setStatus] = useState<Record<string, 'ok' | 'fail' | 'testing'>>({});

  const runTest = async (cfg: SourceConfig) => {
    setStatus((s) => ({ ...s, [cfg.id]: 'testing' }));
    const ok = await store.test(cfg);
    setStatus((s) => ({ ...s, [cfg.id]: ok ? 'ok' : 'fail' }));
  };

  return (
    <SubPage title={title} onBack={onClose}>
      {store.sources.length === 0 ? (
        <div className="empty-hint">
          <Icon name="list" size={40} />
          <p>还没有添加任何仓库</p>
          <span className="muted sm">请在设置中通过「导入源」添加</span>
        </div>
      ) : (
        <div className="source-cards">
          {store.sources.map((s, i) => (
            <div key={s.id} className={`source-card ${s.enabled ? '' : 'off'}`}>
              <div className="sc-main" onClick={() => store.toggle(s.id)}>
                <div className="sc-name">{s.name}</div>
                <div className="sc-url" title={s.baseUrl}>{s.baseUrl}</div>
              </div>
              <span
                className={'switch' + (s.enabled ? ' on' : '')}
                onClick={(e) => { e.stopPropagation(); store.toggle(s.id); }}
                title="启用 / 停用"
              />
              <div className="sc-actions">
                <button className="action-chip" disabled={i === 0} onClick={() => store.move(s.id, -1)}>
                  上移
                </button>
                <button className="action-chip" onClick={() => store.move(s.id, 1)}>
                  下移
                </button>
                <button className="action-chip danger" onClick={() => store.remove(s.id)}>
                  删除
                </button>
                <button className="action-chip" onClick={() => runTest(s)}>
                  {status[s.id] === 'testing' ? '测…' : status[s.id] === 'ok' ? '通' : status[s.id] === 'fail' ? '不通' : '调试'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editTarget && (
        <AddSourceModal
          initial={{
            name: editTarget.name,
            type: editTarget.type,
            baseUrl: editTarget.baseUrl,
            token: editTarget.token,
            mountPath: editTarget.extra?.mountPath,
          }}
          onClose={() => setEditTarget(null)}
          onSubmit={(form) => {
            store.update(editTarget.id, {
              name: form.name,
              type: form.type,
              baseUrl: form.baseUrl,
              token: form.token,
              extra: form.mountPath ? { mountPath: form.mountPath } : editTarget.extra,
            });
            setEditTarget(null);
          }}
        />
      )}
    </SubPage>
  );
}
