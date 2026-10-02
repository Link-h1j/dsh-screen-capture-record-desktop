/**
 * 宿主侧自测：录制源枚举 + 区域/窗口录制的**尺寸正确性**。
 *
 * 不需要 DSH 在跑（直接调 lib/sources.ps1 与 lib/recorder.py），所以宿主侧改动
 * 可以先在这里验一遍，再谈重启：
 *
 *   1) sources.ps1 吐出的 JSON 结构对不对（virtual / monitors / windows）；
 *   2) `--region x,y,w,h` 抓出来的帧尺寸 == 区域按 maxEdge 缩放后的尺寸；
 *   3) `--hwnd <句柄>` 抓出来的帧尺寸 == 该窗口按 maxEdge 缩放后的尺寸。
 *
 * 用法：node tools/check-capture-sources.mjs [--windows]
 *   --windows  额外跑窗口录制用例（需要一个可见窗口，默认跳过）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const SOURCES_PS1 = path.join(root, 'lib', 'sources.ps1')
const RECORDER_PY = path.join(root, 'lib', 'recorder.py')

const withWindows = process.argv.includes('--windows')
const checks = []
function check(name, ok, detail) {
  checks.push(!!ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  —— ' + detail : ''))
}

function pickPowerShell() {
  const win = process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : null
  return win && existsSync(win) ? win : 'powershell.exe'
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const ps = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    const t = setTimeout(() => {
      try {
        ps.kill()
      } catch {}
    }, timeoutMs)
    ps.stdout.setEncoding('utf8')
    ps.stdout.on('data', (c) => (out += c))
    ps.stderr.setEncoding('utf8')
    ps.stderr.on('data', (c) => (err += c))
    ps.on('close', (code) => {
      clearTimeout(t)
      resolve({ code, out, err })
    })
    ps.on('error', (e) => {
      clearTimeout(t)
      resolve({ code: -1, out, err: String(e) })
    })
  })
}

/** 从一段 MJPEG 字节流里读出第一帧的宽高（走 SOF 标记）。 */
function firstJpegSize(buf) {
  let i = 2
  while (i < buf.length - 4) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const m = buf[i + 1]
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + len
  }
  return null
}

function scaleTo(x, y, maxEdge) {
  if (maxEdge <= 0) return { w: x, h: y }
  const scale = Math.min(1, maxEdge / Math.max(x, y))
  return { w: Math.max(2, Math.round(x * scale)), h: Math.max(2, Math.round(y * scale)) }
}

/** 录 ~1.6 秒到临时文件，返回第一帧尺寸与 stderr。 */
async function recordOnce({ region, hwnd, seconds = 1.6, maxEdge = 0 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-rec-check-'))
  const out = path.join(dir, 'raw.mjpg')
  const args = [RECORDER_PY, '--fps', '5', '--max-edge', String(maxEdge), '--quality', '70', '--seconds', String(seconds), '--out', out]
  if (region) args.push('--region', region)
  if (hwnd) args.push('--hwnd', String(hwnd))
  const r = await run('python', args, 30000)
  let size = null
  try {
    size = firstJpegSize(readFileSync(out))
  } catch (e) {
    size = null
  }
  const bytes = existsSync(out) ? statSync(out).size : 0
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {}
  return { size, bytes, err: r.err, code: r.code }
}

// ---------------------------------------------------------------- 1. 源枚举
const src = spawnSync(pickPowerShell(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SOURCES_PS1], {
  encoding: 'utf8',
  timeout: 20000,
  windowsHide: true,
  maxBuffer: 8 * 1024 * 1024
})
let parsed = null
try {
  const lines = String(src.stdout || '').split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0 && !parsed; i--) {
    const line = lines[i].trim()
    if (line.length < 2 || line[0] !== '{') continue
    try {
      parsed = JSON.parse(line)
    } catch (e) {
      /* 继续往上找 */
    }
  }
} catch (e) {
  parsed = null
}
check('sources.ps1 退出码 0 且吐出 JSON', src.status === 0 && parsed && parsed.ok === true, src.status !== 0 ? String(src.stderr || '').slice(0, 200) : '')

