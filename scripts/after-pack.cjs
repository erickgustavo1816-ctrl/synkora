'use strict'

const { copyFileSync, existsSync, mkdirSync, readdirSync } = require('node:fs')
const { join } = require('node:path')

const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

/**
 * electron-builder intentionally prunes declaration files from dependencies,
 * but the TypeScript 7 native executable loads lib.*.d.ts at runtime. Restore
 * only that allowlisted runtime data beside the unpacked executable.
 */
module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName
  const arch = typeof context.arch === 'number'
    ? ARCH_NAMES[context.arch]
    : String(context.arch)
  if (!platform || !arch || arch === 'universal') {
    throw new Error('Unsupported TypeScript runtime target for packaging')
  }

  const packageName = `typescript-${platform}-${arch}`
  const source = join(
    context.packager.projectDir,
    'node_modules',
    '@typescript',
    packageName,
    'lib'
  )
  if (!existsSync(source)) {
    throw new Error(`Missing native TypeScript runtime package: @typescript/${packageName}`)
  }

  const resources = platform === 'darwin'
    ? join(
        context.appOutDir,
        `${context.packager.appInfo.productFilename}.app`,
        'Contents',
        'Resources'
      )
    : join(context.appOutDir, 'resources')
  const destination = join(
    resources,
    'app.asar.unpacked',
    'node_modules',
    '@typescript',
    packageName,
    'lib'
  )
  mkdirSync(destination, { recursive: true })

  const libraries = readdirSync(source).filter((name) => /^lib(?:\..+)?\.d\.ts$/i.test(name))
  if (!libraries.some((name) => name.toLowerCase() === 'lib.d.ts')) {
    throw new Error(`Native TypeScript runtime package has no lib.d.ts: @typescript/${packageName}`)
  }
  for (const name of libraries) copyFileSync(join(source, name), join(destination, name))
}
