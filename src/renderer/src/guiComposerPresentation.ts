import type { GuiCliModel } from './guiApi'

type GuiModelIdentity = Pick<GuiCliModel, 'value' | 'displayName' | 'resolvedModel'>

function stripModelMetadata(source: string): string {
  return source
    .replace(
      /\s*(?:\([^)]*(?:context|recommended|recomendado)[^)]*\)|\[[^\]]*(?:context|recommended|recomendado)[^\]]*\])\s*$/iu,
      ''
    )
    .replace(/\s+(?:·|—|-|:)\s+.*\b(?:context|recommended|recomendado)\b.*$/iu, '')
    .trim()
}

function hasNumericVersion(source: string): boolean {
  return /\b\d+(?:[.-]\d+)+\b|\b\d+\b/u.test(source)
}

function isBuildStamp(source: string): boolean {
  return /^(?:19|20)\d{6}$/u.test(source)
}

/** Mantém major + uma casa útil; datas e patch ficam fora do label visual. */
function compactVersionParts(parts: readonly string[]): string | null {
  const segments = parts.flatMap((part) => part.split('.')).filter(Boolean)
  const useful: string[] = []
  for (const segment of segments) {
    if (!/^\d+$/u.test(segment) || isBuildStamp(segment)) break
    useful.push(segment)
    if (useful.length === 2) break
  }
  if (useful.length === 0) return null
  const major = String(Number.parseInt(useful[0], 10))
  const minor = useful[1]
  if (!minor || /^0+$/u.test(minor)) return major
  return `${major}.${minor.charAt(0)}`
}

/** Também limpa displayName que já chega com data/build embutido. */
function compactDisplayedVersion(source: string): string {
  return source
    .replace(
      /\b(\d+(?:\.\d+)+)[-_](?:19|20)\d{6}\b/gu,
      (_full, version: string) => compactVersionParts([version]) ?? ''
    )
    .replace(
      /\b(\d+(?:[-_]\d+)+)[-_](?:19|20)\d{6}\b/gu,
      (_full, version: string) => compactVersionParts([version.replace(/[-_]/gu, '.')]) ?? ''
    )
    .replace(/\b\d+(?:\.\d+)+\b/gu, (version) => compactVersionParts([version]) ?? version)
    .replace(/[-_](?:19|20)\d{6}\b/gu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

/** Lê os blocos numéricos do identificador canônico sem inventar uma versão. */
function canonicalVersion(source: string): { family: string; version: string } | null {
  const tokens = source
    .replace(/\[[^\]]*\]/gu, '')
    .split(/[-_/]/u)
    .map((token) => token.trim())
    .filter(Boolean)
  const firstNumber = tokens.findIndex((token) => /^\d+(?:\.\d+)*$/u.test(token))
  if (firstNumber < 0) return null
  const versions: string[] = []
  for (const token of tokens.slice(firstNumber)) {
    if (!/^\d+(?:\.\d+)*$/u.test(token)) break
    versions.push(token)
  }
  if (versions.length === 0) return null
  const family = tokens[firstNumber - 1] ?? ''
  const version = compactVersionParts(versions)
  return version ? { family, version } : null
}

function titleFamily(source: string): string {
  if (!source) return ''
  return source.charAt(0).toUpperCase() + source.slice(1)
}

/** Presentation only: the canonical model id still goes to the executor. */
function readableModelName(source: string): string {
  const gpt = /^gpt[-_\s]?(\d+(?:\.\d+)*)(.*)$/iu.exec(source)
  if (gpt) {
    const variant = gpt[2].split(/[-_\s]+/u).filter(Boolean)
      .map(part => titleFamily(part.toLowerCase())).join(' ')
    return `GPT-${gpt[1]}${variant ? ` ${variant}` : ''}`
  }
  const claude = /^(?:claude[-_\s])?(opus|sonnet|haiku|fable|mythos)(?:[-_\s]+(.*))?$/iu.exec(source)
  if (claude) {
    const version = claude[2]?.replace(/(?<=\d)[-_](?=\d)/gu, '.')
    return `${titleFamily(claude[1].toLowerCase())}${version ? ` ${version}` : ''}`
  }
  return source
}

export function guiEffortLabel(effort: string | null | undefined): string {
  return effort?.trim().toUpperCase() || 'PADRÃO'
}

/**
 * O CLI pode mandar displayName sem geração ("Fable") e reservar a versão
 * exata para resolvedModel ("claude-fable-5"). O composer mostra a versão
 * canônica quando ela existe; quando não existe, preserva o displayName sem
 * adivinhar. Descrições longas continuam fora do label.
 */
export function guiModelShortName(
  model: GuiModelIdentity | undefined,
  fallback = ''
): string {
  const source = model?.displayName?.trim() || fallback.trim() || model?.value.trim() || 'modelo'
  const label = readableModelName(compactDisplayedVersion(stripModelMetadata(source)) || source)
  const canonical = model?.resolvedModel?.trim() || model?.value?.trim() || ''
  if (!canonical || hasNumericVersion(label)) return label

  const version = canonicalVersion(canonical)
  if (!version) return label
  const family = /^default\b/iu.test(label) ? titleFamily(version.family) : label
  return family ? `${family} ${version.version}` : label
}

/** O CLI trata value=default/displayName=Default como a mesma escolha. */
export function guiModelIsDefault(model: GuiModelIdentity | undefined): boolean {
  if (!model) return false
  return (
    model.value.trim().toLowerCase() === 'default' ||
    model.displayName.trim().toLowerCase().startsWith('default')
  )
}

/**
 * O protocolo mantém identidade (`value`) e rótulo (`displayName`) separados.
 * Alguns CLIs devolvem o id resolvido no evento de init; por isso o segundo
 * casamento usa `resolvedModel`, sem trocar a chave real usada no clique.
 */
export function guiModelForSelection(
  models: readonly GuiCliModel[],
  selected: string | null | undefined
): GuiCliModel | undefined {
  const id = selected?.trim()
  if (!id) return undefined
  return models.find((model) => model.value === id) ?? models.find((model) => model.resolvedModel === id)
}

export function guiModelLabel(
  models: readonly GuiCliModel[],
  selected: string | null | undefined,
  fallback = 'modelo'
): string {
  return guiModelShortName(guiModelForSelection(models, selected), fallback)
}

/** Espelho ESTREITO do catálogo real de um CLI (`catalog.ts` → `window.synkora
 *  .catalog.get`, o mesmo que o painel D8 lê). Declarado aqui porque este
 *  módulo é FOLHA (ver a nota do `compactTokens`): importar o tipo de
 *  `guiDelegationDefaults` quebraria as suítes que rodam o `.ts` cru. */
export interface GuiComposerCatalog {
  models?: readonly { id?: unknown; label?: unknown; efforts?: readonly unknown[] }[]
  efforts?: readonly unknown[]
}

function cleanEfforts(values: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>()
  for (const value of values ?? []) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen]
}

