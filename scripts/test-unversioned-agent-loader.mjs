import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Native --experimental-strip-types suites load main/*.ts directly, and those
// modules import shared/ code WITHOUT an extension (what the tsc/bundler
// builds need). This hook resolves `./x` to `./x.ts` for those suites only.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.')) {
      const url = new URL(specifier, context.parentURL)
      if (url.protocol === 'file:') {
        const file = fileURLToPath(url)
        if (!existsSync(file) && existsSync(`${file}.ts`)) return nextResolve(`${specifier}.ts`, context)
      }
    }
    return nextResolve(specifier, context)
  }
})
