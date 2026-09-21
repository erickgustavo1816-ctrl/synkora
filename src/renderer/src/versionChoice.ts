/**
 * A RÉGUA DA VERSÃO NOVA — fonte única das DUAS telas que oferecem criar uma:
 * a lateral da aba Versões e o modal de missão nova. Ela não podia ficar dentro
 * do BacklogView (o modal é filho dele — o import voltaria em círculo) nem ser
 * copiada: a cópia do modal nasceria com um trio fixo que o main recusa em
 * projeto que já lançou.
 *
 * ORDEM DO DONO (2026-08-17): o campo LIVRE (digitável) só existe enquanto o
 * projeto tem ZERO versões — ele resolve o produto que CHEGA numerado ("posso
 * colocar um projeto que já esteja na 1.20 e não tem como eu controlar isso").
 * Criada a primeira, o app passa a saber de onde contar: o campo some para
 * sempre e sobram as sugestões calculadas da mais alta.
 */

/** o que a tela oferece num clique: o número e a frase que explica a escolha */
export interface VersionSuggestion {
  label: string
  kind: string
}

/** "V1.2.3" / "v1.2" / "1.3" → [major, minor, patch] (espelho do backlog.ts).
 *  Nome sem padrão numérico ("MVP") devolve null e continua sendo um nome
 *  legítimo — o que ele perde é lugar na ORDENAÇÃO. */
export function parseVersionTriple(name: string): [number, number, number] | null {
  const parts = name.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/iu)
  return parts ? [Number(parts[1]), Number(parts[2] ?? 0), Number(parts[3] ?? 0)] : null
}

export function compareVersionTriples(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] - b[index]
  return 0
}

/**
 * Projeto NOVO escolhe onde começa (decisão de 2026-08-06): nem todo produto
 * nasce 1.0 — alfa/beta começam no 0.x e o semver segue naturalmente dali. Com
 * uma versão qualquer no projeto, as opções passam a ser patch/minor/major
 * calculados da MAIS ALTA: por construção nunca ficam abaixo da main, e a
 * filtragem final garante que nenhuma sugestão repita um nome que já existe (o
 * main recusaria o clique).
 *
 * A VERSÃO DO MANIFESTO (ordem do dono, 2026-09-21): o `version` do
 * package.json da pasta do projeto é o número que o produto JÁ LANÇOU (o
 * release alinha essa chave ao subir). Ele entra na conta como se fosse uma
 * versão lançada: no projeto virgem que chega em 1.20 as sugestões nascem
 * 1.20.1 / 1.21 / 2.0 em vez de V1.0, e quando o manifesto está na frente do
 * que o Synkora conhece, é dele que se conta. Empate com um nome já cadastrado
 * deixa o nome ganhar (é ele que tem prefixo).
 */
export function versionSuggestions(
  versions: readonly { name: string }[],
  manifestVersion?: string | null
): VersionSuggestion[] {
  const parsed = versions
    .map((version) => ({ version, triple: parseVersionTriple(version.name), manifest: false }))
    .filter(
      (
        entry
      ): entry is { version: { name: string }; triple: [number, number, number]; manifest: boolean } =>
        entry.triple != null
    )
  const manifestTriple = manifestVersion ? parseVersionTriple(manifestVersion) : null
  if (manifestVersion && manifestTriple)
    parsed.push({ version: { name: manifestVersion }, triple: manifestTriple, manifest: true })
  // Sem NENHUM nome numérico não há de onde contar — vale para o projeto
  // virgem e para o que só tem nome de código ("MVP"), que continua precisando
  // de uma porta de saída na lateral.
  if (parsed.length === 0)
    return [
      { label: 'V1.0', kind: 'primeira versão — produto direto' },
      { label: 'V0.1.0', kind: 'beta — produto em validação' },
      { label: 'V0.0.1', kind: 'alfa — começo de tudo' }
    ]
  const top = [...parsed].sort(
    (a, b) => compareVersionTriples(b.triple, a.triple) || Number(a.manifest) - Number(b.manifest)
  )[0]
  const [major, minor, patch] = top.triple
  // O prefixo segue o nome cadastrado mais alto; contando do manifesto (que
  // não tem prefixo), herda o dos nomes do projeto — ou o "V" da casa.
  const namedTop = parsed.filter((entry) => !entry.manifest)
    .sort((a, b) => compareVersionTriples(b.triple, a.triple))[0]
  const prefixSource = top.manifest ? namedTop?.version.name : top.version.name
  const prefix = prefixSource === undefined ? 'V' : /^v/iu.test(prefixSource) ? prefixSource.slice(0, 1) : ''
  const from = top.manifest ? ` (a partir da ${manifestVersion} do package.json)` : ''
  return [
    { label: `${prefix}${major}.${minor}.${patch + 1}`, kind: `patch — correções${from}` },
    { label: `${prefix}${major}.${minor + 1}`, kind: `minor — features${from}` },
    { label: `${prefix}${major + 1}.0`, kind: `major — marco grande${from}` }
  ].filter(
    (candidate) =>
      !versions.some(
        (version) =>
          version.name.toLocaleLowerCase('pt-BR') === candidate.label.toLocaleLowerCase('pt-BR')
      )
  )
}

/**
 * O que a tela diz sobre o manifesto ao lado da "versão atual na main":
 * sem versão lançada no Synkora, ele É a atual; lançada mas com o manifesto na
 * frente, o aviso de que o número andou por fora. Igual ou atrás: silêncio.
 */
export function manifestVersionNote(
  versions: readonly { name: string; status: string }[],
  manifestVersion: string | null | undefined
): string | null {
  const triple = manifestVersion ? parseVersionTriple(manifestVersion) : null
  if (!manifestVersion || !triple) return null
  const launched = versions.filter((version) => version.status === 'lancada')
  if (launched.length === 0) return `${manifestVersion} · lida do package.json`
  const highest = versions
    .map((version) => parseVersionTriple(version.name))
    .filter((entry): entry is [number, number, number] => entry !== null)
    .sort((a, b) => compareVersionTriples(b, a))[0]
  if (!highest || compareVersionTriples(triple, highest) > 0)
    return `package.json já está em ${manifestVersion}`
  return null
}

/**
 * O campo do número escrito à mão. "ZERO versões" é literal: aberta e lançada
 * existem do mesmo jeito — uma contagem só de abertas devolveria o campo ao
 * projeto que já lançou tudo o que tinha, e o número dele já é conhecido.
 */
export function allowsOwnVersionNumber(versions: readonly { name: string }[]): boolean {
  return versions.length === 0
}
