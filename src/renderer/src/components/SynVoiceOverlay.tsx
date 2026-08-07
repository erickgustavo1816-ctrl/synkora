import { useEffect, useRef, useState } from 'react'
import type { SynVoiceOverlayState } from '../../../preload/index'
import SynkoraMark from './SynkoraMark'
import SynVoiceIcon from './SynVoiceIcon'
import SynVoiceWindowIcon from './SynVoiceWindowIcon'
import TitleBarIcon from './TitleBarIcon'

const INITIAL_STATE: SynVoiceOverlayState = {
  stage: 'loading',
  elapsed: 0,
  level: 0,
  bands: Array.from({ length: 13 }, () => 0),
  configured: false,
  status: 'Carregando o SynVoice',
  activationMode: 'click',
  activationLabel: 'botão'
}

const WAVE_BAND_COUNT = 13

function SynVoiceHistoryIcon(): React.JSX.Element {
  return (
    <svg
      className="synvoice-overlay-action-icon"
      viewBox="0 0 20 20"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5.1 3.25v3.5h3.5" />
      <path d="M5.25 6.45A6.25 6.25 0 1 1 3.75 10" />
      <path d="M10 6.45v3.9l2.65 1.55" />
    </svg>
  )
}

function LiveVoiceWave({ bands }: { bands: number[] }): React.JSX.Element {
  const values = Array.from({ length: WAVE_BAND_COUNT }, (_, index) =>
    Math.max(0, Math.min(1, Number(bands[index]) || 0))
  )

  return (
    <span className="synvoice-overlay-level" aria-hidden="true">
      {values.map((value, index) => (
        <i
          key={index}
          style={{
            transform: `scaleY(${0.08 + value * 0.92})`,
            opacity: 0.34 + value * 0.66
          }}
        />
      ))}
    </span>
  )
}

