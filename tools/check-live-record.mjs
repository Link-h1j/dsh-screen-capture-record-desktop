/**
 * 真宿主的录屏链路验收（**不需要 CDP、不需要页面**，直接打宿主插件路由）。
 *
 * 这条链路的接缝是「路由 → recorder.py --region/--hwnd → ffmpeg → .webm 文件」，
 * 页面上那一半（选择框）由 tools/e2e-record-picker.mjs 覆盖；这里只验宿主，
 * 所以 CDP 没开、桌面版怎么启的都不影响。
 *
 * 步骤：
 *   1) GET  /sources?probe=1         路由挂上没有
 *   2) GET  /sources                 真清单：virtual / monitors / windows 合理性
 *   3) POST /record/start?…&x&y&w&h  录一块指定区域 ~4 秒 → /record/stop
 *   4) ffmpeg 抽首帧                 帧尺寸 == 区域按 maxEdge 缩放后的尺寸
 *   5) （有窗口时）用 hwnd 再录一次    帧尺寸 == 该窗口尺寸按 maxEdge 缩放
 *
 * 用法：node tools/check-live-record.mjs [--port 19387] [--max-edge 1280] [--ffmpeg 路径]
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = path.join(root, '.e2e-out')
fs.mkdirSync(outDir, { recursive: true })

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const port = Number(arg('port', process.env.DSH_PORT || 19387))
const MAX_EDGE = Number(arg('max-edge', 1280))
const FFMPEG = arg('ffmpeg', process.env.E2E_FFMPEG || 'C:\\Program Files\\CP3\\ffmpeg.exe')
const BASE = `http://127.0.0.1:${port}`
const R = '/plugins/dsh-screen-capture-record-desktop'

const checks = []
function check(name, ok, detail) {
  checks.push(!!ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  —— ' + detail : ''))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function expected(w, h, maxEdge) {
  const scale = maxEdge > 0 ? Math.min(1, maxEdge / Math.max(w, h)) : 1
  return { w: Math.max(2, Math.round(w * scale)), h: Math.max(2, Math.round(h * scale)) }
}

async function jget(url) {
  const r = await fetch(BASE + url, { cache: 'no-store' })
  const t = await r.text()
  let j = null
  try {
    j = JSON.parse(t)
  } catch (e) {
    j = null
  }
  return { status: r.status, json: j, text: t }
}

function firstFrameSize(file) {
  const png = path.join(outDir, 'live-record-frame.png')
  const r = spawnSync(FFMPEG, ['-y', '-i', file, '-frames:v', '1', png], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  try {
    const b = fs.readFileSync(png)
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), png, err: '' }
  } catch (e) {
    return { w: 0, h: 0, png, err: String(r.stderr || '').slice(-300) }
  }
}

// ---- 1. 探活 ----
const probe = await jget(`${R}/sources?probe=1`).catch((e) => ({ status: 0, json: null, text: String(e) }))
check('宿主 /sources 路由已挂上', probe.status === 200 && probe.json && probe.json.capable === true, `HTTP ${probe.status} ${probe.text.slice(0, 120)}`)
if (probe.status !== 200) {
  console.log('\n宿主还没重启（新路由未挂载）—— 完整重启桌面版后再跑这个脚本。')
  process.exit(1)
}

// ---- 2. 真清单 ----
const src = await jget(`${R}/sources`)
const virtual = (src.json && src.json.virtual) || {}
const monitors = (src.json && src.json.monitors) || []
const windows = (src.json && src.json.windows) || []
check('真清单：virtual 有效', virtual.w > 0 && virtual.h > 0, `${virtual.x},${virtual.y} ${virtual.w}x${virtual.h}`)
check('真清单：至少一台显示器', monitors.length >= 1, monitors.map((m) => `${m.w}x${m.h}${m.primary ? ' 主' : ''}`).join(' / '))
check('真清单：窗口带句柄（中文标题不乱码）', windows.length > 0 && windows.every((w) => w.hwnd > 0), `${windows.length} 个：` + windows.slice(0, 4).map((w) => `${w.title.slice(0, 16)}[${w.w}x${w.h}]`).join(' / '))

// 抓屏尺寸必须与 virtual 一致（三方坐标系对齐的硬证）
const shotRes = await fetch(`${BASE}${R}/shot?format=jpg&maxEdge=0&quality=60`, { cache: 'no-store' })
const shotBuf = Buffer.from(await shotRes.arrayBuffer())
let shotSize = null
try {
  // JPEG SOF
  let i = 2
  while (i < shotBuf.length - 4) {
    if (shotBuf[i] !== 0xff) { i++; continue }
    const m = shotBuf[i + 1]
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += 2; continue }
    const len = shotBuf.readUInt16BE(i + 2)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      shotSize = { h: shotBuf.readUInt16BE(i + 5), w: shotBuf.readUInt16BE(i + 7) }
      break
    }
    i += 2 + len
  }
} catch (e) { /* 忽略 */ }
check(
  '抓屏像素 == /sources 的 virtual（坐标系对齐）',
  shotSize && shotSize.w === virtual.w && shotSize.h === virtual.h,
  shotSize ? `shot ${shotSize.w}x${shotSize.h} vs virtual ${virtual.w}x${virtual.h}` : '(解不出 JPEG 尺寸)'
)

