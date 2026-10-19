// Symbol index of the sources, so an agent reads 30 lines instead of a whole file: every exported or top-level
// function, class, const, interface and type, and the methods of classes, as `file:line kind name`.
//   node tools/symbols.mjs [regex]              names matching the regex, e.g. node tools/symbols.mjs "^ice|Crystal"
//   node tools/symbols.mjs --file core/model.ts every symbol of the files whose path contains that text
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2), fileAt = args.indexOf('--file'), only = fileAt >= 0 ? args.splice(fileAt, 2)[1] : null
const pattern = args[0] ? new RegExp(args[0], 'i') : null, root = fileURLToPath(new URL('..', import.meta.url))
const files = []
const walk = (dir) => { for (const name of readdirSync(dir)) { const p = join(dir, name); if (statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) files.push(p) } }
walk(join(root, 'src'))
const top = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/
const method = /^ {2}(?:(?:private|public|protected|static|readonly|async|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/
const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'super', 'constructor'])
for (const file of files) {
  const rel = relative(root, file).split('\\').join('/')
  if (only && !rel.includes(only)) continue
  let inClass = false
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, k) => {
    let kind, name
    const t = line.match(top)
    if (t) { kind = t[1]; name = t[2]; inClass = kind === 'class' }
    else if (/^\S/.test(line) && !/^[}\])]/.test(line)) inClass = false
    else if (inClass) { const m = line.match(method); if (m && !skip.has(m[1])) { kind = 'method'; name = m[1] } }
    if (kind && (!pattern || pattern.test(name))) console.log(`${rel}:${k + 1} ${kind} ${name}`)
  })
}
