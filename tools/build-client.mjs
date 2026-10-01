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
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

const bodyPath = path.join(root, 'lib', 'client.body.js')
const outPath = path.join(root, 'lib', 'client.js')

const body = fs.readFileSync(bodyPath, 'utf8').replace(/^\uFEFF/, '')

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
