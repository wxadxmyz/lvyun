package com.lvyun.app

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    // v2.5.6 #2：切回前台「零闪回」——前台返回路径（onStart / onResume /
    // onWindowFocusChanged）只保活桥(_lvHealStart)，不再调 _lvInitWindow() 重设启动渐变，
    // 避免每次回前台窗口「闪回粉紫渐变」再被 JS 设回页面底色。窗口底色在 onCreate 首启
    // 设一次，之后由 JS setWindowBackground 按当前页维护；兜底由 styles.xml 的
    // windowBackground 渐变承担（见 scripts/patch-android-styles.py）。
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) { _lvHealStart() }
    }

    override fun onResume() {
        super.onResume()
        _lvHealStart()
    }

    override fun onStart() {
        super.onStart()
        _lvHealStart()
    }

    // v2.5.3 #4：横屏旋转中间态遮罩。
    // 点横屏时 WebView 自身在重排扩尺寸，没画出来的区域露出 WebView 默认白底 + 窗口黑底，
    // CSS 的 .ori-lock 盖不住原生层 → 闪一下"别的页面"。这里在 decorView 上盖一层深色 View，
    // 旋转完成首帧后自动移除（OnPreDraw 一次性触发 + 兜底超时），彻底消灭闪屏。
    private var _lvRotateMask: android.view.View? = null
    private var _lvRotateMaskHandler: android.os.Handler? = null
    private fun _lvShowRotateMask() {
        try {
            val decor = window?.decorView as? android.view.ViewGroup ?: return
            _lvRemoveRotateMask()
            val mask = android.view.View(this)
            mask.setBackgroundColor(android.graphics.Color.parseColor("#0E0C12"))
            mask.layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
            mask.isClickable = true
            decor.addView(mask)
            _lvRotateMask = mask
            if (_lvRotateMaskHandler == null) {
                _lvRotateMaskHandler = android.os.Handler(android.os.Looper.getMainLooper())
            }
            val vto = decor.viewTreeObserver
            val listener = object : android.view.ViewTreeObserver.OnPreDrawListener {
                private var fired = false
                override fun onPreDraw(): Boolean {
                    if (!fired) {
                        fired = true
                        _lvRotateMaskHandler?.postDelayed({ _lvRemoveRotateMask() }, 160)
                    }
                    return true
                }
            }
            vto.addOnPreDrawListener(listener)
            _lvRotateMaskHandler?.postDelayed({ _lvRemoveRotateMask() }, 1600)
        } catch (e: Exception) { /* ignore */ }
    }
    private fun _lvRemoveRotateMask() {
        try {
            _lvRotateMask?.let { (window?.decorView as? android.view.ViewGroup)?.removeView(it) }
            _lvRotateMask = null
        } catch (e: Exception) { /* ignore */ }
    }

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
        // v2.5.6 #1：WebView 首帧背景设「透明」，让 decorView 的启动渐变贯穿预渲染期
        // （清单①：消除 v2.5.5 的 #15101B 深灰底与 React 启动页渐变打架导致的「深灰闪一下」）。
        // decorView 渐变由 _lvSplashBg 在 onCreate 就位；WebView 透明后透出该渐变，
        // 与 SplashScreen 同色值 → 中间不再露深灰/黑，启动只有一次「渐变→界面」过渡。
        try { webView.setBackgroundColor(android.graphics.Color.TRANSPARENT) } catch (e: Exception) { /* ignore */ }
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
    // v2.5.5 #1：启动即把 window/decorView 背景设为「启动渐变」（粉→紫→深紫），
    // 与 SplashScreen 完全一致；并关掉底部对比 scrim（API29+），让透明的系统栏
    // 透出渐变而非窗口黑底（v2.5.4 设的是 #0d0f14 纯黑，导致启动页状态栏/手势栏发黑）。
    // WebView 首帧背景在 onWebViewCreate 设深色，避免加载前白闪（见下）。
    // 每次生命周期都调一次，幂等。
    private fun _lvSplashBg() {
        try {
            val g = android.graphics.drawable.GradientDrawable(
                android.graphics.drawable.GradientDrawable.Orientation.TL_BR,
                intArrayOf(
                    android.graphics.Color.parseColor("#FF7AB6"),
                    android.graphics.Color.parseColor("#C05CFF"),
                    android.graphics.Color.parseColor("#3A1E5C")
                )
            )
            window?.setBackgroundDrawable(g)
            window?.decorView?.setBackgroundDrawable(g)
        } catch (e: Exception) { /* ignore */ }
    }
    private fun _lvInitWindow() {
        try {
            _lvSplashBg()
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                window?.isNavigationBarContrastEnforced = false
            }
        } catch (e: Exception) { /* ignore */ }
    }
    var _lvNavColor: Int? = null
    var _lvNavLight: Boolean = false
    // v2.5.1 #1/#5：返回「背景是否偏浅」，供系统栏图标明暗判断复用
    // （与前端 navBar.ts isLightColor 同算法：YIQ > 170 视为浅色）。
    private fun _lvIsLightColor(hex: String): Boolean {
        val h = hex.trim().removePrefix("#")
        val r: Int; val g: Int; val b: Int
        when (h.length) {
            3 -> { r = h[0].toString().repeat(2).toInt(16); g = h[1].toString().repeat(2).toInt(16); b = h[2].toString().repeat(2).toInt(16) }
            6 -> { r = h.substring(0, 2).toInt(16); g = h.substring(2, 4).toInt(16); b = h.substring(4, 6).toInt(16) }
            else -> return false
        }
        return (r * 299 + g * 587 + b * 114) / 1000 > 170
    }
    fun _lvApplyNavBar() {
        val c = _lvNavColor ?: return
        try {
            window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION)
            window.addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS)
            window.navigationBarColor = c
            // v2.5.1 #1/#5：关掉 Android 15+ 默认的手势栏对比度强制白罩，
            // 否则即使把条设透明/深底，系统仍会在底部叠一层浅色 scrim → 看着还是白。
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                window.isNavigationBarContrastEnforced = false
            }
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
                        "landscape" -> {
                            requestedOrientation =
                                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                            _lvShowRotateMask()
                        }
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
        // v2.5.5 #1：把 window/decorView 背景设成任意纯色（应用深底 / 横屏深底）。
        // 启动页渐变由 _lvSplashBg 负责；本接口供「启动页消失」「退出横屏」等时机
        // 把窗口背景恢复成与当前页面一致的颜色，避免栏位透明透出旧背景。
        @android.webkit.JavascriptInterface
        fun setWindowBackground(color: String) {
            runOnUiThread {
                try {
                    val c = android.graphics.Color.parseColor(color)
                    val d = android.graphics.drawable.ColorDrawable(c)
                    window?.setBackgroundDrawable(d)
                    window?.decorView?.setBackgroundDrawable(d)
                } catch (e: Exception) { /* ignore */ }
            }
        }
        // v2.5.1 #1：启动页让两条系统栏「透明」，下方粉紫渐变 WebView 直接透出 →
        // 顶/底与渐变同色「消失」，而不是白块。透明在各 Android 版本都生效，
        // 绕开 API35+ 忽略 navigationBarColor / statusBarColor 的问题。
        // 同时关掉底部对比度白罩（isNavigationBarContrastEnforced=false），
        // 并按顶/底色明暗分别给定状态栏 / 导航栏图标明暗。
        // v2.5.3 #1：启动页把两条系统栏**直接染色**成渐变两端色，而不是透明。
        // 透明时透出的是窗口底色（黑）—— v2.5.2 实测就是黑条。
        // 这里用 JS 传来的 topColor/bottomColor 直接染，并写回 _lvStatusColor/_lvNavColor，
        // 让后续任何 _lvApplyStatusBar/NavBar 都只会维持这个色，不会被覆盖回白色。
        @android.webkit.JavascriptInterface
        fun setSplashBars(topColor: String, bottomColor: String) {
            runOnUiThread {
                try {
                    // v2.5.4 #1：API35+ 已禁用 statusBarColor / navigationBarColor，
                    // 这里不再染色，只关底部对比 scrim，让 .splash 粉紫渐变经透明栏
                    // 直接透出（状态栏=渐变顶色、手势栏=渐变底色），与启动页同色。
                    if (android.os.Build.VERSION.SDK_INT >= 29) {
                        window.isNavigationBarContrastEnforced = false
                    }
                    _lvStatusLight = _lvIsLightColor(topColor)
                    _lvNavLight = _lvIsLightColor(bottomColor)
                    _lvApplyAppearance()
                } catch (e: Exception) { /* ignore */ }
            }
        }
        // v2.5.1 #5：横屏让两条系统栏透明，播放器深底渐变透出 →
        // 通知栏 + 手势栏底色 = 播放器背景色（哪怕点开控件也同色）。
        // 深底 → 浅(白)图标（_lvStatusLight/_lvNavLight = false）。
        // v2.5.3 #5：横屏把两条系统栏**直接染深渐变端点色**，而不是透明。
        // 透明后 _lvApplyStatusBar/NavBar 会把颜色覆盖回 _lvStatusColor/_lvNavColor
        // （进横屏前 navBar.ts 存的是 --bg 白），于是手势栏全程白条、点屏显控件时
        // 顶部冒出白块。这里直接染深色并写回记录值，彻底堵死覆盖回退。
        @android.webkit.JavascriptInterface
        fun setLandscapeBars() {
            runOnUiThread {
                try {
                    // v2.5.5 #5：把 window/decorView 背景同步成横屏深渐变（与 .fs-land 同色），
                    // 这样透明手势栏透出的是深渐变而非系统默认浅色 → 不再发白。
                    // 同时关掉状态栏 + 导航栏的对比度强制白罩（API29+），否则即使把条设
                    // 透明/深底，系统仍会在栏位区域叠一层浅色 scrim。
                    val g = android.graphics.drawable.GradientDrawable(
                        android.graphics.drawable.GradientDrawable.Orientation.LEFT_RIGHT,
                        intArrayOf(
                            android.graphics.Color.parseColor("#0e0c12"),
                            android.graphics.Color.parseColor("#15101b")
                        )
                    )
                    window?.setBackgroundDrawable(g)
                    window?.decorView?.setBackgroundDrawable(g)
                    if (android.os.Build.VERSION.SDK_INT >= 29) {
                        window?.isNavigationBarContrastEnforced = false
                        window?.isStatusBarContrastEnforced = false
                    }
                    _lvStatusLight = false
                    _lvNavLight = false
                    _lvApplyAppearance()
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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  
        _lvInitWindow()
        _lvHealStart()}
}
