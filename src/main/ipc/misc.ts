/**
 * IPC — domínio misc (fase 1, commit 5).
 * Ilhas pequenas do mapa: catalog, policies, dialog, clipboard,
 * attachments, cli, seats e blackbox — handlers de poucas linhas com no
 * máximo um guard/helper do index cada.
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import {
  app,
  clipboard,
  dialog,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent
} from 'electron'
import { basename, extname, join } from 'path'
import { type SeatCli } from '../seats'
import { ensureSynkoraGitExcludes } from '../worktree'
import { type DeptPolicy } from '../policies'
import { getCatalog } from '../catalog'
import { getCliStatus, updateAllClis, type CliStatus } from '../cliUpdate'
import { type Department } from '../tasks'
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { getSeatUsage } from '../seatUsage'
import { describeEntry } from '../blackbox'
import { diagnosticsConsentDetail, exportDiagnostics } from '../diagnostics'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface MiscIpcExtras {
  bindUiSender(sender: Electron.WebContents): void
  assertMainRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): void
  ensureBypassAccepted(configDir: string, trustCwd?: string): void
}

export function registerMiscIpc(ctx: MainContext, extras: MiscIpcExtras): void {
  const {
    seats,
    projects,
    blackbox,
    policies,
    expiredSeats
  } = ctx
  const {
    bindUiSender,
    assertMainRendererSender,
    ensureBypassAccepted
  } = extras
  // Catálogo de modelos/efforts puxado dos PRÓPRIOS CLIs:
  // codex → `codex debug models` (JSON real); claude → help parse + aliases.
  ipcMain.handle('catalog:get', (_e, cli: SeatCli, seatId?: string) => {
    const seat = seatId ? seats.get(seatId) : undefined
    return getCatalog(cli, seat ? seats.configDirOf(seat) : undefined)
  })

  ipcMain.handle('cli:status', (e): CliStatus[] => {
    bindUiSender(e.sender)
    return getCliStatus()
  })

  ipcMain.handle('cli:update', (e): Promise<CliStatus[]> => {
    bindUiSender(e.sender)
    // Chamada durante uma rodada em andamento entra na MESMA promessa e não
    // gera evento nenhum. Sem este empurrão o botão ficaria mudo até o fim da
    // rodada (que pode levar minutos) — e nem desabilitado, porque o estado do
    // renderer ainda era o "unknown" semeado.
    e.sender.send('cli:status', getCliStatus())
    return updateAllClis()
  })

  ipcMain.handle('policies:get', (_e, projectId: string) => policies.get(projectId))

  ipcMain.handle(
    'policies:set',
    (_e, projectId: string, dept: Department, policy: DeptPolicy) =>
      policies.set(projectId, dept, policy)
  )

  ipcMain.handle('seats:list', () => {
    return seats.list().map((s) => {
      const flaggedAt = expiredSeats.get(s.id)
      if (flaggedAt !== undefined) {
        // credencial regravada depois do flag = usuário refez o login
        try {
          const seat = seats.get(s.id)
          const mtime = seat ? statSync(seats.credentialFile(seat)).mtimeMs : 0
          if (mtime > flaggedAt) {
            expiredSeats.delete(s.id)
            return s
          }
        } catch {
          // sem credencial: statusOf já diz pendente
        }
        if (s.status === 'logado') return { ...s, status: 'expirado' as const }
      }
      return s
    })
  })

  ipcMain.handle('seats:create', (_e, name: string, cli: SeatCli) => {
    const created = seats.create(name, cli)
    if (cli === 'claude') ensureBypassAccepted(created.configDir)
    return created
  })

  ipcMain.handle('seats:rename', (_e, id: string, name: string) => seats.rename(id, name))

  ipcMain.handle('seats:remove', (_e, id: string) => seats.remove(id))

  // Limites de uso reais do seat (hover no rail) — cacheado 5 min no main.
  ipcMain.handle('seats:usage', (_e, id: string) => {
    const seat = seats.get(id)
    if (!seat) return null
    seats.preseed(seat)
    return getSeatUsage(seat.id, seat.cli, seats.configDirOf(seat))
  })

  // CAIXA-PRETA: exportar o pacote de diagnóstico completo (diário + estado
  // sanitizado + versões + evidências Git) — reconstrução sem screenshots.
  ipcMain.handle('blackbox:export', async (e) => {
    assertMainRendererSender(e)
    // PERÍODO NO EXPORT (decisão do usuário, 2026-08-05): a retenção fica em
    // 14d e a escolha do recorte acontece aqui — diagnóstico é quase sempre
    // do dia; o pacote inteiro é a exceção.
    const consentOptions = {
      type: 'warning' as const,
      title: 'Exportar diagnóstico sanitizado',
      message: 'Qual período da caixa-preta incluir?',
      detail: diagnosticsConsentDetail(projects.list().length),
      buttons: ['Cancelar', 'Hoje', 'Últimos 3 dias', 'Últimos 7 dias', 'Tudo (14 dias)'],
      defaultId: 1,
      cancelId: 0,
      noLink: true
    }
    const consent = ctx.mainWindow && !ctx.mainWindow.isDestroyed()
      ? await dialog.showMessageBox(ctx.mainWindow, consentOptions)
      : await dialog.showMessageBox(consentOptions)
    if (consent.response === 0) return { ok: false, msg: '' }
    const exportDays = ({ 1: 1, 2: 3, 3: 7 } as Record<number, number | undefined>)[
      consent.response
    ]
    const r = await dialog.showSaveDialog({
      title: 'Exportar diagnóstico sanitizado do Synkora',
      defaultPath: `synkora-diagnostico-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16)}.zip`,
      filters: [{ name: 'Diagnóstico Synkora', extensions: ['zip'] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, msg: '' }
    blackbox.record({
      cat: 'user',
      event: 'diagnostics-export',
      actor: 'user',
      detail: { sanitized: true, days: exportDays ?? 'tudo' }
    })
    return exportDiagnostics({
      outFile: r.filePath,
      days: exportDays,
      userDataDir: app.getPath('userData'),
      blackboxDir: join(app.getPath('userData'), 'blackbox'),
      meta: {
        geradoEm: new Date().toISOString(),
        bootId: blackbox.bootId,
        app: app.getVersion(),
        electron: process.versions.electron,
        clis: getCliStatus(),
        mcp: { state: ctx.internalMcpState, port: ctx.mcpPort }
      },
      projects: projects.list().map((p) => ({ id: p.id, name: p.name, path: p.path }))
    })
  })

  // Monitor embutido: últimas entradas do diário para inspeção rápida.
  ipcMain.handle('blackbox:tail', (_e, limit?: number) =>
    blackbox.tail(Math.min(Math.max(limit ?? 200, 1), 1000)).map((entry) => ({
      ...entry,
      line: describeEntry(entry)
    }))
  )

  // Clipboard de imagem: prints colados viram PNG em .synkora/attachments do
  // projeto (o path entra no prompt e o agente lê a imagem pelo caminho).
  ipcMain.on('clipboard:hasImage', (e) => {
    e.returnValue = clipboard.availableFormats().some((f) => f.startsWith('image/'))
  })

  ipcMain.handle('clipboard:readText', () => clipboard.readText())

  ipcMain.handle('clipboard:saveImage', (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) return null
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return null
    }
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const dir = join(project.path, '.synkora', 'attachments')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `clip-${Date.now()}.png`)
    writeFileSync(file, img.toPNG())
    return file
  })

  // Arquivos SOLTOS num pane (drag & drop): cópia para .synkora/attachments do
  // projeto — mesma casa do print colado. O composer recebe o path da CÓPIA:
  // o original pode ser movido/apagado depois e o dossiê fica organizado por
  // projeto. Nome que colide com tamanho diferente ganha sufixo -N; tamanho
  // igual é tratado como o mesmo arquivo (re-drop idempotente).
  ipcMain.handle('attachments:import', (_e, projectId: string, paths: string[]): string[] => {
    const project = projects.get(projectId)
    if (!project || !Array.isArray(paths)) return []
    try {
      ensureSynkoraGitExcludes(project.path)
    } catch {
      return []
    }
    const dir = join(project.path, '.synkora', 'attachments')
    mkdirSync(dir, { recursive: true })
    const saved: string[] = []
    for (const src of paths.slice(0, 25)) {
      try {
        if (typeof src !== 'string' || !src) continue
        const st = statSync(src)
        if (!st.isFile()) continue
        const base = basename(src)
        let dest = join(dir, base)
        if (existsSync(dest) && statSync(dest).size !== st.size) {
          const ext = extname(base)
          const stem = base.slice(0, base.length - ext.length)
          let n = 1
          while (existsSync(dest) && statSync(dest).size !== st.size) {
            dest = join(dir, `${stem}-${n}${ext}`)
            n++
          }
        }
        if (!existsSync(dest)) copyFileSync(src, dest)
        saved.push(dest)
      } catch {
        // arquivo inacessível/protegido — segue para o próximo
      }
    }
    return saved
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}
