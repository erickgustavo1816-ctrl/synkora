import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { DesktopNotifyFocusMode } from './desktopNotificationPolicy'

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
  /**
   * ACESSIBILIDADE DO SYNKORA (ordem do dono, 2026-09-21): a seção de
   * tipografia dos terminais virou a regulagem do APP INTEIRO. `uiScale` é a
   * escala da interface em porcento (zoom real da janela), `uiFontFamily` a
   * fonte de todo o texto (inclusive terminais), `uiReduceMotion` força
   * `prefers-reduced-motion` mesmo com o Windows permitindo movimento, e o par
   * `chatFontSize`/`chatLineHeight` regula a leitura das mensagens do chat
   * por cima da escala. Quem aplica é `uiAccessibility.ts` (main) e
   * `renderer/uiAccessibility.ts` (variáveis CSS). Os campos
   * `terminalFontSize`/`terminalLineHeight` morreram com a seção; a fonte do
   * terminal (`terminalFontFamily`) migra para `uiFontFamily` na leitura.
   */
  uiScale: number
  uiFontFamily: string
  uiReduceMotion: boolean
  chatFontSize: number
  chatLineHeight: number
  synVoiceInputDeviceId?: string
  chatNotifyNeedsYou: boolean
  chatNotifyFinished: boolean
  chatNotifyFailed: boolean
  chatSoundsEnabled: boolean
  /**
   * COM O SYNKORA ABERTO (ordem do dono, 2026-09-22): o que vira toast com a
   * janela em foco. 'off-screen' (padrão) avisa tudo que o dono não está
   * vendo; 'always' avisa até o chat na tela; 'never' cala tudo em foco.
   * Quem aplica é `desktopNotificationPolicy.canShowDesktopNotification`.
   */
  desktopNotifyWhileFocused: DesktopNotifyFocusMode
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
  uiScale: 100,
  uiFontFamily: 'Cascadia Code',
  uiReduceMotion: false,
  chatFontSize: 12.5,
  chatLineHeight: 1.55,
  chatNotifyNeedsYou: true,
  chatNotifyFinished: true,
  chatNotifyFailed: true,
  chatSoundsEnabled: true,
  desktopNotifyWhileFocused: 'off-screen',
  skillsAgentPull: true,
  chatWritingWordsPerSecond: 20,
  chatWritingMaxLagMs: 1000,
  chatWritingFade: true
}

/** Faixas da acessibilidade — espelho de `UI_SCALE_RANGE`, `CHAT_FONT_SIZE_RANGE`
 *  e `CHAT_LINE_HEIGHT_RANGE` em `renderer/uiAccessibility.ts`. */
export const UI_SCALE_RANGE = { min: 80, max: 150 } as const
export const CHAT_FONT_SIZE_RANGE = { min: 10, max: 20 } as const
export const CHAT_LINE_HEIGHT_RANGE = { min: 1.2, max: 2 } as const

/** Faixas da escrita do chat — espelho de `GUI_WRITING_*_RANGE` no renderer. */
export const CHAT_WRITING_WORDS_PER_SECOND_RANGE = { min: 0, max: 60 } as const
export const CHAT_WRITING_MAX_LAG_RANGE = { min: 300, max: 3000 } as const

function clampInteger(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(range.min, Math.min(range.max, Math.round(parsed)))
}

/** Número com passo fixo dentro da faixa (0.5 para a fonte do chat, 0.01 para a altura da linha). */
function clampNumber(
  value: unknown,
  range: { min: number; max: number },
  fallback: number,
  precision: number
): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const snapped = Math.round(parsed / precision) * precision
  return Number(Math.max(range.min, Math.min(range.max, snapped)).toFixed(4))
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
  // A fonte de terminal de antes da seção de acessibilidade vira a fonte do
  // app: o dono que a tinha escolhido não perde a escolha.
  const fontFamily =
    cleanOptionalString(source.uiFontFamily) ?? cleanOptionalString(source.terminalFontFamily)
  return {
    externalServicePreparation:
      source.externalServicePreparation === 'on-demand' ? 'on-demand' : 'automatic',
    ...(typeof source.conptyDll === 'boolean' ? { conptyDll: source.conptyDll } : {}),
    uiScale: clampInteger(source.uiScale, UI_SCALE_RANGE, DEFAULTS.uiScale),
    uiFontFamily: (fontFamily ?? DEFAULTS.uiFontFamily).slice(0, 200),
    uiReduceMotion: source.uiReduceMotion === true,
    chatFontSize: clampNumber(source.chatFontSize, CHAT_FONT_SIZE_RANGE, DEFAULTS.chatFontSize, 0.5),
    chatLineHeight: clampNumber(
      source.chatLineHeight,
      CHAT_LINE_HEIGHT_RANGE,
      DEFAULTS.chatLineHeight,
      0.01
    ),
    ...(synVoiceInputDeviceId ? { synVoiceInputDeviceId } : {}),
    chatNotifyNeedsYou: source.chatNotifyNeedsYou !== false,
    chatNotifyFinished: source.chatNotifyFinished !== false,
    chatNotifyFailed: source.chatNotifyFailed !== false,
    chatSoundsEnabled: source.chatSoundsEnabled !== false,
    // Ausente/torto = o padrão "fora da tela": o documento de antes do ajuste.
    desktopNotifyWhileFocused:
      source.desktopNotifyWhileFocused === 'always' || source.desktopNotifyWhileFocused === 'never'
        ? source.desktopNotifyWhileFocused
        : DEFAULTS.desktopNotifyWhileFocused,
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
    // O documento entra SEM os defaults por cima: cada campo do sanitize já
    // tem o próprio fallback, e é a ausência de `uiFontFamily` no disco que
    // deixa a fonte de terminal de antes migrar para a fonte do app.
    this.data = sanitizePreferences(storedSettings)
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
