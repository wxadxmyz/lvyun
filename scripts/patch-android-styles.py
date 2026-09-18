#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
v2.5.6 #1：为 Android 主题补「windowBackground 渐变兜底」。

背景：清单①要求 App 刚点开、网页尚未渲染的那一帧，系统默认底色不露黑/白。
原生桥(patch-android-bridge.py) 已在 onCreate 用代码把 window/decorView 设成品牌
渐变(_lvSplashBg)，但「主题 windowBackground」这一层若仍是系统默认，部分机型/低内存
回收后仍可能露默认色。这里把渐变写进主题的 windowBackground，作为与代码等价的持久兜底。

⚠️ 前置条件：必须先 `tauri android init` 生成 res 目录（含 themes.xml / strings.xml）。
   本脚本在 gen/android 的 res 尚未生成时会直接退出并给出提示，绝不裸建文件导致编译冲突。

幂等：已注入 windowBackground 项、splash_gradient drawable 已存在则跳过。
"""

import io
import os
import re
import sys

# gen/android 的 main 目录（与 patch-android-bridge.py 同基准）
MAIN = "src-tauri/gen/android/app/src/main"
VALUES = os.path.join(MAIN, "res", "values")
DRAWABLE = os.path.join(MAIN, "res", "drawable")
MANIFEST = os.path.join(MAIN, "AndroidManifest.xml")

# 与 patch-android-bridge.py 的 _lvSplashBg 完全一致的颜色与方向（TL_BR = angle 315）
GRADIENT_COLORS = ("#FF7AB6", "#C05CFF", "#3A1E5C")

ITEM_LINE = '        <item name="android:windowBackground">@drawable/splash_gradient</item>\n'

DRAWABLE_XML = (
    '<?xml version="1.0" encoding="utf-8"?>\n'
    '<shape xmlns:android="http://schemas.android.com/apk/res/android"\n'
    '    android:shape="rectangle">\n'
    '    <gradient\n'
    '        android:type="linear"\n'
    '        android:angle="315"\n'  # 315° = 左上→右下，对应 GradientDrawable.Orientation.TL_BR
    '        android:startColor="%s"\n'
    '        android:centerColor="%s"\n'
    '        android:endColor="%s" />\n'
    '</shape>\n'
) % GRADIENT_COLORS


def find_theme_name():
    """从 AndroidManifest 解析 android:theme 引用的主题名（如 Theme.lvyun）。"""
    try:
        m = io.open(MANIFEST, encoding="utf-8").read()
    except IOError:
        return None
    hit = re.search(r'android:theme="(?P<ref>@style/(?P<name>[^"]+))"', m)
    if hit:
        return hit.group("name")
    return None


def list_values_xmls():
    if not os.path.isdir(VALUES):
        return []
    return [os.path.join(VALUES, f)
            for f in os.listdir(VALUES)
            if f.endswith(".xml")]


def find_app_theme_style(xml_path, theme_name):
    """在 values xml 中定位应用主题 <style> 块，返回 (start, end) 或 None。

    - 优先按 manifest 主题名精确匹配 name="Theme.xxx"；
    - 否则退而求其次：找 parent 含 NoActionBar 的自定义主题（Tauri 默认主题）。
    """
    src = io.open(xml_path, encoding="utf-8").read()
    pat_name = None
    if theme_name:
        pat_name = re.compile(
            r'<style\b[^>]*\bname="%s"[^>]*>' % re.escape(theme_name))
    pat_noaction = re.compile(
        r'<style\b[^>]*\bparent="[^"]*NoActionBar[^"]*"[^>]*>')

    def block_bounds(m):
        s = m.start()
        depth = 0
        i = src.index(">", s) + 1
        while i < len(src):
            if src[i] == '<':
                if src.startswith("</style", i):
                    return s, i + len("</style>")
                if src[i + 1:].startswith("style"):
                    depth += 1
            elif src[i] == '>':
                pass
            i += 1
        return None

    # 优先精确名
    if pat_name:
        m = pat_name.search(src)
        if m:
            b = block_bounds(m)
            if b:
                return b
    # 退而求其次：第一个 NoActionBar parent 的主题
    m = pat_noaction.search(src)
    if m:
        b = block_bounds(m)
        if b:
            return b
    return None


def patch():
    if not os.path.isdir(VALUES):
        print("::warning::%s 不存在 —— 请先运行 `tauri android init` 生成 res 目录，"
              "再执行本脚本。" % VALUES)
        print("::warning::（当前 gen/android 还是构建骨架，未含 res；裸建文件会与 "
              "init 生成的标准模板冲突导致编译失败。）")
        return 0

    theme_name = find_theme_name()
    xmls = list_values_xmls()
    target = None
    bounds = None
    for xp in xmls:
        b = find_app_theme_style(xp, theme_name)
        if b:
            target, bounds = xp, b
            break
    if not target:
        print("::warning::未在 %s 中找到应用主题 <style>（theme=%s），跳过。"
              % (VALUES, theme_name))
        return 0

    src = io.open(target, encoding="utf-8").read()
    s, e = bounds
    block = src[s:e]
    changed = []

    # 1) windowBackground 项
    if "@drawable/splash_gradient" in block:
        print("windowBackground: already present, skip")
    else:
        # 插到 </style> 之前（即块末尾的 </style> 前）
        close_idx = block.rfind("</style>")
        new_block = block[:close_idx] + ITEM_LINE + block[close_idx:]
        src = src[:s] + new_block + src[e:]
        changed.append("windowBackground→%s" % os.path.basename(target))

    # 2) 创建渐变 drawable（幂等）
    os.makedirs(DRAWABLE, exist_ok=True)
    drawable_path = os.path.join(DRAWABLE, "splash_gradient.xml")
    if os.path.exists(drawable_path):
        print("splash_gradient.xml: already exists, skip")
    else:
        io.open(drawable_path, "w", encoding="utf-8").write(DRAWABLE_XML)
        changed.append("splash_gradient.xml")

    io.open(target, "w", encoding="utf-8").write(src)
    if changed:
        print("Patched styles gradient -> %s" % ", ".join(changed))
    else:
        print("Patched styles gradient -> nothing to do (already complete)")
    return 0


def main():
    # 允许在脚本内 cwd 调整；默认从仓库根执行
    if len(sys.argv) > 1:
        os.chdir(sys.argv[1])
    return patch()


if __name__ == "__main__":
    sys.exit(main())
