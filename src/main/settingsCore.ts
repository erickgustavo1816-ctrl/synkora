import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

/**
 * PREFERÊNCIAS DO SYNKORA — e nada mais.
 *
 * Este arquivo teve um cofre de credenciais (safeStorage + settings-secrets.json)
 * que existia para exatamente dois segredos: `openrouterKey`, da geração de
 * imagens, e `githubToken`, da cota do instalador da biblioteca de skills. Os
 * dois subsistemas saíram na limpa F6 (2026-08-17) e o cofre ficou sem UM
 * consumidor sequer — guardar credencial que ninguém lê é superfície de risco
 * sem contrapartida, então ele saiu junto.
 *
 * O QUE NÃO ACONTECE: nada aqui apaga `settings-secrets.json`. O arquivo do
 * dono continua no disco, intacto e ignorado. Chave órfã dentro de
 * `settings.json` (imageProvider, openrouterKey, githubToken,
 * codeIntelligenceMode, mcpProtocolMode…) é DESCARTADA na leitura —
 * `sanitizePreferences` monta um objeto novo campo a campo, então documento
 * antigo carrega sem lançar e sem ressuscitar conceito morto.
 *
 * O SynVoice tem cofre PRÓPRIO (`synvoice-secret.json`, synVoice.ts) com o
 * próprio safeStorage. Ele nunca dependeu deste arquivo e não foi tocado.
 */

export interface SynkoraPreferences {
  externalServicePreparation: 'automatic' | 'on-demand'
  conptyDll?: boolean
  terminalFontSize: number
  terminalLineHeight: number
  terminalFontFamily: string
  synVoiceInputDeviceId?: string
  chatNotifyNeedsYou: boolean
  chatNotifyFinished: boolean
  chatNotifyFailed: boolean
  chatSoundsEnabled: boolean
  /**
   * INTERRUPTOR do `skill_pull` de rede (Skills 3.0 — ADR-0010, 2026-09-08).
   * Ligado por padrão: o harness é do agente ("ele vá atrás, ela busque, ela
   * pegue e ela faça"). Desligado, o pull de catálogo/URL recusa NOMEANDO este
   * ajuste — a prateleira, a biblioteca e o playbook autoral continuam valendo.
   */
  skillsAgentPull: boolean
  /**
   * A ESCRITA DO CHAT (pedido do dono em 2026-09-21, junto com o mockup do
   * escritor único): a cadência é dele. Palavras por segundo na base (0 =
   * instantâneo), o atraso máximo tolerado entre o texto recebido e o texto na
   * tela, e se cada passo assenta com fade. A régua que consome isto mora em
   * `renderer/guiStreamReveal.ts` (`guiWritingPaceOf`); as faixas são as mesmas.
   */
  chatWritingWordsPerSecond: number
  chatWritingMaxLagMs: number
  chatWritingFade: boolean
}

/** Estado completo, restrito ao processo principal. */
export type SynkoraSettings = SynkoraPreferences

/** Contrato seguro que pode atravessar para o renderer. */
export type SynkoraSettingsView = SynkoraPreferences

export type SynkoraSettingsPatch = Partial<SynkoraPreferences>

interface SettingsStoreCoreOptions {
  userDataPath: string
}

const DEFAULTS: SynkoraPreferences = {
  externalServicePreparation: 'automatic',
  terminalFontSize: 13,
  terminalLineHeight: 1.25,
  terminalFontFamily: 'Cascadia Code',
  chatNotifyNeedsYou: true,
  chatNotifyFinished: true,
  chatNotifyFailed: true,
  chatSoundsEnabled: true,
  skillsAgentPull: true,
  chatWritingWordsPerSecond: 20,
  chatWritingMaxLagMs: 1000,
  chatWritingFade: true
}

/** Faixas da escrita do chat — espelho de `GUI_WRITING_*_RANGE` no renderer. */
export const CHAT_WRITING_WORDS_PER_SECOND_RANGE = { min: 0, max: 60 } as const
export const CHAT_WRITING_MAX_LAG_RANGE = { min: 300, max: 3000 } as const

function clampInteger(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(range.min, Math.min(range.max, Math.round(parsed)))
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Monta as preferências CAMPO A CAMPO a partir do documento lido. É esta
 * construção — e não uma lista de chaves proibidas — que faz um settings.json
 * gravado por qualquer build antigo carregar limpo: o que não é nomeado aqui
 * simplesmente não entra.
 */
function sanitizePreferences(value: unknown): SynkoraPreferences {
  const source = recordOf(value)
  const synVoiceInputDeviceId = cleanOptionalString(source.synVoiceInputDeviceId)
  const fontFamily = cleanOptionalString(source.terminalFontFamily)
  return {
    externalServicePreparation:
      source.externalServicePreparation === 'on-demand' ? 'on-demand' : 'automatic',
    ...(typeof source.conptyDll === 'boolean' ? { conptyDll: source.conptyDll } : {}),
    terminalFontSize: Math.max(8, Math.min(24, Number(source.terminalFontSize) || 13)),
    terminalLineHeight: Math.max(1, Math.min(1.8, Number(source.terminalLineHeight) || 1.25)),
    terminalFontFamily: (fontFamily ?? DEFAULTS.terminalFontFamily).slice(0, 200),
    ...(synVoiceInputDeviceId ? { synVoiceInputDeviceId } : {}),
    chatNotifyNeedsYou: source.chatNotifyNeedsYou !== false,
    chatNotifyFinished: source.chatNotifyFinished !== false,
    chatNotifyFailed: source.chatNotifyFailed !== false,
    chatSoundsEnabled: source.chatSoundsEnabled !== false,
    // Ausente/torto = LIGADO: a ausência do campo é o documento de antes da
    // ADR-0010, e o padrão dela é o agente podendo puxar.
    skillsAgentPull: source.skillsAgentPull !== false,
    chatWritingWordsPerSecond: clampInteger(
      source.chatWritingWordsPerSecond,
      CHAT_WRITING_WORDS_PER_SECOND_RANGE,
      DEFAULTS.chatWritingWordsPerSecond
    ),
    chatWritingMaxLagMs: clampInteger(
      source.chatWritingMaxLagMs,
      CHAT_WRITING_MAX_LAG_RANGE,
      DEFAULTS.chatWritingMaxLagMs
    ),
    chatWritingFade: source.chatWritingFade !== false
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

/** Persistência independente do Electron para manter a fronteira testável. */
export class SettingsStoreCore {
  private readonly settingsFile: string
  private data: SynkoraPreferences = { ...DEFAULTS }

  constructor(options: SettingsStoreCoreOptions) {
    this.settingsFile = join(options.userDataPath, 'settings.json')

    let storedSettings: Record<string, unknown> = {}
    if (existsSync(this.settingsFile)) {
      try {
        storedSettings = recordOf(JSON.parse(readFileSync(this.settingsFile, 'utf-8')))
      } catch {
        storedSettings = {}
      }
    }
    this.data = sanitizePreferences({ ...DEFAULTS, ...storedSettings })
  }

  get(): SynkoraSettings {
    return { ...this.data }
  }

  /** Única representação permitida no IPC de leitura/resposta. */
  view(): SynkoraSettingsView {
    return { ...this.data }
  }

  update(patch: SynkoraSettingsPatch): SynkoraSettings {
    this.data = sanitizePreferences({ ...this.data, ...recordOf(patch) })
    writeJson(this.settingsFile, this.data)
    return this.get()
  }
}
