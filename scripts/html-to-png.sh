#!/usr/bin/env bash
# html-to-png.sh — 把本地 HTML 整页存成一张 PNG（专治 a4m 图谱这种超宽/超高页面）
#
# 原理（为什么不需要滚动截屏 / 拼接）：
#   Firefox 无头模式的 --screenshot 截的是「窗口视口」。只要把 --window-size 设成整页尺寸，
#   一次成图，天然就是完整长图：不滚动、不拼接、不丢失内容，也没有 Chromium 的 16384px 上限。
#   Firefox/cairo 的单边上限约 32767px，对 2 万像素宽的依赖图谱足够。
#
# 三个必须注意的坑（本脚本已处理）：
#   1. 必须给一个独立 profile 并加 --no-remote，否则撞上正在运行的 Firefox：「already running」直接失败。
#   2. --window-size 必须 >= 页面实际尺寸，否则右边/下面的节点被裁掉（视口截图，不是整页截图）。
#   3. Firefox 有时在写完 PNG 之后才崩溃退出（HOME 只读时 crashreporter 报错，退出码非 0）。
#      所以判定成功看 PNG 是否存在，而不是看退出码；同时把 HOME 指到可写目录减少噪音。
#
# 用法：
#   scripts/html-to-png.sh <input.html> [output.png] [--width W] [--height H] [--scale N] [--no-crop] [--margin PX]
#   --width/--height  页面尺寸；省略时自动读取 HTML 里第一个内联 <svg width= height=> 并加上页边距
#   --scale N         设备像素比（N=2 得到 2 倍图，画布也翻倍；超大页面慎用，会非常慢甚至卡死）
#   --no-crop         保留窗口白边（默认会按墨迹裁掉多余白边，四周留 --margin 像素，默认 20）
set -euo pipefail

die() { echo "[html-to-png] 错误：$*" >&2; exit 1; }

[ $# -ge 1 ] || die "用法: html-to-png.sh <input.html> [output.png] [--width W] [--height H] [--scale N] [--no-crop] [--margin PX]"

IN=$1; shift
[ -f "$IN" ] || die "找不到输入文件：$IN"
IN=$(readlink -f "$IN")

OUT=""
if [ $# -ge 1 ] && [[ $1 != --* ]]; then OUT=$1; shift; fi
[ -n "$OUT" ] || OUT="${IN%.*}.png"
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac
mkdir -p "$(dirname "$OUT")"

W=0; H=0; SCALE=1; CROP=1; MARGIN=20
while [ $# -gt 0 ]; do
  case "$1" in
    --width)  W=${2:?}; shift 2 ;;
    --height) H=${2:?}; shift 2 ;;
    --scale)  SCALE=${2:?}; shift 2 ;;
    --margin) MARGIN=${2:?}; shift 2 ;;
    --no-crop) CROP=0; shift ;;
    *) die "未知参数：$1" ;;
  esac
done

command -v firefox >/dev/null || die "未找到 firefox（本脚本用无头 Firefox 渲染）"

# --- 尺寸：优先命令行，其次 HTML 内联 SVG 的固有尺寸 -------------------------------
if [ "$W" -eq 0 ] || [ "$H" -eq 0 ]; then
  SVG_DIM=$(grep -oE '<svg[^>]*[[:space:]]width="[0-9]+"[^>]*[[:space:]]height="[0-9]+"' "$IN" | head -1 || true)
  SW=$(printf '%s' "$SVG_DIM" | grep -oE 'width="[0-9]+"'  | head -1 | grep -oE '[0-9]+' || true)
  SH=$(printf '%s' "$SVG_DIM" | grep -oE 'height="[0-9]+"' | head -1 | grep -oE '[0-9]+' || true)
  [ -n "${SW:-}" ] && [ "$W" -eq 0 ] && W=$((SW + 40))   # 20px 页边距 ×2
  [ -n "${SH:-}" ] && [ "$H" -eq 0 ] && H=$((SH + 100))  # 标题栏 + 上下页边距（多给一点，稍后裁掉）
fi
[ "$W" -gt 0 ] && [ "$H" -gt 0 ] || die "无法确定页面尺寸，请显式传 --width/--height"

if [ "$W" -gt 32767 ] || [ "$H" -gt 32767 ]; then
  echo "[html-to-png] 警告：${W}x${H} 超过 Firefox 单边约 32767px 的上限，可能被裁或失败。" >&2
fi

# --- 渲染 -------------------------------------------------------------------------
PROF=$(mktemp -d "${TMPDIR:-/tmp}/html2png-prof.XXXXXX")
FAKEHOME=$(mktemp -d "${TMPDIR:-/tmp}/html2png-home.XXXXXX")
RAW=$(mktemp "${TMPDIR:-/tmp}/html2png-raw.XXXXXX.png")
trap 'rm -rf "$PROF" "$FAKEHOME" "$RAW"' EXIT

if [ "$SCALE" != "1" ]; then
  # 放大重渲染（不是插值放大）：CSS 像素 → 设备像素按比例映射
  printf 'user_pref("layout.css.devPixelsPerPx", "%s");\n' "$SCALE" > "$PROF/user.js"
fi

echo "[html-to-png] 渲染 $(basename "$IN") → 窗口 ${W}x${H}${SCALE:+ @${SCALE}x}（整页一次成图）" >&2
set +e
HOME="$FAKEHOME" MOZ_CRASHREPORTER_DISABLE=1 MOZ_CRASHREPORTER=0 \
  timeout "${HTML2PNG_TIMEOUT:-900}" firefox --headless --no-remote \
    --profile "$PROF" --window-size="${W},${H}" \
    --screenshot "$RAW" "file://$IN" >/dev/null 2>&1
RC=$?
set -e
[ -s "$RAW" ] || die "渲染失败（退出码 $RC），没有产出图片。检查页面是否需要联网资源，或调大 --height。"

# --- 裁白边 + 落盘 ----------------------------------------------------------------
python3 - "$RAW" "$OUT" "$CROP" "$MARGIN" <<'PY'
import sys
from PIL import Image, ImageOps
raw, out, crop, margin = sys.argv[1], sys.argv[2], sys.argv[3] == "1", int(sys.argv[4])
im = Image.open(raw).convert("RGB")
if crop:
    w, h = im.size
    # 反相后取 bbox：纯白→0 被排除，任何非白像素都算“墨迹”（比逐像素扫描快几个数量级）
    box = ImageOps.invert(im.convert("L")).getbbox()
    if box:
        minx, miny, maxx, maxy = box
        im = im.crop((max(0, minx - margin), max(0, miny - margin),
                      min(w, maxx + margin), min(h, maxy + margin)))
im.save(out, optimize=True)
print(f"[html-to-png] 完成：{out}  {im.size[0]}x{im.size[1]}px")
PY
