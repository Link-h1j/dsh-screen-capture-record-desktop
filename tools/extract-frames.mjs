#!/usr/bin/env node
/**
 * 把「给模型看的证据」变成模型真能读的东西。
 *
 * 为什么需要它：录屏产出的是 .webm 视频，而多数模型没有视频输入通道；
 * 截图虽然是图，也得先给出**可读的绝对路径**。这个工具就干这两件事：
 *
 *   视频（webm / mp4 / mov …）→ 抽帧成 PNG，打印每帧的绝对路径 + 时间戳 + 尺寸
 *   图片（png / jpg / webp / gif …）→ 直接打印路径与尺寸（模型直接读）
 *
 * 抽完帧请**逐帧读图再动手**（DSH 里是 read_image）。这条规矩写在仓库根的 AGENTS.md 里。
 *
 * 用法：
 *   node tools/extract-frames.mjs <文件> [--out 目录] [--fps 1/3] [--width 1300]
 *                                      [--max 12] [--no-dedupe] [--json]
 *
 *   --fps      抽帧间隔，接受 "1/3"（每 3 秒一帧，默认）或 "2"（每秒 2 帧）
 *   --width    每帧缩到多宽（默认 1300，0 = 原始分辨率）
 *   --max      最多保留多少帧（默认 12，均匀取样，首尾必留）
 *   --no-dedupe  不做逐帧去重（默认丢掉与上一帧完全相同的画面）
 *   --json     输出机器可读的 JSON（agent 直接解析）
 *
 * ffmpeg 探测顺序：$DSH_CAPTURE_FFMPEG → C:\Program Files\CP3\ffmpeg.exe →
 * playwright 自带 → PATH。抽帧只用 PNG 编码器，任何一份 ffmpeg 都够。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']
const VIDEO_EXT = ['.webm', '.mp4', '.mov', '.mkv', '.avi', '.m4v']

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i >= 0) {
    const v = process.argv[i + 1]
    if (v && !v.startsWith('--')) return v
    return true
  }
  return fallback
}
const has = (name) => process.argv.includes('--' + name)

const input = process.argv.slice(2).find((a) => !a.startsWith('--') && process.argv[process.argv.indexOf(a) - 1] !== '--out' && process.argv[process.argv.indexOf(a) - 1] !== '--fps' && process.argv[process.argv.indexOf(a) - 1] !== '--width' && process.argv[process.argv.indexOf(a) - 1] !== '--max')
if (!input) {
  console.error('用法: node tools/extract-frames.mjs <视频或图片> [--out 目录] [--fps 1/3] [--width 1300] [--max 12] [--no-dedupe] [--json]')
  process.exit(2)
}
if (!fs.existsSync(input)) {
  console.error('找不到文件: ' + input)
  process.exit(2)
}

const asJson = has('json')
const dedupe = !has('no-dedupe')
const maxFrames = Number(arg('max', 12)) || 12
const width = Number(arg('width', 1300))
const fpsSpec = String(arg('fps', '1/3'))

/** "1/3" → 0.3333（每 3 秒一帧）；"2" → 2 帧/秒 */
function parseFps(spec) {
  const m = String(spec).match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/)
  if (m) return Number(m[1]) / Number(m[2])
  const n = Number(spec)
  return Number.isFinite(n) && n > 0 ? n : 1 / 3
}
const fps = parseFps(fpsSpec)
const stepSec = 1 / fps

function findFfmpeg() {
  const cands = []
  if (process.env.DSH_CAPTURE_FFMPEG) cands.push(process.env.DSH_CAPTURE_FFMPEG)
  cands.push('C:\\Program Files\\CP3\\ffmpeg.exe')
  try {
    const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
    if (root && fs.existsSync(root)) {
      for (const d of fs.readdirSync(root)) {
        if (!d.startsWith('ffmpeg')) continue
        for (const exe of ['ffmpeg-win64.exe', 'ffmpeg.exe', 'ffmpeg']) {
          cands.push(path.join(root, d, exe))
        }
      }
    }
  } catch (e) {
    /* 忽略 */
  }
  cands.push('ffmpeg')
  for (const c of cands) {
    if (!c) continue
    if (c.includes(path.sep) && !fs.existsSync(c)) continue
    const r = spawnSync(c, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true })
    if (r.status === 0) return c
  }
  return null
}

const ffmpeg = findFfmpeg()
if (!ffmpeg) {
  console.error('找不到 ffmpeg。装一个，或用 DSH_CAPTURE_FFMPEG 指向 ffmpeg.exe 的绝对路径。')
  process.exit(3)
}

