/**
 * KIT DE SKILLS (Skills 2.0 — .synkora/reports/DESIGN_SKILLS_2_0_BUILD_2026-08-29.md).
 *
 * O DADO por trás do cardápio: quais skills cada tipo de chat leva no spawn.
 * A biblioteca (userData/skills/lib) é a MÁQUINA — o kit é a CURADORIA, e mora
 * em `userData/skills-kit.json` para que a tela de gestão (ADR-0006) o edite
 * sem tocar num único byte do disco de skills.
 *
 * REGRAS QUE VALEM COMO CONTRATO:
 * - O kit NUNCA mexe na lib: adicionar um slot não instala nada, remover um
 *   slot não apaga pasta nenhuma (quem apaga é a poda, por gesto explícito).
 * - A LEI (ADR-0005) é DOUTRINA, não clique: o slot `law: true` recusa
 *   desligar e recusa sair, e a recusa NOMEIA a receita (commit com o dono).
 *   Ela também é RE-AFIRMADA na leitura — um JSON editado à mão que perdeu a
 *   lei recebe a lei de volta, porque a lei vive no código, não no arquivo.
 * - Toggle vale para o PRÓXIMO spawn (o sync roda no `gui:create`); nada aqui
 *   alcança conversa já aberta.
 * - `release` não passa por aqui: chat sem kit é kit VAZIO por contrato do
 *   chamador (o sync recebe `chat: null`).
 *
 * Única dependência de Electron: o caminho padrão do arquivo, avaliado só
 * quando o construtor é chamado SEM argumento — é o que deixa a suíte rodar em
 * node puro, como as do backlog e dos planos.
 */
import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { loadJsonStore, persistJsonStore } from './jsonStore'

export type SkillChatType = 'dev' | 'planejamento'
export type SkillDevWing = 'execucao' | 'orquestracao'

export interface SkillsKitSlot {
  /** pasta na lib = `name:` do frontmatter */
  id: string
  /** a ocasião, em PT-BR, mostrada na tela e no seed ("vai mexer em UI") */
  occasion: string
  enabled: boolean
  /** LEI da persona (ADR-0005): a tela mostra FIXO, sem toggle;
   *  setSlotEnabled/removeSlot recusam nomeando a receita (mudar lei é
   *  doutrina com o dono — commit, nunca clique). v1: só o impeccable. */
  law?: boolean
}

export interface SkillsKitState {
  version: 1
  dev: { execucao: SkillsKitSlot[]; orquestracao: SkillsKitSlot[] }
  planejamento: SkillsKitSlot[]
}

/** Resultado de mutação: o estado SEMPRE volta (a tela redesenha com ele) e a
 *  recusa vem escrita — beco sem saída é bug (regra da casa). */
export type SkillsKitMutation =
  | { ok: true; state: SkillsKitState }
  | { ok: false; error: string; state: SkillsKitState }

/** Sinal para a caixa-preta sem importar o módulo dela (o store precisa rodar
 *  em node puro). O `ipc/skills.ts` liga isto ao `ctx.blackbox.record`. */
export interface SkillsKitSignal {
  event: string
  reason?: string
  detail?: Record<string, unknown>
}
export type SkillsKitRecorder = (signal: SkillsKitSignal) => void

/** ids de pasta aceitos na lib e no kit: minúsculas, dígitos e hífen simples
 *  (a pasta vira NOME DE ARQUIVO no worktree — Windows recusa `:` e `/`). */
export const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isSkillId(value: unknown): value is string {
  return typeof value === 'string' && SKILL_ID_PATTERN.test(value) && !value.includes('--')
}

/** A LEI v1 (ADR-0005): UI ⇒ impeccable, fixa na persona. */
export const SKILLS_LAW_ID = 'impeccable'

/** Receita da recusa: quem bate na lei sai daqui sabendo o caminho real. */
export function skillsLawRefusal(id: string): string {
  return `"${id}" é a LEI da persona (ADR-0005): mudar a lei é doutrina com o dono — commit no seed de src/main/skillsKit.ts, nunca um clique. Para trocar a direção estética, abra a discussão com o dono e mude o seed.`
}

const LAW_SLOT: SkillsKitSlot = {
  id: SKILLS_LAW_ID,
  occasion: 'mexer em UI (a lei da persona)',
  enabled: true,
  law: true
}

/**
 * O KIT v1 — reconstruído da curadoria e APROVADO pelo dono em 2026-08-29,
 * sem trocas. Uma skill por OCASIÃO (ADR-0004): kit curto por lei, e a
 * ocasião é o que a tela mostra ao lado do id.
 */
