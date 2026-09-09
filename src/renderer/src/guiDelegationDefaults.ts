/**
 * A RÉGUA DO PAINEL DE PADRÕES DA DELEGAÇÃO (D8 do design vinculante
 * `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
 *
 * Ordem do dono (18/08, tarde): uma "abinha do lado" onde ele carimba QUAL
 * MODELO e QUAL EFFORT os ajudantes usam por padrão — "como padrão vai vir
 * eles; caso eu queira outros, aí eu falo".
 *
 * Este módulo é a metade PURA da abinha: agrupar o catálogo real dos DOIS CLIs,
 * filtrar o effort pelo modelo escolhido e escrever o resumo honesto do estado.
 * Ele não conhece React, IPC nem store — é o que deixa a régua ser provada em
 * node puro, longe do app.
 */

export type GuiDelegationCli = 'claude' | 'codex'

/** O pino do dono, como o main o guarda (espelho de `GuiDelegationDefaults`,
 *  em `src/main/guiSessions.ts`). Campo ausente = herdar da conversa — menos o
 *  `fast`, que não herda nada: ausente ali é desligado. */
export interface GuiDelegationDefaultsValue {
  /** id da conta (seat) com que os ajudantes abrem — a primeira etapa da aba
   *  "ajudantes ˄" (2026-09-08). Ausente = a conta segue o modelo. */
  seat?: string
  model?: string
  effort?: string
  fast?: boolean
}

/** Uma conta como a aba a conhece — espelho estreito de `Seat` (store.ts). */
export interface GuiFleetSeat {
  id: string
  name: string
  cli: GuiDelegationCli
}

/**
 * O CLI de um modelo pelo NOME — espelho declarado de `resolveHelperCli`
 * (src/main/guiHelperSessions.ts): é a régua que o motor usa para decidir o
 * binário, e a aba precisa da mesma para saber se o modelo carimbado ainda
 * cabe na conta escolhida.
 */
export function guiDelegationModelCli(model: string): GuiDelegationCli {
  return /^gpt-/iu.test(model.trim()) ? 'codex' : 'claude'
}

/** Catálogo REAL de um CLI (`catalog.ts` → `window.synkora.catalog.get`). */
export interface GuiDelegationCatalog {
  cli: GuiDelegationCli
  /** Espelho estreito de `CatalogModel`, em `src/main/catalog.ts`: campo que
   *  não interessa à régua fica de fora, mas nenhum é renomeado no caminho. */
  models: {
    id: string
    label: string
    /** id canônico do alias ("opus[1m]" → "claude-opus-5"): a versão do nome digno */
    resolvedModel?: string
    efforts?: string[]
    supportsFastMode?: boolean
  }[]
  /** Níveis do BINÁRIO — o fallback de quem não declara nível por modelo. */
  efforts: string[]
}

export interface GuiDelegationModelOption {
  cli: GuiDelegationCli
  id: string
  /** id canônico do alias, quando o catálogo o publica */
  resolvedModel?: string
  /** Rótulo CRU do catálogo (`${displayName} — ${descrição}`) — o texto inteiro,
   *  preservado para a dica. */
  label: string
  /** O TÍTULO: o nome do modelo na régua do seletor do composer. */
  name: string
  /** A descrição do catálogo, quando ela existe. */
  detail: string | null
  /** Níveis já resolvidos. VAZIO = este modelo não aceita effort. */
  efforts: string[]
  /** O modelo aceita o modo fast (R13). Só a AFIRMAÇÃO do catálogo liga: o
   *  silêncio — fallback curado, catálogo de CLI antigo — fica `false`, e o
   *  painel não oferece por conta própria o modo que gasta mais limite. */
  supportsFastMode: boolean
}

/**
 * COMO O COMPOSER NOMEIA UM MODELO — injetado, nunca reimplementado aqui.
 *
 * O achado 5 do dono ("Tá muito feio... Opus Rochetes um milhão") é de FONTE:
 * o painel escrevia o id cru onde o seletor do composer escreve nome digno. A
 * régua digna é a do composer (`guiModelShortName` + `prettyModel`), e ela mora
 * lá — uma no módulo de apresentação, outra num componente React.
 *
 * Ela chega por parâmetro porque este módulo é provado em node puro: as suítes
 * carregam TS com type-stripping, que não resolve import de irmão sem extensão,
 * e o embelezador de id vive num arquivo de React. Injetar mantém a fonte
 * ÚNICA (o painel passa a função do composer) sem trazer React para cá.
 */
