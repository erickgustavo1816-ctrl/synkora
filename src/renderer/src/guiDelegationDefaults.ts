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

/** O pino do dono, como o main o guarda. Campo ausente = herdar da conversa. */
export interface GuiDelegationDefaultsValue {
  model?: string
  effort?: string
}

/** Catálogo REAL de um CLI (`catalog.ts` → `window.synkora.catalog.get`). */
export interface GuiDelegationCatalog {
  cli: GuiDelegationCli
  models: { id: string; label: string; efforts?: string[] }[]
  /** Níveis do BINÁRIO — o fallback de quem não declara nível por modelo. */
  efforts: string[]
}

export interface GuiDelegationModelOption {
  cli: GuiDelegationCli
  id: string
  label: string
  /** Níveis já resolvidos. VAZIO = este modelo não aceita effort. */
  efforts: string[]
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
 */
export function guiDelegationModelGroups(
  catalogs: readonly GuiDelegationCatalog[]
): GuiDelegationModelGroup[] {
  const groups: GuiDelegationModelGroup[] = []
  for (const catalog of catalogs) {
    const fallback = cleanList(catalog.efforts)
    const options: GuiDelegationModelOption[] = []
    for (const model of catalog.models ?? []) {
      const id = typeof model.id === 'string' ? model.id.trim() : ''
      if (!id) continue
      options.push({
        cli: catalog.cli,
        id,
        label: typeof model.label === 'string' && model.label.trim() ? model.label.trim() : id,
        efforts: model.efforts === undefined ? fallback : cleanList(model.efforts)
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

/** O que a abinha recolhida mostra. Sem pino a verdade é "herdado da conversa";
 *  effort sozinho nunca pode parecer o nome de um modelo. */
export function guiDelegationSummary(defaults: GuiDelegationDefaultsValue): string {
  const model = defaults.model?.trim()
  const effort = defaults.effort?.trim()
  if (!model && !effort) return 'herdado da conversa'
  return [model || 'modelo da conversa', effort].filter(Boolean).join(' · ')
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
 * Os marcadores são EXCLUSIVOS do kit de delegação (guiDelegateMcp): o claude
 * ganha `--disallowedTools` com a cerca anti-subagente-nativo e o codex ganha
 * `features.multi_agent=false`. O kit de PLANOS não tem nenhum dos dois — e é
 * isso que impede a abinha de aparecer no chat de planejamento, que não delega.
 */
export function guiPaneDelegates(mcp: { args?: readonly string[] } | undefined): boolean {
  const args = mcp?.args ?? []
  return args.some(
    (arg) =>
      typeof arg === 'string' &&
      (arg === '--disallowedTools' || /features\.multi_agent\s*=\s*false/u.test(arg))
  )
}
