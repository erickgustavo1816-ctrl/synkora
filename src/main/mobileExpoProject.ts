import { lstat, open, realpath } from 'node:fs/promises'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MobileExpoProject } from '../shared/mobileExpo'
import { mobileError } from './mobileCommands'
import { mobileProcessEnvironment } from './mobileProcess'

const MAX_PACKAGE_BYTES = 256 * 1024
const SEMVER = /^(?:[~^])?(\d{1,3})\.\d{1,4}\.\d{1,4}(?:-[A-Za-z0-9.-]{1,80})?$/u
export interface MobileExpoDiscovery { project: MobileExpoProject; rootPath: string; cliPath?: string }
export function expoInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
export async function expoRealRoot(input: string): Promise<string> {
  try {
    const path = resolve(input), stat = await lstat(path)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error()
    return await realpath(path)
  } catch { return mobileError('A pasta desta missão não está disponível. Reabra uma missão de desenvolvimento com worktree ativo.') }
}
async function scopedFile(root: string, target: string): Promise<string> {
  const actual = await realpath(target), stat = await lstat(target)
  if (!expoInside(root, actual) || !stat.isFile() || stat.isSymbolicLink()) throw new Error()
  return actual
}
async function packageObject(root: string, file: string): Promise<Record<string, unknown>> {
  const actual = await scopedFile(root, file), fileStat = await lstat(actual)
  if (fileStat.size > MAX_PACKAGE_BYTES) throw new Error()
  const handle = await open(actual, 'r')
  try {
    const stat = await handle.stat()
    // Never follow a replacement symlink or read an unbounded project-owned file.
    if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES || stat.ino !== fileStat.ino || stat.dev !== fileStat.dev || await scopedFile(root, file) !== actual) throw new Error()
    const buffer = Buffer.alloc(MAX_PACKAGE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_PACKAGE_BYTES) throw new Error()
    const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } finally { await handle.close() }
}
function dependency(pkg: Record<string, unknown>, name: string): string | undefined {
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field]
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
      const value = (deps as Record<string, unknown>)[name]
      if (typeof value === 'string' && value.length > 0 && value.length <= 2048) return value
    }
  }
  return undefined
}
function version(value: unknown): string | undefined { return typeof value === 'string' && SEMVER.test(value) ? value : undefined }
export function expoProjectMessage(project: Omit<MobileExpoProject, 'message'>): string {
  if (project.kind === 'other') return 'O package.json desta missão não declara Expo ou React Native. Abra um projeto mobile nesta missão para usar Expo Go.'
  if (project.kind === 'react-native') return 'React Native sem Expo detectado. Use um APK local no Android ou configure Expo manualmente no projeto; a integração não converte nem instala dependências automaticamente.'
  const setup = project.dependenciesInstalled ? 'Use Iniciar Expo para disponibilizar o projeto na rede local.' : 'Instale as dependências do projeto no terminal da missão e clique em Atualizar; o CLI Expo local ainda não está disponível.'
  const ios = Number(project.sdkVersion?.split('.')[0]) >= 55
    ? 'No iPhone físico, SDK 55+ exige uma versão de Expo Go via TestFlight compatível com o projeto; a versão da App Store suporta até SDK 54.'
    : 'No iPhone físico, confirme uma versão de Expo Go compatível com o SDK do projeto.'
  return `${setup} ${ios} Use a mesma rede Wi-Fi e a mesma conta Expo no CLI e no Expo Go (expo login no terminal da missão). ${project.hasDevClient ? 'expo-dev-client detectado: recursos nativos personalizados podem exigir um development build em vez de Expo Go. ' : 'Expo Go aceita apenas os recursos nativos incluídos nele. '}O QR abre o iPhone físico; não cria simulador nem espelhamento iOS no Windows.`
}
/** Read package data only. Config JavaScript, scripts, .env and account files are never opened. */
export async function inspectExpoProject(inputRoot: string): Promise<MobileExpoDiscovery> {
  const rootPath = await expoRealRoot(inputRoot)
  let pkg: Record<string, unknown>
  try { pkg = await packageObject(rootPath, join(rootPath, 'package.json')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const project: MobileExpoProject = { kind: 'other', dependenciesInstalled: false, hasDevClient: false, message: '' }
      project.message = expoProjectMessage(project); return { rootPath, project }
    }
    return mobileError('O package.json precisa ser um arquivo JSON regular de até 256 KB dentro do worktree. Corrija o arquivo e clique em Atualizar.')
  }
  const declaredExpo = dependency(pkg, 'expo')
  const project: MobileExpoProject = { kind: declaredExpo ? 'expo' : dependency(pkg, 'react-native') ? 'react-native' : 'other',
    dependenciesInstalled: false, hasDevClient: Boolean(dependency(pkg, 'expo-dev-client')), message: '', ...(version(declaredExpo) ? { expoVersion: version(declaredExpo) } : {}) }
  let cliPath: string | undefined
  if (project.kind === 'expo') {
    try {
      const installed = await packageObject(rootPath, join(rootPath, 'node_modules', 'expo', 'package.json'))
      const installedVersion = version(installed.version)
      if (installed.name !== 'expo' || !installedVersion || /^[~^]/u.test(installedVersion)) throw new Error()
      // The official Expo package has this entrypoint; package.json "bin" is never executable authority.
      cliPath = await scopedFile(rootPath, join(rootPath, 'node_modules', 'expo', 'bin', 'cli'))
      project.expoVersion = installedVersion; project.dependenciesInstalled = true
      project.sdkVersion = `${SEMVER.exec(installedVersion)![1]}.0.0`
    } catch { /* The owner can install/fix project dependencies in the mission terminal. */ }
    if (!project.sdkVersion && project.expoVersion) project.sdkVersion = `${SEMVER.exec(project.expoVersion)![1]}.0.0`
  }
  project.message = project.kind === 'other' && dependency(pkg, 'electron')
    ? 'Este projeto é um aplicativo Electron para computador. O Expo Go não executa aplicativos Electron. Para testar no celular, abra uma missão com um projeto Expo ou React Native.'
    : expoProjectMessage(project)
  return { rootPath, project, ...(cliPath ? { cliPath } : {}) }
}
export function privateExpoAddress(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value)) return false
  const bytes = value.split('.').map(Number)
  if (bytes.some((v, i) => v > 255 || String(v) !== value.split('.')[i])) return false
  return bytes[0] === 10 || (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) || (bytes[0] === 192 && bytes[1] === 168)
}
export function privateExpoAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string[] {
  return [...new Set(Object.values(interfaces).flatMap(entries => (entries ?? [])
    .filter(entry => !entry.internal && entry.family === 'IPv4' && privateExpoAddress(entry.address)).map(entry => entry.address)))].sort()
}
/** Credentials are resolved by Expo itself; no account files or inherited bearer/options are copied. */
export function expoProcessEnvironment(address: string, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!privateExpoAddress(address)) return mobileError('Escolha um endereço IPv4 privado da rede local no painel Expo.')
  return { ...mobileProcessEnvironment(source), CI: '1', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    EXPO_NO_TELEMETRY: '1', EXPO_NO_TYPESCRIPT_SETUP: '1', EXPO_NO_WEB_SETUP: '1',
    REACT_NATIVE_PACKAGER_HOSTNAME: address, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }
}