export function seedSkillsKit(): SkillsKitState {
  return {
    version: 1,
    dev: {
      execucao: [
        { ...LAW_SLOT },
        { id: 'synkora-investigacao', occasion: 'investigar antes de mexer', enabled: true },
        {
          id: 'synkora-codigo-limpo',
          occasion: 'limpar/revisar o próprio código',
          enabled: true
        },
        { id: 'test-driven-development', occasion: 'código novo com teste', enabled: true },
        { id: 'systematic-debugging', occasion: 'caçar um bug', enabled: true },
        { id: 'verification-before-completion', occasion: 'declarar pronto', enabled: true },
        { id: 'nodejs-backend-patterns', occasion: 'back-end/API', enabled: true },
        {
          id: 'supabase-postgres-best-practices',
          occasion: 'banco de dados',
          enabled: true
        },
        { id: 'owasp-security', occasion: 'segurança', enabled: true },
        { id: 'better-writing', occasion: 'copy de interface', enabled: true }
      ],
      orquestracao: [
        { id: 'writing-plans', occasion: 'destrinchar/planejar a frota', enabled: true },
        {
          id: 'resolving-merge-conflicts',
          occasion: 'integrar fatias/conflitos',
          enabled: true
        }
      ]
    },
    planejamento: [
      { id: 'brainstorming', occasion: 'entrevistar/descobrir', enabled: true },
      { id: 'domain-modeling', occasion: 'modelar o domínio', enabled: true },
      { id: 'codebase-design', occasion: 'desenhar a arquitetura', enabled: true },
      {
        id: 'architecture-decision-records',
        occasion: 'registrar decisões (ADRs)',
        enabled: true
      },
      { id: 'writing-plans', occasion: 'escrever o plano', enabled: true }
    ]
  }
}

function isSlotArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

/** Shape MÍNIMO que o arquivo precisa ter para valer alguma coisa. O conteúdo
 *  de cada slot é saneado depois — um slot podre não derruba o kit inteiro,
 *  mas um arquivo sem as três listas degrada para o seed. */
function looksLikeKitState(value: unknown): value is SkillsKitState {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SkillsKitState>
  if (candidate.version !== 1) return false
  const dev = candidate.dev
  if (typeof dev !== 'object' || dev === null) return false
  return (
    isSlotArray((dev as SkillsKitState['dev']).execucao) &&
    isSlotArray((dev as SkillsKitState['dev']).orquestracao) &&
    isSlotArray(candidate.planejamento)
  )
}

interface SanitizeReport {
  dropped: string[]
  lawRestored: boolean
}

function sanitizeSlot(value: unknown): SkillsKitSlot | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<SkillsKitSlot>
  if (!isSkillId(candidate.id)) return null
  const occasion =
    typeof candidate.occasion === 'string' && candidate.occasion.trim()
      ? candidate.occasion.trim().slice(0, 120)
      : 'sem ocasião registrada'
  const slot: SkillsKitSlot = {
    id: candidate.id,
    occasion,
    enabled: candidate.enabled !== false
  }
  // A lei nunca nasce do arquivo: quem carimba `law` é o seed (abaixo, em
  // `restoreLaw`). Um JSON editado à mão não promove skill nenhuma a lei.
  return slot
}

function sanitizeList(list: unknown[], report: SanitizeReport): SkillsKitSlot[] {
  const out: SkillsKitSlot[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const slot = sanitizeSlot(raw)
    if (!slot) {
      report.dropped.push(typeof raw === 'object' && raw !== null ? 'slot inválido' : String(raw))
      continue
    }
    // id repetido na mesma lista viraria duas linhas idênticas na tela
    if (seen.has(slot.id)) {
      report.dropped.push(`${slot.id} (duplicado)`)
      continue
    }
    seen.add(slot.id)
    out.push(slot)
  }
  return out
}

/** A LEI VOLTA SEMPRE. Arquivo que perdeu (ou desligou) o slot da lei recebe
 *  a lei de volta na leitura — ela mora no código, não no JSON. */
function restoreLaw(execucao: SkillsKitSlot[], report: SanitizeReport): SkillsKitSlot[] {
  const index = execucao.findIndex((slot) => slot.id === SKILLS_LAW_ID)
  if (index < 0) {
    report.lawRestored = true
    return [{ ...LAW_SLOT }, ...execucao]
  }
  const current = execucao[index]
  // Carimbar `law` é o código RE-AFIRMANDO doutrina — silencioso. O que vira
  // sinal é a lei ter sumido da lista ou ter sido DESLIGADA à mão.
  if (current.enabled !== true) report.lawRestored = true
  const next = [...execucao]
  next[index] = {
    ...current,
    occasion: current.occasion || LAW_SLOT.occasion,
    enabled: true,
    law: true
  }
  return next
}

function sanitizeState(value: SkillsKitState, report: SanitizeReport): SkillsKitState {
  return {
    version: 1,
    dev: {
      execucao: restoreLaw(sanitizeList(value.dev.execucao, report), report),
      orquestracao: sanitizeList(value.dev.orquestracao, report)
    },
    planejamento: sanitizeList(value.planejamento, report)
  }
}

