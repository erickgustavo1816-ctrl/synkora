import { randomUUID } from 'node:crypto'
// @ts-expect-error Node strip-types exige a extensão; o bundler também a aceita.
import { loadJsonStore, persistJsonStore } from './jsonStore.ts'

/**
 * A integração é paralela entre projetos, mas estritamente FIFO dentro de
 * cada projeto. Assim, missões podem ser desenvolvidas ao mesmo tempo sem que
 * duas delas tentem alterar a mesma branch de integração simultaneamente.
 */
export type IntegrationQueueState =
  | 'queued'
  | 'sync_required'
  | 'blocked'
  | 'merging'

export type IntegrationTargetKind = 'base' | 'version'
export type IntegrationBlockOwner = 'maestro' | 'orchestrator'

export interface IntegrationQueueBlock {
  code: string
  owner: IntegrationBlockOwner
  detail: string
  files?: string[]
  at: string
}

export interface IntegrationQueueResolution {
  instruction: string
  decidedAt: string
  decidedBy: 'maestro'
}

export interface IntegrationQueueTicket {
  id: string
  projectId: string
  missionId: string
  sequence: number
  state: IntegrationQueueState
  requestedAt: string
  requestedBy: string
  targetKind: IntegrationTargetKind
  versionId?: string
  attempts: number
  /** Card de plano aprovado cuja conclusão autorizou esta fotografia. */
  planId?: string
  sourceHead?: string
  validatedTargetHead?: string
  targetBranch?: string
  targetDir?: string
  startedAt?: string
  lastError?: string
  block?: IntegrationQueueBlock
  resolution?: IntegrationQueueResolution
}

/** Posição nunca é persistida: ela é derivada da sequência pendente. */
export interface IntegrationQueueTicketView extends IntegrationQueueTicket {
  position: number
  total: number
  isHead: boolean
}

export interface EnqueueIntegrationInput {
  projectId: string
  missionId: string
  requestedBy: string
  targetKind: IntegrationTargetKind
  versionId?: string
  requestedAt?: string
  planId?: string
  sourceHead?: string
  validatedTargetHead?: string
  targetBranch?: string
  targetDir?: string
}

export interface IntegrationQueueBlockInput {
  code: string
  owner: IntegrationBlockOwner
  detail: string
  files?: string[]
  at?: string
}

export type IntegrationQueueErrorCode =
  | 'invalid_input'
  | 'ticket_not_found'
  | 'invalid_transition'
  | 'not_queue_head'
  | 'merge_in_progress'

export class IntegrationQueueError extends Error {
  readonly code: IntegrationQueueErrorCode

  constructor(code: IntegrationQueueErrorCode, message: string) {
    super(message)
    this.name = 'IntegrationQueueError'
    this.code = code
  }
}

