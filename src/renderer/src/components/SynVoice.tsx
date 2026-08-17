import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  SynVoiceConfig,
  SynVoiceGlobalActivationBinding,
  SynVoiceModel,
  SynVoiceOverlayState,
  SynVoiceProvider
} from '../../../preload/index'
import {
  getSynVoiceTarget,
  onSynVoiceTargetChange,
  rememberEditableTarget,
  type SynVoiceTarget
} from '../synVoiceTarget'
import SynVoiceIcon from './SynVoiceIcon'
import SynVoiceWindowIcon from './SynVoiceWindowIcon'
import TitleBarIcon from './TitleBarIcon'
import { useStore } from '../store'

type Stage =
  | 'loading'
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'processing'
  | 'inserted'

type ActivationMode = 'click' | 'toggle' | 'hold'
type ActivationSource = 'click' | 'toggle' | 'hold' | 'external' | 'external-hold'

interface PushToTalkBinding {
  code: string
  key: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
  label: string
}

type ToggleBinding =
  | (PushToTalkBinding & { kind: 'keyboard' })
  | { kind: 'mouse'; button: number; label: string }

interface RecordedClip {
  blob: Blob
  durationMs: number
  mimeType: string
  target: SynVoiceTarget | null
  external: boolean
  externalTarget: Promise<string | null> | null
}

interface VoiceActivity {
  analyserAvailable: boolean
  speechDetected: boolean
  candidateMs: number
  noiseFloor: number
  lastSampleAt: number
  startedAt: number
  sampledMs: number
}

interface PanelRect {
  x: number
  y: number
  width: number
  height: number
}

const MAX_RECORDING_MS = 5 * 60 * 1000
const SYNVOICE_WAVE_BAND_COUNT = 13
const PANEL_WIDTH = 440
const PANEL_HEIGHT = 530
const PANEL_KEY = 'synkora:synvoice-panel:v2'
const ACTIVATION_MODE_KEY = 'synkora:synvoice-activation:v1'
const PUSH_TO_TALK_KEY = 'synkora:synvoice-push-key:v1'
const TOGGLE_BINDING_KEY = 'synkora:synvoice-toggle-key:v1'
const BILLING_URL: Record<SynVoiceProvider, string> = {
  openai: 'https://platform.openai.com/settings/organization/billing/overview',
  openrouter: 'https://openrouter.ai/settings/credits'
}
const DEFAULT_PUSH_TO_TALK: PushToTalkBinding = {
  code: 'F8',
  key: 'F8',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  label: 'F8'
}
const DEFAULT_TOGGLE_BINDING: ToggleBinding = {
  kind: 'keyboard',
  code: 'F9',
  key: 'F9',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  label: 'F9'
}

function freshVoiceActivity(): VoiceActivity {
  return {
    analyserAvailable: false,
    speechDetected: false,
    candidateMs: 0,
    noiseFloor: 0.004,
    lastSampleAt: 0,
    startedAt: performance.now(),
    sampledMs: 0
  }
}

function normalizedSpeechResult(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isNoSpeechResult(value: string): boolean {
  const normalized = normalizedSpeechResult(value)
  if (!normalized) return true
  return new Set([
    'silence',
    'silent',
    'no speech',
    'no speech detected',
    'no audio',
    'no audio detected',
    'blank audio',
    'inaudible',
    'silencio',
    'sem fala',
    'nenhuma fala',
    'nenhuma fala detectada',
    'sem audio',
    'audio vazio',
    'audio inaudivel'
  ]).has(normalized)
}

function isNoSpeechFailure(value: string): boolean {
  const normalized = normalizedSpeechResult(value)
  return /(?:no|without) (?:speech|voice|audio)(?: detected| found)?/.test(normalized) ||
    /(?:audio|recording) (?:is )?(?:empty|silent)/.test(normalized) ||
    /(?:audio|recording)(?: file)? (?:is )?too short/.test(normalized) ||
    /(?:nenhuma|sem) (?:fala|voz|audio)/.test(normalized) ||
    /(?:audio|gravacao) (?:esta |ficou )?(?:vazio|vazia|silencioso|silenciosa)/.test(normalized)
}

function formatTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

function defaultPanelRect(): PanelRect {
  const width = Math.min(PANEL_WIDTH, Math.max(320, window.innerWidth - 32))
  const height = Math.min(PANEL_HEIGHT, Math.max(260, window.innerHeight - 64))
  return { x: window.innerWidth - width - 16, y: 48, width, height }
}

function clampPanel(rect: PanelRect): PanelRect {
  const margin = 10
  const minTop = 42
  const maxWidth = Math.max(320, window.innerWidth - margin * 2)
  const maxHeight = Math.max(240, window.innerHeight - minTop - margin)
  const width = Math.min(PANEL_WIDTH, maxWidth)
  const desiredHeight = Number.isFinite(rect.height) ? Math.max(240, rect.height) : PANEL_HEIGHT
  const height = Math.min(desiredHeight, maxHeight)
  return {
    width,
    height,
    x: Math.min(window.innerWidth - width - margin, Math.max(margin, rect.x)),
    y: Math.min(window.innerHeight - height - margin, Math.max(minTop, rect.y))
  }
}

function loadPanelRect(): PanelRect {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '') as Partial<PanelRect>
    if (
      Number.isFinite(saved.x) &&
      Number.isFinite(saved.y)
    ) {
      return clampPanel({
        x: saved.x as number,
        y: saved.y as number,
        width: PANEL_WIDTH,
        height: PANEL_HEIGHT
      })
    }
  } catch {
    // primeira abertura ou preferência antiga inválida
  }
  return defaultPanelRect()
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

function noticeToneOf(message: string): 'error' | 'warning' {
  return /crédit|saldo|limite|muitas solicitações|aguarde|temporariamente|sem conexão|demorou demais/i.test(message)
    ? 'warning'
    : 'error'
}

function bestMimeType(): string {
  const choices = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
  return choices.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
}

function available(target: SynVoiceTarget | null): target is SynVoiceTarget {
  try {
    return Boolean(target?.isAvailable())
  } catch {
    return false
  }
}

function loadActivationMode(): ActivationMode {
  const saved = localStorage.getItem(ACTIVATION_MODE_KEY)
  return saved === 'hold' || saved === 'toggle' ? saved : 'click'
}

function isSafeBinding(binding: Pick<PushToTalkBinding, 'code' | 'ctrlKey' | 'altKey'>): boolean {
  return !isModifierCode(binding.code) &&
    (/^F([1-9]|1[0-2])$/.test(binding.code) || binding.ctrlKey || binding.altKey)
}

function loadPushToTalkBinding(): PushToTalkBinding {
  try {
    const saved = JSON.parse(localStorage.getItem(PUSH_TO_TALK_KEY) ?? '') as Partial<PushToTalkBinding>
    if (
      typeof saved.code === 'string' &&
      typeof saved.key === 'string' &&
      typeof saved.label === 'string' &&
      typeof saved.ctrlKey === 'boolean' &&
      typeof saved.altKey === 'boolean' &&
      typeof saved.shiftKey === 'boolean' &&
      typeof saved.metaKey === 'boolean' &&
      isSafeBinding(saved as PushToTalkBinding)
    ) {
      return saved as PushToTalkBinding
    }
  } catch {
    // preferência ausente ou inválida
  }
  return DEFAULT_PUSH_TO_TALK
}

function isSafeMouseButton(button: number): boolean {
  return Number.isInteger(button) && (button === 1 || button === 3 || button === 4)
}

function mouseButtonLabel(button: number): string {
  if (button === 1) return 'Mouse 3 (meio)'
  if (button === 3) return 'Mouse 4 (lateral)'
  if (button === 4) return 'Mouse 5 (lateral)'
  return `Mouse ${button + 1}`
}

function toggleBindingPrompt(binding: ToggleBinding, capitalize = false): string {
  const text = `${binding.kind === 'mouse' ? 'use' : 'aperte'} ${binding.label}`
  return capitalize ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text
}

