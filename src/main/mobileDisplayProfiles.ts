import { getMobileDeviceProfile } from '../shared/mobileDeviceProfiles'
import { mobileError, parseAndroidDisplayGeometry } from './mobileCommands'

interface Size { width:number; height:number }
interface DisplaySettings {
  physical:Size
  physicalDensity:number
  override:Size|null
  overrideDensity:number|null
}
export interface MobileDisplayIo {
  run(args:string[],effect?:boolean,onEffectDispatched?:()=>void):Promise<Buffer>
  authorized():boolean
  pause():Promise<void>
}
function sameSize(a:Size|null,b:Size|null):boolean { return a?.width === b?.width && a?.height === b?.height }
function same(a:DisplaySettings,b:DisplaySettings):boolean {
  return sameSize(a.physical,b.physical) && a.physicalDensity === b.physicalDensity && sameSize(a.override,b.override) && a.overrideDensity === b.overrideDensity
}
function normalized(value:DisplaySettings):DisplaySettings {
  // wm does not report an override when it equals the physical value.
  return {...value,override:sameSize(value.override,value.physical) ? null:value.override,
    overrideDensity:value.overrideDensity === value.physicalDensity ? null:value.overrideDensity}
}
function parseSettings(sizeText:string,densityText:string):DisplaySettings {
  const invalid=():never=>mobileError('O Android não confirmou a configuração original da tela. Tente novamente após concluir a inicialização.')
  const sizeLines=sizeText.trim().split(/\r?\n/u), densityLines=densityText.trim().split(/\r?\n/u)
  if (sizeLines.length < 1 || sizeLines.length > 2 || densityLines.length < 1 || densityLines.length > 2) return invalid()
  const physical=/^Physical size: (\d+)x(\d+)$/u.exec(sizeLines[0])
  const override=sizeLines.length === 2 ? /^Override size: (\d+)x(\d+)$/u.exec(sizeLines[1]) : null
  const physicalDensity=/^Physical density: (\d+)$/u.exec(densityLines[0])
  const overrideDensity=densityLines.length === 2 ? /^Override density: (\d+)$/u.exec(densityLines[1]) : null
  if (!physical || !physicalDensity || (sizeLines.length === 2 && !override) || (densityLines.length === 2 && !overrideDensity)) return invalid()
  const size=(match:RegExpExecArray):Size=>({width:Number(match[1]),height:Number(match[2])})
  const result:DisplaySettings={physical:size(physical),physicalDensity:Number(physicalDensity[1]),override:override ? size(override):null,overrideDensity:overrideDensity ? Number(overrideDensity[1]):null}
  for (const value of [result.physical,result.override]) if (value && (!(value.width >= 1 && value.width <= 8192 && value.height >= 1 && value.height <= 8192) || value.width*value.height > 40_000_000)) return invalid()
  if ([result.physicalDensity,result.overrideDensity].some(value=>value !== null && (value < 72 || value > 1000))) return invalid()
  return normalized(result)
}

/** Transaction state is kept only for the currently owned emulator session. */
export class MobileAndroidDisplayProfiles {
  profileId?:string
  private original?:DisplaySettings
  private applied?:DisplaySettings
  private attempted:DisplaySettings[]=[]

  async initialize(io:MobileDisplayIo):Promise<void> {
    this.original=await this.read(io)
    this.profileId='native'
  }
  async apply(profileId:string,io:MobileDisplayIo):Promise<void> {
    const profile=getMobileDeviceProfile(profileId)
    if (!profile) mobileError('Escolha um modelo de tela disponível no painel Mobile.')
    const before=await this.read(io), previousId=this.profileId
    const previousApplied=this.applied, previousAttempts=[...this.attempted]
    this.original ??= before
    const target:DisplaySettings=normalized(profile.id === 'native' ? this.original : {...before,override:{width:profile.width,height:profile.height},overrideDensity:profile.density})
    if (!sameSize(before.physical,target.physical) || before.physicalDensity !== target.physicalDensity) mobileError('A tela física do emulador mudou. Pare a sessão e inicie novamente antes de trocar o modelo.')
    const expected=[before]
    try {
      await this.write(before,target,io,expected)
      await this.confirm(target,io)
      this.applied=target; this.profileId=profile.id; this.attempted=[]
    } catch (error) {
      delete this.profileId
      // Never recover after cancellation, scope loss or emulator identity loss.
      if (io.authorized()) {
        try {
          const current=await this.read(io)
          if (expected.some(value=>same(value,current))) {
            await this.write(current,before,io,[])
            await this.confirm(before,io)
            this.applied=previousApplied; this.attempted=previousAttempts
            this.profileId=(previousId === 'native' ? same(before,this.original) : previousApplied && same(before,previousApplied)) ? previousId:undefined
          }
        } catch { /* leave the model unclaimed when rollback cannot be confirmed */ }
      }
      throw error
    }
  }
  async restoreForStop(io:MobileDisplayIo):Promise<void> {
    if (!this.original || (!this.applied && !this.attempted.length) || !io.authorized()) return
    if (this.applied && same(this.original,this.applied) && !this.attempted.length) return
    const current=await this.read(io)
    // An owner may have changed wm outside Synkora. Do not overwrite that change.
    if (!(this.applied && same(current,this.applied)) && !this.attempted.some(value=>same(current,value))) return
    await this.write(current,this.original,io,[])
    await this.confirm(this.original,io)
    this.applied=this.original; this.profileId='native'; this.attempted=[]
  }
  private async read(io:MobileDisplayIo):Promise<DisplaySettings> {
    const size=await io.run(['wm','size'])
    const density=await io.run(['wm','density'])
    return parseSettings(size.toString('utf8'),density.toString('utf8'))
  }
  private async write(current:DisplaySettings,target:DisplaySettings,io:MobileDisplayIo,expected:DisplaySettings[]):Promise<void> {
    let applied=current
    if (!sameSize(current.override,target.override)) {
      const next={...applied,override:target.override}
      await io.run(['wm','size',target.override ? `${target.override.width}x${target.override.height}`:'reset'],true,()=>{expected.push(next); this.rememberAttempt(next)})
      applied=next; this.applied=applied
    }
    if (current.overrideDensity !== target.overrideDensity) {
      const next={...applied,overrideDensity:target.overrideDensity}
      await io.run(['wm','density',target.overrideDensity === null ? 'reset':String(target.overrideDensity)],true,()=>{expected.push(next); this.rememberAttempt(next)})
      this.applied=next
    }
  }
  private rememberAttempt(value:DisplaySettings):void {
    // A command can take effect just before cancellation hides its receipt.
    // Cleanup may restore only after reading an exact matching owned candidate.
    this.attempted=[...this.attempted.slice(-7),value]
  }
  private async confirm(target:DisplaySettings,io:MobileDisplayIo):Promise<void> {
    const deadline=Date.now()+2000, size=target.override ?? target.physical
    do {
      const current=await this.read(io)
      const reply=await io.run(['cmd','display','get-displays'])
      const geometry=parseAndroidDisplayGeometry(reply.toString('utf8'))
      const expected=geometry.rotation % 2 ? {width:size.height,height:size.width}:size
      if (same(current,target) && geometry.width === expected.width && geometry.height === expected.height) return
      if (Date.now() >= deadline) break
      await io.pause()
    } while (true)
    mobileError('O Android não confirmou a mudança de tela. O modelo não foi aplicado; tente novamente pelo painel Mobile.')
  }
}
