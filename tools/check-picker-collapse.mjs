/**
 * 真浏览器回归：「选择要录制的内容」框打开时，「窗口（N 个）」这一节必须是**收起的**。
 *
 * 为什么单独有这一条：
 *   - 这是用户 2026-10-24 的明确要求（弹框不要一上来铺开一整列窗口）；
 *   - 它只在真 DOM / 真 CSS 里才成立（display / 箭头 / 可见行数），
 *     假 DOM 自检（tools/selftest.mjs）看不出来；
 *   - 不需要 DSH 在跑、也不碰用户界面：起一个 headless Chrome 打开本地桩页面，
 *     用假的宿主路由（/shot、/sources、/record/*）把插件真 bundle 跑起来，
 *     然后像用户那样点「录屏」→ 看选源框 → 点标题展开 → 取消 → 再打开。
 *
 * 用法：node tools/check-picker-collapse.mjs
 *      CHROME_PATH=<chrome/edge 可执行文件> 可覆盖浏览器探测。
 *
 * 产物：.e2e-out/picker-collapsed.png、.e2e-out/picker-expanded.png、picker-harness/。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const outDir = process.env.E2E_OUT || path.join(root, '.e2e-out')
const workDir = path.join(outDir, 'picker-harness')
const profileDir = path.join(outDir, 'chrome-profile-picker')

fs.rmSync(workDir, { recursive: true, force: true })
fs.rmSync(profileDir, { recursive: true, force: true })
fs.mkdirSync(workDir, { recursive: true })
fs.copyFileSync(path.join(root, 'lib', 'client.js'), path.join(workDir, 'client.js'))

// ------------------------------------------------------------------ 桩页面
// 页面里只验客户端：fetch 全部由桩接管，不发真请求、不抓屏、不落盘。
const harnessHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-capture picker harness</title>
<style>
  html, body { margin: 0; height: 100%; background: #f2f3f7; font-family: system-ui, "Segoe UI", sans-serif; }
  #composer { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); display: flex; gap: 8px;
    align-items: center; padding: 10px 14px; background: #fff; border-radius: 14px; box-shadow: 0 8px 30px rgba(0,0,0,.12); }
  #composer button { width: 42px; height: 43px; border: 0; border-radius: 10px; background: #eef0f5; color: #333;
    font-size: 12px; cursor: pointer; }
</style>
</head>
<body>
<div id="composer">
  <button aria-label="添加文件或调用指令">+</button>
  <button aria-label="开始录音" id="dictation">听写</button>
</div>
<script>
  var SOURCES = {
    ok: true,
    virtual: { x: 0, y: 0, w: 3840, h: 2160 },
    monitors: [
      { index: 0, primary: true, x: 0, y: 0, w: 3840, h: 2160, name: "\\\\\\\\.\\\\DISPLAY1" },
      { index: 1, primary: false, x: -1920, y: 0, w: 1920, h: 1080, name: "\\\\\\\\.\\\\DISPLAY2" }
    ],
    windows: [
      { title: "记事本 — 未命名", process: "notepad", x: 100, y: 100, w: 900, h: 600, hwnd: 12345 },
      { title: "计算器", process: "calc", x: 1200, y: 500, w: 400, h: 700, hwnd: 67890 },
      { title: "Windows 资源管理器", process: "explorer", x: 300, y: 200, w: 1100, h: 800, hwnd: 24680 }
    ]
  };
  function jsonResponse(obj) {
    return new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });
  }
  window.fetch = function (url) {
    var u = String(url);
    if (u.indexOf("/shot?probe=1") >= 0) return Promise.resolve(jsonResponse({ ok: true, capable: true, script: "harness" }));
    if (u.indexOf("/sources") >= 0) return Promise.resolve(jsonResponse(SOURCES));
    if (u.indexOf("/shot?") >= 0) return Promise.resolve(new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }), { status: 200 }));
    if (u.indexOf("/record/status") >= 0) return Promise.resolve(jsonResponse({ recording: false, finished: true }));
    if (u.indexOf("/record/start") >= 0) return Promise.resolve(jsonResponse({ ok: true, file: "X:/fake-rec.webm", fps: 5 }));
    if (u.indexOf("/record/stop") >= 0) return Promise.resolve(jsonResponse({ ok: true, file: "X:/fake-rec.webm", bytes: 1, seconds: 1 }));
    return Promise.resolve(jsonResponse({ ok: true }));
  };
  // 缩略图只需要一个「有 width/height」的位图；drawImage 会抛错，但插件自己 try/catch 了。
  window.createImageBitmap = function () {
    return Promise.resolve({ width: 3840, height: 2160, close: function () {} });
  };
  window.__harness = { ready: false, error: null };
  window.__ModuleLoader__ = { load: function (def) { window.__harness.def = def; } };
</script>
<script src="./client.js"></script>
<script>
  try {
    var exp = window.__harness.def.factory(function () { throw new Error("插件不该 require 任何模块"); });
    exp.apply({ slots: { inject: function () {}, register: function () {} } });
    window.__harness.ready = true;
  } catch (e) {
    window.__harness.error = String((e && (e.stack || e.message)) || e);
  }
</script>
</body>
</html>
`
fs.writeFileSync(path.join(workDir, 'index.html'), harnessHtml, 'utf8')

// ------------------------------------------------------------- 找浏览器
function findBrowser() {
  const env = process.env.CHROME_PATH
  const candidates = [
    env,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe')
  ].filter(Boolean)
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c
    } catch (e) {
      /* 下一个 */
    }
  }
  return null
}

