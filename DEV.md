# dsh-screen-capture-record-desktop — 开发者笔记

面向要改这个插件的开发者。用户向的使用说明在 [`README.md`](./README.md)。

## 仓库结构

```
lib/index.js          宿主半边：5 条 HTTP 路由（抓屏 / 落盘 / 开录 / 停录 / 取录像）
lib/shot.ps1          单帧抓屏（GDI，纯 ASCII）
lib/recorder.py       录屏抓帧（Pillow ImageGrab → MJPEG 流）
lib/client.body.js    浏览器半边 —— 可读源码，改这个
lib/client.js         由 build-client.mjs 生成，不要直接改
cordis.patch.yml      组合包 patch：把本包那一行插进 profile 名单
package.json          声明 dsh.bundle.patch 与 dsh.client
tools/build-client.mjs  client.body.js → client.js（--check 校验一致）
tools/selftest.mjs      假 DOM 里跑 client.body.js，抓「加载就炸」
tools/smoke.mjs         冒烟：抓屏 / 落盘 / 真录一段并校验 WebM / 路由接线
tools/check-bundle.mjs  安装前自检：复刻插件管理器的 inspect 判据
tools/check-patch.mjs   手工挂载路线：校验 profile 的 cordis.patch.yml
```

## 架构与数据流

### 为什么抓屏必须在宿主进程

桌面版 Electron 主进程在 `configureSession()` 里写死了：

```js
setPermissionRequestHandler((_c, _p, cb) => cb(false));   // 一切权限 → 拒绝
setPermissionCheckHandler(() => false);
setDevicePermissionHandler(() => false);
setDisplayMediaRequestHandler((_r, cb) => cb({}));        // 屏幕共享 → 回空对象
```

所以 `navigator.mediaDevices.getDisplayMedia()` 在桌面壳里永远拿不到流（promise 以 `NotAllowedError` 拒绝）。**不要改 app.asar**：升级即被覆盖，而且那是桌面版自己的加固策略。抓屏、录屏一律放宿主进程。

### 路由

| 方法 | 路径（`<name>` = 包名） | 作用 |
| --- | --- | --- |
| `GET` | `/plugins/<name>/shot?probe=1` | 探活，返回 `{ok,capable,script}`，不抓屏 |
| `GET` | `/plugins/<name>/shot?format=jpg\|png&maxEdge=&quality=` | 宿主跑 `shot.ps1` 抓整屏，直接回图片字节 |
| `POST` | `/plugins/<name>/save?dir=&file=` | 把请求体字节落盘到 `<DSH_HOME>\dsh-screen-capture\<dir>\<file>` |
| `POST` | `/plugins/<name>/record/start?fps=&maxEdge=&quality=&seconds=` | 起 `recorder.py` → ffmpeg（VP8/WebM）管道 |
| `POST` | `/plugins/<name>/record/stop` | 关抓屏管 → 等 ffmpeg 收尾 → 报产物 |
| `GET` | `/plugins/<name>/record/file` | 把录好的 `.webm` 交给浏览器（进附件） |

路由注册走 `ctx.inject(['webServer'], …)` + `ctx.effect()`（HMR 卸载时可以撤掉），另有 `mountRoutes(ctx.webServer)` 兜底；`mounted` 标记保证只挂一次（webServer 对重复路由会抛错）。`apply` 全程 try/catch：这个插件坏了也不该影响宿主启动。

客户端挂载时先 `probe`：宿主没重启（新路由未挂载）时，按钮的悬浮提示会明确说「宿主路由没挂上（…），需完整重启桌面版」，而不是点了没反应。

### 客户端按钮

两个按钮都是 DOM 直插，不是槽位注册。原因：工具条上的「听写」来自内置语音输入包，注册在 `conversation.input.activity` —— 那是一个 `kind: "single"` 槽位，已经被它占了，第二个注册会被拒绝；而我们要的位置（听写左边、与模型选择器之间）没有可声明的槽位。所以用 `MutationObserver` 直插 DOM。

```
apply(ctx)
  └─ teardownPrevious()                    HMR 重载时先撤上一代
  └─ observe()                             MutationObserver + 3 秒兜底心跳
  └─ ensureButtons()                       以「听写」按钮为锚点插入 录屏 | 截图 | 听写
        ├─ insertionPoint()                一路剥掉「只有一个子元素」的包装层
        └─ reassertHost()                  每轮重申样式（已经对了就不动）
```

`insertionPoint()` 必须循环剥包装层：听写按钮的结构是 `<Tooltip><span class="triggerAnchor"><Button/></span></Tooltip>`，插进那层 `span` 里的话，hover 命中的是外层 anchor —— 鼠标停在我们按钮上弹出来的却是「听写」。

### 截图数据流

