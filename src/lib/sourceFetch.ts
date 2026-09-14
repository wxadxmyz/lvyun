// 源配置地址自动抓取与解析：支持 JSON 直链，也支持 HTML 订阅页里的链接提取。
// 用于「导入 json 源 / 导入 json 音源」子页面的「配置地址」自动抓取。
//
// 方案C：抓取由 Rust 后端命令 fetchsource 代理完成，彻底绕开 WebView 前端
// 的 CORS 与 Android 明文 HTTP 限制（可导入 http://饭太硬.cc/tv 这类地址）。
// 若不在 Tauri 环境（本地 web 调试）则回退到前端 fetch。

import { invoke } from '@tauri-apps/api/core';

export type FetchResult =
  | { kind: 'sources'; sources: any[] }
  | { kind: 'links'; links: string[] }
  | { kind: 'error'; message: string };

function toAbsolute(href: string, base: string): string {
  try {
    return new URL(href, base).href;
  } catch {
    return href;
  }
}

function looksLikeSourceLink(href: string): boolean {
  const h = href.toLowerCase();
  if (h.startsWith('javascript:') || h.startsWith('#') || h.startsWith('mailto:')) return false;
  return /\.json($|\?)/.test(h) || /(json|config|drpy|tvbox|cat|api|txt|m3u|web|share|resource)/.test(h);
}

function normalize(arr: any[]): any[] {
  return arr
    .filter((r) => r && typeof r === 'object')
    .map((r) => {
      const o = { ...r };
      // 部分订阅源用 api 字段代替 baseUrl
      if (!o.baseUrl && o.api) o.baseUrl = o.api;
      return o;
    })
    .filter((r) => r.type && r.baseUrl);
}

// 优先走 Rust 后端代理抓取；不在 Tauri 环境时回退前端 fetch。
async function fetchText(url: string): Promise<string> {
  try {
    return await invoke<string>('fetchsource', { url });
  } catch {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
}

// 影视仓 / TVBox 接口常为 base64 密文，尝试解码（仅当整段像 base64 时）
function b64DecodeSafe(t: string): string | null {
  const s = t.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/=_\-]{24,}$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/[-_]/g, (c) => (c === '-' ? '+' : '/')));
    if (bin.startsWith('{') || bin.startsWith('[')) return bin;
  } catch {
    /* ignore */
  }
  return null;
}

// v2.4.0 A2：容忍 JSON 里的 //、/* */ 注释与尾随逗号（TVBox/影视仓配置常见）。
// 逐字符扫描，字符串内的 // 与逗号不误伤；最后去掉 } / ] 前的尾随逗号。
function stripJsonComments(t: string): string {
  let out = '';
  let inStr: string | null = null;
  let i = 0;
  while (i < t.length) {
    const c = t[i];
    const n = t[i + 1];
    if (inStr) {
      if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
      if (c === inStr) { out += c; inStr = null; i++; continue; }
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < t.length && t[i] !== '\n') i++; continue; }
    if (c === '/' && n === '/*') { i += 2; while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// v2.4.0 A2：把各种包装结构摊平成「源对象数组」。
// 兼容顶层数组、{sources:[...]}、{list:[...]}、{urls:[...]}、{sites:[...]}、单个对象。
// 注意：{urls:[]}/{sites:[]} 若为影视仓聚合（isTvboxConfig 命中）仍按单个 tvbox 源处理，此处不摊。
function toSourceList(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.sources)) return data.sources;
  if (data && Array.isArray(data.list)) return data.list;
  if (data && Array.isArray(data.urls)) return data.urls;
  if (data && Array.isArray(data.sites)) return data.sites;
  return [data];
}

// TVBox / 影视仓：顶层 { sites:[...] } 或 { urls:[...] }。
// 关键：不摊平成多个子源，而是整体作为一个 tvbox 源存储原始地址，搜索/播放时再解析。
function isTvboxConfig(data: any): boolean {
  return !!(data && (Array.isArray(data.sites) || Array.isArray(data.urls)));
}

