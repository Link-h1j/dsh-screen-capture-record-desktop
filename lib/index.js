/**
 * dsh-screen-capture-record-desktop — 宿主侧一半：**屏幕抓取路由**。
 *
 * 为什么必须落在宿主侧
 * --------------------
 * 桌面版（Electron）主进程在 app.asar/lib/main.js 的 configureSession() 里写死了：
 *
 *     browserSession.setPermissionRequestHandler((_c, _p, cb) => cb(false))   // 一切权限→拒绝
 *     browserSession.setPermissionCheckHandler(() => false)
 *     browserSession.setDevicePermissionHandler(() => false)
 *     browserSession.setDisplayMediaRequestHandler((_r, cb) => cb({}))        // 屏幕共享→回空对象
 *
 * 于是 navigator.mediaDevices.getDisplayMedia() 在桌面壳里**永远拿不到流**
 * （promise 以 NotAllowedError 拒绝）。任何浏览器端抓屏都注定失效 —— 这不是
 * 插件 bug，是桌面版的加固策略，也不该去改 app.asar（升级即被覆盖）。
 *
 * 所以抓屏改由宿主进程做：跑 lib/shot.ps1，用 GDI 抓整个虚拟桌面。
 *
 * 路由
 * ----
 *   GET  /plugins/dsh-screen-capture-record-desktop/shot
 *       ?probe=1                 -> {"ok":true,"capable":true,...}（探活，不抓屏）
 *       ?format=jpg|png          -> 图片字节（默认 jpg）
 *       &maxEdge=<0|px>          -> 0 = 原生分辨率（选区取景用）；1440 = 小帧（录屏用）
 *       &quality=<1..100>        -> JPEG 质量，默认 82
 *   POST /plugins/dsh-screen-capture-record-desktop/save
 *       ?dir=<名>&file=<名>      body = 图片字节
 *       -> 落盘到 <DSH_HOME>\dsh-screen-capture\<dir>\<file>，返回 {ok,file,dir,bytes}
 *       （客户端用它兜底：附件入口万一收不下，截图也一定在磁盘上有文件）
 *
 *   POST /plugins/dsh-screen-capture-record-desktop/record/start?fps=&maxEdge=&quality=&seconds=
 *       -> 起 recorder.py（抓屏 → MJPEG）管道进 ffmpeg（VP8/WebM），
 *          返回 {ok,file,fps}。**产出一个真视频文件**，不是一堆图片。
 *   POST /plugins/dsh-screen-capture-record-desktop/record/stop
 *       -> 关掉抓屏管，等 ffmpeg 收尾，返回 {ok,file,bytes,seconds}
 *   GET  /plugins/dsh-screen-capture-record-desktop/record/file
 *       -> 把录好的 .webm 交给浏览器（用于塞进附件）
 *
 * 抽帧不在这里做：视频是完整证据，抽帧交给 Agent 侧
 * （tools/screen-watch/watch_video.py，opencv 解 VP8）—— 少一帧还能重抽，
 * 密度也能按问题现场调。浏览器只管把整段视频放进附件。
 *
 * 客户端先 probe：宿主还没重启（新路由未挂载）时按钮会显示成不可用并说明原因。
 *
 * 安全约定
 * -------
 *   - 只用 Node 内置模块，不和 DSH 内部实现耦合；
 *   - 抓屏的临时文件写在 %TEMP%，每次抓完立刻删；只有 /save 与录制会按请求落盘；
 *   - dir/file 只允许 [A-Za-z0-9._-]，不接受路径分隔符；
 *   - 同时只允许一路录制，且强制 --seconds 上限；
 *   - apply 全程 try/catch：这个插件坏了也不该影响宿主启动。
 *
 * 可选环境变量：
 *   DSH_CAPTURE_POWERSHELL   powershell.exe / pwsh.exe 路径
 *   DSH_CAPTURE_TIMEOUT_MS   单次抓屏超时，默认 15000
 *   DSH_CAPTURE_PYTHON       带 Pillow 的 python.exe（录屏用）
 *   DSH_CAPTURE_FFMPEG       ffmpeg.exe（需 image2pipe+mjpeg+libvpx+webm）
 */

