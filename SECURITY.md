# 安全与实现说明（宿主半边）

这个插件是社区索引里少数会在**宿主进程**里执行本机程序（PowerShell / Python / ffmpeg）的条目，
所以这份文档只讲审阅时会关心的事：**这些路由谁能调、进程参数怎么拼、临时文件什么时候删、出错时会发生什么**。

实现位置：`lib/index.js`（宿主半边）、`lib/shot.ps1`、`lib/sources.ps1`、`lib/recorder.py`。
（文件里引用的行号对应 `v0.5.0` 那个 commit，挪动后以函数名为准。）

## 1. 路由与调用方

| 路由 | 作用 |
| --- | --- |
| `GET  /plugins/dsh-screen-capture-record-desktop/shot` | 宿主跑 `lib/shot.ps1`（GDI）抓整屏，直接回图片字节；`?probe=1` 只探活 |
| `GET  /plugins/dsh-screen-capture-record-desktop/sources` | 宿主跑 `lib/sources.ps1` 枚举虚拟桌面 / 显示器 / 顶层窗口 |
| `POST /plugins/dsh-screen-capture-record-desktop/save` | 把请求体字节落盘到 `<DSH_HOME>\dsh-screen-capture\<dir>\<file>` |
| `POST /plugins/dsh-screen-capture-record-desktop/record/start` | 起 `recorder.py` → ffmpeg（VP8/WebM）管道 |
| `POST /plugins/dsh-screen-capture-record-desktop/record/stop` | 关抓屏管 → 等 ffmpeg 收尾 → 报产物 |
| `GET  /plugins/dsh-screen-capture-record-desktop/record/file` | 把录好的 `.webm` 交给浏览器（进附件） |

- 只挂在 DSH 宿主的 webServer 上（`ctx.inject(['webServer'])` + `ctx.effect()`），路由表见 `lib/index.js` 的 `ROUTES`。
  **不额外做鉴权** —— 它和 DSH 自己的入口同源、同样只绑 `127.0.0.1`；能访问这个端口的人本来就能操作这台机器的桌面，
  所以没有再叠一层 token。如果官方统一要求给插件路由加 Origin/token 校验，可以按同一口径补上。
- `require` 只用了 Node 内置模块（`node:child_process` / `node:fs` / `node:path` / `node:os` / `node:url`），
  不碰 DSH 内部实现；`apply()` 全程 try/catch —— 这个插件坏了也不该影响宿主启动。

## 2. 子进程与参数：没有任何一处把页面输入拼进命令行

三条链路，参数都是**固定的脚本路径 + 我们自己的参数**，页面能影响的只有数字：

| 链路 | 启动方式 | 页面可控 | 夹取 |
| --- | --- | --- | --- |
| 抓屏 | `spawn(powershell.exe, ['-NoProfile','-ExecutionPolicy','Bypass','-File', <repo>/lib/shot.ps1, '-OutPath', <临时文件>, '-Format', …, '-MaxEdge', …, '-Quality', …])` | format / maxEdge / quality | `format ∈ {jpg,png}`；`maxEdge 0–4096`；`quality 1–100` |
| 枚举源 | `spawn(powershell.exe, ['-NoProfile','-ExecutionPolicy','Bypass','-File', <repo>/lib/sources.ps1])` | 无 | — |
| 录屏 | `spawn(python, [<repo>/lib/recorder.py, '--fps', …, '--max-edge', …, '--quality', …, '--seconds', … [, '--region', 'x,y,w,h'] [, '--hwnd', N]])` | fps / maxEdge / quality / seconds / 区域 / hwnd | `1–15` / `0–2560` / `40–95` / `5–900`（`REC_MAX_SECONDS`）/ 坐标 `±100000` 且 `w,h ≥ 8` / `hwnd` 为整数（`clampInt`，见 `lib/index.js` 的 `handleRecordStart`） |
| 编码 | 同一函数里 `spawn(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', N, '-i', 'pipe:0', …, '-f', 'webm', 'pipe:1'])` | 只有上面那些数字 | — |

