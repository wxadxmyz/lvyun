import { useEffect, useRef, useState } from 'react';
import { useSources } from '../store';
import { useLibrary } from '../lib/library';
import { useSettings } from '../lib/settings';
import { SubPage } from '../components/SubPage';
import { ImportSourcePage } from '../components/ImportSourcePage';
import { SourceListPage } from '../components/SourceListPage';
import { Icon } from '../components/Icon';
import { checkForUpdate } from '../lib/tauriBridge';
import { useSkin, SKINS } from '../lib/theme';
// v2.4.6 #7：window.confirm / alert 一律换成 App 内中文弹层 + toast
// （原生弹窗在 Android WebView 里按钮文案是英文 CANCEL/OK，且宿主未实现
//   onJsConfirm 时会直接返回 false —— 确认框点了没反应）
import { promptText } from '../components/PromptDialog';
import { useToast } from '../lib/toast';
import { getVersion } from '@tauri-apps/api/app';
// v2.4.5 #7：下载任务此前只存在内存里，设置页「离线缓存」又只放了音质/并发两个选项，
// 于是用户点了下载之后完全看不到进度和结果（「下载的歌曲在哪里？」）。
import { useDownloads, downloadStore } from '../lib/downloads';
// v2.3.11 #4：返回键栈式调度
import { pushBackHandler } from '../lib/backStack';

// 回退版本：仅在取不到 Tauri 打包版本时使用（例如在浏览器里直接调试）。
// ⚠️ 每次发版都要同步这里：之前写死 '2.3.6'，结果 APK 已是新版本、
//    设置页一直显示旧号；这次升到 2.4.6 时又忘了同步，浏览器调试下显示成 2.3.11。
const FALLBACK_VERSION = '2.4.8';

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