import { spawn, spawnSync } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/plugins/dsh-screen-capture-record-desktop/shot'
const SAVE_ROUTE = '/plugins/dsh-screen-capture-record-desktop/save'
const REC_START = '/plugins/dsh-screen-capture-record-desktop/record/start'
const REC_STOP = '/plugins/dsh-screen-capture-record-desktop/record/stop'
const REC_FILE = '/plugins/dsh-screen-capture-record-desktop/record/file'
const REC_STATUS = '/plugins/dsh-screen-capture-record-desktop/record/status'
const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.dirname(LIB_DIR)
const SHOT_SCRIPT = path.join(LIB_DIR, 'shot.ps1')
const RECORDER_PY = path.join(LIB_DIR, 'recorder.py')
const TIMEOUT_MS = Number(process.env.DSH_CAPTURE_TIMEOUT_MS) || 15000
const SAVE_LIMIT_BYTES = 32 * 1024 * 1024
const REC_MAX_SECONDS = 900

/** cordis 插件名（loader 日志里显示这个）。 */
export const name = 'dsh-screen-capture-record-desktop'

/** 需要宿主的 webServer 服务来挂路由。 */
export const inject = ['webServer']

function log(...args) {
  try {
    console.log('[dsh-screen-capture]', ...args)
  } catch (e) {
    /* 日志失败不影响主流程 */
  }
}

function pickPowerShell() {
  if (process.env.DSH_CAPTURE_POWERSHELL) return process.env.DSH_CAPTURE_POWERSHELL
  const win = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : null
  if (win && existsSync(win)) return win
  return 'powershell.exe'
}

function sendJson(res, status, payload) {
  try {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch (e) {
    try {
      res.end()
    } catch (e2) {
      /* 已经断开就算了 */
    }
  }
}

/** 跑一次 shot.ps1；返回 { bytes, stdout }。 */
function runShot(outPath, { format, maxEdge, quality }) {
  return new Promise((resolve, reject) => {
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SHOT_SCRIPT, '-OutPath', outPath]
    if (format) args.push('-Format', format)
    if (maxEdge > 0) args.push('-MaxEdge', String(maxEdge))
    if (quality > 0) args.push('-Quality', String(quality))

    let ps
    try {
      ps = spawn(pickPowerShell(), args, { windowsHide: true })
    } catch (e) {
      reject(e)
      return
    }

    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { ps.kill() } catch (e) { /* 忽略 */ }
      reject(new Error('抓屏超时（' + TIMEOUT_MS + 'ms）'))
    }, TIMEOUT_MS)

    try {
      ps.stdout.setEncoding('utf8')
      ps.stdout.on('data', (c) => { out += c })
      ps.stderr.setEncoding('utf8')
      ps.stderr.on('data', (c) => {
        err += c
        if (err.length > 4000) err = err.slice(-4000)
      })
    } catch (e) {
      /* 拿不到输出也能靠退出码判断 */
    }

    ps.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve({ stdout: out })
      else reject(new Error((err || '').trim() || '抓屏脚本退出码 ' + code))
    })
    ps.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
  })
}

/**
 * 抓屏路由处理函数。导出以便 tools/smoke.mjs 用假的 req/res 直接测。
 */
