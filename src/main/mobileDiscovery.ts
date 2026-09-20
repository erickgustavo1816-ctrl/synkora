import { access, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import type { MobileDevice, MobileHostPlatform, MobilePlatformCapability } from '../shared/mobileSimulator'
import { mobileExecutor, MobileProcessError, type MobileExecutor } from './mobileProcess'
import { freshMacPath } from './macPath'

export interface MobileTools { adb?: string; emulator?: string; xcrun?: string; idb?: string }
export interface MobileDiscoverySnapshot {
  hostPlatform: MobileHostPlatform
  platforms: MobilePlatformCapability[]
  devices: MobileDevice[]
  tools: MobileTools
  androidSerials: Record<string, string>
  androidDiscoveryIncomplete: boolean
}
export const MOBILE_IOS_UDID = /^[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}$/u
export const MOBILE_AVD_NAME = /^[A-Za-z0-9_.-]{1,128}$/u
export function parseAndroidDevices(text: string): string[] {
  return [...new Set(text.split(/\r?\n/u).flatMap(line => {
    const match = /^\s*(emulator-(\d{4,5}))\s+(?:device|offline)\b/u.exec(line)
    return match && Number(match[2]) <= 65535 ? [match[1]] : []
  }))].slice(0, 64)
}
export function parseIosDevices(text: string): MobileDevice[] {
  const value = JSON.parse(text) as { devices?: unknown }
  if (!value.devices || typeof value.devices !== 'object' || Array.isArray(value.devices)) throw new Error('invalid-devices')
  const devices: MobileDevice[] = []
  for (const [runtime, entries] of Object.entries(value.devices)) {
    if (!/^com\.apple\.CoreSimulator\.SimRuntime\.iOS[-.]/u.test(runtime) || !Array.isArray(entries)) continue
    for (const item of entries) {
      if (!item || typeof item !== 'object') continue
      const d = item as Record<string, unknown>
      if (typeof d.udid !== 'string' || !MOBILE_IOS_UDID.test(d.udid) || typeof d.name !== 'string' || d.name.length > 256) continue
      devices.push({ id: d.udid, platform:'ios', name: d.name.replace(/[\u0000-\u001f\u007f]/gu,''), runtime: runtime.split('.').at(-1),
        ...(typeof d.deviceTypeIdentifier === 'string' && /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9-]{1,128}$/u.test(d.deviceTypeIdentifier) ? {deviceTypeIdentifier:d.deviceTypeIdentifier}:{}),
        state: d.isAvailable !== true ? 'unavailable' : d.state === 'Shutdown' ? 'available' : ['Booted','Booting'].includes(String(d.state)) ? 'running' : 'unavailable' })
      if (devices.length >= 128) return devices
    }
  }
  return devices
}
async function executable(candidates: string[], platform: NodeJS.Platform): Promise<string | undefined> {
  for (const path of [...new Set(candidates)]) {
    if (!isAbsolute(path)) continue
    try {
      if (!(await stat(path)).isFile()) continue
      if (platform !== 'win32') await access(path, constants.X_OK)
      return await realpath(path)
    } catch { /* continue through user-installed SDK locations */ }
  }
  return undefined
}
export async function discoverMobileTools(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<MobileTools> {
  const home = homedir(), suffix = platform === 'win32' ? '.exe' : ''
  const pathText = platform === 'darwin' && process.platform === 'darwin' && env === process.env
    ? freshMacPath() : Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  const paths = pathText.split(delimiter).map(path => path.replace(/^"|"$/gu,'' )).filter(isAbsolute)
  const sdkRoots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA,'Android','Sdk') : undefined,
    join(home,'Library','Android','sdk'), join(home,'Android','Sdk')].filter((v): v is string => Boolean(v) && isAbsolute(v!))
  const [adb, emulator, xcrun, idb] = await Promise.all([
    executable([...sdkRoots.map(root => join(root,'platform-tools',`adb${suffix}`)), ...paths.map(root => join(root,`adb${suffix}`))],platform),
    executable([...sdkRoots.map(root => join(root,'emulator',`emulator${suffix}`)), ...paths.map(root => join(root,`emulator${suffix}`))],platform),
    platform === 'darwin' ? executable(['/usr/bin/xcrun'],platform) : undefined,
    platform === 'darwin' ? executable([...paths.map(root => join(root,'idb')), '/opt/homebrew/bin/idb','/usr/local/bin/idb'],platform) : undefined
  ])
  return { ...(adb ? {adb}:{}), ...(emulator ? {emulator}:{}), ...(xcrun ? {xcrun}:{}), ...(idb ? {idb}:{}) }
}
export async function discoverMobileRuntime(executor: MobileExecutor = mobileExecutor, signal?:AbortSignal): Promise<MobileDiscoverySnapshot> {
  const controller=new AbortController(), abort=():void=>controller.abort()
  if (signal?.aborted) throw new MobileProcessError('cancelled')
  signal?.addEventListener('abort',abort,{once:true})
  let expired=false
  const timer=setTimeout(()=>{expired=true; controller.abort()},20_000)
  try { return await discoverSnapshot(executor,controller.signal) }
  catch (error) { if (expired && !signal?.aborted) throw new MobileProcessError('timeout'); throw error }
  finally { clearTimeout(timer); signal?.removeEventListener('abort',abort) }
}
async function discoverSnapshot(executor:MobileExecutor,signal:AbortSignal):Promise<MobileDiscoverySnapshot> {
  const hostPlatform: MobileHostPlatform = ['win32','darwin','linux'].includes(process.platform) ? process.platform as MobileHostPlatform : 'unsupported'
  const tools = await discoverMobileTools()
  if (signal.aborted) throw new MobileProcessError('cancelled')
  const android: MobilePlatformCapability = {platform:'android',supported:hostPlatform !== 'unsupported',available:Boolean(tools.adb && tools.emulator),inputAvailable:Boolean(tools.adb && tools.emulator),title:'Android',
    setupSteps:['Instale o Android Studio com Android SDK Platform-Tools e Android Emulator.','No Device Manager, crie um dispositivo virtual com uma imagem de sistema.','Ative a virtualização da máquina e clique em Atualizar no painel Mobile.'],docsUrl:'https://developer.android.com/studio/run/emulator'}
  const ios: MobilePlatformCapability = {platform:'ios',supported:hostPlatform === 'darwin',available:false,inputAvailable:false,title:'iOS',
    setupSteps:['No macOS, instale o Xcode e um runtime de simulador iOS.','Abra o Xcode uma vez para concluir a preparação e selecionar Command Line Tools.','Para toques e teclado integrados, instale idb e idb_companion; depois clique em Atualizar.'],docsUrl:'https://developer.apple.com/documentation/xcode/running-your-app-in-simulator-or-on-a-device'}
  const result: MobileDiscoverySnapshot = {hostPlatform,platforms:[android,ios],devices:[],tools,androidSerials:Object.create(null) as Record<string,string>,androidDiscoveryIncomplete:false}
  if (!android.available) android.reason = 'Android SDK não encontrado. Prepare o SDK e um dispositivo virtual e clique em Atualizar.'
  if (android.available) {
    try {
      const [avds, attached] = await Promise.all([
        executor.run({executable:tools.emulator!,args:['-list-avds'],timeoutMs:10_000,maxBytes:64*1024,signal}),
        executor.run({executable:tools.adb!,args:['devices'],timeoutMs:10_000,maxBytes:64*1024,signal})
      ])
      const names = [...new Set(avds.stdout.toString('utf8').split(/\r?\n/u).map(s=>s.trim()).filter(name=>MOBILE_AVD_NAME.test(name)))].slice(0,128)
      for (const serial of parseAndroidDevices(attached.stdout.toString('utf8'))) {
        if (signal.aborted) throw new MobileProcessError('cancelled')
        try {
          const reply = await executor.run({executable:tools.adb!,args:['-s',serial,'emu','avd','name'],timeoutMs:2000,maxBytes:4096,signal})
          const name = reply.stdout.toString('utf8').split(/\r?\n/u)[0]?.trim()
          if (!name || !names.includes(name)) result.androidDiscoveryIncomplete = true
          else result.androidSerials[name] = serial
        } catch { result.androidDiscoveryIncomplete = true }
      }
      result.devices.push(...names.map(name => ({id:name,platform:'android' as const,name,state:result.androidSerials[name] ? 'running' as const:'available' as const})))
      if (!names.length) android.reason = 'Nenhum dispositivo virtual Android encontrado. Crie um AVD no Device Manager e clique em Atualizar.'
      else if (result.androidDiscoveryIncomplete) android.reason = 'Há um emulador cuja identidade não pôde ser confirmada. Encerre-o no Android Studio e atualize o painel.'
    } catch {
      if (signal.aborted) throw new MobileProcessError('cancelled')
      android.available = false; android.inputAvailable = false
      android.reason = 'Não foi possível consultar o SDK Android. Verifique a instalação e clique em Atualizar.'
    }
  }
  if (hostPlatform !== 'darwin') ios.reason = 'O simulador iOS requer macOS com Xcode. Use Android nesta máquina.'
  else if (!tools.xcrun) ios.reason = 'Xcode não encontrado. Instale o Xcode e um runtime iOS e clique em Atualizar.'
  else {
    try {
      const reply = await executor.run({executable:tools.xcrun,args:['simctl','list','devices','--json'],timeoutMs:15_000,maxBytes:1024*1024,signal})
      result.devices.push(...parseIosDevices(reply.stdout.toString('utf8')))
      ios.available = true; ios.inputAvailable = Boolean(tools.idb)
      if (!tools.idb) ios.reason = 'Imagem e instalação disponíveis. Instale idb e idb_companion para habilitar toques e teclado.'
    } catch {
      if (signal.aborted) throw new MobileProcessError('cancelled')
      ios.reason = 'O Xcode não respondeu ao simctl. Abra o Xcode, conclua a preparação e clique em Atualizar.'
    }
  }
  if (signal.aborted) throw new MobileProcessError('cancelled')
  return result
}
