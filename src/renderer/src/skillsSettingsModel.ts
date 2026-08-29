// A TELA DE SKILLS, FORA DO REACT (Skills 2.0 — 2026-08-29).
//
// Tudo o que a tela DECIDE mora aqui: como o kit vira grupos na página, o que a
// busca da biblioteca acha, quantas pastas a poda leva e se uma URL do GitHub é
// mesmo a PASTA de uma skill. No componente isso ficaria escondido atrás de JSX
// e sem teste; aqui é puro, roda em node e reprova sozinho.
//
// OS TIPOS VÊM DO PRELOAD, não de uma cópia: o par declarado dele já espelha
// `src/main/skillsKit.ts` e `src/main/ipc/skills.ts`. Re-declarar aqui seria um
// terceiro espelho — e o terceiro é sempre o que fica para trás sem ninguém
// perceber. (O renderer segue sem importar main; o preload é a fronteira.)
import type {
  SkillChatType,
  SkillDevWing,
  SkillsKitSlot,
  SkillsKitState,
  SkillsLibraryItem
} from '../../preload'

export type {
  SkillChatType,
  SkillDevWing,
  SkillsKitSlot,
  SkillsKitState,
  SkillsLibraryItem
}

/** linha da biblioteca já resolvida contra o kit vivo (o `inKit` que a tela
 *  desenha sai do KIT, não do retrato que veio junto da lista) */
export type SkillsLibraryRow = SkillsLibraryItem

/** A REGRA VISÍVEL (ADR-0006): o kit é lido no SPAWN; conversa já aberta ficou
 *  com a pasta que recebeu no boot. Dizer isso na tela é o que evita o dono
 *  desligar um slot e esperar que o chat aberto mude de ideia. */
export const SKILLS_KIT_RULE =
  'A mudança vale para a PRÓXIMA conversa aberta — conversa já aberta não re-sincroniza.'

/** o que a ficha da LEI diz no lugar do toggle */
export const SKILLS_LAW_BADGE = 'lei da persona'

/** por que a LEI não tem toggle — a receita de mudá-la é doutrina, não clique */
export const SKILLS_LAW_NOTE =
  'Vale para todo trabalho de interface, em toda conversa de dev. Muda por decisão registrada (commit), nunca por clique.'

export type SkillsKitGroupKey = 'dev:execucao' | 'dev:orquestracao' | 'planejamento'

export interface SkillsKitGroup {
  key: SkillsKitGroupKey
  chat: SkillChatType
  /** null = o chat não tem alas (planejamento) */
  wing: SkillDevWing | null
  /** rótulo da ala na tela ('' quando o chat não tem alas: o cabeçalho do
   *  chat já disse tudo, e repetir vira dois títulos para uma coisa só) */
  label: string
  /** uma linha dizendo o que esta ala faz */
  hint: string
  slots: SkillsKitSlot[]
}

const GROUP_SHAPE: Array<Omit<SkillsKitGroup, 'slots'>> = [
  {
    key: 'dev:execucao',
    chat: 'dev',
    wing: 'execucao',
    label: 'ala execução',
    hint: 'pôr a mão no código.'
  },
  {
    key: 'dev:orquestracao',
    chat: 'dev',
    wing: 'orquestracao',
    label: 'ala orquestração',
    hint: 'repartir a obra entre ajudantes e integrar as fatias.'
  },
  {
    key: 'planejamento',
    chat: 'planejamento',
    wing: null,
    label: '',
    hint: ''
  }
]

export interface SkillsKitChatBlock {
  chat: SkillChatType
  /** título do bloco na tela */
  label: string
  /** onde essa conversa nasce — o dono precisa saber qual pasta recebe o kit */
  hint: string
  groups: SkillsKitGroup[]
}

const CHAT_SHAPE: Array<Omit<SkillsKitChatBlock, 'groups'>> = [
  {
    chat: 'dev',
    label: 'conversa de dev',
    hint: 'nasce no worktree da missão — as duas alas dividem a mesma pasta de skills.'
  },
  {
    chat: 'planejamento',
    label: 'conversa de planejamento',
    hint: 'nasce na raiz do projeto e escreve plano/.'
  }
]

function slotsOf(kit: SkillsKitState | null, key: SkillsKitGroupKey): SkillsKitSlot[] {
  if (!kit) return []
  if (key === 'dev:execucao') return kit.dev?.execucao ?? []
  if (key === 'dev:orquestracao') return kit.dev?.orquestracao ?? []
  return kit.planejamento ?? []
}