const browser = findBrowser()
if (!browser) {
  console.error('找不到 Chrome / Edge：设 CHROME_PATH=<可执行文件> 再跑')
  process.exit(2)
}

// ------------------------------------------------------------- 起浏览器
const chrome = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--window-size=1280,860',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=0',
    'file:///' + path.join(workDir, 'index.html').replace(/\\/g, '/')
  ],
  { stdio: 'ignore', windowsHide: true }
)
let browserExited = false
chrome.on('exit', () => {
  browserExited = true
})

function killBrowser() {
  try {
    if (!browserExited) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch (e) {
    /* 忽略 */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitDevToolsPort(timeoutMs) {
  const active = path.join(profileDir, 'DevToolsActivePort')
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const txt = fs.readFileSync(active, 'utf8').split('\n')
      const port = Number(txt[0])
      if (port > 0) return port
    } catch (e) {
      /* 还没写 */
    }
    await sleep(120)
  }
  throw new Error('等 DevToolsActivePort 超时（浏览器没起来？）')
}

// ------------------------------------------------------------- CDP 客户端
let ws = null
let seq = 0
const pending = new Map()

async function cdp(method, params) {
  const id = ++seq
  const reply = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('CDP 超时：' + method))
      }
    }, 15000)
  })
  ws.send(JSON.stringify({ id, method, params: params || {} }))
  const m = await reply
  if (m.error) throw new Error('CDP 报错：' + method + ' ' + JSON.stringify(m.error))
  return m.result || {}
}

async function evalIn(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('页面里抛错: ' + JSON.stringify(r.exceptionDetails).slice(0, 600))
  return r.result ? r.result.value : undefined
}

async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now()
  for (;;) {
    const v = await evalIn(expr)
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('等超时：' + label)
    await sleep(150)
  }
}

async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'))
  return file
}

// ------------------------------------------------------------- 断言
const checks = []
function check(name, ok, detail) {
  checks.push(!!ok)
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  —— ' + detail : ''))
}

/** 选源框当前状态（收起/展开、箭头、可见窗口行数、卡片高度）。 */
const STATE_EXPR = `(() => {
  const root = document.querySelector('[data-dsh-capture-sources]')
  const card = root ? root.firstElementChild : null
  const sec = document.querySelector('[data-dsh-capture-window-section]')
  const head = document.querySelector('[data-dsh-capture-section="collapsible"]')
  const arrowEl = head ? head.querySelector('[data-dsh-capture-section-arrow]') : null
  const winRows = sec ? Array.prototype.slice.call(sec.querySelectorAll('[data-dsh-capture-source="window"]')) : []
  const screenRow = document.querySelector('[data-dsh-capture-source="all"]')
  return {
    open: !!root,
    display: sec ? getComputedStyle(sec).display : null,
    arrow: arrowEl ? arrowEl.textContent : null,
    headTitle: head ? head.title : null,
    winRowsInDom: winRows.length,
    visibleWinRows: winRows.filter((r) => r.offsetParent !== null).length,
    screenVisible: !!(screenRow && screenRow.offsetParent !== null),
    cardHeight: card ? card.clientHeight : 0
  }
})()`

