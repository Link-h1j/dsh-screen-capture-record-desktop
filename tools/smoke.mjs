/**
 * 抓屏路由冒烟测试 —— 不需要 DSH 在跑，也不需要重启。
 *
 * 直接调 lib/index.js 导出的 handleShot()，配上假的 req/res，验证：
 *   1. probe=1        → 200 + {"ok":true,"capable":true}
 *   2. 默认抓屏        → 200 + image/jpeg + JPEG 魔数
 *   3. maxEdge=1440   → 图被真的缩到 1440 以内（解析 JPEG 的 SOF 段拿尺寸）
 *   4. format=png     → 200 + image/png + PNG 魔数
 *   5. maxEdge 越界/乱填 → 不报错（夹到合法范围）
 *   6. apply()        → 假 ctx 验证 inject/effect/register 的接线形状
 *   7. save 落盘路由   → 200 + 文件真的写到 <DSH_HOME>\dsh-screen-capture\<dir>\，且路径被消毒
 *   8. 录屏路由        → record/start 真抓几秒 → record/stop → 产物是**合法 WebM 视频**
 *                        （EBML 魔数 + 文件非空），record/file 能原样取回
 *
 * 用法：node dsh-screen-capture-record-desktop/tools/smoke.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

// 落盘根目录改到工作区：冒烟测试跑在受限沙箱里，工作区是唯一稳妥的写目标。
// （录屏现在是 ffmpeg 写 stdout、宿主 Node 落盘，子进程完全不碰文件。）
const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.DSH_CAPTURE_DIR = path.join(HERE, '..', '..', '_tmp', 'rec-out')

import {
  apply,
  handleRecordFile,
  handleRecordStart,
  handleRecordStop,
  handleSave,
  handleShot
} from '../lib/index.js'

/**
 * 假的 ServerResponse：必须是真正的可写流。
 *
 * 为什么：/record/file 用 `createReadStream(...).pipe(res)` 发视频，pipe 要求目标是
 * 可写流（会调 dest.on/emit）。早先那个只有 writeHead/write/end 的鸭子类型会让
 * pipe 抛 "dest.on is not a function" —— 那是测试替身的缺陷，不是生产 bug
 * （真 ServerResponse 本来就是 Writable）。
 */
function fakeRes() {
  const chunks = []
  const res = new Writable({
    write(chunk, _enc, cb) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      cb()
    }
  })
  res.status = 0
  res.headers = null
  res.writeHead = function (status, headers) {
    res.status = status
    res.headers = headers || {}
    return res
  }
  res.body = () => Buffer.concat(chunks)
  return res
}

/** 假的 IncomingMessage：够 handleShot 用（它只读 url；GET 不读 body）。 */
function fakeReq(url, method = 'GET') {
  return { url, method, on() {}, destroy() {} }
}

/** 从 JPEG 的 SOF 段读出 [宽, 高]。 */
function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++
      continue
    }
    const marker = buf[i + 1]
    const len = buf.readUInt16BE(i + 2)
    // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
    if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)]
    }
    i += 2 + len
  }
  return null
}

const problems = []
function check(label, ok, detail) {
  if (ok) console.log('  ✔ ' + label + (detail ? ' — ' + detail : ''))
  else {
    console.log('  ✘ ' + label + (detail ? ' — ' + detail : ''))
    problems.push(label)
  }
}

async function call(query) {
  const res = fakeRes()
  const started = Date.now()
  await handleShot(fakeReq('/plugins/dsh-screen-capture-record-desktop/shot' + query), res)
  return { res, ms: Date.now() - started }
}

console.log('抓屏路由冒烟测试')

// 1. 探活
{
  const { res, ms } = await call('?probe=1')
  const json = JSON.parse(res.body().toString('utf8'))
  check('probe 返回 200 + capable', res.status === 200 && json.ok === true && json.capable === true, JSON.stringify(json))
  check('probe 很快（<1500ms）', ms < 1500, ms + 'ms')
}