/**
 * O kit vira SEMPRE os três grupos, mesmo vazio: a tela precisa mostrar a ala
 * sem nenhum slot como uma ala VAZIA (com a saída: adicionar da biblioteca), e
 * não sumir com ela — uma ala que some parece uma ala que não existe.
 */
export function kitGroups(kit: SkillsKitState | null): SkillsKitGroup[] {
  return GROUP_SHAPE.map((shape) => ({ ...shape, slots: slotsOf(kit, shape.key) }))
}

/**
 * O mesmo kit, aninhado por TIPO DE CONVERSA. As duas alas do dev pertencem ao
 * MESMO chat (mesma pasta no worktree) — plano em três blocos irmãos diria que
 * são três conversas diferentes, que é justamente o que elas não são.
 */
export function kitChatBlocks(kit: SkillsKitState | null): SkillsKitChatBlock[] {
  const groups = kitGroups(kit)
  return CHAT_SHAPE.map((shape) => ({
    ...shape,
    groups: groups.filter((group) => group.chat === shape.chat)
  }))
}

/** quantos slots o chat inteiro tem (dev = as duas alas) */
export function chatSlotCount(block: SkillsKitChatBlock): number {
  return block.groups.reduce((total, group) => total + group.slots.length, 0)
}

/** quantos vão para a conversa: habilitados + a LEI (que não tem toggle) */
export function chatActiveCount(block: SkillsKitChatBlock): number {
  return block.groups.reduce(
    (total, group) => total + group.slots.filter((slot) => slot.enabled || slot.law).length,
    0
  )
}

/** ids com slot em QUALQUER kit (habilitado ou não) — é o critério da poda */
export function kitSkillIds(kit: SkillsKitState | null): string[] {
  const ids = new Set<string>()
  for (const group of kitGroups(kit)) for (const slot of group.slots) ids.add(slot.id)
  return [...ids].sort((a, b) => a.localeCompare(b))
}

/** a skill já tem slot no kit DESTE tipo de chat? (dev = as duas alas) */
export function isInChatKit(kit: SkillsKitState | null, chat: SkillChatType, id: string): boolean {
  return kitGroups(kit).some(
    (group) => group.chat === chat && group.slots.some((slot) => slot.id === id)
  )
}

/* ---------------------------------------------------------------- busca ---- */

/** minúsculas e SEM acento: procurar "investigação" tem que achar "investigacao" */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** a busca olha id E descrição — o dono lembra do assunto, não da pasta */
export function matchesSkillQuery(entry: SkillsLibraryItem, query: string): boolean {
  const needle = fold(query.trim())
  if (!needle) return true
  const haystack = `${fold(entry.id)} ${fold(entry.description)}`
  return needle.split(/\s+/u).every((term) => haystack.includes(term))
}

/**
 * As linhas da biblioteca: `inKit` REDERIVADO do kit vivo (fonte única), em
 * ordem de id. Trocar um slot não precisa de ida ao disco para o ✓ da lista
 * mudar — o kit que voltou da mutação já sabe.
 */
