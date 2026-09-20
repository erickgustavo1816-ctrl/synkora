#!/usr/bin/env node
/** Local-only packaging; this command cannot publish or sign with a remote service. */
import { spawnSync } from 'node:child_process'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkMacInstallation } from './check-macos.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function buildMac(deps = {}) {
  const platform = deps.platform ?? process.platform, arch = deps.arch ?? process.arch, args = deps.args ?? process.argv.slice(2)
  const print = deps.print ?? console.log
  if (platform !== 'darwin' || arch !== 'arm64' || args.length > 1 || (args.length === 1 && args[0] !== '--dir')) {
    print('Use node scripts/build-macos.mjs [--dir] no próprio Mac, com Node arm64. Publicação não é permitida por este comando.')
    return 2
  }
  const result = (deps.check ?? checkMacInstallation)()
  if (!result.requiredChecksPass) {
    print('A preparação local ainda está incompleta. Execute node scripts/check-macos.mjs e siga docs/INSTALAR_MACOS.md.')
    return 1
  }
  const root = deps.root ?? ROOT, node = deps.node ?? process.execPath, run = deps.run ?? spawnSync
  // Builder imports CSC_LINK before choosing the configured identity. This
  // local-only command must not inherit release signing/notarization authority.
  const appleSigning = new Set(['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID',
    'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE'])
  const env = Object.fromEntries(Object.entries(deps.env ?? process.env)
    .filter(([key]) => !key.startsWith('CSC_') && !appleSigning.has(key)))
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  for (const command of [
    [posix.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'],
    [posix.join(root, 'node_modules/electron-builder/cli.js'), '--mac', '--arm64', '--publish', 'never', ...args]
  ]) {
    try {
      const child = run(node, command, { shell: false, cwd: root, stdio: 'inherit', env })
      if (child.status !== 0) { print('O build local não terminou. Nenhum aplicativo foi iniciado por este comando.'); return 1 }
    } catch { print('Não foi possível executar as ferramentas locais de build.'); return 1 }
  }
  print('Pacote local gerado em release/. Assinatura ad-hoc; a validação nativa no Mac continua necessária.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = buildMac()
