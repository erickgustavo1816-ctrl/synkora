/**
 * IPC — domínio voice (fase 1, commit 5).
 * SynVoice — a ilha quase perfeita do mapa: 26 handlers + o banquinho
 * de historico (estado privado que viaja junto). Os lets do overlay que os
 * handlers LEEM/ESCREVEM chegam via extras.state (getters/setters do index
 * fechando sobre os lets — leitura e escrita textuais continuam validas).
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import {
  BrowserWindow,
  app,
  clipboard,
  ipcMain,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { join } from 'path'
import { type SynVoiceProvider } from '../synVoice'
import { WindowsTextInput } from '../windowsTextInput'
import { WindowsGlobalActivation, type GlobalActivationBinding } from '../windowsGlobalActivation'
import { loadJsonStore, persistJsonStore } from '../jsonStore'
import type { MainContext } from '../mainContext'
import type {
  SynVoiceNoticeTone,
  SynVoiceOverlayCommand,
  SynVoiceOverlayState,
  SynVoiceOverlayTooltipRequest
} from '../index'

/** Lets do closure do index que estes handlers leem/escrevem — o call
 * site entrega getters/setters fechando sobre as variáveis reais. */
export interface VoiceIpcState {
  readonly synVoiceOverlayWindow: BrowserWindow | null
  synVoicePendingOverlayTarget: Promise<string | null> | null
  synVoiceActiveOverlayTargetToken: string | null
  synVoiceOverlayCommandInFlight: boolean
  latestSynVoiceOverlayState: SynVoiceOverlayState
  readonly synVoiceDetached: boolean
}

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface VoiceIpcExtras {
  assertMainVoiceSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  assertOverlayVoiceSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  prepareSynVoiceExternalTarget(): void
  takePreparedSynVoiceTarget(): Promise<string | null> | null
  restoreSynVoiceTarget(token: string | null): Promise<void>
  normalizeSynVoiceOverlayState(value: unknown): SynVoiceOverlayState | null
  isNoSpeechTranscript(value: string): boolean
  safeExternalTranscript(value: string): string
  showMainWindow(): void
  setSynVoiceDetached(detached: boolean): void
  safeSynVoicePopupText(value: unknown, maxLength: number): string
  normalizeSynVoiceTooltipRequest(value: unknown): SynVoiceOverlayTooltipRequest | null
  hideSynVoiceOverlayTooltip(): void
  showSynVoiceOverlayTooltip(request: SynVoiceOverlayTooltipRequest): Promise<void>
  hideSynVoiceNotice(): void
  showSynVoiceNotice(message: string, tone: SynVoiceNoticeTone): Promise<void>
  setSynVoiceOverlayHistoryOpen(expanded: boolean): void
  toggleSynVoiceOverlay(): void
  synVoiceExternalInput: WindowsTextInput
  synVoiceGlobalActivation: WindowsGlobalActivation
  SYNVOICE_ATOMIC_PASTE_THRESHOLD: number
  state: VoiceIpcState
}

