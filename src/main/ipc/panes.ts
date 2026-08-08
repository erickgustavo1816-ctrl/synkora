/**
 * IPC — domínio panes (fase 1, commit 7c).
 * Specs e consultas de pane pelo renderer: servidor de teste do dono
 * (▶ testar), mapa de portas do modal, o pane do agente livre (freeSpec) e
 * a lista de panes vivos. A mecânica mora no paneLifecycle (extras.engine).
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
import { FREE_AGENT_PERSONA } from '../maestro'
import { buildIdleWaiterHint } from '../phasePrompts'
import { createVersionWorktree } from '../worktree'
import {
  activeQaRuntimes,
  detectRuntimeScript,
  installCommand,
  portInvocation,
  readScriptCommand
} from '../qaRuntime'
import { formatPortMap } from '../portMap'
import type { Mission } from '../missions'
import type { MainContext } from '../mainContext'
import type { PaneLifecycleEngine } from '../paneLifecycle'

/** Dependências do closure do index ainda não migradas (mesmo padrão dos
 * outros ipc/*). */
export interface PanesIpcExtras {
  engine: PaneLifecycleEngine
  bindUiSender(sender: Electron.WebContents): void
  codexDeveloperInstructions(value: string): string
  /** missionEngine — worktree provado antes do servidor de teste. */
  ensureMissionWorktree(missionId: string): Mission | undefined
}