- `-File` 后面的路径是**仓库内的固定文件**（`path.join(LIB_DIR, 'shot.ps1')` 等），页面无法指定脚本；
  全程 `spawn(cmd, argvArray)`，**没有** `shell: true` / `cmd /c` / 拼接命令行字符串的地方。
- `/save` 的 `dir` / `file` 只允许 `[A-Za-z0-9._-]`、去掉开头点、各自 ≤96 字符；请求体上限 32 MiB；
  落盘根固定为 `<DSH_HOME>\dsh-screen-capture`（`captureDir()`）；回包只回**文件名**，不回显宿主绝对路径。
- Python / ffmpeg 的路径探测只认：环境变量 `DSH_CAPTURE_PYTHON` / `DSH_CAPTURE_FFMPEG` → `<DSH_HOME>\python\*`
  → 常见安装位置 → `PATH`，并且**逐个做能力探测**（`import PIL`、`-encoders` 里有 libvpx）。**不接受页面传路径**。

## 3. 临时文件与清理

- **抓屏**：宿主 `mkdtemp(tmpdir()/dsh-capture-)` 建临时目录 → 图写在那儿 → serve 完**立刻** `rm(dir, { recursive: true, force: true })`
  （`handleShot` 的 finally；客户端另有 `/save` 的兜底落盘，那是产物不是临时件）。
- **录制产物**：直接写 `<DSH_HOME>\dsh-screen-capture\rec-<时间戳>.webm`。
- **子进程完全不写盘**：DSH 的 Windows 沙箱约束的是子进程（写不了 `~/.dsh` 与 `%TEMP%`），所以管道是
  `python --stdout--> ffmpeg --stdout--> 宿主 Node createWriteStream`。详见 [DEV.md](DEV.md) 的「沙箱 / 权限事实」。
- 收尾：关 recorder 的 stdin（EOF 即停）→ 等 ffmpeg 写完后 `out.end()`；超时先 `kill` python、再等、最后 `kill` ffmpeg
  （`handleRecordStop`）——文件流一定会关，不留半开句柄。

## 4. 错误路径

- **先预检再动手**：缺 Python+Pillow 或缺带 libvpx 的 ffmpeg → 直接 500，并把「怎么补」写进错误
  （`pip install Pillow` / 用 `DSH_CAPTURE_FFMPEG` 指一个带 libvpx 的 ffmpeg）；不会先回 ok 再让用户录完才发现没文件。
- 脚本超时（默认 15s，可用 `DSH_CAPTURE_TIMEOUT_MS` 调）→ kill 子进程 + 500。
- 同时只允许一路录制：第二次 `/record/start` 回 **409**（`handleRecordStart` 开头）。
- 抓屏偶发失败**不中断**整段录制（把原因写进 stderr 日志、跳过这一帧）；python / ffmpeg 的退出码都记进日志，
  并在 ffmpeg close 时落 `finished` 标记，`/record/status` 据此回答，不会把陈旧会话报成"还在录"。
- 错误回包都带一句人能看懂的原因；`dir`/`file` 绝不接受路径分隔符。
- 一个诚实的边界（已在 README、Release 说明与条目文案里写明）：录「窗口」录的是**屏幕上那块像素**，
  不是窗口自身画面 —— 别的窗口摞在上面就会录到挡着的那个。宿主机只能抓屏，做不到 `getDisplayMedia` 那种窗口流。

## 5. 自己怎么验

| 命令 | 覆盖 | 本机结果 |
| --- | --- | --- |
| `node tools/check-capture-sources.mjs --windows` | 源枚举 + `--region`/`--hwnd`/`--max-edge` 的帧尺寸（**不需要 DSH 在跑**） | 8/8 |
| `node tools/check-live-record.mjs` | 需要 DSH 在跑：直接打上述路由跑真录制，抽帧校验尺寸、并核对「抓屏像素 == `/sources` 的 virtual」 | 9/9 |
| `node tools/e2e-annotate.mjs` / `node tools/e2e-record-picker.mjs` | 真机 UI 端到端（CDP 合成事件，不碰物理鼠标） | 13/13、8/8 |
| `node tools/build-client.mjs --check` + `node tools/check-bundle.mjs` | 客户端 bundle 与源一致、安装前自检 | ok |
