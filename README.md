# dsh-screen-capture-record-desktop

> 给 DSH 桌面版（Desktop）输入框工具条加两个按钮：在「听写 / 开始录音」**左边**插入「录屏」和「截图」。

## 为什么做这个

人和模型沟通时，最贵的一步往往不是模型不够聪明，而是我们**描述不准**：按钮错位了、动效不对、点完某个开关界面变成了另一副样子……打字描述要花几分钟，还常常漏掉决定性细节，来回几轮才说清一件事。

这个插件就是把这一步压缩成两个动作 —— **录一段、截一张，直接塞进输入框**：

- 录屏产出**一个 `.webm` 视频**（不是一堆图片），抽不抽帧、抽多密由会话里的 agent 按需决定；
- 截图带**选区**，框哪算哪；框完手一松就能直接用**画笔 / 矩形 / 箭头 / 文字**在图上圈重点，画完点一次「用这张」进附件；
- 两者都走 DSH 现成的附件通道，在输入框里补一句话就能发出去。

模型拿到的是**第一手画面**，而不是一段转述。少一轮误解，就少一次返工 —— 这是它唯一的设计目标。

**Quick start (English).** A DSH Desktop plugin that adds two buttons to the left of the dictation button in the composer toolbar. **Record**: click, pick what to record (whole desktop / a monitor / a window / a custom region), click again (or press `Esc`) to stop — the host process captures frames and encodes them into a single `.webm` video that is attached to your message. **Screenshot**: capture the full screen, drag a region in the picker — the annotation toolbar (pen / rectangle / arrow / text) appears the moment you release the drag, so you can mark the picture up right away and commit it with a single 「用这张」. It exists to make human-agent communication cheaper: instead of describing a UI problem in words, hand the model the actual picture. Requires Windows with PowerShell 5.1+, Python 3 with Pillow, and an ffmpeg build that includes the `image2pipe` demuxer, the `mjpeg` decoder, the `libvpx_vp8` encoder and the `webm` muxer — see [前置条件](#前置条件). Install with `dsh plugin add dsh-screen-capture-record-desktop`, then fully restart DSH.

## 两个按钮

| 按钮 | 图标 | 操作 | 产物 |
| --- | --- | --- | --- |
| **录屏** | 显示器 + 录制圆点 | 点一下弹「选择要录制的内容」（整个桌面 / 某个显示器 / 某个窗口 / 自定义区域）；开始后按钮右上角出现红色计时徽标；再点一下结束；录制中按 `Esc` 也可结束；到达最长时长会自动结束 | 一个 `.webm` 视频（VP8），自动塞进输入框附件 |
| **截图** | 相机 | 点一下抓整屏 → 弹出浮层 → 拖框选（**松手就能画**）→「用这张」进附件 | 一张 JPEG（可带标注），自动塞进输入框附件 |

两个按钮的悬浮提示常态只有两个字（「录屏」/「截图」），录制中显示「停止录屏」；只有宿主路由没挂上时才补一句原因。

### 录屏：先选「录哪一个」

点「录屏」先弹一个框（不是直接开录）：

| 选项 | 录什么 |
| --- | --- |
| 整个桌面（所有显示器） | 整个虚拟桌面（多显示器一起），也就是老行为 |
| 显示器 N | 只录那一台显示器 |
| 窗口 | 只录那一个窗口；**跟着窗口走** —— 录制中窗口被拖动 / 改大小都跟着 |
| 自定义区域… | 回到拖框浮层，拖哪录哪（`Enter` /「用这张」确认） |

- 每一项都带**缩略图**（用一张整屏底图按各源矩形裁出来的小图），窗口多的时候好认。
- **上次选的那个会预选上**并自动滚进视野，第二次录同一个东西就是两次点击。
- 选中即开录，`Esc` /「取消」什么都不做；下方提示条会写明正在录的是哪一个。
- 不想每次弹框：DevTools 里 `localStorage['dsh-capture.askSource'] = '0'`（直接用上次选的）。

> ⚠ 录窗口录的是**屏幕上那块像素**：别的窗口摞在它上面就会录到摞上去的那个
> （宿主机只能抓屏，做不到浏览器 `getDisplayMedia` 那种窗口流）。所以录窗口时别把别的窗口盖上去。

### 录屏中直接点「发送」或按回车

不用先停下来：**点「发送」（或在输入框里按回车）就等于「停录 + 把视频挂进附件 + 发送」**。
点下去会看到一句「正在结束录屏并把视频挂进附件，随后自动发送…」，然后这条消息带着 `.webm` 一起发出去。

- 两条发送路径都接管：**点发送按钮**与**按回车**（`Shift/Alt+Enter` 是换行，输入法组字中的回车也不会被抢）。
- 万一视频没能挂进附件，这次发送会被**取消**（不会发出一条没有视频的消息），并把磁盘路径告诉你。
- 生成中那个按钮仍然是「停止生成」，点它只会打断 agent，不会触发这套流程。
- 想关掉这个联动：DevTools 里 `localStorage['dsh-screen-capture.sendStopsRec'] = '0'`。
- 录屏中按 `Esc`（或再点一次「录屏」）就是单纯停止录屏，视频照常进附件。

### 截图：选区 + 标注是**同一个浮层**

点「截图」后是一层搞定，中间不需要再确认一次：

```
整屏铺开（92%×80% 缩放展示）
      │
      ├─ 拖框选 ──→ 手一松，底部工具栏立刻出现（画笔默认选中）──→ 直接在图上画
      │                                                        │
      │                                                        └─ 画完点「用这张」→ 裁切 + 合成标注 → 进附件
      │
      ├─ 单击不拖 ─→ 选中整屏（留在选区态，按 Enter /「用这张」再用）
      └─ Esc / 右键 / 点遮罩空白 ─→ 取消
```

| 场景 | 按键 / 操作 | 含义 |
| --- | --- | --- |
| 浮层（选区态） | 按住左键拖动 | 框选一块区域，**松手即进入标注态** |
| 浮层（选区态） | 单击（不拖动） | 选中**整屏** |
| 浮层（选区态） | `Enter` 或「用这张」 | 用当前选区，进入标注态（关了标注则直接出图） |
| 浮层（标注态） | 工具栏 | 画笔 / 矩形 / 箭头 / 文字、撤销 / 清空、7 种颜色、细中粗三档线宽 |
| 浮层（标注态） | `Ctrl+Z` | 撤销上一笔 |
| 浮层（标注态） | 「重选区域」 | 回到选区态重新框（已画的笔画留着，按新框重新裁剪） |
| 浮层 | `Enter` 或「用这张」 | 确认并进附件 |
| 浮层 | `Esc`、右键、点遮罩空白处、或「取消」 | 取消截图 |

画的笔画**只在选区内生效**（画笔不会污染框外），合成时按原始像素重算，所以标注不会因为展示缩放而变糊。整个浮层用 DSH 自己的 design token 上色，浅色 / 深色主题都跟随系统。

选区态按 92% × 80% 的视口比例缩放展示整屏底图，框选后再按原始分辨率裁切。

## 安装

**从 registry 安装（推荐）**

```bash
dsh plugin add dsh-screen-capture-record-desktop
```

装完**必须完整重启 DSH**（宿主侧的抓屏 / 录屏路由在进程启动时挂载，只刷新界面不会生效）。

**本地开发 / 免发布安装**

```bash
dsh plugin --profile desktop add link:<插件目录绝对路径>
```

`link:` 是给本地开发用的：直接把包目录链进 profile，改完 `lib/` 立即被加载，不必先发布到 registry。同样需要完整重启 DSH。

> ⚠ 同一个插件不要在两层同时挂载。已经用上面的方式安装后，就**不要**再手工往 profile 的 `cordis.patch.yml` 里写同 id 的 `insert` 行 —— 两层挂同一个 id 会导致重复挂载。启停、卸载请在 DSH 的「插件」页里做。

本插件是一个**组合包（bundle）**：`package.json` 声明了 `dsh.bundle.patch`，由 `cordis.patch.yml` 把自己那一行插进 profile 的插件名单；浏览器半边由 `package.json` 的 `dsh.client` 声明加载。

## 前置条件

这是本插件最大的使用门槛：**截图只需要 Windows + PowerShell；录屏还需要 Python 和 ffmpeg。**

| 能力 | 要求 | 说明 |
| --- | --- | --- |
| 运行平台 | Windows | 宿主侧用 PowerShell + GDI 抓屏，目前只支持 Windows |
| 抓屏 | PowerShell 5.1 及以上 | Windows 自带的 `powershell.exe` 即可，也可以指向 `pwsh.exe` |
| 录屏 | Python 3 + **Pillow** | 抓帧用 Pillow 的 `ImageGrab`；缺 Pillow 时录屏起不来。安装：`pip install Pillow` |
| 录屏 | **ffmpeg**（必须是带这些组件构建的） | 见下方清单 |

录屏用的 ffmpeg 必须编译进了这几段：

| 组件 | 用途 |
| --- | --- |
| `image2pipe`（demuxer） | 从管道读连续的 MJPEG 帧 |
| `mjpeg`（decoder） | 解码每一帧 |
| `libvpx_vp8`（encoder） | 编码成 VP8 |
| `webm`（muxer） | 封装成 `.webm` |

Playwright 自带的那份精简 ffmpeg 就够用（它恰好开了这一段），不必单独装系统版 ffmpeg。可以这样自查：

```powershell
ffmpeg -hide_banner -demuxers | findstr /i image2pipe
ffmpeg -hide_banner -decoders | findstr /i mjpeg
ffmpeg -hide_banner -encoders | findstr /i libvpx
ffmpeg -hide_banner -muxers  | findstr /i webm
```

四条都出现在输出里，才说明这份 ffmpeg 能用于录屏。

### 怎么把路径指给插件

宿主进程启动时读这几个环境变量：

| 环境变量 | 指向 | 不设置时的查找顺序 |
| --- | --- | --- |
| `DSH_CAPTURE_PYTHON` | 带 Pillow 的 `python.exe` | 插件所在工作区里的虚拟环境 / 自带 CPython → 系统 `PATH` 上的 `python.exe` |
| `DSH_CAPTURE_FFMPEG` | 上面那份 `ffmpeg.exe` | 工作区或 `%LOCALAPPDATA%` 下的 `ms-playwright\ffmpeg-*` → 系统 `PATH` 上的 `ffmpeg.exe` |
| `DSH_CAPTURE_POWERSHELL` | 抓屏用的 PowerShell | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` → `PATH` 上的 `powershell.exe` |

设置之后要**完整重启 DSH**（这些变量在宿主进程启动时读取）。截图不依赖 Python / ffmpeg，所以缺了它们按钮仍然可用，只是录屏会报错。

## 配置

### 客户端（localStorage）

在 DevTools 控制台改，**下一次操作立即生效**，不需要重启：

```js
localStorage['dsh-capture.fps']          = '5'
localStorage['dsh-capture.picker']       = '1'
localStorage['dsh-capture.annotate']     = '1'
localStorage['dsh-capture.askSource']    = '1'
localStorage['dsh-capture.maxDimension'] = '1280'
localStorage['dsh-capture.quality']      = '0.72'
localStorage['dsh-capture.maxSeconds']   = '180'
```

| 键 | 默认值 | 取值范围 | 含义 |
| --- | --- | --- | --- |
| `dsh-capture.fps` | `5` | `1` – `15` | 录屏帧率 |
| `dsh-capture.maxDimension` | `1280` | `640` – `2560` | 录屏单帧长边上限（像素） |
| `dsh-capture.quality` | `0.72` | `0.3` – `0.95` | 帧 / 截图的 JPEG 质量 |
| `dsh-capture.picker` | `1`（开） | `0` / `false` 关闭，其余视为开 | 截图是否弹出选区浮层；`0` = 直接抓整屏进附件 |
| `dsh-capture.annotate` | `1`（开） | `0` / `false` 关闭，其余视为开 | 选区里是否带标注工具栏（画笔/矩形/箭头/文字）；`0` = 拖框后必须点「用这张」确认，不出工具栏 |
| `dsh-capture.askSource` | `1`（开） | `0` / `false` 关闭，其余视为开 | 录屏前是否弹「选择要录制的内容」框；`0` = 直接用上次选的那个源开录（没记录过就是整个桌面） |
| `dsh-capture.maxSeconds` | `180` | `5` – `900` | 录屏最长秒数，到点自动结束 |

参数越界会被夹到合法范围或退回默认值，不会报错。截图时客户端会自动把质量抬高 `0.1`（上限 `0.92`），并用不小于 `1920` 的长边上限裁剪，保证框选出来的图够清晰。

### 宿主侧（环境变量）

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `DSH_CAPTURE_PYTHON` | 自动探测 | 录屏抓帧用的 Python |
| `DSH_CAPTURE_FFMPEG` | 自动探测 | 录屏编码用的 ffmpeg |
| `DSH_CAPTURE_POWERSHELL` | 系统 Windows PowerShell | 截图抓屏用的 PowerShell |
| `DSH_CAPTURE_DIR` | `<DSH_HOME>\dsh-screen-capture` | 截图 / 录像的落盘根目录 |
| `DSH_CAPTURE_TIMEOUT_MS` | `15000` | 单次抓屏超时（毫秒） |
| `DSH_HOME` | `%USERPROFILE%\.dsh` | DSH 家目录，决定默认落盘位置 |

宿主侧变量改完必须完整重启 DSH。

## 产物落盘位置

默认落在 `<DSH_HOME>\dsh-screen-capture`（`DSH_HOME` 默认 `%USERPROFILE%\.dsh`），可用 `DSH_CAPTURE_DIR` 覆盖。时间戳格式为 `YYYYMMDD-HHMMSS`。

| 产物 | 路径 |
| --- | --- |
| 截图 | `<DSH_HOME>\dsh-screen-capture\shot-<时间戳>\shot-<时间戳>.jpg` |
| 录像 | `<DSH_HOME>\dsh-screen-capture\rec-<时间戳>.webm` |

截图会**先落盘、再进附件**，所以即使附件入口出问题，磁盘上也一定有文件（提示条会给出目录，并自动把路径复制到剪贴板）。录像同样是宿主直接写盘，附件里那份是从磁盘原样取回的。

## 故障排查

先看宿主日志，前缀是 `[dsh-screen-capture]`。

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 点「录屏」提示「起录屏失败」，日志说找不到 python | 没装 Python 3，或解释器里没有 Pillow | `python -c "import PIL"` 自查；`pip install Pillow`；或用 `DSH_CAPTURE_PYTHON` 指向带 Pillow 的解释器 |
| 录屏能开始，结束时提示「没录到内容（ffmpeg 没写出文件）」 | 这份 ffmpeg 缺 `libvpx_vp8` 或 `webm` | 用「前置条件」里的四条自查命令确认；换一份带这些组件的 ffmpeg，用 `DSH_CAPTURE_FFMPEG` 指过去 |
| 录屏一开始就报 `Error opening input: Protocol not found` | 该 ffmpeg 不认 `-i -` | 插件已统一用 `-i pipe:0`；仍报这个说明 ffmpeg 版本过老或构建异常，换一份 |
| 附件里有图 / 有视频，但没看到提示条 | 自绘提示条被更高层级的浮层盖住，或没渲染出来 | 以附件卡片和磁盘文件为准；在 DevTools 里查 `[data-dsh-capture-toast]` 是否在 DOM 中及其层级 |
| 提示条显示「宿主路由没挂上（…）：完整重启桌面版后再生效」 | 宿主进程没加载到新路由：装完或更新后没完整重启，或插件未启用 | 完整重启 DSH；在「插件」页确认插件已启用、没有被回滚 |
| 点「截图」直接就是整屏，没有框选 | `dsh-capture.picker` 被设成了 `0`；或在浮层里只是单击（单击 = 整屏，设计如此）；或框得太小（小于 4px 会回退成整屏） | 把 `dsh-capture.picker` 设回 `1`，用拖动框选 |
| 框完松手没有出现画笔工具栏 | `dsh-capture.annotate` 被设成了 `0`（那时是「拖框 + 用这张」的老行为，设计如此） | 把 `dsh-capture.annotate` 删掉或设回 `1` |
| 点「录屏」没弹选择框，直接就开始录了 | `dsh-capture.askSource` 被设成了 `0`，或宿主还没挂上 `/sources` 路由（装完没完整重启） | 设回 `1`；完整重启 DSH（按钮会先提示一句"这次按整个桌面录"） |
| 选择框里没有我要的窗口 | 窗口不可见 / 已最小化 / 面积小于 120×80 / 被 DWM 标记为 cloaked（UWP 幽灵窗）都不会列出来 | 先把窗口恢复到桌面再看；或选「自定义区域…」手动框 |
| 录窗口时录到了别的窗口 | 录的是屏幕上那块像素，被摞在上面了 | 把要录的窗口切到前面；或改录「自定义区域」 |
| 画到选区外面的笔画看不见了 | 标注只在选区内生效（所见即所得，不会偷偷进图） | 想要更大范围就点「重选区域」把框拉大再画 |
| 截图黑屏 / 有黑边 / 内容错位 | 多显示器：抓的是整个虚拟桌面的联合矩形，显示器排列带负坐标或各自缩放不同时会留下黑边；DPI：抓屏进程若没声明 DPI 感知会得到缩放模糊图 | 确认显示器的虚拟桌面矩形；`DSH_CAPTURE_POWERSHELL` 指向真正的 `powershell.exe`（插件会主动声明 DPI 感知） |
| 录出来的画面没有鼠标指针 | 光标当时不在虚拟桌面范围内 | 默认会把光标画进每一帧；把鼠标移回捕获范围即可 |
| 视频录好了，但提示「取回失败」 | 浏览器那一侧没拿到视频字节 | 视频仍在磁盘上（提示里带完整路径），可以直接拖进输入框 |
| 工具条上根本没出现这两个按钮 | 找不到「听写」按钮这个锚点（宿主界面或语言变化），或插件未启用 | 看按钮悬浮提示和控制台里的 `[dsh-capture]` 日志；完整重启 DSH |
| 录像太大 / 太长 | 帧率、分辨率或时长上限偏高 | 调低 `dsh-capture.fps`、`dsh-capture.maxDimension`、`dsh-capture.maxSeconds` |

## 实现方式（一句话）

桌面壳在浏览器侧禁用了屏幕共享，所以抓屏 / 录屏全部放在**宿主进程**做，浏览器半边只负责按钮、选区浮层、把产物塞进附件。宿主侧的录制管道是「Python 抓帧 → MJPEG → ffmpeg → 单个 `.webm`」，产物是完整视频而不是一堆抽好的图片（要不要抽帧、抽多密，由使用方按需决定）。

## 欢迎官方收录

这个插件刻意只站在**官方公开接口**上实现：组合包用 `package.json` 的 `dsh.bundle.patch` 声明，浏览器半边用 `dsh.client` 挂载，宿主侧只用 `ctx.inject(['webServer'])` 注册路由 —— **不改 DSH 源码、不碰私有 API、不引入第三方运行时**。按钮尺寸、圆角、图标规范、悬浮提示、轻提示、选区卡片也都逐项对齐了官方组件（实测数据见 [DEV.md](DEV.md)），目的就是让它看起来、用起来都像内置功能。

如果官方认为「把说不清的界面问题直接发给模型」这件事该由桌面版本体来做，**欢迎直接收录、合并，或以任何方式复用这里的实现** —— 本仓库是 MIT，随你处置。需要配合改造、补测试或写设计说明，在本仓库开 Issue 即可，作者会跟到底。

## License

MIT。以 `package.json` 的 `license` 字段和仓库根目录的 `LICENSE` 文件为准。
