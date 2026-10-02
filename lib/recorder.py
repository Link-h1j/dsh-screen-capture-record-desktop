"""宿主侧录屏：抓屏 → MJPEG 帧流（stdout / 文件）→ 交给 ffmpeg 封装成 webm。

为什么这么设计
--------------
桌面版 Electron 把媒体权限全拒了（setDisplayMediaRequestHandler → cb({})），
浏览器侧的 getDisplayMedia 永远拿不到流，所以录屏只能在宿主进程做。

宿主能用的编码器只有 playwright 那个精简 ffmpeg（--disable-everything），但它
恰好开了我们要的那一段：
    --enable-demuxer=image2pipe --enable-decoder=mjpeg
    --enable-encoder=libvpx_vp8 --enable-muxer=webm   （另有 scale/crop/pad）
所以管道就是：本脚本按帧率抓屏 → JPEG → image2pipe → ffmpeg → .webm。

**产出是真正的视频文件**，抽帧交给 Agent 侧（tools/screen-watch/watch_video.py，
opencv 解 VP8）：视频是完整证据，少了哪一帧还能重抽，抽帧密度也能按问题现场调。

用法
----
    python recorder.py [--fps 5] [--max-edge 1280] [--quality 72]
                       [--seconds 600] [--out FILE] [--no-cursor]
                       [--region X,Y,W,H] [--hwnd 0x1234]

    --region 只录虚拟桌面上的一块（物理像素，虚拟桌面坐标系；多显示器时
    原点可能是负数）。不给就是整个虚拟桌面 —— 也就是老行为。
    --hwnd 给一个窗口句柄时，每帧按该窗口**当前**的矩形录（窗口被拖动/改
    大小后跟着走）；窗口最小化/失效时退回 --region 给的矩形。

    注意：录的是**屏幕上的那块像素**，不是窗口自己的画面 —— 别的窗口挡在
    前面就会录到挡着的那个（getDisplayMedia 那种"窗口流"做不到，宿主机只能
    抓屏）。所以录窗口时别把别的窗口摞上去。

    --out 省略时写 stdout（生产路径：Node 把 stdout 接进 ffmpeg 的 stdin）。
    --out 给文件时用于离线自测（Windows 的 PowerShell 管道会毁二进制，别用 > 重定向）。

停止方式（任一）
    - 父进程关闭 stdin（生产路径就是关掉管道）
    - 往 stdin 写任意一行
    - 达到 --seconds 上限
    - 输出文件旁出现 <out>.stop

指标写到 stderr：抓了多少帧、实际 fps、平均每帧耗时。
"""

import argparse
import ctypes
from ctypes import wintypes
import io
import os
import sys
import threading
import time

from PIL import Image, ImageDraw, ImageGrab


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
DWMWA_EXTENDED_FRAME_BOUNDS = 9

_user32 = ctypes.windll.user32 if hasattr(ctypes, "windll") else None
_dwmapi = None
try:
    _dwmapi = ctypes.windll.dwmapi
except Exception:
    _dwmapi = None

if _user32 is not None:
    # HWND is 64-bit on x64: declare argtypes so ctypes does not truncate it to int.
    _user32.IsWindow.argtypes = [wintypes.HWND]
    _user32.IsWindow.restype = wintypes.BOOL
    _user32.IsWindowVisible.argtypes = [wintypes.HWND]
    _user32.IsWindowVisible.restype = wintypes.BOOL
    _user32.IsIconic.argtypes = [wintypes.HWND]
    _user32.IsIconic.restype = wintypes.BOOL
    _user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
    _user32.GetWindowRect.restype = wintypes.BOOL
    _user32.GetCursorPos.argtypes = [ctypes.POINTER(POINT)]
    _user32.GetCursorPos.restype = wintypes.BOOL
    _user32.GetSystemMetrics.argtypes = [ctypes.c_int]
    _user32.GetSystemMetrics.restype = ctypes.c_int