// 主题色 hex → 中文名映射，设置页展示中文而非原始色值
const ACCENT_NAMES: Record<string, string> = {
  '#4f8cff': '蓝',
  '#ff5c8a': '粉',
  '#ff5d73': '粉红',
  '#23c08b': '翠绿',
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
  onOpenDebug,
}: {
  onOpenMyMusic: (t: 'favorites' | 'playlists') => void;
  sub: string | null;
  setSub: (v: string | null) => void;
  onOpenDebug?: () => void;
}) {
  const store = useSources('music');
  const library = useLibrary('music');
  const toast = useToast();
  const { settings, update } = useSettings();
  const [updateState, setUpdateState] = useState('');
  const [checking, setChecking] = useState(false);
  const [appVersion, setAppVersion] = useState(FALLBACK_VERSION);
  const [cacheMsg, setCacheMsg] = useState('');
  const [cacheSize, setCacheSize] = useState(0);
  // v2.4.6 #12（方案 A）：调试入口隐藏化。
  // 原来的「主页顶栏 虫图标」和「主页工具栏 虫图标」都被删掉了 ——
  // 普通用户看到会困惑，而开发者自己每次多点两下并不亏。
  // 新入口：设置 → 关于 → 连点版本号 7 次（Android 惯例的「开发者模式」手势）。
  const [tapCount, setTapCount] = useState(0);
  const tapTimer = useRef<number | undefined>(undefined);

  const onVersionTap = () => {
    if (!onOpenDebug) return;
    // 3 秒内没有继续点击就重新计数，避免误触累积
    if (tapTimer.current) window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => setTapCount(0), 3000);

    const next = tapCount + 1;
    setTapCount(next);
    if (next >= 7) {
      setTapCount(0);
      if (tapTimer.current) window.clearTimeout(tapTimer.current);
      toast.push('已解锁开发者调试面板', 'ok');
      onOpenDebug();
      return;
    }
    // 点到第 4 次开始给提示，让"还差几下"可见（否则用户不知道在数什么）
    if (next >= 4) toast.push(`再点 ${7 - next} 次进入开发者模式`);
  };
  const dls = useDownloads();
  // 显示 Tauri 打包时的真实版本（tauri.conf.json 的 version），不再写死
  useEffect(() => {
    getVersion()
      .then((v) => { if (v) setAppVersion(v); })
      .catch(() => { /* 非 Tauri 环境（浏览器调试）保留回退值 */ });
  }, []);

  // v2.4.5 #14（原 v2.5.0 #6）：清除缓存 —— 对齐幕海，但**必须保留音源**。
  // KEEP 清单：mps_sources_*（音源，用户明确要求保留）、mps_settings（设置）、
  // mps_skin*（皮肤选择）。这些是「数据 / 配置」，不是缓存。
  const KEEP = /^(mps_sources_|mps_settings$|mps_skin)/;
  const calcSize = () => {
    let n = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && !KEEP.test(k)) n += (localStorage.getItem(k)?.length ?? 0) + k.length;
      }
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k) n += (sessionStorage.getItem(k)?.length ?? 0) + k.length;
      }
    } catch { /* ignore */ }
    return n * 2; // localStorage 以 UTF-16 计，粗略折算字节
  };
  const fmtSize = (b: number) =>
    b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';

  useEffect(() => { setCacheSize(calcSize()); }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps

  const clearCache = async () => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && !KEEP.test(k)) keys.push(k);
      }
      const size = calcSize();
      if (!keys.length && size === 0) { setCacheMsg('无缓存'); return; }
      // v2.4.6 #7：原生 confirm → 应用内中文确认弹窗。
      // 复用 promptText 的空输入语义：值为 '1' 表示"确认"，null 表示"取消"。
      const ok = await promptText({
        title: '清除缓存',
        message: `将清除约 ${fmtSize(size)} 缓存（音源、设置与皮肤会保留），确定继续吗？`,
        confirmText: '清除',
        cancelText: '取消',
        defaultValue: '1',
      });
      if (!ok) return;
      keys.forEach((k) => localStorage.removeItem(k));
      try {
        sessionStorage.clear();
        // 律云目前未用 IndexedDB，保留调用作防御（与幕海一致）
        (indexedDB as any).databases?.().then((dbs: any[]) => dbs.forEach((d: any) => d.name && indexedDB.deleteDatabase(d.name)));
      } catch { /* ignore */ }
      setCacheSize(calcSize());
      setCacheMsg('已清除');
      toast.push(`已清除 ${keys.length} 项缓存，音源与设置均已保留。`, 'ok');
    } catch (e) {
      toast.push('清除失败：' + String(e), 'err');
    }
  };

  const { skin, selectedId, setSkinId } = useSkin();

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

  // v2.3.11 #4：设置子页注册到返回栈。
  // 旧实现里 settingsSub 是单个 string|null，没有任何层级信息 —— 子页内部再深一层的状态
  // （如导入源页里的扫码面板）父容器看不见，返回只能一步 setSub(null) 跳回一级。
  // 现在由本组件负责「子页 → 一级」，子页内部若还有浮层则由它自己再压一条，
  // 栈从顶往下问，自然形成逐级返回。
  useEffect(() => {
    if (!sub) return;
    return pushBackHandler(() => {
      setSub(null);
      return true;
    });
  }, [sub, setSub]);

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
          <NavRow icon="sliders" label="皮肤" value={skin.name} onClick={() => setSub('skin')} />
        </div>

        {/* 通用 */}
        <div className="settings-group-title">通用</div>
        <div className="settings-card">
          <NavRow icon="download" label="检查更新" value={`v${appVersion}`} onClick={() => setSub('update')} />
          <NavRow icon="file-text" label="关于" onClick={() => setSub('about')} />
          {/* v2.4.5 #8：清除缓存。注意必须保留 mps_sources_* —— 那是用户自己添加的音源，
              一并清掉等于把音源全删了（用户明确要求保留）。 */}
          <NavRow icon="trash" label="清除缓存" value={cacheMsg || fmtSize(cacheSize)} onClick={clearCache} />
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

          {/* v2.4.5 #7：下载任务清单（进度 / 完成 / 失败原因） */}
          <div className="settings-group-title">下载任务</div>
          <div className="settings-card">
            {dls.length === 0 && (
              <div className="muted sm" style={{ padding: 10 }}>
                还没有下载任务。在搜索结果点 ⬇ 即可下载；桌面端会弹系统保存对话框，安卓端存到系统「下载」目录。
              </div>
            )}
            {dls.length > 0 && (
              <div className="settings-row">
                <span className="label">共 {dls.length} 个任务</span>
                <button className="link" onClick={() => downloadStore.clearDone()}>清除已完成</button>
              </div>
            )}
            {dls.map((t) => (
              <div key={t.id} className="dl-row">
                <span className="dl-name">{t.item.title}</span>
                <span className={'dl-st ' + t.status}>
                  {t.status === 'done' ? '已完成' : t.status === 'error' ? (t.error || '失败') : `${t.progress}%`}
                </span>
              </div>
            ))}
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

      {sub === 'skin' && (
        <SubPage title="皮肤" onBack={() => setSub(null)}>
          <div className="settings-card">
            <div className="settings-row">
              <span className="ico">
                <Icon name="sliders" size={20} />
              </span>
              <span className="label">选择皮肤（深色 / 浅色）</span>
            </div>
            <div className="skin-grid">
              <button key="auto" className={`skin-cell ${selectedId === 'auto' ? 'active' : ''}`} onClick={() => setSkinId('auto')}>
                <span className="skin-swatch" style={{ background: 'linear-gradient(135deg,#1e2230 50%,#f4f5f9 50%)' }} />
                <span className="skin-name">自动</span>
              </button>
              {SKINS.map((s) => (
                <button key={s.id} className={`skin-cell ${selectedId === s.id ? 'active' : ''}`} onClick={() => setSkinId(s.id)}>
                  <span className="skin-swatch" style={{ background: s.swatch }} />
                  <span className="skin-name">{s.name}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="settings-note">浅色皮肤：樱花粉 / 薄荷绿 / 落日橙 等；深色皮肤：暗夜黑 / 极光蓝 / 葡萄紫 / 火山红。「自动」跟随系统明暗。</p>
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
              <span className="value">v{appVersion}</span>
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
            <h2>律云 LvYun</h2>
            {/* v2.4.6 #12：连点 7 次进开发者模式（隐藏入口，见 onVersionTap） */}
            <p className="muted" onClick={onVersionTap} style={{ cursor: 'default' }}>版本 v{appVersion}</p>
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
