// R29 (2026-08-21) — O RELEASE ENTREGA A CAIXA.
//
// O caso que cobrou a rodada: a V1.0.4 do Painel subiu pelo release (merge +
// push da R28) com um fix do "verificar atualização" — e o erro continuou,
// porque o que o updater do produto lê NÃO é a main: é a release PUBLICADA do
// GitHub (instalador + latest.yml). Ninguém bumpou o version, ninguém publicou.
//
// A doutrina desta rodada, nas palavras do dono: o release "precisa entender
// com quem está lidando — se é um aplicativo que precisa de release, ele
// atualiza a release no GitHub; se não precisa, não atualiza. Não é só jogar
// no GitHub". O sinal é ESTRUTURAL, nunca heurística: produto que publica
// caixa = package.json com script `release` declarado (a convenção que o
// próprio produto carrega no publish-release dele).
//
// Divisão de autoridade: o BUMP do version é do HARNESS (commit na main antes
// do push — git manual na main é proibido ao agente); a PUBLICAÇÃO é do AGENTE
// (build de minutos, produto-específico, e o chat do release já mora na pasta
// do projeto com shell — R27). Este módulo é PURO (strings entram, strings
// saem): a sonda, o bump e as frases são provados em node puro
// (`test:release-publish`) sem app e sem disco.

/** O que a fotografia e o desfecho precisam saber do manifesto do produto. */
export interface ManifestPublishProbe {
  /** o produto declara pipeline de caixa? (`scripts.release` no package.json) */
  hasReleaseScript: boolean
  /** o `version` atual do manifesto (null = campo ausente). */
  version: string | null
}

/** Sonda o package.json do produto. `null` = JSON ilegível (produto quebrado
 *  responde no build dele, não aqui — sem sonda, sem linhas, sem bump). */
export function probeManifestPublish(manifestContents: string): ManifestPublishProbe | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestContents)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const manifest = parsed as { version?: unknown; scripts?: unknown }
  const scripts =
    typeof manifest.scripts === 'object' && manifest.scripts !== null
      ? (manifest.scripts as Record<string, unknown>)
      : undefined
  const releaseScript = scripts?.['release']
  return {
    hasReleaseScript: typeof releaseScript === 'string' && releaseScript.trim().length > 0,
    version:
      typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : null
  }
}

/**
 * O nome da versão do Synkora vira número de versão do produto — por régua
 * ESTREITA: `V1.0.4`/`v1.0.4`/`1.0.4` → `1.0.4`; partes ausentes completam
 * com zero (`V1.0` → `1.0.0`). Qualquer outra coisa ("V1.0 hotfix", "Sprint
 * 3") → null, e o bump mecânico NÃO acontece (vira linha advisory — guarda de
 * julgamento nunca decide sozinha).
 */
export function semverFromVersionName(name: string): string | null {
  const match = /^\s*[vV]?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/u.exec(name)
  if (!match) return null
  return `${Number(match[1])}.${Number(match[2] ?? '0')}.${Number(match[3] ?? '0')}`
}

/**
 * Troca CIRÚRGICA do primeiro `"version": "…"` do texto — a formatação do
 * dono fica intacta (JSON.stringify reescreveria o arquivo inteiro). No
 * package.json real o primeiro `"version"` é o top-level (scripts/deps não
 * têm chave com esse nome antes dele). `null` = campo não encontrado.
 */
export function bumpManifestVersion(contents: string, version: string): string | null {
  const pattern = /("version"\s*:\s*")([^"]*)(")/u
  if (!pattern.test(contents)) return null
  return contents.replace(pattern, (_all, open: string, _old: string, close: string) => `${open}${version}${close}`)
}

/**
 * O package-lock acompanha o bump (senão `npm ci`/instalador nascem
 * dessincronizados): os DOIS campos de versão (raiz e `packages[""]`).
 * O lock é gerado por máquina — parse + rewrite 2-espaços é o formato dele.
 */