export async function handleShot(req, res) {
  let url = null
  try {
    url = new URL(req.url ?? ROUTE, 'http://localhost')
  } catch (e) {
    /* 用默认参数 */
  }

  const wantPng = url && url.searchParams.get('format') === 'png'
  const ext = wantPng ? 'png' : 'jpg'
  const mime = wantPng ? 'image/png' : 'image/jpeg'
  const rawMaxEdge = Number(url && url.searchParams.get('maxEdge'))
  const maxEdge = Number.isFinite(rawMaxEdge) && rawMaxEdge > 0 ? Math.min(4096, Math.round(rawMaxEdge)) : 0
  const rawQuality = Number(url && url.searchParams.get('quality'))
  const quality = Number.isFinite(rawQuality) && rawQuality > 0 ? Math.min(100, Math.round(rawQuality)) : 82

  // 探活：客户端用它判断宿主是否已经挂上新路由。
  if (url && url.searchParams.get('probe')) {
    sendJson(res, 200, { ok: true, capable: true, script: basenameOf(SHOT_SCRIPT) })
    return
  }

  if (!existsSync(SHOT_SCRIPT)) {
    sendJson(res, 500, { ok: false, error: '抓屏脚本不存在: ' + SHOT_SCRIPT })
    return
  }

  let dir = null
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'dsh-capture-'))
    const file = path.join(dir, 'screen.' + ext)
    await runShot(file, { format: ext, maxEdge, quality })
    const buf = await readFile(file)
    if (!buf.length) throw new Error('抓到的图是空的')
    res.writeHead(200, {
      'content-type': mime,
      'content-length': buf.length,
      'cache-control': 'no-store'
    })
    res.end(buf)
  } catch (e) {
    log('抓屏失败:', (e && e.message) || e)
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  } finally {
    if (dir) rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** DSH 家目录：优先环境变量，退回 ~/.dsh。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

/**
 * 截图/录像的落盘根目录。
 *
 * 默认 <DSH_HOME>\dsh-screen-capture；可用 DSH_CAPTURE_DIR 覆盖 —— 存在的理由是
 * 自测：冒烟测试跑在受限沙箱里，被沙箱约束的子进程（ffmpeg）写不了 ~/.dsh，
 * 换成工作区路径就能把整条链路测穿。生产环境（DSH 宿主进程）不受这个限制。
 */
function captureDir() {
  const override = process.env.DSH_CAPTURE_DIR
  if (override) return path.resolve(override)
  return path.join(dshHome(), 'dsh-screen-capture')
}

/**
 * 录制输出：**ffmpeg 写 stdout，宿主 Node 落盘**。
 *
 * ⚠ 为什么不给 ffmpeg 输出路径（2026-10-01 在活宿主上实测）：
 *   DSH 的 Windows ACL 沙箱约束的是**子进程**。ffmpeg 既写不了 ~/.dsh
 *   （Permission denied），也写不了 %TEMP%（同样 Permission denied）；
 *   而宿主 Node 两个地方都写得了（截图落盘一路正常）。
 *   所以干脆让子进程完全不碰文件：
 *       recorder.py --stdout--> ffmpeg (-i pipe:0 … -f webm pipe:1) --stdout--> Node 写文件
 *   实测：ffmpeg exit 0，产出文件魔数 1a45dfa3（合法 WebM）。
 *   顺带省掉了"先写暂存、再搬移"那一步。
 */

/** 只留 [A-Za-z0-9._-]，并去掉开头的点：绝不接受路径分隔符。 */
function safeName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 96)
  return cleaned || fallback
}

/** 收请求体，超过上限就断开。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        try { req.destroy() } catch (e) { /* 忽略 */ }
        reject(new Error('数据超过 ' + Math.round(limit / 1048576) + ' MiB 上限'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * 落盘路由：把客户端手里的帧/截图写到
 *   <DSH_HOME>\dsh-screen-capture\<dir>\<file>
 *
 * 为什么要有它：附件注入是 DOM 层的技巧（造一个 DataTransfer 派发 change），
 * 万一宿主 composer 改版收不下，用户就"什么都拿不到"。这条路由保证**一定有文件**。
 * 导出以便 tools/smoke.mjs 直接测。
 */
export async function handleSave(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只接受 POST' })
    return
  }

  let url = null
  try {
    url = new URL(req.url ?? SAVE_ROUTE, 'http://localhost')
  } catch (e) {
    /* 用默认名 */
  }
  const dirName = safeName(url && url.searchParams.get('dir'), 'frames')
  const fileName = safeName(url && url.searchParams.get('file'), 'frame.jpg')

  let body = null
  try {
    body = await readBody(req, SAVE_LIMIT_BYTES)
  } catch (e) {
    sendJson(res, 413, { ok: false, error: String((e && e.message) || e) })
    return
  }
  if (!body || !body.length) {
    sendJson(res, 400, { ok: false, error: '没有收到数据' })
    return
  }

  try {
    const dir = path.join(captureDir(), dirName)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, fileName)
    await writeFile(file, body)
    sendJson(res, 200, { ok: true, file: file, dir: dir, bytes: body.length })
  } catch (e) {
    log('落盘失败:', (e && e.message) || e)
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

// ------------------------------------------------------------------- 录屏

/**
 * 当前录制会话（同时只允许一路）。
 *
 * 为什么在宿主录：桌面壳禁用 getDisplayMedia（见文件头），浏览器拿不到流；
 * 而"录屏"的产物应该是**一个视频文件**，不是一堆抽好的图片 —— 抽帧是 Agent
 * 那边的事（视频是完整证据，少一帧还能重抽）。
 */
let recording = null

/** 一次性探测结果缓存：{python, ffmpeg} 各自只探一次。 */
const toolCache = { python: undefined, ffmpeg: undefined }

/** 跑一个命令做能力探测，返回是否成功（超时 8s，绝不抛）。 */
function probe(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { timeout: 8000, windowsHide: true, encoding: 'utf8' })
    return r.status === 0
  } catch (e) {
    return false
  }
}