export type GuiDelegationModelNamer = (model: {
  id: string
  /** Nome humano do catálogo, JÁ sem a descrição. VAZIO = o catálogo só
   *  repetiu o id, e quem nomeia é o embelezador de id do composer. */
  displayName: string
  /** id canônico do alias ("claude-opus-5"): é dele que sai a versão do nome
   *  ("Opus 5"), exatamente como no seletor do composer */
  resolvedModel?: string
}) => string

/** Sem embelezador injetado a régua não inventa: fica com o que o catálogo
 *  disse. É o que mantém a metade pura provável sem simular o composer. */
const CATALOG_NAMER: GuiDelegationModelNamer = ({ id, displayName }) => displayName || id

/** `catalog.ts` escreve `${displayName} — ${descrição}` (travessão cercado de
 *  espaço); o codex manda só o `display_name`, sem descrição nenhuma. */
const CATALOG_LABEL_SPLIT = /^(.*?)\s+—\s+(.+)$/su

/**
 * Parte o rótulo do catálogo em NOME e DESCRIÇÃO.
 *
 * Rótulo que só repete o identificador não tem nome humano a oferecer: a cabeça
 * sai VAZIA de propósito, para o embelezador de id assumir. Mostrar `opus[1m]`
 * como título é exatamente o que o dono reprovou.
 *
 * "Só repete o id" é o rótulo que é NADA ALÉM do identificador — sem descrição
 * e idêntico a ele. É assim, e só assim, que ele nasce: `catalog.ts` escreve
 * `m.displayName ?? m.value` quando o CLI não descreve o modelo, e a régua
 * acima cai no `id` quando não vem rótulo nenhum.
 *
 * As duas exigências têm dono. Sem a DESCRIÇÃO, `fable — o mais capaz` perderia
 * o nome que o catálogo escolheu só porque ele coincide com o alias, e a lista
 * misturaria duas vozes (`FABLE` ao lado de `opus`). Sem a comparação EXATA, o
 * `GPT-5.6-Sol` do codex viraria repetição do slug — e ali a caixa É o nome
 * humano, a mesma palavra que o seletor do composer mostra.
 */
export function guiDelegationModelLabelParts(
  id: string,
  label: string
): { displayName: string; detail: string | null } {
  const text = label.trim()
  const parts = CATALOG_LABEL_SPLIT.exec(text)
  const head = (parts?.[1] ?? text).trim()
  const detail = parts?.[2]?.trim() || null
  const isJustTheId = detail === null && head === id.trim()
  return { displayName: isJustTheId ? '' : head, detail }
}

export interface GuiDelegationModelGroup {
  cli: GuiDelegationCli
  options: GuiDelegationModelOption[]
}

function cleanList(values: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>()
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen]
}

/**
 * Um grupo por CLI, na ordem em que os catálogos chegaram. CLI sem modelo
 * NENHUM não vira grupo: catálogo que ainda não respondeu (ou binário fora do
 * PATH) é ausência, e um cabeçalho vazio na tela leria como defeito.
 *
 * `efforts` de cada modelo:
 * - lista declarada e não vazia → é ela (o codex publica nível por modelo);
 * - lista declarada VAZIA → o modelo não aceita effort (o caso do haiku, sonda
 *   de 2026-08-18 §2.4: o flag é engolido sem aviso) e a abinha diz isso;
 * - NÃO declarada → os níveis daquele CLI, nunca os do outro: as escalas são
 *   diferentes (o claude vai a `max`, o codex trabalha em outra faixa).
 *
 * `supportsFastMode` atravessa como veio do catálogo, e só o `true` passa: modo
 * que gasta mais limite não se liga por omissão.
 */
export function guiDelegationModelGroups(
  catalogs: readonly GuiDelegationCatalog[],
  namer: GuiDelegationModelNamer = CATALOG_NAMER
): GuiDelegationModelGroup[] {
  const groups: GuiDelegationModelGroup[] = []
  for (const catalog of catalogs) {
    const fallback = cleanList(catalog.efforts)
    const options: GuiDelegationModelOption[] = []
    for (const model of catalog.models ?? []) {
      const id = typeof model.id === 'string' ? model.id.trim() : ''
      if (!id) continue
      const label = typeof model.label === 'string' && model.label.trim() ? model.label.trim() : id
      const { displayName, detail } = guiDelegationModelLabelParts(id, label)
      const resolvedModel =
        typeof model.resolvedModel === 'string' && model.resolvedModel.trim()
          ? model.resolvedModel.trim()
          : undefined
      options.push({
        cli: catalog.cli,
        id,
        ...(resolvedModel ? { resolvedModel } : {}),
        label,
        // O nome vem da régua do composer; o id só entra se ela devolver vazio,
        // porque uma ficha sem título nenhum seria pior que o id cru.
        name: namer({ id, displayName, ...(resolvedModel ? { resolvedModel } : {}) }).trim() || id,
        detail,
        efforts: model.efforts === undefined ? fallback : cleanList(model.efforts),
        supportsFastMode: model.supportsFastMode === true
      })
    }
    if (options.length > 0) groups.push({ cli: catalog.cli, options })
  }
  return groups
}

