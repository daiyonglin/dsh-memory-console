// 把 src/client/*.js 组装成浏览器 bundle（client.js）。
// 浏览器侧不能直接 import 相对模块，所以用一个极小的顺序拼接构建；
// 所有 part 共享同一个 factory 作用域（React 由 require('react') 注入）。
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const partsDir = join(root, 'src', 'client')
const outFile = join(root, 'client.js')

const files = (await readdir(partsDir))
  .filter((name) => name.endsWith('.js'))
  .sort()

const chunks = []
for (const file of files) {
  const body = await readFile(join(partsDir, file), 'utf8')
  chunks.push(`// ---- ${file} ----\n${body.trim()}\n`)
}

const bundle = `// 记忆控制台 · Client bundle（由 scripts/build-client.mjs 生成，请勿手改）
window.__ModuleLoader__.load({
  id: 'memory-console',
  factory(require) {
    const React = require('react')
    const h = React.createElement

${chunks.join('\n')}
    return { inject: ['slots'], apply }
  },
})
`
await writeFile(outFile, bundle, 'utf8')
console.log(`built ${outFile} from ${files.length} parts (${bundle.length} bytes)`)
