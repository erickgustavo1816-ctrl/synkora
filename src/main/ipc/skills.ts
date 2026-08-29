/**
 * IPC — domínio skills (Skills 2.0, build de 2026-08-29).
 * A ponte da tela de gestão (Ajustes ▸ Skills): ler a biblioteca da MÁQUINA,
 * editar o KIT de cada tipo de chat, instalar por URL pinada e podar.
 *
 * CERCA VIVA da Fase 0: register*Ipc é CHAMADO do whenReady (bloco único antes
 * do createWindow), NUNCA no import — instrumentIpcMain só cobre handlers
 * registrados depois dele.
 *
 * Sender: `assertAppRendererSender` (host OU view de panes) — a tela mora no
 * host, mas o remetente segue o padrão das irmãs.
 *
 * O que este módulo NÃO faz: não roteia skill por conteúdo (ADR-0001, quem
 * escolhe é o agente), não materializa pasta em worktree nenhum (isso é o
 * sync do spawn) e não poda sozinho (ADR-0007: só o gesto do dono).
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import {
  skillsKitStore,
  attachSkillsKitRecorder,
  allKitSkillIds,
  type SkillChatType,
  type SkillDevWing,
  type SkillsKitState
} from '../skillsKit'
import { scanSkillsLibrary } from '../skillsLibraryScan'
import { installSkillFromUrl, type SkillInstallResult } from '../skillsInstall'
import { pruneSkillsLibrary } from '../skillsPrune'
import type { MainContext } from '../mainContext'

export interface SkillsIpcExtras {
  /** F3-c4: host OU view de panes — mesmo porteiro das irmãs. */
  assertAppRendererSender(event: IpcMainInvokeEvent): void
}

/** Uma linha da biblioteca como a tela a desenha. */
export interface SkillsLibraryItem {
  id: string
  description: string
  /** SKILL.md com BOM: o codex rejeita o frontmatter — a tela avisa */
  hasBom: boolean
  /** citada por ALGUM slot de ALGUM kit (habilitado ou não) */
  inKit: boolean
}

export interface SkillsListResult {
  library: SkillsLibraryItem[]
  kit: SkillsKitState
}

export type SkillsPruneIpcResult =
  | { ok: true; removed: string[] }
  | { ok: false; error: string }

function asChat(value: unknown): SkillChatType | null {
  return value === 'dev' || value === 'planejamento' ? value : null
}

function asWing(value: unknown): SkillDevWing | undefined {
  return value === 'execucao' || value === 'orquestracao' ? value : undefined
}

export function registerSkillsIpc(ctx: MainContext, extras: SkillsIpcExtras): void {
  // A caixa-preta antes do store: a degradação do skills-kit.json acontece na
  // PRIMEIRA leitura, e ela não pode ser muda.
  attachSkillsKitRecorder((signal) => {
    ctx.blackbox.record({
      cat: 'recovery',
      event: signal.event,
      actor: 'harness',
      reason: signal.reason,
      detail: signal.detail
    })
  })
  const kit = skillsKitStore()

  /** Recusa do motor: volta o estado atual (a tela redesenha) e o motivo fica
   *  no diário — a lei recusada nomeia a receita lá dentro. */
  const refused = (event: string, error: string, detail: Record<string, unknown>): void => {
    ctx.blackbox.record({
      cat: 'user',
      event,
      actor: 'user',
      reason: error,
      detail
    })
  }

  ipcMain.handle('skills:list', (e): SkillsListResult => {
    extras.assertAppRendererSender(e)
    const state = kit.state()
    const known = allKitSkillIds(state)
    return {
      library: scanSkillsLibrary().map((entry) => ({
        id: entry.id,
        description: entry.description,
        hasBom: entry.hasBom,
        inKit: known.has(entry.id)
      })),
      kit: state
    }
  })

  ipcMain.handle(
    'skills:setEnabled',
    (e, chat: unknown, id: unknown, enabled: unknown): SkillsKitState => {
      extras.assertAppRendererSender(e)
      const target = asChat(chat)
      if (!target || typeof id !== 'string') return kit.state()
      const result = kit.setSlotEnabled(target, id, enabled === true)
      if (!result.ok) refused('skills-kit-toggle-refused', result.error, { chat: target, id })
      else {
        ctx.blackbox.record({
          cat: 'user',
          event: 'skills-kit-toggled',
          actor: 'user',
          next: enabled === true ? 'ligada' : 'desligada',
          detail: { chat: target, id }
        })
      }
      return result.state
    }
  )

  ipcMain.handle(
    'skills:addToKit',
    (e, chat: unknown, id: unknown, occasion: unknown, wing: unknown): SkillsKitState => {
      extras.assertAppRendererSender(e)
      const target = asChat(chat)
      if (!target || typeof id !== 'string') return kit.state()
      const result = kit.addSlot(
        target,
        { id, occasion: typeof occasion === 'string' ? occasion : '' },
        asWing(wing)
      )
      if (!result.ok) refused('skills-kit-add-refused', result.error, { chat: target, id })
      else {
        ctx.blackbox.record({
          cat: 'user',
          event: 'skills-kit-slot-added',
          actor: 'user',
          detail: { chat: target, id, wing: asWing(wing) ?? (target === 'dev' ? 'execucao' : null) }
        })
      }
      return result.state
    }
  )

  ipcMain.handle('skills:removeFromKit', (e, chat: unknown, id: unknown): SkillsKitState => {
    extras.assertAppRendererSender(e)
    const target = asChat(chat)
    if (!target || typeof id !== 'string') return kit.state()
    const result = kit.removeSlot(target, id)
    if (!result.ok) refused('skills-kit-remove-refused', result.error, { chat: target, id })
    else {
      ctx.blackbox.record({
        cat: 'user',
        event: 'skills-kit-slot-removed',
        actor: 'user',
        detail: { chat: target, id }
      })
    }
    return result.state
  })

  /** A ÚNICA porta com rede do subsistema (ADR-0007). */
  ipcMain.handle('skills:installFromUrl', async (e, url: unknown): Promise<SkillInstallResult> => {
    extras.assertAppRendererSender(e)
    if (typeof url !== 'string' || !url.trim()) {
      return {
        ok: false,
        error: 'cole a URL da PASTA da skill no GitHub (…/tree/<branch>/<caminho>/<pasta>)'
      }
    }
    const result = await installSkillFromUrl(url)
    ctx.blackbox.record({
      cat: 'user',
      event: result.ok ? 'skill-installed' : 'skill-install-failed',
      actor: 'user',
      reason: result.ok ? undefined : result.error,
      detail: result.ok ? { id: result.id } : { url: url.slice(0, 200) }
    })
    return result
  })

  /** PODA — gesto explícito, confirmado por overlay na tela. */
  ipcMain.handle('skills:prune', (e): SkillsPruneIpcResult => {
    extras.assertAppRendererSender(e)
    try {
      const result = pruneSkillsLibrary(kit.state(), {
        record: (signal) =>
          ctx.blackbox.record({
            cat: 'user',
            event: signal.event,
            actor: 'harness',
            reason: signal.reason,
            detail: signal.detail
          })
      })
      ctx.blackbox.record({
        cat: 'user',
        event: 'skills-library-pruned',
        actor: 'user',
        detail: { removed: result.removed.length, kept: result.kept.length }
      })
      return { ok: true, removed: result.removed }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        error: `a poda falhou: ${detail} — feche o que estiver usando a pasta de skills e tente de novo`
      }
    }
  })
}
