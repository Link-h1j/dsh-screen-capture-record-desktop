/**
 * 端到端验收：在**真实跑着的 DSH 桌面版**里走一遍「截图 → 拖框选 → 松手立刻能用画笔
 * → 画一笔 → 用这张」，全程用 CDP 的合成 PointerEvent 驱动，不碰用户的物理鼠标。
 *
 * 前置：DSH 桌面版带着 --remote-debugging-port=9222 在跑（本机已有）。
 * 用法：node tools/e2e-annotate.mjs [--keep-open]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = process.env.E2E_OUT || path.join(root, '.e2e-out')
fs.mkdirSync(outDir, { recursive: true })

const port = process.env.DSH_CDP_PORT || '9222'
const base = 'http://127.0.0.1:' + port

const list = await (await fetch(base + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('没有 page target：' + JSON.stringify(list.map((t) => t.type)))
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
  if (res.exceptionDetails) {
    throw new Error('页面里抛错: ' + JSON.stringify(res.exceptionDetails).slice(0, 600))
  }
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
  checks.push({ name, ok: !!ok, detail })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  —— ' + detail : ''))
}

await send('Runtime.enable', {})
await send('Page.enable', {})

// ---- 1. 找到截图按钮 ----
// 属性同时挂在外层 host span 和里面的 button 上，querySelector 命中的是 span（点了没反应），
// 所以必须指名 button。
const SHOT = 'button[data-dsh-capture-shot]'
const hasBtn = await evalIn('!!document.querySelector(' + JSON.stringify(SHOT) + ')')
check('页面上有截图按钮', hasBtn, hasBtn ? '' : '插件没挂上或页面没刷新')

// 记录截图产物目录的当前状态
const shotRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'dsh-screen-capture')
const before = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []

// ---- 2. 点截图 ----
await evalIn('(() => { document.querySelector(' + JSON.stringify(SHOT) + ').click(); return 1 })()')
await waitFor('!!document.querySelector("[data-dsh-capture-overlay]")', 15000, '截图浮层出现')
const initial = await evalIn(`(() => {
  const tools = document.querySelector('[data-dsh-capture-tools]')
  return {
    hasStage: !!document.querySelector('[data-dsh-capture-stage]'),
    toolsHidden: getComputedStyle(tools).display === 'none',
    hint: document.querySelector('[data-dsh-capture-hint]').textContent
  }
})()`)
check('浮层里起初没有工具栏（还在选区态）', initial.toolsHidden, initial.hint)

// ---- 3. 拖框选：松手那一刻工具栏就该出现 ----
const dragResult = await evalIn(`(() => {
  const stage = document.querySelector('[data-dsh-capture-stage]')
  const ann = document.querySelector('[data-dsh-capture-annotate]')
  const r = stage.getBoundingClientRect()
  const P = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy })
  const fire = (type, p, extra) => ann.dispatchEvent(new PointerEvent(type, Object.assign({
    clientX: p.x, clientY: p.y, button: 0, buttons: 1, bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true
  }, extra || {})))
  const a = P(0.18, 0.22)
  const b = P(0.72, 0.62)
  fire('pointerdown', a)
  for (let i = 1; i <= 8; i++) fire('pointermove', { x: a.x + (b.x - a.x) * i / 8, y: a.y + (b.y - a.y) * i / 8 })
  fire('pointerup', b, { buttons: 0 })
  const tools = document.querySelector('[data-dsh-capture-tools]')
  const sel = document.querySelector('[data-dsh-capture-sel]')
  return {
    toolsDisplay: getComputedStyle(tools).display,
    hint: document.querySelector('[data-dsh-capture-hint]').textContent,
    selBox: sel.style.width + 'x' + sel.style.height,
    penOn: document.querySelector('[data-tool="pen"]').getAttribute('data-on'),
    stageRect: { left: r.left, top: r.top, width: r.width, height: r.height }
  }
})()`)
check(
  '松手即出工具栏（不用再确认一次）',
  dragResult.toolsDisplay !== 'none',
  'tools.display=' + dragResult.toolsDisplay + ' / 选区=' + dragResult.selBox
)
check('画笔默认选中', dragResult.penOn === '1', 'hint=' + dragResult.hint)

// ---- 4. 直接在选区里画一笔，并检查画布真的落墨 ----
const paint = await evalIn(`(() => {
  const ann = document.querySelector('[data-dsh-capture-annotate]')
  const r = ann.getBoundingClientRect()
  const P = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy })
  const fire = (type, p, extra) => ann.dispatchEvent(new PointerEvent(type, Object.assign({
    clientX: p.x, clientY: p.y, button: 0, buttons: 1, bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true
  }, extra || {})))
  const a = P(0.30, 0.36)
  const b = P(0.58, 0.52)
  fire('pointerdown', a)
  for (let i = 1; i <= 12; i++) fire('pointermove', { x: a.x + (b.x - a.x) * i / 12, y: a.y + (b.y - a.y) * i / 12 + Math.sin(i) * 4 })
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, buttons: 0, pointerId: 1 }))
  const d = ann.getContext('2d').getImageData(0, 0, ann.width, ann.height).data
  let painted = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) painted++
  return { painted, canvas: ann.width + 'x' + ann.height }
})()`)
check('拖完框选后立刻能画（画布落墨）', paint.painted > 200, '落墨像素=' + paint.painted)

// ---- 5. 留一张浮层截图给用户看 ----
const shot = await send('Page.captureScreenshot', { format: 'png' })
const pngPath = path.join(outDir, 'overlay-toolbar.png')
fs.writeFileSync(pngPath, Buffer.from(shot.result.data, 'base64'))
console.log('overlay screenshot: ' + pngPath)

// ---- 6. 用这张 → 出图 ----
await evalIn('(() => { document.querySelector("[data-dsh-capture-ok]").click(); return 1 })()')
await waitFor('!document.querySelector("[data-dsh-capture-overlay]")', 10000, '浮层关闭')
const toast = await waitFor(
  `(() => { const el = document.querySelector('[data-dsh-capture-toast]'); return el ? el.textContent : '' })()`,
  10000,
  '出图提示'
)

await new Promise((r) => setTimeout(r, 800))
const after = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []
const fresh = after.filter((x) => before.indexOf(x) < 0)
check('有新的截图产物落盘', fresh.length > 0, fresh.join(', '))

let savedImage = ''
if (fresh.length) {
  const dir = path.join(shotRoot, fresh[0])
  try {
    const files = fs.statSync(dir).isDirectory() ? fs.readdirSync(dir).map((f) => path.join(dir, f)) : [dir]
    const jpg = files.find((f) => /\.(jpg|jpeg)$/i.test(f)) || files[0]
    if (jpg && fs.existsSync(jpg)) {
      savedImage = path.join(outDir, 'annotated-result.jpg')
      fs.copyFileSync(jpg, savedImage)
    }
  } catch (e) {
    /* 忽略 */
  }
}

