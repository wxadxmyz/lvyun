// v2.3.0 统一 JS 沙箱引擎（幕海/律云共用）
//
// 在 Rust 侧嵌入 QuickJS（rquickjs），执行用户源提供的 spider 脚本，
// 让 App 像影视仓/洛雪那样靠"脚本"驱动任意源（蜘蛛源/加密源/网上各种源）。
//
// 关键约束：脚本内的网络请求一律通过 `fetch` 桥接回 Rust 代理
// （reqwest::blocking），彻底绕开 WebView 的 CORS 与 Android 明文 HTTP 限制。
// 解密原语 base64/md5 由 Rust 注入；AES/RC4 等由加载器在脚本前拼接纯 JS 实现。
//
// v2.3.11 两处重要修复（对齐慕海 v2.5.x / v3.x）：
//   #5 `typeof "search"` 恒 false —— 分发表用了带引号的字符串字面量做 typeof，
//      导致「全局函数形态」的源永远无法进分支。改为 `typeof __global["search"]`。
//   #5 ext 改为 Option<serde_json::Value>，兼容对象型 ext（如 {"class":"电影"}），
//      此前 Option<String> 遇对象会整体反序列化失败，依赖 ext 的站点全部返回空。
//   #5 补齐沙箱缺失的全局 API（globalThis / console / setTimeout / atob / btoa）与
//      drpy2 的 `var rule = {...}` 形态适配。
//   #2 通过 tauri AppHandle emit "debug://spider" 事件，把脚本内的每一次网络请求与
//      每一处报错推给 App 内调试面板，不必再连 ADB 抓 logcat。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use md5::{Digest, Md5};
use rquickjs::{Context, Function, Object, Runtime};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

#[derive(Deserialize)]
pub struct SpiderCall {
    /// spider 脚本全文（定义 home/search/detail/play 等函数，或定义 `spider` 类）
    pub code: String,
    /// 要调用的函数名，如 "search" / "home" / "detail" / "play"
    pub func: String,
    /// 函数参数（字符串数组，引擎内部 JSON.parse 后展开传入）
    pub args: Vec<String>,
    /// TVBox csp 模型：站点代号（如 "csp_DoubanGuard"），传给 spider 构造器选路
    #[serde(default)]
    pub api: Option<String>,
    /// TVBox csp 模型：站点 ext 配置（字符串或对象皆可），传给 spider 构造器。
    /// v2.3.11 #5：改为 serde_json::Value，兼容对象型 ext（如 {"class":"电影"}）；
    /// 此前 Option<String> 遇对象时整个 run_spider 反序列化失败，
    /// 导致依赖 ext 的 drpy2/csp 站点全部返回空。
    #[serde(default)]
    pub ext: Option<serde_json::Value>,
    /// v2.3.11 #2：源名称，仅用于调试面板标注日志归属，不参与脚本执行
    #[serde(default)]
    pub name: Option<String>,
}

/// v2.3.11 #2：推给前端调试面板的事件负载。
/// 除通用 message 外的字段均为可选：网络请求类日志会带上结构化明细，
/// 便于调试面板直接分列展示，无需在前端反解字符串。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpiderLog {
    pub ts: i64,
    pub level: String, // info | warn | error
    pub source: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 把日志同时打到 logcat 和 App 调试面板，避免手机上无法连 ADB 时排不了障
#[derive(Clone)]
struct LogSink {
    app: tauri::AppHandle,
    source: String,
}

impl LogSink {
    fn emit(&self, level: &str, message: String) {
        let line = format!("[{}][{}] {}", level, self.source, message);
        match level {
            "error" => eprintln!("[spider] {}", line),
            "warn" => eprintln!("[spider] {}", line),
            _ => println!("[spider] {}", line),
        }
        let payload = SpiderLog {
            ts: now_ms(),
            level: level.to_string(),
            source: self.source.clone(),
            message,
            url: None,
            method: None,
            status: None,
            duration_ms: None,
            size: None,
            preview: None,
        };
        let _ = self.app.emit("debug://spider", payload);
    }
    fn info(&self, m: String) {
        self.emit("info", m);
    }
    fn error(&self, m: String) {
        self.emit("error", m);
    }
    /// 网络请求明细：单独 push 一条带结构化字段的日志
    fn request(
        &self,
        url: String,
        method: String,
        status: u16,
        duration_ms: u64,
        size: usize,
        preview: String,
    ) {
        let ok = status < 400;
        let message = format!(
            "{method} {url} → HTTP {status} · {duration_ms}ms · {size} 字节"
        );
        println!("[spider][info][{}] {}", self.source, message);
        let _ = self.app.emit(
            "debug://spider",
            SpiderLog {
                ts: now_ms(),
                level: if ok { "info" } else { "error" }.to_string(),
                source: self.source.clone(),
                message,
                url: Some(url),
                method: Some(method),
                status: Some(status),
                duration_ms: Some(duration_ms),
                size: Some(size),
                preview: Some(preview),
            },
        );
    }
}