def make_dpi_aware():
    """不声明 DPI 感知的话，150% 缩放下抓到的图是放大的糊图，坐标也对不上。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def cursor_pos():
    """当前鼠标位置（物理像素）；拿不到返回 None。"""
    try:
        pt = POINT()
        if _user32 is not None and _user32.GetCursorPos(ctypes.byref(pt)):
            return int(pt.x), int(pt.y)
    except Exception:
        pass
    return None


def virtual_origin():
    """虚拟桌面左上角（多显示器时可能是负数）—— 与 ImageGrab(all_screens=True) 对齐。"""
    try:
        if _user32 is not None:
            return (
                int(_user32.GetSystemMetrics(SM_XVIRTUALSCREEN)),
                int(_user32.GetSystemMetrics(SM_YVIRTUALSCREEN)),
            )
    except Exception:
        pass
    return (0, 0)


def parse_region(text):
    """'x,y,w,h' -> (x, y, w, h)；空或非法返回 None。"""
    if not text:
        return None
    try:
        parts = [int(float(p.strip())) for p in str(text).split(",")]
    except Exception:
        return None
    if len(parts) != 4:
        return None
    x, y, w, h = parts
    if w <= 0 or h <= 0:
        return None
    return (x, y, w, h)


def window_rect(hwnd):
    """窗口当前矩形（物理像素）；最小化 / 隐藏 / 句柄失效时返回 None。

    先问 DWM 的 extended frame bounds：GetWindowRect 在最大化窗口上会把
    不可见的拖拽边框算进去（四周多出几个像素的黑边）。
    """
    if not hwnd or _user32 is None:
        return None
    try:
        if not _user32.IsWindow(hwnd):
            return None
        if not _user32.IsWindowVisible(hwnd):
            return None
        if _user32.IsIconic(hwnd):
            return None
        r = RECT()
        got = False
        if _dwmapi is not None:
            try:
                if (
                    _dwmapi.DwmGetWindowAttribute(
                        wintypes.HWND(hwnd),
                        DWMWA_EXTENDED_FRAME_BOUNDS,
                        ctypes.byref(r),
                        ctypes.sizeof(r),
                    )
                    == 0
                    and r.right > r.left
                ):
                    got = True
            except Exception:
                got = False
        if not got:
            if not _user32.GetWindowRect(hwnd, ctypes.byref(r)):
                return None
        w = int(r.right - r.left)
        h = int(r.bottom - r.top)
        if w < 40 or h < 40:
            return None
        return (int(r.left), int(r.top), w, h)
    except Exception:
        return None


CURSOR_SHAPE = [
    (0, 0), (0, 16), (4, 12), (7, 19), (10, 17), (7, 11), (12, 11),
]


def draw_cursor(img, pos):
    """把鼠标箭头画进帧里。

    为什么必须画：getDisplayMedia 默认不含光标，而"看不出在点哪儿"的录屏基本没用；
    这个信息一旦没录进去，事后无法补救（本机老插件的总结）。
    """
    if not pos:
        return img
    x, y = pos
    if x < 0 or y < 0 or x > img.width or y > img.height:
        return img
    overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(overlay).polygon(
        [(x + px, y + py) for px, py in CURSOR_SHAPE],
        fill=(0, 0, 0, 235),
        outline=(255, 255, 255, 245),
        width=2,
    )
    return Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")


def watch_stdin(flag):
    """后台线程：stdin 关闭或收到任意一行就置位。stdin 不可读时静默退出。"""
    try:
        while True:
            chunk = sys.stdin.buffer.read(1)
            if not chunk:
                flag["stop"] = True
                return
            if chunk.strip():
                flag["stop"] = True
                return
    except Exception:
        return


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--fps", type=float, default=5.0)
    ap.add_argument("--max-edge", type=int, default=1280)
    ap.add_argument("--quality", type=int, default=72)
    ap.add_argument("--seconds", type=float, default=600.0)
    ap.add_argument("--out", default="")
    ap.add_argument("--no-cursor", action="store_true")
    ap.add_argument("--region", default="")
    ap.add_argument("--hwnd", default="")
    args = ap.parse_args()

    if args.fps <= 0:
        print("recorder: --fps 必须 > 0", file=sys.stderr)
        return 2
    if args.max_edge < 0:
        print("recorder: --max-edge 不能为负", file=sys.stderr)
        return 2

    region = parse_region(args.region)
    if args.region and not region:
        print("recorder: --region 需要 x,y,w,h 形式", file=sys.stderr)
        return 2
    hwnd = 0
    try:
        hwnd = int(str(args.hwnd), 0) if args.hwnd else 0
    except Exception:
        print("recorder: --hwnd 不是合法句柄", file=sys.stderr)
        return 2

    make_dpi_aware()
    vox, voy = virtual_origin()
    print(
        "recorder: 虚拟桌面原点 (%d,%d) 区域 %s 窗口 %s"
        % (vox, voy, region if region else "整个桌面", hwnd or "无"),
        file=sys.stderr,
    )

    sink = open(args.out, "wb") if args.out else sys.stdout.buffer
    stop_file = (args.out + ".stop") if args.out else None
    if stop_file and os.path.exists(stop_file):
        try:
            os.remove(stop_file)
        except OSError:
            pass

    flag = {"stop": False}
    if not args.out:
        threading.Thread(target=watch_stdin, args=(flag,), daemon=True).start()

    period = 1.0 / args.fps
    started = time.time()
    frames = 0
    capture_ms = 0.0
    next_at = started

    try:
        while True:
            now = time.time()
            if flag["stop"] or (now - started) >= args.seconds:
                break
            if stop_file and os.path.exists(stop_file):
                break

            t0 = time.time()
            try:
                img = ImageGrab.grab(all_screens=True)
            except Exception as exc:  # 抓屏偶发失败不该终止整段录制
                print("recorder: 抓屏失败 %r" % (exc,), file=sys.stderr)
                time.sleep(period)
                continue

            # 本帧要录的那一块：优先跟窗口（窗口动/改大小都跟着），拿不到就退回
            # 选择时的固定矩形，都没有就是整个虚拟桌面。
            box = window_rect(hwnd) if hwnd else None
            if not box:
                box = region
            if box:
                bx, by, bw, bh = box
                x1 = max(0, bx - vox)
                y1 = max(0, by - voy)
                x2 = min(img.width, bx - vox + bw)
                y2 = min(img.height, by - voy + bh)
                if x2 - x1 >= 4 and y2 - y1 >= 4:
                    img = img.crop((x1, y1, x2, y2))
                    ox, oy = vox + x1, voy + y1
                else:
                    # 区域完全跑到屏幕外了（窗口挪走/显示器拔了）：别产出 0x0，
                    # 这一帧退回整屏，下帧也许就回来了。
                    ox, oy = vox, voy
            else:
                ox, oy = vox, voy

            if args.max_edge > 0 and max(img.size) > args.max_edge:
                scale = args.max_edge / float(max(img.size))
                img = img.resize(
                    (max(2, int(img.width * scale)), max(2, int(img.height * scale))),
                    Image.LANCZOS,
                )
            if not args.no_cursor:
                cur = cursor_pos()
                # 光标是虚拟桌面坐标：按本帧的实际原点平移，否则区域录制里会画到框外
                img = draw_cursor(img, (cur[0] - ox, cur[1] - oy) if cur else None)

            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=args.quality)
            try:
                sink.write(buf.getvalue())
                sink.flush()
            except (BrokenPipeError, OSError):
                break  # ffmpeg 那头退出了，收摊

            capture_ms += (time.time() - t0) * 1000.0
            frames += 1

            next_at += period
            sleep_for = next_at - time.time()
            if sleep_for > 0:
                time.sleep(sleep_for)
            else:
                next_at = time.time()  # 抓不过来就顺延，不堆积
    finally:
        try:
            sink.flush()
        except Exception:
            pass
        if args.out:
            try:
                sink.close()
            except Exception:
                pass

    elapsed = time.time() - started
    fps = (frames / elapsed) if elapsed > 0 else 0.0
    per = (capture_ms / frames) if frames else 0.0
    print(
        "recorder: %d 帧 / %.1fs (实得 %.2f fps, 目标 %.1f) 平均每帧 %.0fms"
        % (frames, elapsed, fps, args.fps, per),
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
