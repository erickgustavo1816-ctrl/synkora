import { lstat, realpath, readdir } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { MobileAction, MobilePlatform } from '../shared/mobileSimulator'
import { getMobileDeviceProfile } from '../shared/mobileDeviceProfiles'

export class MobileCommandError extends Error {}
export function mobileError(message: string): never { throw new MobileCommandError(message) }
export function validMobileId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}
export function quoteAndroidArgument(value: string): string {
  if (/[\u0000\r\n]/u.test(value)) mobileError('O valor contém caracteres não aceitos pelo ADB. Edite o campo e tente novamente.')
  return `'${value.replace(/'/gu, "'\\''")}'`
}
export function androidShellArgs(serial: string, args: string[]): string[] {
  if (!/^emulator-\d{4,5}$/u.test(serial)) mobileError('Escolha um emulador Android do Synkora antes de enviar comandos.')
  return ['-s', serial, 'shell', args.map(quoteAndroidArgument).join(' ')]
}
const stringField = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
const coordinate = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
export function validateMobileAction(input: unknown): MobileAction {
  if (!input || typeof input !== 'object' || Array.isArray(input)) mobileError('Ação mobile inválida. Atualize o painel e tente novamente.')
  const action = input as Record<string, unknown>
  const keys: Record<string, string[]> = { tap:['type','x','y'], swipe:['type','x','y','endX','endY','durationMs'], text:['type','text'],
    key:['type','key'], openUrl:['type','url'], install:['type','relativePath'], launch:['type','appId'], reverse:['type','port'], displayProfile:['type','profileId'] }
  const allowed = typeof action.type === 'string' ? keys[action.type] : undefined
  if (!allowed || Object.keys(action).some(key => !allowed.includes(key))) mobileError('Ação mobile inválida. Atualize o painel e tente novamente.')
  switch (action.type) {
    case 'tap': if (!coordinate(action.x) || !coordinate(action.y)) mobileError('Toque fora da tela. Use coordenadas entre 0 e 1.'); break
    case 'swipe':
      if (![action.x,action.y,action.endX,action.endY].every(coordinate) || (action.durationMs !== undefined &&
        (!Number.isInteger(action.durationMs) || Number(action.durationMs) < 100 || Number(action.durationMs) > 2000))) mobileError('Gesto inválido. Use coordenadas entre 0 e 1 e duração de 100 a 2000 ms.')
      break
    case 'text': if (!stringField(action.text, 2000)) mobileError('Digite de 1 a 2000 caracteres sem quebras de linha.'); break
    case 'key': if (!['home','back','recents','enter','backspace'].includes(String(action.key))) mobileError('Tecla mobile não disponível. Use os controles do painel.'); break
    case 'openUrl': {
      if (!stringField(action.url, 2048)) mobileError('Informe um link de até 2048 caracteres.')
      try {
        const url = new URL(action.url)
        if (!/^[a-z][a-z0-9+.-]*:$/iu.test(url.protocol) || ['file:','javascript:','data:','content:','intent:','vbscript:'].includes(url.protocol) || url.username || url.password) throw new Error()
      } catch { mobileError('Use um link HTTP, HTTPS ou o esquema do seu aplicativo, sem credenciais.') }
      break
    }
    case 'install': if (!stringField(action.relativePath, 2048)) mobileError('Informe o caminho relativo do build dentro do worktree.'); break
    case 'launch': if (!stringField(action.appId, 255) || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_-]+)+$/u.test(action.appId)) mobileError('Informe o identificador do aplicativo, como com.exemplo.app.'); break
    case 'reverse': if (!Number.isInteger(action.port) || Number(action.port) < 1 || Number(action.port) > 65535) mobileError('Escolha uma porta entre 1 e 65535.'); break
    case 'displayProfile': if (!getMobileDeviceProfile(action.profileId)) mobileError('Escolha um modelo de tela disponível no painel Mobile.'); break
  }
  return input as MobileAction
}
export function androidText(text: string): string {
  if (!/^[\x20-\x7e]+$/u.test(text) || text.includes('%s')) mobileError('O teclado ADB aceita ASCII imprimível e não preserva a sequência %s. Use texto compatível ou a entrada do próprio aplicativo.')
  return text.replace(/ /gu, '%s')
}
export function mobilePixel(value: number, dimension: number): string { return String(Math.min(dimension - 1, Math.round(value * dimension))) }
/** DisplayInfo.real is the logical size in the current rotation, including system bars.
 * Unlike wm size or DisplayMetrics.app bounds, it matches input's display coordinates.
 */
export function parseAndroidDisplayGeometry(text:string):{width:number;height:number;rotation:number} {
  const invalid=():never=>mobileError('O Android não confirmou as dimensões e a orientação atuais da tela. Aguarde a rotação terminar ou atualize o emulador e tente novamente.')
  if (text.length > 64*1024) return invalid()
  const primary=text.split(/\r?\n/u).map(line=>line.trim()).filter(line=>/^Display id 0: DisplayInfo\{/u.test(line))
  if (primary.length !== 1 || !/,\s*isValid=true$/u.test(primary[0])) return invalid()
  const sizes=[...primary[0].matchAll(/,\s*real (\d+) x (\d+)(?=,)/gu)]
  const rotations=[...primary[0].matchAll(/,\s*rotation ([0-3])(?=,|\})/gu)]
  if (sizes.length !== 1 || rotations.length !== 1) return invalid()
  const width=Number(sizes[0][1]), height=Number(sizes[0][2])
  if (![width,height].every(value=>Number.isInteger(value) && value >= 1 && value <= 8192) || width*height > 40_000_000) return invalid()
  return {width,height,rotation:Number(rotations[0][1])}
}
function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
/** APKs and every descendant of .app bundles must remain physically in scope. */
export async function resolveMobileInstallPath(root: string, input: string, platform: MobilePlatform): Promise<string> {
  if (!stringField(input, 2048) || isAbsolute(input) || /[:]/u.test(input) || input.replace(/\\/gu, '/').split('/').some(p => p === '..')) mobileError('O build deve estar dentro do worktree. Informe um caminho relativo sem .. ou links.')
  try {
    const logicalRoot = resolve(root), rootStat = await lstat(logicalRoot)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error()
    const physicalRoot = await realpath(logicalRoot), target = resolve(logicalRoot, input)
    if (!inside(logicalRoot, target)) throw new Error()
    let cursor = logicalRoot
    for (const part of relative(logicalRoot, target).split(sep)) {
      cursor = join(cursor, part)
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error()
    }
    if (!inside(physicalRoot, await realpath(target))) throw new Error()
    const stat = await lstat(target)
    if (platform === 'android') { if (!stat.isFile() || extname(target).toLowerCase() !== '.apk') throw new Error() }
    else {
      if (!stat.isDirectory() || extname(target).toLowerCase() !== '.app') throw new Error()
      const pending = [target]; let visited = 0
      while (pending.length) {
        const directory = pending.pop()!
        for (const name of await readdir(directory)) {
          if (++visited > 30_000) throw new Error()
          const entry = join(directory, name), child = await lstat(entry)
          if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) throw new Error()
          if (child.isDirectory()) pending.push(entry)
        }
      }
    }
    return target
  } catch { return mobileError('Build inválido ou fora do worktree. Gere um APK Android ou bundle .app de simulador iOS nesta missão, sem links simbólicos.') }
}
