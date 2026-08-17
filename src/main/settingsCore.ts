import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export type SettingsSecretName = 'openrouterKey' | 'githubToken'

export interface SynkoraPreferences {
  externalServicePreparation: 'automatic' | 'on-demand'
  imageProvider: 'codex' | 'openrouter'
  imageSeatId?: string
  openrouterModel?: string
  conptyDll?: boolean
  terminalFontSize: number
  terminalLineHeight: number
  terminalFontFamily: string
  synVoiceInputDeviceId?: string
  chatNotifyNeedsYou: boolean
  chatNotifyFinished: boolean
  chatNotifyFailed: boolean
  chatSoundsEnabled: boolean
}

/** Estado completo, restrito ao processo principal. */
export interface SynkoraSettings extends SynkoraPreferences {
  openrouterKey?: string
  githubToken?: string
}

/** Contrato seguro que pode atravessar para o renderer. */
export interface SynkoraSettingsView extends SynkoraPreferences {
  openrouterKeyConfigured: boolean
  openrouterKeyMasked?: string
  githubTokenConfigured: boolean
  githubTokenMasked?: string
}

export type SynkoraSettingsPatch = Partial<SynkoraPreferences>

export interface SecretProtector {
  isAvailable(): boolean
  seal(value: string): string
  open(value: string): string
}

interface SettingsStoreCoreOptions {
  userDataPath: string
  protector: SecretProtector
}

interface StoredSecrets {
  version: 1
  secrets: Partial<Record<SettingsSecretName, string>>
}

const SECRET_NAMES: SettingsSecretName[] = ['openrouterKey', 'githubToken']
const MASKED_SECRET = '••••••••'

