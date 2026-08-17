import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { MaestroEvent } from './maestro'
import { redactSensitiveText } from './securityRedaction'

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
  /** sessão do PANE TUI do Maestro (resume ao reabrir o projeto/app) */
  tuiSessionId?: string
  /** contexto vivo da conversa do pane TUI (carimbo do sessionStats) — o
   *  paneSpec usa para decidir resume × fresco (teto de custo, 2026-08-06:
   *  replay integral de conversa grande custa fatia real do limite) */
  tuiContextTokens?: number
  /** versão atual do projeto — tarefas novas são carimbadas com ela */
  version?: string
  log: MaestroEvent[]
}

/* REGISTRO LEGADO (limpa F6, 2026-08-17): `bypassOff`, `sensitiveAutoOk`,
 * `runtimePaths`, `projectLifecycle`, `reviewerSeatId/Model/Effort` e
 * `releaseHold` saíram do tipo com os subsistemas que os liam (permissão por
 * pane, gate de segurança, persona do orquestrador, reviewer de integração,
 * hold de release). O loader não valida chave por chave, então o
 * maestro.json do dono continua carregando e regravando o que já tem. */

// Ferramentas e saídas do painel de fundo também entram no histórico.
const MAX_LOG = 800
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

function sanitizePersistedEvent(evt: MaestroEvent): MaestroEvent {
  const sanitize = (value: string): string =>
    redactSensitiveText(value).replace(EMAIL_RE, '[redigido:email]')
  return {
    ...evt,
    text: sanitize(evt.text),
    ...(evt.detail !== undefined ? { detail: sanitize(evt.detail) } : {})
  }
}

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
    state.log = [...state.log, sanitizePersistedEvent(evt)].slice(-MAX_LOG)
    this.data[projectId] = state
    this.persist()
  }

  /** Apaga o estado de uma chave (ex.: orquestrador de missão excluída) —
   *  arquivo inútil não fica (política do usuário). */
  forget(key: string): void {
    if (this.data[key]) {
      delete this.data[key]
      this.persist()
    }
  }

  /** /clear: zera sessão e conversa, preserva modelo/effort/limite configurados. */
  clear(projectId: string): void {
    const { model, effort, contextLimit, contextWindow, fastMode, seatId } =
      this.get(projectId)
    this.data[projectId] = {
      model,
      effort,
      contextLimit,
      contextWindow,
      fastMode,
      seatId,
      log: []
    }
    this.persist()
  }
}
