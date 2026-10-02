/**
 * 录屏选源（「选择要录制的内容」框）端到端验收。
 *
 * 两种模式：
 *   默认（mock）   把页面里的 fetch 换成一个替身：/sources 回一份假清单、/record/start
 *                  只记下 URL 并回 ok。用来验**客户端**逻辑（选择框渲染、点哪个源就该
 *                  带哪组坐标、窗口带 hwnd、取消不录），不需要宿主重启。
 *   --live         用宿主真实的 /sources 与真实录制：选中一个显示器 → 真录 ~4 秒 →
 *                  停 → 校验产出的 .webm 首帧尺寸 == 该显示器按 maxEdge 缩放后的尺寸。
 *                  （宿主半边是新路由，必须完整重启过 DSH 才有。）
 *
 * 前置：DSH 桌面版带 --remote-debugging-port=9222 在跑。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = process.env.E2E_OUT || path.join(root, '.e2e-out')
fs.mkdirSync(outDir, { recursive: true })

const live = process.argv.includes('--live')
const port = process.env.DSH_CDP_PORT || '9222'

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('没有 page target')
  process.exit(2)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws error'))
  setTimeout(() => rej(new Error('ws timeout')), 8000)
})
let id = 0
const pending = new Map()
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m)
    pending.delete(m.id)
  }
}
const send = (method, params) =>
  new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
async function evalIn(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  const res = r.result || {}
  if (res.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(res.exceptionDetails).slice(0, 600))
  return res.result ? res.result.value : undefined
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const v = await evalIn(expr)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('等超时：' + label)
    await new Promise((r) => setTimeout(r, 200))
  }
}

const checks = []
function check(name, ok, detail) {
  checks.push(!!ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  —— ' + detail : ''))
}

await send('Runtime.enable', {})
await send('Page.enable', {})

const REC_BTN = 'button[data-dsh-capture-rec]'

/** 把催的假清单：两台显示器 + 两个窗口（含中文标题）。 */
const MOCK_SOURCES = {
  ok: true,
  virtual: { x: 0, y: 0, w: 3840, h: 2160 },
  monitors: [
    { index: 0, primary: true, x: 0, y: 0, w: 3840, h: 2160, name: '\\\\.\\DISPLAY1' },
    { index: 1, primary: false, x: -1920, y: 0, w: 1920, h: 1080, name: '\\\\.\\DISPLAY2' }
  ],
  windows: [
    { title: '记事本 — 未命名', process: 'notepad', x: 100, y: 100, w: 900, h: 600, hwnd: 12345 },
    { title: '计算器', process: 'calc', x: 1200, y: 500, w: 400, h: 700, hwnd: 67890 }
  ]
}

async function installMock() {
  await evalIn(`(() => {
    if (!window.__origFetch) window.__origFetch = window.fetch
    window.__spy = []
    const SRC = ${JSON.stringify(MOCK_SOURCES)}
    window.fetch = function (url, opts) {
      const u = String(url)
      window.__spy.push({ url: u, method: (opts && opts.method) || 'GET' })
      const json = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } }))
      if (u.indexOf('/sources') >= 0) return json(SRC)
      if (u.indexOf('/record/start') >= 0) return json({ ok: true, file: 'X:/fake-rec.webm', fps: 5 })
      if (u.indexOf('/record/stop') >= 0) return json({ ok: true, file: 'X:/fake-rec.webm', bytes: 1, seconds: 1 })
      return window.__origFetch.apply(this, arguments)
    }
    return 1
  })()`)
}

async function removeMock() {
  await evalIn(`(() => { if (window.__origFetch) { window.fetch = window.__origFetch; delete window.__origFetch } return 1 })()`)
}