const DEFAULTS: SynkoraPreferences = {
  externalServicePreparation: 'automatic',
  imageProvider: 'codex',
  terminalFontSize: 13,
  terminalLineHeight: 1.25,
  terminalFontFamily: 'Cascadia Code',
  chatNotifyNeedsYou: true,
  chatNotifyFinished: true,
  chatNotifyFailed: true,
  chatSoundsEnabled: true
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function sanitizePreferences(value: unknown): SynkoraPreferences {
  const source = recordOf(value)
  const imageSeatId = cleanOptionalString(source.imageSeatId)
  const openrouterModel = cleanOptionalString(source.openrouterModel)
  const synVoiceInputDeviceId = cleanOptionalString(source.synVoiceInputDeviceId)
  const fontFamily = cleanOptionalString(source.terminalFontFamily)
  return {
    externalServicePreparation:
      source.externalServicePreparation === 'on-demand' ? 'on-demand' : 'automatic',
    imageProvider: source.imageProvider === 'openrouter' ? 'openrouter' : 'codex',
    ...(imageSeatId ? { imageSeatId } : {}),
    ...(openrouterModel ? { openrouterModel } : {}),
    ...(typeof source.conptyDll === 'boolean' ? { conptyDll: source.conptyDll } : {}),
    terminalFontSize: Math.max(8, Math.min(24, Number(source.terminalFontSize) || 13)),
    terminalLineHeight: Math.max(1, Math.min(1.8, Number(source.terminalLineHeight) || 1.25)),
    terminalFontFamily: (fontFamily ?? DEFAULTS.terminalFontFamily).slice(0, 200),
    ...(synVoiceInputDeviceId ? { synVoiceInputDeviceId } : {}),
    chatNotifyNeedsYou: source.chatNotifyNeedsYou !== false,
    chatNotifyFinished: source.chatNotifyFinished !== false,
    chatNotifyFailed: source.chatNotifyFailed !== false,
    chatSoundsEnabled: source.chatSoundsEnabled !== false
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

/**
 * Persistência independente do Electron para manter a fronteira testável.
 * Segredos novos nunca entram em settings.json; valores legados são migrados
 * para o cofre antes de o JSON antigo ser regravado sem as credenciais.
 */
export class SettingsStoreCore {
  private readonly settingsFile: string
  private readonly secretsFile: string
  private readonly options: SettingsStoreCoreOptions
  private data: SynkoraPreferences = { ...DEFAULTS }
  private readonly secrets: Partial<Record<SettingsSecretName, string>> = {}
  private readonly encryptedSecrets: Partial<Record<SettingsSecretName, string>> = {}
  private readonly legacySecrets: Partial<Record<SettingsSecretName, string>> = {}

  constructor(options: SettingsStoreCoreOptions) {
    this.options = options
    this.settingsFile = join(options.userDataPath, 'settings.json')
    this.secretsFile = join(options.userDataPath, 'settings-secrets.json')

    let storedSettings: Record<string, unknown> = {}
    if (existsSync(this.settingsFile)) {
      try {
        storedSettings = recordOf(JSON.parse(readFileSync(this.settingsFile, 'utf-8')))
      } catch {
        storedSettings = {}
      }
    }
    this.data = sanitizePreferences({ ...DEFAULTS, ...storedSettings })
    for (const name of SECRET_NAMES) {
      const legacy = cleanOptionalString(storedSettings[name])
      if (legacy) this.legacySecrets[name] = legacy
    }

    if (existsSync(this.secretsFile)) {
      try {
        const stored = recordOf(JSON.parse(readFileSync(this.secretsFile, 'utf-8')))
        const values = recordOf(stored.secrets)
        for (const name of SECRET_NAMES) {
          const encrypted = cleanOptionalString(values[name])
          if (encrypted) this.encryptedSecrets[name] = encrypted
        }
      } catch {
        // Um cofre corrompido falha fechado. Um valor legado ainda pode ser
        // migrado abaixo, mas conteúdo cifrado inválido nunca chega ao renderer.
      }
    }

    this.unlockEncryptedSecrets()
    this.migrateLegacySecrets()
  }

  /** Somente para consumidores internos do main (imagem e cliente GitHub). */
  get(): SynkoraSettings {
    // `legacySecrets` só permanece preenchido enquanto o SO não oferece um
    // cofre real; mantê-lo restrito ao main preserva os consumidores atuais
    // sem permitir que o valor atravesse a fronteira do IPC.
    return { ...this.data, ...this.legacySecrets, ...this.secrets }
  }

  /** Única representação permitida no IPC de leitura/resposta. */
  view(): SynkoraSettingsView {
    const openrouterConfigured = this.isConfigured('openrouterKey')
    const githubConfigured = this.isConfigured('githubToken')
    return {
      ...this.data,
      openrouterKeyConfigured: openrouterConfigured,
      ...(openrouterConfigured
        ? { openrouterKeyMasked: MASKED_SECRET }
        : {}),
      githubTokenConfigured: githubConfigured,
      ...(githubConfigured
        ? { githubTokenMasked: MASKED_SECRET }
        : {})
    }
  }

  update(patch: SynkoraSettingsPatch): SynkoraSettings {
    this.data = sanitizePreferences({ ...this.data, ...recordOf(patch) })
    this.persistPreferences()
    return this.get()
  }

  setSecret(name: SettingsSecretName, rawValue: string): SynkoraSettings {
    if (!SECRET_NAMES.includes(name)) throw new Error('Credencial desconhecida.')
    const value = cleanOptionalString(rawValue)
    if (!value) return this.clearSecret(name)
    if (!this.options.protector.isAvailable()) {
      throw new Error('O cofre seguro do sistema ainda não está disponível. Reinicie o Synkora e tente novamente.')
    }

    const encrypted = this.options.protector.seal(value)
    this.encryptedSecrets[name] = encrypted
    this.secrets[name] = value
    delete this.legacySecrets[name]
    // O cofre é persistido primeiro. Assim, uma interrupção nunca apaga o
    // último exemplar utilizável de uma credencial legada.
    this.persistSecrets()
    this.persistPreferences()
    return this.get()
  }

  clearSecret(name: SettingsSecretName): SynkoraSettings {
    if (!SECRET_NAMES.includes(name)) throw new Error('Credencial desconhecida.')
    delete this.encryptedSecrets[name]
    delete this.secrets[name]
    delete this.legacySecrets[name]
    this.persistSecrets()
    this.persistPreferences()
    return this.get()
  }

  private isConfigured(name: SettingsSecretName): boolean {
    // Ciphertext presente, mas indecifrável, não é uma configuração utilizável.
    return Boolean(this.secrets[name] || this.legacySecrets[name])
  }

  private unlockEncryptedSecrets(): void {
    if (!this.options.protector.isAvailable()) return
    for (const name of SECRET_NAMES) {
      const encrypted = this.encryptedSecrets[name]
      if (!encrypted) continue
      try {
        const value = cleanOptionalString(this.options.protector.open(encrypted))
        if (value) this.secrets[name] = value
      } catch {
        delete this.secrets[name]
      }
    }
  }

  private migrateLegacySecrets(): void {
    const names = SECRET_NAMES.filter((name) => this.legacySecrets[name])
    if (names.length === 0 || !this.options.protector.isAvailable()) return

    let changed = false
    for (const name of names) {
      const legacy = this.legacySecrets[name]
      if (!legacy) continue
      // Um valor cifrado e decifrável já é a fonte mais nova. Caso contrário,
      // o legado recupera um cofre ausente/corrompido sem perder compatibilidade.
      if (!this.secrets[name]) {
        this.encryptedSecrets[name] = this.options.protector.seal(legacy)
        this.secrets[name] = legacy
        changed = true
      }
      delete this.legacySecrets[name]
    }
    if (changed) this.persistSecrets()
    this.persistPreferences()
  }

  private persistPreferences(): void {
    const persisted: Record<string, unknown> = { ...this.data }
    // Em plataformas sem um cofre real, não destruímos silenciosamente uma
    // credencial antiga. Ela permanece apenas até a próxima inicialização em
    // que a migração segura puder concluir; segredos novos nunca usam este caminho.
    if (!this.options.protector.isAvailable()) {
      for (const name of SECRET_NAMES) {
        if (this.legacySecrets[name]) persisted[name] = this.legacySecrets[name]
      }
    }
    writeJson(this.settingsFile, persisted)
  }

  private persistSecrets(): void {
    const stored: StoredSecrets = { version: 1, secrets: { ...this.encryptedSecrets } }
    writeJson(this.secretsFile, stored)
  }
}