export function registerPanesIpc(ctx: MainContext, extras: PanesIpcExtras): void {
  const { projects, seats, tasks, backlog, blackbox, hub, projectModeOf, projectPlanOf } = ctx
  const { engine, bindUiSender, codexDeveloperInstructions, ensureMissionWorktree } = extras
  const {
    livePaneSpecs,
    closingPaneIds,
    testServerPanes,
    armPane,
    harnessPortsInUse
  } = engine

  ipcMain.handle(
    'panes:testServerSpec',
    (
      e,
      projectId: string,
      target: { missionId?: string; versionId?: string },
      port?: number
    ): {
      ok: boolean
      msg?: string
      paneId?: string
      cwd?: string
      command?: string
      title?: string
      missionId?: string
      versionId?: string
    } => {
      bindUiSender(e.sender)
      const project = projects.get(projectId)
      if (!project || !existsSync(project.path))
        return { ok: false, msg: 'projeto indisponível — a pasta existe?' }
      let cwd: string | undefined
      let label = ''
      let missionId: string | undefined
      if (target.missionId) {
        const mission = ensureMissionWorktree(target.missionId)
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
      // o usuário está olhando — o modal fecha no sucesso.
      // Porta PINADA + runtime de QA vivo = colisão anunciada ANTES do crash
      // (caso real 2026-08-07: o dono escolheu outra porta, o produto foi na
      // 5174 pinada e morreu contra o runtime do QA de outra missão — o erro
      // cru não dizia quem segurava).
      let noteText = inv.note
      if (inv.note && /Electron/i.test(inv.note)) {
        const live = activeQaRuntimes()
        if (live.length > 0) {
          noteText = `${inv.note} · ATENÇÃO: runtime de QA vivo (${live
            .map((r) => {
              const t = tasks.get(r.taskId)
              return `card "${t?.title?.slice(0, 40) ?? r.taskId.slice(0, 8)}"${r.url ? ` em ${r.url}` : ''}`
            })
            .join(', ')}) — a porta pinada do produto provavelmente está OCUPADA; derrube aquele gate (■) ou teste depois`
        }
      }
      const noteEcho = noteText
        ? isWin
          ? `Write-Host 'nota: ${noteText.replace(/'/g, "''")}'; `
          : `echo 'nota: ${noteText.replace(/'/g, "'\\''")}'; `
        : ''
      const command = `${noteEcho}${installPrefix}${inv.prefix}npm run ${script}${inv.suffix}`
      const paneId = randomUUID()
      testServerPanes.set(paneId, { projectId, cwd, command, port: chosenPort, label })
      blackbox.record({
        cat: 'pane',
        event: 'test-server-open',
        actor: 'user',
        ids: { projectId, missionId, paneId },
        reason: `servidor de teste: "${command}" em ${cwd}`
      })
      return {
        ok: true,
        paneId,
        cwd,
        command,
        title: `▶ ${label.slice(0, 26)}`,
        missionId,
        versionId: target.versionId
      }
    }
  )

  // Mapa de portas para o MODAL do ▶ testar (decisão do dono, 2026-08-07):
  // mesma string que o QA recebe no prompt — o dono escolhe vendo o mapa.
  ipcMain.handle('panes:portsInUse', (e, projectId: string) => {
    bindUiSender(e.sender)
    return formatPortMap(harnessPortsInUse(projectId))
  })

  // Spec do PANE TUI do Maestro: um terminal REAL do CLI do seat escolhido,
  // com a persona de orquestrador e as tools MCP do Synkora. Sessão retomada
  // via --resume (claude) / resume (codex) quando o pane renasce.
  // AGENTE LIVRE (pane manual "✦ Agente"): nasce ARMADO — MCP do Synkora
  // (register_direct_mission, board_status, notify_maestro…) + persona de
  // consciência da base (claude). Sem isso ele podia quebrar o app editando a
  // main por fora do sistema de missões/versões.
  ipcMain.handle('panes:freeSpec', (e, projectId: string, seatId: string, effort?: string) => {
    bindUiSender(e.sender)
    const project = projects.get(projectId)
    const seat = seats.get(seatId)
    if (!project || !seat || !existsSync(project.path)) return null
    if (
      projectModeOf(projectId) === 'greenfield' &&
      projectPlanOf(projectId)?.status !== 'done'
    ) {
      hub.publish({
        projectId,
        kind: 'error',
        text:
          'agente livre bloqueado: este projeto novo ainda segue o plano mestre — trabalhe somente pela missão indicada pelo Maestro',
        actor: 'harness'
      })
      return null
    }
    seats.preseed(seat)
    const armed = armPane(
      { projectId, role: 'livre', cwd: project.path, seatId: seat.id },
      seat.cli,
      {
        strictMcp: true,
        configDir: seats.configDirOf(seat),
        // Antes do primeiro prompt nao existe uma missao que possa ser
        // classificada. Contexto desconhecido usa o perfil sensivel para nao
        // herdar bypass, hooks, plugins ou MCPs persistentes.
        sensitive: true
      }
    )
    const cliArgs = [...armed.cliArgs]
    if (effort) {
      if (seat.cli === 'claude') cliArgs.push('--effort', effort)
      else cliArgs.push('-c', `model_reasoning_effort="${effort}"`)
    }
    // F5-F3b: o agente livre também aprende a esperar SEM digitação (waiter
    // claude / long-poll codex) — era o único papel sem o hint (teste real
    // 2026-08-08: o livre pollou list_helpers/helper_output em loop).
    const freePersona = `${FREE_AGENT_PERSONA}${buildIdleWaiterHint(seat.cli)}`
    if (seat.cli === 'codex') {
      // persona invisível do codex VALIDADA em PTY real (2026-07-24, sonda
      // BANANA123): -c developer_instructions="…" injeta developer
      // instructions sem aparecer na conversa — os dois CLIs iguais.
      // Valor vira string TOML de uma linha (\n escapado).
      cliArgs.push('-c', codexDeveloperInstructions(freePersona))
    }
    return {
      paneId: armed.paneId,
      cliArgs,
      appendSystemPrompt: seat.cli === 'claude' ? freePersona : undefined
    }
  })

  ipcMain.handle('panes:live', () =>
    [...livePaneSpecs.values()].filter(
      ({ spec }) =>
        !closingPaneIds.has(spec.paneId) && Boolean(hub.identityByPane(spec.paneId))
    )
  )
}
