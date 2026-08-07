import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

export type SynVoiceProvider = 'openai' | 'openrouter'

export type SynVoiceApiFailureKind =
  | 'authentication'
  | 'credits'
  | 'rate-limit'
  | 'model'
  | 'unavailable'
  | 'connection'
  | 'configuration'
  | 'request'

/**
 * Erro estruturado mantido no processo principal para que a interface possa
 * exibir um aviso curto sem depender de interpretar o texto da mensagem.
 */
export class SynVoiceApiError extends Error {
  readonly name = 'SynVoiceApiError'

  constructor(
    message: string,
    readonly kind: SynVoiceApiFailureKind,
    readonly provider: SynVoiceProvider,
    readonly status?: number
  ) {
    super(message)
  }
}

const TRANSCRIPTIONS_URL: Record<SynVoiceProvider, string> = {
  openai: 'https://api.openai.com/v1/audio/transcriptions',
  openrouter: 'https://openrouter.ai/api/v1/audio/transcriptions'
}
const API_KEYS_URL: Record<SynVoiceProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  openrouter: 'https://openrouter.ai/settings/keys'
}
const DEFAULT_MODEL: Record<SynVoiceProvider, string> = {
  openai: 'gpt-transcribe',
  openrouter: 'openai/gpt-4o-transcribe'
}
const OPENROUTER_MODELS_URL =
  'https://openrouter.ai/api/v1/models?output_modalities=transcription'
const MAX_AUDIO_BYTES = 20 * 1024 * 1024
const MAX_DURATION_MS = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000
const MAX_CUSTOM_VOCABULARY_TERMS = 50
const MAX_CUSTOM_VOCABULARY_TERM_LENGTH = 80

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mpga',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav'
}

const KEYWORDS = [
  'SynVoice',
  'Codex',
  'Claude',
  'OpenAI',
  'OpenRouter',
  'Maestro',
  'frontend',
  'backend',
  'TypeScript',
  'React',
  'Electron',
  'GitHub',
  'worktree',
  'pane'
]

const DEFAULT_CUSTOM_VOCABULARY = ['Synkora']

const VOCABULARY_ALIASES: Record<string, string[]> = {
  synkora: ['síncora', 'sincora', 'syncora', 'sin cora', 'sim cora']
}

const BASE_PROMPT =
  'Ditado em português brasileiro sobre desenvolvimento de software no Synkora. ' +
  'Transcreva literalmente no idioma original, sem resumir nem reescrever. ' +
  'Preserve a intenção, a pontuação e a capitalização de nomes técnicos.'

interface StoredSynVoiceSecret {
  provider?: SynVoiceProvider
  encryptedKeys?: Partial<Record<SynVoiceProvider, string>>
  models?: Partial<Record<SynVoiceProvider, string>>
  customVocabulary?: string[]
  /** Migração da primeira versão, que guardava somente a chave da OpenAI. */
  encryptedApiKey?: string
}

export interface SynVoiceProviderConfig {
  configured: boolean
  source: 'secure-storage' | 'none'
  model: string
  selectedModel: string | null
}

export interface SynVoiceConfig {
  provider: SynVoiceProvider
  configured: boolean
  source: 'secure-storage' | 'none'
  model: string
  customVocabulary: string[]
  secureStorageAvailable: boolean
  providers: Record<SynVoiceProvider, SynVoiceProviderConfig>
}

export interface SynVoiceModel {
  id: string
  name: string
  description: string
  recommended?: boolean
}

export interface SynVoiceTranscript {
  text: string
  languages: string[]
  model: string
}

export interface SynVoiceRequest {
  audio: Uint8Array
  mimeType: string
  durationMs: number
}

interface OpenAITranscriptResponse {
  text?: unknown
  languages?: unknown
  error?: {
    code?: unknown
    message?: unknown
    type?: unknown
  }
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: unknown
    name?: unknown
    description?: unknown
    architecture?: { output_modalities?: unknown }
  }>
}

const OPENAI_MODELS: SynVoiceModel[] = [
  {
    id: 'gpt-transcribe',
    name: 'GPT Transcribe',
    description: 'Máxima precisão, vocabulário técnico e mistura de idiomas.',
    recommended: true
  },
  {
    id: 'gpt-4o-transcribe',
    name: 'GPT-4o Transcribe',
    description: 'Transcrição de alta qualidade da geração GPT-4o.'
  },
  {
    id: 'gpt-4o-mini-transcribe',
    name: 'GPT-4o Mini Transcribe',
    description: 'Opção mais rápida e econômica.'
  },
  {
    id: 'whisper-1',
    name: 'Whisper 1',
    description: 'Modelo legado multilíngue.'
  }
]