// ---- 3/4. 区域录制 ----
const shotRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-screen-capture')
async function recordRegion({ x, y, w, h, hwnd, seconds = 4 }) {
  let url = `${R}/record/start?fps=5&maxEdge=${MAX_EDGE}&quality=70&seconds=60&x=${x}&y=${y}&w=${w}&h=${h}`
  if (hwnd) url += `&hwnd=${hwnd}`
  const start = await fetch(BASE + url, { method: 'POST', cache: 'no-store' }).then((r) => r.json().catch(() => null))
  if (!start || start.ok !== true) return { start, error: (start && start.error) || 'start 失败' }
  await sleep(seconds * 1000)
  const stop = await fetch(`${BASE}${R}/record/stop`, { method: 'POST', cache: 'no-store' }).then((r) => r.json().catch(() => null))
  return { start, stop }
}

const mon = monitors.slice().sort((a, b) => a.w * a.h - b.w * b.h)[0]
const rw = Math.min(1600, Math.round(mon.w * 0.6))
const rh = Math.min(900, Math.round(mon.h * 0.6))
const rx = mon.x + Math.round((mon.w - rw) / 2)
const ry = mon.y + Math.round((mon.h - rh) / 2)
const rec = await recordRegion({ x: rx, y: ry, w: rw, h: rh })
check('区域录制：start 回 ok 且带上 region', rec.start && rec.start.ok === true && rec.start.region && rec.start.region.w === rw, JSON.stringify(rec.start && rec.start.region))
check('区域录制：stop 产出非空 .webm', rec.stop && rec.stop.ok === true && rec.stop.bytes > 1000, rec.stop ? `${path.basename(rec.stop.file || '')} ${rec.stop.bytes} bytes / ${rec.stop.seconds}s` : JSON.stringify(rec))

let frame = null
if (rec.stop && rec.stop.file && fs.existsSync(rec.stop.file)) {
  frame = firstFrameSize(rec.stop.file)
  const want = expected(rw, rh, MAX_EDGE)
  check(
    '区域录制的首帧尺寸 == 区域按 maxEdge 缩放',
    frame.w === want.w && frame.h === want.h,
    `${frame.w}x${frame.h}（区域 ${rw}x${rh}，期望 ${want.w}x${want.h}）`
  )
  fs.copyFileSync(rec.stop.file, path.join(outDir, 'live-record-region.webm'))
}

// ---- 5. 窗口跟随 ----
if (windows.length) {
  const win = windows.slice().sort((a, b) => b.w * b.h - a.w * a.h)[0]
  const rec2 = await recordRegion({ x: win.x, y: win.y, w: win.w, h: win.h, hwnd: win.hwnd, seconds: 4 })
  if (rec2.stop && rec2.stop.file && fs.existsSync(rec2.stop.file)) {
    const f2 = firstFrameSize(rec2.stop.file)
    const want2 = expected(win.w, win.h, MAX_EDGE)
    check(
      '窗口录制（带 hwnd）首帧尺寸 == 窗口尺寸按 maxEdge 缩放',
      Math.abs(f2.w - want2.w) <= 4 && Math.abs(f2.h - want2.h) <= 6,
      `${f2.w}x${f2.h}（窗口 ${win.w}x${win.h}，期望 ${want2.w}x${want2.h}）` + (f2.err ? ' | ' + f2.err : '')
    )
    fs.copyFileSync(rec2.stop.file, path.join(outDir, 'live-record-window.webm'))
  } else {
    check('窗口录制（带 hwnd）能产出文件', false, JSON.stringify(rec2.stop))
  }
}

const failed = checks.filter((c) => !c).length
console.log('\n==== ' + (checks.length - failed) + '/' + checks.length + ' PASS ====')
console.log('产物副本在 ' + outDir)
process.exit(failed ? 1 : 0)