/**
 * 从包目录向上找 `…/.local/<name>`（最多 4 层）。
 *
 * 为什么需要：把插件放在开发工作区里（junction / 直接引用）时，工具往往就躺在
 * 工作区的 `.local/` 下。这里**不写死任何项目名**，只是"往上几层找这个通用目录"，
 * 对别的机器没有副作用（找不到就当没有）。
 */
function findLocalDir(name) {
  let dir = PKG_DIR
  for (let i = 0; i < 4; i++) {
    try {
      const guess = path.join(dir, '.local', name)
      if (existsSync(guess)) return guess
    } catch (e) {
      /* 忽略 */
    }
    const up = path.dirname(dir)
    if (!up || up === dir) break
    dir = up
  }
  return null
}

/** PATH 上的候选（Windows 下 python3 常不存在，py 启动器常见）。 */
const PYTHON_NAMES = ['python.exe', 'python3.exe', 'py.exe']

/**
 * 找**带 Pillow** 的 Python（录屏抓帧用）。
 *
 * 候选来源（都跨机器可移植，不再猜某个项目目录）：
 *   1. `DSH_CAPTURE_PYTHON` 环境变量（显式指定，最高优先级）
 *   2. `<DSH_HOME>/python/**` —— DSH 自带的 Python 分发包
 *   3. 向上找 `.local/python/**` —— 包放在开发工作区里的情形
 *   4. PATH 上的 python / python3 / py
 *
 * 找到后会做一次**能力探测**（`import PIL`）：不合格的候选直接跳过。为什么必须探：
 * 否则失败会一路拖到录制结束，以 "没录到内容（ffmpeg 没写出文件）" 的形式暴露，
 * 用户根本看不出是 Python 缺 Pillow（2026-10-01 排障实录）。
 */
function findPython() {
  if (toolCache.python !== undefined) return toolCache.python
  const roots = []
  if (process.env.DSH_CAPTURE_PYTHON) return cachePython(process.env.DSH_CAPTURE_PYTHON)
  roots.push(path.join(dshHome(), 'python'))
  const localPy = findLocalDir('python')
  if (localPy) roots.push(localPy)
  const candidates = []
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue
      for (const d of readdirSync(root)) {
        for (const exe of ['python.exe', path.join('bin', 'python3'), path.join('bin', 'python')]) {
          const p = path.join(root, d, exe)
          if (existsSync(p)) candidates.push(p)
        }
      }
    } catch (e) {
      /* 忽略 */
    }
  }
  for (const n of PYTHON_NAMES) candidates.push(n)
  return cachePython(candidates.find((c) => probe(c, ['-c', 'import PIL'])) || null)
}

function cachePython(v) {
  toolCache.python = v
  return v
}

/** PATH 上的 ffmpeg 候选名。 */
const FFMPEG_NAMES = ['ffmpeg.exe', 'ffmpeg']

/**
 * 找**能编 webm** 的 ffmpeg（需要 image2pipe + mjpeg + libvpx_vp8 + webm muxer）。
 *
 * 候选来源：
 *   1. `DSH_CAPTURE_FFMPEG` 环境变量
 *   2. Playwright 自带的精简 ffmpeg（`ms-playwright\ffmpeg-*`，正好带 libvpx + webm +
 *      image2pipe，是最省事的现成来源）——覆盖 %LOCALAPPDATA%、~/.cache 与向上找 `.local/`
 *   3. 常见安装位置（winget / choco / scoop / Program Files）
 *   4. PATH 上的 ffmpeg
 *
 * 能力探测：`-encoders` 输出里必须有 `libvpx`，否则这个 ffmpeg 编不出 webm（很多
 * 精简发行版会砍掉它），直接跳过。
 */