/** 从 ffmpeg -i 的 stderr 里读时长 / 分辨率 / 帧率（只要能拿到就拿出来）。 */
function probe(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8', windowsHide: true })
  const err = String(r.stderr || '')
  const out = {}
  const dur = err.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
  if (dur) out.durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])
  const v = err.match(/(\d{2,5})x(\d{2,5})[\s,]/)
  if (v) {
    out.width = Number(v[1])
    out.height = Number(v[2])
  }
  const f = err.match(/([\d.]+)\s*fps/)
  if (f) out.fps = Number(f[1])
  return out
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

const ext = path.extname(input).toLowerCase()
const abs = path.resolve(input)
const info = probe(abs)

// ---------------------------------------------------------------- 图片
if (IMAGE_EXT.includes(ext)) {
  const frames = [{ path: abs, t: 0, sha256: sha256(abs) }]
  if (asJson) {
    console.log(JSON.stringify({ input: abs, kind: 'image', probe: info, frames }, null, 2))
  } else {
    console.log('图片  ' + path.basename(abs) + (info.width ? '  ' + info.width + 'x' + info.height : ''))
    console.log('\n直接逐帧读它：\n  ' + abs + '\n')
    console.log('（DSH 里用 read_image；看完再动手。）')
  }
  process.exit(0)
}

if (!VIDEO_EXT.includes(ext)) {
  console.error('既不是认识的图片也不是认识的视频后缀: ' + ext)
  process.exit(2)
}

// ---------------------------------------------------------------- 视频
const outDir = String(arg('out', '')) || fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-frames-'))
fs.mkdirSync(outDir, { recursive: true })

const vf = ['fps=' + Number(fps.toFixed(6))]
if (width > 0) vf.push('scale=' + width + ':-2')
const args = ['-hide_banner', '-loglevel', 'error', '-i', abs, '-vf', vf.join(','), path.join(outDir, 'frame-%04d.png')]
const run = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true })
if (run.status !== 0) {
  console.error('抽帧失败：' + String(run.stderr || '').slice(-500))
  process.exit(4)
}

let files = fs
  .readdirSync(outDir)
  .filter((f) => /^frame-\d+\.png$/.test(f))
  .sort()
  .map((f) => path.join(outDir, f))

let frames = files.map((p, i) => ({ path: p, t: Number((i * stepSec).toFixed(3)), sha256: sha256(p) }))
let dropped = 0
if (dedupe) {
  const kept = []
  for (const fr of frames) {
    if (kept.length && kept[kept.length - 1].sha256 === fr.sha256) {
      dropped++
      try {
        fs.unlinkSync(fr.path)
      } catch (e) {
        /* 忽略 */
      }
      continue
    }
    kept.push(fr)
  }
  frames = kept
}
if (frames.length > maxFrames) {
  const picked = []
  for (let i = 0; i < maxFrames; i++) {
    picked.push(frames[Math.round((i * (frames.length - 1)) / (maxFrames - 1))])
  }
  frames = Array.from(new Set(picked))
}

if (asJson) {
  console.log(JSON.stringify({ input: abs, kind: 'video', probe: info, ffmpeg, outDir, frames }, null, 2))
  process.exit(0)
}

const fmtT = (t) => {
  const m = Math.floor(t / 60)
  const s = (t - m * 60).toFixed(1)
  return (m ? m + 'm' : '') + s + 's'
}
console.log(
  '视频  ' +
    path.basename(abs) +
    '  ' +
    (info.width ? info.width + 'x' + info.height + ' · ' : '') +
    (info.fps ? info.fps + ' fps · ' : '') +
    (info.durationSec ? info.durationSec.toFixed(1) + 's' : '')
)
console.log(
  '抽帧  每 ' + (stepSec >= 1 ? stepSec.toFixed(2) + 's' : fps.toFixed(2) + ' 帧/秒') + ' 一帧' +
    (width > 0 ? '，缩到 ' + width + 'px 宽' : '，原始分辨率') +
    (dedupe ? '，逐帧去重（丢掉 ' + dropped + ' 帧相同画面）' : '') +
    ' → 保留 ' + frames.length + ' 帧'
)
console.log('目录  ' + outDir)
console.log('')
console.log('逐帧读图再动手（DSH 里是 read_image）：')
for (const fr of frames) {
  console.log('  [' + fmtT(fr.t).padStart(7) + ']  ' + fr.path)
}
console.log('')