/** Cópia defensiva: quem lê o estado nunca segura a referência viva do store. */
function cloneState(state: SkillsKitState): SkillsKitState {
  return {
    version: 1,
    dev: {
      execucao: state.dev.execucao.map((slot) => ({ ...slot })),
      orquestracao: state.dev.orquestracao.map((slot) => ({ ...slot }))
    },
    planejamento: state.planejamento.map((slot) => ({ ...slot }))
  }
}

/**
 * Os slots que um chat leva no spawn. dev = as DUAS alas (execução +
 * orquestração) habilitadas; planejamento = as habilitadas dele. `release`
 * jamais chega aqui: o chamador manda kit vazio por contrato.
 */
export function kitForChat(state: SkillsKitState, chat: SkillChatType): SkillsKitSlot[] {
  const slots =
    chat === 'dev' ? [...state.dev.execucao, ...state.dev.orquestracao] : state.planejamento
  // A mesma skill pode servir duas ocasiões (writing-plans nas duas alas do
  // dev seria o caso): a PASTA é uma só, então o transporte não a duplica.
  const seen = new Set<string>()
  const out: SkillsKitSlot[] = []
  for (const slot of slots) {
    if (!slot.enabled || seen.has(slot.id)) continue
    seen.add(slot.id)
    out.push({ ...slot })
  }
  return out
}

/** TODO id citado em QUALQUER slot de QUALQUER kit — habilitado ou não. É a
 *  lista de proteção da poda (ADR-0007): desligar não é autorizar apagar. */
export function allKitSkillIds(state: SkillsKitState): Set<string> {
  return new Set(
    [...state.dev.execucao, ...state.dev.orquestracao, ...state.planejamento].map(
      (slot) => slot.id
    )
  )
}

let recorder: SkillsKitRecorder | null = null
const pendingSignals: SkillsKitSignal[] = []

/** O `ipc/skills.ts` liga a caixa-preta aqui. Sinal emitido antes da ligação
 *  fica na fila e é drenado na ligação — degradação nunca é muda. */
export function attachSkillsKitRecorder(next: SkillsKitRecorder): void {
  recorder = next
  while (pendingSignals.length > 0) {
    const signal = pendingSignals.shift()
    if (signal) next(signal)
  }
}

function signal(input: SkillsKitSignal): void {
  if (recorder) recorder(input)
  else if (pendingSignals.length < 32) pendingSignals.push(input)
}

export class SkillsKitStore {
  private readonly file: string
  private data: SkillsKitState

  constructor(file = join(app.getPath('userData'), 'skills-kit.json')) {
    this.file = file
    // "não existia" e "existia e estava podre" são histórias diferentes no
    // diário — e é a segunda que alguém vai investigar.
    const existed = existsSync(file)
    let degraded = false
    const loaded = loadJsonStore<SkillsKitState>(
      this.file,
      () => {
        degraded = true
        return seedSkillsKit()
      },
      looksLikeKitState
    )
    const report: SanitizeReport = { dropped: [], lawRestored: false }
    const next = sanitizeState(loaded, report)
    if (degraded) {
      signal({
        event: 'skills-kit-seeded',
        reason: existed
          ? 'o skills-kit.json existia mas não era legível — o kit voltou ao seed aprovado'
          : 'primeira leitura: o kit nasceu do seed aprovado',
        detail: { file: this.file, existed }
      })
    } else if (report.dropped.length > 0 || report.lawRestored) {
      signal({
        event: 'skills-kit-degraded',
        reason:
          report.dropped.length > 0
            ? 'entradas inválidas no skills-kit.json foram descartadas'
            : 'a LEI da persona voltou ao kit (ela mora no código, não no arquivo)',
        detail: { dropped: report.dropped, lawRestored: report.lawRestored }
      })
    }
    // A primeira leitura SEMEIA o arquivo: o disco passa a ter a fotografia
    // que a tela mostra, mesmo que ninguém clique em nada.
    if (degraded || report.dropped.length > 0 || report.lawRestored) {
      persistJsonStore(this.file, next)
    }
    this.data = next
  }

  /** O arquivo pousa antes de a fotografia viva mudar. */
  private commit(next: SkillsKitState): SkillsKitState {
    persistJsonStore(this.file, next)
    this.data = next
    return cloneState(next)
  }

  state(): SkillsKitState {
    return cloneState(this.data)
  }

  private listOf(chat: SkillChatType, wing?: SkillDevWing): SkillsKitSlot[] {
    if (chat === 'planejamento') return this.data.planejamento
    return wing === 'orquestracao' ? this.data.dev.orquestracao : this.data.dev.execucao
  }