function formatElapsed(elapsed: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsed / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function conciseActivationLabel(value: string): string {
  const mouse = value.match(/\bmouse\s*(\d+)\b/i)
  if (mouse) return `MOUSE ${mouse[1]}`
  return value.trim()
}

function stagePresentation(state: SynVoiceOverlayState): {
  icon: 'mic' | 'stop' | 'processing' | 'done'
  title: string
  actionLabel: string
} {
  switch (state.stage) {
    case 'loading':
      return {
        icon: 'processing',
        title: 'Carregando',
        actionLabel: 'SynVoice carregando'
      }
    case 'requesting':
      return {
        icon: 'processing',
        title: 'Abrindo microfone',
        actionLabel: 'Cancelar abertura do microfone'
      }
    case 'recording':
      return {
        icon: 'stop',
        title: 'Ouvindo',
        actionLabel: 'Parar e transcrever'
      }
    case 'processing':
      return {
        icon: 'processing',
        title: 'Transcrevendo',
        actionLabel: 'Transcrição em andamento'
      }
    case 'inserted':
      return {
        icon: 'done',
        title: 'Texto inserido',
        actionLabel: 'Gravar novamente'
      }
    case 'idle':
    default:
      if (!state.configured) {
        return {
            icon: 'mic',
            title: 'Configure o SynVoice',
            actionLabel: 'Começar a gravar'
        }
      }
      if (state.activationMode === 'hold') {
        return {
          icon: 'mic',
          title: conciseActivationLabel(state.activationLabel),
          actionLabel: 'Abrir configuração da tecla de falar'
        }
      }
      if (state.activationMode === 'toggle') {
        return {
          icon: 'mic',
          title: conciseActivationLabel(state.activationLabel),
          actionLabel: 'Começar a gravar ou usar o atalho'
        }
      }
      return {
        icon: 'mic',
        title: 'Pronto para falar',
        actionLabel: 'Começar a gravar'
      }
  }
}

export default function SynVoiceOverlay(): React.JSX.Element {
  const [state, setState] = useState<SynVoiceOverlayState>(INITIAL_STATE)
  // Banquinho das últimas falas no mini destacado (2026-08-06): abrir cresce
  // a própria janela (IPC no main); gravar/transcrever fecha para dar espaço.
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<Array<{ text: string; at: string }>>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null)
  const historyTriggerRef = useRef<HTMLButtonElement>(null)
  const closeHistory = (): void => {
    setHistoryOpen(false)
    setHistoryLoading(false)
    setHistoryError('')
    setCopiedIndex(null)
    window.synkoraOverlay.setHistoryOpen?.(false)
  }
  useEffect(() => {
    if (!historyOpen) return
    if (state.stage === 'recording' || state.stage === 'processing' || state.stage === 'requesting') {
      closeHistory()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, state.stage])

  useEffect(() => {
    if (!historyOpen) return
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setHistoryOpen(false)
      setHistoryLoading(false)
      setHistoryError('')
      setCopiedIndex(null)
      window.synkoraOverlay.setHistoryOpen?.(false)
      window.requestAnimationFrame(() => historyTriggerRef.current?.focus())
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [historyOpen])

  useEffect(() => {
    document.documentElement.classList.add('synvoice-overlay-page')
    document.body.classList.add('synvoice-overlay-page')
    return () => {
      document.documentElement.classList.remove('synvoice-overlay-page')
      document.body.classList.remove('synvoice-overlay-page')
    }
  }, [])

  useEffect(() => {
    let mounted = true
    let receivedLiveState = false
    const overlay = window.synkoraOverlay
    const unsubscribe = overlay.onState((next: SynVoiceOverlayState) => {
      if (!mounted) return
      receivedLiveState = true
      setState(next)
    })

    void overlay
      .getState()
      .then((next: SynVoiceOverlayState) => {
        if (mounted && !receivedLiveState) setState(next)
      })
      .catch(() => {
        // A mini-janela permanece discreta; a ponte tentará publicar o próximo estado.
      })

    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const presentation = stagePresentation(state)
  const isRecording = state.stage === 'recording'
  const mainDisabled = state.stage === 'loading' || state.stage === 'processing'
  const navigationDisabled =
    state.stage === 'requesting' || state.stage === 'recording' || state.stage === 'processing'
  const subtitle = isRecording
    ? `${formatElapsed(state.elapsed)} · ${state.activationMode === 'hold' ? `solte ${state.activationLabel}` : 'clique para transcrever'}`
    : state.stage === 'idle' && state.configured
      ? ''
      : state.status || 'Abra as configurações'
  return (
    <>
      <main
        className={`synvoice-overlay-shell ${state.stage}`}
        aria-label="Mini SynVoice"
        onPointerEnter={() => window.synkoraOverlay.prepareInteraction()}
      >
        <span className="synvoice-overlay-lead synvoice-overlay-drag" aria-hidden="true">
          <SynkoraMark size={15} className="synvoice-overlay-brand" />
          <span className="synvoice-overlay-handle">
            <i />
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
        </span>

        <button
          type="button"
          className="synvoice-overlay-main synvoice-overlay-no-drag"
          data-tip={presentation.actionLabel}
          aria-label={presentation.actionLabel}
          disabled={mainDisabled}
          onClick={() => window.synkoraOverlay.command(
            state.activationMode === 'hold' ? 'open-settings' : 'toggle'
          )}
        >
          <span className="synvoice-overlay-main-icon" aria-hidden="true">
            <SynVoiceIcon state={presentation.icon} />
          </span>

          <span className="synvoice-overlay-copy">
            <strong>{presentation.title}</strong>
            {(isRecording || subtitle) && (
              <small>{isRecording ? formatElapsed(state.elapsed) : subtitle}</small>
            )}
          </span>

          {isRecording && <LiveVoiceWave bands={state.bands} />}
        </button>

        <nav
          className="synvoice-overlay-actions synvoice-overlay-no-drag"
          aria-label="Ações do SynVoice"
        >
          <button
            ref={historyTriggerRef}
            type="button"
            className="synvoice-overlay-action synvoice-overlay-no-drag synvoice-overlay-history-trigger"
            data-tip={'Últimas falas transcritas\nclique numa fala para copiá-la'}
            aria-label="Últimas falas do SynVoice"
            aria-expanded={historyOpen}
            disabled={navigationDisabled}
            onClick={() => {
              if (historyOpen) {
                closeHistory()
                return
              }
              setHistoryOpen(true)
              setHistoryLoading(true)
              setHistoryError('')
              window.synkoraOverlay.setHistoryOpen?.(true)
              void Promise.resolve(window.synkoraOverlay.history?.() ?? [])
                .then((list) => Array.isArray(list) && setHistory(list))
                .catch(() => {
                  setHistory([])
                  setHistoryError('não foi possível carregar as falas')
                })
                .finally(() => setHistoryLoading(false))
            }}
          >
            <SynVoiceHistoryIcon />
          </button>
          <button
            type="button"
            className="synvoice-overlay-action synvoice-overlay-no-drag"
            data-tip="Abrir configurações do SynVoice"
            aria-label="Abrir configurações do SynVoice"
            disabled={navigationDisabled}
            onClick={() => {
              closeHistory()
              window.synkoraOverlay.command('open-settings')
            }}
          >
            <TitleBarIcon name="tune" size={14} className="synvoice-overlay-action-icon" />
          </button>
          <button
            type="button"
            className="synvoice-overlay-action synvoice-overlay-no-drag"
            data-tip="Voltar o SynVoice para o cabeçalho"
            aria-label="Voltar ao Synkora"
            disabled={navigationDisabled}
            onClick={() => {
              closeHistory()
              window.synkoraOverlay.command('attach')
            }}
          >
            <SynVoiceWindowIcon mode="attach" size={14} className="synvoice-overlay-action-icon" />
          </button>
        </nav>
      </main>
      {historyOpen && (
        <section
          className="synvoice-overlay-history"
          aria-label="Últimas falas transcritas"
          aria-busy={historyLoading}
        >
          <b className="synvoice-history-title">últimas falas</b>
          {historyLoading && (
            <span className="synvoice-history-empty">carregando falas…</span>
          )}
          {!historyLoading && historyError && (
            <span className="synvoice-history-empty error">{historyError}</span>
          )}
          {!historyLoading && !historyError && history.length === 0 && (
            <span className="synvoice-history-empty">nada transcrito ainda</span>
          )}
          {history.map((entry, index) => (
            <button
              key={`${entry.at}-${index}`}
              type="button"
              className={`synvoice-history-item ${copiedIndex === index ? 'copied' : ''}`}
              onClick={() => {
                void window.synkoraOverlay.historyCopy?.(index).then((ok) => {
                  if (!ok) return
                  setCopiedIndex(index)
                  window.setTimeout(() => setCopiedIndex((prev) => (prev === index ? null : prev)), 1400)
                })
              }}
            >
              <span>{entry.text}</span>
              <small aria-live="polite">
                {copiedIndex === index
                  ? 'copiado ✓'
                  : `${new Date(entry.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} · copiar`}
              </small>
            </button>
          ))}
        </section>
      )}
    </>
  )
}
