# Changelog

本插件的所有值得一提的改动都记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-01

首个公开发布版本。

### 功能

- 在 DSH 输入框工具条的「听写」按钮左侧插入两个按钮：**录屏**、**截图**。
- **截图**：宿主侧 GDI 抓屏（桌面壳禁用了 `getDisplayMedia`，浏览器端拿不到流），
  弹出选区浮层可拖框选 / 单击整屏 / Enter 确认 / Esc 取消；选中的画面经附件通道进输入框。
- **录屏**：点一下开始、再点一下结束（Esc 亦可）。宿主侧 Python 抓帧 → ffmpeg 编码 →
  **产出单个 `.webm` 视频**并自动进附件；抽屉里的抽帧由 Agent 侧完成。
- 产物同时落盘到 `<DSH_HOME>\dsh-screen-capture\`（`shot-<时间戳>\` 与 `rec-<时间戳>.webm`）。

### 与 DSH 官方组件的对齐

- 按钮：28×28 CSS、圆角 `--dsw-radius-xs`（4px）、图标 `viewBox 16×16` + `stroke-width 1` + 18px 渲染、
  hover 底色 `--dsw-alias-interactive-bg-hover-solid` —— 与内置「听写」按钮逐项一致（实测数据见 `DEV.md`）。
- 悬浮提示：复刻官方 `Tooltip`（`gap 8`、`edgeMargin 12`、`tooltip-in 150ms`、溢出自动翻面、延迟 0）。
- 轻提示：改用官方 `Toast` 的深色横幅（`--dsw-alias-toast-bg`、`--dsw-radius-lg`、`--dsw-shadow-lv3`、160ms 滑入 + 定时淡出）。
- 选区浮层：卡片用官方 Modal 的浮层语言（`--dsw-alias-bg-layer-2` + `--dsw-elevation-prominent`），
  按钮用官方 `Button` 的 `sm` 变体（primary / outline）。

### 修复与加固（相对内部开发版）

- **录屏一度完全无法产出文件**：DSH 的 Windows 沙箱约束的是子进程 —— ffmpeg 既写不了
  `~/.dsh` 也写不了 `%TEMP%`。改为让 ffmpeg 把 webm 写到 `stdout`（`-f webm pipe:1`）、
  由宿主 Node 落盘，链路上**没有任何子进程需要写文件**。
- playwright 自带的精简 ffmpeg 不认 `-i -`（报 `Protocol not found`），必须写 `-i pipe:0`。
- 录屏结束时的失败提示不再只有「HTTP 200」，会把 ffmpeg 的原因带出来。
- 起录屏前先做**能力预检**：找不到带 Pillow 的 Python、或找不到带 `libvpx` 的 ffmpeg 时立刻报错，
  不再先回成功、录完才发现没有文件。
- 工具探测不再写死开发目录：改为 `DSH_CAPTURE_*` 环境变量 → `<DSH_HOME>` / `%LOCALAPPDATA%\ms-playwright`
  / 向上查找 `.local` → 常见安装位置 → `PATH`，并且**逐个做能力探测**。
- 宿主路由响应不再回显绝对路径（只回文件名）。
- 客户端修掉 `style.cssText` 写 camelCase 被静默丢弃的问题（圆角与居中一起失效）；
  每次扫描重申样式与插入位置，免受 `client-hmr` 遗留旧实例影响。
- 附件只走一条通道，修掉「同一个录屏出现两个附件」的重复。