function loadToggleBinding(): ToggleBinding {
  try {
    const saved = JSON.parse(localStorage.getItem(TOGGLE_BINDING_KEY) ?? '') as Record<string, unknown>
    if (saved.kind === 'mouse' && typeof saved.button === 'number' && isSafeMouseButton(saved.button)) {
      return { kind: 'mouse', button: saved.button, label: mouseButtonLabel(saved.button) }
    }
    if (
      saved.kind === 'keyboard' &&
      typeof saved.code === 'string' &&
      typeof saved.key === 'string' &&
      typeof saved.label === 'string' &&
      typeof saved.ctrlKey === 'boolean' &&
      typeof saved.altKey === 'boolean' &&
      typeof saved.shiftKey === 'boolean' &&
      typeof saved.metaKey === 'boolean' &&
      isSafeBinding(saved as unknown as PushToTalkBinding)
    ) {
      return saved as unknown as ToggleBinding
    }
  } catch {
    // preferência ausente ou inválida
  }
  return DEFAULT_TOGGLE_BINDING
}

function isModifierCode(code: string): boolean {
  return /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)
}

function keyLabel(event: KeyboardEvent): string {
  if (/^F([1-9]|1[0-2])$/.test(event.code)) return event.code
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3)
  if (/^Digit[0-9]$/.test(event.code)) return event.code.slice(5)
  if (event.code === 'Space') return 'Espaço'
  if (event.key.length === 1) return event.key.toUpperCase()
  return event.key === 'ArrowUp'
    ? '↑'
    : event.key === 'ArrowDown'
      ? '↓'
      : event.key === 'ArrowLeft'
        ? '←'
        : event.key === 'ArrowRight'
          ? '→'
          : event.key
}

function bindingFromEvent(event: KeyboardEvent): PushToTalkBinding | null {
  if (isModifierCode(event.code)) return null
  const isFunctionKey = /^F([1-9]|1[0-2])$/.test(event.code)
  if (!isFunctionKey && !event.ctrlKey && !event.altKey) return null
  const main = keyLabel(event)
  const parts = [
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
    main
  ].filter(Boolean)
  return {
    code: event.code,
    key: event.key,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    label: parts.join(' + ')
  }
}

function matchesBinding(event: KeyboardEvent, binding: PushToTalkBinding): boolean {
  return event.code === binding.code &&
    event.ctrlKey === binding.ctrlKey &&
    event.altKey === binding.altKey &&
    event.shiftKey === binding.shiftKey &&
    event.metaKey === binding.metaKey
}

function releasesBinding(event: KeyboardEvent, binding: PushToTalkBinding): boolean {
  if (event.code === binding.code) return true
  if (binding.ctrlKey && /^Control/.test(event.code)) return true
  if (binding.altKey && /^Alt/.test(event.code)) return true
  if (binding.shiftKey && /^Shift/.test(event.code)) return true
  return binding.metaKey && /^Meta/.test(event.code)
}