export function bumpLockVersion(contents: string, version: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const lock = parsed as Record<string, unknown> & {
    packages?: Record<string, { version?: unknown }>
  }
  if (typeof lock.version === 'string') lock.version = version
  const rootPackage = lock.packages?.['']
  if (rootPackage && typeof rootPackage === 'object' && typeof rootPackage.version === 'string')
    rootPackage.version = version
  return `${JSON.stringify(lock, null, 2)}\n`
}

/** O desfecho do alinhamento de versão — quem consome é o texto do release. */
export type ReleaseBumpOutcome =
  | { kind: 'committed'; version: string }
  | { kind: 'aligned'; version: string }
  | { kind: 'name-not-semver'; name: string }
  | { kind: 'manifest-opaque' }
  | { kind: 'commit-failed'; version: string; error: string }

/** A sonda como viaja para a fotografia (espelho do `publish` do
 *  ReleaseStatusInput em releaseChat.ts — o par declarado). */
export interface ReleasePublishSignal {
  hasReleaseScript: boolean
  manifestVersion?: string
  expectedVersion?: string
}

/** A linha PUBLICAÇÃO da fotografia (release_status). */
export function releasePublishStatusLine(publish: ReleasePublishSignal, released = false): string {
  if (!publish.hasReleaseScript)
    return 'PUBLICAÇÃO: nenhum script `release` no package.json. A subida envia código à branch de destino; a hospedagem pode publicar por integração Git. Verifique a configuração e o resultado do deploy antes de declarar PROD publicado.'
  if (released)
    return 'PUBLICAÇÃO: a versão já subiu e o produto declara caixa (npm run release). Confira a entrega e se as correções exigem reconstrução/publicação autorizada; commit e push não confirmam instalador publicado.'
  const versionPart =
    publish.manifestVersion && publish.expectedVersion
      ? publish.manifestVersion === publish.expectedVersion
        ? ` · version ${publish.manifestVersion} em dia`
        : ` · version ${publish.manifestVersion} → ${publish.expectedVersion} (o harness alinha na subida)`
      : publish.expectedVersion
        ? ` · version esperado ${publish.expectedVersion}`
        : ' · o nome da versão não vira número de versão: confira o "version" do manifesto na mão'
  return (
    `PUBLICAÇÃO: o produto declara caixa (npm run release)${versionPart} — depois do release_run, ` +
    'a publicação roda na PASTA DO PROJETO e a subida só termina com a caixa no GitHub.'
  )
}

/**
 * Os fragmentos ` · …` que o desfecho do release_run anexa. Ordem: primeiro o
 * que o harness FEZ (ou não conseguiu), depois a receita do que falta. Nada
 * aqui derruba um release feito — falha vira frase nomeada, nunca rollback.
 */
export function releaseOutcomeFragments(input: {
  hasReleaseScript: boolean
  bump: ReleaseBumpOutcome | null
}): string[] {
  const fragments: string[] = []
  const { bump } = input
  if (bump) {
    if (bump.kind === 'committed')
      fragments.push(
        `o version do produto foi alinhado em ${bump.version} (commit na main, incluído no push)`
      )
    else if (bump.kind === 'commit-failed')
      fragments.push(
        `ATENÇÃO: o alinhamento do version para ${bump.version} FALHOU (${bump.error}) — alinhe o package.json na pasta do projeto antes de publicar`
      )
    else if (bump.kind === 'name-not-semver' && input.hasReleaseScript)
      fragments.push(
        `o nome da versão (${bump.name}) não vira número de versão — confira o "version" do package.json antes de publicar`
      )
    else if (bump.kind === 'manifest-opaque' && input.hasReleaseScript)
      fragments.push(
        'ATENÇÃO: não achei o campo "version" no package.json do produto — alinhe na mão antes de publicar'
      )
  }
  if (input.hasReleaseScript)
    fragments.push(
      'este produto PUBLICA caixa: rode npm run release na PASTA DO PROJETO (npm install antes, se as dependências mudaram) — ' +
        'ele builda o instalador e publica a release no GitHub com verificação própria; leia o desfecho e conte ao dono. ' +
        'A subida só termina com a caixa publicada'
    )
  return fragments
}
