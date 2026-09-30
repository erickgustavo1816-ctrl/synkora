/**
 * IPC — domínio panes (fase 1, commit 7c).
 * Specs e consultas de pane pelo renderer: servidor de teste do dono
 * (▶ testar), mapa de portas do modal e a lista de panes vivos.
 * A mecânica mora no paneLifecycle (extras.engine).
 *
 * Corpo movido VERBATIM do whenReady do index.ts. CERCA VIVA da Fase 0:
 * register*Ipc é CHAMADO do whenReady (bloco único antes do createWindow),
 * NUNCA no import. Com este módulo, TODO handler IPC do Synkora vive em
 * src/main/ipc/ — exceto crash:renderer/perf:renderer-stall (escopo de
 * módulo, por desenho).
 */
import { app, ipcMain } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { randomUUID } from 'crypto'
import { createVersionWorktree } from '../worktree'
import {
  detectRuntimeScript,
  installCommand,
  portInvocation,
  readScriptCommand
} from '../runtimeScripts'
import { formatPortMap } from '../portMap'
import type { Mission } from '../missions'
import type { MainContext } from '../mainContext'
import type { PaneLifecycleEngine } from '../paneLifecycle'
import { isUnversionedProject, openSoloMission, unversionedRefusal } from '../../shared/projectVersioning'
import { soloMissionIsStopping } from '../soloMission'

/** Dependências do closure do index ainda não migradas (mesmo padrão dos
 * outros ipc/*). */
export interface PanesIpcExtras {
  engine: PaneLifecycleEngine
  /** missionEngine — worktree provado antes do servidor de teste. */
  ensureMissionWorktree(missionId: string): Promise<Mission | undefined>
}