export function registerVoiceIpc(ctx: MainContext, extras: VoiceIpcExtras): void {
  const {
    settings,
    synVoice,
    voiceRequests
  } = ctx
  const {
    assertMainVoiceSender,
    assertOverlayVoiceSender,
    prepareSynVoiceExternalTarget,
    takePreparedSynVoiceTarget,
    restoreSynVoiceTarget,
    normalizeSynVoiceOverlayState,
    isNoSpeechTranscript,
    safeExternalTranscript,
    showMainWindow,
    setSynVoiceDetached,
    safeSynVoicePopupText,
    normalizeSynVoiceTooltipRequest,
    hideSynVoiceOverlayTooltip,
    showSynVoiceOverlayTooltip,
    hideSynVoiceNotice,
    showSynVoiceNotice,
    setSynVoiceOverlayHistoryOpen,
    toggleSynVoiceOverlay,
    synVoiceExternalInput,
    synVoiceGlobalActivation,
    SYNVOICE_ATOMIC_PASTE_THRESHOLD,
    state
  } = extras
  // Banquinho do SynVoice: as últimas 4 falas transcritas, persistidas — o
  // caso real é falar, transcrever, e o destino não estava focado: o texto se
  // perdia e era preciso falar tudo de novo. Só TEXTO + hora; áudio nunca é
  // retido (contrato de privacidade do SynVoice intacto).
  const voiceHistoryFile = join(app.getPath('userData'), 'synvoice-history.json')
  type VoiceHistoryEntry = { text: string; at: string }
  const voiceHistory: VoiceHistoryEntry[] = loadJsonStore<VoiceHistoryEntry[]>(
    voiceHistoryFile,
    () => [],
    (v): v is VoiceHistoryEntry[] =>
      Array.isArray(v) &&
      v.every(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as VoiceHistoryEntry).text === 'string' &&
          typeof (entry as VoiceHistoryEntry).at === 'string'
      )
  )
  const rememberVoiceTranscript = (rawText: string): void => {
    const text = rawText.trim()
    if (!text) return
    voiceHistory.unshift({ text: text.slice(0, 4000), at: new Date().toISOString() })
    voiceHistory.splice(4)
    try {
      persistJsonStore(voiceHistoryFile, voiceHistory)
    } catch {
      // histórico é rede de conforto — a transcrição em si já foi entregue
    }
  }

  ipcMain.handle('voice:overlay-open', (e) => {
    assertMainVoiceSender(e)
    toggleSynVoiceOverlay()
  })

  ipcMain.handle('voice:overlay-get-state', (e) => {
    assertOverlayVoiceSender(e)
    return state.latestSynVoiceOverlayState
  })

  ipcMain.on('voice:overlay-prepare-interaction', (e) => {
    try {
      assertOverlayVoiceSender(e)
      prepareSynVoiceExternalTarget()
    } catch {
      // Apenas a mini autenticada pode preparar o destino externo.
    }
  })

  ipcMain.on('voice:overlay-tooltip-show', (e, value: unknown) => {
    try {
      assertOverlayVoiceSender(e)
      const request = normalizeSynVoiceTooltipRequest(value)
      if (!request || !state.synVoiceDetached) return
      void showSynVoiceOverlayTooltip(request).catch(() => hideSynVoiceOverlayTooltip())
    } catch {
      hideSynVoiceOverlayTooltip()
    }
  })

  ipcMain.on('voice:overlay-tooltip-hide', (e) => {
    try {
      assertOverlayVoiceSender(e)
      hideSynVoiceOverlayTooltip()
    } catch {
      // Uma janela sem a identidade do mini não controla seus pop-ups.
    }
  })

  ipcMain.handle('voice:overlay-is-detached', (e) => {
    assertMainVoiceSender(e)
    return state.synVoiceDetached
  })

  ipcMain.on('voice:overlay-state', (e, value: unknown) => {
    try {
      assertMainVoiceSender(e)
      const next = normalizeSynVoiceOverlayState(value)
      if (!next) return
      const previousStage = state.latestSynVoiceOverlayState.stage
      state.latestSynVoiceOverlayState = next
      if (state.synVoiceOverlayWindow && !state.synVoiceOverlayWindow.isDestroyed()) {
        state.synVoiceOverlayWindow.webContents.send('voice:overlay-state-changed', next)
      }
      if (
        previousStage !== next.stage &&
        (next.stage === 'idle' || next.stage === 'inserted')
      ) prepareSynVoiceExternalTarget()
    } catch {
      // Estado vindo de outra janela é ignorado.
    }
  })

  // Banquinho no MINI destacado (2026-08-06): a janela do mini é FIXA
  // (255×72) — abrir as falas cresce a PRÓPRIA janela para baixo (sobe se
  // estourar a área útil) e fechar restaura a altura original.
  ipcMain.handle('voice:overlay-history', (e) => {
    assertOverlayVoiceSender(e)
    return [...voiceHistory]
  })

  ipcMain.handle('voice:overlay-history-copy', (e, index: number) => {
    assertOverlayVoiceSender(e)
    const entry = voiceHistory[Math.trunc(index)]
    if (!entry) return false
    clipboard.writeText(entry.text)
    return true
  })

  ipcMain.on('voice:overlay-history-open', (e, open: unknown) => {
    try {
      assertOverlayVoiceSender(e)
      if (!state.synVoiceOverlayWindow || state.synVoiceOverlayWindow.isDestroyed()) return
      setSynVoiceOverlayHistoryOpen(open === true)
    } catch {
      // janela morrendo no meio do gesto — nada a redimensionar
    }
  })

  ipcMain.on('voice:overlay-command', (e, value: unknown) => {
    try {
      assertOverlayVoiceSender(e)
      hideSynVoiceOverlayTooltip()
      const allowed = new Set<SynVoiceOverlayCommand>([
        'toggle', 'attach', 'open-settings'
      ])
      if (typeof value !== 'string' || !allowed.has(value as SynVoiceOverlayCommand)) return
      const command = value as SynVoiceOverlayCommand
      const busy = state.latestSynVoiceOverlayState.stage === 'requesting' ||
        state.latestSynVoiceOverlayState.stage === 'recording' ||
        state.latestSynVoiceOverlayState.stage === 'processing'
      if (busy && command !== 'toggle') return
      if (command === 'attach') {
        setSynVoiceOverlayHistoryOpen(false)
        state.synVoiceOverlayWindow?.hide()
        setSynVoiceDetached(false)
        showMainWindow()
        return
      }
      if (command === 'open-settings' || !state.latestSynVoiceOverlayState.configured) {
        setSynVoiceOverlayHistoryOpen(false)
        showMainWindow()
        ctx.mainWindow?.webContents.send('voice:overlay-command-received', 'open-settings')
        return
      }
      if (state.synVoiceOverlayCommandInFlight) return
      state.synVoiceOverlayCommandInFlight = true
      void (async () => {
        try {
          if (state.latestSynVoiceOverlayState.stage === 'recording') {
            await restoreSynVoiceTarget(state.synVoiceActiveOverlayTargetToken)
          } else if (
            state.latestSynVoiceOverlayState.stage !== 'requesting' &&
            state.latestSynVoiceOverlayState.stage !== 'processing'
          ) {
            const prepared = takePreparedSynVoiceTarget()
            state.synVoicePendingOverlayTarget = prepared
            if (prepared) await restoreSynVoiceTarget(await prepared)
          }
          ctx.mainWindow?.webContents.send('voice:overlay-command-received', 'toggle')
        } finally {
          state.synVoiceOverlayCommandInFlight = false
        }
      })()
    } catch {
      // Comando vindo de outra janela é ignorado.
    }
  })

  ipcMain.on('voice:show-notice', (e, value: unknown) => {
    try {
      assertMainVoiceSender(e)
      if (!value || typeof value !== 'object') return
      const input = value as { message?: unknown; tone?: unknown }
      const message = safeSynVoicePopupText(input.message, 280)
      if (!message) return
      const tone: SynVoiceNoticeTone =
        input.tone === 'warning' || input.tone === 'info' ? input.tone : 'error'
      void showSynVoiceNotice(message, tone).catch(() => hideSynVoiceNotice())
    } catch {
      // Avisos só podem ser disparados pelo renderer principal autenticado.
    }
  })

  ipcMain.on('voice:global-activation-config', (e, value: unknown) => {
    try {
      assertMainVoiceSender(e)
      if (!state.synVoiceDetached || value === null) {
        synVoiceGlobalActivation.stop()
        return
      }
      void synVoiceGlobalActivation.configure(
        value as GlobalActivationBinding,
        (activationEvent) => {
          if (!state.synVoiceDetached || !ctx.mainWindow || ctx.mainWindow.isDestroyed()) return
          ctx.mainWindow.webContents.send('voice:global-activation-event', activationEvent)
        }
      ).catch(() => undefined)
    } catch {
      synVoiceGlobalActivation.stop()
    }
  })

  ipcMain.handle('voice:external-begin', async (e) => {
    assertMainVoiceSender(e)
    const pendingOverlayTarget = state.synVoicePendingOverlayTarget
    state.synVoicePendingOverlayTarget = null
    if (pendingOverlayTarget) {
      const token = await pendingOverlayTarget
      if (token) {
        state.synVoiceActiveOverlayTargetToken = token
        return token
      }
    }
    if (
      state.synVoiceDetached &&
      state.synVoiceOverlayWindow &&
      !state.synVoiceOverlayWindow.isDestroyed() &&
      state.synVoiceOverlayWindow.isFocused()
    ) {
      const prepared = takePreparedSynVoiceTarget()
      if (prepared) {
        const token = await prepared
        if (token) {
          state.synVoiceActiveOverlayTargetToken = token
          return token
        }
      }
    }
    return synVoiceExternalInput.capture(e.sender.id)
  })

  ipcMain.on('voice:external-discard', (e, token: unknown) => {
    try {
      assertMainVoiceSender(e)
      if (typeof token === 'string') {
        synVoiceExternalInput.discard(token)
        if (state.synVoiceActiveOverlayTargetToken === token) state.synVoiceActiveOverlayTargetToken = null
      }
    } catch {
      // Token vindo de outra janela é ignorado.
    }
  })

  ipcMain.handle('voice:getConfig', (e) => {
    assertMainVoiceSender(e)
    return synVoice.getConfig()
  })

  ipcMain.handle('voice:setProvider', (e, provider: SynVoiceProvider) => {
    assertMainVoiceSender(e)
    return synVoice.setProvider(provider)
  })

  ipcMain.handle('voice:setModel', async (e, provider: SynVoiceProvider, model: string | null) => {
    assertMainVoiceSender(e)
    return synVoice.setModel(provider, model)
  })

  ipcMain.handle('voice:setCustomVocabulary', (e, terms: unknown) => {
    assertMainVoiceSender(e)
    return synVoice.setCustomVocabulary(terms)
  })

  ipcMain.handle('voice:listModels', async (e, provider: SynVoiceProvider) => {
    assertMainVoiceSender(e)
    return synVoice.listModels(provider)
  })

  ipcMain.handle('voice:setApiKey', (e, provider: SynVoiceProvider, key: string | null) => {
    assertMainVoiceSender(e)
    if (key !== null && typeof key !== 'string') throw new Error('Chave da API inválida.')
    return synVoice.setApiKey(provider, key)
  })

  ipcMain.handle('voice:openApiKeys', (e, provider: SynVoiceProvider) => {
    assertMainVoiceSender(e)
    return shell.openExternal(synVoice.getApiKeysUrl(provider))
  })

  ipcMain.handle('voice:history', (e) => {
    assertMainVoiceSender(e)
    return [...voiceHistory]
  })

  ipcMain.handle('voice:historyCopy', (e, index: number) => {
    assertMainVoiceSender(e)
    const entry = voiceHistory[Math.trunc(index)]
    if (!entry) return false
    clipboard.writeText(entry.text)
    return true
  })

  ipcMain.handle(
    'voice:transcribe',
    async (
      e,
      request: {
        requestId: string
        audio: Uint8Array | ArrayBuffer
        mimeType: string
        durationMs: number
        externalTargetToken?: string | null
      }
    ) => {
      assertMainVoiceSender(e)
      const externalRequested = Object.prototype.hasOwnProperty.call(
        request ?? {},
        'externalTargetToken'
      )
      const externalTargetToken = typeof request?.externalTargetToken === 'string'
        ? request.externalTargetToken
        : null
      const releaseExternalTarget = (): void => {
        if (externalTargetToken) {
          synVoiceExternalInput.discard(externalTargetToken)
          if (state.synVoiceActiveOverlayTargetToken === externalTargetToken) {
            state.synVoiceActiveOverlayTargetToken = null
          }
        }
      }
      if (
        externalRequested &&
        request?.externalTargetToken !== null &&
        typeof request?.externalTargetToken !== 'string'
      ) {
        releaseExternalTarget()
        throw new Error('Destino externo inválido.')
      }
      const requestId = String(request?.requestId ?? '')
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) {
        releaseExternalTarget()
        throw new Error('Identificador de transcrição inválido.')
      }
      if (voiceRequests.size > 0) {
        releaseExternalTarget()
        throw new Error('Já existe uma transcrição do SynVoice em andamento.')
      }
      const controller = new AbortController()
      const senderId = e.sender.id
      voiceRequests.set(requestId, { controller, senderId })
      const abortOnDestroyed = (): void => controller.abort()
      e.sender.once('destroyed', abortOnDestroyed)
      try {
        const byteLength =
          request.audio instanceof Uint8Array || request.audio instanceof ArrayBuffer
            ? request.audio.byteLength
            : 0
        if (byteLength <= 0 || byteLength > 20 * 1024 * 1024) {
          throw new Error('O tamanho da gravação é inválido.')
        }
        const audio =
          request.audio instanceof Uint8Array
            ? request.audio
            : request.audio instanceof ArrayBuffer
              ? new Uint8Array(request.audio)
              : new Uint8Array()
        const transcript = await synVoice.transcribe(
          {
            audio,
            mimeType: String(request.mimeType ?? ''),
            durationMs: Number(request.durationMs)
          },
          controller.signal
        )
        if (controller.signal.aborted) throw new Error('Transcrição cancelada.')
        // Banquinho do SynVoice (pedido do usuário, 2026-08-06): TODA fala
        // transcrita entra no histórico ANTES de qualquer entrega — destino
        // perdido/sem foco nunca mais custa falar tudo de novo.
        if (!isNoSpeechTranscript(transcript.text)) rememberVoiceTranscript(transcript.text)
        if (!externalRequested) return transcript
        if (isNoSpeechTranscript(transcript.text)) {
          return { ...transcript, delivery: 'none' as const }
        }
        const safeText = safeExternalTranscript(transcript.text)
        if (!safeText) return { ...transcript, delivery: 'none' as const }

        let delivery: 'inserted' | 'clipboard' | 'uncertain' = 'clipboard'
        if (externalTargetToken) {
          const insertionMode = safeText.length >= SYNVOICE_ATOMIC_PASTE_THRESHOLD
            ? 'paste' as const
            : 'unicode' as const
          if (insertionMode === 'paste') clipboard.writeText(safeText)
          const result = await synVoiceExternalInput.commit(
            senderId,
            externalTargetToken,
            safeText,
            controller.signal,
            insertionMode
          )
          if (result === 'inserted') delivery = 'inserted'
          else if (result === 'uncertain') delivery = 'uncertain'
          else if (!controller.signal.aborted) clipboard.writeText(safeText)
        } else {
          if (controller.signal.aborted) throw new Error('Transcrição cancelada.')
          clipboard.writeText(safeText)
        }
        return { ...transcript, delivery }
      } finally {
        releaseExternalTarget()
        e.sender.removeListener('destroyed', abortOnDestroyed)
        if (voiceRequests.get(requestId)?.controller === controller) voiceRequests.delete(requestId)
      }
    }
  )

  ipcMain.on('voice:cancel', (e, requestId: string) => {
    try {
      assertMainVoiceSender(e)
      const active = voiceRequests.get(String(requestId))
      if (active?.senderId === e.sender.id) active.controller.abort()
    } catch {
      // Mensagem de uma origem não confiável: negar silenciosamente.
    }
  })
}