function findFfmpeg() {
  if (toolCache.ffmpeg !== undefined) return toolCache.ffmpeg
  if (process.env.DSH_CAPTURE_FFMPEG) return cacheFfmpeg(process.env.DSH_CAPTURE_FFMPEG)

  const pwRoots = []
  if (process.env.LOCALAPPDATA) pwRoots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'))
  if (process.env.USERPROFILE) pwRoots.push(path.join(process.env.USERPROFILE, '.cache', 'ms-playwright'))
  const localPw = findLocalDir('ms-playwright')
  if (localPw) pwRoots.push(localPw)

  const candidates = []
  for (const root of pwRoots) {
    try {
      if (!existsSync(root)) continue
      for (const d of readdirSync(root)) {
        if (!/^ffmpeg/i.test(d)) continue
        for (const exe of ['ffmpeg-win64.exe', 'ffmpeg.exe']) {
          const p = path.join(root, d, exe)
          if (existsSync(p)) candidates.push(p)
        }
      }
    } catch (e) {
      /* 忽略 */
    }
  }
  // 常见安装位置（存在才加，不存在当没有）
  const fixed = [
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe') : null,
    process.env.ChocolateyInstall ? path.join(process.env.ChocolateyInstall, 'bin', 'ffmpeg.exe') : null,
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe') : null
  ]
  for (const p of fixed) if (p && existsSync(p)) candidates.push(p)
  for (const n of FFMPEG_NAMES) candidates.push(n)

  const ok = candidates.find((c) => {
    try {
      const r = spawnSync(c, ['-hide_banner', '-encoders'], { timeout: 8000, windowsHide: true, encoding: 'utf8' })
      return r.status === 0 && typeof r.stdout === 'string' && r.stdout.includes('libvpx')
    } catch (e) {
      return false
    }
  })
  return cacheFfmpeg(ok || null)
}

function cacheFfmpeg(v) {
  toolCache.ffmpeg = v
  return v
}

/** 只回文件名，绝不把宿主绝对路径回显给页面。 */
function basenameOf(p) {
  try {
    return p ? path.basename(p) : null
  } catch (e) {
    return null
  }
}

/** 20261001-113748 形式的时间戳。 */
function stampName() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
    '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
  )
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function killQuiet(proc) {
  try {
    if (proc && !proc.killed) proc.kill()
  } catch (e) {
    /* 忽略 */
  }
}

function waitForFinish(session, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    // 25ms 而不是 200ms：ffmpeg 收尾完成后响应还能被这个轮询白等最多 200ms，
    // 而「录制中点发送」这条链路对这点延迟是能感觉到的（2026-10-01 用户反馈）。
    const tick = () => {
      if (session.finished || Date.now() - t0 > ms) {
        resolve(!!session.finished)
        return
      }
      setTimeout(tick, 25)
    }
    tick()
  })
}

