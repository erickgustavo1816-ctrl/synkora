import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MaestroEvent } from './maestro'

export interface MaestroProjectState {
  sessionId?: string
  model?: string
  effort?: string
  seatId?: string
  contextTokens?: number
  contextLimit?: number
  /** janela real do modelo atual (teto automático do medidor) */
  contextWindow?: number
  /** persona já foi enviada nesta sessão? (comandos / não contam) */
  personaSent?: boolean
  /** claude: fast mode ligado (/fast) */
  fastMode?: boolean
  /** harness automático: despacha tarefas do backlog sozinho pela política */
  autopilot?: boolean
  log: MaestroEvent[]
}

// Ferramentas e saídas do painel de fundo também entram no histórico.
const MAX_LOG = 800

// Persistência do Maestro por projeto: sessão do CLI, modelo escolhido e o
// histórico do painel. Sair do projeto (ou fechar o app) não perde a conversa.
export class MaestroStore {
  private file = join(app.getPath('userData'), 'maestro.json')
  private data: Record<string, MaestroProjectState> = {}

  constructor() {
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf-8'))
      } catch {
        this.data = {}
      }
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data), 'utf-8')
  }

  get(projectId: string): MaestroProjectState {
    return this.data[projectId] ?? { log: [] }
  }

  update(projectId: string, patch: Partial<MaestroProjectState>): void {
    this.data[projectId] = { ...this.get(projectId), ...patch }
    this.persist()
  }

  appendLog(projectId: string, evt: MaestroEvent): void {
    const state = this.get(projectId)
    state.log = [...state.log, evt].slice(-MAX_LOG)
    this.data[projectId] = state
    this.persist()
  }

  /** /clear: zera sessão e conversa, preserva modelo/effort/limite configurados. */
  clear(projectId: string): void {
    const { model, effort, contextLimit, contextWindow, fastMode } = this.get(projectId)
    this.data[projectId] = { model, effort, contextLimit, contextWindow, fastMode, log: [] }
    this.persist()
  }
}