// v2.4.0 A2：从 URL 推断订阅名。GitHub / jsDelivr raw 等用路径末段（去扩展名）做名字，
// 避免显示裸域名；其余回退到 hostname。
function nameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, '');
    if (/githubusercontent\.com|jsdelivr\.net|raw\.github|githack\.com|github\.com/.test(h)) {
      const seg = u.pathname.split('/').filter(Boolean).pop() || '';
      const name = seg.replace(/\.[^.]+$/, '');
      if (name) return decodeURIComponent(name);
    }
    if (h) return h;
  } catch {
    /* ignore */
  }
  return '影视仓聚合';
}

// 落雪式 .js 音源：去掉 ESM 语法后用沙箱求值，尝试拿到导出的 source 对象
function extractJsSource(code: string): any | null {
  const src = code
    .replace(/^\s*import[^\n;]*;?\s*$/gm, '')
    .replace(/export\s+default\s+/g, 'var __exp = ')
    .replace(/export\s+/g, '');
  try {
    const cap: any = {};
    const fn = new Function(
      'module', 'exports', 'window', 'document', 'localStorage', 'navigator', '__cap',
      src +
        '\n;try{__cap.v=(typeof __exp!=="undefined")?__exp:(typeof rule!=="undefined")?rule:(typeof source!=="undefined")?source:(typeof bookSource!=="undefined")?bookSource:(typeof cfg!=="undefined")?cfg:null;}catch(e){}'
    );
    fn(undefined, undefined, {}, { document: {} }, {}, {}, {}, cap);
    return cap.v || null;
  } catch {
    return null;
  }
}

function parseFetched(text: string, url: string): FetchResult {
  let trimmed = text.trim();

  // 加密接口常为 base64 密文，先尝试解码再解析
  const decoded = b64DecodeSafe(trimmed);
  if (decoded) {
    const r = parseFetched(decoded, url);
    if (r.kind !== 'error') return r;
    trimmed = decoded; // 解码后当作明文继续
  }

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      // v2.4.0 A2：先去注释/尾随逗号再解析（TVBox 配置常带 // 与逗号，裸 JSON.parse 会抛异常被静默吞掉）
      const data = JSON.parse(stripJsonComments(trimmed));
      // 影视仓 / TVBox 聚合配置：整体作为「一个」tvbox 源，仓库里只显示你粘贴的这个地址
      if (isTvboxConfig(data)) {
        return {
          kind: 'sources',
          sources: [{ name: nameFromUrl(url), type: 'tvbox', baseUrl: url }],
        };
      }
      const valid = normalize(toSourceList(data));
      if (valid.length) return { kind: 'sources', sources: valid };
    } catch {
      /* 不是 JSON，往下走 HTML / JS 分支 */
    }
  }

  // HTML：提取页面里的订阅/配置链接
  const links: string[] = [];
  const re = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const href = m[1];
    if (looksLikeSourceLink(href)) links.push(toAbsolute(href, url));
  }
  const uniq = [...new Set(links)];
  if (uniq.length) return { kind: 'links', links: uniq };

  // 落雪式 .js 音源：尝试提取导出的 source 对象
  if (/\.js(\?|$)/i.test(url) || /export\s+default|module\.exports|var\s+rule|const\s+rule|bookSource/.test(text)) {
    const cfg = extractJsSource(text);
    if (cfg && (cfg.baseUrl || cfg.api || cfg.search)) {
      return {
        kind: 'sources',
        sources: normalize([{ ...cfg, name: cfg.name || '导入音源', type: cfg.type || 'music-json' }]),
      };
    }
  }

  return { kind: 'error', message: '未在该地址识别到可用的源配置，请改用「本地文件」或手动粘贴。' };
}

export async function fetchFromUrl(input: string): Promise<FetchResult> {
  let url = input.trim();
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  try {
    const text = await fetchText(url);
    return parseFetched(text, url);
  } catch (e: any) {
    return {
      kind: 'error',
      message: `抓取失败：${e?.message || e}`,
    };
  }
}

export function parsePasted(text: string): { sources: any[]; error?: string } {
  const t = text.trim();
  if (!t) return { sources: [], error: '内容为空' };
  try {
    // v2.4.0 A2：容忍注释与尾随逗号
    const data = JSON.parse(stripJsonComments(t));
    const valid = normalize(toSourceList(data));
    if (valid.length) return { sources: valid };
    return { sources: [], error: '未找到有效源（需包含 type 与 baseUrl）' };
  } catch (e: any) {
    return { sources: [], error: 'JSON 解析失败：' + (e?.message || e) };
  }
}
