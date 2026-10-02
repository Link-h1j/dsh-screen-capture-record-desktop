/**
 * 离线自检：在假 DOM 里跑一遍 lib/client.body.js。
 *
 * 目的不是模拟完整浏览器，而是抓「加载就炸」这类会拖垮宿主的错：
 *   - factory 里 require / 顶层代码是否抛错；
 *   - apply(ctx) 是否能跑完不抛；
 *   - 找不到锚点时是否安静退出（找得到时要能插出两个按钮）。
 *
 * 用法：node tools/selftest.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const bodyFile = process.env.SELFTEST_BODY || 'lib/client.body.js'
const body = fs.readFileSync(path.join(root, bodyFile), 'utf8')

// ------------------------------------------------------------------ 假 DOM

class FakeClassList {
  constructor() {
    this.set = new Set()
  }
  add(...names) {
    names.forEach((n) => this.set.add(n))
  }
  remove(...names) {
    names.forEach((n) => this.set.delete(n))
  }
  contains(name) {
    return this.set.has(name)
  }
}

let nodeSeq = 0
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || '').toUpperCase()
    this.nodeName = this.tagName
    this.attributes = new Map()
    this.children = []
    this.parentNode = null
    this.style = { cssText: '' }
    this.classList = new FakeClassList()
    this.listeners = new Map()
    this.textContent = ''
    this.innerHTML = ''
    this.__id = ++nodeSeq
    this.isConnected = true
    this.files = null
    this.value = ''
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }
  hasAttribute(name) {
    return this.attributes.has(name)
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  get className() {
    return Array.from(this.classList.set).join(' ')
  }
  set className(value) {
    this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean))
  }
  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }
  insertBefore(child, ref) {
    child.parentNode = this
    const idx = ref ? this.children.indexOf(ref) : -1
    if (idx === -1) this.children.push(child)
    else this.children.splice(idx, 0, child)
    return child
  }
  removeChild(child) {
    const idx = this.children.indexOf(child)
    if (idx !== -1) this.children.splice(idx, 1)
    child.parentNode = null
    return child
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type)
    if (!list) return
    const idx = list.indexOf(fn)
    if (idx !== -1) list.splice(idx, 1)
  }
  dispatch(type, event) {
    const list = this.listeners.get(type) || []
    list.forEach((fn) => fn(event || { type, preventDefault() {}, stopPropagation() {} }))
  }
  getBoundingClientRect() {
    return { left: 100, top: 500, right: 142, bottom: 543, width: 42, height: 43 }
  }
  get nextElementSibling() {
    if (!this.parentNode) return null
    const list = this.parentNode.children
    const idx = list.indexOf(this)
    return idx === -1 || idx + 1 >= list.length ? null : list[idx + 1]
  }
  get previousElementSibling() {
    if (!this.parentNode) return null
    const list = this.parentNode.children
    const idx = list.indexOf(this)
    return idx <= 0 ? null : list[idx - 1]
  }
  querySelector() {
    return null
  }
  querySelectorAll() {
    return []
  }
  get firstElementChild() {
    return this.children[0] || null
  }
}

const documentRoot = new FakeNode('html')
const bodyEl = new FakeNode('body')
documentRoot.appendChild(bodyEl)

/** 注册进「文档」的所有元素，供 querySelectorAll 用。 */
const allNodes = []
function register(node) {
  allNodes.push(node)
  return node
}

/** 递归收集节点树（假 DOM 没实现真实的 querySelector 遍历）。 */
function collectTree(node, out) {
  out.push(node)
  node.children.forEach((child) => collectTree(child, out))
  return out
}

/** 只支持单条简单选择器（tag、[attr]、tag[attr]）。 */
function matchesSimple(node, selector) {
  const trimmed = selector.trim()
  if (!trimmed) return false
  let rest = trimmed
  const tagMatch = /^[a-zA-Z]+/.exec(rest)
  if (tagMatch) {
    if (node.tagName !== tagMatch[0].toUpperCase()) return false
    rest = rest.slice(tagMatch[0].length)
  }
  const attrRe = /\[([a-zA-Z-]+)(?:=["']?([^"'\]]*)["']?)?\]/g
  let m
  let sawAttr = false
  while ((m = attrRe.exec(rest)) !== null) {
    sawAttr = true
    const name = m[1]
    if (!node.hasAttribute(name)) return false
    if (m[2] !== undefined && node.getAttribute(name) !== m[2]) return false
  }
  if (!tagMatch && !sawAttr) return false
  return true
}

function matchesSelector(node, selector) {
  // 选择器分组（逗号）要按「任一命中」处理，否则假 DOM 比真浏览器更严格，
  // 会误报插件有 bug。
  return selector.split(',').some((part) => matchesSimple(node, part))
}

function documentQueryAll(selector) {
  return collectTree(documentRoot, []).filter((n) => matchesSelector(n, selector))
}

const fakeDocument = {
  documentElement: documentRoot,
  body: bodyEl,
  head: new FakeNode('head'),
  hidden: false,
  createElement: (tag) => register(new FakeNode(tag)),
  createElementNS: (ns, tag) => register(new FakeNode(tag)),
  querySelector: (selector) => documentQueryAll(selector)[0] || null,
  querySelectorAll: (selector) => documentQueryAll(selector),
  addEventListener() {},
  removeEventListener() {},
  execCommand() {
    return false
  }
}

