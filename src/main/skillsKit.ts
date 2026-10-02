/**
 * KIT DE SKILLS (Skills 2.0 — .synkora/reports/DESIGN_SKILLS_2_0_BUILD_2026-08-29.md;
 * Skills 3.0 — ADR-0008/0009, .synkora/reports/DESIGN_HARNESS_DO_MODELO_2026-09-08.md).
 *
 * O DADO por trás da PRATELEIRA: quais skills cada tipo de chat leva no spawn.
 * A biblioteca (userData/skills/lib) é a MÁQUINA — o kit é a CURADORIA, e mora
 * em `userData/skills-kit.json` para que a tela de gestão (ADR-0006) o edite
 * sem tocar num único byte do disco de skills.
 *
 * A LEI CAIU (ADR-0008, 2026-09-08). Até aqui `impeccable` era `law: true`:
 * recusava desligar, recusava sair e voltava sozinho na leitura. O dono mediu o
 * custo — "impeccable não é a melhor opção pra landing page" — e revogou: não há
 * mais lei de skill, `impeccable` é slot comum como qualquer outro, e o que fica
 * é o PADRÃO na persona (interface pede UMA direção de design escolhida pela
 * obra). Consequência mecânica aqui: `law` não existe mais no tipo, ninguém é
 * promovido na leitura, e um `skills-kit.json` gravado pela era da lei carrega
 * igual — o campo `law` do arquivo é simplesmente IGNORADO (a versão segue 1).
 *
 * REGRAS QUE VALEM COMO CONTRATO:
 * - O kit NUNCA mexe na lib: adicionar um slot não instala nada, remover um
 *   slot não apaga pasta nenhuma (quem apaga é a poda, por gesto explícito).
 * - A PRATELEIRA É PONTO DE PARTIDA, NUNCA CERCA (ADR-0009): o que o agente
 *   puxa por conta dele vive no worktree (skillsSync/skillsAgentSync, com
 *   `origin: 'agent'`) e não passa por este arquivo.
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
import { readFileSync } from 'fs'
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

/**
 * O KIT v3 — a lista ORIGINAL fechada com o dono no grill de 2026-08-21,
 * recuperada da memória de longo prazo e RESTAURADA por ordem dele em
 * 2026-08-29 (o build daquele dia tinha semeado uma RECONSTRUÇÃO, aprovada
 * às cegas porque o original ainda não tinha aparecido).
 *
 * Uma skill por OCASIÃO (ADR-0004): kit curto por lei, e a ocasião é o que a
 * tela mostra ao lado do id. 17 slots, 16 pastas — `writing-plans` serve duas
 * ocasiões (planejar a frota no dev, escrever o plano no planejamento).
 *
 * `impeccable` segue PRIMEIRO da ala execução — não por lei (ela caiu na
 * ADR-0008), mas porque a ocasião dela é a mais frequente da casa; a ocasião
 * agora DIZ que é uma direção entre várias.
 */
/** A ocasião do impeccable HOJE (ADR-0008: uma das direções de design). */
export const IMPECCABLE_OCCASION = 'direção/polish de UI — uma das direções de design'
/** A ocasião que o seed de 2026-08-29 gravou no userData do dono, na era da
 *  lei. É EXATAMENTE este texto (e só ele, e só no impeccable) que a leitura
 *  migra — uma ocasião escrita pelo dono nunca é tocada. */
export const LAW_ERA_IMPECCABLE_OCCASION = 'mexer em UI (a lei da persona)'