  private withList(
    chat: SkillChatType,
    wing: SkillDevWing | undefined,
    list: SkillsKitSlot[]
  ): SkillsKitState {
    if (chat === 'planejamento') return { ...this.data, planejamento: list }
    return wing === 'orquestracao'
      ? { ...this.data, dev: { ...this.data.dev, orquestracao: list } }
      : { ...this.data, dev: { ...this.data.dev, execucao: list } }
  }

  /** Onde o id mora hoje neste chat (a tela não precisa dizer a ala). */
  private locate(
    chat: SkillChatType,
    id: string
  ): { wing?: SkillDevWing; index: number } | null {
    if (chat === 'planejamento') {
      const index = this.data.planejamento.findIndex((slot) => slot.id === id)
      return index < 0 ? null : { index }
    }
    const execucao = this.data.dev.execucao.findIndex((slot) => slot.id === id)
    if (execucao >= 0) return { wing: 'execucao', index: execucao }
    const orquestracao = this.data.dev.orquestracao.findIndex((slot) => slot.id === id)
    return orquestracao < 0 ? null : { wing: 'orquestracao', index: orquestracao }
  }

  /** Liga/desliga um slot. Vale para a PRÓXIMA conversa aberta. */
  setSlotEnabled(chat: SkillChatType, id: string, enabled: boolean): SkillsKitMutation {
    const found = this.locate(chat, id)
    if (!found) {
      return {
        ok: false,
        error: `"${id}" não está no kit de ${chat} — adicione pela biblioteca antes de ligar ou desligar`,
        state: this.state()
      }
    }
    const list = this.listOf(chat, found.wing)
    const current = list[found.index]
    if (current.law && !enabled) {
      return { ok: false, error: skillsLawRefusal(id), state: this.state() }
    }
    if (current.enabled === enabled) return { ok: true, state: this.state() }
    const next = [...list]
    next[found.index] = { ...current, enabled }
    return { ok: true, state: this.commit(this.withList(chat, found.wing, next)) }
  }

  /**
   * Nova OCASIÃO no kit. Não instala nada: a skill já tem que estar na lib
   * (a tela só oferece o que o scan achou). `wing` só existe para o dev.
   */
  addSlot(
    chat: SkillChatType,
    slot: { id: string; occasion: string; enabled?: boolean },
    wing?: SkillDevWing
  ): SkillsKitMutation {
    if (!isSkillId(slot?.id)) {
      return {
        ok: false,
        error: `id de skill inválido — a pasta na biblioteca usa minúsculas, dígitos e hífen (ex.: "systematic-debugging")`,
        state: this.state()
      }
    }
    const occasion = typeof slot.occasion === 'string' ? slot.occasion.trim().slice(0, 120) : ''
    if (!occasion) {
      return {
        ok: false,
        error: 'toda skill entra por uma OCASIÃO (ADR-0004): escreva quando ela deve ser carregada',
        state: this.state()
      }
    }
    const already = this.locate(chat, slot.id)
    if (already) {
      const where =
        chat === 'dev' ? ` (ala ${already.wing === 'orquestracao' ? 'orquestração' : 'execução'})` : ''
      return {
        ok: false,
        error: `"${slot.id}" já está no kit de ${chat}${where} — edite a ocasião existente ou remova antes de recolocar`,
        state: this.state()
      }
    }
    const target: SkillDevWing | undefined = chat === 'dev' ? (wing ?? 'execucao') : undefined
    const list = this.listOf(chat, target)
    const next = [...list, { id: slot.id, occasion, enabled: slot.enabled !== false }]
    return { ok: true, state: this.commit(this.withList(chat, target, next)) }
  }

  /** Tira a ocasião do kit. NUNCA toca na lib do disco (quem apaga é a poda). */
  removeSlot(chat: SkillChatType, id: string): SkillsKitMutation {
    const found = this.locate(chat, id)
    if (!found) {
      return {
        ok: false,
        error: `"${id}" não está no kit de ${chat}`,
        state: this.state()
      }
    }
    const list = this.listOf(chat, found.wing)
    if (list[found.index].law) {
      return { ok: false, error: skillsLawRefusal(id), state: this.state() }
    }
    const next = list.filter((_, index) => index !== found.index)
    return { ok: true, state: this.commit(this.withList(chat, found.wing, next)) }
  }
}

let shared: SkillsKitStore | undefined

/**
 * A INSTÂNCIA ÚNICA do main. O IPC da tela e o sync do spawn (fatia B) leem o
 * MESMO store — duas instâncias sobre o mesmo arquivo se sobrescreveriam.
 * As suítes constroem `new SkillsKitStore(arquivoTemporário)` e não passam
 * por aqui.
 */
export function skillsKitStore(): SkillsKitStore {
  shared ??= new SkillsKitStore()
  return shared
}
