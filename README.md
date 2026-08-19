# 律云 LvYun

> 支持 **自定义 API 音源** 的音乐播放器，基于 Tauri 2 的桌面客户端。跨源搜索、歌单/收藏/历史、全屏播放器、桌面歌词、频谱可视化、可拖拽播放队列，数据全部本地存储。

> ⚠️ **本仓库只含「框架」，不含任何内置音源。** 所有音源由用户自行在「源管理」中添加（音乐 JSON API 适配器）。请仅添加你拥有合法使用权的音源。

---

## 功能

- 🔌 **可插拔音源引擎**：内置 music-json 适配器，支持用户自定义添加/测试/排序/导入导出音源（分享码）。
- 🔍 跨源聚合搜索，结果去重合并。
- 📚 本地「收藏 / 歌单 / 历史 / 本地下载」管理。
- 🎵 独立**全屏播放页**：黑胶旋转、时间轴歌词、Web Audio 频谱、可拖拽播放队列。
- 🎨 7 套可切换主题（暗夜黑 / 樱花粉 / 极光蓝 / 薄荷绿 / 葡萄紫 / 落日橙 / 火山红），设置持久化。
- ⌨️ 全局快捷键（空格播放/暂停、←→ 快退快进、↑↓ 音量、M 静音、N 下一首、P 播放页）。
- 🖥️ 桌面歌词（应用内悬浮层）。
- 🐛 调试面板：查看源请求/响应，便于排查自定义源。

## 技术栈

- 前端：Vite + React + TypeScript
- 桌面端：Tauri 2（Rust）
- 状态/持久化：localStorage；媒体源以适配器模式接入

## 开发

```bash
pnpm install
pnpm dev          # 浏览器中开发，默认 http://localhost:5173/music.html
```

## 构建桌面安装包（本机）

需要先安装 [Rust](https://rustup.rs/) 与系统 WebView 依赖（Linux 需 `libwebkit2gtk-4.1-dev` 等）：

```bash
pnpm tauri dev          # 以桌面窗口运行（开发）
pnpm tauri build        # 产出对应平台的安装包（Windows .msi/.exe、macOS .dmg、Linux .deb/.AppImage）
```

## 自动化构建（GitHub Actions）

推送带 `v` 前缀的 tag（如 `v0.1.0`）即触发 CI，自动为 **Windows / macOS / Linux** 构建并发布到 GitHub Release。无需本机交叉编译。

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Android / iOS（移动端）

仓库已通过 `tauri icon` 生成 Android / iOS 图标资源。完整移动端构建需在本机执行：

```bash
pnpm tauri android init && pnpm tauri android build   # Android
pnpm tauri ios init     && pnpm tauri ios build       # iOS（需 macOS）
```

Android 签名请在 CI 或本机配置 keystore 后打包。

## 许可证

[MIT](./LICENSE)