// ---------------------------------------------------------------- mock 模式
if (!live) {
  await installMock()

  // 1. 点录屏 → 出选择框（而不是直接开录）
  await evalIn(`document.querySelector('${REC_BTN}').click()`)
  const opened = await waitFor('!!document.querySelector("[data-dsh-capture-sources]")', 15000, '选择框出现')
  const rows = await evalIn(`(() => {
    const rs = Array.prototype.slice.call(document.querySelectorAll('[data-dsh-capture-source]'))
    return { count: rs.length, kinds: rs.map((r) => r.getAttribute('data-dsh-capture-source')), texts: rs.map((r) => r.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40)) }
  })()`)
  check('点录屏先弹「选择要录制的内容」框', !!opened, '')
  check('清单 = 整桌面 + 2 显示器 + 2 窗口', rows.count === 5, rows.kinds.join(',') + ' | ' + rows.texts.join(' / '))
  check('窗口标题中文正常', rows.texts.join(' ').indexOf('记事本') >= 0, '')

  // 2. 选「记事本」窗口 → /record/start 必须带该窗口的矩形与 hwnd
  await evalIn(`(() => {
    const rs = Array.prototype.slice.call(document.querySelectorAll('[data-dsh-capture-source]'))
    const r = rs.filter((x) => x.textContent.indexOf('记事本') >= 0)[0]
    r.click()
    return 1
  })()`)
  const startUrl = await waitFor(
    `(() => { const h = (window.__spy || []).filter((s) => s.url.indexOf('/record/start') >= 0); return h.length ? h[h.length - 1].url : '' })()`,
    10000,
    '/record/start 被调用'
  )
  check(
    '选窗口 → 带 x,y,w,h 与 hwnd',
    startUrl.indexOf('x=100') >= 0 && startUrl.indexOf('y=100') >= 0 && startUrl.indexOf('w=900') >= 0 && startUrl.indexOf('h=600') >= 0 && startUrl.indexOf('hwnd=12345') >= 0,
    startUrl.replace(/^.*record\/start/, '/record/start')
  )
  check('选择框选完即关闭', (await evalIn('!document.querySelector("[data-dsh-capture-sources]")')) === true, '')

  // 3. 上次的选择会预选：再点一次录屏，记事本那行应被标成已选
  await evalIn(`document.querySelector('${REC_BTN}').click()`) // 这次是「停录」（假的开始把它带到 recording）
  await waitFor('!document.querySelector("[data-dsh-capture-overlay]")', 3000, '（等兜底）').catch(() => {})
  const lastSaved = await evalIn(`localStorage.getItem('dsh-capture.lastSource')`)
  check('选择的源被记住（localStorage.lastSource）', !!lastSaved && lastSaved.indexOf('记事本') >= 0, String(lastSaved).slice(0, 120))

  // 4. 取消：不该发起任何 /record/start
  await removeMock()
  await installMock()
  await evalIn(`(() => { window.__spy.length = 0; return 1 })()`)
  // 先回到 idle：假的 start 让 rec.state 停在 recording，用 Esc 走正常停止路径
  await evalIn(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise((r) => setTimeout(r, 1200))
  await evalIn(`document.querySelector('${REC_BTN}').click()`)
  await waitFor('!!document.querySelector("[data-dsh-capture-sources]")', 15000, '选择框（第二次）')
  await evalIn(`document.querySelector('[data-dsh-capture-sources-cancel]').click()`)
  await new Promise((r) => setTimeout(r, 500))
  const afterCancel = await evalIn(`(window.__spy || []).filter((s) => s.url.indexOf('/record/start') >= 0).length`)
  check('点「取消」不会开录', afterCancel === 0, 'record/start 次数=' + afterCancel)

  // 5. 「自定义区域…」→ 进拖框浮层（只有选区、没有标注工具栏）
  await evalIn(`document.querySelector('${REC_BTN}').click()`)
  await waitFor('!!document.querySelector("[data-dsh-capture-sources]")', 15000, '选择框（第三次）')
  await evalIn(`document.querySelector('[data-dsh-capture-region]').click()`)
  await waitFor('!!document.querySelector("[data-dsh-capture-overlay]")', 15000, '拖框浮层')
  const regionUi = await evalIn(`(() => {
    const tools = document.querySelector('[data-dsh-capture-tools]')
    return { tools: getComputedStyle(tools).display, hint: document.querySelector('[data-dsh-capture-hint]').textContent }
  })()`)
  check('「自定义区域」进的是无标注的选区浮层', regionUi.tools === 'none', regionUi.hint)

  // 收尾：Esc 关掉浮层、卸掉替身、把假录制状态也清掉（刷新页面最干净）
  await evalIn(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await removeMock()
  await send('Page.reload', { ignoreCache: false })
  await waitFor(`!!document.querySelector('${REC_BTN}')`, 20000, '刷新后按钮回来')

  console.log('\n（mock 模式：只验客户端。真机全链路请跑 node tools/e2e-record-picker.mjs --live）')
}

// ---------------------------------------------------------------- live 模式
if (live) {
  // 宿主有没有挂上新路由？
  const probe = await evalIn(`fetch('/plugins/dsh-screen-capture-record-desktop/sources?probe=1', { cache: 'no-store' }).then((r) => r.status).catch((e) => 'ERR:' + e.message)`)
  check('宿主 /sources 路由已挂上（probe=1）', probe === 200, 'HTTP ' + probe)
  if (probe !== 200) {
    console.log('\n宿主还没重启（新路由未挂载）—— 完整重启桌面版后再跑 --live。')
    try {
      ws.close()
    } catch {}
    process.exit(1)
  }

  const src = await evalIn(`fetch('/plugins/dsh-screen-capture-record-desktop/sources', { cache: 'no-store' }).then((r) => r.json())`)
  console.log('宿主清单：' + JSON.stringify({ virtual: src.virtual, monitors: src.monitors, windows: src.windows.length }))

  const shotRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-screen-capture')
  const before = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []

  // 选一个显示器开录（挑小的那个，录得快）
  const target = src.monitors.slice().sort((a, b) => a.w * a.h - b.w * b.h)[0]
  await evalIn(`document.querySelector('${REC_BTN}').click()`)
  await waitFor('!!document.querySelector("[data-dsh-capture-sources]")', 15000, '选择框出现')
  const picked = await evalIn(`(() => {
    const rows = Array.prototype.slice.call(document.querySelectorAll('[data-dsh-capture-source]'))
    const wants = ${JSON.stringify(target.w + '×' + target.h)}
    const row = rows.filter((r) => r.textContent.indexOf(wants) >= 0 && r.getAttribute('data-dsh-capture-source') === 'monitor')[0] || rows[1]
    row.click()
    return row.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60)
  })()`)
  check('选中显示器并开录', !!picked, picked)

  await waitFor(`document.querySelector('${REC_BTN}').getAttribute('aria-label') === '停止录屏'`, 15000, '按钮进入录制态')

  await new Promise((r) => setTimeout(r, 4000))
  await evalIn(`document.querySelector('${REC_BTN}').click()`) // 停录
  const toast = await waitFor(
    `(() => { const el = document.querySelector('[data-dsh-capture-toast]'); return el ? el.textContent : '' })()`,
    20000,
    '出片提示'
  )
  console.log('toast: ' + JSON.stringify(toast))

  const after = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []
  const fresh = after.filter((x) => before.indexOf(x) < 0 && /\.webm$/.test(x))
  check('产出新的 .webm', fresh.length > 0, fresh.join(', '))

  if (fresh.length) {
    const file = path.join(shotRoot, fresh[0])
    // 用 ffmpeg 抽一帧，看真实帧尺寸是否等于显示器按 maxEdge 缩放后的尺寸
    const { spawnSync } = await import('node:child_process')
    const png = path.join(outDir, 'record-first-frame.png')
    const ff = process.env.E2E_FFMPEG || 'C:\\Program Files\\CP3\\ffmpeg.exe'
    const ffDir = path.dirname(root)
    const r = spawnSync(ff, ['-y', '-i', file, '-frames:v', '1', '-vf', 'scale=iw:ih', png], { encoding: 'utf8', windowsHide: true, timeout: 60000 })
    let size = null
    try {
      const buf = fs.readFileSync(png)
      size = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    } catch (e) {
      size = null
    }
    fs.writeFileSync(path.join(outDir, 'record-info.json'), JSON.stringify({ file, target, toast, size }, null, 2))
    check(
      '首帧尺寸 == 所选显示器（按 maxEdge 缩放）',
      size && Math.abs(size.w - Math.min(target.w, 1280)) <= 4 && Math.abs(size.h - Math.round(target.h * Math.min(1, 1280 / target.w))) <= 6,
      size ? `${size.w}x${size.h}（显示器 ${target.w}x${target.h}）` : '抽帧失败: ' + String(r.stderr || '').slice(-200)
    )
    console.log('E2E_RECORD_FRAME=' + png)
  }
}

const failed = checks.filter((c) => !c).length
console.log('\n==== ' + (checks.length - failed) + '/' + checks.length + ' PASS ====')
try {
  ws.close()
} catch {}
process.exit(failed ? 1 : 0)