/**
 * A LISTA DE MODELOS ANTES DAS CAPS (foto do dono, 2026-08-30: pane "abrindo"
 * com o menu de modelos vazio e o chip de effort SUMIDO). Enquanto o CLI não
 * termina de abrir — no boot frio o `waitForCliStable` segura o spawn por
 * minutos — o composer cai no CATÁLOGO REAL da conta, vestido na forma das
 * caps, e os dois seletores continuam de pé.
 *
 * A régua dos efforts é ESPELHO DECLARADO de `guiDelegationModelGroups`
 * (guiDelegationDefaults.ts): lista declarada e não vazia é ela; declarada
 * VAZIA = o modelo não aceita effort; AUSENTE = os níveis do binário. E o
 * rótulo parte no ` — ` como lá (`CATALOG_LABEL_SPLIT`): `catalog.ts` escreve
 * `${displayName} — ${descrição}`, e descrição não é nome de menu.
 */
export function guiComposerCatalogModels(
  catalog: GuiComposerCatalog | undefined
): GuiCliModel[] {
  const fallback = cleanEfforts(catalog?.efforts)
  const models: GuiCliModel[] = []
  for (const model of catalog?.models ?? []) {
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id) continue
    const raw =
      typeof model.label === 'string' && model.label.trim() ? model.label.trim() : id
    const head = raw.split(/\s+—\s+/u)[0]?.trim() || id
    models.push({
      value: id,
      displayName: head,
      supportedEffortLevels:
        model.efforts === undefined ? fallback : cleanEfforts(model.efforts)
    })
  }
  return models
}

/** A VOZ COMPACTA DOS NÚMEROS DO CHAT. ESPELHO DECLARADO: o par é
 *  `compactTokens` em `guiCostSignals.ts` (o odômetro fala igual ao medidor de
 *  janela). A cópia existe porque os dois módulos são FOLHAS de propósito — as
 *  suítes os rodam como `.ts` cru, onde import entre eles não resolve. */
function compactTokens(value: number): string {
  const safe = Math.max(0, Math.round(value))
  if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)} mi`
  if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 100_000 ? 0 : 1)} mil`
  return String(safe)
}

export interface GuiContextUsagePresentation {
  percent: number
  label: string
  title: string
}

/** Fonte única da régua no composer; valores incompletos não viram chute. */
export function guiContextUsagePresentation(
  contextTokens: number | null | undefined,
  contextWindow: number | null | undefined
): GuiContextUsagePresentation | null {
  if (
    typeof contextTokens !== 'number' ||
    !Number.isFinite(contextTokens) ||
    contextTokens < 0 ||
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) return null

  const percent = Math.max(0, Math.min(100, Math.round((contextTokens / contextWindow) * 100)))
  return {
    percent,
    label: `${percent}% contexto`,
    title: `${compactTokens(contextTokens)} de ${compactTokens(contextWindow)} tokens usados`
  }
}