/** 开录：recorder.py 抓屏（MJPEG）→ ffmpeg 封成 VP8/WebM 落到磁盘。 */
export async function handleRecordStart(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只接受 POST' })
    return
  }
  if (recording && !recording.finished) {
    sendJson(res, 409, { ok: false, error: '已经在录了', file: recording.file })
    return
  }
  if (!existsSync(RECORDER_PY)) {
    sendJson(res, 500, { ok: false, error: '找不到 recorder.py: ' + RECORDER_PY })
    return
  }

  let url = null
  try {
    url = new URL(req.url ?? REC_START, 'http://localhost')
  } catch (e) {
    /* 用默认参数 */
  }
  const fps = clampInt(url && url.searchParams.get('fps'), 1, 15, 5)
  const maxEdge = clampInt(url && url.searchParams.get('maxEdge'), 0, 2560, 1280)
  const quality = clampInt(url && url.searchParams.get('quality'), 40, 95, 72)
  const seconds = clampInt(url && url.searchParams.get('seconds'), 5, REC_MAX_SECONDS, 300)

  let file = ''
  let out = null
  try {
    const dir = captureDir()
    await mkdir(dir, { recursive: true })
    file = path.join(dir, 'rec-' + stampName() + '.webm')
    // 关键：由宿主 Node 打开并写这个文件；ffmpeg 只吐 stdout（子进程写盘会被沙箱拒）
    out = createWriteStream(file)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: '建目录/文件失败：' + ((e && e.message) || e) })
    return
  }

  const session = {
    file: file,
    out: out,
    fps: fps,
    seconds: seconds,
    log: '',
    finished: false,
    startedAt: Date.now(),
    bytes: 0,
    python: null,
    ffmpeg: null
  }
  const note = (s) => {
    session.log = (session.log + String(s)).slice(-4000)
  }

  // 起子进程之前先做**能力预检**：缺 Python+Pillow 或缺少带 libvpx 的 ffmpeg 时
  // 立刻给出可执行的错误，不要先回 200 ok:true 再让用户录完才发现没文件
  const py = findPython()
  const ff = findFfmpeg()
  if (!py) {
    sendJson(res, 500, {
      ok: false,
      error: '没找到带 Pillow 的 Python。装好 Python 3 后执行 `pip install Pillow`，' +
        '或用环境变量 DSH_CAPTURE_PYTHON 指向 python.exe 的绝对路径。'
    })
    return
  }
  if (!ff) {
    sendJson(res, 500, {
      ok: false,
      error: '没找到能编码 webm 的 ffmpeg（需要 libvpx）。' +
        '可用 `npx playwright install ffmpeg` 装一个自带 libvpx 的精简版，' +
        '或用环境变量 DSH_CAPTURE_FFMPEG 指向 ffmpeg.exe 的绝对路径。'
    })
    return
  }
  try {
    session.python = spawn(
      py,
      [RECORDER_PY, '--fps', String(fps), '--max-edge', String(maxEdge), '--quality', String(quality), '--seconds', String(seconds)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
    session.ffmpeg = spawn(
      ff,
      ['-hide_banner', '-loglevel', 'warning', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps),
       // ⚠ 必须写 pipe:0：playwright 这个精简 ffmpeg 不认 `-i -`（报 Protocol not found）
       '-i', 'pipe:0', '-c:v', 'libvpx', '-b:v', '1M', '-deadline', 'realtime', '-cpu-used', '8',
       '-pix_fmt', 'yuv420p', '-f', 'webm', 'pipe:1'],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    )
  } catch (e) {
    killQuiet(session.python)
    killQuiet(session.ffmpeg)
    try { out.destroy() } catch (e2) { /* 忽略 */ }
    sendJson(res, 500, { ok: false, error: '起子进程失败：' + ((e && e.message) || e) })
    return
  }

  try {
    session.python.stderr.setEncoding('utf8')
    session.python.stderr.on('data', note)
  } catch (e) { /* 忽略 */ }
  try {
    session.ffmpeg.stderr.setEncoding('utf8')
    session.ffmpeg.stderr.on('data', note)
  } catch (e) { /* 忽略 */ }
  try {
    session.python.stdout.pipe(session.ffmpeg.stdin)
  } catch (e) {
    note('pipe: ' + ((e && e.message) || e))
  }
  try {
    // ffmpeg 的 webm 输出直接进宿主打开的文件流
    session.ffmpeg.stdout.pipe(session.out)
  } catch (e) {
    note('输出管道: ' + ((e && e.message) || e))
  }
  try {
    session.out.on('error', (e) => note('写文件失败: ' + ((e && e.message) || e) + '\n'))
  } catch (e) { /* 忽略 */ }

  session.python.on('error', (e) => note('python 启动失败: ' + ((e && e.message) || e)))
  session.ffmpeg.on('error', (e) => note('ffmpeg 启动失败: ' + ((e && e.message) || e)))
  session.python.on('exit', (code) => {
    note('recorder 退出 code=' + code + '\n')
    try {
      session.ffmpeg.stdin.end()
    } catch (e) { /* 忽略 */ }
  })
  session.ffmpeg.on('close', (code) => {
    note('ffmpeg 退出 code=' + code + '\n')
    // 收尾：把文件流关掉（flush 完）再报字节数
    try {
      session.out.end(() => {
        try {
          session.bytes = existsSync(file) ? statSync(file).size : 0
        } catch (e) {
          session.bytes = 0
        }
        if (!session.bytes) note('输出文件为空：' + file + '\n')
        session.finished = true
      })
    } catch (e) {
      session.finished = true
    }
  })

  recording = session
  log('开录 ' + file + ' fps=' + fps + ' maxEdge=' + maxEdge + ' seconds=' + seconds)
  sendJson(res, 200, { ok: true, file: file, fps: fps, seconds: seconds, python: basenameOf(py), ffmpeg: basenameOf(ff) })
}

