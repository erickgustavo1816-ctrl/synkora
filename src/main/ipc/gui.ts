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
import { clipboard, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GuiSessionRegistry,
  type GuiPaneSpawn,
  type GuiPermBehavior,
  type GuiResult
} from '../guiSessions'
import {
  GUI_ATTACHMENT_MAX_BYTES,
  attachPayloadProblem,
  attachmentTooLargeError,
  base64ByteLength,
  stripDataUrlPrefix,
  uniqueAttachmentPath,
  type GuiAttachPayload,
  type GuiAttachResult
} from '../guiAttachments'
import { guiMissionRoleOf, missionShortId } from '../guiMissionContracts'
import { notifyDesktop } from '../desktopNotifications'
import { ensureSynkoraGitExcludes } from '../worktree'
import type { MainContext } from '../mainContext'

export interface GuiIpcExtras {
  /** F3-c4: host OU view de panes — o canvas é quem monta o pane GUI. */
  assertAppRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
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

/**
 * Grava UM anexo do composer na casa do pane. Fora do handler porque é o
 * único trecho aqui com disco de verdade — as decisões (nome, unicidade,
 * teto) moram no módulo puro `guiAttachments`.
 */
function writeAttachment(cwd: string, payload: GuiAttachPayload): GuiAttachResult {
  // O `.synkora` do worktree tem de ser git-invisível ANTES da primeira
  // escrita: anexo do dono nunca pode sujar a fotografia da missão.
  try {
    ensureSynkoraGitExcludes(cwd)
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `não consegui preparar a pasta de anexos: ${text}` }
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

  // `resolve` e não `join`: o caminho de volta é ABSOLUTO por contrato, e o
  // prompt do agente não pode depender do cwd de quem lê.
  const dir = resolve(cwd, '.synkora', 'attachments')
  try {
    mkdirSync(dir, { recursive: true })
    const dest = uniqueAttachmentPath(dir, name, existsSync)
    writeFileSync(dest, bytes)
    return { ok: true, path: dest }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `não consegui gravar o anexo: ${text}` }
  }
}

export function registerGuiIpc(ctx: MainContext, extras: GuiIpcExtras): GuiSessionRegistry {
  const { blackbox } = ctx
  const registry = new GuiSessionRegistry({
    // pushAll: a view monta o pane e o host espelha o status (§Push do contrato).
    push: (payload) => ctx.pushAll('gui:live', payload),
    systemPromptFile: extras.systemPromptFile,
    storeFile: extras.storeFile,
    record: (event, ids, detail) =>
      blackbox.record({ cat: 'pane', event, actor: 'harness', ids, detail }),
    // ONDA D: a conversa parou pedindo permissão e o dono pode estar em outra
    // janela. O throttle por pane e a guarda de foco moram no módulo — aqui só
    // se resolve QUEM está chamando (o guiSessions não conhece missão nem
    // projeto por nome, e nunca importa electron).
    onPermissionPending: ({ paneId, projectId, toolName }) =>
      notifyDesktop({
        kind: 'attention',
        key: paneId,
        title: 'Synkora — missão esperando você',
        body: `${paneLabel(ctx, paneId, projectId)} pediu permissão para ${toolName}`
      })
  })

  ipcMain.handle('gui:create', (e, spawn: GuiPaneSpawn): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.create(spawn)
  })

  ipcMain.handle('gui:send', (e, paneId: string, text: string): GuiResult => {
    extras.assertAppRendererSender(e)
    if (!text?.trim()) return { ok: false, error: 'mensagem vazia' }
    return registry.send(paneId, text)
  })

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

  ipcMain.handle('gui:interrupt', (e, paneId: string): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.interrupt(paneId)
  })

  ipcMain.handle('gui:kill', (e, paneId: string): GuiResult => {
    extras.assertAppRendererSender(e)
    return registry.kill(paneId)
  })

  ipcMain.handle('gui:state', (e, paneId: string): { events: unknown[] } => {
    extras.assertAppRendererSender(e)
    return registry.state(paneId)
  })

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
      detail: { kind: payload.kind, ...(result.ok ? { path: result.path } : { err: result.error }) }
    })
    return result
  })

  return registry
}
