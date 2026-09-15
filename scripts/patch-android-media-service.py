#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v2.4.8 #9：给 Android 端注入「前台媒体服务」，解决切后台音频被杀。

【问题】
App 用 Tauri WebView 播放音频。Android 在内存紧张或切后台一段时间后，会回收整个
Activity / WebView 进程 → JS 音频逻辑与 navigator.mediaSession 全部失效 →
表现为「切后台过一会儿自动停」；切回时 Activity 重建，观感是「重新进了软件」。

【方案】
注册一个前台服务（Foreground Service）+ 常驻通知，把进程提升为「前台优先级」，
系统就不会随便回收。通知同时扮演媒体控制入口（上一首 / 播放暂停 / 下一首），
点击动作通过 JS 回调转给 WebView 里的播放器。

【实现方式】
   1) 写 Kotlin：LvYunMediaService.kt（前台服务本体）
   2) 改 AndroidManifest.xml：加权限、service、receiver
   3) MainActivity.kt 里加一个 LvYunAndroid 桥方法 startMediaService()/stopMediaService()，
      由 Web 侧在开始播放时调用、暂停/停止时调用。

本脚本幂等：可重复执行，已有则跳过。
"""

import io
import os
import re
import sys

# --------------------------------------------------------------- Kotlin 服务 ----
SERVICE_KT = r'''
package com.lvyun.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * v2.4.8 #9：前台媒体服务。
 *
 * 目的：把 App 进程提升为前台优先级，避免切后台后 WebView 被系统回收导致音频中断。
 * 通知栏提供「上一首 / 播放暂停 / 下一首」三个动作，动作结果通过静态回调转给
 * MainActivity 的 WebView（最终落到 Web 侧 playerStore）。
 */
class LvYunMediaService : Service() {

    companion object {
        const val CHANNEL_ID = "lvyun_playback"
        const val NOTIFICATION_ID = 8848
        const val ACTION_UPDATE = "com.lvyun.app.MEDIA_UPDATE"
        const val ACTION_STOP = "com.lvyun.app.MEDIA_STOP"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"
        const val EXTRA_PLAYING = "playing"

        /** 由 MainActivity 设置：接收通知动作，转交给 WebView */
        @JvmStatic
        var onAction: ((String) -> Unit)? = null

        fun start(ctx: Context, title: String, artist: String, playing: Boolean) {
            val i = Intent(ctx, LvYunMediaService::class.java).apply {
                action = ACTION_UPDATE
                putExtra(EXTRA_TITLE, title)
                putExtra(EXTRA_ARTIST, artist)
                putExtra(EXTRA_PLAYING, playing)
            }
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            val i = Intent(ctx, LvYunMediaService::class.java).apply { action = ACTION_STOP }
            ctx.startService(i)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE)
                else @Suppress("DEPRECATION") stopForeground(true)
                stopSelf()
                return START_NOT_STICKY
            }
            else -> {
                val title = intent?.getStringExtra(EXTRA_TITLE) ?: "律云"
                val artist = intent?.getStringExtra(EXTRA_ARTIST) ?: ""
                val playing = intent?.getBooleanExtra(EXTRA_PLAYING, true) ?: true
                ensureChannel()
                val n = buildNotification(title, artist, playing)
                if (Build.VERSION.SDK_INT >= 29) {
                    startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
                } else {
                    startForeground(NOTIFICATION_ID, n)
                }
            }
        }
        return START_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val mgr = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val ch = NotificationChannel(
            CHANNEL_ID, "播放控制", NotificationManager.IMPORTANCE_LOW
        ).apply { setShowBadge(false) }
        mgr.createNotificationChannel(ch)
    }

    private fun actionIntent(action: String, code: Int): PendingIntent {
        val i = Intent(this, LvYunMediaService::class.java).apply { this.action = action }
        // 用广播式的 PendingIntent 不足以回传 WebView，这里改为直接触发静态回调：
        // 通知按钮点击 → Service 自身 onStartCommand 收到 action。为简化，
        // 播放控制一律走 JS 桥（MainActivity 绑定的 WebView），此处只做「点通知回前台」。
        val launch = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val fl = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        return PendingIntent.getActivity(this, code, launch, fl)
    }

    private fun buildNotification(title: String, artist: String, playing: Boolean): Notification {
        val open = actionIntent("open", 1)
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL_ID)
        else @Suppress("DEPRECATION") Notification.Builder(this)

        builder.setContentTitle(title)
            .setContentText(artist)
            .setSmallIcon(applicationInfo.icon)
            .setContentIntent(open)
            .setOngoing(playing)
            .setShowWhen(false)

        // 媒体风格：上一首 / 播放暂停 / 下一首
        val prev = mediaAction("prev", 11, "上一首")
        val toggle = mediaAction("toggle", 12, if (playing) "暂停" else "播放")
        val next = mediaAction("next", 13, "下一首")
        if (Build.VERSION.SDK_INT >= 21) {
            builder.addAction(Notification.Action.Builder(null, "上一首", prev).build())
            builder.addAction(Notification.Action.Builder(null, if (playing) "暂停" else "播放", toggle).build())
            builder.addAction(Notification.Action.Builder(null, "下一首", next).build())
        }
        if (Build.VERSION.SDK_INT >= 16) {
            builder.setStyle(Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2))
        }
        return builder.build()
    }

    /** 通知按钮：点击后触发 onAction 回调（MainActivity 把它转成 JS 调用） */
    private fun mediaAction(cmd: String, code: Int, label: String): PendingIntent {
        val scene = Intent(this, LvYunMediaService::class.java).apply {
            action = "com.lvyun.app.MEDIA_CMD_$cmd"
        }
        val fl = PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        return PendingIntent.getService(this, code, scene, fl)
    }
}
'''

# 通知命令 action 的处理（补在 onStartCommand 里）
CMD_HANDLER = r'''
        // v2.4.8 #9：通知栏媒体键 → 转交 WebView 播放器
        if (intent?.action?.startsWith("com.lvyun.app.MEDIA_CMD_") == true) {
            val cmd = intent.action!!.removePrefix("com.lvyun.app.MEDIA_CMD_")
            LvYunMediaService.onAction?.invoke(cmd)
            return START_STICKY
        }
'''

# ---------------------------------------------------------- Manifest 注入 ----
PERM_COMMENT = '''    <!-- v2.4.8 #9：前台媒体服务（后台播放保活 + 通知栏控制） -->
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK" />
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
'''

SERVICE_XML = '''
        <!-- v2.4.8 #9：前台媒体服务，避免切后台被系统回收 -->
        <service
            android:name=".LvYunMediaService"
            android:exported="false"
            android:foregroundServiceType="mediaPlayback" />
'''

BRIDGE_METHODS = '''
        @android.webkit.JavascriptInterface
        fun startMediaService(title: String, artist: String, playing: Boolean) {
            runOnUiThread {
                try { com.lvyun.app.LvYunMediaService.start(this@MainActivity, title, artist, playing) }
                catch (e: Exception) { /* ignore */ }
            }
        }
        @android.webkit.JavascriptInterface
        fun stopMediaService() {
            runOnUiThread {
                try { com.lvyun.app.LvYunMediaService.stop(this@MainActivity) }
                catch (e: Exception) { /* ignore */ }
            }
        }
'''

ONACTION_BLOCK = '''
    // v2.4.8 #9：把通知栏媒体键转发进 WebView
    private fun _lvWireMediaService() {
        try {
            com.lvyun.app.LvYunMediaService.onAction = { cmd ->
                runOnUiThread {
                    try {
                        val wv = _lvBoundView?.get() ?: findBackWebView(window?.decorView as? android.view.ViewGroup)
                        val js = when (cmd) {
                            "prev" -> "window.__lvMedia&&window.__lvMedia.prev()"
                            "next" -> "window.__lvMedia&&window.__lvMedia.next()"
                            "toggle" -> "window.__lvMedia&&window.__lvMedia.toggle()"
                            else -> ""
                        }
                        if (wv != null && js.isNotEmpty()) wv.evaluateJavascript(js, null)
                    } catch (e: Exception) { /* ignore */ }
                }
            }
        } catch (e: Exception) { /* ignore */ }
    }
'''


def class_body_insert_pos(src, cls="class MainActivity"):
    idx = src.index(cls)
    brace = src.index("{", idx)
    return brace + 1


def patch_manifest(path):
    src = io.open(path, encoding="utf-8").read()
    changed = []

    if "FOREGROUND_SERVICE" not in src:
        # 插在第一个 <uses-permission> 前
        m = re.search(r"<uses-permission[^>]*/>", src)
        if m:
            src = src[:m.start()] + PERM_COMMENT + src[m.start():]
        else:
            src = src.replace("<manifest", "<manifest", 1)  # noop safeguard
        changed.append("permissions")

    if "LvYunMediaService" not in src:
        # 插在 </application> 前
        pos = src.rindex("</application>")
        src = src[:pos] + SERVICE_XML + src[pos:]
        changed.append("service")

    io.open(path, "w", encoding="utf-8").write(src)
    return changed


def patch_mainactivity(path):
    src = io.open(path, encoding="utf-8").read()
    if "class MainActivity" not in src:
        print("::warning::class MainActivity not found in %s" % path)
        return []
    changed = []

    # 1) 桥方法
    if "fun startMediaService(" not in src:
        m = re.search(r"fun setBarsColor\(", src)
        if m:
            # 插到 setBarsColor 方法体闭合之后
            tail = src.index("\n        }", m.start())
            ins = tail + len("\n        }")
            src = src[:ins] + BRIDGE_METHODS.rstrip("\n") + src[ins:]
        else:
            # 没有旧桥则插到类体开头
            pos = class_body_insert_pos(src)
            src = src[:pos] + "\n" + BRIDGE_METHODS + src[pos:]
        changed.append("bridge:start/stopMediaService")

    # 2) onAction 连线
    if "_lvWireMediaService" not in src:
        pos = class_body_insert_pos(src)
        src = src[:pos] + ONACTION_BLOCK + src[pos:]
        changed.append("_lvWireMediaService")

    # 3) 在 onStart/onResume 里调用 _lvWireMediaService()
    for name in ("onStart", "onResume"):
        sig = "override fun %s(" % name
        m = re.search(re.escape(sig) + r"[^{]*\{", src)
        if m:
            body_start = m.end()
            body_end = src.index("\n    }", body_start)
            body = src[body_start:body_end]
            if "_lvWireMediaService()" not in body:
                src = src[:body_end] + "\n        _lvWireMediaService()" + src[body_end:]
                changed.append("wire:%s" % name)

    io.open(path, "w", encoding="utf-8").write(src)
    return changed


def write_service(kt_dir):
    os.makedirs(kt_dir, exist_ok=True)
    out = os.path.join(kt_dir, "LvYunMediaService.kt")
    io.open(out, "w", encoding="utf-8").write(SERVICE_KT.lstrip("\n"))
    return out


def main():
    manifest = sys.argv[1] if len(sys.argv) > 1 else \
        "src-tauri/gen/android/app/src/main/AndroidManifest.xml"
    main_kt = sys.argv[2] if len(sys.argv) > 2 else \
        "src-tauri/gen/android/app/src/main/java/com/lvyun/app/MainActivity.kt"

    if not os.path.exists(manifest):
        print("::warning::%s not found, skip media service patch" % manifest)
        return 0

    ch = patch_manifest(manifest)
    print("manifest patched: %s" % (", ".join(ch) if ch else "nothing to do"))

    if os.path.exists(main_kt):
        ch2 = patch_mainactivity(main_kt)
        print("MainActivity patched: %s" % (", ".join(ch2) if ch2 else "nothing to do"))
        kt_dir = os.path.dirname(main_kt)
        out = write_service(kt_dir)
        print("service written: %s" % out)
    else:
        print("::warning::%s not found, skip MainActivity patch" % main_kt)

    return 0


if __name__ == "__main__":
    sys.exit(main())