console.log('toast: ' + JSON.stringify(toast))
console.log('fresh artifacts: ' + JSON.stringify(fresh))
if (savedImage) console.log('annotated result copy: ' + savedImage)

// ---- 7. 第二轮：重选区域 / Esc 取消 ----
const round2Before = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []
await evalIn('(() => { document.querySelector(' + JSON.stringify(SHOT) + ').click(); return 1 })()')
await waitFor('!!document.querySelector("[data-dsh-capture-overlay]")', 15000, '第二轮浮层出现')

const ROUND2_DRAG = `(() => {
  const stage = document.querySelector('[data-dsh-capture-stage]')
  const ann = document.querySelector('[data-dsh-capture-annotate]')
  const r = stage.getBoundingClientRect()
  const P = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy })
  const fire = (type, p, extra) => ann.dispatchEvent(new PointerEvent(type, Object.assign({
    clientX: p.x, clientY: p.y, button: 0, buttons: 1, bubbles: true, cancelable: true,
    pointerId: 1, pointerType: 'mouse', isPrimary: true
  }, extra || {})))
  return { P, fire, r }
})()`

// 先框一块 → 再点「重选区域」→ 应该回到选区态
const reselect = await evalIn(`(() => {
  const { P, fire } = ${ROUND2_DRAG}
  const a = P(0.2, 0.3), b = P(0.6, 0.7)
  fire('pointerdown', a)
  fire('pointermove', b)
  fire('pointerup', b, { buttons: 0 })
  const beforeTools = getComputedStyle(document.querySelector('[data-dsh-capture-tools]')).display
  document.querySelector('[data-dsh-capture-reselect]').click()
  return {
    afterDrag: beforeTools,
    afterReselect: getComputedStyle(document.querySelector('[data-dsh-capture-tools]')).display,
    hint: document.querySelector('[data-dsh-capture-hint]').textContent
  }
})()`)
check('「重选区域」能回到选区态', reselect.afterDrag === 'flex' && reselect.afterReselect === 'none', 'hint=' + reselect.hint)