interface IntegrationQueueData {
  schemaVersion: 1
  nextSequence: number
  tickets: IntegrationQueueTicket[]
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

function isQueueState(value: unknown): value is IntegrationQueueState {
  return (
    value === 'queued' ||
    value === 'sync_required' ||
    value === 'blocked' ||
    value === 'merging'
  )
}

function isBlock(value: unknown): value is IntegrationQueueBlock {
  if (typeof value !== 'object' || value === null) return false
  const block = value as Partial<IntegrationQueueBlock>
  return (
    nonEmptyString(block.code) &&
    (block.owner === 'maestro' || block.owner === 'orchestrator') &&
    nonEmptyString(block.detail) &&
    nonEmptyString(block.at) &&
    (block.files === undefined ||
      (Array.isArray(block.files) && block.files.every((file) => typeof file === 'string')))
  )
}

function isResolution(value: unknown): value is IntegrationQueueResolution {
  if (typeof value !== 'object' || value === null) return false
  const resolution = value as Partial<IntegrationQueueResolution>
  return (
    nonEmptyString(resolution.instruction) &&
    nonEmptyString(resolution.decidedAt) &&
    resolution.decidedBy === 'maestro'
  )
}

function isTicket(value: unknown): value is IntegrationQueueTicket {
  if (typeof value !== 'object' || value === null) return false
  const ticket = value as Partial<IntegrationQueueTicket>
  if (
    !nonEmptyString(ticket.id) ||
    !nonEmptyString(ticket.projectId) ||
    !nonEmptyString(ticket.missionId) ||
    !Number.isSafeInteger(ticket.sequence) ||
    Number(ticket.sequence) < 1 ||
    !isQueueState(ticket.state) ||
    !nonEmptyString(ticket.requestedAt) ||
    !nonEmptyString(ticket.requestedBy) ||
    (ticket.targetKind !== 'base' && ticket.targetKind !== 'version') ||
    !Number.isSafeInteger(ticket.attempts) ||
    Number(ticket.attempts) < 0 ||
    !optionalString(ticket.planId) ||
    !optionalString(ticket.sourceHead) ||
    !optionalString(ticket.validatedTargetHead) ||
    !optionalString(ticket.targetBranch) ||
    !optionalString(ticket.targetDir) ||
    !optionalString(ticket.startedAt) ||
    !optionalString(ticket.lastError) ||
    (ticket.block !== undefined && !isBlock(ticket.block)) ||
    (ticket.resolution !== undefined && !isResolution(ticket.resolution))
  )
    return false

  if (ticket.targetKind === 'version' && !nonEmptyString(ticket.versionId)) return false
  if (ticket.targetKind === 'base' && ticket.versionId !== undefined) return false
  if ((ticket.state === 'blocked' || ticket.state === 'sync_required') && !ticket.block)
    return false
  return true
}

function isQueueData(value: unknown): value is IntegrationQueueData {
  if (typeof value !== 'object' || value === null) return false
  const data = value as Partial<IntegrationQueueData>
  if (
    data.schemaVersion !== 1 ||
    !Number.isSafeInteger(data.nextSequence) ||
    Number(data.nextSequence) < 1 ||
    !Array.isArray(data.tickets) ||
    !data.tickets.every(isTicket)
  )
    return false

  const ids = new Set<string>()
  const missions = new Set<string>()
  const sequences = new Set<number>()
  const mergingProjects = new Set<string>()
  let maxSequence = 0
  const heads = new Map<string, number>()

  for (const ticket of data.tickets) {
    if (ids.has(ticket.id) || missions.has(ticket.missionId) || sequences.has(ticket.sequence))
      return false
    ids.add(ticket.id)
    missions.add(ticket.missionId)
    sequences.add(ticket.sequence)
    maxSequence = Math.max(maxSequence, ticket.sequence)
    heads.set(
      ticket.projectId,
      Math.min(heads.get(ticket.projectId) ?? Number.POSITIVE_INFINITY, ticket.sequence)
    )
    if (ticket.state === 'merging') {
      if (mergingProjects.has(ticket.projectId)) return false
      mergingProjects.add(ticket.projectId)
    }
  }

  if (Number(data.nextSequence) <= maxSequence) return false
  return data.tickets.every(
    (ticket) => ticket.state !== 'merging' || heads.get(ticket.projectId) === ticket.sequence
  )
}

function copyTicket(ticket: IntegrationQueueTicket): IntegrationQueueTicket {
  return {
    ...ticket,
    block: ticket.block
      ? {
          ...ticket.block,
          files: ticket.block.files ? [...ticket.block.files] : undefined
        }
      : undefined,
    resolution: ticket.resolution ? { ...ticket.resolution } : undefined
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Store puro: o chamador escolhe o caminho (normalmente userData). Ao abrir,
 * qualquer merge interrompido por queda do app volta para o começo da mesma
 * fila; bloqueios e orientações de sincronização permanecem intactos.
 */
export class IntegrationQueueStore {
  private data: IntegrationQueueData
  private readonly file: string

  constructor(file: string) {
    this.file = file
    this.data = loadJsonStore(
      file,
      (): IntegrationQueueData => ({ schemaVersion: 1, nextSequence: 1, tickets: [] }),
      isQueueData
    )
    this.data.tickets.sort((a, b) => a.sequence - b.sequence)
    this.recoverInterruptedMerges()
  }

  private persist(): void {
    this.data.tickets.sort((a, b) => a.sequence - b.sequence)
    persistJsonStore(this.file, this.data)
  }

  private ticketByMission(missionId: string): IntegrationQueueTicket | undefined {
    return this.data.tickets.find((ticket) => ticket.missionId === missionId)
  }

  private requireTicket(missionId: string): IntegrationQueueTicket {
    const ticket = this.ticketByMission(missionId)
    if (!ticket)
      throw new IntegrationQueueError(
        'ticket_not_found',
        `A missão ${missionId} não está na fila de integração.`
      )
    return ticket
  }

  private view(ticket: IntegrationQueueTicket): IntegrationQueueTicketView {
    const lane = this.data.tickets
      .filter((candidate) => candidate.projectId === ticket.projectId)
      .sort((a, b) => a.sequence - b.sequence)
    const position = lane.findIndex((candidate) => candidate.id === ticket.id) + 1
    return {
      ...copyTicket(ticket),
      position,
      total: lane.length,
      isHead: position === 1
    }
  }

  listPending(projectId?: string): IntegrationQueueTicketView[] {
    return this.data.tickets
      .filter((ticket) => projectId === undefined || ticket.projectId === projectId)
      .sort((a, b) => a.sequence - b.sequence)
      .map((ticket) => this.view(ticket))
  }

  getByMission(missionId: string): IntegrationQueueTicketView | undefined {
    const ticket = this.ticketByMission(missionId)
    return ticket ? this.view(ticket) : undefined
  }

  head(projectId: string): IntegrationQueueTicketView | undefined {
    return this.listPending(projectId)[0]
  }

  activeMerge(projectId: string): IntegrationQueueTicketView | undefined {
    const ticket = this.data.tickets.find(
      (candidate) => candidate.projectId === projectId && candidate.state === 'merging'
    )
    return ticket ? this.view(ticket) : undefined
  }

  enqueue(input: EnqueueIntegrationInput): IntegrationQueueTicketView {
    const existing = this.ticketByMission(input.missionId)
    if (existing) return this.view(existing)

    if (
      !nonEmptyString(input.projectId) ||
      !nonEmptyString(input.missionId) ||
      !nonEmptyString(input.requestedBy) ||
      (input.targetKind !== 'base' && input.targetKind !== 'version') ||
      (input.targetKind === 'version' && !nonEmptyString(input.versionId)) ||
      (input.targetKind === 'base' && input.versionId !== undefined) ||
      !optionalString(input.planId) ||
      !optionalString(input.sourceHead) ||
      !optionalString(input.validatedTargetHead) ||
      !optionalString(input.targetBranch) ||
      !optionalString(input.targetDir)
    )
      throw new IntegrationQueueError('invalid_input', 'Dados inválidos para entrar na fila.')

    const ticket: IntegrationQueueTicket = {
      id: randomUUID(),
      projectId: input.projectId,
      missionId: input.missionId,
      sequence: this.data.nextSequence++,
      state: 'queued',
      requestedAt: input.requestedAt ?? nowIso(),
      requestedBy: input.requestedBy,
      targetKind: input.targetKind,
      versionId: input.targetKind === 'version' ? input.versionId : undefined,
      attempts: 0,
      planId: input.planId,
      sourceHead: input.sourceHead,
      validatedTargetHead: input.validatedTargetHead,
      targetBranch: input.targetBranch,
      targetDir: input.targetDir
    }
    this.data.tickets.push(ticket)
    this.persist()
    return this.view(ticket)
  }

  /**
   * Reserva a cabeça para merge. Retorna undefined quando a cabeça precisa
   * de decisão/sincronização ou quando já existe merge em andamento.
   */
  beginNext(projectId: string, at = nowIso()): IntegrationQueueTicketView | undefined {
    if (this.activeMerge(projectId)) return undefined
    const first = this.head(projectId)
    if (!first || first.state !== 'queued') return undefined
    return this.beginMerge(first.missionId, at)
  }

  /** Reserva uma missão específica, desde que ela seja a cabeça FIFO. */
  beginMerge(missionId: string, at = nowIso()): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (ticket.state === 'merging') return this.view(ticket)
    if (ticket.state !== 'queued')
      throw new IntegrationQueueError(
        'invalid_transition',
        `A missão ${missionId} está em ${ticket.state}, não em espera.`
      )
    const first = this.head(ticket.projectId)
    if (first?.id !== ticket.id)
      throw new IntegrationQueueError(
        'not_queue_head',
        `A missão ${missionId} ainda não chegou ao início da fila.`
      )
    const active = this.activeMerge(ticket.projectId)
    if (active)
      throw new IntegrationQueueError(
        'merge_in_progress',
        `A missão ${active.missionId} já está integrando neste projeto.`
      )

    ticket.state = 'merging'
    ticket.startedAt = at
    ticket.attempts += 1
    this.persist()
    return this.view(ticket)
  }

  /** Sincronização mecânica necessária antes de tentar o merge novamente. */
  requireSync(
    missionId: string,
    input: IntegrationQueueBlockInput
  ): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (ticket.state !== 'queued' && ticket.state !== 'merging')
      throw new IntegrationQueueError(
        'invalid_transition',
        `Não é possível pedir sincronização a partir de ${ticket.state}.`
      )
    ticket.state = 'sync_required'
    ticket.startedAt = undefined
    ticket.block = this.makeBlock(input)
    ticket.resolution = undefined
    ticket.lastError = input.detail
    this.persist()
    return this.view(ticket)
  }

  /** Conflito real: a posição fica congelada até o Maestro decidir. */
  block(missionId: string, input: IntegrationQueueBlockInput): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (ticket.state !== 'merging' && ticket.state !== 'queued')
      throw new IntegrationQueueError(
        'invalid_transition',
        `Não é possível bloquear a partir de ${ticket.state}.`
      )
    ticket.state = 'blocked'
    ticket.startedAt = undefined
    ticket.block = this.makeBlock(input)
    ticket.resolution = undefined
    ticket.lastError = input.detail
    this.persist()
    return this.view(ticket)
  }

