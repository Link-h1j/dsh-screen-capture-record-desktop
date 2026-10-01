/**
 * 校验 desktop profile 的 cordis.patch.yml 语法与新增条目。
 *
 * 为什么要单独校验：patch 文件解析失败会让整个 profile 起不来（或静默丢掉
 * 所有 patch 行），代价是整个 GUI。所以重启前先过一遍：yaml 能解析、顶层是
 * 数组、能找到 screen-capture-record-desktop 那条 insert。
 *
 * 用法：node dsh-screen-capture-record-desktop/tools/check-patch.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const patchPath = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'profiles',
  'desktop',
  'cordis.patch.yml'
)

let yaml
try {
  yaml = require(path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'profiles',
    'node_modules',
    'yaml'
  ))
} catch (e) {
  console.error('找不到 yaml 模块：' + e.message)
  process.exit(2)
}

const raw = fs.readFileSync(patchPath, 'utf8')
// !!js 是宿主自定义 tag，用 js-yaml 风格的未知标签处理：这里按字符串 tag 读，
// 只做结构校验，不求值。
let doc
try {
  doc = yaml.parse(raw, { schema: 'core' })
} catch (e) {
  console.error('YAML 解析失败: ' + e.message)
  process.exit(1)
}

const problems = []
if (!Array.isArray(doc)) problems.push('顶层不是数组（loader 要求数组）')

const entry = Array.isArray(doc)
  ? doc.find((row) => row && Array.isArray(row.insert) && row.insert.some((i) => i && i.name === 'dsh-screen-capture-record-desktop'))
  : null
if (!entry) problems.push('找不到 insert: dsh-screen-capture-record-desktop 这一行')

const byId = Array.isArray(doc) ? doc.filter((row) => row && row.id === 'screen-capture-record-desktop') : []
if (byId.length) problems.push('同时存在 id 形式与 insert 形式，可能重复挂载')

if (problems.length) {
  console.error('PATCH CHECK FAIL: ' + patchPath)
  problems.forEach((p) => console.error(' - ' + p))
  process.exit(1)
}

console.log('PATCH CHECK OK: ' + patchPath)
console.log('  顶层条目数 = ' + doc.length)
console.log('  insert 行 = ' + (entry.insert.map((i) => i.name).join(', ') || '(空)'))