// 2. 默认抓屏（原生分辨率 JPEG）
{
  const { res, ms } = await call('?format=jpg&maxEdge=0&quality=82')
  const buf = res.body()
  check('默认抓屏 200 + image/jpeg', res.status === 200 && res.headers['content-type'] === 'image/jpeg', 'status=' + res.status)
  check('JPEG 魔数 FFD8 / 收尾 FFD9', buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9)
  const size = jpegSize(buf)
  check('能解析出尺寸', !!size, size ? size.join('×') : '解析失败')
  check('原生分辨率没有被缩放（宽度 > 1440）', !!size && size[0] > 1440, size ? size[0] + 'px' : '')
  console.log('    原生抓屏：' + (buf.length / 1024).toFixed(0) + ' KB / ' + ms + 'ms')
}

// 3. 小帧（录屏用）
{
  const { res, ms } = await call('?format=jpg&maxEdge=1440&quality=72')
  const buf = res.body()
  const size = jpegSize(buf)
  check('maxEdge=1440 生效（长边 ≤ 1440）', !!size && Math.max(size[0], size[1]) <= 1440, size ? size.join('×') : '解析失败')
  check('小帧明显更小（< 原生一半）', buf.length < 900 * 1024, (buf.length / 1024).toFixed(0) + ' KB')
  console.log('    1440 抓屏：' + (buf.length / 1024).toFixed(0) + ' KB / ' + ms + 'ms')
}

// 4. PNG
{
  const { res } = await call('?format=png')
  const buf = res.body()
  const pngMagic = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  check('format=png 返回 image/png + PNG 魔数', res.status === 200 && res.headers['content-type'] === 'image/png' && pngMagic)
}

// 5. 乱填参数不该炸
{
  const { res } = await call('?maxEdge=99999&quality=abc')
  check('越界参数被夹住、不报错', res.status === 200 && res.headers['content-type'] === 'image/jpeg', 'status=' + res.status)
}

// 6. apply() 的接线：假 ctx 验证 inject / effect / register 的调用形状
//    （0.1.7 运行时的标准写法见 dsh-client-modules/lib/index.js:546-552）
{
  const calls = []
  const fakeWebServer = {
    register(route) {
      calls.push(route)
      return () => {}
    }
  }
  const fakeWebCtx = {
    webServer: fakeWebServer,
    effect(fn) {
      fn()
      return () => {}
    }
  }
  const ctx = {
    inject(deps, cb) {
      if (deps.indexOf('webServer') !== -1) cb(fakeWebCtx)
    }
  }

  apply(ctx)
  check(
    'apply 挂上全部 5 条 prefix 路由（shot/save/record×3）',
    calls.length === 5 &&
      calls.every((c) => c.kind === 'prefix') &&
      calls[0].path === '/plugins/dsh-screen-capture-record-desktop/shot' &&
      calls[1].path === '/plugins/dsh-screen-capture-record-desktop/save' &&
      calls[2].path === '/plugins/dsh-screen-capture-record-desktop/record/start' &&
      calls[3].path === '/plugins/dsh-screen-capture-record-desktop/record/stop' &&
      calls[4].path === '/plugins/dsh-screen-capture-record-desktop/record/file',
    JSON.stringify(calls.map((c) => c.path))
  )
  check(
    'handler 分别正确',
    calls[0].handler === handleShot &&
      calls[1].handler === handleSave &&
      calls[2].handler === handleRecordStart &&
      calls[3].handler === handleRecordStop &&
      calls[4].handler === handleRecordFile
  )

  apply(ctx)
  check('重复 apply 只挂一次（不会撞 duplicate route）', calls.length === 5, 'calls=' + calls.length)
}