const OPENROUTER_FALLBACK_MODELS: SynVoiceModel[] = [
  {
    id: 'openai/gpt-4o-transcribe',
    name: 'OpenAI: GPT-4o Transcribe',
    description: 'Alta precisão via OpenRouter.',
    recommended: true
  },
  {
    id: 'openai/gpt-4o-mini-transcribe',
    name: 'OpenAI: GPT-4o Mini Transcribe',
    description: 'Mais rápido e econômico.'
  },
  {
    id: 'mistralai/voxtral-mini-transcribe',
    name: 'Mistral: Voxtral Mini Transcribe',
    description: 'Modelo dedicado a transcrição multilíngue.'
  },
  {
    id: 'openai/whisper-large-v3',
    name: 'OpenAI: Whisper Large V3',
    description: 'Alternativa multilíngue robusta.'
  }
]

function cleanMimeType(value: string): string {
  return value.toLowerCase().split(';', 1)[0].trim()
}

function isProvider(value: unknown): value is SynVoiceProvider {
  return value === 'openai' || value === 'openrouter'
}

function normalizeVocabulary(
  value: unknown,
  limit = MAX_CUSTOM_VOCABULARY_TERMS
): string[] {
  if (!Array.isArray(value)) return []
  const terms: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const term = item.replace(/\s+/g, ' ').trim().slice(0, MAX_CUSTOM_VOCABULARY_TERM_LENGTH)
    if (!term) continue
    const identity = term.toLocaleLowerCase('pt-BR')
    if (seen.has(identity)) continue
    seen.add(identity)
    terms.push(term)
    if (terms.length >= limit) break
  }
  return terms
}

function mergedVocabulary(customVocabulary: string[]): string[] {
  return normalizeVocabulary(
    [...KEYWORDS, ...customVocabulary],
    KEYWORDS.length + MAX_CUSTOM_VOCABULARY_TERMS
  )
}

function transcriptionPrompt(customVocabulary: string[]): string {
  const vocabulary = mergedVocabulary(customVocabulary)
  return (
    `${BASE_PROMPT} ` +
    `Use exatamente estas grafias quando reconhecer os termos correspondentes: ${vocabulary.join('; ')}.`
  )
}

function foldedVocabularyIdentity(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function vocabularyPhrasePattern(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .map(escapeRegExp)
    .join('\\s+')
}

/**
 * O prompt aumenta a chance de a API escolher a grafia certa, mas não é uma
 * garantia. Esta etapa local torna determinística a capitalização dos termos
 * salvos e corrige apenas variantes explícitas, sempre como palavras inteiras.
 */
export function normalizeTranscriptVocabulary(text: string, customVocabulary: string[]): string {
  let normalized = text
  const vocabulary = normalizeVocabulary(customVocabulary)
    .sort((left, right) => right.length - left.length)

  for (const canonical of vocabulary) {
    const identity = foldedVocabularyIdentity(canonical)
    const variants = new Set<string>([
      canonical,
      canonical.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      ...(VOCABULARY_ALIASES[identity] ?? [])
    ])
    const alternatives = [...variants]
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)
      .map(vocabularyPhrasePattern)
      .join('|')
    if (!alternatives) continue
    const expression = new RegExp(
      `(^|[^\\p{L}\\p{N}])(?:${alternatives})(?=$|[^\\p{L}\\p{N}])`,
      'giu'
    )
    normalized = normalized.replace(expression, (_match, prefix: string) => `${prefix}${canonical}`)
  }
  return normalized
}

function secureStorageReady(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'
}