/** 停录：关掉抓屏管 → 等 ffmpeg 收尾 → 报告产物。 */
export async function handleRecordStop(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只接受 POST' })
    return
  }
  const session = recording
  if (!session) {
    sendJson(res, 404, { ok: false, error: '当前没有在录制' })
    return
  }

  const elapsed = Math.round((Date.now() - session.startedAt) / 1000)
  if (!session.finished) {
    // recorder.py 监听 stdin：EOF 即收工，随后 ffmpeg 收到管道结束会把 webm 收尾
    try {
      session.python.stdin.end()
    } catch (e) { /* 忽略 */ }
    const done = await waitForFinish(session, 20000)
    if (!done) {
      killQuiet(session.python)
      await waitForFinish(session, 8000)
      if (!session.finished) killQuiet(session.ffmpeg)
      await waitForFinish(session, 5000)
    }
  }

  let bytes = 0
  try {
    bytes = existsSync(session.file) ? statSync(session.file).size : 0
  } catch (e) {
    bytes = 0
  }
  log('停止录制 ' + session.file + ' bytes=' + bytes)
  const payload = {
    ok: bytes > 0,
    file: session.file,
    bytes: bytes,
    seconds: elapsed,
    fps: session.fps,
    log: session.log.slice(-600)
  }
  if (bytes <= 0) {
    // 一定要给出原因：客户端只看到 ok:false 时只能报「HTTP 200」，等于没说
    payload.error = '没录到内容（ffmpeg 没写出文件）'
  }
  sendJson(res, 200, payload)
}

/**
 * 录制状态（只读）：客户端热更 / 页面刷新后靠它**认领**宿主里正在进行的那一段录制。
 *
 * 为什么需要：客户端插件是热更的（HMR 每 ~500ms 轮询 bundle，一变就重载），重载会把
 * `rec.state` 重置成 idle，而宿主侧的录制还在继续 —— 于是「录制中点发送」的钩子
 * 因为 `rec.state !== 'recording'` 直接放行，用户看到的就是「回车只把文字发出去了，
 * 视频没带上、录制还在跑」（2026-10-01 实测 trace：`rec=idle ... inInput=true`）。
 */
export function handleRecordStatus(req, res) {
  const s = recording
  // ⚠ 必须看 finished：宿主这个变量收尾后**不会清空**（只 set 不 reset），只回 !!s 会
  // 永远说「在录」—— 客户端认领后会一直跳秒数（2026-10-01 用户报障）。
  const live = !!s && !s.finished
  sendJson(res, 200, {
    ok: true,
    recording: live,
    finished: !!(s && s.finished),
    file: s ? s.file : '',
    startedAt: live ? s.startedAt : 0,
    seconds: live ? Math.round((Date.now() - s.startedAt) / 1000) : 0,
    fps: live ? s.fps : 0
  })
}

/** 把录好的 webm 交给浏览器（塞进附件用）。 */
export function handleRecordFile(req, res) {
  const session = recording
  if (!session || !existsSync(session.file)) {
    sendJson(res, 404, { ok: false, error: '没有可下载的录像' })
    return
  }
  let bytes = 0
  try {
    bytes = statSync(session.file).size
  } catch (e) {
    bytes = 0
  }
  if (!bytes) {
    sendJson(res, 409, { ok: false, error: '录像还没写完' })
    return
  }
  try {
    res.writeHead(200, {
      'content-type': 'video/webm',
      'content-length': bytes,
      'cache-control': 'no-store'
    })
    const stream = createReadStream(session.file)
    stream.on('error', () => {
      try {
        res.end()
      } catch (e) { /* 忽略 */ }
    })
    stream.pipe(res)
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
  }
}