const virtual = parsed && parsed.virtual
const monitors = parsed && Array.isArray(parsed.monitors) ? parsed.monitors : []
const windows = parsed && Array.isArray(parsed.windows) ? parsed.windows : []

check('virtual 矩形有效', virtual && virtual.w > 0 && virtual.h > 0, virtual ? `${virtual.x},${virtual.y} ${virtual.w}x${virtual.h}` : '(缺失)')
check('至少一个显示器', monitors.length >= 1, monitors.map((m) => `${m.w}x${m.h}${m.primary ? ' 主' : ''}`).join(' / '))
check(
  '窗口列表带坐标与句柄（且都在虚拟桌面内）',
  windows.every((w) => w.w > 0 && w.h > 0 && w.hwnd > 0) && windows.every((w) => w.x + w.w <= virtual.x + virtual.w + 1 && w.y + w.h <= virtual.y + virtual.h + 1),
  `${windows.length} 个窗口：` + windows.slice(0, 3).map((w) => `${w.title.slice(0, 14)}[${w.w}x${w.h}]`).join(' / ')
)
console.log('      显示器：' + JSON.stringify(monitors))
console.log('      窗口前 5：' + JSON.stringify(windows.slice(0, 5).map((w) => ({ t: w.title.slice(0, 24), p: w.process, r: [w.x, w.y, w.w, w.h] }))))

// ---------------------------------------------------------------- 2. 区域录制
if (virtual) {
  // 取中间一块，避免正好是个空区域
  const rw = Math.min(800, Math.round(virtual.w / 2))
  const rh = Math.min(600, Math.round(virtual.h / 2))
  const region = [virtual.x + Math.round((virtual.w - rw) / 2), virtual.y + Math.round((virtual.h - rh) / 2), rw, rh]
  const rec = await recordOnce({ region: region.join(',') })
  const want = { w: rw, h: rh }
  check(
    '--region 抓到的帧尺寸 == 区域尺寸',
    rec.size && rec.size.width === want.w && rec.size.height === want.h,
    `${region.join(',')} -> ${rec.size ? rec.size.width + 'x' + rec.size.height : '(没解出帧)'}（期望 ${want.w}x${want.h}）`
  )

  const rec2 = await recordOnce({ region: region.join(','), maxEdge: Math.round(rw / 2) })
  const want2 = scaleTo(rw, rh, Math.round(rw / 2))
  check(
    '--region + --max-edge 按区域（不是整屏）缩放',
    rec2.size && rec2.size.width === want2.w && rec2.size.height === want2.h,
    `${rec2.size ? rec2.size.width + 'x' + rec2.size.height : '(没解出帧)'}（期望 ${want2.w}x${want2.h}）`
  )

  const full = await recordOnce({})
  check(
    '不给 --region 时仍是整个虚拟桌面（老行为）',
    full.size && full.size.width === virtual.w && full.size.height === virtual.h,
    `${full.size ? full.size.width + 'x' + full.size.height : '(没解出帧)'}（期望 ${virtual.w}x${virtual.h}）`
  )
}

// ---------------------------------------------------------------- 3. 窗口跟随
if (withWindows && windows.length) {
  const w = windows[0]
  const rec = await recordOnce({ region: [w.x, w.y, w.w, w.h].join(','), hwnd: w.hwnd })
  const ok = rec.size && Math.abs(rec.size.width - w.w) <= 2 && Math.abs(rec.size.height - w.h) <= 2
  check('--hwnd 录到窗口本体尺寸', ok, `${w.title.slice(0, 20)} ${w.w}x${w.h} -> ${rec.size ? rec.size.width + 'x' + rec.size.height : '(没解出帧)'}`)
}

const failed = checks.filter((c) => !c).length
console.log('\n==== ' + (checks.length - failed) + '/' + checks.length + ' PASS ====')
process.exit(failed ? 1 : 0)