/** O modelo escolhido, quando ele existe no catálogo carregado. */
export function guiDelegationModelOption(
  groups: readonly GuiDelegationModelGroup[],
  model: string | undefined
): GuiDelegationModelOption | undefined {
  const wanted = model?.trim().toLowerCase()
  if (!wanted) return undefined
  for (const group of groups) {
    const found = group.options.find((option) => option.id.trim().toLowerCase() === wanted)
    if (found) return found
  }
  return undefined
}

/**
 * Os níveis oferecidos para o modelo escolhido. VAZIO em três casos honestos:
 * nenhum modelo carimbado, modelo que o catálogo não conhece, e modelo que
 * DECLARA não aceitar effort — nos três a abinha mostra "—" em vez de uma lista
 * que não vale.
 */
export function guiDelegationEffortOptions(
  groups: readonly GuiDelegationModelGroup[],
  model: string | undefined
): string[] {
  return guiDelegationModelOption(groups, model)?.efforts ?? []
}

/**
 * O que a abinha recolhida mostra. Sem pino a verdade é "herdado da conversa";
 * effort sozinho nunca pode parecer o nome de um modelo.
 *
 * Com o catálogo em mãos o modelo aparece pelo NOME (a mesma régua do painel
 * aberto e do seletor do composer). Pino que o catálogo carregado não conhece
 * continua dito COMO FOI CARIMBADO: trocá-lo por um nome inventado esconderia
 * justamente o pino que precisa de atenção.
 *
 * O ⚡ (R12) é a última parcela e nunca some sozinho: ele é a escolha que GASTA
 * MAIS, então mesmo sem modelo e sem effort a linha o diz — "herdado da
 * conversa · ⚡ fast" é o estado real, e "herdado da conversa" ali seria mentira.
 */
export function guiDelegationSummary(
  defaults: GuiDelegationDefaultsValue,
  groups: readonly GuiDelegationModelGroup[] = [],
  seats: readonly GuiFleetSeat[] = []
): string {
  const seatId = defaults.seat?.trim()
  // Conta que o app não conhece mais é dita PELO ID: esconder o pino seria o
  // estado mais enganoso da aba, e o id é o que o motor vai tentar usar.
  const seatName = seatId ? (seats.find((seat) => seat.id === seatId)?.name ?? seatId) : ''
  const model = defaults.model?.trim()
  const effort = defaults.effort?.trim()
  const fast = defaults.fast === true ? '⚡ fast' : ''
  if (!seatName && !model && !effort) {
    return ['herdado da conversa', fast].filter(Boolean).join(' · ')
  }
  const name = model ? (guiDelegationModelOption(groups, model)?.name ?? model) : ''
  return [seatName, name || (effort ? 'modelo da conversa' : ''), effort, fast]
    .filter(Boolean)
    .join(' · ')
}

// ————— A ABA "ajudantes ˄" (2026-09-08): a sequência conta › modelo › effort › fast —————

export interface GuiFleetPlanInput {
  defaults: GuiDelegationDefaultsValue
  /** o CLI da conversa (o delegador) — manda quando a conta é "a da conversa" */
  conversationCli: GuiDelegationCli
  seats: readonly GuiFleetSeat[]
  groups: readonly GuiDelegationModelGroup[]
  /** o dono já respondeu a etapa da conta nesta abertura (mesmo escolhendo
   *  "a da conversa", que não deixa pino): a etapa do modelo nasce */
  reachedModel: boolean
}

export interface GuiFleetPlan {
  /** o CLI que manda no catálogo: o da conta carimbada, senão o da conversa */
  cli: GuiDelegationCli
  /** conta carimbada que o app não conhece mais (apagada) — ainda valendo */
  seatOutsideList: boolean
  showModel: boolean
  /** "o da conversa" só é opção quando a conta é a da conversa (mesmo CLI):
   *  do outro lado não existe "modelo da conversa" para herdar */
  modelInheritAllowed: boolean
  modelOptions: GuiDelegationModelOption[]
  pinnedOption: GuiDelegationModelOption | undefined
  showEffort: boolean
  effortOptions: string[]
  showFast: boolean
}

/** O patch que a aba manda ao main: `null` LIMPA, ausente CONSERVA (a mesma
 *  gramática de `GuiDelegationDefaultsPatch`, em src/main/guiSessions.ts). */
export interface GuiFleetPatch {
  seat?: string | null
  model?: string | null
  effort?: string | null
  fast?: boolean | null
}