```
点击截图
  └─ hostShot({maxEdge, quality})           GET /shot，拿整屏 → ImageBitmap
        └─ pickRegion(bitmap)               自绘浮层：拖动框选 / 单击=整屏 / Enter / Esc
              └─ cropToJpeg()               canvas 按原始分辨率裁切 → JPEG Blob
                    ├─ saveFramesToHost()   POST /save，先落盘保证有文件
                    └─ pushToComposer()     造 DataTransfer → 附件入口派发 change
```

### 录屏数据流

```
点击录屏
  └─ POST /record/start
        spawn recorder.py --fps … --max-edge … --quality … --seconds …
              │ stdout: MJPEG 帧流
              ▼
        spawn ffmpeg -f image2pipe -c:v mjpeg -framerate N -i pipe:0
                     -c:v libvpx -b:v 1M -deadline realtime -cpu-used 8
                     -pix_fmt yuv420p -f webm pipe:1
              │ stdout: webm 字节
              ▼
        宿主 Node createWriteStream  →  <DSH_HOME>\dsh-screen-capture\rec-<ts>.webm

点击结束（再点按钮 / Esc / 到时长上限）
  └─ POST /record/stop
        recorder.py 的 stdin EOF → 停止抓帧
        → ffmpeg 收到管道结束 → 写完 webm 尾部 → close
        → 宿主关文件流、stat 字节数 → 回 {ok,file,bytes,seconds,fps,log}
  └─ GET /record/file → Blob → File → pushToComposer()
```

`recorder.py` 的停止条件有四条：父进程关闭 stdin、往 stdin 写任意一行、到达 `--seconds`、输出文件旁出现 `<out>.stop`。生产路径只用第一条。

## 关键限制与坑

### 1. `style.cssText` 只认 kebab-case

写成 `borderRadius:` / `placeItems:` 这种 camelCase，浏览器**静默丢弃**这几条声明（不报错）。症状是按钮变成「图标贴在左上角的方块」：圆角没了、居中也没了，跟同排官方按钮既不同形状也对不到中线。HMR 一轮轮覆盖，肉眼很难看出是哪一步坏的。

### 2. 被沙箱约束的子进程写不了盘

DSH 的 Windows ACL 沙箱约束的是**子进程**：ffmpeg 既写不了 `~/.dsh`（Permission denied），也写不了 `%TEMP%`；而宿主 Node 两个地方都写得了。所以录制时**子进程完全不碰文件**：

```
recorder.py --stdout--> ffmpeg (-i pipe:0 … -f webm pipe:1) --stdout--> Node 写文件
```

实测 ffmpeg `exit 0`，产物魔数 `1a45dfa3`（合法 WebM）。顺带省掉了「先写暂存、再搬移」。

### 3. 精简 ffmpeg 不认 `-i -`

Playwright 那份 `--disable-everything` 构建必须写 `-i pipe:0`，写 `-i -` 会报 `Error opening input: Protocol not found`。另外它只开了 `image2pipe`/`mjpeg`/`libvpx_vp8`/`webm`（filter 只有 `pad`/`crop`/`scale`），**没有 `fps`/`select` 滤镜** —— 所以抽帧不要写 `-vf fps=1`。

### 4. client-hmr 会留下僵尸实例

`dsh-client-hmr` 反复重载插件时，旧实例可能还活着（它自己的 `setInterval` 还在跑），会按旧代码把按钮挪回旧位置 / 旧样式，或者每热更一次就多留一个 `MutationObserver` + 3 秒定时器。对策：

- `teardownPrevious()`：重新 `apply` 时先撤掉上一代（按钮 / observer / 心跳 / 还在跑的录制），再装新的；
- `ensureButtons()` 每轮重申样式与插入位置；
- `reassertHost()` 用 `getComputedStyle` 判断「已经对了就不动」（`display === 'grid' && borderRadius === '4px'`），免得每 3 秒重申时把正在悬停的 hover 底色刷掉。

**不要**再用 `window.__X__` 那种「只装一次」的守卫 —— 在 HMR 下它正好会把新代码挡回去。

### 5. 附件注入只走一条通道

上一版为了兜底，先派发 file input 的 `change`，再观测输入框附近 500ms 的 DOM 变化，没变化就补一次 `paste` —— 结果两条都成功，同一段录像被挂进附件**两次**。观测失灵的原因是附件卡片渲染在输入框**之外**的节点里。现在的做法：只用 input 通道（`DataTransfer` 造 FileList → 派发 `change`），只有拿不到 input 或派发抛错时才退到 `paste`。宁可有明确失败提示，也不要静默重复。

### 6. 先判 state 再判锁

