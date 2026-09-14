import React from 'react';
import ReactDOM from 'react-dom/client';
import MusicApp from './MusicApp';
import { ThemeProvider } from '../lib/theme';
import { ToastProvider } from '../lib/toast';
import { installSafeAreaFallback } from '../lib/safeArea';
import { installNavBarSync } from '../lib/navBar';
import { initSpiderDebug } from '../lib/debug';
import '../styles.css';

// #8：沉浸式下部分 WebView 的 env(safe-area-inset-top) 返回 0，
// 导致播放器顶部贴到通知栏热区、上滑误触系统通知栏。这里补一层兜底。
installSafeAreaFallback();
// v2.3.10：把 --bg 同步给 Android 系统导航栏，消除底部手势条的灰色罩层。
installNavBarSync();
// v2.3.11 #2：订阅 Rust 沙箱推来的 spider 日志，让调试面板也能看到 JS 源的请求。
void initSpiderDebug();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <ToastProvider>
        <MusicApp />
      </ToastProvider>
    </ThemeProvider>
  </React.StrictMode>
);
