#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v2.4.5：把 Android 原生桥注入 src-tauri/gen/android/**/MainActivity.kt

历史上这段逻辑写在 .github/workflows/android.yml 的 heredoc 里，导致：
  1) YAML 里嵌 Python 三引号字符串，缩进一改就 ScannerError；
  2) 幂等判断写成 `if "LvYunAndroid" in src: skip` —— 只要仓库里提交过
     旧版桥（或旧版 back 桥），新增方法永远注入不进去（v2.4.5 #12 状态栏
     同色就是这样静默丢失的）。

改为独立脚本后：
  - 按「能力」而非「字符串存在」判断是否幂等：back 桥 / LvYunAndroid 桥 /
    setStatusBarColor / setBarsColor / _lvHealStart 逐项检查、逐项补；
  - 可重复执行，任一环境（干净模板、半旧桥、全旧桥）都能收敛到完整版。
"""

import io
import re
import sys

DEFAULT = "src-tauri/gen/android/app/src/main/java/com/lvyun/app/MainActivity.kt"

# ---------------------------------------------------------------- back 桥 ----
BACK_BLOCK = '''
    private var _backWebView: android.webkit.WebView? = null

    override fun onBackPressed() {
        val wv = _backWebView ?: findBackWebView(window?.decorView as? android.view.ViewGroup)
        _backWebView = wv
        if (wv == null) {
            super.onBackPressed()
            return
        }
        wv.evaluateJavascript(
            "(function(){ try { return window.__onAndroidBack ? !!window.__onAndroidBack() : true; } catch(e) { return true; } })()"
        ) { result ->
            if (result != "true") { super.onBackPressed() }
        }
    }

    private fun findBackWebView(group: android.view.ViewGroup?): android.webkit.WebView? {
        if (group == null) return null
        for (i in 0 until group.childCount) {
            val child = group.getChildAt(i)
            if (child is android.webkit.WebView) return child
            if (child is android.view.ViewGroup) {
                val found = findBackWebView(child)
                if (found != null) return found
            }
        }
        return null
    }
'''

# ---------------------------------------------------- 状态栏（类成员方法）----
# v2.4.5 #12：播放页「通知栏 -> 手势栏」一色
STATUS_BLOCK = '''
    // ===== v2.4.5 #12：状态栏同色 =====
    var _lvStatusColor: Int? = null
    var _lvStatusLight: Boolean = false
    fun _lvApplyStatusBar() {
        val c = _lvStatusColor ?: return
        try {
            // enableEdgeToEdge() 默认让系统栏透明；不清掉 TRANSLUCENT / 不声明
            // DRAWS_SYSTEM_BAR_BACKGROUNDS，statusBarColor 会被系统忽略。
            window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS)
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            window.statusBarColor = c
            if (android.os.Build.VERSION.SDK_INT >= 23) {
                val decor = window.decorView
                val flag = android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR
                decor.systemUiVisibility =
                    if (_lvStatusLight) decor.systemUiVisibility or flag
                    else decor.systemUiVisibility and flag.inv()
            }
        } catch (e: Exception) { /* ignore */ }
        _lvApplyAppearance()
    }
'''

# ------------------------------------------------- 桥对象新增的两个 JS 方法 ----
BARS_METHODS = '''
                    @android.webkit.JavascriptInterface
                    fun setStatusBarColor(color: String, lightIcons: Boolean) {
                        runOnUiThread {
                            try {
                                _lvStatusColor = android.graphics.Color.parseColor(color)
                                _lvStatusLight = lightIcons
                                _lvApplyStatusBar()
                            } catch (e: Exception) { /* ignore */ }
                        }
                    }
                    @android.webkit.JavascriptInterface
                    fun setBarsColor(color: String, lightIcons: Boolean) {
                        runOnUiThread {
                            try {
                                val c = android.graphics.Color.parseColor(color)
                                _lvNavColor = c; _lvNavLight = lightIcons; _lvApplyNavBar()
                                _lvStatusColor = c; _lvStatusLight = lightIcons; _lvApplyStatusBar()
                            } catch (e: Exception) { /* ignore */ }
                        }
                    }
'''

# ------------------------------------------------------------ 完整桥（全新）----
FULL_BLOCK = '''
    // ===== 播放器原生桥（横屏 / 导航栏 / 状态栏）=====
    private var _lvBound = false
    private var _lvBoundView: java.lang.ref.WeakReference<android.webkit.WebView>? = null
    private val _lvHealHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private fun _lvBindTo(wv: android.webkit.WebView?) {
        try {
            if (wv == null) return
            val prev = _lvBoundView?.get()
            if (!_lvBound || prev !== wv) {
                wv.addJavascriptInterface(LvYunAndroid, "LvYunAndroid")
                _lvBoundView = java.lang.ref.WeakReference(wv)
                _lvBound = true
            }
        } catch (e: Exception) { /* ignore */ }
    }
    private fun _lvBind() {
        _lvBindTo(findBackWebView(window?.decorView as? android.view.ViewGroup))
    }
    override fun onWebViewCreate(webView: android.webkit.WebView) {
        super.onWebViewCreate(webView)
        _lvBindTo(webView)
        _lvHealHandler.postDelayed({ _lvBind() }, 800)
    }
    private var _lvHealRunning = false
    private val _lvHeal = object : Runnable {
        override fun run() {
            var keep = true
            try {
                val wv = findBackWebView(window?.decorView as? android.view.ViewGroup)
                val prev = _lvBoundView?.get()
                if (wv == null) {
                    keep = true
                } else if (prev == null || prev !== wv || !_lvBound) {
                    _lvBind()
                    keep = true
                } else {
                    keep = false
                }
            } catch (e: Exception) {
                keep = true
            }
            if (keep) {
                _lvHealHandler.postDelayed(this, 1000)
            } else {
                _lvHealRunning = false
            }
        }
    }
    private fun _lvHealStart() {
        if (_lvHealRunning) return
        _lvHealRunning = true
        _lvHealHandler.postDelayed(_lvHeal, 0)
    }
    var _lvNavColor: Int? = null
    var _lvNavLight: Boolean = false
    fun _lvApplyNavBar() {
        val c = _lvNavColor ?: return
        try {
            window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION)
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            window.navigationBarColor = c
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                val decor = window.decorView
                val flag = android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
                decor.systemUiVisibility =
                    if (_lvNavLight) decor.systemUiVisibility or flag
                    else decor.systemUiVisibility and flag.inv()
            }
        } catch (e: Exception) { /* ignore */ }
        _lvApplyAppearance()
    }
    // v2.5.0 #5：API30+ 用 WindowInsetsController.setSystemBarsAppearance 控制
    // 状态栏 / 导航栏图标的明暗。navigationBarColor 与 SYSTEM_UI_FLAG_LIGHT_*
    // 在 API35+ 已废弃，旧写法在新系统上失效，图标会看不清。
    fun _lvApplyAppearance() {
        if (android.os.Build.VERSION.SDK_INT < 30) return
        try {
            val insets = window?.insetsController ?: return
            val lightStatus = if (_lvStatusLight) android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS else 0
            val lightNav = if (_lvNavLight) android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS else 0
            val mask = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or
                android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            insets.setSystemBarsAppearance(lightStatus or lightNav, mask)
        } catch (e: Exception) { /* ignore */ }
    }
    val LvYunAndroid = object {
        @android.webkit.JavascriptInterface
        fun isBound(): Boolean = _lvBound && _lvBoundView?.get() != null
        @android.webkit.JavascriptInterface
        fun setOrientation(orientation: String) {
            runOnUiThread {
                _lvBind()
                try {
                    when (orientation) {
                        "landscape" -> requestedOrientation =
                            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                        "sensor" -> requestedOrientation =
                            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
                        else -> requestedOrientation =
                            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                    }
                } catch (e: Exception) { /* ignore */ }
            }
        }
        @android.webkit.JavascriptInterface
        fun setNavBarColor(color: String, lightBars: Boolean) {
            runOnUiThread {
                try {
                    _lvNavColor = android.graphics.Color.parseColor(color)
                    _lvNavLight = lightBars
                    _lvApplyNavBar()
                } catch (e: Exception) { /* ignore */ }
            }
        }
        @android.webkit.JavascriptInterface
        fun setStatusBarColor(color: String, lightIcons: Boolean) {
            runOnUiThread {
                try {
                    _lvStatusColor = android.graphics.Color.parseColor(color)
                    _lvStatusLight = lightIcons
                    _lvApplyStatusBar()
                } catch (e: Exception) { /* ignore */ }
            }
        }
        @android.webkit.JavascriptInterface
        fun setBarsColor(color: String, lightIcons: Boolean) {
            runOnUiThread {
                try {
                    val c = android.graphics.Color.parseColor(color)
                    _lvNavColor = c; _lvNavLight = lightIcons; _lvApplyNavBar()
                    _lvStatusColor = c; _lvStatusLight = lightIcons; _lvApplyStatusBar()
                } catch (e: Exception) { /* ignore */ }
            }
        }
        // v2.5.0 #2/#4：横屏隐藏 / 显示系统状态栏。
        // API30+ 走 WindowInsetsController.hide/show(statusBars)；旧系统退回 SYSTEM_UI_FLAG_FULLSCREEN。
        @android.webkit.JavascriptInterface
        fun setStatusBarVisible(visible: Boolean) {
            runOnUiThread {
                try {
                    val win = window ?: return@runOnUiThread
                    if (android.os.Build.VERSION.SDK_INT >= 30) {
                        // Window.insetsController 是可空的 WindowInsetsController?，必须先判空，
                        // 否则 Kotlin 编译报错「only safe (?.) or non-null asserted (!!.) calls
                        // are allowed on a nullable receiver」→ 整个 APK 构建失败。
                        val insets = win.insetsController ?: return@runOnUiThread
                        if (visible) insets.show(android.view.WindowInsets.Type.statusBars())
                        else insets.hide(android.view.WindowInsets.Type.statusBars())
                    } else {
                        val decor = win.decorView
                        val flag = android.view.View.SYSTEM_UI_FLAG_FULLSCREEN
                        decor.systemUiVisibility =
                            if (visible) decor.systemUiVisibility and flag.inv()
                            else decor.systemUiVisibility or flag
                    }
                } catch (e: Exception) { /* ignore */ }
            }
        }
    }
'''

LIFECYCLE = [
    ("onStart", "override fun onStart() {\n        super.onStart()\n        _lvHealStart()\n    }\n"),
    ("onResume", "override fun onResume() {\n        super.onResume()\n        _lvHealStart()\n    }\n"),
    ("onWindowFocusChanged",
     "override fun onWindowFocusChanged(hasFocus: Boolean) {\n"
     "        super.onWindowFocusChanged(hasFocus)\n"
     "        if (hasFocus) _lvHealStart()\n    }\n"),
]


def class_body_insert_pos(src):
    """返回类体第一个 '{' 之后的位置（用于往类体开头插成员）。"""
    idx = src.index("class MainActivity")
    brace = src.index("{", idx)
    return brace + 1


def patch(path):
    src = io.open(path, encoding="utf-8").read()
    if "class MainActivity" not in src:
        print("::warning::class MainActivity not found in %s, skip" % path)
        return 0

    changed = []

    # 1) back 桥
    if "fun onBackPressed(" not in src or "fun findBackWebView(" not in src:
        pos = class_body_insert_pos(src)
        src = src[:pos] + BACK_BLOCK + src[pos:]
        changed.append("back-bridge")
    else:
        print("back-bridge: already present, skip")

    # 2) 状态栏方法（类成员）—— 有旧桥时也要能补
    if "fun _lvApplyStatusBar(" not in src:
        if "var _lvNavColor" in src:
            pos = src.index("var _lvNavColor")
        elif "val LvYunAndroid" in src:
            pos = src.index("val LvYunAndroid")
        else:
            pos = class_body_insert_pos(src)
        src = src[:pos] + STATUS_BLOCK + "\n" + src[pos:]
        changed.append("_lvApplyStatusBar")
    else:
        print("_lvApplyStatusBar: already present, skip")

    # 3) 整套桥
    if "LvYunAndroid" not in src:
        pos = class_body_insert_pos(src)
        src = src[:pos] + FULL_BLOCK + src[pos:]
        changed.append("LvYunAndroid(bridge)")
    else:
        print("LvYunAndroid: already present, checking methods")
        if "fun setBarsColor(" not in src or "fun setStatusBarColor(" not in src:
            # 定位 setNavBarColor 方法体结束的 '}'，把新方法插到它后面
            m = re.search(r"fun setNavBarColor\(", src)
            if m:
                tail = src.index("\n        }", m.start())  # 方法体闭合（8 空格缩进）
                src = src[:tail + len("\n        }")] + BARS_METHODS.rstrip("\n") + src[tail + len("\n        }"):]
                changed.append("setStatusBarColor+setBarsColor")
            else:
                print("::warning::old bridge without setNavBarColor, cannot append bar methods")
        else:
            print("setStatusBarColor+setBarsColor: already present, skip")

    # 4) 生命周期里触发自愈 —— 逐项检查 override 是否存在
    #    注意：不能只判断 "_lvHealStart()" 是否在 src 里，FULL_BLOCK 自带定义，
    #    会让判断恒真、钩子永远注入不进去（v2.4.5 排查时的坑）。
    for name, stub in LIFECYCLE:
        sig = "override fun %s(" % name
        if sig not in src:
            pos = class_body_insert_pos(src)
            src = src[:pos] + "\n    " + stub + src[pos:]
            changed.append("lifecycle:%s" % name)
        else:
            # 已有 override，但可能没调 _lvHealStart()（例如别的 patch 先生成的）
            m = re.search(re.escape(sig) + r"[^{]*\{", src)
            if m:
                body_start = m.end()
                body_end = src.index("\n    }", body_start)
                body = src[body_start:body_end]
                if "_lvHealStart()" not in body:
                    src = (src[:body_end]
                           + "\n        _lvHealStart()"
                           + src[body_end:])
                    changed.append("lifecycle:%s(+call)" % name)
                else:
                    print("lifecycle %s: already calls _lvHealStart, skip" % name)

    io.open(path, "w", encoding="utf-8").write(src)
    if changed:
        print("Patched %s -> %s" % (path, ", ".join(changed)))
    else:
        print("Patched %s -> nothing to do (already complete)" % path)
    return 0


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT
    try:
        io.open(path, encoding="utf-8").read()
    except IOError:
        print("::warning::%s not found, skip bridge patch" % path)
        return 0
    return patch(path)


if __name__ == "__main__":
    sys.exit(main())