export function seedSkillsKit(): SkillsKitState {
  return {
    version: 1,
    dev: {
      execucao: [
        {
          id: 'impeccable',
          occasion: IMPECCABLE_OCCASION,
          enabled: true
        },
        {
          id: 'synkora-design-system-standard',
          occasion: 'criar/evoluir design system',
          enabled: true
        },
        {
          id: 'synkora-codigo-limpo',
          occasion: 'limpar/revisar o próprio código',
          enabled: true
        },
        { id: 'synkora-investigacao', occasion: 'investigar antes de mexer', enabled: true },
        { id: 'codebase-design', occasion: 'desenhar a arquitetura', enabled: true },
        { id: 'node', occasion: 'back-end Node/runtime', enabled: true },
        { id: 'systematic-debugging', occasion: 'caçar um bug', enabled: true },
        { id: 'test-driven-development', occasion: 'código novo com teste', enabled: true },
        { id: 'verification-before-completion', occasion: 'declarar pronto', enabled: true },
        { id: 'owasp-security', occasion: 'segurança', enabled: true },
        { id: 'better-writing', occasion: 'copy de interface', enabled: true }
      ],
      orquestracao: [
        { id: 'writing-plans', occasion: 'destrinchar/planejar a frota', enabled: true }
      ]
    },
    planejamento: [
      { id: 'grilling', occasion: 'estressar uma proposta', enabled: true },
      { id: 'grill-me', occasion: 'ser entrevistado a fundo', enabled: true },
      { id: 'grill-with-docs', occasion: 'entrevista que escreve docs/ADRs', enabled: true },
      { id: 'domain-modeling', occasion: 'modelar o domínio', enabled: true },
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
  /** ids cuja ocasião da era da lei virou a de hoje (ADR-0008) */
  migrated: string[]
}

function sanitizeSlot(value: unknown): SkillsKitSlot | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<SkillsKitSlot>
  if (!isSkillId(candidate.id)) return null
  const occasion =
    typeof candidate.occasion === 'string' && candidate.occasion.trim()
      ? candidate.occasion.trim().slice(0, 120)
      : 'sem ocasião registrada'
  // O slot é montado CAMPO A CAMPO: um `law: true` sobrevivente da era da lei
  // (ou escrito à mão no userData) não entra por porta nenhuma — a lei caiu na
  // ADR-0008 e ninguém é promovido a nada na leitura.
  return {
    id: candidate.id,
    occasion,
    enabled: candidate.enabled !== false
  }
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

/** NADA VOLTA SOZINHO (ADR-0008). O arquivo do dono é a fotografia: slot que
 *  ele tirou fica fora, slot que ele desligou fica desligado. */
function sanitizeState(value: SkillsKitState, report: SanitizeReport): SkillsKitState {
  return {
    version: 1,
    dev: {
      execucao: migrateLawEraOccasion(sanitizeList(value.dev.execucao, report), report),
      orquestracao: sanitizeList(value.dev.orquestracao, report)
    },
    planejamento: sanitizeList(value.planejamento, report)
  }
}

/**
 * A ÚNICA migração da era da lei (revisão do orquestrador, 2026-09-08): o
 * userData do dono tem o slot do impeccable com a ocasião "mexer em UI (a lei
 * da persona)", e a tela contaria uma história revogada até ele editar à mão.
 * Troca só esse texto, só nesse id — o resto do arquivo é a fotografia dele.
 */
function migrateLawEraOccasion(execucao: SkillsKitSlot[], report: SanitizeReport): SkillsKitSlot[] {
  return execucao.map((slot) => {
    if (slot.id !== 'impeccable' || slot.occasion !== LAW_ERA_IMPECCABLE_OCCASION) return slot
    report.migrated.push(slot.id)
    return { ...slot, occasion: IMPECCABLE_OCCASION }
  })
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
    let existed = false
    let degraded = false
    const loaded = loadJsonStore<SkillsKitState>(
      this.file,
      () => {
        for (const candidate of [this.file, `${this.file}.bak`, `${this.file}.bak.1`]) {
          try {
            readFileSync(candidate)
            existed = true
          } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
              throw error
            }
          }
        }
        degraded = true
        return seedSkillsKit()
      },
      looksLikeKitState
    )
    const report: SanitizeReport = { dropped: [], migrated: [] }
    const next = sanitizeState(loaded, report)
    if (degraded) {
      signal({
        event: 'skills-kit-seeded',
        reason: existed
          ? 'a persistência do skills-kit.json existia mas não era legível — seed aprovado em memória, arquivos preservados e gravação bloqueada'
          : 'primeira leitura: o kit nasceu do seed aprovado',
        detail: { file: this.file, existed, writesBlocked: existed }
      })
    } else if (report.dropped.length > 0) {
      signal({
        event: 'skills-kit-degraded',
        reason: 'entradas inválidas no skills-kit.json foram descartadas',
        detail: { dropped: report.dropped }
      })
    }
    if (!degraded && report.migrated.length > 0) {
      signal({
        event: 'skills-kit-migrated',
        reason: 'a ocasião da era da lei virou a de hoje (ADR-0008)',
        detail: { migrated: report.migrated }
      })
    }
    if ((degraded && !existed) || report.dropped.length > 0 || report.migrated.length > 0) {
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
    // Nenhum slot é intocável (ADR-0008): o dono liga e desliga o que quiser,
    // `impeccable` incluído.
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
