import { buildSync, transformSync } from 'esbuild'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

// Pin the pre-implementation seam commit: helpers share HEAD and it may advance.
export const readSource = file => process.env.SYNKORA_TEST_BASELINE === '1'
  ? execFileSync('git', ['show', `2d07cf8:${file}`], { encoding: 'utf8' }) : readFileSync(file, 'utf8')

export function load(entry, stubs = {}) {
  const compiled = buildSync({ stdin: { contents: readSource(entry), sourcefile: entry, loader: 'ts', resolveDir: dirname(resolve(entry)) }, bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', write: false, external: Object.keys(stubs) }).outputFiles[0].text
  const module = { exports: {} }
  const require = createRequire(import.meta.url)
  new Function('require', 'module', 'exports', compiled)(
    (name) => name in stubs ? stubs[name] : require(name), module, module.exports)
  return module.exports
}

export function sourceFunction(file, name, deps) {
  const source = readSource(file)
  const match = new RegExp(`^( *)(?:export )?(?:(?:async )?function ${name}\\(|const ${name}\\s*=)`, 'mu').exec(source)
  if (!match) throw new Error(`Function ${name} missing from ${file}`)
  const end = source.indexOf(`\n${match[1]}}`, match.index)
  const found = source.slice(match.index, end + match[1].length + 2).trimStart()
  const code = transformSync(found.replace(/^export /u, ''), { loader: 'ts', target: 'es2022' }).code
  return new Function(...Object.keys(deps), `${code}; return ${name}`)(...Object.values(deps))
}