export function libraryRows(
  entries: readonly SkillsLibraryItem[],
  kit: SkillsKitState | null,
  query: string
): SkillsLibraryRow[] {
  const inKit = new Set(kitSkillIds(kit))
  return entries
    .filter((entry) => matchesSkillQuery(entry, query))
    .map((entry) => ({ ...entry, inKit: kit ? inKit.has(entry.id) : entry.inKit }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** A RECEITA do BOM: SKILL.md com BOM é frontmatter que o codex rejeita (sonda
 *  2026-08-29; o claude de hoje tolera, mas basta um recusar) — a pasta existe,
 *  a skill não chega inteira. Quem conserta é o instalador (grava sem BOM). */
export const SKILLS_BOM_NOTE =
  'O SKILL.md desta pasta começa com BOM e o codex não lê o frontmatter dela. Reinstale por URL: o instalador grava em UTF-8 sem BOM.'

/** ids cujo SKILL.md tem BOM — a tela avisa em vez de deixar falhar calado */
export function skillsWithBom(entries: readonly SkillsLibraryItem[]): string[] {
  return entries
    .filter((entry) => entry.hasBom)
    .map((entry) => entry.id)
    .sort((a, b) => a.localeCompare(b))
}

/** as pastas que a PODA leva: sem slot em nenhum kit, habilitado ou não */
export function prunableSkillIds(
  entries: readonly SkillsLibraryItem[],
  kit: SkillsKitState | null
): string[] {
  const keep = new Set(kitSkillIds(kit))
  return entries
    .map((entry) => entry.id)
    .filter((id) => !keep.has(id))
    .sort((a, b) => a.localeCompare(b))
}

/* --------------------------------------------------- adicionar ao kit ---- */

export interface KitAdditionDraft {
  id: string
  chat: SkillChatType
  /** ignorado fora do dev */
  wing: SkillDevWing
  occasion: string
}

export type KitAdditionCheck =
  | { ok: true; id: string; chat: SkillChatType; wing?: SkillDevWing; occasion: string }
  | { ok: false; error: string }

/** a ocasião é a linha que o agente lê — longa demais vira parágrafo na ficha */
export const OCCASION_MAX = 80

/**
 * A guarda de adicionar ao kit. Recusa NOMEANDO a saída (regra da casa: beco
 * sem saída é bug) — sem ocasião, com ocasião gigante ou com slot repetido, a
 * mensagem diz o que fazer.
 */
export function checkKitAddition(
  draft: KitAdditionDraft,
  kit: SkillsKitState | null
): KitAdditionCheck {
  const id = draft.id.trim()
  if (!id) return { ok: false, error: 'escolha uma skill da biblioteca primeiro.' }

  const occasion = draft.occasion.trim().replace(/\s+/gu, ' ')
  if (!occasion)
    return {
      ok: false,
      error: 'diga a OCASIÃO em uma linha (ex.: "vai mexer em UI") — é ela que o agente lê.'
    }
  if (occasion.length > OCCASION_MAX)
    return {
      ok: false,
      error: `a ocasião passou de ${OCCASION_MAX} caracteres — encurte para caber na ficha.`
    }

  if (isInChatKit(kit, draft.chat, id))
    return {
      ok: false,
      error: `${id} já tem slot no kit de ${chatLabel(draft.chat)} — edite o slot que existe em vez de criar outro.`
    }

  return draft.chat === 'dev'
    ? { ok: true, id, chat: 'dev', wing: draft.wing, occasion }
    : { ok: true, id, chat: 'planejamento', occasion }
}

export function chatLabel(chat: SkillChatType): string {
  return chat === 'dev' ? 'dev' : 'planejamento'
}

export function wingLabel(wing: SkillDevWing): string {
  return wing === 'execucao' ? 'execução' : 'orquestração'
}

/* ------------------------------------------------- instalar por URL ------ */

export type SkillUrlCheck =
  | { ok: true; url: string; folder: string }
  | { ok: false; error: string }

/**
 * A GUARDA DA URL (ADR-0007): só PASTA de skill no GitHub. Ela não substitui o
 * instalador do main (que resolve o sha e valida o `name:` do frontmatter) —
 * ela evita a viagem de rede que já nasce perdida, e cada recusa nomeia a
 * receita da URL certa.
 *
 * O `<ref>` do GitHub pode ter barra ("feat/x"), então a URL sozinha não separa
 * ref de caminho: aqui só exigimos que exista ALGO depois do ref. Quem desata
 * o nó é o main, com a API.
 */
export function checkSkillFolderUrl(raw: string): SkillUrlCheck {
  const text = raw.trim()
  if (!text)
    return {
      ok: false,
      error: 'cole a URL da PASTA da skill no GitHub (…/tree/<ref>/<caminho>).'
    }

  const withScheme = /^https?:\/\//iu.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: 'isso não é uma URL — cole o endereço completo da pasta no GitHub.' }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { ok: false, error: 'a URL precisa ser http(s) do github.com.' }

  const host = url.hostname.toLowerCase().replace(/^www\./u, '')
  if (host !== 'github.com')
    return {
      ok: false,
      error: 'por enquanto só github.com — a instalação pinada usa a API de commits do GitHub.'
    }

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (parts.length < 2)
    return { ok: false, error: 'faltou o repositório: github.com/<dono>/<repo>/tree/<ref>/<pasta>.' }

  // `github.com/<dono>/<repo>` sem /tree é a skill que MORA NA RAIZ do repo
  // (caso real: temporal-developer) — o main resolve o id pelo frontmatter.
  if (parts.length === 2) {
    return { ok: true, url: `https://github.com/${parts.join('/')}`, folder: '' }
  }

  const marker = parts[2]
  if (marker === 'blob')
    return {
      ok: false,
      error: 'essa URL aponta para um ARQUIVO — abra a PASTA da skill (a que contém o SKILL.md) e copie o endereço dela.'
    }
  if (marker !== 'tree')
    return {
      ok: false,
      error: 'aponte para uma pasta dentro do repositório: github.com/<dono>/<repo>/tree/<ref>/<pasta>.'
    }
  if (parts.length < 5)
    return {
      ok: false,
      error: 'essa URL é a raiz do repositório — abra a pasta da skill e copie o endereço dela.'
    }

  const folder = parts[parts.length - 1]
  return { ok: true, url: `https://github.com/${parts.join('/')}`, folder }
}