/// 截断字符串，避免把整份 HTML/JSON 塞进调试面板
fn clip(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().take(max).collect();
    let out: String = chars.into_iter().collect();
    if s.chars().count() > max {
        format!("{}…(+{} 字符)", out, s.chars().count() - max)
    } else {
        out
    }
}

/// 执行一段 spider 脚本并调用指定函数，返回 JSON 字符串。
#[tauri::command]
pub fn run_spider(app: tauri::AppHandle, payload: SpiderCall) -> Result<String, String> {
    let sink = LogSink {
        app,
        source: payload
            .name
            .clone()
            .or_else(|| payload.api.clone())
            .unwrap_or_else(|| "js".to_string()),
    };

    sink.info(format!(
        "调用 {} · code_len={} args={:?}",
        payload.func,
        payload.code.len(),
        payload.args
    ));

    let rt = Runtime::new().map_err(|e| format!("引擎初始化失败: {e}"))?;
    let ctx = Context::full(&rt).map_err(|e| format!("上下文创建失败: {e}"))?;

    let out = ctx.with(|ctx| -> Result<String, String> {
        let globals = ctx.globals();

        // fetch 桥接：同步 HTTP，返回响应体字符串。
        // 兼容 TVBox spider 习惯：fetch(url, headers_json?, data?)
        let sink_fetch = sink.clone();
        let fetch_fn = Function::new(ctx.clone(), move |url: String, hd: Option<String>, data: Option<String>| -> Result<String, rquickjs::Error> {
            let t0 = std::time::Instant::now();
            let client = reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .build()
                .map_err(|e| {
                    sink_fetch.error(format!("建立 HTTP 客户端失败: {e}"));
                    rquickjs::Error::new_into_js_message("fetch", "response", e.to_string())
                })?;
            let mut req = if let Some(d) = &data {
                client.post(&url).body(d.clone())
            } else {
                client.get(&url)
            };
            let method = if data.is_some() { "POST" } else { "GET" };
            // TVBox 生态普遍只对 okhttp UA 返回正常内容；若调用方通过 headers
            // 显式指定了 UA，则尊重之，否则默认 okhttp。
            let mut ua = "okhttp/4.10.0".to_string();
            if let Some(h) = &hd {
                if let Ok(map) = serde_json::from_str::<serde_json::Value>(h) {
                    if let Some(obj) = map.as_object() {
                        for (k, v) in obj {
                            if let Some(s) = v.as_str() {
                                if k.eq_ignore_ascii_case("user-agent") {
                                    ua = s.to_string();
                                } else {
                                    req = req.header(k, s);
                                }
                            }
                        }
                    }
                }
            }
            req = req.header("User-Agent", ua);
            let resp = req.send().map_err(|e| {
                let m = format!("请求失败 {method} {url} — {e}");
                sink_fetch.error(m);
                rquickjs::Error::new_into_js_message("fetch", "response", e.to_string())
            })?;
            let status = resp.status().as_u16();
            let body = resp.text().map_err(|e| {
                let m = format!("读取响应失败 {method} {url} — {e}");
                sink_fetch.error(m);
                rquickjs::Error::new_into_js_message("fetch", "response", e.to_string())
            })?;
            let ms = t0.elapsed().as_millis() as u64;
            // v2.3.11 #2：每条请求都结构化推给调试面板（URL / 状态 / 耗时 / 体积 / 响应预览），
            // 让「源跑通了但返回空」这类问题在 App 内即可定位，不必连 ADB。
            sink_fetch.request(
                url.clone(),
                method.to_string(),
                status,
                ms,
                body.len(),
                clip(&body, 300),
            );
            Ok(body)
        })
        .map_err(|e| e.to_string())?;
        globals.set("fetch", fetch_fn).map_err(|e| e.to_string())?;

        // v2.3.11 #5：rquickjs 0.6 在部分目标（尤其 Android）上默认未把全局对象暴露为
        // `globalThis`，而包装代码依赖它调用全局函数型蜘蛛。显式注入避免
        // "ReferenceError: globalThis is not defined" → QuickJS Exception。
        globals
            .set("globalThis", globals.clone())
            .map_err(|e| e.to_string())?;

        // base64 编码
        let b64enc = Function::new(ctx.clone(), |s: String| -> String { B64.encode(s.as_bytes()) })
            .map_err(|e| e.to_string())?;
        globals.set("base64Encode", b64enc).map_err(|e| e.to_string())?;

        // base64 解码
        let b64dec =
            Function::new(ctx.clone(), |s: String| -> Result<String, rquickjs::Error> {
                let bytes = B64.decode(s.trim()).map_err(|e| rquickjs::Error::new_into_js_message("base64Decode", "string", e.to_string()))?;
                String::from_utf8(bytes).map_err(|e| rquickjs::Error::new_into_js_message("base64Decode", "string", e.to_string()))
            })
            .map_err(|e| e.to_string())?;
        globals.set("base64Decode", b64dec).map_err(|e| e.to_string())?;

        // md5
        let md5_fn = Function::new(ctx.clone(), |s: String| -> String {
            let digest = Md5::digest(s.as_bytes());
            digest.iter().map(|b| format!("{:02x}", b)).collect()
        })
        .map_err(|e| e.to_string())?;
        globals.set("md5", md5_fn).map_err(|e| e.to_string())?;

        // 调试输出
        let sink_print = sink.clone();
        let print_fn = Function::new(ctx.clone(), move |s: String| {
            sink_print.info(s);
        })
        .map_err(|e| e.to_string())?;
        globals.set("print", print_fn).map_err(|e| e.to_string())?;

        // v2.3.11 #5：注入 console 对象（log/info/warn/error/debug）。
        // 大量 drpy/CatVod 脚本使用 console.log，缺失会 ReferenceError。
        // 注意：这里必须先把 Ctx 复制一份再 move 进闭包。若直接捕获外层的 ctx，
        // move 闭包会把它夺走，后面的 Object::new(ctx.clone()) 就会报 use of moved value。
        let mk_log = {
            let sink = sink.clone();
            let ctx2 = ctx.clone();
            move |tag: &'static str| {
                let s = sink.clone();
                Function::new(ctx2.clone(), move |msg: String| {
                    let level = match tag {
                        "error" => "error",
                        "warn" => "warn",
                        _ => "info",
                    };
                    s.emit(level, format!("console.{tag}: {}", msg));
                })
            }
        };
        let console_obj = Object::new(ctx.clone()).map_err(|e| e.to_string())?;
        for (k, tag) in [
            ("log", "log"),
            ("info", "info"),
            ("warn", "warn"),
            ("error", "error"),
            ("debug", "debug"),
        ] {
            let f = mk_log(tag).map_err(|e| e.to_string())?;
            console_obj.set(k, f).map_err(|e| e.to_string())?;
        }
        globals.set("console", console_obj).map_err(|e| e.to_string())?;

        // v2.3.11 #5：其它常被脚本引用的全局 API（缺失即 ReferenceError）
        let timeout_fn = Function::new(ctx.clone(), |_cb: rquickjs::Function, _ms: i32| -> i32 { 0 })
            .map_err(|e| e.to_string())?;
        globals.set("setTimeout", timeout_fn).map_err(|e| e.to_string())?;
        let clear_fn = Function::new(ctx.clone(), |_id: i32| {}).map_err(|e| e.to_string())?;
        globals.set("clearTimeout", clear_fn).map_err(|e| e.to_string())?;
        // atob/btoa（base64 互转，部分 drpy 用作别名）
        let atob_fn = Function::new(ctx.clone(), |s: String| -> String { B64.encode(s.as_bytes()) })
            .map_err(|e| e.to_string())?;
        globals.set("atob", atob_fn).map_err(|e| e.to_string())?;
        let btoa_fn =
            Function::new(ctx.clone(), |s: String| -> Result<String, rquickjs::Error> {
                let bytes = B64.decode(s.trim()).map_err(|e| rquickjs::Error::new_into_js_message("btoa", "string", e.to_string()))?;
                String::from_utf8(bytes).map_err(|e| rquickjs::Error::new_into_js_message("btoa", "string", e.to_string()))
            })
            .map_err(|e| e.to_string())?;
        globals.set("btoa", btoa_fn).map_err(|e| e.to_string())?;

        // 执行 spider 代码（定义各函数，或定义 `spider` 类/对象）
        ctx.eval::<(), _>(payload.code.as_str()).map_err(|e| {
            let mut msg = format!("脚本执行失败: {e}");
            // v2.3.11 #5：eval 失败时把脚本前 12 行一并报出，便于定位出错行
            let mut head = String::from("\n  —— 脚本前 12 行 ——");
            for (i, line) in payload.code.lines().take(12).enumerate() {
                head.push_str(&format!("\n  L{}: {}", i + 1, clip(line, 160)));
            }
            msg.push_str(&head);
            sink.error(msg.clone());
            msg
        })?;

        sink.info("脚本 eval 成功，准备调用函数".to_string());

        // 调用目标函数并 JSON 序列化结果。
        // 兼容三种 spider 形态：
        //  1) `spider` 类/对象（TVBox csp 模型）：new spider(api, ext) 后用实例方法选路
        //  2) `rule` 对象（drpy2 标准源）：包一层适配为 spider 形态
        //  3) 全局函数 home/search/detail/play（drpy 风格单文件脚本）
        let func_lit = serde_json::to_string(&payload.func).unwrap_or_else(|_| "\"\"".to_string());
        let args_lit = serde_json::to_string(&payload.args).unwrap_or_else(|_| "[]".to_string());
        let api_lit = payload
            .api
            .as_ref()
            .map(|s| serde_json::to_string(s).unwrap())
            .unwrap_or_else(|| "null".to_string());
        // ext 已是经 serde_json 序列化的合法 JSON 字面量（字符串或对象），无需再 JSON.parse。
        // 此前 double escape 导致注入的是双重转义字符串字面量，JSON.parse 抛错使依赖
        // ext 的站点初始化失败。
        let ext_lit = payload
            .ext
            .as_ref()
            .map(|s| serde_json::to_string(s).unwrap())
            .unwrap_or_else(|| "null".to_string());

        let expr = format!(
            r#"
const __api = {api};
const __ext = {ext};
const __global = (typeof globalThis !== 'undefined' && globalThis !== null) ? globalThis : this;

// v2.3.11 #5：drpy2 标准源适配 —— 社区 drpy2 规则以 `var rule = {{...}}` 形态提供，其
//   home/search/detail/play 与我们的 spider 接口同名，返回 AppleCMS 风格 Vod。
//   这里统一包装为 spider 形态（search/detail 返回 list、play 返回 url/{{url,header}}）。
function __drpyWrap(rule, api, ext) {{
  // 合并 rule.headers 到全局 fetch（drpy2 常用 headers 携带 UA/Referer/签名）
  try {{
    if (rule && rule.headers) {{
      var __rh = (typeof rule.headers === 'function') ? rule.headers() : rule.headers;
      if (__rh && typeof __rh === 'object') {{
        var __of = (typeof fetch === 'function') ? fetch : null;
        if (__of) {{
          globalThis.fetch = function(u, hd, data) {{
            var m = {{}};
            for (var k in __rh) m[k] = __rh[k];
            if (hd) {{ try {{ var j = JSON.parse(hd); if (j && typeof j === 'object') {{ for (var k2 in j) m[k2] = j[k2]; }} }} catch(e) {{}} }}
            return __of(u, JSON.stringify(m), data);
          }};
        }}
      }}
    }}
  }} catch(e) {{}}
  function __normVods(r) {{
    if (!r) return [];
    if (Array.isArray(r)) return r;
    if (Array.isArray(r.list)) return r.list;
    if (Array.isArray(r.data)) return r.data;
    return [];
  }}
  return {{
    home: function() {{ var h = (typeof rule.home === 'function') ? rule.home() : null; return __normVods(h); }},
    search: function(key) {{ var s = (typeof rule.search === 'function') ? rule.search(key) : []; return __normVods(s); }},
    detail: function(id) {{ var d = (typeof rule.detail === 'function') ? rule.detail(id) : {{list:[]}}; return {{ list: __normVods(d) }}; }},
    play: function(input) {{ var p = (typeof rule.play === 'function') ? rule.play(input, '', '') : ''; return p; }},
  }};
}}

let __t;
if (typeof spider !== 'undefined' && spider !== null) {{
  __t = (typeof spider === 'function') ? new spider(__api, __ext) : spider;
}} else if (typeof rule !== 'undefined' && rule !== null) {{
  __t = __drpyWrap(rule, __api, __ext);
// v2.3.11 #5 关键修复：此前写成 `typeof {{func}} === 'function'`，展开后是
// `typeof "search" === 'function'` —— typeof 一个字符串字面量恒为 "string"，
// 该分支永远进不去，导致全局函数形态的源一律抛「spider 未定义且全局无函数」。
// 改为按名字取下全局对象上的成员再 typeof，参数用 globals 后的字符串索引。
}} else if (typeof __global[{func}] === 'function') {{
  __t = __global;
}} else {{
  throw new Error('spider/rule 未定义且全局无函数 ' + {func});
}}
const __args = {args};
const __r = (__t === __global) ? __global[{func}](...__args) : __t[{func}](...__args);
JSON.stringify(__r === undefined ? null : __r);
"#,
            api = api_lit,
            ext = ext_lit,
            func = func_lit,
            args = args_lit,
        );
        let out: String = ctx.eval(expr.as_str()).map_err(|e| {
            let msg = format!("调用 {} 失败: {e}", payload.func);
            sink.error(msg.clone());
            msg
        })?;
        sink.info(format!("调用 {} 返回 {} 字节", payload.func, out.len()));
        Ok(out)
    })?;

    Ok(out)
}