const REC_BTN = '[data-dsh-capture-rec] button'
const HEAD = '[data-dsh-capture-section="collapsible"]'

async function openPicker() {
  await evalIn(`document.querySelector('${REC_BTN}').click()`)
  await waitFor(`!!document.querySelector('[data-dsh-capture-sources]')`, 15000, '选源框出现')
  // 等一帧，让样式与布局落定
  await sleep(120)
}

let failed = 0
try {
  const port = await waitDevToolsPort(25000)
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!page) throw new Error('没有 page target')

  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('CDP ws 连不上'))
    setTimeout(() => reject(new Error('CDP ws 超时')), 8000)
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve } = pending.get(m.id)
      pending.delete(m.id)
      resolve(m)
    }
  }
  await cdp('Runtime.enable')
  await cdp('Page.enable')

  const harness = await waitFor(`window.__harness ? (window.__harness.ready ? { ready: true } : (window.__harness.error ? { ready: false, error: window.__harness.error } : null)) : null`, 15000, '插件跑起来')
  check('插件 bundle 在页面里加载并 apply 成功', harness && harness.ready === true, harness && harness.error ? harness.error : '')
  await waitFor(`!!document.querySelector('${REC_BTN}')`, 15000, '「录屏」按钮挂上')

  // 1) 打开：窗口列表必须是收起的
  await openPicker()
  const opened = await evalIn(STATE_EXPR)
  check('打开选源框：窗口这一节是收起的（display:none）', opened.display === 'none', 'display=' + opened.display)
  check('打开选源框：箭头是 ▸、tooltip 写「展开窗口列表」', opened.arrow === '▸' && opened.headTitle === '展开窗口列表', 'arrow=' + opened.arrow + ' title=' + opened.headTitle)
  check('收起的只是窗口列表：3 个窗口行仍在 DOM 里但不可见', opened.winRowsInDom === 3 && opened.visibleWinRows === 0, 'inDom=' + opened.winRowsInDom + ' visible=' + opened.visibleWinRows)
  check('屏幕 / 显示器照常显示', opened.screenVisible === true, '')
  const collapsedHeight = opened.cardHeight
  const pngCollapsed = await shot('picker-collapsed.png')

  // 2) 点标题才展开
  await evalIn(`document.querySelector('${HEAD}').click()`)
  await sleep(150)
  const expanded = await evalIn(STATE_EXPR)
  check('点标题展开：显示窗口行、箭头变 ▾', expanded.display === 'block' && expanded.visibleWinRows === 3 && expanded.arrow === '▾', 'visible=' + expanded.visibleWinRows + ' arrow=' + expanded.arrow)
  check('展开后卡片变高（收起确实让弹框更矮）', expanded.cardHeight > collapsedHeight, 'collapsed=' + collapsedHeight + 'px expanded=' + expanded.cardHeight + 'px')
  const pngExpanded = await shot('picker-expanded.png')

  // 3) 取消 → 再打开：又回到收起（不是「记住上次展开」）
  await evalIn(`document.querySelector('[data-dsh-capture-sources-cancel]').click()`)
  await waitFor(`!document.querySelector('[data-dsh-capture-sources]')`, 5000, '取消后选源框关闭')
  await openPicker()
  const reopened = await evalIn(STATE_EXPR)
  check('重新打开仍然是收起的（不沿用上次展开）', reopened.display === 'none' && reopened.arrow === '▸' && reopened.visibleWinRows === 0, 'display=' + reopened.display + ' arrow=' + reopened.arrow)
  await evalIn(`document.querySelector('[data-dsh-capture-sources-cancel]').click()`)

  console.log('\n截图：' + pngCollapsed + '\n      ' + pngExpanded)
} catch (e) {
  failed = 1
  console.error('检查中断：' + ((e && e.message) || e))
} finally {
  try {
    if (ws) ws.close()
  } catch (e) {
    /* 忽略 */
  }
  killBrowser()
}

const bad = checks.filter((c) => !c).length
console.log('\n==== ' + (checks.length - bad) + '/' + checks.length + ' PASS ====')
process.exit(failed || bad ? 1 : 0)
