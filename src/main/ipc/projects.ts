/**
 * IPC — domínio projects (fase 1, commit 5).
 * Universos: listar/criar/renomear/foto e a RELOCAÇÃO (a cascata que
 * mata panes, repara worktrees e migra sessões claude por seat).
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import — instrumentIpcMain só cobre handlers registrados depois
 * dele. uiSender/mainWindow/mcpPort e afins são lidos via ctx a cada uso.
 */
import { app, dialog, ipcMain, nativeImage } from 'electron'
import { isAbsolute, join, resolve } from 'path'
import { ensureSynkoraGitExcludes, hasGitCommit, repairWorktrees } from '../worktree'
import { ensureProjectSecurityBaseline } from '../projectSecurityBaseline'
import { redactSensitiveText } from '../securityRedaction'
import { cpSync, existsSync } from 'fs'
import { ensureGreenfieldProjectPlan, isEffectivelyEmptyProject } from '../projectPlan'
import type { MainContext } from '../mainContext'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface ProjectsIpcExtras {
  killMaestroSession(projectId: string): void
  hasProjectPlanArtifacts(projectPath: string): boolean
  ensureBypassAccepted(configDir: string, trustCwd?: string): void
  discardUnstartedPane(paneId: string): void
}

export function registerProjectsIpc(ctx: MainContext, extras: ProjectsIpcExtras): void {
  const {
    seats,
    projects,
    ptys,
    maestro,
    backlog,
    phaseWatches,
    syncBoard,
    scheduleProgressSnapshot,
    projectModeOf,
    projectPlanOf,
    hub
  } = ctx
  const {
    killMaestroSession,
    hasProjectPlanArtifacts,
    ensureBypassAccepted,
    discardUnstartedPane
  } = extras
  // `missing` é COMPUTADO na listagem (nunca persistido): pasta renomeada ou
  // movida fora do app → a UI mostra o estado quebrado e oferece relocação.
  ipcMain.handle('projects:list', () =>
    projects.list().map((p) => {
      const exists = existsSync(p.path)
      // Projeto legado ainda sem classificação não deve ser carimbado como
      // existente só porque a pasta está temporariamente ausente.
      const mode = p.mode ?? (exists ? projectModeOf(p.id) : undefined)
      return {
        ...p,
        ...(mode ? { mode } : {}),
        missing: !exists,
        ...(mode === 'greenfield' ? { planStatus: projectPlanOf(p.id)?.status } : {})
      }
    })
  )

  ipcMain.handle('projects:create', (_e, name: string, path: string) => {
    // GUARDA DE PATH (CHECK 12, 2026-08-07): um path RELATIVO/amassado vira
    // pasta fantasma no cwd do app (caso real: o driver E2E perdeu as barras
    // no escape e "C:\Users\Erick\.synkora-e2e\p1" materializou como
    // "UsersErick.synkora-e2ep1" DENTRO do repo do Synkora, com scaffold
    // completo). Projeto só nasce de path absoluto e nunca dentro do
    // diretório do próprio app.
    if (!isAbsolute(path)) {
      throw new Error(
        `caminho inválido (não é absoluto): "${path.slice(0, 120)}" — provavelmente perdeu as barras no transporte (escape); use forward slashes`
      )
    }
    const appRoot = app.getAppPath().replace(/\\/g, '/').toLowerCase()
    if (path.replace(/\\/g, '/').toLowerCase().startsWith(appRoot)) {
      throw new Error('caminho recusado: a pasta cairia dentro do diretório do próprio Synkora')
    }
    // A classificação acontece ANTES de qualquer injeção de skills, que cria
    // .agents/.claude e faria uma pasta vazia parecer um projeto existente.
    const mode =
      hasProjectPlanArtifacts(path) || isEffectivelyEmptyProject(path)
        ? 'greenfield'
        : 'existing'
    const project = projects.create(name, path, mode)
    if (mode === 'greenfield') {
      try {
        ensureSynkoraGitExcludes(path)
        ensureGreenfieldProjectPlan(path, { projectName: name })
        ensureProjectSecurityBaseline(path, {
          installRepositoryAdapters: true,
          projectName: name
        })
      } catch (error) {
        // O cadastro continua disponível, mas o primeiro pane fica bloqueado
        // até a política local poder ser materializada.
        hub.publish({
          projectId: project.id,
          kind: 'error',
          text: `projeto cadastrado, mas a política local de segurança não pôde ser preparada: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
          actor: 'harness',
          urgent: true
        })
      }
    }
    if (mode === 'existing') {
      try {
        ensureSynkoraGitExcludes(path)
        ensureProjectSecurityBaseline(path, {
          installRepositoryAdapters: false,
          projectName: name
        })
      } catch {
        // Projetos existentes continuam sob a política de sistema; nenhum
        // arquivo do repositório é alterado para forçar uma migração.
      }
    }
    scheduleProgressSnapshot()
    return project
  })

  ipcMain.handle('projects:remove', (_e, id: string) => {
    projects.remove(id)
    scheduleProgressSnapshot()
  })

  ipcMain.handle('projects:rename', (_e, id: string, name: string) => {
    const updated = name.trim() ? (projects.rename(id, name.trim()) ?? null) : null
    if (updated) scheduleProgressSnapshot()
    return updated
  })

  // Foto do projeto (rail estilo Discord): picker → nativeImage 128px →
  // data URL persistida no projects.json (alguns KB, sem protocolo custom).
  ipcMain.handle('projects:setPhoto', async (_e, id: string) => {
    const result = await dialog.showOpenDialog({
      title: 'Foto do projeto',
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return projects.get(id) ?? null
    const img = nativeImage.createFromPath(result.filePaths[0])
    if (img.isEmpty()) return projects.get(id) ?? null
    // resize pode falhar/vir vazio em alguns formatos — NUNCA gravar dataURL
    // quebrada (a UI inteira mostrava imagem quebrada)
    let resized = img.resize({ width: 128, height: 128 })
    if (resized.isEmpty()) resized = img
    const dataUrl = resized.toDataURL()
    if (!dataUrl.startsWith('data:image') || dataUrl.length < 100) return projects.get(id) ?? null
    const updated = projects.setPhoto(id, dataUrl) ?? null
    if (updated) scheduleProgressSnapshot()
    return updated
  })

  ipcMain.handle('projects:removePhoto', (_e, id: string) => {
    const updated = projects.setPhoto(id, null) ?? null
    if (updated) scheduleProgressSnapshot()
    return updated
  })

  // RELOCAÇÃO: a pasta foi renomeada/movida fora do app. O id (e todo estado
  // chaveado por ele — tarefas, missões, backlog, políticas, maestro) fica;
  // só o caminho muda. Cascata: mata o que roda no cwd velho, conserta os
  // ponteiros de worktree do git e migra as sessões claude (o JSONL da
  // conversa vive em <configDir>/projects/<slug-do-cwd> — sem migrar, o
  // --resume do pane do Maestro não acha a conversa).
  ipcMain.handle('projects:relocate', async (e, id: string) => {
    const project = projects.get(id)
    if (!project) return { ok: false, error: 'projeto não encontrado' }
    const result = await dialog.showOpenDialog({
      title: `Nova pasta de "${project.name}"`,
      properties: ['openDirectory'],
      ...(existsSync(project.path) ? { defaultPath: project.path } : {})
    })
    if (result.canceled || !result.filePaths[0]) return { ok: false, error: 'cancelado' }
    const newPath = result.filePaths[0]
    const norm = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
    const clash = projects.list().find((p) => p.id !== id && norm(p.path) === norm(newPath))
    if (clash) return { ok: false, error: `essa pasta já é o universo "${clash.name}"` }
    // F2-c4 (§5.4 do mapa da Fase 2): relocar no meio de um veredito faria o
    // cwd do watch em voo sumir sob o advancePhase. Gesto raro e explícito do
    // dono — recusar com receita é trivial e correto.
    if (ctx.phaseTransitions.lockedCount(id) > 0) {
      return {
        ok: false,
        error:
          'há um veredito de fase fechando neste projeto agora — aguarde alguns segundos e tente relocar de novo'
      }
    }
    const oldPath = project.path
    // 1. derruba tudo que roda no projeto (panes no cwd velho ficariam zumbis)
    killMaestroSession(id)
    for (const pane of hub.panesOf(id)) {
      if (ptys.has(pane.paneId)) ptys.kill(pane.paneId)
      ctx.pushAll('panes:closeById', id, pane.paneId)
    }
    for (const [tid, watch] of phaseWatches) {
      if (watch.projectId === id) {
        phaseWatches.delete(tid)
        if (watch.paneId && !ptys.has(watch.paneId)) discardUnstartedPane(watch.paneId)
      }
    }
    // 2. caminho novo no store (única fonte de verdade do path)
    ctx.codeIntelligence?.invalidateWorktreeNow(oldPath)
    projects.setPath(id, newPath)
    // 3. git: o .git dos worktrees (userData/worktrees) aponta p/ o repo no
    // caminho antigo — repair rodado do caminho novo reescreve os ponteiros
    if (hasGitCommit(newPath)) repairWorktrees(newPath)
    // 4. sessões claude: copia o dir de conversas do slug antigo p/ o novo em
    // todos os seats + trust do cwd novo (senão o TUI trava no "trust folder")
    const slugOf = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
    const migratedBySeat = new Map<string, boolean>()
    for (const seat of seats.list()) {
      if (seat.cli !== 'claude') continue
      const configDir = seats.configDirOf(seat)
      try {
        const src = join(configDir, 'projects', slugOf(oldPath))
        const dst = join(configDir, 'projects', slugOf(newPath))
        if (existsSync(src) && !existsSync(dst)) cpSync(src, dst, { recursive: true })
        migratedBySeat.set(seat.id, existsSync(dst))
      } catch {
        migratedBySeat.set(seat.id, false)
      }
      ensureBypassAccepted(configDir, newPath)
    }
    // Sessão do PM presa ao slug antigo e sem migração → reset (um --resume
    // que não resolve travaria o pane). Seat codex retoma por thread id,
    // independente de cwd — nada a resetar. Orquestradores de missão rodam
    // no worktree (userData, não se moveu) — intocados.
    const pmSeatId = maestro.get(id).seatId
    const pmSeat = pmSeatId ? seats.get(pmSeatId) : undefined
    if (pmSeat?.cli === 'claude' && !migratedBySeat.get(pmSeat.id)) {
      maestro.update(id, { sessionId: undefined, tuiSessionId: undefined, personaSent: false })
    }
    // BOARD.md renasce já na pasta nova
    syncBoard(id)
    hub.publish({
      projectId: id,
      actor: 'app',
      kind: 'info',
      text: `pasta do projeto relocada: ${oldPath} → ${newPath}`,
      quiet: true
    })
    scheduleProgressSnapshot()
    return { ok: true, project: { ...projects.get(id)!, missing: false } }
  })
}
