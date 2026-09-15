import { useEffect, useRef, useState } from 'react';
import { pushBackHandler } from '../lib/backStack';

/**
 * v2.4.6 #7：App 内中文输入弹窗，替换全部 `window.prompt`。
 *
 * 为什么要换掉 window.prompt：
 *   1. Android WebView 会调起系统 `JsPromptDialog`，按钮文案（CANCEL / OK）来自
 *      WebView 内置字符串资源，**前端 CSS/JS 完全无法控制** —— 系统是中文也照样出英文；
 *   2. 若宿主未实现 `onJsPrompt`，`window.prompt` 会**直接返回 null**，
 *      表现为「点了创建歌单没反应」；
 *   3. 样式与 App 主题完全脱节（白底紫字直角，跟 --panel 圆角风格不搭）。
 *
   * 两种形态：
   *   - 单行（`multiline=false`）：用于歌单名等短文本，回车即提交；
   *   - 多行（`multiline=true`）：用于粘贴音源 JSON / 分享码，支持换行，
   *     额外给一个「粘贴」按钮（WebView 里长按粘贴有时不灵）。
   *
   * v2.4.6 追加「确认模式」：传了 `message` 就不渲染输入框，只显示一段说明文字，
   * 「确定」直接返回固定标记值 —— 这样 `window.confirm` 也能收进同一个组件，
   * 不必再为确认框单独写一套浮层。
   */

export function PromptDialog({
  open,
  title,
  message,
  placeholder,
  defaultValue = '',
  multiline = false,
  confirmText = '确定',
  cancelText = '取消',
  maxLength,
  hint,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  /** 有值时进入「确认模式」：不显示输入框，仅展示这段说明 */
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  confirmText?: string;
  cancelText?: string;
  maxLength?: number;
  hint?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // 每次打开重置为默认值并聚焦（否则第二次打开会残留上次输入）
  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    if (message) return; // 确认模式没有输入框，不需要聚焦
    const t = window.setTimeout(() => {
      (multiline ? areaRef.current : inputRef.current)?.focus();
    }, 60);
    return () => window.clearTimeout(t);
    // defaultValue 刻意不进依赖：只在 open 翻转时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, multiline, message]);

  // 纳入系统返回栈：返回键先关弹窗，而不是退出 App
  useEffect(() => {
    if (!open) return;
    return pushBackHandler(() => {
      onCancel();
      return true;
    });
  }, [open, onCancel]);

  if (!open) return null;

  const trimmed = value.trim();
  const canSubmit = message ? true : trimmed.length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm(message ? '1' : trimmed);
  };

  return (
    <div className="modal-mask" onClick={onCancel} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal prompt-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>

        {message ? (
          <p className="prompt-message">{message}</p>
        ) : multiline ? (
          <textarea
            ref={areaRef}
            className="text-area prompt-input"
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            rows={7}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : (
          <input
            ref={inputRef}
            className="text-input prompt-input"
            value={value}
            placeholder={placeholder}
            maxLength={maxLength}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
          />
        )}

        {hint && <p className="muted sm prompt-hint">{hint}</p>}

        <div className="modal-actions">
          <button className="ghost" onClick={onCancel}>{cancelText}</button>
          <button className="primary" onClick={submit} disabled={!canSubmit}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
}

/**
 * 命令式封装：用一个 Promise 代替 `window.prompt(...)` 的返回值语义。
 *
 *   const name = await promptText({ title: '歌单名称', placeholder: '给歌单起个名字' });
 *   if (name) library.createPlaylist(name);
 *
 * 返回 `string | null`（null = 用户取消），与 window.prompt 的契约一致，
 * 便于把现有 6 处调用点做最小改写。
 *
 * 实现：单例宿主（PromptHost），任意时刻只允许一个弹窗。
 */
type PromptOptions = {
  title: string;
  /** 有值时进入「确认模式」：不渲染输入框，确定时 resolve 固定值 '1' */
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  confirmText?: string;
  cancelText?: string;
  maxLength?: number;
  hint?: string;
};

let _resolver: ((v: string | null) => void) | null = null;
let _opts: PromptOptions | null = null;
const _subs = new Set<() => void>();

function _notify() {
  for (const cb of Array.from(_subs)) cb();
}

export function promptText(opts: PromptOptions): Promise<string | null> {
  // 若已有未决弹窗，先按取消结束，避免 Promise 悬挂
  if (_resolver) {
    const prev = _resolver;
    _resolver = null;
    prev(null);
  }
  _opts = opts;
  _notify();
  return new Promise<string | null>((resolve) => {
    _resolver = resolve;
  });
}

function _finish(v: string | null) {
  const r = _resolver;
  _resolver = null;
  _opts = null;
  _notify();
  if (r) r(v);
}

/** 挂在 App 根部一次即可。 */
export function PromptHost() {
  const [, force] = useState(0);
  useEffect(() => {
    const cb = () => force((n) => n + 1);
    _subs.add(cb);
    return () => { _subs.delete(cb); };
  }, []);

  if (!_opts) return null;

  return (
    <PromptDialog
      open
      title={_opts.title}
      message={_opts.message}
      placeholder={_opts.placeholder}
      defaultValue={_opts.defaultValue}
      multiline={_opts.multiline}
      confirmText={_opts.confirmText}
      cancelText={_opts.cancelText}
      maxLength={_opts.maxLength}
      hint={_opts.hint}
      onCancel={() => _finish(null)}
      onConfirm={(v) => _finish(v)}
    />
  );
}
