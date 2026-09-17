import { useEffect, useState } from 'react';
import { setSplashBars, setWindowBackground, syncNavBarNow, holdNavBarPush } from '../lib/navBar';

type Props = {
  appName: string;
  iconSrc: string;
  gradient: string;
  duration?: number;
  /** v2.5.0 #7：启动页两端色（顶部粉 / 底部深紫），让状态栏与手势栏与渐变同色消失 */
  barColors?: { top: string; bottom: string };
};

export default function SplashScreen({
  appName,
  iconSrc,
  gradient,
  duration = 1600,
  barColors = { top: '#FF7AB6', bottom: '#3A1E5C' },
}: Props) {
  const [closing, setClosing] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    // v2.5.0 #7：启动页要把系统状态栏 / 手势栏染成渐变两端色，避免白块。
    // v2.5.2 #1：先冻结 navBar 的主题色染色（否则 1.2s 后 RETRIES 的 push()
    // 会把刚设好的透明覆盖成 --bg 白色 —— 这正是 v2.5.0/v2.5.1 两版白条的根因）。
    holdNavBarPush(true);
    setSplashBars(barColors.top, barColors.bottom);
    const t = setTimeout(() => setClosing(true), duration);
    return () => {
      clearTimeout(t);
      holdNavBarPush(false); // 组件卸载兜底：一定解除冻结
    };
  }, [duration, barColors.top, barColors.bottom]);

  // v2.5.0 #7：启动页消失后，恢复成应用主题色（navBar.ts 的 MutationObserver 也兜底）。
  useEffect(() => {
    if (gone) {
      // v2.5.5 #1：把窗口背景从启动渐变恢复成应用深底，否则栏位透明会一直
      // 透出粉紫渐变（进入主页/播放页后仍残留渐变底色）。
      setWindowBackground('#0d0f14');
      // v2.5.2 #1：解除冻结（内部会立即补推一次主题色）
      holdNavBarPush(false);
      syncNavBarNow();
    }
  }, [gone]);

  if (gone) return null;

  return (
    <div
      className={`splash${closing ? ' splash--hide' : ''}`}
      style={{ background: gradient }}
      aria-hidden={closing}
      onTransitionEnd={(e) => {
        if (closing && e.propertyName === 'opacity') setGone(true);
      }}
    >
      <div className="splash-logo">
        <img src={iconSrc} alt="" className="splash-icon" />
      </div>
      <div className="splash-name">{appName}</div>
      <div className="splash-bar">
        <span className="splash-bar-fill" style={{ animationDuration: `${duration}ms` }} />
      </div>
      <button className="splash-skip" onClick={() => setClosing(true)}>跳过</button>
    </div>
  );
}