function friendlyProviderError(
  provider: SynVoiceProvider,
  status: number,
  payload: OpenAITranscriptResponse
): SynVoiceApiError {
  const code = payload.error?.code == null ? '' : String(payload.error.code)
  const type = typeof payload.error?.type === 'string' ? payload.error.type : ''
  const message = typeof payload.error?.message === 'string' ? payload.error.message : ''
  const providerName = provider === 'openai' ? 'OpenAI' : 'OpenRouter'
  const detail = `${code} ${type} ${message}`

  if (status === 401 || status === 403 || /invalid[_ -]?api[_ -]?key|unauthori[sz]ed|authentication/i.test(detail)) {
    return new SynVoiceApiError(
      `A chave da API da ${providerName} foi recusada ou não tem permissão. Confira a chave do SynVoice.`,
      'authentication',
      provider,
      status
    )
  }
  if (
    status === 402 ||
    (status === 429 && /insufficient[_ -]?quota|quota|billing|credit|balance|payment|fund|spend|saldo/i.test(detail))
  ) {
    return new SynVoiceApiError(
      `Os créditos da API da ${providerName} acabaram ou o limite de gastos foi atingido. Adicione créditos e tente novamente.`,
      'credits',
      provider,
      status
    )
  }
  if (status === 429) {
    return new SynVoiceApiError(
      `A ${providerName} recebeu muitas solicitações agora. Aguarde alguns segundos e tente novamente.`,
      'rate-limit',
      provider,
      status
    )
  }
  if (status === 413) {
    return new SynVoiceApiError(
      'A gravação ficou grande demais. Grave um trecho menor e tente novamente.',
      'request',
      provider,
      status
    )
  }
  if (status === 404 || code === 'model_not_found') {
    return new SynVoiceApiError(
      'O modelo de transcrição ainda não está disponível nesta conta da API.',
      'model',
      provider,
      status
    )
  }
  if (status === 408 || status >= 500) {
    return new SynVoiceApiError(
      `${providerName} está temporariamente indisponível. Tente novamente em instantes.`,
      'unavailable',
      provider,
      status
    )
  }
  if (/audio|file|format/i.test(message)) {
    return new SynVoiceApiError(
      `${providerName} não conseguiu ler esta gravação. Tente gravar novamente.`,
      'request',
      provider,
      status
    )
  }
  return new SynVoiceApiError(
    'Não foi possível transcrever o áudio. Tente novamente em instantes.',
    'request',
    provider,
    status
  )
}

export class SynVoiceService {
  private readonly file = join(app.getPath('userData'), 'synvoice-secret.json')
  private stored: StoredSynVoiceSecret = {}
  private openRouterModelsCache: { at: number; models: SynVoiceModel[] } | null = null

  constructor() {
    if (existsSync(this.file)) {
      try {
        this.stored = JSON.parse(readFileSync(this.file, 'utf-8')) as StoredSynVoiceSecret
      } catch {
        this.stored = {}
      }
    }
    let shouldPersist = false
    if (!isProvider(this.stored.provider)) {
      this.stored.provider = 'openai'
      shouldPersist = true
    }
    if (!Array.isArray(this.stored.customVocabulary)) {
      this.stored.customVocabulary = [...DEFAULT_CUSTOM_VOCABULARY]
      shouldPersist = true
    } else {
      const normalized = normalizeVocabulary(this.stored.customVocabulary)
      if (JSON.stringify(normalized) !== JSON.stringify(this.stored.customVocabulary)) {
        this.stored.customVocabulary = normalized
        shouldPersist = true
      }
    }
    if (this.stored.encryptedApiKey && !this.stored.encryptedKeys?.openai) {
      this.stored.encryptedKeys = {
        ...this.stored.encryptedKeys,
        openai: this.stored.encryptedApiKey
      }
      delete this.stored.encryptedApiKey
      shouldPersist = true
    }
    if (shouldPersist) this.persist()
  }

  getConfig(): SynVoiceConfig {
    const provider = isProvider(this.stored.provider) ? this.stored.provider : 'openai'
    const providers = {
      openai: this.providerConfig('openai'),
      openrouter: this.providerConfig('openrouter')
    }
    const selected = providers[provider]
    return {
      provider,
      configured: selected.configured,
      source: selected.source,
      model: selected.model,
      customVocabulary: [...(this.stored.customVocabulary ?? DEFAULT_CUSTOM_VOCABULARY)],
      secureStorageAvailable: secureStorageReady(),
      providers
    }
  }

  setCustomVocabulary(value: unknown): SynVoiceConfig {
    if (!Array.isArray(value)) throw new Error('A lista de palavras personalizadas é inválida.')
    this.stored.customVocabulary = normalizeVocabulary(value)
    this.persist()
    return this.getConfig()
  }

  setProvider(provider: SynVoiceProvider): SynVoiceConfig {
    if (!isProvider(provider)) throw new Error('Provedor de transcrição inválido.')
    this.stored.provider = provider
    this.persist()
    return this.getConfig()
  }

