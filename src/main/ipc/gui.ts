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
  clipboard,
  dialog,
  ipcMain,
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
  guiAttachmentKindForName,
  makeGuiAttachmentDescriptor,
  stripDataUrlPrefix,
  type GuiAttachPayload,
  type GuiAttachResult
} from '../guiAttachments'
import {
  prepareGuiAttachmentDirectory,
  resolveGuiExternalFolderReference,
  writeGuiAttachmentExclusive
} from '../guiAttachmentStorage'
import { randomUUID } from 'node:crypto'
import { guiMissionRoleOf, missionShortId } from '../guiMissionContracts'
import { notifyDesktop } from '../desktopNotifications'
import { GuiPaneVisibilityRegistry, GuiWindowReadyController } from '../guiWindowReady'
import type { GuiAlertPayload, GuiNoticeKind } from '../guiNotices'
import { ensureSynkoraGitExcludes } from '../worktree'
import type { MainContext } from '../mainContext'
import { GuiWorkspaceFileIndex, type GuiWorkspaceFilesResult } from '../guiWorkspaceFiles'

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
function writeAttachment(cwd: string, payload: GuiAttachPayload): GuiAttachResult {
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
    return {
      ok: true,
      path: dest,
      attachment: makeGuiAttachmentDescriptor(
        `attachment-${randomUUID()}`,
        payload.kind === 'clipboard-image' ? 'image' : guiAttachmentKindForName(dest),
        dest,
        bytes.length
      )
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
function writeFolderAttachment(selectedPath: unknown): GuiAttachResult {
  const folder = resolveGuiExternalFolderReference(selectedPath)
  if (!folder.ok) return { ok: false, error: folder.error }
  return {
    ok: true,
    path: folder.path,
    attachment: makeGuiAttachmentDescriptor(
      `attachment-${randomUUID()}`,
      'folder',
      folder.path,
      null
    )
  }
}

export function registerGuiIpc(ctx: MainContext, extras: GuiIpcExtras): GuiSessionRegistry {
  const { blackbox } = ctx
  const workspaceFileIndex = new GuiWorkspaceFileIndex()
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

  const registry = new GuiSessionRegistry({
    // pushAll: a view monta o pane e o host espelha o status (§Push do contrato).
    push: (payload) => ctx.pushAll('gui:live', payload),
    systemPromptFile: extras.systemPromptFile,
    storeFile: extras.storeFile,
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
    onPaneDisposed: ({ paneId }) => readyTitle.dropPane(paneId)
  })

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

  // ANEXO DO COMPOSER: print colado ou arquivo solto vira arquivo em
  // `<cwd do pane>/.synkora/attachments` e o renderer recebe o caminho
  // ABSOLUTO para citar no prompt. O DESTINO NUNCA VEM DO RENDERER — sai do
  // registro de sessões pelo paneId, então um pane sem sessão é recusado em
  // vez de gravar num lugar adivinhado.
  ipcMain.handle('gui:attach', (e, paneId: string, payload: GuiAttachPayload): GuiAttachResult => {
    extras.assertAppRendererSender(e)
    const problem = attachPayloadProblem(payload)
    if (problem) return { ok: false, error: problem }
    const cwd = registry.cwdOf(paneId)
    if (!cwd) return { ok: false, error: 'este pane não tem sessão aberta' }

    const result = writeAttachment(cwd, payload)
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
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: 'Escolher pasta para anexar',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: 'Escolher pasta para anexar',
          properties: ['openDirectory', 'createDirectory']
        })
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true }

    const attachment = writeFolderAttachment(result.filePaths[0])
    blackbox.record({
      cat: 'pane',
      event: attachment.ok ? 'gui-attachment-saved' : 'gui-attachment-failed',
      actor: 'user',
      ids: { paneId },
      detail: { kind: 'folder', ok: attachment.ok }
    })
    return attachment
  })

  return registry
}