/**
 * 取宿主里的 webServer 服务。
 *
 * 0.1.7 运行时的标准写法是直接读服务属性（见 @deepseek-ai/dsh-client-modules
 * lib/index.js:546-552、@deepseek-ai/dsh-host-frontend-static lib/index.js:87 都是
 * `ctx.inject(["webServer"], webCtx => webCtx.webServer.register(...))`），
 * 所以先试 `ctx.webServer`，再退回 reflect 取法。
 * @returns {any} 服务对象或 undefined
 */
function resolveWebServer(ctx) {
  try {
    if (ctx && ctx.webServer) return ctx.webServer
  } catch (e) {
    /* 落到下一个取法 */
  }
  try {
    if (ctx && typeof ctx.reflect?.get === 'function') return ctx.reflect.get('webServer')
  } catch (e) {
    /* 两种取法都不行 */
  }
  return undefined
}

/** 已挂载标记：inject 回调与兜底路径只允许挂一次（webserver 对重复路由会抛错）。 */
let mounted = false

/** 本插件要挂的路由表。 */
const ROUTES = [
  { kind: 'prefix', path: ROUTE, handler: handleShot, label: '抓屏' },
  { kind: 'prefix', path: SAVE_ROUTE, handler: handleSave, label: '落盘' },
  { kind: 'prefix', path: REC_START, handler: handleRecordStart, label: '开录' },
  { kind: 'prefix', path: REC_STOP, handler: handleRecordStop, label: '停录' },
  { kind: 'prefix', path: REC_FILE, handler: handleRecordFile, label: '取录像' },
  { kind: 'prefix', path: REC_STATUS, handler: handleRecordStatus, label: '录制状态' }
]

/** 挂全部路由；已经挂过就什么都不做。 */
function mountRoutes(webServer, via) {
  if (mounted) return
  if (!webServer || typeof webServer.register !== 'function') return
  mounted = true
  for (const route of ROUTES) {
    try {
      webServer.register({ kind: route.kind, path: route.path, handler: route.handler })
      log('已挂载' + route.label + '路由 ' + route.path + '（' + via + '）')
    } catch (e) {
      log('挂载' + route.label + '路由失败（可能已存在）:', (e && e.message) || e)
    }
  }
}

export function apply(ctx) {
  try {
    if (!existsSync(SHOT_SCRIPT)) log('警告：找不到 ' + SHOT_SCRIPT + '，抓屏路由会返回 500')

    // 主路径：等 webServer 服务就绪。用 effect 包一层，HMR 卸载时能撤掉路由。
    try {
      ctx.inject(['webServer'], (webCtx) => {
        const webServer = resolveWebServer(webCtx)
        if (!webServer || typeof webServer.register !== 'function') {
          log('拿不到 webServer.register，路由未挂载')
          return
        }
        if (mounted) return
        mounted = true
        try {
          if (typeof webCtx.effect === 'function') {
            webCtx.effect(() => {
              const disposers = []
              for (const route of ROUTES) {
                disposers.push(webServer.register({ kind: route.kind, path: route.path, handler: route.handler }))
                log('已挂载' + route.label + '路由 ' + route.path + '（inject）')
              }
              return () => {
                for (const dispose of disposers) {
                  try { dispose() } catch (e) { /* 忽略 */ }
                }
              }
            }, 'dsh-screen-capture-record-desktop: capture + save routes')
          } else {
            for (const route of ROUTES) {
              webServer.register({ kind: route.kind, path: route.path, handler: route.handler })
              log('已挂载' + route.label + '路由 ' + route.path + '（inject）')
            }
          }
        } catch (e) {
          log('挂载路由失败（可能已存在）:', (e && e.message) || e)
        }
      })
    } catch (e) {
      log('ctx.inject 不可用:', (e && e.message) || e)
    }

    // 兜底：有的版本 apply 时服务已就绪、inject 回调不一定立刻跑。
    mountRoutes(resolveWebServer(ctx), 'fallback')
  } catch (e) {
    log('apply 失败:', (e && e.message) || e)
  }
}