  async setModel(provider: SynVoiceProvider, model: string | null): Promise<SynVoiceConfig> {
    if (!isProvider(provider)) throw new Error('Provedor de transcrição inválido.')
    const selected = model?.trim() ?? ''
    if (selected) {
      const allowed = await this.listModels(provider)
      if (!allowed.some((item) => item.id === selected)) {
        throw new Error('Escolha um modelo disponível somente para transcrição.')
      }
    }
    this.stored.models = { ...this.stored.models }
    if (selected) this.stored.models[provider] = selected
    else delete this.stored.models[provider]
    this.persist()
    return this.getConfig()
  }

  async listModels(provider: SynVoiceProvider): Promise<SynVoiceModel[]> {
    if (!isProvider(provider)) throw new Error('Provedor de transcrição inválido.')
    if (provider === 'openai') return OPENAI_MODELS
    if (this.openRouterModelsCache && Date.now() - this.openRouterModelsCache.at < 10 * 60 * 1000) {
      return this.openRouterModelsCache.models
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await fetch(OPENROUTER_MODELS_URL, { signal: controller.signal })
      if (!response.ok) throw new Error('catálogo indisponível')
      const payload = (await response.json()) as OpenRouterModelsResponse
      const models = (payload.data ?? [])
        .filter((item) => {
          const modalities = item.architecture?.output_modalities
          return Array.isArray(modalities) && modalities.includes('transcription')
        })
        .map((item): SynVoiceModel | null => {
          if (typeof item.id !== 'string' || typeof item.name !== 'string') return null
          return {
            id: item.id,
            name: item.name,
            description:
              typeof item.description === 'string'
                ? item.description.replace(/\s+/g, ' ').trim().slice(0, 220)
                : 'Modelo dedicado a transcrição.',
            recommended: item.id === DEFAULT_MODEL.openrouter
          }
        })
        .filter((item): item is SynVoiceModel => Boolean(item))
        .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || a.name.localeCompare(b.name))
      if (!models.length) throw new Error('catálogo vazio')
      this.openRouterModelsCache = { at: Date.now(), models }
      return models
    } catch {
      return OPENROUTER_FALLBACK_MODELS
    } finally {
      clearTimeout(timeoutId)
    }
  }

  setApiKey(provider: SynVoiceProvider, value: string | null): SynVoiceConfig {
    if (!isProvider(provider)) throw new Error('Provedor de transcrição inválido.')
    const key = value?.trim() ?? ''
    this.stored.encryptedKeys = { ...this.stored.encryptedKeys }
    if (!key) {
      delete this.stored.encryptedKeys[provider]
      this.persist()
      return this.getConfig()
    }
    if (key.length < 20 || key.length > 256 || /\s/.test(key)) {
      throw new Error('A chave da API parece incompleta.')
    }
    const hasStoredKey = Boolean(this.stored.encryptedKeys?.[provider])
    const existingKey = hasStoredKey ? this.readStoredKey(provider) : ''
    if (hasStoredKey) {
      if (existingKey === key) return this.getConfig()
      throw new Error(`A chave da ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} já está protegida. Remova a chave atual antes de cadastrar outra.`)
    }
    if (!secureStorageReady()) {
      throw new Error('O cofre seguro do sistema ainda não está disponível. Reinicie o Synkora e tente novamente.')
    }
    this.stored.encryptedKeys[provider] = safeStorage.encryptString(key).toString('base64')
    this.persist()
    return this.getConfig()
  }

  getApiKeysUrl(provider: SynVoiceProvider): string {
    if (!isProvider(provider)) throw new Error('Provedor de transcrição inválido.')
    return API_KEYS_URL[provider]
  }

  async transcribe(request: SynVoiceRequest, signal?: AbortSignal): Promise<SynVoiceTranscript> {
    if (signal?.aborted) throw new Error('Transcrição cancelada.')
    const config = this.getConfig()
    const provider = config.provider
    const key = this.resolveApiKey(provider)
    if (!key) {
      throw new SynVoiceApiError(
        `Configure uma chave da API da ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'} para usar o SynVoice.`,
        'configuration',
        provider
      )
    }

    const audio = request.audio
    if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
      throw new Error('Nenhum áudio foi recebido. Grave novamente.')
    }
    if (audio.byteLength > MAX_AUDIO_BYTES) {
      throw new Error('A gravação passou de 20 MB. Grave um trecho menor.')
    }
    if (!Number.isFinite(request.durationMs) || request.durationMs <= 0 || request.durationMs > MAX_DURATION_MS + 5000) {
      throw new Error('A duração da gravação é inválida.')
    }

    const mimeType = cleanMimeType(request.mimeType)
    const extension = MIME_EXTENSIONS[mimeType]
    if (!extension) {
      throw new Error('Este formato de áudio não é compatível com o SynVoice.')
    }

    let model = config.model
    if (provider === 'openrouter' && !config.providers.openrouter.selectedModel) {
      const availableModels = await this.listModels('openrouter')
      if (signal?.aborted) throw new Error('Transcrição cancelada.')
      model = availableModels.find((item) => item.recommended)?.id ??
        availableModels[0]?.id ??
        DEFAULT_MODEL.openrouter
    }
    const form = new FormData()
    // IPC pode entregar uma view sobre ArrayBufferLike. Copiar garante um
    // ArrayBuffer comum, aceito por Blob também nos tipos estritos do TS 7.
    const audioCopy = new Uint8Array(audio.byteLength)
    audioCopy.set(audio)
    form.append('file', new Blob([audioCopy.buffer], { type: mimeType }), `synvoice-${Date.now()}.${extension}`)
    form.append('model', model)
    const vocabulary = mergedVocabulary(config.customVocabulary)
    form.append('prompt', transcriptionPrompt(config.customVocabulary))
    if (provider === 'openai' && model === 'gpt-transcribe') {
      form.append('languages[]', 'pt')
      form.append('languages[]', 'en')
      for (const keyword of vocabulary) form.append('keywords[]', keyword)
    } else {
      form.append('language', 'pt')
    }
    form.append('response_format', 'json')

    const timeout = new AbortController()
    const timeoutId = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS)
    const relayAbort = (): void => timeout.abort()
    if (signal?.aborted) timeout.abort()
    else signal?.addEventListener('abort', relayAbort, { once: true })

    try {
      const response = await fetch(TRANSCRIPTIONS_URL[provider], {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          ...(provider === 'openrouter' ? { 'X-Title': 'Synkora SynVoice' } : {})
        },
        body: form,
        signal: timeout.signal
      })

      let payload: OpenAITranscriptResponse = {}
      try {
        payload = (await response.json()) as OpenAITranscriptResponse
      } catch {
        payload = {}
      }
      if (!response.ok) throw friendlyProviderError(provider, response.status, payload)

      const text = typeof payload.text === 'string'
        ? normalizeTranscriptVocabulary(payload.text, config.customVocabulary).trim()
        : ''
      if (!text) throw new Error('Nenhuma fala foi reconhecida. Tente novamente mais perto do microfone.')
      const languages = Array.isArray(payload.languages)
        ? payload.languages
            .map((item) =>
              typeof item === 'string'
                ? item
                : item && typeof item === 'object' && 'code' in item && typeof item.code === 'string'
                  ? item.code
                  : ''
            )
            .filter(Boolean)
        : []
      return { text, languages, model }
    } catch (error) {
      if (timeout.signal.aborted) {
        if (signal?.aborted) throw new Error('Transcrição cancelada.')
        throw new SynVoiceApiError(
          'A transcrição demorou demais. Tente novamente em instantes.',
          'unavailable',
          provider
        )
      }
      if (error instanceof Error && !/fetch failed/i.test(error.message)) throw error
      throw new SynVoiceApiError(
        `Sem conexão com a ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'}. Verifique a internet e tente novamente.`,
        'connection',
        provider
      )
    } finally {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', relayAbort)
    }
  }

  private providerConfig(provider: SynVoiceProvider): SynVoiceProviderConfig {
    const hasStoredKey = Boolean(this.stored.encryptedKeys?.[provider])
    const selectedModel = this.stored.models?.[provider]?.trim() || null
    return {
      configured: hasStoredKey,
      source: hasStoredKey ? 'secure-storage' : 'none',
      model: selectedModel || DEFAULT_MODEL[provider],
      selectedModel
    }
  }

  private resolveApiKey(provider: SynVoiceProvider): string {
    return this.readStoredKey(provider)
  }

  private readStoredKey(provider: SynVoiceProvider): string {
    const encrypted = this.stored.encryptedKeys?.[provider]
    if (!encrypted || !secureStorageReady()) return ''
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64')).trim()
    } catch {
      return ''
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.stored, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
  }
}