// ------------------------------------------------------- 造一个 composer

const composerRow = register(new FakeNode('div'))
const tools = register(new FakeNode('div'))
const plusButton = register(new FakeNode('button'))
plusButton.setAttribute('aria-label', '添加文件或调用指令')
const dictation = register(new FakeNode('button'))
dictation.setAttribute('aria-label', '开始录音')
tools.appendChild(plusButton)
tools.appendChild(dictation)
composerRow.appendChild(tools)
bodyEl.appendChild(composerRow)

const hiddenFileInput = register(new FakeNode('input'))
hiddenFileInput.setAttribute('type', 'file')
bodyEl.appendChild(hiddenFileInput)

// ------------------------------------------------------------ 跑插件

const sandbox = {
  console,
  document: fakeDocument,
  window: {},
  navigator: { mediaDevices: undefined },
  localStorage: {
    store: new Map(),
    getItem(k) {
      return this.store.has(k) ? this.store.get(k) : null
    },
    setItem(k, v) {
      this.store.set(k, String(v))
    },
    removeItem(k) {
      this.store.delete(k)
    }
  },
  setTimeout,
  clearTimeout,
  setInterval() {
    return 0
  },
  clearInterval() {},
  requestAnimationFrame(fn) {
    setTimeout(fn, 0)
    return 0
  },
  cancelAnimationFrame() {},
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  Event: class {
    constructor(type) {
      this.type = type
    }
  },
  DataTransfer: class {
    constructor() {
      this.items = { add() {} }
      this.files = []
    }
  },
  File: class {
    constructor(parts, name, opts) {
      this.parts = parts
      this.name = name
      this.type = (opts && opts.type) || ''
      this.size = 1024
    }
  },
  Blob: class {},
  // 浏览器里 fetch 是全局的；沙箱里不给它，apply() 会立刻 ReferenceError，
  // 于是「插不出按钮」这种自检结论全是假阳性（2026-10-02 修）。
  // 这里给一个永远 reject 的替身：走完「宿主路由不可用」这条真实失败分支。
  fetch: () => Promise.reject(new Error('selftest: no network')),
  URL,
  Promise,
  Math,
  Date,
  Number,
  String,
  Object,
  Array,
  JSON,
  RegExp,
  Error,
  Symbol,
  isFinite
}
sandbox.globalThis = sandbox
sandbox.window = sandbox
sandbox.self = sandbox

const context = vm.createContext(sandbox)

const moduleObject = { exports: {} }
const requireShim = (specifier) => {
  throw new Error('本插件不应 require 任何模块，收到: ' + specifier)
}

const wrapper = new vm.Script(
  '(function (module, exports, require) {\n' + body + '\n})',
  { filename: 'client.body.js' }
)
const factory = wrapper.runInContext(context)
factory(moduleObject, moduleObject.exports, requireShim)

const exported = moduleObject.exports
const problems = []
if (typeof exported.apply !== 'function') problems.push('exports.apply 不是函数')
if (!Array.isArray(exported.inject)) problems.push('exports.inject 不是数组')

if (typeof exported.apply === 'function') {
  try {
    exported.apply({ slots: { inject() {}, register() {} } })
  } catch (e) {
    problems.push('apply(ctx) 抛错: ' + (e && e.message))
  }
}

// MutationObserver 是空的 + rAF 走 setTimeout，等一拍让它真的插一次
await new Promise((r) => setTimeout(r, 100))

console.log('debug: flag=' + String(sandbox.__DSH_SCREEN_CAPTURE_DESKTOP__))
console.log('debug: 找到听写=' + String(!!fakeDocument.querySelector('button[aria-label="开始录音"]')))
console.log('debug: 工具条子节点数=' + tools.children.length)
console.log('debug: 全文档节点数=' + collectTree(documentRoot, []).length)

const recHost = fakeDocument.querySelector('[data-dsh-capture-rec]')
const shotHost = fakeDocument.querySelector('[data-dsh-capture-shot]')
if (!recHost) problems.push('没有插出录屏按钮')
if (!shotHost) problems.push('没有插出截图按钮')
if (recHost && shotHost) {
  const order = tools.children.map((c) => {
    if (c === recHost) return '录屏'
    if (c === shotHost) return '截图'
    if (c === dictation) return '听写'
    if (c === plusButton) return '+'
    return '?'
  })
  console.log('工具条顺序：' + order.join(' | '))
  const recIdx = tools.children.indexOf(recHost)
  const shotIdx = tools.children.indexOf(shotHost)
  const dictIdx = tools.children.indexOf(dictation)
  if (!(recIdx < shotIdx && shotIdx < dictIdx)) {
    problems.push('顺序不对：期望 录屏 < 截图 < 听写')
  }
}

const recBtn = recHost && recHost.children[0] ? recHost.children[0] : null
console.log('录屏按钮 aria-label：' + (recBtn ? recBtn.getAttribute('aria-label') : '(没有)'))

if (problems.length) {
  console.error('SELFTEST FAIL')
  problems.forEach((p) => console.error(' - ' + p))
  process.exit(1)
}
console.log('SELFTEST OK')
