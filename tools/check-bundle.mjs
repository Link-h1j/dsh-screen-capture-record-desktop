/**
 * 安装前自检：复刻 @deepseek-ai/dsh-plugin-manager 的 inspect() 判据。
 *
 * 为什么要有这个：插件管理器只收「组合包」—— package.json 里必须声明
 * dsh.bundle.patch，且该文件存在、能解析、确实插入了本包那一行。任一条不满足，
 * UI 就报「这个包没有声明组合包，无法作为插件安装」，并在回滚后把
 * package.json / pnpm-lock.yaml 恢复原样。重启前先在这里过一遍，别拿整个 GUI 试错。
 *
 * 用法：node dsh-screen-capture-record-desktop/tools/check-bundle.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** yaml 解析器：优先用 profile 里装的那份，退回 ~/.dsh 下的任一份。 */
function loadYaml() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const candidates = [
    path.join(dshHome, 'profiles', 'node_modules', 'yaml'),
    path.join(dshHome, 'profiles', 'web', 'node_modules', 'js-yaml'),
  ]
  for (const c of candidates) {
    try { return require(c) } catch { /* 试下一个 */ }
  }
  return null
}

const problems = []
const notes = []

// 1. package.json 能解析
let manifest
const manifestPath = path.join(pkgDir, 'package.json')
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
} catch (e) {
  console.error('BUNDLE CHECK FAIL: package.json 读不了或不是合法 JSON')
  console.error(' - ' + e.message)
  process.exit(1)
}

// 2. 声明了 dsh.bundle.patch —— 管理器的 bundleManifest() 判据
const patchRef = manifest?.dsh?.bundle?.patch
if (patchRef === undefined) {
  problems.push('package.json 的 dsh.bundle.patch 未声明 → inspect() 会回答 not-a-bundle')
} else {
  const patchPaths = Array.isArray(patchRef) ? patchRef : [patchRef]
  for (const rel of patchPaths) {
    const file = path.resolve(pkgDir, rel)
    if (!fs.existsSync(file)) {
      problems.push(`dsh.bundle.patch 指向的文件不存在: ${rel}`)
      continue
    }
    notes.push(`bundle patch = ${rel}`)

    const yaml = loadYaml()
    if (!yaml) {
      notes.push('（找不到 yaml 解析器，跳过 patch 内容校验）')
      continue
    }
    let doc
    try {
      doc = yaml.parse
        ? yaml.parse(fs.readFileSync(file, 'utf8'), { schema: 'core' })
        : yaml.load(fs.readFileSync(file, 'utf8'))
    } catch (e) {
      problems.push(`patch 解析失败: ${rel} — ${e.message}`)
      continue
    }
    if (!Array.isArray(doc)) {
      problems.push(`patch 顶层不是数组（loader 要求数组）: ${rel}`)
      continue
    }
    const row = doc.find(
      (r) => r && Array.isArray(r.insert) && r.insert.some((i) => i && i.name === manifest.name),
    )
    if (!row) problems.push(`patch 里找不到引用本包（name: ${manifest.name}）的 insert 行: ${rel}`)
    else notes.push(`insert 行 id = ${row.insert.find((i) => i.name === manifest.name).id}`)

    if (doc.some((r) => r && r.id && r.insert)) {
      problems.push('patch 里同时存在 id 形式与 insert 形式，可能重复挂载')
    }
  }
}

// 3. 浏览器半边仍然要被 client-modules 认出（别在改 bundle 声明时把它弄丢）
if (manifest?.dsh?.client === undefined) {
  problems.push('dsh.client 声明丢了 —— 浏览器半边不会加载，按钮不会出现')
} else if (manifest.dsh.client.platform !== 'web') {
  problems.push(`dsh.client.platform 应为 'web'，实际是 ${String(manifest.dsh.client.platform)}`)
} else {
  notes.push(`dsh.client.platform = web, inject = [${(manifest.dsh.client.inject || []).join(', ')}]`)
}

// 4. 关键文件在不在（shot.ps1 是宿主抓屏脚本，缺了路由会返回 500）
for (const rel of ['lib/index.js', 'lib/client.js', 'lib/shot.ps1']) {
  if (!fs.existsSync(path.join(pkgDir, rel))) problems.push(`缺少关键文件: ${rel}`)
}

if (problems.length) {
  console.error('BUNDLE CHECK FAIL: ' + pkgDir)
  problems.forEach((p) => console.error(' - ' + p))
  process.exit(1)
}

console.log('BUNDLE CHECK OK: ' + pkgDir)
notes.forEach((n) => console.log('  ' + n))
console.log('  → 可以在「插件」页填这个绝对路径安装：')
console.log('    ' + pkgDir)