// 7. 落盘路由：POST 一段字节，验证文件真的落盘 + 路径消毒
{
  const dir = 'smoke-' + Date.now()
  const payload = Buffer.from('fake-jpeg-bytes-for-smoke')

  const post = (url, body) => {
    const handlers = {}
    const req = {
      url,
      method: 'POST',
      on(ev, cb) {
        ;(handlers[ev] = handlers[ev] || []).push(cb)
        return req
      },
      destroy() {}
    }
    setImmediate(() => {
      for (const cb of handlers.data || []) cb(body)
      for (const cb of handlers.end || []) cb()
    })
    return req
  }

  const res = fakeRes()
  await handleSave(
    post('/plugins/dsh-screen-capture-record-desktop/save?dir=' + dir + '&file=frame-01.jpg', payload),
    res
  )
  const json = JSON.parse(res.body().toString('utf8'))
  check('save 返回 200 + ok', res.status === 200 && json.ok === true, JSON.stringify(json).slice(0, 120))
  check('文件真的落盘且字节一致', !!json.file && fs.existsSync(json.file) && fs.readFileSync(json.file).equals(payload))
  check('落在配置的落盘根目录下', !!json.dir && json.dir.startsWith(process.env.DSH_CAPTURE_DIR))

  // 消毒：路径分隔符与 .. 都不该逃出目录
  const res2 = fakeRes()
  await handleSave(
    post('/plugins/dsh-screen-capture-record-desktop/save?dir=..%2F..%2Fevil&file=..%2Fpwn.jpg', Buffer.from('x')),
    res2
  )
  const json2 = JSON.parse(res2.body().toString('utf8'))
  const base = process.env.DSH_CAPTURE_DIR
  const rel = json2.file ? path.relative(base, json2.file) : ''
  check(
    '路径消毒：仍在 base 下、且只有「目录\\文件」两段',
    res2.status === 200 &&
      !!rel &&
      !rel.startsWith('..') &&
      !path.isAbsolute(rel) &&
      rel.split(path.sep).length === 2,
    rel
  )

  // 清理
  try {
    fs.rmSync(path.join(base, dir), { recursive: true, force: true })
    if (json2.dir) fs.rmSync(json2.dir, { recursive: true, force: true })
  } catch (e) {
    /* 清理失败无所谓 */
  }
}

// 8. 没在录时 stop 应 404，而不是假装成功
{
  const res = fakeRes()
  await handleRecordStop(fakeReq('/plugins/dsh-screen-capture-record-desktop/record/stop', 'POST'), res)
  check('无录制时 record/stop 返回 404', res.status === 404, 'status=' + res.status)
}

// 9. 录屏路由：真抓几秒 → 真 WebM 视频
{
  const startRes = fakeRes()
  await handleRecordStart(
    fakeReq('/plugins/dsh-screen-capture-record-desktop/record/start?fps=5&maxEdge=640&quality=60&seconds=20', 'POST'),
    startRes
  )
  const started = JSON.parse(startRes.body().toString('utf8'))
  check(
    'record/start 200 + 给出了 .webm 目标路径',
    startRes.status === 200 && started.ok === true && /\.webm$/.test(started.file || ''),
    JSON.stringify(started).slice(0, 150)
  )

  await new Promise((r) => setTimeout(r, 2500))

  const stopRes = fakeRes()
  await handleRecordStop(fakeReq('/plugins/dsh-screen-capture-record-desktop/record/stop', 'POST'), stopRes)
  const stopped = JSON.parse(stopRes.body().toString('utf8'))
  check(
    'record/stop 200 + bytes > 0',
    stopRes.status === 200 && stopped.ok === true && stopped.bytes > 0,
    'bytes=' + (stopped && stopped.bytes) + ' seconds=' + (stopped && stopped.seconds)
  )

  let buf = null
  if (stopped.file && fs.existsSync(stopped.file)) buf = fs.readFileSync(stopped.file)
  const ebml = !!buf && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
  check('产物是合法 WebM（EBML 魔数 1A45DFA3）', ebml, buf ? buf.slice(0, 4).toString('hex') + ' ' + buf.length + 'B' : 'no file')

  // /record/file 应能原样取回
  const fileRes = fakeRes()
  handleRecordFile(fakeReq('/plugins/dsh-screen-capture-record-desktop/record/file', 'GET'), fileRes)
  await new Promise((r) => setTimeout(r, 400))
  const fetched = fileRes.body()
  check(
    'record/file 返回 video/webm 且与原文件一致',
    fileRes.headers && fileRes.headers['content-type'] === 'video/webm' && !!buf && fetched.equals(buf),
    (fileRes.headers && fileRes.headers['content-type']) +
      ' ' + fetched.length + 'B body=' + fetched.toString('utf8').slice(0, 120)
  )

  if (stopped.file) console.log('    录像：' + stopped.file)
}

if (problems.length) {
  console.error('\nSMOKE FAIL（' + problems.length + ' 项）')
  problems.forEach((p) => console.error(' - ' + p))
  process.exit(1)
}
console.log('\nSMOKE OK：抓屏路由可用')
