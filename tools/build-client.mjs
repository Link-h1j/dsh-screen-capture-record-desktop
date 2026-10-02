/**
 * 把 lib/client.body.js 包成 DSH 0.1.7 客户端模块（__ModuleLoader__ 懒 CJS 注册）。
 *
 * 为什么要包：
 *   dsh-client-modules 的客户端半边是一个懒加载 CJS 表：每个客户端 bundle
 *   都是
 *       window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 *   的一层壳，factory 里用 `exports.apply` / `exports.inject` 交出插件体。
 *   裸写 `exports.apply = ...` 在浏览器里会直接 ReferenceError，所以正文单独放在
 *   client.body.js 里，由这个脚本生成真正被加载的 lib/client.js。
 *
 * 用法：
 *     node tools/build-client.mjs            # 重新生成 lib/client.js
 *     node tools/build-client.mjs --check    # 只校验生成结果与现文件一致
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const bodyPath = path.join(root, 'lib', 'client.body.js')
const outPath = path.join(root, 'lib', 'client.js')

const body = fs.readFileSync(bodyPath, 'utf8').replace(/^\uFEFF/, '')

/**
 * 语法闸门：生成的 client.js 会被 client-hmr 直接塞进渲染进程执行，
 * **写坏一次就能把整个界面带走**。
 *
 * 2026-10-02 真事：一次按 GBK 解码的 PowerShell 行手术把正文写成乱码，
 * 加上另一次删错括号 —— 两个坏包先后被 HMR 加载，渲染进程当场崩，
 * 桌面版弹出「应用无法启动或已意外停止」（崩在 SyntaxError 上，日志在
 * %APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-renderer.log）。
 *
 * 所以：先按渲染进程的真实包法编译一遍（只编译、不执行），不过就拒绝落盘 ——
 * 磁盘上永远留着上一个能跑的版本。
 */
try {
  new vm.Script('(function (module, exports, require) {\n' + body + '\n})', { filename: 'client.body.js' })
} catch (e) {
  console.error('lib/client.body.js 语法不过，拒绝生成 lib/client.js：' + ((e && e.message) || e))
  console.error('（磁盘上的 lib/client.js 保持原样，HMR 不会拿到坏包）')
  process.exit(1)
}

const banner = `/**
 * 由 tools/build-client.mjs 从 lib/client.body.js 生成 —— 不要直接改这个文件。
 * 改正文请改 client.body.js，然后跑：node tools/build-client.mjs
 */
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

`

const footer = `
\t\treturn module.exports;
\t}
});
`

const generated = banner + body.split('\n').map((line) => (line.length ? '\t\t' + line : line)).join('\n') + footer

const check = process.argv.includes('--check')
if (check) {
  const current = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : ''
  if (current !== generated) {
    console.error('lib/client.js 与 client.body.js 不一致，请跑 node tools/build-client.mjs')
    process.exit(1)
  }
  console.log('ok: lib/client.js 与 client.body.js 一致')
} else {
  fs.writeFileSync(outPath, generated)
  console.log('written: ' + path.relative(process.cwd(), outPath) + ' (' + generated.length + ' bytes)')
}
