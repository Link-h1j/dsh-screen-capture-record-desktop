/**
 * 宿主侧验收：截图的「隐藏DSH界面」（`/shot?...&hideDsh=1`）。
 *
 * 不需要 CDP / 页面，检查：
 *   1. 普通抓屏：200 + 响应头 `x-dsh-capture-hidden: 0`；
 *   2. 隐藏抓屏：200 + `x-dsh-capture-hidden: 1`（真把 DSH 窗口藏了），
 *      且 `x-dsh-capture-restored: 1`（抓完恢复成功）；
 *   3. 抓完窗口真的回到可见，且最大化状态被还原。
 *
 * 两种模式：
 *
 *   A. 打真宿主路由（推荐，要求桌面版已完整重启、路由是新的）：
 *        node tools/check-window-hide.mjs --url http://127.0.0.1:61087
 *        DSH_WEB_URL=http://127.0.0.1:61087 node tools/check-window-hide.mjs
 *
 *   B. 直调宿主处理函数（宿主还没重启、或想在 CI 里跑时用）：
 *        node tools/check-window-hide.mjs --pid 47716
 *      `--pid` = 桌面版 Electron 主进程 pid（任务管理器里 DeepSeek Harness.exe 的父进程）。
 *      本脚本会用自己的进程 import lib/index.js，通过 DSH_CAPTURE_WINDOW_PID 指向桌面版，
 *      所以不依赖正在运行的宿主进程，也不会改 profile。
 *
 * 说明：
 *   - `/plugins/...` 路由不做页面鉴权（只有首页要），所以 A 模式直接 fetch 即可；
 *   - 两种模式都会让 DSH 窗口**真实地闪一下**（约 1 秒）—— 这就是功能本身，不是 bug；
 *   - 老宿主（没重启、还没有 hideDsh 参数）会缺响应头：A 模式算 FAIL 并提示重启。
 */

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const WINDOW_SCRIPT = path.join(root, 'lib', 'window.ps1')

const args = process.argv.slice(2)
function argOf(name) {
  const i = args.indexOf('--' + name)
  return i >= 0 ? args[i + 1] : undefined
}

const checks = []
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok })
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  -- ' + detail : ''))
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function pickPowerShell() {
  if (process.env.DSH_CAPTURE_POWERSHELL) return process.env.DSH_CAPTURE_POWERSHELL
  const win = process.env.SystemRoot
    ? process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
    : null
  return win || 'powershell.exe'
}

/** 用窗口脚本查 DSH 主窗口状态（面积最大的那个）。 */
function windowState(ownerPid, tag) {
  const r = spawnSync(
    pickPowerShell(),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WINDOW_SCRIPT, '-Action', 'state', '-OwnerPid', String(ownerPid)],
    { encoding: 'utf8', windowsHide: true }
  )
  const lines = String(r.stdout || '').trim().split(/\r?\n/)
  let json = null
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      json = JSON.parse(lines[i])
      break
    } catch (e) {
      /* 继续往上找 */
    }
  }
  const main = json && (json.windows || []).slice().sort((a, b) => (b.area || 0) - (a.area || 0))[0]
  console.log(tag + ' ' + JSON.stringify(main))
  return main
}

/** 走真宿主路由。返回 { status, hidden, restored, bytes, ms }。 */
async function shotViaRoute(route, query) {
  const t0 = Date.now()
  const res = await fetch(route + '/shot?' + query + '&ts=' + Date.now(), { cache: 'no-store' })
  const buf = Buffer.from(await res.arrayBuffer())
  return {
    status: res.status,
    hidden: res.headers.get('x-dsh-capture-hidden'),
    restored: res.headers.get('x-dsh-capture-restored'),
    bytes: buf,
    ms: Date.now() - t0
  }
}

/** 直调 lib/index.js 的 handleShot（假 req/res，与 tools/smoke.mjs 同一套路）。 */
async function loadHandleShot(ownerPid) {
  process.env.DSH_CAPTURE_WINDOW_PID = String(ownerPid)
  const mod = await import(pathToFileURL(path.join(root, 'lib', 'index.js')).href)
  return async function shotViaHandler(query) {
    const chunks = []
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers || {}
      },
      end(buf) {
        if (buf) chunks.push(buf)
      }
    }
    const req = {
      url: '/plugins/dsh-screen-capture-record-desktop/shot?' + query,
      method: 'GET',
      on() {},
      destroy() {}
    }
    const t0 = Date.now()
    await mod.handleShot(req, res)
    return {
      status: res.status,
      hidden: res.headers['x-dsh-capture-hidden'],
      restored: res.headers['x-dsh-capture-restored'],
      bytes: Buffer.concat(chunks),
      ms: Date.now() - t0
    }
  }
}

