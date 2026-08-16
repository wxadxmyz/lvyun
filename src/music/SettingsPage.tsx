import { useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { useSettings } from '../lib/settings';
import { SubPage } from '../components/SubPage';
import { ImportSourcePage } from '../components/ImportSourcePage';
import { SourceListPage } from '../components/SourceListPage';
import { Icon } from '../components/Icon';
import { checkForUpdate } from '../lib/tauriBridge';

const APP_VERSION = '2.1.0';

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

const ACCENTS = ['#ff5c8a', '#4f8cff', '#ff5d73', '#23c08b', '#ff9f43', '#a66bff', '#1ec8e8', '#f4b2c0', '#ff6b9d'];

// 主题色 → 中文名（设置页展示用，对齐 UI 设计稿的“粉/蓝/…”）
const ACCENT_NAMES: Record<string, string> = {
  '#ff5c8a': '粉',
  '#4f8cff': '蓝',
  '#ff5d73': '红',
  '#23c08b': '绿',
  '#ff9f43': '橙',
  '#a66bff': '紫',
  '#1ec8e8': '青',
  '#f4b2c0': '浅粉',
  '#ff6b9d': '玫红',
};

export function SettingsPage({
  onOpenMyMusic,
  sub,
  setSub,
}: {
  onOpenMyMusic: (t: 'favorites' | 'playlists') => void;
  sub: string | null;
  setSub: (v: string | null) => void;
}) {
  const store = useSources('music');
  const library = useLibrary('music');
  const { settings, update } = useSettings();
  const [updateState, setUpdateState] = useState('');
  const [checking, setChecking] = useState(false);

  const applyTheme = (c: string) => {
    document.documentElement.style.setProperty('--accent', c);
    document.documentElement.style.setProperty('--accent2', c);
    update({ themeColor: c });
  };

  // 睡眠定时：把 settings.sleepTimer/sleepEnd 翻译成展示文案
  const sleepLabel = (): string => {
    if (settings.sleepEnd) return '播完本曲';
    if (settings.sleepTimer > 0) return `${settings.sleepTimer} 分钟`;
    return '关';
  };
  const setSleep = (mode: 'off' | '15' | '30' | '60' | 'end') => {
    if (mode === 'off') update({ sleepTimer: 0, sleepEnd: false });
    else if (mode === 'end') update({ sleepTimer: 0, sleepEnd: true });
    else update({ sleepTimer: Number(mode), sleepEnd: false });
    setSub(null);
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
          <NavRow icon="clock" label="睡眠定时" value={sleepLabel()} onClick={() => setSub('sleep')} />
        </div>

        {/* 外观 */}
        <div className="settings-group-title">外观</div>
        <div className="settings-card">
          <NavRow icon="palette" label="主题色" value={settings.themeColor ? (ACCENT_NAMES[settings.themeColor] ?? '自定义') : '粉'} onClick={() => setSub('theme')} />
          <ToggleRow icon="sliders" label="深色模式" on={settings.darkMode} onChange={(v) => update({ darkMode: v })} />
          <ToggleRow icon="camera" label="封面模糊背景" desc="播放页以封面作模糊背景" on={settings.blurCover} onChange={(v) => update({ blurCover: v })} />
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
      {sub === 'switch' && <SourceListPage mediaType="music" title="仓库管理" onClose={() => setSub(null)} />}

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

      {sub === 'sleep' && (
        <SubPage title="睡眠定时" onBack={() => setSub(null)}>
          <div className="settings-card">
            {([
              ['off', '关闭'],
              ['15', '15 分钟'],
              ['30', '30 分钟'],
              ['60', '60 分钟'],
              ['end', '播完本曲'],
            ] as ['off' | '15' | '30' | '60' | 'end', string][]).map(([mode, label]) => {
              const active =
                (mode === 'off' && !settings.sleepEnd && settings.sleepTimer === 0) ||
                (mode === 'end' && settings.sleepEnd) ||
                (mode !== 'off' && mode !== 'end' && settings.sleepTimer === Number(mode));
              return (
                <div key={mode} className={`settings-row tap${active ? ' active' : ''}`} onClick={() => setSleep(mode)}>
                  <span className="ico">
                    <Icon name="clock" size={20} />
                  </span>
                  <span className="label">{label}</span>
                  {active && <span className="value"><Icon name="check" size={18} /></span>}
                </div>
              );
            })}
          </div>
          <p className="settings-note">到点后将淡出并暂停播放。</p>
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