/**
 * A escolha da CONTA. `null` = "a da conversa". Modelo carimbado de OUTRO CLI
 * que o da conta nova não cabe nela: cai junto, e com ele o effort e o fast,
 * que são dele. Do mesmo CLI, fica. Re-escolher a mesma conta não grava nada.
 */
export function guiFleetSeatPatch(
  defaults: GuiDelegationDefaultsValue,
  seats: readonly GuiFleetSeat[],
  conversationCli: GuiDelegationCli,
  seat: string | null
): GuiFleetPatch | null {
  if ((seat ?? undefined) === (defaults.seat?.trim() || undefined)) return null
  const nextCli = (seat ? seats.find((candidate) => candidate.id === seat)?.cli : undefined) ?? conversationCli
  const model = defaults.model?.trim()
  const dropModel = Boolean(model) && guiDelegationModelCli(model ?? '') !== nextCli
  return { seat, ...(dropModel ? { model: null, effort: null, fast: null } : {}) }
}

/**
 * A escolha do MODELO. `null` = "o da conversa": limpa o effort junto (sem
 * modelo não existe escala para filtrar o nível) e o ⚡ (propriedade do modelo
 * carimbado). Trocando de modelo, o effort atravessa só se o novo o aceita, e
 * o ⚡ só se o novo tem o modo — catálogo VAZIO é ausência de notícia, não
 * notícia de ausência: ali o pino fica de pé (campo ausente CONSERVA).
 */
export function guiFleetModelPatch(
  defaults: GuiDelegationDefaultsValue,
  options: readonly GuiDelegationModelOption[],
  catalogLoaded: boolean,
  model: string | null
): GuiFleetPatch | null {
  if (model === null) return { model: null, effort: null, fast: null }
  if (model === defaults.model) return null
  const option = options.find((candidate) => candidate.id === model)
  const effort = defaults.effort?.trim()
  const keep = effort && option?.efforts.includes(effort) ? effort : null
  const dropFast = catalogLoaded && option?.supportsFastMode !== true
  return { model, effort: keep, ...(dropFast ? { fast: null } : {}) }
}

/**
 * O que a aba mostra, etapa a etapa. As etapas nascem UMA DE CADA VEZ — a
 * conta sempre; o modelo depois que a conta foi respondida (ou já há pino);
 * o effort só com modelo carimbado (os níveis são dele); o fast só quando o
 * modelo aceita — ou quando já está ligado, porque pino ligado e invisível é
 * o pior estado da aba.
 */
export function guiFleetPlan(input: GuiFleetPlanInput): GuiFleetPlan {
  const seatId = input.defaults.seat?.trim()
  const seat = seatId ? input.seats.find((candidate) => candidate.id === seatId) : undefined
  const cli = seat?.cli ?? input.conversationCli
  const modelOptions = input.groups.find((group) => group.cli === cli)?.options ?? []
  const pinnedOption = guiDelegationModelOption(input.groups, input.defaults.model)
  const model = Boolean(input.defaults.model?.trim())
  return {
    cli,
    seatOutsideList: Boolean(seatId) && !seat,
    showModel: Boolean(seatId) || model || input.reachedModel,
    modelInheritAllowed: !seat || seat.cli === input.conversationCli,
    modelOptions,
    pinnedOption,
    showEffort: model,
    effortOptions: pinnedOption?.efforts ?? [],
    showFast: input.defaults.fast === true || pinnedOption?.supportsFastMode === true
  }
}

/**
 * ESTE CHAT DELEGA?
 *
 * Derivado dos args do MCP, pelo MESMO motivo que o
 * `guiSpawnSuppressesNativeAgents` deriva a cerca do codex em vez de carregar um
 * campo próprio: todo campo novo do `GuiPaneSpawn` precisa ser repetido à mão em
 * quatro listas do renderer, e foi o silêncio dessas listas que já deixou um
 * chat inteiro sem ferramenta por uma noite.
 *
 * Os marcadores são EXCLUSIVOS de chat que delega (guiDelegateMcp): o claude
 * ganha `--disallowedTools` com a cerca anti-subagente-nativo e o codex ganha
 * `features.multi_agent=false`. Desde 2026-08-30 o PLANEJADOR também nasce com
 * as cercas (ele delega pesquisa), então a abinha aparece nele de graça — a
 * mesma derivação, nenhuma lista nova para esquecer.
 */
export function guiPaneDelegates(mcp: { args?: readonly string[] } | undefined): boolean {
  const args = mcp?.args ?? []
  return args.some(
    (arg) =>
      typeof arg === 'string' &&
      (arg === '--disallowedTools' || /features\.multi_agent\s*=\s*false/u.test(arg))
  )
}
