#!/usr/bin/env node
/** Read-only prerequisites. Never launches Synkora, a simulator or an emulator. */
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const JAR_SHA256 = 'deacb991ed2509715160ffdc7907e47b4160eb30d1566217e9047fd5b8850cae'
const MAX_OUTPUT = 512 * 1024
const executable = path => { try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false } }

export function checkMacInstallation(deps = {}) {
  const platform = deps.platform ?? process.platform, arch = deps.arch ?? process.arch
  const checks = []
  const add = (id, ok, detail, required = false, mobile = false) => checks.push({ id, ok: Boolean(ok), required, mobile, detail })
  const finish = () => ({ requiredChecksPass: checks.every(check => !check.required || check.ok),
    mobilePrerequisitesPresent: checks.some(check => check.mobile) && checks.every(check => !check.mobile || check.ok),
    nativeValidation: 'pending', checks })
  add('apple-silicon', platform === 'darwin' && arch === 'arm64', 'Execute no Mac com Node arm64, sem Rosetta.', true)
  if (platform !== 'darwin' || arch !== 'arm64') return finish()
  const nodeVersion = deps.nodeVersion ?? process.versions.node
  const [major, minor] = nodeVersion.split('.').map(Number)
  add('node', major > 22 || (major === 22 && minor >= 12), 'Node arm64 22.12 ou superior; prefira a versão LTS atual.', true)
  const root = deps.root ?? ROOT, home = deps.home ?? homedir(), env = deps.env ?? process.env
  const stat = deps.stat ?? statSync, readFile = deps.readFile ?? readFileSync, isExecutable = deps.isExecutable ?? executable
  const run = deps.run ?? spawnSync
  const pathEntries = [env.PATH ?? '', '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin',
    posix.join(home, '.local', 'bin'), '/usr/bin:/bin:/usr/sbin:/sbin'].join(':').split(':')
    .filter(value => value.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(value))
  const searchPath = [...new Set(pathEntries)].join(':')
  const find = name => pathEntries.map(path => posix.join(path, name)).find(isExecutable)
  const boundedFile = (path, limit = 65536) => {
    try {
      const info = stat(path)
      if (!info.isFile() || info.size < 0 || info.size > limit) return null
      const value = readFile(path)
      return value.length <= limit ? Buffer.from(value) : null
    } catch { return null }
  }
  const exists = path => { try { return stat(path).isFile() } catch { return false } }
  const invoke = (file, args) => {
    try {
      const result = run(file, args, { shell: false, cwd: home, encoding: 'utf8', timeout: 15000,
        maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'ignore'],
        env: { HOME: home, PATH: searchPath, LANG: 'en_US.UTF-8', TMPDIR: env.TMPDIR } })
      const output = typeof result.stdout === 'string' ? result.stdout : ''
      return result.status === 0 && Buffer.byteLength(output) <= MAX_OUTPUT ? output.trim() : null
    } catch { return null } // Tool errors may contain local private paths/output.
  }
  const osVersion = invoke('/usr/bin/sw_vers', ['-productVersion'])
  const osMajor = /^\d+\.\d+(?:\.\d+)?$/u.test(osVersion ?? '') ? Number(osVersion.split('.')[0]) : 0
  add('macos', osMajor >= 12, 'Electron 43 requer macOS Monterey ou superior.', true)
  add('node-pty-arm64', exists(posix.join(root, 'node_modules/@lydell/node-pty-darwin-arm64/package.json')),
    'npm ci deve instalar o pacote opcional nativo de terminal para darwin-arm64.', true)
  add('typescript-arm64', exists(posix.join(root, 'node_modules/@typescript/typescript-darwin-arm64/lib/tsc')) &&
    exists(posix.join(root, 'node_modules/@typescript/typescript-darwin-arm64/lib/lib.d.ts')),
    'O compilador TypeScript arm64 e suas bibliotecas precisam estar presentes.', true)
  const png = boundedFile(posix.join(root, 'build/icon-mac.png'), 2 * 1024 * 1024)
  add('mac-icon', png && png.length >= 24 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    png.readUInt32BE(16) === 1024 && png.readUInt32BE(20) === 1024,
    'O ícone Mac deve ter 1024×1024 pixels, gerado da geometria original.', true)
  const jar = boundedFile(posix.join(root, 'build/vendor/scrcpy/scrcpy-server-v4.1.jar'), 2 * 1024 * 1024)
  add('mobile-server', jar && createHash('sha256').update(jar).digest('hex') === (deps.expectedJarHash ?? JAR_SHA256),
    'O servidor Android scrcpy 4.1 precisa corresponder ao SHA-256 fixado.', true)
  add('git', Boolean(find('git')), 'Git precisa estar acessível ao aplicativo.')
  add('agent-cli', Boolean(find('codex') || find('claude')), 'Instale e autentique o CLI escolhido no próprio Mac; nenhuma conta foi consultada.')

  const sdkCandidates = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, posix.join(home, 'Library/Android/sdk')]
    .filter(value => typeof value === 'string' && posix.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value))
  const sdk = sdkCandidates.find(path => isExecutable(posix.join(path, 'platform-tools/adb')) && isExecutable(posix.join(path, 'emulator/emulator')))
  add('android-sdk', Boolean(sdk), 'Android SDK: Platform Tools e Emulator para Apple Silicon.', false, true)
  let arm64Image = false, avds = null
  if (sdk) {
    // Recommended image, independently verified in Google's official catalog.
    const properties = boundedFile(posix.join(sdk, 'system-images/android-36/google_apis_playstore/arm64-v8a/source.properties'))?.toString('utf8')
    arm64Image = /^SystemImage\.Abi\s*=\s*arm64-v8a\s*$/mu.test(properties ?? '')
    avds = invoke(posix.join(sdk, 'emulator/emulator'), ['-list-avds'])
  }
  add('android-arm64-image', arm64Image, 'Imagem recomendada: API 36 Google Play arm64-v8a; a imagem Windows x86_64 não serve.', false, true)
  add('android-avd', Boolean(avds?.split(/\r?\n/u).some(name => /^[A-Za-z0-9_.-]{1,128}$/u.test(name))),
    'Crie um aparelho Android novo no Device Manager; este check apenas lista os disponíveis.', false, true)
  const developer = invoke('/usr/bin/xcode-select', ['-p'])
  const simctl = invoke('/usr/bin/xcrun', ['--find', 'simctl'])
  const xcode = invoke('/usr/bin/xcodebuild', ['-version'])
  const xcodeMajor = Number(/^Xcode (\d+)(?:\.\d+)*$/mu.exec(xcode ?? '')?.[1] ?? 0)
  const fullXcode = /^\/[^\r\n]+\.app\/Contents\/Developer$/u.test(developer ?? '') &&
    /^\/[^\r\n]+\.app\/Contents\/Developer\//u.test(simctl ?? '')
  add('xcode', fullXcode, 'Abra o Xcode completo, conclua sua preparação e selecione suas Command Line Tools.', false, true)
  let availableSimulators = 0
  if (fullXcode) {
    try {
      const value = JSON.parse(invoke('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '--json']) ?? 'null')
      if (value?.devices && typeof value.devices === 'object' && !Array.isArray(value.devices)) {
        const groups = Object.values(value.devices)
        if (groups.length <= 64) for (const devices of groups) {
          if (Array.isArray(devices) && devices.length <= 256) availableSimulators += devices.filter(device => device?.isAvailable === true).length
        }
      }
    } catch { /* No raw simulator metadata is retained or printed. */ }
  }
  add('ios-runtime', availableSimulators > 0, 'Instale um runtime iOS e crie um iPhone no Xcode; este check não o inicia.', false, true)
  add('ios-input', Boolean(find('idb') && find('idb_companion')) && osMajor >= 15 && xcodeMajor >= 26,
    'O idb atual requer CLI + companion, macOS 15+ e Xcode 26+; toque e teclado ainda exigem teste no Mac.', false, true)
  return finish()
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length > 2) { console.error('Uso: node scripts/check-macos.mjs'); process.exitCode = 2 }
  else {
    const result = checkMacInstallation()
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = result.requiredChecksPass ? 0 : 1
  }
}