录屏按钮「能开不能关」的根因：旧写法把 `if (recLocked) return` 放在最前面，`startRec` 在录制期间持有 `recLocked`，于是「停止」这一次点击被直接吞掉。现在 `toggleRec()` 先按 `state` 分派（recording → stop），再判锁。

## 按钮几何：照官方「听写」逐像素对齐

同排三个按钮（录屏 / 截图 / 听写）得看着像一家人。做法不是凭感觉调，是把鼠标停到按钮上逐像素量出来：

| 量到的量 | 官方「听写」 | 本插件按钮 |
| --- | --- | --- |
| 尺寸 | **28×28 CSS**（150% 缩放时约 42 设备px） | 28×28 CSS |
| 常态圆角 | `--dsw-radius-xs`（= 4px） | `--dsw-radius-xs`（= 4px） |
| hover 底色 | `--dsh-alias-interactive-bg-hover-solid`（≈ `#F2F3F4`） | 同左 |
| hover 圆角 | 内缩 6 设备px = **4 CSS** | 4px |
| 图标规格 | `viewBox 16×16`、`stroke-width 1`、渲染 18px | 同左 |
| 图标居中 | 正中 | `display:grid + place-items:center` |

要点：

- 尺寸的坑最要命：早先容器 / 按钮被写死成 42px **CSS**，在 150% 缩放下渲染成 63×65，比邻居大 1.5 倍 —— 这才是「看着丑」的主因，不是图标本身。
- 图标按原生规范：`viewBox 16×16`、`fill:none`、`stroke:currentColor`、`stroke-width = 1`（`ICON_REGULAR_STROKE`）、按 `size=18` 渲染，几何内缩半个线宽让 1px 描边落在格内。内置听写麦克风的 `IconMicrophoneOutlineRegular` 就是这套。
- **先量再写**：官方圆角实测是 4px（`--dsw-radius-xs`），既不是 `--dsw-radius-sm`（8px），也不是圆形。
- **同排两个官方按钮形状本来就不同**：「听写」是 4px 圆角方块，「+」是 999px 圆形（还带常驻浅灰底 `--dsw-specific-selector`）。先挑清楚跟谁对齐，再动手。

### 浮层 / 提示条的样式出处

- **Tooltip**：逐条对齐官方 Tooltip 气泡 —— `position fixed`、`z-index 1100`、`padding 3px 7px`、`border-radius: var(--dsw-radius-sm)`、`background: var(--dsw-alias-tooltip-bg)`、`13px/20px`、`display:inline-flex + gap 8px`。定位 gap = 8、离视口边至少 12px、上方放不下就翻到下方。官方听写那颗按钮的 `<Tooltip>` 没给 `delayMs`，也就是默认 **0ms 立即显示**，所以这里也不自己拍一个延迟。
- **Toast**：照官方 Toast 复刻 —— `fixed` / `top:40px` / 居中 / `z-index 1100` / `max-width: min(640px, 100vw - 48px)` / `padding 12px 16px` / `border-radius: var(--dsw-radius-lg)`（16px）/ `background: var(--dsw-alias-toast-bg)` / `14px/22px`。官方那条在**两套主题下都是深底**，所以文字色固定、不跟随主题 —— 这点必须照抄，否则浅色主题下会变成「白底黑字」，一眼就不像。
- **选区浮层**：遮罩用官方 Modal 的 mask 令牌 `--dsw-alias-bg-mask-1`；工具条是官方 Modal 的 `.dialog` 卡片语言（`--dsw-alias-bg-layer-2` + `--dsw-radius-lg` + `--dsw-elevation-prominent`）；两个按钮是官方 Button 的 `sm` 变体（`height 28` / `padding 0 10px` / `--dsw-radius-sm` / `12px/18px`），动作顺序按官方 footer「次要在前、主要在后」。

## 构建与自检

在插件目录下跑：

```powershell
node tools\build-client.mjs            # 重新生成 lib/client.js
node tools\build-client.mjs --check    # 只校验 lib/client.js 与 client.body.js 一致
node tools\selftest.mjs                # 假 DOM 离线自检（apply 不炸 + 按钮顺序）
node tools\smoke.mjs                   # 冒烟：抓屏 / PNG / 落盘 / 真录一段并校验 WebM / 路由接线
node tools\check-bundle.mjs            # 安装前自检：复刻插件管理器 inspect 判据
node tools\check-patch.mjs             # 校验 profile 的 cordis.patch.yml（手工挂载路线）
```

