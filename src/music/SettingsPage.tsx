import { useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { useSettings } from '../lib/settings';
import { SubPage } from '../components/SubPage';
import { ImportSourcePage } from '../components/ImportSourcePage';
import { SourceListPage } from '../components/SourceListPage';
import { Icon } from '../components/Icon';
import { checkForUpdate } from '../lib/tauriBridge';

const APP_VERSION = '1.2.1';

function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on} />
  );
}

function NavRow({ icon, label, value, onClick }: { icon: any; label: string; value?: string; onClick: () => void }) {
  return (
    <div className="settings-row tap" onClick={onClick}>
      <span className="ico">
        <Icon name={icon} size={20} />
      </span>
      <span className="label">{label}</span>
      {value && <span className="value">{value}</span>}
      <span className="chevron">
        <Icon name="arrow-right" size={18} />
      </span>
    </div>
  );
}

function ToggleRow({ icon, label, desc, on, onChange }: { icon: any; label: string; desc?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="settings-row">
      <span className="ico">
        <Icon name={icon} size={20} />
      </span>
      <span className="label">
        {label}
        {desc && <small>{desc}</small>}
      </span>
      <Switch on={on} onChange={onChange} />
    </div>
  );
}

const ACCENTS = ['#4f8cff', '#ff5d73', '#23c08b', '#ff9f43', '#a66bff', '#1ec8e8', '#f4b2c0', '#ff6b9d'];

export function SettingsPage({ onOpenMyMusic }: { onOpenMyMusic: (t: 'favorites' | 'playlists') => void }) {
  const store = useSources('music');
  const library = useLibrary('music');
  const { settings, update } = useSettings();
  const [sub, setSub] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState('');
  const [checking, setChecking] = useState(false);

  const applyTheme = (c: string) => {
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--accent2', c);
    update({ themeColor: c });
  };

  return (
    <>
      <div className="settings-scroll">
        {/* 我的音乐 */}
        <div className="settings-group-title">我的音乐</div>
        <div className="settings-card">
          <NavRow icon="heart" label="我的喜欢" value={`${library.lib.favorites.length} 首`} onClick={() => onOpenMyMusic('favorites')} />
          <NavRow icon="list" label="创建的歌单" value={`${library.lib.playlists.length}`} onClick={() => onOpenMyMusic('playlists')} />
        </div>

        {/* 音源 */}
        <div className="settings-group-title">音源</div>
        <div className="settings-card">
          <NavRow icon="download" label="导入 json 音源" value="手动地址 / 扫码" onClick={() => setSub('import')} />
          <NavRow icon="music" label="音源切换" onClick={() => setSub('switch')} />
        </div>

        {/* 下载 */}
        <div className="settings-group-title">下载</div>
        <div className="settings-card">
          <NavRow icon="download" label="离线缓存" value="歌曲 / 音质 / 并发" onClick={() => setSub('downloads')} />
        </div>

        {/* 播放 */}
        <div className="settings-group-title">播放</div>
        <div className="settings-card">
          <div className="settings-row">
            <span className="ico">
              <Icon name="sliders" size={20} />
            </span>
            <span className="label">音质</span>
            <select
              className="value-select"
              value={settings.defaultQuality}
              onChange={(e) => update({ defaultQuality: e.target.value as any })}
            >
              <option value="standard">标准</option>
              <option value="high">高品质</option>
              <option value="lossless">无损</option>
            </select>
          </div>
          <ToggleRow icon="shuffle" label="随机播放" on={settings.shuffle} onChange={(v) => update({ shuffle: v })} />
          <ToggleRow icon="arrow-up" label="上下滑切歌手势" desc="播放页上下滑动切换歌曲" on={settings.swipeGesture} onChange={(v) => update({ swipeGesture: v })} />
          <ToggleRow icon="clock" label="睡眠定时" desc="定时停止播放" on={settings.sleepTimer > 0} onChange={(v) => update({ sleepTimer: v ? 30 : 0 })} />
          <ToggleRow icon="camera" label="封面模糊背景" desc="播放页以封面作模糊背景" on={settings.blurCover} onChange={(v) => update({ blurCover: v })} />
        </div>

        {/* 外观 */}
        <div className="settings-group-title">外观</div>
        <div className="settings-card">
          <NavRow icon="palette" label="主题色" value={settings.themeColor || '蓝'} onClick={() => setSub('theme')} />
          <ToggleRow icon="sliders" label="深色模式" on={settings.darkMode} onChange={(v) => update({ darkMode: v })} />
        </div>

        {/* 通用 */}
        <div className="settings-group-title">通用</div>
        <div className="settings-card">
          <NavRow icon="download" label="检查更新" value={`v${APP_VERSION}`} onClick={() => setSub('update')} />
          <NavRow icon="file-text" label="关于" onClick={() => setSub('about')} />
        </div>
      </div>

      {/* ===== 子页 ===== */}
      {sub === 'import' && <ImportSourcePage mediaType="music" onClose={() => setSub(null)} />}
      {sub === 'switch' && <SourceListPage mediaType="music" title="音源切换" onClose={() => setSub(null)} />}

      {sub === 'downloads' && (
        <SubPage title="离线缓存" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="download" size={20} />
              </span>
              <span className="label">默认音质</span>
              <select className="value-select" value={settings.defaultQuality} onChange={(e) => update({ defaultQuality: e.target.value as any })}>
                <option value="standard">标准</option>
                <option value="high">高品质</option>
                <option value="lossless">无损</option>
              </select>
            </div>
            <div className="settings-row">
              <span className="ico">
                <Icon name="sliders" size={20} />
              </span>
              <span className="label">并发下载数</span>
              <span className="value">3</span>
            </div>
          </div>
        </SubPage>
      )}

      {sub === 'theme' && (
        <SubPage title="主题色" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="palette" size={20} />
              </span>
              <span className="label">选择强调色</span>
            </div>
            <div className="skin-grid">
              {ACCENTS.map((c) => (
                <button key={c} className={`skin-cell ${settings.themeColor === c ? 'active' : ''}`} style={{ background: c }} onClick={() => applyTheme(c)} />
              ))}
            </div>
          </div>
        </SubPage>
      )}

      {sub === 'update' && (
        <SubPage title="检查更新" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="download" size={20} />
              </span>
              <span className="label">当前版本</span>
              <span className="value">v{APP_VERSION}</span>
            </div>
          </div>
          <button
            className="primary block"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              setUpdateState('正在检查…');
              const r = await checkForUpdate();
              setChecking(false);
              if (!r.available) setUpdateState('已是最新版本');
              else if (r.updated) setUpdateState(`已更新至 v${r.version}`);
              else setUpdateState('发现新版本，但当前为侧载包，请手动下载更新。');
            }}
          >
            {checking ? '检查中…' : '检查更新'}
          </button>
          {updateState && <p className="settings-note">{updateState}</p>}
        </SubPage>
      )}

      {sub === 'about' && (
        <SubPage title="关于" onBack={() => setSub(null)}>
          <div className="about-box">
            <h2>音流 MeloFlow</h2>
            <p className="muted">版本 v{APP_VERSION}</p>
            <p className="about-desc">
              一款开源的本地音乐聚合播放工具，内容来自用户自行添加的第三方音源，软件本身不提供任何资源。
            </p>
            <p className="muted sm">使用即代表同意《免责声明》。</p>
          </div>
        </SubPage>
      )}
    </>
  );
}
