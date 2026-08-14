/**
 * IPC — domínio gui (Synkora 2.0, onda A — docs/GUI_PANE_CONTRACT.md).
 * Os seis canais do pane GUI. O motor mora no guiSessions; aqui só há a
 * costura: validar o remetente, delegar e empurrar `gui:live`.
 *
 * CERCA VIVA da Fase 0: register*Ipc é CHAMADO do whenReady (bloco único
 * antes do createWindow), NUNCA no import — instrumentIpcMain só cobre
 * handlers registrados depois dele.
 *
 * Sender: `assertAppRendererSender` (host OU view de panes) — quem MONTA o
 * pane é a WebContentsView do canvas (F3), então host-only trancaria o dono
 * legítimo do chat.
 */
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import {
  GuiSessionRegistry,
  guiMessageIdProblem,
  guiPromptProblem,
  type GuiExecutorPatch,
  type GuiExecutorResult,
  type GuiPaneSpawn,
  type GuiPermBehavior,
  type GuiQueuedDeliveryInput,
  type GuiResult,
  type GuiStatePayload
} from '../guiSessions'
import {
  GUI_ATTACHMENT_MAX_BYTES,
  attachPayloadProblem,
  attachmentTooLargeError,
  base64ByteLength,
  guiAttachmentMediaType,
  guiAttachmentOpenProblem,
  stripDataUrlPrefix,
  type GuiAttachmentAction,
  type GuiAttachmentActionResult,
  type GuiAttachmentDescriptor,
  type GuiAttachPayload,
  type GuiAttachResult,
  type GuiAttachmentPreviewPurpose,
  type GuiAttachmentPreviewResult
} from '../guiAttachments'
import {
  prepareGuiAttachmentDirectory,
  resolveGuiExternalFolderReference,
  validateGuiAttachmentReferences,
  writeGuiAttachmentExclusive
} from '../guiAttachmentStorage'
import { GuiAttachmentCapabilityStore } from '../guiAttachmentCapabilities'
import { renderGuiAttachmentPreview } from '../guiAttachmentMedia'
import { unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { guiMissionRoleOf, missionShortId } from '../guiMissionContracts'
import { notifyDesktop } from '../desktopNotifications'
import { GuiPaneVisibilityRegistry, GuiWindowReadyController } from '../guiWindowReady'
import type { GuiAlertPayload, GuiNoticeKind } from '../guiNotices'
import {
  GuiFileResolver,
  prepareGuiFileOpen,
  type GuiFileOpenResult
} from '../guiFileResolver'
import { ensureSynkoraGitExcludes } from '../worktree'
import type { MainContext } from '../mainContext'
import { GuiWorkspaceFileIndex, type GuiWorkspaceFilesResult } from '../guiWorkspaceFiles'
import { BrowserObserverRegistry } from '../browserObserver'

export interface GuiIpcExtras {
  /** F3-c4: host OU view de panes — o canvas é quem monta o pane GUI. */
  assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  /** Aguarda uma eventual troca do executável global antes de criar a sessão. */
  waitForCliStable(cli: GuiPaneSpawn['cli']): Promise<void>
  /** Materializa a persona do claude em userData/prompts (teto de argv). */
  systemPromptFile(name: string, content: string): string | undefined
  /** userData/gui-sessions.json — resume pós-boot. */
  storeFile: string
}

const BEHAVIORS: GuiPermBehavior[] = ['allow', 'allow-always', 'deny']

const ROLE_LABEL: Record<string, string> = {
  dev: 'agente',
  reviewer: 'revisor',
  helper: 'ajudante'
}

/**
 * Quem está pedindo, em PT-BR, para a notificação de desktop. O paneId segue a
 * convenção do guiMissionContracts (`gui-<papel>-<id8>`), então o id8 basta
 * para achar a missão; sem casar, o papel sozinho já diz o essencial.
 */
function paneLabel(ctx: MainContext, paneId: string, projectId: string): string {
  const role = guiMissionRoleOf(paneId)
  if (!role) {
    const project = ctx.projects.get(projectId)
    return project ? `planejamento de ${project.name}` : 'planejamento do universo'
  }
  const short = paneId.split('-')[2] ?? ''
  const mission = ctx.missions
    .list(projectId)
    .find((candidate) => missionShortId(candidate.id) === short)
  const who = ROLE_LABEL[role] ?? role
  return mission ? `${who} · ${mission.title}` : who
}

function chatNoticeEnabled(ctx: MainContext, kind: GuiNoticeKind): boolean {
  const settings = ctx.settings.view()
  if (kind === 'needs-you') return settings.chatNotifyNeedsYou
  if (kind === 'finished') return settings.chatNotifyFinished
  return settings.chatNotifyFailed
}

function chatNoticeBody(kind: GuiNoticeKind, label: string): string {
  if (kind === 'finished') return `${label} terminou um turno`
  if (kind === 'failed') return `${label} encontrou uma falha`
  return `${label} precisa de você`
}

/**
 * Grava UM anexo do composer na casa do pane. Fora do handler porque é o
 * único trecho aqui com disco de verdade — as decisões (nome, unicidade,
 * teto) moram no módulo puro `guiAttachments`.
 */
function writeAttachment(
  cwd: string,
  paneId: string,
  payload: GuiAttachPayload,
  capabilities: GuiAttachmentCapabilityStore
): GuiAttachResult {
  // Pastas chegam somente pelo handler `gui:attachFolder`, depois do diálogo
  // nativo. Nunca trate um path enviado pelo renderer como seleção válida.
  if (payload.kind === 'folder') {
    return { ok: false, error: 'pasta deve ser escolhida pelo diálogo do sistema' }
  }

  // O `.synkora` do worktree tem de ser git-invisível ANTES da primeira
  // escrita: anexo do dono nunca pode sujar a fotografia da missão.
  try {
    ensureSynkoraGitExcludes(cwd)
  } catch {
    // Erro bruto de disco pode carregar uma árvore/local de usuário. O detalhe
    // não entra nem na UI nem no blackbox; o handler já registra só ok/kind.
    return { ok: false, error: 'não consegui preparar a pasta de anexos' }
  }

  let bytes: Buffer
  let name: string
  if (payload.kind === 'clipboard-image') {
    const image = clipboard.readImage()
    if (image.isEmpty()) return { ok: false, error: 'não há imagem na área de transferência' }
    bytes = image.toPNG()
    name = `clip-${Date.now()}.png`
  } else {
    const base64 = stripDataUrlPrefix(payload.bytesBase64)
    // Pré-cheque SEM alocar: base64 de 10MB já são ~13MB de string, e decodar
    // para depois recusar seria pagar a memória que o teto existe para evitar.
    const declared = base64ByteLength(base64)
    if (declared > GUI_ATTACHMENT_MAX_BYTES) {
      return { ok: false, error: attachmentTooLargeError(declared) }
    }
    bytes = Buffer.from(base64, 'base64')
    name = payload.name
  }
  if (bytes.length === 0) return { ok: false, error: 'anexo sem conteúdo' }
  if (bytes.length > GUI_ATTACHMENT_MAX_BYTES) {
    return { ok: false, error: attachmentTooLargeError(bytes.length) }
  }

  // A camada de storage devolve o caminho FÍSICO e absoluto depois de recusar
  // symlink/junction e reservar o nome com criação exclusiva.
  try {
    const dir = prepareGuiAttachmentDirectory(cwd)
    const dest = writeGuiAttachmentExclusive(dir, name, bytes)
    try {
      const media = guiAttachmentMediaType(dest, bytes)
      return {
        ok: true,
        attachment: capabilities.issue(paneId, {
          kind: media.kind,
          path: dest,
          size: bytes.length,
          mime: media.mime
        })
      }
    } catch {
      // Sem registro durável, o renderer nunca recebe uma capacidade zumbi.
      try {
        unlinkSync(dest)
      } catch {
        // O arquivo órfão continua privado no worktree e será ignorado.
      }
      return { ok: false, error: 'não consegui autorizar o anexo' }
    }
  } catch {
    return { ok: false, error: 'não consegui gravar o anexo' }
  }
}

/**
 * Pasta é referência, não upload. O único chamador recebe o resultado do
 * diálogo nativo do main; ainda assim o alvo é revalidado antes de virar um
 * descritor persistível, sem copiar nem enumerar a árvore escolhida.
 */
function writeFolderAttachment(
  paneId: string,
  selectedPath: unknown,
  capabilities: GuiAttachmentCapabilityStore
): GuiAttachResult {
  const folder = resolveGuiExternalFolderReference(selectedPath)
  if (!folder.ok) return { ok: false, error: folder.error }
  try {
    return {
      ok: true,
      attachment: capabilities.issue(paneId, {
        kind: 'folder',
        path: folder.path,
        size: null,
        mime: null
      })
    }
  } catch {
    return { ok: false, error: 'não consegui autorizar a pasta' }
  }
}

export function registerGuiIpc(ctx: MainContext, extras: GuiIpcExtras): GuiSessionRegistry {
  const { blackbox } = ctx
  const workspaceFileIndex = new GuiWorkspaceFileIndex()
  const attachmentCapabilities = new GuiAttachmentCapabilityStore(
    join(dirname(extras.storeFile), 'gui-attachment-capabilities.json')
  )
  const visibility = new GuiPaneVisibilityRegistry()
  const readyTitle = new GuiWindowReadyController({
    setTitle: (title) => {
      const win = ctx.mainWindow
      if (win && !win.isDestroyed()) win.setTitle(title)
    },
    isFocused: () => Boolean(ctx.mainWindow && !ctx.mainWindow.isDestroyed() && ctx.mainWindow.isFocused()),
    isPaneActive: (paneId) => visibility.isActive(paneId),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle)
  })
  let boundWindow: BrowserWindow | null = null
  const onWindowFocus = (): void => readyTitle.onWindowFocus()
  const onWindowBlur = (): void => readyTitle.onWindowBlur()
  const bindWindow = (): void => {
    const next = ctx.mainWindow
    if (next === boundWindow) return
    if (boundWindow && !boundWindow.isDestroyed()) {
      boundWindow.off('focus', onWindowFocus)
      boundWindow.off('blur', onWindowBlur)
    }
    boundWindow = next
    if (!next || next.isDestroyed()) return
    next.on('focus', onWindowFocus)
    next.on('blur', onWindowBlur)
  }
  const trackedVisibilitySenders = new Set<number>()

  // P28 nasce junto do registro do chat porque a autoridade de cwd e o
  // lifecycle pertencem ao mesmo pane. A variável é preenchida logo depois
  // do registry; o callback de dispose pode então fechar o watcher sem abrir
  // um segundo canal de poder ou aceitar path do renderer.
  let browserObserver: BrowserObserverRegistry | undefined
  const registry = new GuiSessionRegistry({
    // pushAll: a view monta o pane e o host espelha o status (§Push do contrato).
    push: (payload) => ctx.pushAll('gui:live', payload),
    systemPromptFile: extras.systemPromptFile,
    storeFile: extras.storeFile,
    attachmentCapabilities,
    record: (event, ids, detail) =>
      blackbox.record({ cat: 'pane', event, actor: 'harness', ids, detail }),
    // O sink vivo publica UM alerta canônico. Replay nunca entra aqui, e só o
    // host recebe gui:alert; a WebContentsView não pode duplicar o som.
    onChatAlert: ({ paneId, projectId, kind }) => {
      bindWindow()
      const payload: GuiAlertPayload = { paneId, projectId, kind }
      ctx.pushBoard('gui:alert', payload)
      if (kind === 'finished') readyTitle.noteFinished(paneId)
      if (!chatNoticeEnabled(ctx, kind)) return
      const label = paneLabel(ctx, paneId, projectId)
      notifyDesktop({
        kind: `chat-${kind}`,
        key: paneId,
        title: `Synkora — ${label}`,
        body: chatNoticeBody(kind, label),
        // O vocabulário sonoro próprio é sintetizado pelo host (P20).
        silent: true,
        // P19 é uma saída do sistema, inclusive durante o uso do app.
        showWhenFocused: true
      })
    },
    // Um único teardown cobre kill do renderer, arquivamento em lote, troca de
    // projeto e respawn. Assim nenhum marcador [pronto] sobrevive ao pane.
    onPaneDisposed: ({ paneId }) => {
      readyTitle.dropPane(paneId)
      browserObserver?.closePane(paneId)
    }
  })
  // Índice curto por cwd para basename/sufixo. A raiz nunca vem do renderer;
  // cada chamada abaixo a reencontra no registro vivo da conversa.
  const fileResolver = new GuiFileResolver()
  browserObserver = new BrowserObserverRegistry({
    cwdOf: (paneId) => registry.cwdOf(paneId),
    push: (snapshot) => ctx.pushAll('gui:browser-observer', snapshot)
  })
  const closeBrowserObservers = (): void => browserObserver?.closeAll()
  app.once('will-quit', closeBrowserObservers)

  ipcMain.on('gui:visibility', (event, paneId: unknown, active: unknown) => {
    extras.assertAppRendererSender(event)
    if (typeof paneId !== 'string' || paneId.length === 0 || typeof active !== 'boolean') return
    bindWindow()
    const senderId = event.sender.id
    visibility.report(senderId, paneId, active)
    readyTitle.onPaneActiveChanged(paneId)
    if (trackedVisibilitySenders.has(senderId)) return
    trackedVisibilitySenders.add(senderId)
    event.sender.once('destroyed', () => {
      trackedVisibilitySenders.delete(senderId)
      for (const droppedPaneId of visibility.dropSender(senderId)) {
        readyTitle.onPaneActiveChanged(droppedPaneId)
      }
    })
  })

  ipcMain.on('gui:presented', (event, paneId: unknown, terminalSeq: unknown) => {
    extras.assertAppRendererSender(event)
    if (
      typeof paneId !== 'string' ||
      paneId.length === 0 ||
      paneId.length > 256 ||
      typeof terminalSeq !== 'number' ||
      !Number.isSafeInteger(terminalSeq) ||
      terminalSeq <= 0
    ) return
    registry.presented(paneId, terminalSeq)
  })

  ipcMain.handle('gui:create', async (e, spawn: GuiPaneSpawn): Promise<GuiResult> => {
    extras.assertAppRendererSender(e)
    await extras.waitForCliStable(spawn.cli)
    return registry.create(spawn)
  })

  ipcMain.handle(
    'gui:configureExecutor',
    (e, paneId: string, patch: GuiExecutorPatch): Promise<GuiExecutorResult> => {
      extras.assertAppRendererSender(e)
      return registry.configureExecutor(paneId, patch)
    }
  )

  ipcMain.handle(
    'gui:send',
    (e, paneId: string, text: string, messageId: string, attachments?: unknown): GuiResult => {
      extras.assertAppRendererSender(e)
      const problem = guiPromptProblem(text, 'mensagem', true)
      if (problem) return { ok: false, error: problem }
      const idProblem = guiMessageIdProblem(messageId)
      if (idProblem) return { ok: false, error: idProblem }
      // O Registry conhece o cwd deste pane e revalida cada descritor antes de
      // montar a referência que realmente chega ao CLI.
      return registry.send(paneId, text, messageId, attachments)
    }
  )

  ipcMain.handle(
    'gui:deliverQueued',
    (e, paneId: unknown, input: GuiQueuedDeliveryInput): Promise<GuiResult> => {
      extras.assertAppRendererSender(e)
      if (typeof paneId !== 'string' || !paneId || paneId.length > 256) {
        return Promise.resolve({ ok: false, error: 'pane sem identificador válido' })
      }
      return registry.deliverQueued(paneId, input)
    }
  )

  ipcMain.handle(
    'gui:permission',
    (e, paneId: string, requestId: string, behavior: GuiPermBehavior): GuiResult => {
      extras.assertAppRendererSender(e)
      if (!BEHAVIORS.includes(behavior)) {
        return { ok: false, error: `decisão inválida: ${String(behavior)}` }
      }
      return registry.permission(paneId, requestId, behavior)
    }
  )

  // PERGUNTA COM OPÇÕES (AskUserQuestion): as escolhas do card viajam no
  // updatedInput do MESMO control_response da permissão — quem monta o payload
  // é o maestroSession; aqui só se valida a forma que veio do renderer.
  ipcMain.handle(
    'gui:answerQuestion',
    (e, paneId: string, requestId: string, answers: Record<string, string>): GuiResult => {
      extras.assertAppRendererSender(e)
      if (!requestId) return { ok: false, error: 'pergunta sem identificador' }
      if (!answers || typeof answers !== 'object' || Array.isArray(answers))
        return { ok: false, error: 'resposta em formato inválido' }
      const clean: Record<string, string> = {}
      let count = 0
      for (const question in answers) {
        if (!Object.prototype.hasOwnProperty.call(answers, question)) continue
        count += 1
        if (count > 8) return { ok: false, error: 'pergunta com respostas demais' }
        const answer = answers[question]
        if (typeof answer !== 'string')
          return { ok: false, error: 'resposta em formato inválido' }
        if (question.length > 2_000 || answer.length > 4_000)
          return { ok: false, error: 'resposta grande demais' }
        clean[question] = answer
      }
      return registry.answerQuestion(paneId, requestId, clean)
    }
  )

  // VEREDITO DO PLANO (ExitPlanMode): construir = allow, revisar = deny.
  ipcMain.handle(
    'gui:answerPlan',
    (e, paneId: string, requestId: string, approve: boolean): GuiResult => {
      extras.assertAppRendererSender(e)
      if (!requestId) return { ok: false, error: 'plano sem identificador' }
      if (typeof approve !== 'boolean')
        return { ok: false, error: 'decisão de plano inválida' }
      return registry.answerPlan(paneId, requestId, approve)
    }
  )

  ipcMain.handle('gui:interrupt', (e, paneId: string): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.interrupt(paneId)
  })

  ipcMain.handle('gui:kill', (e, paneId: string): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.kill(paneId)
  })

  ipcMain.handle('gui:state', (e, paneId: string): GuiStatePayload => {
    extras.assertAppRendererSender(e)
    return registry.state(paneId)
  })

  /**
   * Índice de menções: o `cwd` é resolvido pelo registro do pane, nunca pelo
   * renderer. A lista é completa dentro dos limites do índice e fica cacheada
   * pela raiz canonical do worktree; digitar mais um caractere não varre disco.
   */
  ipcMain.handle(
    'gui:workspaceFiles',
    (e, paneId: unknown): GuiWorkspaceFilesResult => {
      extras.assertAppRendererSender(e)
      if (typeof paneId !== 'string' || paneId.length === 0 || paneId.length > 256) {
        return { ok: false, error: 'pane sem identificador válido' }
      }
      const cwd = registry.cwdOf(paneId)
      if (!cwd) return { ok: false, error: 'este pane não tem sessão aberta' }
      return workspaceFileIndex.list(cwd)
    }
  )

  ipcMain.handle(
    'gui:fileOpen',
    (
      e,
      paneId: unknown,
      reference: unknown,
      selectedPath?: unknown
    ): GuiFileOpenResult => {
      extras.assertAppRendererSender(e)
      if (typeof paneId !== 'string' || !paneId || paneId.length > 256) {
        return { ok: false, reason: 'invalid', error: 'pane sem identificador válido' }
      }
      if (typeof reference !== 'string') {
        return { ok: false, reason: 'invalid', error: 'caminho inválido' }
      }
      if (selectedPath !== undefined && typeof selectedPath !== 'string') {
        return { ok: false, reason: 'invalid', error: 'escolha de arquivo inválida' }
      }

      const cwd = registry.cwdOf(paneId)
      if (!cwd) {
        return {
          ok: false,
          reason: 'unavailable',
          error: 'este pane não tem sessão aberta'
        }
      }

      const resolved = fileResolver.resolve(cwd, reference, selectedPath)
      if (!resolved.ok) {
        blackbox.record({
          cat: 'pane',
          event: 'gui-file-open-refused',
          actor: 'user',
          ids: { paneId },
          // Token, escolha e path podem carregar árvore/username. Só a classe
          // segura da recusa entra no journal.
          detail: { reason: resolved.reason }
        })
        return resolved
      }

      const prepared = prepareGuiFileOpen(resolved.file)
      if (!prepared.ok) {
        blackbox.record({
          cat: 'pane',
          event: 'gui-file-open-refused',
          actor: 'user',
          ids: { paneId },
          detail: { reason: prepared.reason }
        })
        return prepared
      }
      if (prepared.action === 'preview') {
        blackbox.record({
          cat: 'pane',
          event: 'gui-file-previewed',
          actor: 'user',
          ids: { paneId },
          detail: { kind: prepared.preview.kind }
        })
        return prepared
      }

      // Fallback deliberadamente não executável: Explorer seleciona o arquivo,
      // mas nenhuma associação do SO é acionada nesta superfície.
      shell.showItemInFolder(prepared.absolutePath)
      blackbox.record({
        cat: 'pane',
        event: 'gui-file-revealed',
        actor: 'user',
        ids: { paneId },
        detail: { action: 'reveal' }
      })
      return { ok: true, action: 'reveal', message: prepared.message }
    }
  )

  // OBSERVADOR LOCAL DO NAVEGADOR (P28, caminho barato): os únicos inputs do
  // renderer são paneId e o token opaco da fotografia corrente. Raiz, arquivo,
  // MIME e tamanho são resolvidos/revalidados no main; nenhum destes canais
  // abre navegador, recebe URL ou controla o computador.
  ipcMain.handle('gui:browser-observer-start', (e, paneId: unknown) => {
    extras.assertAppRendererSender(e)
    const result = browserObserver.start(paneId)
    blackbox.record({
      cat: 'pane',
      event: result.ok ? 'browser-observer-started' : 'browser-observer-start-failed',
      actor: 'user',
      ids: typeof paneId === 'string' ? { paneId } : {},
      detail: { ok: result.ok }
    })
    return result
  })

  ipcMain.handle('gui:browser-observer-stop', (e, paneId: unknown) => {
    extras.assertAppRendererSender(e)
    const result = browserObserver.stop(paneId)
    blackbox.record({
      cat: 'pane',
      event: result.ok ? 'browser-observer-stopped' : 'browser-observer-stop-failed',
      actor: 'user',
      ids: typeof paneId === 'string' ? { paneId } : {},
      detail: { ok: result.ok }
    })
    return result
  })

  ipcMain.handle('gui:browser-observer-state', (e, paneId: unknown) => {
    extras.assertAppRendererSender(e)
    return browserObserver.state(paneId)
  })

  ipcMain.handle('gui:browser-observer-frame', (e, paneId: unknown, frameId: unknown) => {
    extras.assertAppRendererSender(e)
    return browserObserver.frame(paneId, frameId)
  })

  // ANEXO DO COMPOSER: print colado ou arquivo solto vira arquivo em
  // `<cwd do pane>/.synkora/attachments` e o renderer recebe uma capacidade
  // opaca. O DESTINO NUNCA VEM DO RENDERER — sai do
  // registro de sessões pelo paneId, então um pane sem sessão é recusado em
  // vez de gravar num lugar adivinhado.
  ipcMain.handle('gui:attach', (e, paneId: string, payload: GuiAttachPayload): GuiAttachResult => {
    extras.assertAppRendererSender(e)
    const problem = attachPayloadProblem(payload)
    if (problem) return { ok: false, error: problem }
    const cwd = registry.cwdOf(paneId)
    if (!cwd) return { ok: false, error: 'este pane não tem sessão aberta' }

    const result = writeAttachment(cwd, paneId, payload, attachmentCapabilities)
    blackbox.record({
      cat: 'pane',
      event: result.ok ? 'gui-attachment-saved' : 'gui-attachment-failed',
      actor: 'user',
      ids: { paneId },
      // Nunca journaliza caminho, nome ou erro bruto do fs: os três podem
      // carregar username/árvore local/dado pessoal. O resultado detalhado
      // volta somente ao renderer que iniciou a ação.
      detail: { kind: payload.kind, ok: result.ok }
    })
    return result
  })

  // A escolha de pasta é deliberadamente um salto direto do main para o
  // diálogo nativo. O renderer recebe apenas o descritor já validado; ele
  // nunca envia um caminho para autorizar uma pasta arbitrária.
  ipcMain.handle('gui:attachFolder', async (e, paneId: string): Promise<GuiAttachResult> => {
    extras.assertAppRendererSender(e)
    if (!registry.cwdOf(paneId)) return { ok: false, error: 'este pane não tem sessão aberta' }

    const owner = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : undefined
    let result: Awaited<ReturnType<typeof dialog.showOpenDialog>>
    try {
      result = owner
        ? await dialog.showOpenDialog(owner, {
            title: 'Escolher pasta para anexar',
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({
            title: 'Escolher pasta para anexar',
            properties: ['openDirectory', 'createDirectory']
          })
    } catch {
      return { ok: false, error: 'não consegui abrir o seletor de pasta' }
    }
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true }

    const attachment = writeFolderAttachment(paneId, result.filePaths[0], attachmentCapabilities)
    blackbox.record({
      cat: 'pane',
      event: attachment.ok ? 'gui-attachment-saved' : 'gui-attachment-failed',
      actor: 'user',
      ids: { paneId },
      detail: { kind: 'folder', ok: attachment.ok }
    })
    return attachment
  })

  /** Miniatura/lightbox: descriptor opaco entra, PNG limitado sai. O caminho
   * físico nunca cruza o preload e a capacidade é revalidada a cada pedido. */
  ipcMain.handle(
    'gui:attachmentPreview',
    (
      e,
      paneId: string,
      descriptor: GuiAttachmentDescriptor,
      purpose: GuiAttachmentPreviewPurpose
    ): GuiAttachmentPreviewResult => {
      extras.assertAppRendererSender(e)
      if (purpose !== 'thumbnail' && purpose !== 'lightbox') {
        return { ok: false, error: 'tamanho de prévia inválido' }
      }
      const cwd = registry.cwdOf(paneId)
      if (!cwd) return { ok: false, error: 'este pane não tem sessão aberta' }
      const checked = validateGuiAttachmentReferences(
        cwd,
        paneId,
        [descriptor],
        attachmentCapabilities
      )
      if (!checked.ok) return { ok: false, error: checked.error }
      const attachment = checked.resolved[0]
      if (!attachment || attachment.kind !== 'image' || !attachment.mime) {
        return { ok: false, error: 'este anexo não é uma imagem com prévia' }
      }
      if (!attachment.bytes) return { ok: false, error: 'a imagem não está mais disponível' }
      return renderGuiAttachmentPreview(attachment.bytes, attachment.mime, purpose)
    }
  )

  /** Abrir/baixar são efeitos do main. Ambos revalidam a capacidade; baixar
   * revalida de novo depois do diálogo, porque o alvo pode mudar enquanto o
   * usuário escolhe o destino. */
  ipcMain.handle(
    'gui:attachmentAction',
    async (
      e,
      paneId: string,
      action: GuiAttachmentAction,
      descriptor: GuiAttachmentDescriptor
    ): Promise<GuiAttachmentActionResult> => {
      extras.assertAppRendererSender(e)
      if (action !== 'open' && action !== 'download') {
        return { ok: false, error: 'ação de anexo inválida' }
      }
      const cwd = registry.cwdOf(paneId)
      if (!cwd) return { ok: false, error: 'este pane não tem sessão aberta' }
      const authorize = (): ReturnType<typeof validateGuiAttachmentReferences> =>
        validateGuiAttachmentReferences(cwd, paneId, [descriptor], attachmentCapabilities)
      let checked = authorize()
      if (!checked.ok) return { ok: false, error: checked.error }
      let attachment = checked.resolved[0]
      if (!attachment || attachment.kind === 'folder' || !attachment.mime) {
        return { ok: false, error: 'esta ação só funciona com arquivos' }
      }

      let outcome: GuiAttachmentActionResult
      if (action === 'open') {
        const problem = guiAttachmentOpenProblem(attachment.name, attachment.mime)
        if (problem) return { ok: false, error: problem }
        try {
          const error = await shell.openPath(attachment.path)
          outcome = error
            ? { ok: false, error: 'não consegui abrir o arquivo no aplicativo do sistema' }
            : { ok: true }
        } catch {
          outcome = { ok: false, error: 'não consegui abrir o arquivo no aplicativo do sistema' }
        }
      } else {
        const owner = ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : undefined
        let selected: Awaited<ReturnType<typeof dialog.showSaveDialog>>
        try {
          selected = owner
            ? await dialog.showSaveDialog(owner, {
                title: 'Baixar uma cópia do anexo',
                defaultPath: attachment.name
              })
            : await dialog.showSaveDialog({
                title: 'Baixar uma cópia do anexo',
                defaultPath: attachment.name
              })
        } catch {
          return { ok: false, error: 'não consegui abrir o seletor para salvar a cópia' }
        }
        if (selected.canceled || !selected.filePath) return { ok: false, cancelled: true }
        checked = authorize()
        if (!checked.ok) return { ok: false, error: checked.error }
        attachment = checked.resolved[0]
        if (!attachment || attachment.kind === 'folder' || !attachment.bytes) {
          return { ok: false, error: 'o arquivo não está mais disponível' }
        }
        try {
          writeFileSync(selected.filePath, attachment.bytes)
          outcome = { ok: true }
        } catch {
          outcome = { ok: false, error: 'não consegui salvar a cópia do arquivo' }
        }
      }
      blackbox.record({
        cat: 'pane',
        event: 'gui-attachment-action',
        actor: 'user',
        ids: { paneId },
        detail: { action, kind: descriptor.kind, ok: outcome.ok }
      })
      return outcome
    }
  )

  return registry
}
