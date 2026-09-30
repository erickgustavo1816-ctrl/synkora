import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { redactSensitiveText } from './securityRedaction'

// Hub do Synkora: DUAS coisas num arquivo só, e não se pode confundi-las.
//
// 1) REGISTRO DE IDENTIDADE (registerPane/unregisterPane/identityByToken/
//    identityByPane/panesOf). 🔴 ISTO NÃO É MECÂNICA F6: é o que autentica o
//    CHAT DE PLANEJAMENTO da era 2.0 no servidor MCP. `guiPlannerMcp.ts` emite
//    o bearer e registra a identidade aqui; `mcpServer.identityForRequest`
//    resolve o token por aqui a cada request. Apagar isto derruba o
//    propose_plan — e nenhuma suíte de chat perceberia, porque elas só
//    COMPILAM o guiPlannerMcp. Por isso existe o test:gui-planner-mcp.
//
// 2) BARRAMENTO DE EVENTOS: pane aberto/fechado, missão integrada, merge…
//    vira (a) linha em .synkora/EVENTS.md e (b) evento hub:event para a UI
//    (App.tsx toca o blip de marco).
//
// O que NÃO existe mais: TODA a entrega. O correio durável (caixa postal por
// endereço, entrega de carona no resultado da tool, nudge 📬, long-poll) saiu
// com o catálogo MCP legado; a fila de DIGITAÇÃO em pane de terminal saiu com
// o pipeline de fases (2026-08-17) — não há mais pane de agente com teclado
// para receber texto: o chat 2.0 conversa pelo protocolo do próprio CLI e o
// pane shell é do dono. `publish` grava e avisa a UI; ponto final.

/**
 * `gui-planner` (2.0, onda D) é o forasteiro desta lista: ele identifica um
 * CHAT (pane GUI de missão de planejamento), não um pane de terminal. A
 * identidade existe só para AUTENTICAR e ESCOPAR as tools de plano — ele nunca
 * entra na fila de injeção do hub, não recebe evento e não é destino de
 * notify_pane. Ver `guiPlannerMcp.ts`.
 */
export type HubPaneRole =
  | 'maestro'
  | 'dev'
  | 'review'
  | 'qa'
  // Chat de missão dev da era 2.0 com o MCP de DELEGAÇÃO (subagentes sem
  // aba, 2026-08-18): mesma natureza do gui-planner — autentica e escopa,
  // nunca recebe injeção.
  | 'gui-delegator'
  // Chat de RELEASE da versão (R10, 2026-08-19): mesma natureza — autentica e
  // escopa o catálogo release_status/release_run, nunca recebe injeção.
  | 'gui-release'
  | 'ajudante'
  | 'livre'
  | 'gui-planner'
export interface PaneIdentity {
  paneId: string
  projectId: string
  role: HubPaneRole
  taskId?: string
  phase?: 'dev' | 'review' | 'qa'
  cwd: string
  seatId?: string
  /** quem pediu este ajudante (recebe o aviso de conclusão) */
  delegatorPaneId?: string
  /** missão do pane (orquestrador da missão ou pane de tarefa da missão) */
  missionId?: string
}

export interface HubEvent {
  ts: string
  projectId: string
  kind:
    | 'pane-open'
    | 'pane-close'
    | 'task-created'
    | 'task-updated'
    | 'report'
    | 'delegate'
    | 'merge'
    | 'image'
    | 'error'
    | 'info'
  text: string
  /** quem causou (maestro/dev/review/qa/ajudante/harness/user) */
  actor?: string
  /** evento de MISSÃO: vai para o orquestrador dela, não para o PM */
  missionId?: string
  /** silencioso: registra em EVENTS.md + UI, mas NÃO injeta em pane nenhum
   *  (rotina que o usuário mesmo causou — o PM não precisa tagarelar) */
  quiet?: boolean
  /** URGENTE: um agente está ESPERANDO por isto (aprovação/pausa de plano) —
   *  tenta injetar AGORA, furando a cadência do drain; cai na fila se o pane
   *  não estiver quieto. */
  urgent?: boolean
}

export interface HubDeps {
  projectVersioningOf?: (projectId: string) => import('../shared/projectVersioning').ProjectVersioning
  projectPathOf: (projectId: string) => string | undefined
  /** Guarda central: nenhuma escrita/limpeza do runtime pode tocar .synkora
   *  quando o projeto já versiona esse diretório. */
  ensureProjectRuntimeWritable: (projectPath: string) => void
  onEvent: (evt: HubEvent) => void
}