- `build-client.mjs` 的产物是一层 `window.__ModuleLoader__.load({ id, factory })` 外壳：客户端 bundle 必须是这种懒 CJS 表，裸写 `exports.apply = …` 在浏览器里会直接 `ReferenceError`。所以正文放在 `client.body.js`，`client.js` 是生成物。改完正文记得重跑，或者用 `--check` 让 CI 卡住不一致。
- `smoke.mjs` 在文件开头把 `DSH_CAPTURE_DIR` 指到工作区路径 —— 冒烟跑在受限沙箱里，工作区是唯一稳妥的写目标。它不需要 DSH 在跑，也不需要重启。
- `check-bundle.mjs` 复刻插件管理器的判据（`dsh.bundle.patch` 存在且能解析、确实插入了本包那一行、`dsh.client.platform === 'web'`、关键文件齐全）。任一条不满足，GUI 会报「这个包没有声明组合包，无法作为插件安装」并回滚安装。

## 本地开发挂载与热更

**挂载方式**：包声明成组合包（`dsh.bundle.patch`），由 profile 的 `dsh.profile.bundles` 名单决定启停。开发期通常把这个包目录用 junction / symlink 映进 profile 的模块目录，再把包名写进 profile `package.json` 的 `dsh.profile.bundles`，然后**完整重启** DSH。

> ⚠ 装成组合包之后，不要再手工往 `profiles/<profile>/cordis.patch.yml` 写同 id 的 `insert` 行 —— 两层挂同一个 id 会重复挂载。`check-patch.mjs` 就是给手工挂载路线做结构校验的（解析失败会让整个 profile 起不来，代价是整个 GUI）。

**热更的区别**：

| 改动 | 生效方式 |
| --- | --- |
| `lib/client.body.js` + 重新生成 `lib/client.js` | client-hmr 每约 500ms `stat` 轮询客户端 bundle，文件一变就推 SSE `rebuilt` 帧，浏览器侧 `modules.reload(id, rev)` 重新执行；约 1 秒后界面自动换新代码，不用重启 |
| `lib/index.js`（宿主半边） | **不在**热更机制里，必须完整重启 DSH |
| `lib/shot.ps1` / `lib/recorder.py` | 每次操作都重新起进程，脚本内容在启动时读取，改完不用重启宿主 |

## 路由参数与默认值

| 路由 | 参数 | 默认 | 夹取范围 |
| --- | --- | --- | --- |
| `shot` | `format` | `jpg` | `jpg` / `png` |
| `shot` | `maxEdge` | `0`（原生分辨率） | `0` – `4096` |
| `shot` | `quality` | `82` | `1` – `100` |
| `record/start` | `fps` | `5` | `1` – `15` |
| `record/start` | `maxEdge` | `1280` | `0` – `2560` |
| `record/start` | `quality` | `72` | `40` – `95` |
| `record/start` | `seconds` | `300` | `5` – `900`（`REC_MAX_SECONDS`） |
| `save` | `dir` / `file` | `frames` / `frame.jpg` | 只允许 `[A-Za-z0-9._-]`，最多 96 字符，去开头的点 |

客户端把 localStorage 的 `maxDimension` 映射到路由的 `maxEdge`，`quality`（0.3–0.95）乘以 100 传过去。注意客户端允许低到 `0.3`，但宿主路由把 `quality` 夹到 `40–95`，所以极端低质量会被抬到 `40`。

安全约定：`dir` / `file` 绝不接受路径分隔符；`/save` 请求体上限 32 MiB；同时只允许一路录制；`--seconds` 有硬上限；抓屏临时文件写在 `%TEMP%` 并每次抓完立刻删。这些都有 `smoke.mjs` 用例覆盖（含 `..%2F` 路径消毒）。

## 沙箱 / 权限事实

| 主体 | 能写 `~/.dsh` | 能写 `%TEMP%` |
| --- | --- | --- |
| 宿主 Node 进程 | 能 | 能 |
| 被沙箱约束的子进程（ffmpeg / python） | 不能 | 不能 |

由此推出两条设计：录制让子进程写 `stdout`、宿主 Node 落盘；`DSH_CAPTURE_DIR` 允许覆盖落盘根 —— 存在的理由就是自测：冒烟测试跑在受限沙箱里，换成工作区路径就能把整条链路测穿，而生产环境（真正的宿主进程）不受这个限制。

## 参考数据（以 3840×2160 桌面为例，数值随机器变化）

| 场景 | 结果 |
| --- | --- |
| 单帧抓屏 `maxEdge=0` | 3840×2160 JPEG ≈ 430 KB / ≈ 930 ms |
| 单帧抓屏 `maxEdge=1440` | 1440×810 ≈ 70 KB / ≈ 940 ms |
| 录屏 `fps=5 maxEdge=640` 3 秒 | `rec-*.webm` ≈ 32 KB，13 帧 / 2.6 s / 5.00 fps，EBML 合法 |

单帧抓屏慢在 PowerShell 启动（约 900 ms），所以**截图**够用；**录屏**走的是常驻 Python + ffmpeg 管道，不受这个限制。