// 再框一次 → 工具栏回来；然后 Esc 取消，不该留产物
const cancel = await evalIn(`(() => {
  const { P, fire } = ${ROUND2_DRAG}
  const a = P(0.35, 0.25), b = P(0.62, 0.55)
  fire('pointerdown', a)
  fire('pointermove', b)
  fire('pointerup', b, { buttons: 0 })
  const toolsBack = getComputedStyle(document.querySelector('[data-dsh-capture-tools]')).display
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return { toolsBack, overlayGone: !document.querySelector('[data-dsh-capture-overlay]') }
})()`)
check('重选后再框一次工具栏又回来', cancel.toolsBack === 'flex', 'tools.display=' + cancel.toolsBack)
check('Esc 取消后浮层退出', cancel.overlayGone, '')

await new Promise((r) => setTimeout(r, 800))
const round2After = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []
const round2Fresh = round2After.filter((x) => round2Before.indexOf(x) < 0)
check('取消的那轮没有产物落盘', round2Fresh.length === 0, round2Fresh.join(', '))

// 兜底：万一还有浮层挂在页面上，按 Esc 关掉，别把用户的屏幕盖住
const leftOpen = await evalIn(`(() => {
  const o = document.querySelector('[data-dsh-capture-overlay]')
  if (o) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  return !!o
})()`)
if (leftOpen) console.log('（清掉了测试期间残留的浮层）')

// ---- 8. 回归：annotate=0 时退化成「拖框 + 用这张」，且不出现工具栏 ----
if (!process.argv.includes('--skip-fallback')) {
  const flagBefore = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []
  await evalIn(`localStorage.setItem('dsh-capture.annotate', '0')`)
  await send('Page.reload', { ignoreCache: false })
  await waitFor(`!!document.querySelector('${SHOT}')`, 20000, '重载后按钮回来')
  await evalIn(`document.querySelector('${SHOT}').click()`)
  await waitFor('!!document.querySelector("[data-dsh-capture-overlay]")', 15000, 'annotate=0 的浮层出现')
  const fb = await evalIn(`(() => {
    const stage = document.querySelector('[data-dsh-capture-stage]')
    const ann = document.querySelector('[data-dsh-capture-annotate]')
    const r = stage.getBoundingClientRect()
    const P = (fx, fy) => ({ x: r.left + r.width * fx, y: r.top + r.height * fy })
    const fire = (type, p, extra) => ann.dispatchEvent(new PointerEvent(type, Object.assign({
      clientX: p.x, clientY: p.y, button: 0, buttons: 1, bubbles: true, cancelable: true,
      pointerId: 1, pointerType: 'mouse', isPrimary: true
    }, extra || {})))
    const a = P(0.25, 0.25), b = P(0.6, 0.6)
    fire('pointerdown', a); fire('pointermove', b); fire('pointerup', b, { buttons: 0 })
    return {
      toolsDisplay: getComputedStyle(document.querySelector('[data-dsh-capture-tools]')).display,
      hint: document.querySelector('[data-dsh-capture-hint]').textContent
    }
  })()`)
  check('annotate=0 时松手不出工具栏（老行为）', fb.toolsDisplay === 'none', 'hint=' + fb.hint)
  await evalIn('document.querySelector("[data-dsh-capture-ok]").click()')
  await waitFor('!document.querySelector("[data-dsh-capture-overlay]")', 10000, 'annotate=0 出图后浮层关闭')
  await new Promise((r) => setTimeout(r, 800))
  const flagAfter = fs.existsSync(shotRoot) ? fs.readdirSync(shotRoot) : []
  const fbFresh = flagAfter.filter((x) => flagBefore.indexOf(x) < 0)
  check('annotate=0 也能出图', fbFresh.length > 0, fbFresh.join(', '))

  await evalIn(`localStorage.removeItem('dsh-capture.annotate')`)
  await send('Page.reload', { ignoreCache: false })
  await waitFor(`!!document.querySelector('${SHOT}')`, 20000, '恢复后按钮回来')
  const restored = await evalIn(`localStorage.getItem('dsh-capture.annotate')`)
  check('恢复默认开关', restored === null, 'localStorage=' + String(restored))
}

const failed = checks.filter((c) => !c.ok)
console.log('\n==== ' + (checks.length - failed.length) + '/' + checks.length + ' PASS ====')
if (savedImage) console.log('E2E_RESULT_IMAGE=' + savedImage)
if (pngPath) console.log('E2E_OVERLAY_IMAGE=' + pngPath)

try {
  ws.close()
} catch {}
process.exit(failed.length ? 1 : 0)