export interface HubPublishOptions {
  /** Pane que já consumiu o evento por outro caminho e não deve ser acordado. */
  excludePaneId?: string
}

// EVENTS.md é JANELA OPERACIONAL, não história (decisão do usuário): a
// memória durável do projeto é o CONTEXT.md + os planos do universo.
const EVENTS_MAX_LINES = 300
const EVENTS_KEEP_LINES = 150

export class Hub {
  private readonly deps: HubDeps
  private byToken = new Map<string, PaneIdentity>()
  private byPane = new Map<string, PaneIdentity>()
  private appendCount = 0

  constructor(deps: HubDeps) {
    this.deps = deps
  }

  registerPane(token: string, identity: PaneIdentity): void {
    this.byToken.set(token, identity)
    this.byPane.set(identity.paneId, identity)
  }

  /** Lápides de panes mortos: paneId → identidade. notify_pane usa para
   *  reendereçar um id velho ao pane VIVO do mesmo card+papel (paneIds morrem
   *  em minutos — 3 ids para o mesmo dev em 4min no caso real de 05/08). */
  private tombstones = new Map<string, PaneIdentity>()

  tombstoneOf(paneId: string): PaneIdentity | undefined {
    return this.tombstones.get(paneId)
  }

  unregisterPane(paneId: string): PaneIdentity | undefined {
    const identity = this.byPane.get(paneId)
    if (identity) {
      this.tombstones.set(paneId, identity)
      if (this.tombstones.size > 300) {
        const oldest = this.tombstones.keys().next().value
        if (oldest !== undefined) this.tombstones.delete(oldest)
      }
      this.byPane.delete(paneId)
      for (const [token, id] of this.byToken) {
        if (id.paneId === paneId) this.byToken.delete(token)
      }
    }
    return identity
  }

  identityByToken(token: string): PaneIdentity | undefined {
    return this.byToken.get(token)
  }

  identityByPane(paneId: string): PaneIdentity | undefined {
    return this.byPane.get(paneId)
  }

  panesOf(projectId: string): PaneIdentity[] {
    return [...this.byPane.values()].filter((p) => p.projectId === projectId)
  }

  /** Publica um evento: EVENTS.md + UI + fila do Maestro do projeto. */
  publish(evt: Omit<HubEvent, 'ts'>, options: HubPublishOptions = {}): void {
    const full: HubEvent = {
      ...evt,
      text: redactSensitiveText(evt.text),
      ts: new Date().toISOString()
    }
    this.appendEventsFile(full)
    try {
      this.deps.onEvent(full)
    } catch {
      // UI é best-effort
    }
  }

  purgeMissionEvents(projectId: string, missionId: string): void {
    const projectPath = this.deps.projectPathOf(projectId)
    if (!projectPath) return
    try {
      if (this.deps.projectVersioningOf?.(projectId) !== 'none') this.deps.ensureProjectRuntimeWritable(projectPath)
      const file = join(projectPath, '.synkora', 'EVENTS.md')
      const tag = `[missão ${missionId.slice(0, 8)}]`
      const lines = readFileSync(file, 'utf-8').split('\n')
      const kept = lines.filter((l) => !l.includes(tag))
      if (kept.length !== lines.length) writeFileSync(file, kept.join('\n'), 'utf-8')
    } catch {
      // sem arquivo de eventos ainda
    }
  }

  private appendEventsFile(evt: HubEvent): void {
    const projectPath = this.deps.projectPathOf(evt.projectId)
    if (!projectPath) return
    try {
      if (this.deps.projectVersioningOf?.(evt.projectId) !== 'none') this.deps.ensureProjectRuntimeWritable(projectPath)
      const dir = join(projectPath, '.synkora')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'EVENTS.md')
      appendFileSync(
        file,
        `- ${evt.ts} [${evt.kind}]${evt.missionId ? ` [missão ${evt.missionId.slice(0, 8)}]` : ''}${evt.actor ? ` (${evt.actor})` : ''} ${evt.text.replace(/\s+/g, ' ').trim()}\n`,
        'utf-8'
      )
      // rotação barata: de tempos em tempos, mantém só o rabo do arquivo
      if (++this.appendCount % 200 === 0) {
        const lines = readFileSync(file, 'utf-8').split('\n')
        if (lines.length > EVENTS_MAX_LINES) {
          writeFileSync(file, lines.slice(-EVENTS_KEEP_LINES).join('\n'), 'utf-8')
        }
      }
    } catch {
      // eventos em arquivo são best-effort
    }
  }
}