  /**
   * O ref de destino já recebeu o merge, mas o worktree ainda não conseguiu
   * refletir esse commit. Este é um estado de recuperação, não um conflito:
   * pode sobrescrever o estado restaurado após crash e nunca aceita decisão
   * do Maestro nem uma nova tentativa de merge.
   */
  requireTargetRepair(
    missionId: string,
    detail: string,
    at = nowIso()
  ): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (!nonEmptyString(detail))
      throw new IntegrationQueueError('invalid_input', 'O detalhe do reparo está vazio.')
    ticket.state = 'blocked'
    ticket.startedAt = undefined
    ticket.block = {
      code: 'target_repair_pending',
      owner: 'orchestrator',
      detail: detail.trim(),
      at
    }
    ticket.resolution = undefined
    ticket.lastError = detail.trim()
    this.persist()
    return this.view(ticket)
  }

  /**
   * O reparo externo devolveu uma fotografia comprovadamente pré-CAS. Rearma
   * exatamente o mesmo ticket/sequence; nenhum item pode furar a FIFO.
   */
  requeueAfterTargetRepair(missionId: string): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (
      ticket.state !== 'blocked' ||
      ticket.block?.owner !== 'orchestrator' ||
      ticket.block.code !== 'target_repair_pending'
    ) {
      throw new IntegrationQueueError(
        'invalid_transition',
        'Somente um bloqueio operacional de reparo comprovado pode voltar à fila.'
      )
    }
    ticket.state = 'queued'
    ticket.startedAt = undefined
    ticket.block = undefined
    ticket.resolution = undefined
    ticket.lastError = undefined
    this.persist()
    return this.view(ticket)
  }

  /**
   * Só o Maestro produz esta transição: sua decisão fica registrada e a
   * missão passa a aguardar a aplicação da sincronização orientada.
   */
  guideResolution(
    missionId: string,
    input: { instruction: string; decidedAt?: string }
  ): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (ticket.state !== 'blocked' || ticket.block?.owner !== 'maestro')
      throw new IntegrationQueueError(
        'invalid_transition',
        ticket.state === 'blocked'
          ? 'Este bloqueio é operacional e não aceita uma nova estratégia de integração.'
          : `O Maestro só pode orientar uma missão bloqueada, não ${ticket.state}.`
      )
    if (!nonEmptyString(input.instruction))
      throw new IntegrationQueueError('invalid_input', 'A orientação do Maestro está vazia.')

    ticket.resolution = {
      instruction: input.instruction.trim(),
      decidedAt: input.decidedAt ?? nowIso(),
      decidedBy: 'maestro'
    }
    ticket.state = 'sync_required'
    this.persist()
    return this.view(ticket)
  }

  /** A correção terminou; o ticket conserva sua sequência original. */
  requeueAfterSync(
    missionId: string,
    snapshot: {
      planId?: string
      sourceHead?: string
      validatedTargetHead?: string
      targetBranch?: string
      targetDir?: string
    } = {}
  ): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (ticket.state !== 'sync_required')
      throw new IntegrationQueueError(
        'invalid_transition',
        `A missão ${missionId} não está aguardando sincronização.`
      )
    ticket.state = 'queued'
    ticket.startedAt = undefined
    if (snapshot.planId !== undefined) ticket.planId = snapshot.planId
    if (snapshot.sourceHead !== undefined) ticket.sourceHead = snapshot.sourceHead
    if (snapshot.validatedTargetHead !== undefined)
      ticket.validatedTargetHead = snapshot.validatedTargetHead
    if (snapshot.targetBranch !== undefined) ticket.targetBranch = snapshot.targetBranch
    if (snapshot.targetDir !== undefined) ticket.targetDir = snapshot.targetDir
    this.persist()
    return this.view(ticket)
  }

  /**
   * RE-LACRE (R9, 2026-08-19) — o AGENTE é o integrador.
   *
   * Resolver um conflito acontece DENTRO do worktree da missão, e isso muda o
   * commit da entrega. O ⇪ do dono autorizou a INTENÇÃO de subir aquela missão,
   * não um sha específico (palavras dele: "qualquer erro que der, ele que
   * arruma"), então o lacre acompanha a mão do agente e a TRANSPARÊNCIA ocupa o
   * lugar de uma segunda porteira: quem chama audita o par velho→novo
   * (`mission-integration-resealed`) e escreve a nota no fio que o dono lê.
   *
   * Só sobre um ticket EM ESPERA: um merge em andamento jamais troca a
   * fotografia debaixo de si mesmo.
   */
  reseal(
    missionId: string,
    snapshot: {
      sourceHead?: string
      validatedTargetHead?: string
      targetBranch?: string
      targetDir?: string
    }
  ): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (ticket.state !== 'queued')
      throw new IntegrationQueueError(
        'invalid_transition',
        `A missão ${missionId} está em ${ticket.state} e não pode ser relacrada.`
      )
    if (
      !optionalString(snapshot.sourceHead) ||
      !optionalString(snapshot.validatedTargetHead) ||
      !optionalString(snapshot.targetBranch) ||
      !optionalString(snapshot.targetDir)
    )
      throw new IntegrationQueueError('invalid_input', 'Fotografia inválida para o re-lacre.')
    if (snapshot.sourceHead !== undefined) ticket.sourceHead = snapshot.sourceHead
    if (snapshot.validatedTargetHead !== undefined)
      ticket.validatedTargetHead = snapshot.validatedTargetHead
    if (snapshot.targetBranch !== undefined) ticket.targetBranch = snapshot.targetBranch
    if (snapshot.targetDir !== undefined) ticket.targetDir = snapshot.targetDir
    this.persist()
    return this.view(ticket)
  }

  /**
   * A TENTATIVA DO AGENTE FALHOU (R9). O ticket NÃO congela em `blocked`
   * esperando uma decisão de máquina: ele volta para a espera, na MESMA
   * posição e na cabeça, carregando o motivo. Quem resolve é o agente — ele
   * está com a conversa do dono aberta —, e o dono vê o trabalho acontecendo no
   * fio em vez de um card parado.
   */
  noteAttemptFailure(missionId: string, detail: string): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (!nonEmptyString(detail))
      throw new IntegrationQueueError('invalid_input', 'O motivo da falha está vazio.')
    if (ticket.state !== 'queued' && ticket.state !== 'merging')
      throw new IntegrationQueueError(
        'invalid_transition',
        `A missão ${missionId} está em ${ticket.state}, não numa tentativa de integração.`
      )
    ticket.state = 'queued'
    ticket.startedAt = undefined
    ticket.lastError = detail.trim()
    this.persist()
    return this.view(ticket)
  }

  /**
   * A ERA DO AGENTE REABRE O QUE A ERA DA MÁQUINA CONGELOU (R9).
   *
   * `blocked`/`sync_required` de dono `maestro` eram esperas por uma decisão de
   * estratégia que HOJE é do agente da missão. Deixá-los parados seria um beco
   * sem saída — um ticket que nenhuma ferramenta viva consegue destravar. O
   * motivo fica preservado em `lastError`, e o ticket não fura fila nenhuma:
   * volta para a MESMA sequência.
   *
   * Bloqueio OPERACIONAL (`orchestrator`, reparo de destino) continua fora do
   * alcance dele de propósito: ali o merge JÁ está gravado no Git e uma segunda
   * tentativa seria perigosa — aquele estado espera reparo, não decisão.
   */
  reclaimForAgent(missionId: string): IntegrationQueueTicketView {
    const ticket = this.requireTicket(missionId)
    if (ticket.state !== 'blocked' && ticket.state !== 'sync_required')
      throw new IntegrationQueueError(
        'invalid_transition',
        `A missão ${missionId} está em ${ticket.state} — não há congelamento a reabrir.`
      )
    if (ticket.block?.owner !== 'maestro')
      throw new IntegrationQueueError(
        'invalid_transition',
        'Este bloqueio é operacional: o merge já está gravado e só o reparo do destino o resolve.'
      )
    ticket.state = 'queued'
    ticket.startedAt = undefined
    ticket.block = undefined
    ticket.resolution = undefined
    this.persist()
    return this.view(ticket)
  }

  /** Merge confirmado: remove a cabeça e faz as posições seguintes avançarem. */
  complete(missionId: string): boolean {
    const ticket = this.ticketByMission(missionId)
    if (!ticket) return false
    if (ticket.state !== 'merging')
      throw new IntegrationQueueError(
        'invalid_transition',
        `A missão ${missionId} não está em merge.`
      )
    this.data.tickets = this.data.tickets.filter((candidate) => candidate.id !== ticket.id)
    this.persist()
    return true
  }

  /** Cancelamento explícito pode retirar um ticket em qualquer estado. */
  cancel(missionId: string): boolean {
    const before = this.data.tickets.length
    this.data.tickets = this.data.tickets.filter((ticket) => ticket.missionId !== missionId)
    if (this.data.tickets.length === before) return false
    this.persist()
    return true
  }

  /**
   * Queda durante merge não pula a missão: ela volta a queued na mesma
   * posição. Estados que exigem intervenção humana/mecânica são preservados.
   */
  recoverInterruptedMerges(): number {
    let recovered = 0
    for (const ticket of this.data.tickets) {
      if (ticket.state !== 'merging') continue
      ticket.state = 'queued'
      ticket.startedAt = undefined
      recovered += 1
    }
    if (recovered > 0) this.persist()
    return recovered
  }

  private makeBlock(input: IntegrationQueueBlockInput): IntegrationQueueBlock {
    if (
      !nonEmptyString(input.code) ||
      (input.owner !== 'maestro' && input.owner !== 'orchestrator') ||
      !nonEmptyString(input.detail) ||
      (input.files !== undefined && !input.files.every((file) => typeof file === 'string'))
    )
      throw new IntegrationQueueError('invalid_input', 'Bloqueio inválido para a fila.')
    return {
      code: input.code.trim(),
      owner: input.owner,
      detail: input.detail.trim(),
      files: input.files ? [...input.files] : undefined,
      at: input.at ?? nowIso()
    }
  }
}