export function registerPanesIpc(ctx: MainContext, extras: PanesIpcExtras): void {
  const { projects, backlog, blackbox, hub } = ctx
  const { engine, ensureMissionWorktree } = extras
  const { livePaneSpecs, closingPaneIds, harnessPortsInUse } = engine
  const { testServerPanes } = ctx

  ipcMain.handle(
    'panes:testServerSpec',
    async (
      e,
      projectId: string,
      target: { missionId?: string; versionId?: string },
      port?: number
    ): Promise<{
      ok: boolean
      msg?: string
      paneId?: string
      cwd?: string
      command?: string
      title?: string
      missionId?: string
      versionId?: string
    }> => {
      const project = projects.get(projectId)
      if (!project || !existsSync(project.path))
        return { ok: false, msg: 'projeto indisponível — a pasta existe?' }
      let cwd: string | undefined
      let label = ''
      let missionId: string | undefined
      if (isUnversionedProject(project)) {
        if (target.versionId) return { ok: false, msg: unversionedRefusal('versions') }
        const mission = openSoloMission(ctx.missions.list(projectId), projectId)
        if (!mission || mission.status !== 'ativa' || (target.missionId && target.missionId !== mission.id))
          return { ok: false, msg: unversionedRefusal('reopen') }
        if (soloMissionIsStopping(ctx.missions, projectId)) return { ok: false, msg: unversionedRefusal('second-mission') }
        cwd = project.path
        label = mission.title
        missionId = mission.id
      } else if (target.missionId) {
        const mission = await ensureMissionWorktree(target.missionId)
        if (!mission || mission.projectId !== projectId)
          return { ok: false, msg: 'missão não encontrada' }
        cwd = mission.worktree
        label = mission.title
        missionId = mission.id
      } else if (target.versionId) {
        const version = backlog
          .listVersions(projectId)
          .find((v) => v.id === target.versionId)
        if (!version) return { ok: false, msg: 'versão não encontrada' }
        if (version.worktree && existsSync(version.worktree)) {
          cwd = version.worktree
        } else {
          const wt = createVersionWorktree(
            project.path,
            join(app.getPath('userData'), 'worktrees', projectId),
            version.name,
            version.id
          )
          if (wt) {
            backlog.setVersionBranch(version.id, wt.branch, wt.dir)
            cwd = wt.dir
          }
        }
        label = `versão ${version.name}`
      }
      if (!cwd || !existsSync(cwd))
        return {
          ok: false,
          msg: 'não foi possível preparar o worktree para testar (branch existe?)'
        }
      const script = detectRuntimeScript(cwd)
      if (!script)
        return {
          ok: false,
          msg: 'nenhum script dev/preview/serve/start no package.json deste worktree'
        }
      const portN = Number(port)
      const chosenPort = Number.isInteger(portN) && portN > 0 ? portN : undefined
      const isWin = process.platform === 'win32'
      const inv = portInvocation(readScriptCommand(cwd, script), script, chosenPort, isWin)
      // Worktree recém-criado NÃO tem node_modules — sem o bootstrap o script
      // resolvia binários pelo PATH herdado (caso real: o electron-vite do
      // PRÓPRIO Synkora vazou para o produto). O npm ci roda visível no pane.
      const needsInstall = !existsSync(join(cwd, 'node_modules'))
      const install = installCommand(cwd)
      const installPrefix = needsInstall
        ? isWin
          ? `if (-not (Test-Path node_modules)) { ${install} }; `
          : `[ -d node_modules ] || ${install}; `
        : ''
      // A nota (porta não se aplica / convenção PORT=) aparece NO PANE, onde
      // o usuário está olhando — o modal fecha no sucesso. O aviso de colisão
      // com "runtime de QA vivo" saiu junto com o gerente de runtime do gate:
      // hoje quem ocupa porta do harness é outro terminal de teste, e esses o
      // mapa de portas (panes:portsInUse) já anuncia.
      const noteText = inv.note
      const noteEcho = noteText
        ? isWin
          ? `Write-Host 'nota: ${noteText.replace(/'/g, "''")}'; `
          : `echo 'nota: ${noteText.replace(/'/g, "'\\''")}'; `
        : ''
      const command = `${noteEcho}${installPrefix}${inv.prefix}npm run ${script}${inv.suffix}`
      const paneId = randomUUID()
      testServerPanes.set(paneId, {
        projectId,
        missionId,
        cwd,
        command,
        port: chosenPort,
        label,
        purpose: 'test-server'
      })
      blackbox.record({
        cat: 'pane',
        event: 'test-server-open',
        actor: 'user',
        ids: { projectId, missionId, paneId },
        reason: `servidor de teste: "${command}" em ${cwd}`
      })
      // F3-c3: TODO nascimento de pane viaja por evento do main — as duas
      // views populam a lista (o host como espelho, a view de panes monta).
      const title = `▶ ${label.slice(0, 26)}`
      ctx.pushAll('panes:open-free', projectId, 'shell', {
        id: paneId,
        title,
        cwd,
        missionId,
        versionId: target.versionId,
        testServer: true
      })
      return {
        ok: true,
        paneId,
        cwd,
        command,
        title,
        missionId,
        versionId: target.versionId
      }
    }
  )

  // F3-c3: fechar pane a partir do HOST (■ derrubar teste do Board/Versões).
  // terminatePaneNow mata o PTY no main e faz o broadcast panes:closeById —
  // funciona MESMO com a view de panes crashada (o kill não depende dela).
  ipcMain.on('panes:requestClose', (e, projectId: string, paneId: string) => {
    engine.terminatePaneNow(projectId, paneId)
  })

  // Mapa de portas para o MODAL do ▶ testar (decisão do dono, 2026-08-07):
  // mesma string que o QA recebe no prompt — o dono escolhe vendo o mapa.
  ipcMain.handle('panes:portsInUse', (e, projectId: string) => {
    return formatPortMap(harnessPortsInUse(projectId))
  })

  ipcMain.handle('panes:live', () =>
    [...livePaneSpecs.values()].filter(
      ({ spec }) =>
        !closingPaneIds.has(spec.paneId) && Boolean(hub.identityByPane(spec.paneId))
    )
  )
}
