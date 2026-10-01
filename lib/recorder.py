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
import io
import os
import sys
import threading
import time

from PIL import Image, ImageDraw, ImageGrab


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


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
        if ctypes.windll.user32.GetCursorPos(ctypes.byref(pt)):
            return int(pt.x), int(pt.y)
    except Exception:
        pass
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
    args = ap.parse_args()

    if args.fps <= 0:
        print("recorder: --fps 必须 > 0", file=sys.stderr)
        return 2
    if args.max_edge < 0:
        print("recorder: --max-edge 不能为负", file=sys.stderr)
        return 2

    make_dpi_aware()

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

            if args.max_edge > 0 and max(img.size) > args.max_edge:
                scale = args.max_edge / float(max(img.size))
                img = img.resize(
                    (max(2, int(img.width * scale)), max(2, int(img.height * scale))),
                    Image.LANCZOS,
                )
            if not args.no_cursor:
                img = draw_cursor(img, cursor_pos())

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