export default function SynVoice(): React.JSX.Element {
  const microphoneDeviceId = useStore((s) => s.settings?.synVoiceInputDeviceId)
  const [config, setConfig] = useState<SynVoiceConfig | null>(null)
  const [stage, setStage] = useState<Stage>('loading')
  const [panelOpen, setPanelOpen] = useState(false)
  // Fase 3 (D6): o painel/banquinho flutuam sobre a área do canvas — com a
  // view de panes visível eles ficariam por baixo dela.
  const bumpHostOverlay = useStore((s) => s.bumpHostOverlay)
  // Banquinho das últimas falas (2026-08-06): recuperar transcrição que caiu
  // no vazio (destino sem foco) sem precisar falar tudo de novo.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Array<{ text: string; at: string }>>([])
  const historyAnchorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!panelOpen && !historyOpen) return
    bumpHostOverlay(1)
    return () => bumpHostOverlay(-1)
  }, [panelOpen, historyOpen, bumpHostOverlay])
  useEffect(() => {
    if (!historyOpen) return
    const onDocClick = (event: MouseEvent): void => {
      if (!historyAnchorRef.current?.contains(event.target as Node)) setHistoryOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [historyOpen])
  const [detached, setDetached] = useState(false)
  const [panelRect, setPanelRect] = useState<PanelRect>(() => loadPanelRect())
  const [activeTarget, setActiveTarget] = useState<SynVoiceTarget | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [level, setLevel] = useState(0)
  const [bands, setBands] = useState<number[]>(() =>
    Array.from({ length: SYNVOICE_WAVE_BAND_COUNT }, () => 0)
  )
  const [error, setError] = useState('')
  const [keyInput, setKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [vocabularyInput, setVocabularyInput] = useState('')
  const [savingVocabulary, setSavingVocabulary] = useState(false)
  const [confirmingRemoval, setConfirmingRemoval] = useState(false)
  const [activationMode, setActivationMode] = useState<ActivationMode>(() => loadActivationMode())
  const [pushToTalkBinding, setPushToTalkBinding] = useState<PushToTalkBinding>(() => loadPushToTalkBinding())
  const [toggleBinding, setToggleBinding] = useState<ToggleBinding>(() => loadToggleBinding())
  const [capturingKey, setCapturingKey] = useState(false)
  const [capturingToggle, setCapturingToggle] = useState(false)
  const [shortcutError, setShortcutError] = useState('')
  const [models, setModels] = useState<SynVoiceModel[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [statusMessage, setStatusMessage] = useState('SynVoice carregando')

  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const startedAtRef = useRef(0)
  const recordingTimerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)
  const recordingTargetRef = useRef<SynVoiceTarget | null>(null)
  const recordingExternalTargetRef = useRef<Promise<string | null> | null>(null)
  const pushToTalkHeldRef = useRef(false)
  const requestRef = useRef<string | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const voiceActivityRef = useRef<VoiceActivity>(freshVoiceActivity())
  const meterTimerRef = useRef(0)
  const meterLastPaintRef = useRef(0)
  const insertedTimerRef = useRef<number | null>(null)
  const operationRef = useRef(0)
  const microphoneRequestRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  const openerRef = useRef<HTMLElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const keyInputRef = useRef<HTMLInputElement | null>(null)
  const removeKeyButtonRef = useRef<HTMLButtonElement | null>(null)
  const cancelRemovalButtonRef = useRef<HTMLButtonElement | null>(null)
  const gestureRef = useRef<
    { pointerId: number; startX: number; startY: number; rect: PanelRect } | null
  >(null)

  useEffect(() => {
    let live = true
    void window.synkora.voice
      .getConfig()
      .then((next) => {
        if (!live) return
        setConfig(next)
        setStage('idle')
        setStatusMessage(next.configured ? 'SynVoice pronto' : 'SynVoice precisa de uma chave da API')
      })
      .catch((reason: unknown) => {
        if (!live) return
        setStage('idle')
        setError(messageOf(reason))
        setStatusMessage('SynVoice indisponível no momento')
      })
    return () => {
      live = false
    }
  }, [])

  // A página global de Configurações abre as opções avançadas já existentes
  // sem duplicar estado de provedor/chave/atalhos em dois componentes.
  useEffect(() => {
    const openSettings = (): void => {
      setPanelOpen(true)
      setError('')
    }
    window.addEventListener('synkora:open-voice-settings', openSettings)
    return () => window.removeEventListener('synkora:open-voice-settings', openSettings)
  }, [])

  useEffect(() => {
    let live = true
    const off = window.synkora.voice.onOverlayVisibility((next) => setDetached(next))
    void window.synkora.voice.isOverlayDetached().then((next) => {
      if (live) setDetached(next)
    }).catch(() => undefined)
    return () => {
      live = false
      off()
    }
  }, [])

  useEffect(() => {
    if (!panelOpen || !config) return
    let live = true
    setLoadingModels(true)
    void window.synkora.voice
      .listModels(config.provider)
      .then((next) => {
        if (live) setModels(next)
      })
      .catch((reason: unknown) => {
        if (live) setError(messageOf(reason))
      })
      .finally(() => {
        if (live) setLoadingModels(false)
      })
    return () => {
      live = false
    }
  }, [config?.provider, panelOpen])

  const closePanel = useCallback((): void => {
    setCapturingKey(false)
    setCapturingToggle(false)
    setShortcutError('')
    setPanelOpen(false)
    window.setTimeout(() => openerRef.current?.focus({ preventScroll: true }), 0)
  }, [])

  useEffect(() => {
    if (!panelOpen) return
    const focusTimer = window.setTimeout(() => {
      const focusTarget = keyInputRef.current ?? panelRef.current
      focusTarget?.focus({ preventScroll: true })
    }, 0)
    const onEscape = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        capturingKey ||
        capturingToggle ||
        stage === 'requesting' ||
        stage === 'recording' ||
        stage === 'processing'
      ) return
      event.preventDefault()
      closePanel()
    }
    window.addEventListener('keydown', onEscape, true)
    return () => {
      window.clearTimeout(focusTimer)
      window.removeEventListener('keydown', onEscape, true)
    }
  }, [capturingKey, capturingToggle, closePanel, panelOpen, stage])

  useEffect(() => {
    const off = onSynVoiceTargetChange(setActiveTarget)
    const capture = (event: Event): void => rememberEditableTarget(event.target)
    document.addEventListener('focusin', capture, true)
    document.addEventListener('pointerup', capture, true)
    document.addEventListener('keyup', capture, true)
    return () => {
      off()
      document.removeEventListener('focusin', capture, true)
      document.removeEventListener('pointerup', capture, true)
      document.removeEventListener('keyup', capture, true)
    }
  }, [])

  const persistPanel = useCallback((next: PanelRect): void => {
    const clamped = clampPanel(next)
    setPanelRect(clamped)
    localStorage.setItem(PANEL_KEY, JSON.stringify(clamped))
  }, [])

  useEffect(() => {
    const onResize = (): void => persistPanel(panelRect)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [panelRect, persistPanel])

  useEffect(() => {
    if (!panelOpen || !panelRef.current || typeof ResizeObserver === 'undefined') return
    const panelElement = panelRef.current
    const observer = new ResizeObserver(() => {
      const measuredHeight = Math.ceil(panelElement.getBoundingClientRect().height)
      setPanelRect((current) => {
        if (Math.abs(current.height - measuredHeight) < 1) return current
        return clampPanel({ ...current, height: measuredHeight })
      })
    })
    observer.observe(panelElement)
    return () => observer.disconnect()
  }, [panelOpen])

  const stopMeter = useCallback((): void => {
    if (meterTimerRef.current) window.clearInterval(meterTimerRef.current)
    meterTimerRef.current = 0
    setLevel(0)
    setBands(Array.from({ length: SYNVOICE_WAVE_BAND_COUNT }, () => 0))
    const context = audioContextRef.current
    audioContextRef.current = null
    if (context) void context.close().catch(() => undefined)
  }, [])

  const stopStream = useCallback((): void => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop()
    streamRef.current = null
    stopMeter()
  }, [stopMeter])

  const startMeter = useCallback((stream: MediaStream): void => {
    try {
      const context = new AudioContext()
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      // Resolução suficiente para separar graves, médios e agudos da voz.
      analyser.fftSize = 1024
      analyser.minDecibels = -90
      analyser.maxDecibels = -20
      analyser.smoothingTimeConstant = 0.45
      source.connect(analyser)
      audioContextRef.current = context
      voiceActivityRef.current.analyserAvailable = context.state === 'running'
      if (context.state === 'suspended') {
        void context.resume().then(() => {
          if (audioContextRef.current === context) {
            voiceActivityRef.current.analyserAvailable = context.state === 'running'
          }
        }).catch(() => undefined)
      }
      const data = new Uint8Array(analyser.fftSize)
      const frequencyData = new Uint8Array(analyser.frequencyBinCount)
      const binHz = context.sampleRate / analyser.fftSize
      const lowHz = 80
      const highHz = Math.min(7200, context.sampleRate / 2 - binHz)
      const frequencyRatio = highHz / lowHz
      const bandRanges = Array.from({ length: SYNVOICE_WAVE_BAND_COUNT }, (_, index) => {
        const startHz = lowHz * Math.pow(frequencyRatio, index / SYNVOICE_WAVE_BAND_COUNT)
        const endHz = lowHz * Math.pow(frequencyRatio, (index + 1) / SYNVOICE_WAVE_BAND_COUNT)
        const start = Math.max(1, Math.floor(startHz / binHz))
        const end = Math.min(
          analyser.frequencyBinCount,
          Math.max(start + 1, Math.ceil(endHz / binHz))
        )
        return { start, end }
      })
      meterLastPaintRef.current = 0
      const paint = (now: number): void => {
        analyser.getByteTimeDomainData(data)
        let power = 0
        for (const sample of data) {
          const value = (sample - 128) / 128
          power += value * value
        }
        const rms = Math.sqrt(power / data.length)
        const activity = voiceActivityRef.current
        if (!activity.speechDetected) {
          const deltaMs = activity.lastSampleAt
            ? Math.min(50, Math.max(8, now - activity.lastSampleAt))
            : 16
          activity.lastSampleAt = now
          activity.sampledMs += deltaMs

          // Os primeiros milissegundos servem para absorver o clique/ruído de início.
          // Depois, 80 ms de sinal sustentado bastam para preservar até falas curtas.
          const calibrating = now - activity.startedAt < 120
          const threshold = Math.max(
            calibrating ? 0.016 : 0.009,
            activity.noiseFloor * 1.9 + 0.0015
          )
          const voiced = !calibrating && rms >= threshold
          if (!voiced || calibrating) {
            const floorSample = Math.min(rms, 0.012)
            activity.noiseFloor += (floorSample - activity.noiseFloor) * 0.035
          }
          activity.candidateMs = voiced
            ? activity.candidateMs + deltaMs
            : Math.max(0, activity.candidateMs - deltaMs * 0.65)
          if (activity.candidateMs >= 80) activity.speechDetected = true
        }
        if (now - meterLastPaintRef.current >= 32) {
          // Remove o piso do microfone antes de comprimir o restante do sinal.
          // Assim, silêncio fica parado, mas fala baixa ainda ganha leitura suficiente.
          const meterCalibrating = now - activity.startedAt < 120
          const visualFloor = Math.max(0.008, activity.noiseFloor * 1.55 + 0.001)
          const audibleSignal = meterCalibrating ? 0 : Math.max(0, rms - visualFloor)
          const visualLevel = Math.min(1, Math.sqrt(audibleSignal * 9))
          analyser.getByteFrequencyData(frequencyData)
          const rawBands = bandRanges.map(({ start, end }) => {
            let energy = 0
            for (let index = start; index < end; index += 1) {
              const magnitude = frequencyData[index] / 255
              energy += magnitude * magnitude
            }
            return Math.sqrt(energy / Math.max(1, end - start))
          })
          const spectralPeak = Math.max(...rawBands)
          const spectralFloor = spectralPeak * 0.08
          const spectralRange = Math.max(0.001, spectralPeak - spectralFloor)
          const nextBands = visualLevel < 0.001 || spectralPeak < 0.001
            ? Array.from({ length: SYNVOICE_WAVE_BAND_COUNT }, () => 0)
            : rawBands.map((magnitude) => {
                const shape = Math.pow(
                  Math.max(0, Math.min(1, (magnitude - spectralFloor) / spectralRange)),
                  0.72
                )
                return Math.min(1, visualLevel * shape)
              })
          setLevel((current) => Math.abs(current - visualLevel) < 0.004 ? current : visualLevel)
          setBands((current) => current.some(
            (value, index) => Math.abs(value - nextBands[index]) >= 0.006
          ) ? nextBands : current)
          meterLastPaintRef.current = now
        }
      }
      paint(performance.now())
      // O analisador trabalha em tempo real fixo, sem multiplicar o custo em
      // monitores de 75, 120 ou 144 Hz. A interpolação visual fica no compositor.
      meterTimerRef.current = window.setInterval(() => paint(performance.now()), 16)
    } catch {
      // O medidor é feedback visual; falhar nunca pode impedir a gravação.
    }
  }, [])

  const clearTimers = useCallback((): void => {
    if (recordingTimerRef.current !== null) window.clearInterval(recordingTimerRef.current)
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current)
    recordingTimerRef.current = null
    maxTimerRef.current = null
  }, [])

  const deliverText = useCallback(
    async (text: string, preferredTarget: SynVoiceTarget | null): Promise<SynVoiceTarget | null> => {
      const target = available(preferredTarget) ? preferredTarget : null
      if (target) {
        target.insert(text)
        target.focus()
        return target
      }
      // Havia aqui um segundo caminho de entrega: o terminal focado na VIEW de
      // panes (processo irmão), que o registry local do host não enxergava. A
      // ilha morreu na purga F6 (2026-08-17) — sem alvo local, o texto vai ao
      // clipboard, e o banquinho (↺) já o guardou antes desta entrega.
      await navigator.clipboard.writeText(text)
      return null
    },
    []
  )

  const releaseExternalTarget = useCallback((): void => {
    const pending = recordingExternalTargetRef.current
    recordingExternalTargetRef.current = null
    if (!pending) return
    void pending
      .then((token) => {
        if (token) window.synkora.voice.discardExternalTarget(token)
      })
      .catch(() => undefined)
  }, [])

  const completeDelivery = useCallback((
    target: SynVoiceTarget | null,
    status?: string
  ): void => {
    if (insertedTimerRef.current !== null) window.clearTimeout(insertedTimerRef.current)
    setStage('inserted')
    setPanelOpen(false)
    setError('')
    setElapsed(0)
    recordingTargetRef.current = null
    recordingExternalTargetRef.current = null
    voiceActivityRef.current = freshVoiceActivity()
    pushToTalkHeldRef.current = false
    setStatusMessage(status ?? (
      target
        ? `Texto inserido em ${target.label}; ainda não foi enviado`
        : 'Nenhum painel ativo; transcrição copiada'
    ))
    insertedTimerRef.current = window.setTimeout(() => {
      insertedTimerRef.current = null
      setStage('idle')
      setStatusMessage('SynVoice pronto')
    }, 2200)
  }, [])

  const completeSilently = useCallback((status = 'SynVoice pronto'): void => {
    if (insertedTimerRef.current !== null) {
      window.clearTimeout(insertedTimerRef.current)
      insertedTimerRef.current = null
    }
    releaseExternalTarget()
    setStage('idle')
    setPanelOpen(false)
    setError('')
    setElapsed(0)
    recordingTargetRef.current = null
    voiceActivityRef.current = freshVoiceActivity()
    pushToTalkHeldRef.current = false
    setStatusMessage(status)
  }, [releaseExternalTarget])

  const transcribe = useCallback(async (recorded: RecordedClip): Promise<void> => {
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    setStage('processing')
    setPanelOpen(false)
    setError('')
    setStatusMessage('SynVoice transcrevendo')
    try {
      const [audio, externalTargetToken] = await Promise.all([
        recorded.blob.arrayBuffer(),
        recorded.externalTarget ?? Promise.resolve(null)
      ])
      if (requestRef.current !== requestId || cancelledRef.current) {
        if (externalTargetToken) window.synkora.voice.discardExternalTarget(externalTargetToken)
        return
      }
      const result = await window.synkora.voice.transcribe({
        requestId,
        audio,
        mimeType: recorded.mimeType,
        durationMs: recorded.durationMs,
        // Token nulo = o foco era o próprio Synkora; a entrega segue em-app.
        ...(recorded.external && externalTargetToken ? { externalTargetToken } : {})
      })
      if (requestRef.current !== requestId) return
      requestRef.current = null
      if (result.delivery === 'none' || isNoSpeechResult(result.text)) {
        completeSilently()
        return
      }
      if (recorded.external && externalTargetToken) {
        const status = result.delivery === 'inserted'
          ? 'Texto inserido no aplicativo ativo; ainda não foi enviado'
          : result.delivery === 'clipboard'
            ? 'O foco mudou; transcrição copiada para colar'
            : 'Transcrição concluída; confira o campo ativo'
        completeDelivery(null, status)
        return
      }
      try {
        const target = await deliverText(result.text, recorded.target)
        completeDelivery(target)
      } catch {
        try {
          await navigator.clipboard.writeText(result.text)
          completeDelivery(null)
        } catch {
          completeSilently()
        }
      }
    } catch (reason) {
      if (requestRef.current !== requestId) return
      requestRef.current = null
      const message = messageOf(reason)
      const noSpeech = isNoSpeechFailure(message)
      if (!noSpeech) window.synkora.voice.showNotice(message, noticeToneOf(message))
      completeSilently(noSpeech ? 'SynVoice pronto' : undefined)
    }
  }, [completeDelivery, completeSilently, deliverText])

  const finishRecording = useCallback(
    (
      recorder: MediaRecorder,
      durationMs: number,
      operation: number,
      chunks: Blob[],
      recordingFailed: boolean
    ): void => {
      if (
        !mountedRef.current ||
        operationRef.current !== operation ||
        recorderRef.current !== recorder
      ) return
      clearTimers()
      stopStream()
      recorderRef.current = null
      if (recordingFailed) {
        completeSilently()
        return
      }
      if (cancelledRef.current) {
        setStage('idle')
        setElapsed(0)
        setStatusMessage('Gravação descartada')
        return
      }
      const mimeType = recorder.mimeType || bestMimeType() || 'audio/webm'
      const blob = new Blob(chunks, { type: mimeType })
      const activity = voiceActivityRef.current
      const reliableSampleMs = Math.min(240, Math.max(100, durationMs - 120))
      const silentByMeter = activity.analyserAvailable &&
        activity.sampledMs >= reliableSampleMs &&
        !activity.speechDetected
      if (blob.size < 256 || durationMs < 120 || silentByMeter) {
        completeSilently()
        return
      }
      const externalTarget = recordingExternalTargetRef.current
      recordingExternalTargetRef.current = null
      const recorded: RecordedClip = {
        blob,
        durationMs,
        mimeType,
        target: recordingTargetRef.current,
        external: Boolean(externalTarget),
        externalTarget
      }
      void transcribe(recorded)
    },
    [clearTimers, completeSilently, stopStream, transcribe]
  )

  const stopRecording = useCallback((): void => {
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') return
    setStage('processing')
    setPanelOpen(false)
    setStatusMessage('Gravação concluída; preparando transcrição')
    recorder.stop()
  }, [])

  const startRecording = useCallback(async (source: ActivationSource = 'click'): Promise<void> => {
    setCapturingKey(false)
    setCapturingToggle(false)
    setShortcutError('')
    if (!config?.configured) {
      setPanelOpen(true)
      setStatusMessage('Configure uma chave da API para usar o SynVoice')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      completeSilently()
      return
    }

    if (insertedTimerRef.current !== null) {
      window.clearTimeout(insertedTimerRef.current)
      insertedTimerRef.current = null
    }
    const operation = ++operationRef.current
    const external = source === 'external' || source === 'external-hold'
    // Mesmo em modo externo (mini destacada), o destino EM-APP é capturado:
    // quando o foco estava no próprio Synkora, a captura externa devolve
    // token nulo (capture() recusa o próprio processo) e a entrega cai aqui —
    // sem isso, ditar para um pane com a mini destacada ia parar no clipboard
    // (bug real, 2026-08-03 à noite).
    const target = getSynVoiceTarget()
    recordingTargetRef.current = target
    recordingExternalTargetRef.current = external
      ? window.synkora.voice.captureExternalTarget().catch(() => null)
      : null
    setError('')
    setElapsed(0)
    setPanelOpen(false)
    setStage('requesting')
    setStatusMessage('SynVoice pedindo acesso ao microfone')
    cancelledRef.current = false
    microphoneRequestRef.current = operation

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(microphoneDeviceId ? { deviceId: { exact: microphoneDeviceId } } : {}),
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        },
        video: false
      })
      if (microphoneRequestRef.current === operation) microphoneRequestRef.current = null
      if (operationRef.current !== operation || cancelledRef.current) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      if ((source === 'hold' || source === 'external-hold') && !pushToTalkHeldRef.current) {
        for (const track of stream.getTracks()) track.stop()
        setStage('idle')
        setStatusMessage(`Segure ${pushToTalkBinding.label} para falar`)
        return
      }
      voiceActivityRef.current = freshVoiceActivity()
      streamRef.current = stream
      const mimeType = bestMimeType()
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000
      })
      recorderRef.current = recorder
      const chunks: Blob[] = []
      let recordingFailed = false
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size > 0) chunks.push(event.data)
      })
      recorder.addEventListener(
        'error',
        () => {
          if (operationRef.current !== operation || recorderRef.current !== recorder) return
          recordingFailed = true
          pushToTalkHeldRef.current = false
          clearTimers()
          stopStream()
          recorderRef.current = null
          completeSilently()
        },
        { once: true }
      )
      recorder.addEventListener(
        'stop',
        () => finishRecording(
          recorder,
          Math.max(1, Date.now() - startedAtRef.current),
          operation,
          chunks,
          recordingFailed
        ),
        { once: true }
      )
      startedAtRef.current = Date.now()
      recorder.start(250)
      startMeter(stream)
      setStage('recording')
      setStatusMessage(
        source === 'hold' || source === 'external-hold'
          ? `SynVoice gravando; solte ${pushToTalkBinding.label} para transcrever`
          : `SynVoice gravando${target ? ` para ${target.label}` : ''}`
      )
      recordingTimerRef.current = window.setInterval(
        () => setElapsed(Date.now() - startedAtRef.current),
        250
      )
      maxTimerRef.current = window.setTimeout(stopRecording, MAX_RECORDING_MS)
    } catch (reason) {
      if (microphoneRequestRef.current === operation) microphoneRequestRef.current = null
      if (operationRef.current !== operation) return
      clearTimers()
      stopStream()
      if (cancelledRef.current) return
      pushToTalkHeldRef.current = false
      // Falha real de captura NUNCA volta a "pronto" (custou um diagnóstico:
      // o empacotado negava o microfone e o botão parecia simplesmente morto).
      completeSilently('SynVoice sem acesso ao microfone — verifique a permissão de áudio')
    }
  }, [clearTimers, completeSilently, config, finishRecording, microphoneDeviceId, pushToTalkBinding.label, startMeter, stopRecording, stopStream])

  const discard = useCallback((): void => {
    operationRef.current += 1
    microphoneRequestRef.current = null
    cancelledRef.current = true
    if (recorderRef.current?.state && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    }
    recorderRef.current = null
    if (requestRef.current) {
      window.synkora.voice.cancel(requestRef.current)
      requestRef.current = null
    }
    clearTimers()
    stopStream()
    releaseExternalTarget()
    setError('')
    setElapsed(0)
    recordingTargetRef.current = null
    voiceActivityRef.current = freshVoiceActivity()
    pushToTalkHeldRef.current = false
    setPanelOpen(false)
    setStage('idle')
    setStatusMessage('SynVoice pronto')
    window.setTimeout(() => openerRef.current?.focus({ preventScroll: true }), 0)
  }, [clearTimers, releaseExternalTarget, stopStream])

  const saveKey = useCallback(async (): Promise<void> => {
    const value = keyInput.trim()
    if (!value || !config) return
    setSavingKey(true)
    setError('')
    try {
      const next = await window.synkora.voice.setApiKey(config.provider, value)
      setConfig(next)
      setKeyInput('')
      setStage('idle')
      closePanel()
      setStatusMessage('SynVoice configurado e pronto')
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setSavingKey(false)
    }
  }, [closePanel, config, keyInput])

  const clearKey = useCallback(async (): Promise<void> => {
    if (!config) return
    setSavingKey(true)
    setError('')
    try {
      const next = await window.synkora.voice.setApiKey(config.provider, null)
      setConfig(next)
      setKeyInput('')
      setConfirmingRemoval(false)
      setStatusMessage(`Chave da ${config.provider === 'openai' ? 'OpenAI' : 'OpenRouter'} removida`)
      window.setTimeout(() => keyInputRef.current?.focus({ preventScroll: true }), 0)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setSavingKey(false)
    }
  }, [config])

  const chooseProvider = useCallback(async (provider: SynVoiceProvider): Promise<void> => {
    if (!config || provider === config.provider || savingKey) return
    setSavingKey(true)
    setError('')
    setKeyInput('')
    setConfirmingRemoval(false)
    try {
      const next = await window.synkora.voice.setProvider(provider)
      setConfig(next)
      setModels([])
      setStatusMessage(
        next.configured
          ? `SynVoice pronto via ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'}`
          : `Adicione a chave da ${provider === 'openai' ? 'OpenAI' : 'OpenRouter'}`
      )
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setSavingKey(false)
    }
  }, [config, savingKey])

  const chooseModel = useCallback(async (value: string): Promise<void> => {
    if (!config || savingKey) return
    setSavingKey(true)
    setError('')
    try {
      const next = await window.synkora.voice.setModel(
        config.provider,
        value === 'auto' ? null : value
      )
      setConfig(next)
      setStatusMessage(`Modelo do SynVoice: ${next.model}`)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setSavingKey(false)
    }
  }, [config, savingKey])

  const updateVocabulary = useCallback(async (terms: string[]): Promise<boolean> => {
    if (savingVocabulary) return false
    setSavingVocabulary(true)
    setError('')
    try {
      const next = await window.synkora.voice.setCustomVocabulary(terms)
      setConfig(next)
      setStatusMessage('Palavras personalizadas atualizadas')
      return true
    } catch (reason) {
      setError(messageOf(reason))
      return false
    } finally {
      setSavingVocabulary(false)
    }
  }, [savingVocabulary])

  const addVocabularyTerm = useCallback(async (): Promise<void> => {
    if (!config) return
    const term = vocabularyInput.replace(/\s+/g, ' ').trim()
    if (!term) return
    if (term.length > 80) {
      setError('Use até 80 caracteres em cada palavra ou nome.')
      return
    }
    const identity = term.toLocaleLowerCase('pt-BR')
    if (config.customVocabulary.some((item) => item.toLocaleLowerCase('pt-BR') === identity)) {
      setVocabularyInput('')
      return
    }
    if (config.customVocabulary.length >= 50) {
      setError('O glossário aceita até 50 palavras personalizadas.')
      return
    }
    if (await updateVocabulary([...config.customVocabulary, term])) setVocabularyInput('')
  }, [config, updateVocabulary, vocabularyInput])

  const removeVocabularyTerm = useCallback((term: string): void => {
    if (!config) return
    void updateVocabulary(config.customVocabulary.filter((item) => item !== term))
  }, [config, updateVocabulary])

  const chooseActivationMode = useCallback((mode: ActivationMode): void => {
    if (mode === activationMode) return
    pushToTalkHeldRef.current = false
    setCapturingKey(false)
    setCapturingToggle(false)
    setShortcutError('')
    setActivationMode(mode)
    localStorage.setItem(ACTIVATION_MODE_KEY, mode)
    setStatusMessage(
      mode === 'hold'
        ? `SynVoice pronto; segure ${pushToTalkBinding.label} para falar`
        : mode === 'toggle'
          ? `SynVoice pronto; ${toggleBindingPrompt(toggleBinding)} para iniciar ou parar`
          : 'SynVoice pronto; clique para iniciar e clique para parar'
    )
  }, [activationMode, pushToTalkBinding.label, toggleBinding.label])

  const toggleAction = useCallback((): void => {
    if (savingKey) return
    if (stage === 'recording') {
      stopRecording()
      return
    }
    if (stage === 'requesting') {
      discard()
      return
    }
    if (stage === 'processing') return
    void startRecording('toggle')
  }, [discard, savingKey, stage, startRecording, stopRecording])

  const mainAction = useCallback((): void => {
    if (savingKey) return
    if (stage === 'recording') {
      stopRecording()
      return
    }
    if (stage === 'requesting') {
      discard()
      return
    }
    if (stage === 'processing') return
    if (activationMode === 'hold') {
      setStatusMessage(`Segure ${pushToTalkBinding.label} para falar`)
      setPanelOpen(true)
      return
    }
    void startRecording(activationMode === 'toggle' ? 'toggle' : 'click')
  }, [activationMode, discard, pushToTalkBinding.label, savingKey, stage, startRecording, stopRecording])

  const externalAction = useCallback((): void => {
    if (savingKey || stage === 'processing' || stage === 'loading') return
    if (stage === 'recording') {
      stopRecording()
      return
    }
    if (stage === 'requesting') {
      discard()
      return
    }
    void startRecording('external')
  }, [discard, savingKey, stage, startRecording, stopRecording])

  useEffect(() => window.synkora.voice.onOverlayCommand((command) => {
    if (command === 'toggle') {
      externalAction()
      return
    }
    if (command === 'open-settings') {
      setError('')
      setPanelOpen(true)
    }
  }), [externalAction])

  useEffect(() => {
    const state: SynVoiceOverlayState = {
      stage,
      elapsed,
      level,
      bands,
      configured: Boolean(config?.configured),
      status: statusMessage,
      activationMode,
      activationLabel: activationMode === 'hold'
        ? pushToTalkBinding.label
        : activationMode === 'toggle'
          ? toggleBinding.label
          : 'botão'
    }
    window.synkora.voice.publishOverlayState(state)
  }, [
    activationMode,
    bands,
    config?.configured,
    elapsed,
    level,
    pushToTalkBinding.label,
    stage,
    statusMessage,
    toggleBinding.label
  ])

  useEffect(() => {
    let binding: SynVoiceGlobalActivationBinding | null = null
    if (
      detached &&
      config?.configured &&
      !capturingKey &&
      !capturingToggle &&
      activationMode === 'toggle'
    ) {
      binding = toggleBinding.kind === 'mouse'
        ? { mode: 'toggle', kind: 'mouse', button: toggleBinding.button }
        : {
            mode: 'toggle',
            kind: 'keyboard',
            code: toggleBinding.code,
            ctrlKey: toggleBinding.ctrlKey,
            altKey: toggleBinding.altKey,
            shiftKey: toggleBinding.shiftKey,
            metaKey: toggleBinding.metaKey
          }
    } else if (
      detached &&
      config?.configured &&
      !capturingKey &&
      !capturingToggle &&
      activationMode === 'hold'
    ) {
      binding = {
        mode: 'hold',
        kind: 'keyboard',
        code: pushToTalkBinding.code,
        ctrlKey: pushToTalkBinding.ctrlKey,
        altKey: pushToTalkBinding.altKey,
        shiftKey: pushToTalkBinding.shiftKey,
        metaKey: pushToTalkBinding.metaKey
      }
    }
    window.synkora.voice.setGlobalActivation(binding)
    return () => window.synkora.voice.setGlobalActivation(null)
  }, [
    activationMode,
    capturingKey,
    capturingToggle,
    config?.configured,
    detached,
    pushToTalkBinding,
    toggleBinding
  ])

  useEffect(() => window.synkora.voice.onGlobalActivation((event) => {
    if (!detached) return
    if (event === 'toggle' && activationMode === 'toggle') {
      externalAction()
      return
    }
    if (activationMode !== 'hold') return
    if (event === 'hold-start') {
      if (stage !== 'idle' && stage !== 'inserted') return
      pushToTalkHeldRef.current = true
      void startRecording('external-hold')
      return
    }
    if (event === 'hold-stop' && pushToTalkHeldRef.current) {
      pushToTalkHeldRef.current = false
      if (microphoneRequestRef.current !== null) {
        discard()
      } else if (recorderRef.current) {
        stopRecording()
      }
    }
  }), [activationMode, detached, discard, externalAction, stage, startRecording, stopRecording])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (capturingKey || capturingToggle) {
        event.preventDefault()
        event.stopPropagation()
        if (event.repeat) return
        if (event.key === 'Escape') {
          setCapturingKey(false)
          setCapturingToggle(false)
          setShortcutError('')
          return
        }
        if (isModifierCode(event.code)) return
        const next = bindingFromEvent(event)
        if (!next) {
          setShortcutError('Use F1–F12 ou uma combinação com Ctrl ou Alt.')
          return
        }
        if (capturingToggle) {
          const toggle: ToggleBinding = { kind: 'keyboard', ...next }
          setToggleBinding(toggle)
          localStorage.setItem(TOGGLE_BINDING_KEY, JSON.stringify(toggle))
          setCapturingToggle(false)
          setStatusMessage(`Atalho liga/desliga: ${toggle.label}`)
        } else {
          setPushToTalkBinding(next)
          localStorage.setItem(PUSH_TO_TALK_KEY, JSON.stringify(next))
          setCapturingKey(false)
          setStatusMessage(`Tecla de falar: ${next.label}`)
        }
        setShortcutError('')
        return
      }
      if (detached) return
      if (event.repeat) return
      if (
        activationMode === 'hold' &&
        (stage === 'idle' || stage === 'inserted') &&
        matchesBinding(event, pushToTalkBinding)
      ) {
        event.preventDefault()
        event.stopPropagation()
        pushToTalkHeldRef.current = true
        void startRecording('hold')
        return
      }
      if (
        activationMode === 'toggle' &&
        toggleBinding.kind === 'keyboard' &&
        matchesBinding(event, toggleBinding)
      ) {
        event.preventDefault()
        event.stopPropagation()
        toggleAction()
      }
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      if (
        detached ||
        capturingKey ||
        capturingToggle ||
        activationMode !== 'hold' ||
        !pushToTalkHeldRef.current ||
        !releasesBinding(event, pushToTalkBinding)
      ) return
      event.preventDefault()
      event.stopPropagation()
      pushToTalkHeldRef.current = false
      if (microphoneRequestRef.current !== null) {
        discard()
        return
      }
      if (recorderRef.current) stopRecording()
    }

    const onMouseDown = (event: MouseEvent): void => {
      if (capturingToggle) {
        if (event.button === 0 && event.target instanceof Element && event.target.closest('.synvoice-panel')) return
        event.preventDefault()
        event.stopPropagation()
        if (!isSafeMouseButton(event.button)) {
          setShortcutError('Use o botão do meio ou um botão lateral do mouse.')
          return
        }
        const next: ToggleBinding = {
          kind: 'mouse',
          button: event.button,
          label: mouseButtonLabel(event.button)
        }
        setToggleBinding(next)
        localStorage.setItem(TOGGLE_BINDING_KEY, JSON.stringify(next))
        setCapturingToggle(false)
        setShortcutError('')
        setStatusMessage(`Atalho liga/desliga: ${next.label}`)
        return
      }
      if (detached) return
      if (
        activationMode !== 'toggle' ||
        toggleBinding.kind !== 'mouse' ||
        event.button !== toggleBinding.button
      ) return
      event.preventDefault()
      event.stopPropagation()
      toggleAction()
    }

    const onBlur = (): void => {
      if (!pushToTalkHeldRef.current) return
      pushToTalkHeldRef.current = false
      if (microphoneRequestRef.current !== null) {
        discard()
        return
      }
      if (recorderRef.current) stopRecording()
    }

    const suppressToggleMouseDefault = (event: MouseEvent): void => {
      if (
        activationMode !== 'toggle' ||
        toggleBinding.kind !== 'mouse' ||
        event.button !== toggleBinding.button
      ) return
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('mousedown', onMouseDown, true)
    window.addEventListener('mouseup', suppressToggleMouseDefault, true)
    window.addEventListener('auxclick', suppressToggleMouseDefault, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('mousedown', onMouseDown, true)
      window.removeEventListener('mouseup', suppressToggleMouseDefault, true)
      window.removeEventListener('auxclick', suppressToggleMouseDefault, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [
    activationMode,
    capturingKey,
    capturingToggle,
    detached,
    discard,
    pushToTalkBinding,
    stage,
    startRecording,
    stopRecording,
    toggleAction,
    toggleBinding
  ])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      operationRef.current += 1
      microphoneRequestRef.current = null
      cancelledRef.current = true
      if (recorderRef.current?.state && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop()
      }
      recorderRef.current = null
      if (requestRef.current) window.synkora.voice.cancel(requestRef.current)
      requestRef.current = null
      clearTimers()
      stopStream()
      releaseExternalTarget()
      if (insertedTimerRef.current !== null) window.clearTimeout(insertedTimerRef.current)
    }
  }, [clearTimers, releaseExternalTarget, stopStream])

  function beginGesture(event: React.PointerEvent<HTMLElement>): void {
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button, input, textarea, select')) return
    event.currentTarget.setPointerCapture(event.pointerId)
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: panelRect
    }
  }

  function moveGesture(event: React.PointerEvent<HTMLElement>): void {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    const dx = event.clientX - gesture.startX
    const dy = event.clientY - gesture.startY
    setPanelRect(
      clampPanel({ ...gesture.rect, x: gesture.rect.x + dx, y: gesture.rect.y + dy })
    )
  }

  function endGesture(event: React.PointerEvent<HTMLElement>): void {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    gestureRef.current = null
    persistPanel(panelRect)
  }

  const buttonIcon =
    stage === 'recording'
      ? 'stop'
      : stage === 'processing' || stage === 'requesting' || stage === 'loading'
        ? 'processing'
        : stage === 'inserted'
          ? 'done'
          : 'mic'
  const buttonTarget = available(activeTarget) ? activeTarget : null
  const triggerAriaLabel =
    stage === 'recording'
      ? 'Parar gravação do SynVoice'
      : stage === 'requesting'
        ? 'Cancelar abertura do microfone do SynVoice'
        : stage === 'processing'
          ? 'Transcrição do SynVoice em andamento'
          : stage === 'inserted'
            ? activationMode === 'hold'
              ? 'Texto inserido; configurar o modo segure para falar'
              : 'Texto inserido; gravar novamente com o SynVoice'
            : activationMode === 'hold'
              ? `Configurar SynVoice; segure ${pushToTalkBinding.label} para falar`
              : activationMode === 'toggle'
                ? `Iniciar SynVoice; também pode ${toggleBindingPrompt(toggleBinding)}`
                : `Falar com SynVoice${buttonTarget ? ` para ${buttonTarget.label}` : ''}`
  const triggerTip = stage === 'recording'
    ? `${formatTime(elapsed)} · ${triggerAriaLabel}`
    : triggerAriaLabel

  const panel = panelOpen ? (
    <section
      ref={panelRef}
      id="synvoice-panel"
      className={`synvoice-panel term-window setup ${stage}`}
      style={{
        left: `${panelRect.x}px`,
        top: `${panelRect.y}px`,
        width: `${panelRect.width}px`
      }}
      role="dialog"
      aria-modal="false"
      aria-labelledby="synvoice-panel-title"
      tabIndex={-1}
    >
      <header
        className="synvoice-panel-head term-titlebar"
        onPointerDown={beginGesture}
        onPointerMove={moveGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        <span id="synvoice-panel-title" className="term-title">SynVoice</span>
        <span className="synvoice-model">{config?.model ?? 'gpt-transcribe'}</span>
        <button
          type="button"
          className="synvoice-panel-close"
          aria-label="Fechar paleta do SynVoice"
          onClick={closePanel}
        >
          ×
        </button>
      </header>

      <div className="synvoice-setup">
          <div className="synvoice-provider-tabs" role="group" aria-label="Provedor de transcrição">
            {(['openai', 'openrouter'] as const).map((provider) => (
              <button
                key={provider}
                type="button"
                className={config?.provider === provider ? 'active' : ''}
                aria-pressed={config?.provider === provider}
                disabled={savingKey}
                onClick={() => void chooseProvider(provider)}
              >
                {provider === 'openai' ? 'OpenAI' : 'OpenRouter'}
                {config?.providers[provider].configured && <i className="meta-dot run" />}
              </button>
            ))}
          </div>
          <div className="synvoice-kicker">transcrição de alta precisão</div>
          <h2>Configurar o SynVoice</h2>
          <p>
            {config?.provider === 'openrouter' ? (
              <>Escolha entre os modelos de transcrição disponíveis no OpenRouter. A precisão e o preço variam por modelo.</>
            ) : (
              <>O modo automático usa <strong>gpt-transcribe</strong>, hoje a opção recomendada para máxima precisão, por US$ 0,0045/minuto.</>
            )}
          </p>

          <fieldset className="synvoice-activation-field">
            <legend>modo de ativação</legend>
            <div className="synvoice-activation-options" role="group" aria-label="Modo de ativação do SynVoice">
              <button
                type="button"
                aria-pressed={activationMode === 'click'}
                className={activationMode === 'click' ? 'active' : ''}
                disabled={savingKey}
                onClick={() => chooseActivationMode('click')}
              >
                <strong>botão</strong>
                <span>clique no microfone para iniciar e parar</span>
              </button>
              <button
                type="button"
                aria-pressed={activationMode === 'toggle'}
                className={activationMode === 'toggle' ? 'active' : ''}
                disabled={savingKey}
                onClick={() => chooseActivationMode('toggle')}
              >
                <strong>atalho</strong>
                <span>aperte uma vez para ligar e outra para parar</span>
              </button>
              <button
                type="button"
                aria-pressed={activationMode === 'hold'}
                className={activationMode === 'hold' ? 'active' : ''}
                disabled={savingKey}
                onClick={() => chooseActivationMode('hold')}
              >
                <strong>segurar</strong>
                <span>grave somente enquanto mantém a tecla pressionada</span>
              </button>
            </div>
            {activationMode === 'toggle' && (
              <div className="synvoice-shortcut-field">
                <span>acionador liga/desliga</span>
                <button
                  type="button"
                  className={capturingToggle ? 'capturing' : ''}
                  aria-pressed={capturingToggle}
                  onClick={() => {
                    setCapturingKey(false)
                    setCapturingToggle(true)
                    setShortcutError('')
                  }}
                >
                  {capturingToggle ? 'pressione agora…' : toggleBinding.label}
                </button>
                <small>Escolha F1–F12, Ctrl/Alt + tecla, botão do meio ou lateral. Esc cancela.</small>
                {shortcutError && <small className="error" role="alert">{shortcutError}</small>}
              </div>
            )}
            {activationMode === 'hold' && (
              <div className="synvoice-shortcut-field">
                <span>tecla de falar</span>
                <button
                  type="button"
                  className={capturingKey ? 'capturing' : ''}
                  aria-pressed={capturingKey}
                  onClick={() => {
                    setCapturingToggle(false)
                    setCapturingKey(true)
                    setShortcutError('')
                  }}
                >
                  {capturingKey ? 'pressione a tecla…' : pushToTalkBinding.label}
                </button>
                <small>F1–F12 ou Ctrl/Alt + tecla. A gravação só existe enquanto você segura. Esc cancela.</small>
                {shortcutError && <small className="error" role="alert">{shortcutError}</small>}
              </div>
            )}
          </fieldset>

          <label className="synvoice-model-field">
            <span>modelo de transcrição</span>
            <select
              value={config?.providers[config.provider].selectedModel ?? 'auto'}
              disabled={!config || loadingModels || savingKey}
              onChange={(event) => void chooseModel(event.target.value)}
            >
              <option value="auto">
                Automático — {config?.provider === 'openrouter' ? 'recomendado' : 'máxima precisão'}
              </option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.name}</option>
              ))}
            </select>
          </label>

          <section
            aria-labelledby="synvoice-vocabulary-title"
            className="synvoice-vocabulary"
          >
            <div className="synvoice-key-field synvoice-vocabulary-field">
              <span id="synvoice-vocabulary-title">palavras personalizadas</span>
              <div className="synvoice-vocabulary-row">
                <input
                  type="text"
                  value={vocabularyInput}
                  maxLength={80}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Nova palavra ou nome para o SynVoice reconhecer"
                  placeholder="ex.: nome de pessoa, empresa ou produto"
                  disabled={!config || savingVocabulary}
                  className="synvoice-vocabulary-input"
                  onChange={(event) => setVocabularyInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    void addVocabularyTerm()
                  }}
                />
                <button
                  type="button"
                  className="btn ghost synvoice-vocabulary-add"
                  disabled={!vocabularyInput.trim() || savingVocabulary}
                  onClick={() => void addVocabularyTerm()}
                >
                  {savingVocabulary ? 'salvando…' : 'adicionar'}
                </button>
              </div>
            </div>
            {Boolean(config?.customVocabulary.length) && (
              <div
                role="list"
                aria-label="Palavras personalizadas salvas"
                className="synvoice-vocabulary-list"
              >
                {config?.customVocabulary.map((term) => (
                  <span key={term} role="listitem">
                    <button
                      type="button"
                      className="synvoice-vocabulary-chip"
                      aria-label={`Remover ${term} das palavras personalizadas`}
                      disabled={savingVocabulary}
                      onClick={() => removeVocabularyTerm(term)}
                    >
                      <span>{term}</span>
                      <i aria-hidden="true">×</i>
                    </button>
                  </span>
                ))}
              </div>
            )}
            <small className="synvoice-vocabulary-help">
              A IA usa estes nomes como contexto e o SynVoice padroniza a grafia reconhecida. Synkora e suas variações faladas vêm incluídos.
            </small>
          </section>

          {config?.configured ? (
            <div className="synvoice-configured">
              <span className="meta-dot run" />
              <span>{config.provider === 'openai' ? 'OpenAI' : 'OpenRouter'} configurada no cofre seguro</span>
            </div>
          ) : (
            <div className="synvoice-configured warn">
              <span className="meta-dot err" />
              <span>adicione uma chave da API da {config?.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'}</span>
            </div>
          )}

          <label className={`synvoice-key-field${config?.configured ? ' locked' : ''}`}>
            <span>chave da API</span>
            {config?.configured ? (
              <input
                type="text"
                value="••••••••••••••••••••••••"
                readOnly
                aria-label="Chave da API protegida e bloqueada"
              />
            ) : (
              <input
                ref={keyInputRef}
                type="password"
                value={keyInput}
                autoComplete="off"
                spellCheck={false}
                placeholder={config?.provider === 'openrouter' ? 'sk-or-v1-…' : 'sk-proj-…'}
                onChange={(event) => setKeyInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveKey()
                }}
              />
            )}
          </label>
          {error && <div className="synvoice-error" role="alert">{error}</div>}
          <div className="synvoice-setup-actions">
            {config?.configured ? (
              confirmingRemoval ? (
                <>
                  <span className="synvoice-remove-warning" role="status">Remover libera o cadastro de outra chave.</span>
                  <button
                    ref={cancelRemovalButtonRef}
                    type="button"
                    className="btn ghost"
                    disabled={savingKey}
                    onClick={() => {
                      setConfirmingRemoval(false)
                      window.setTimeout(() => removeKeyButtonRef.current?.focus({ preventScroll: true }), 0)
                    }}
                  >
                    cancelar
                  </button>
                  <button type="button" className="btn ghost danger" disabled={savingKey} onClick={() => void clearKey()}>
                    {savingKey ? 'removendo…' : 'confirmar remoção'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    ref={removeKeyButtonRef}
                    type="button"
                    className="btn ghost danger"
                    disabled={savingKey}
                    onClick={() => {
                      setConfirmingRemoval(true)
                      window.setTimeout(() => cancelRemovalButtonRef.current?.focus({ preventScroll: true }), 0)
                    }}
                  >
                    remover chave
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => config && window.open(BILLING_URL[config.provider], '_blank', 'noopener,noreferrer')}
                  >
                    créditos da {config?.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} ↗
                  </button>
                </>
              )
            ) : (
              <>
                <button type="button" className="btn ghost" onClick={() => config && void window.synkora.voice.openApiKeys(config.provider)}>
                  criar chave na {config?.provider === 'openrouter' ? 'OpenRouter' : 'OpenAI'} ↗
                </button>
                <button type="button" className="btn primary" disabled={!keyInput.trim() || savingKey} onClick={() => void saveKey()}>
                  {savingKey ? 'salvando…' : 'salvar com segurança'}
                </button>
              </>
            )}
          </div>
          <p className="synvoice-security-note">
            A chave fica cifrada pelo cofre do sistema e nunca é devolvida à interface. A cobrança da API é separada da assinatura do ChatGPT.
          </p>
      </div>

    </section>
  ) : null

  return (
    <div className={`synvoice-title-control ${stage}${detached ? ' detached' : ''}`}>
      <button
        type="button"
        className="tb-btn synvoice-trigger"
        data-tip={triggerTip}
        aria-label={triggerAriaLabel}
        aria-pressed={stage === 'recording'}
        aria-expanded={panelOpen}
        aria-controls="synvoice-panel"
        disabled={stage === 'loading' || stage === 'processing' || savingKey}
        onClick={(event) => {
          openerRef.current = event.currentTarget
          mainAction()
        }}
      >
        <SynVoiceIcon state={buttonIcon} />
        {stage === 'recording' && (
          <span className="synvoice-level" aria-hidden="true">
            {[0.65, 1, 0.8, 0.55].map((weight, index) => (
              <i key={index} style={{ transform: `scaleY(${Math.max(0.18, level * weight)})` }} />
            ))}
          </span>
        )}
        {!config?.configured && stage !== 'loading' && <i className="synvoice-needs-key" aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="tb-btn synvoice-detach-trigger"
        data-tip="Abrir o mini SynVoice em uma janela separada"
        aria-label="Destacar mini SynVoice"
        disabled={stage === 'loading' || savingKey}
        onClick={() => void window.synkora.voice.openOverlay()}
      >
        <SynVoiceWindowIcon mode="detach" size={15} />
      </button>
      <div className="synvoice-history-anchor" ref={historyAnchorRef}>
        <button
          type="button"
          className="tb-btn synvoice-history-trigger"
          data-tip={'Últimas falas transcritas\nclique numa fala para copiá-la'}
          aria-label="Últimas falas do SynVoice"
          aria-expanded={historyOpen}
          disabled={stage === 'loading'}
          onClick={() => {
            const next = !historyOpen
            setHistoryOpen(next)
            if (next) {
              void window.synkora.voice
                .history?.()
                .then((list) => Array.isArray(list) && setHistory(list))
            }
          }}
        >
          ↺
        </button>
        {historyOpen && (
          <div className="synvoice-history-menu" role="menu">
            <b className="synvoice-history-title">últimas falas</b>
            {history.length === 0 && (
              <span className="synvoice-history-empty">nada transcrito ainda</span>
            )}
            {history.map((entry, index) => (
              <button
                key={`${entry.at}-${index}`}
                type="button"
                className="synvoice-history-item"
                role="menuitem"
                onClick={() => {
                  void window.synkora.voice.historyCopy?.(index).then((ok) => {
                    if (ok) {
                      window.synkora.voice.showNotice(
                        'fala copiada — cole onde precisar (Ctrl+V)',
                        'info'
                      )
                    }
                  })
                  setHistoryOpen(false)
                }}
              >
                <span>{entry.text}</span>
                <small>
                  {new Date(entry.at).toLocaleTimeString('pt-BR', {
                    hour: '2-digit',
                    minute: '2-digit'
                  })}{' '}
                  · copiar
                </small>
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className="tb-btn synvoice-settings-trigger"
        data-tip="Configurar microfone, atalho e transcrição do SynVoice"
        aria-label="Configurar SynVoice"
        aria-expanded={panelOpen}
        aria-controls="synvoice-panel"
        disabled={savingKey || stage === 'loading' || stage === 'requesting' || stage === 'recording' || stage === 'processing'}
        onClick={(event) => {
          openerRef.current = event.currentTarget
          setPanelOpen(true)
          setError('')
        }}
      >
        <TitleBarIcon name="tune" size={15} />
      </button>
      <span className="synvoice-live" role="status" aria-live="polite">{statusMessage}</span>
      {panel && createPortal(panel, document.body)}
    </div>
  )
}