async function main() {
  const explicitPid = Number(argOf('pid') || 0)
  const pid = explicitPid || Number(process.env.DSH_CAPTURE_WINDOW_PID || 0)
  const base = (argOf('url') || process.env.DSH_WEB_URL || process.env.DSH_CAPTURE_URL || '').replace(/\/+$/, '')

  let shot
  let ownerPid
  let modeLabel

  // 显式 --pid 优先：它表达的就是「直调处理函数」，不能被环境里的 DSH_WEB_URL 抢走
  if (explicitPid <= 0 && base) {
    const ROUTE = base + '/plugins/dsh-screen-capture-record-desktop'
    console.log('模式 A（真宿主路由）: ' + ROUTE)
    // 先从路由拿窗口清单 → 顺带确认宿主挂上了 /window
    let state
    try {
      const res = await fetch(ROUTE + '/window?ts=' + Date.now(), { cache: 'no-store' })
      state = await res.json()
    } catch (e) {
      check('GET /window 可用', false, String((e && e.message) || e))
      finish()
      return
    }
    check('GET /window 可用（宿主已挂上窗口路由）', state && state.ok === true, 'ok=' + (state && state.ok))
    ownerPid = state && state.parentPid
    check('找到 DSH 主窗口进程 pid', !!ownerPid, String(ownerPid))
    shot = function (query) {
      return shotViaRoute(ROUTE, query)
    }
    modeLabel = 'http'
  } else if (pid > 0) {
    console.log('模式 B（直调 handleShot），DSH 主进程 pid=' + pid)
    ownerPid = pid
    shot = await loadHandleShot(pid)
    modeLabel = 'handler'
  } else {
    console.error('用法：')
    console.error('  node tools/check-window-hide.mjs --url http://127.0.0.1:<端口>   # 打真宿主路由')
    console.error('  node tools/check-window-hide.mjs --pid <桌面版主进程pid>        # 直调处理函数')
    console.error('（端口 = 桌面版 GUI 地址的端口；也可以用 DSH_WEB_URL 传同样的地址）')
    process.exit(2)
  }

  const before = windowState(ownerPid, 'BEFORE')
  check('主窗口当前可见', before && before.visible === true, JSON.stringify(before))
  if (!before || before.visible !== true) {
    finish()
    return
  }

  const normal = await shot('maxEdge=640&quality=50')
  check('普通抓屏 200 且是图片', normal.status === 200 && normal.bytes.length > 1000, 'status=' + normal.status + ' bytes=' + normal.bytes.length)
  check('普通抓屏响应头 hidden=0', normal.hidden === '0', String(normal.hidden))
  check('普通抓屏响应头 restored=1', normal.restored === '1', String(normal.restored))

  const hidden = await shot('maxEdge=640&quality=50&hideDsh=1')
  check(
    '隐藏抓屏 200 且是图片',
    hidden.status === 200 && hidden.bytes.length > 1000,
    'status=' + hidden.status + ' bytes=' + hidden.bytes.length + ' ms=' + hidden.ms
  )
  check('隐藏抓屏响应头 hidden=1（真把 DSH 藏掉了）', hidden.hidden === '1', String(hidden.hidden))
  check('隐藏抓屏响应头 restored=1（窗口恢复成功）', hidden.restored === '1', String(hidden.restored))
  check(
    '隐藏抓屏是一张合法 JPEG',
    hidden.bytes.length > 1000 && hidden.bytes[0] === 0xff && hidden.bytes[1] === 0xd8,
    'magic=' + hidden.bytes.slice(0, 2).toString('hex')
  )

  await sleep(350)
  const after = windowState(ownerPid, 'AFTER')
  check('抓完主窗口可见', after && after.visible === true, JSON.stringify(after))
  check('最大化状态被还原', !!before.zoomed === !!after.zoomed, 'before=' + before.zoomed + ' after=' + after.zoomed)

  console.log('\n模式: ' + modeLabel + '（隐藏期间屏幕会闪一下，属正常）')
  finish()
}

function finish() {
  const failed = checks.filter((c) => !c.ok)
  console.log('\nSUMMARY ' + failed.length + ' failed / ' + checks.length)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL 验收脚本异常: ' + ((e && e.stack) || e))
  process.exit(1)
})
