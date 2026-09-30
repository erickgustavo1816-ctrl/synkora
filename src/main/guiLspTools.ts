/**
 * AS FERRAMENTAS DE CÓDIGO DOS CHATS (R14, seção L2 do design
 * `.synkora/reports/DESIGN_COPIA_E_LSP_R14_2026-08-19.md`).
 *
 * O motor (`src/main/lsp/`) fala o protocolo e não sabe de mais nada: não
 * conhece pane, não conhece missão e — de propósito, decisão registrada pelo
 * agente L1 — não escreve uma linha de caixa-preta. Este módulo é a metade que
 * FALTAVA: ele traduz a identidade do pane em RAIZ, chama o motor e devolve
 * TEXTO legível ao agente. É aqui, e só aqui, que os eventos de LSP viram
 * `blackbox.record` com ids de correlação (paneId, projeto, missão, raiz).
 *
 * O `mcpServer.ts` só REGISTRA estas quatro tools nos catálogos; nenhuma regra
 * de produto mora lá.
 *
 * As três leis desta borda:
 *
 * 1. **Posição é 1-BASED nos dois sentidos.** O agente escreve `line`/`column`
 *    como ele lê num editor (a primeira linha é 1) e o recibo imprime na mesma
 *    contagem. A conversão para o fio já mora dentro do motor — aqui não se
 *    soma nem se subtrai 1 em lugar nenhum.
 * 2. **A raiz é o `cwd` da identidade.** O worktree da missão (ou a raiz do
 *    projeto) é o mundo inteiro daquela conversa: caminho fora dela é recusa, e
 *    a recusa NOMEIA a raiz que vale. É guarda de AUTORIDADE — o chat de uma
 *    missão não lê o worktree da outra.
 * 3. **Toda recusa nomeia a RECEITA.** As frases que o motor devolve
 *    (`LspAnswer.reason`, `LspError.message`) já vêm com ela e viajam
 *    VERBATIM para o recibo: reescrevê-las aqui só perderia o comando que
 *    destrava. Beco sem saída é bug.
 */
import { extname } from 'node:path'
import type { PaneIdentity } from './hub'
import {
  LspError,
  type LspAnswer,
  type LspDiagnostic,
  type LspHover,
  type LspLocation,
  type LspSeverity
} from './lsp/lspSession'

/** Os nomes das quatro tools, em UM lugar só. A pré-sanção do claude
 *  (`GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS`) e as suítes leem daqui — lista
 *  duplicada à mão é como uma tool nova volta a levantar card de permissão. */
export const LSP_TOOL_NAMES: readonly string[] = [
  'lsp_diagnostics',
  'lsp_definition',
  'lsp_references',
  'lsp_hover'
]

/**
 * O que o servidor de linguagem da onda 1 sabe ler. `.mjs`/`.cjs` entram porque
 * o tsserver os fala (o próprio motor já os mapeia para `javascript`) e porque
 * este repositório tem `scripts/*.mjs` de verdade — dizer "fora do alcance"
 * sobre um arquivo que o servidor entende seria um recibo MENTIROSO, que é pior
 * que um recibo ausente. `.json` fica de fora por outro motivo: o tsserver não
 * publica diagnóstico útil nele e a lista só ganharia ruído.
 */
export const LSP_SUPPORTED_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs'
]

/** Teto de PROBLEMAS por recibo. O agente conserta os primeiros e chama de
 *  novo; despejar mil linhas de erro num chat não ajuda ninguém — e o recibo
 *  diz em voz alta quando cortou. */
export const LSP_DIAGNOSTICS_ITEM_CAP = 200

/** Teto de arquivos por chamada de `lsp_diagnostics`: cada arquivo é um
 *  documento sincronizado com o servidor e uma janela de assentamento a pagar. */
export const LSP_DIAGNOSTICS_FILES_MAX = 40

/** Teto de posições por recibo de `lsp_definition`/`lsp_references`. */
export const LSP_LOCATIONS_ITEM_CAP = 200

/** Uma mensagem de erro de tipo profundamente aninhado passa dos 5 000
 *  caracteres; 200 delas seriam megabytes num resultado de tool. O corte com
 *  `…` não é beco sem saída: o arquivo e a linha estão logo ao lado. */
export const LSP_MESSAGE_MAX_CHARS = 600

/** Mesma doutrina para o hover, que carrega documentação inteira. */
export const LSP_HOVER_MAX_CHARS = 2000

/** A severidade do motor vira a palavra que o recibo imprime. */
const SEVERITY_LABEL: Record<LspSeverity, string> = {
  error: 'erro',
  warning: 'aviso',
  information: 'info',
  hint: 'dica'
}

/**
 * A fatia do motor que estas tools usam. Interface e não a classe, por duas
 * razões que valem juntas: a suíte injeta um dublê sem subir processo nenhum, e
 * o `LspManager` real satisfaz esta forma sem cast (é o mesmo contrato).
 */
export interface LspSessionLike {
  diagnostics(files: string[]): Promise<LspDiagnostic[]>
  definition(file: string, line: number, column: number): Promise<LspAnswer<LspLocation[]>>
  references(file: string, line: number, column: number): Promise<LspAnswer<LspLocation[]>>
  hover(file: string, line: number, column: number): Promise<LspAnswer<LspHover | null>>
}

export interface LspManagerLike {
  sessionFor(root: string): Promise<LspSessionLike>
}

/** Evento de caixa-preta desta borda. O `root` viaja SEMPRE: é ele que amarra
 *  a pergunta ao worktree, e um journal com paneId sem raiz não explica nada
 *  numa missão que já foi integrada. */
export interface GuiLspLogEntry {
  event: string
  paneId: string
  projectId?: string
  missionId?: string
  root: string
  detail?: Record<string, unknown>
  err?: string
}

export interface GuiLspToolsDeps {
  projectVersioning?: (projectId: string) => import('../shared/projectVersioning').ProjectVersioning
  manager: LspManagerLike
  /**
   * Os arquivos MODIFICADOS de uma raiz, relativos a ela — o alvo do
   * `lsp_diagnostics` sem `files`. Injetado porque a fonte é a MESMA do resto
   * do app (o gitWorker), e ela não pode entrar neste módulo: git no main
   * thread foi a causa raiz das travadas de 2026-08-04.
   *
   * Ausente = a tool sem `files` recusa nomeando a receita (`files`), nunca
   * devolve "nenhum problema" — mentir por omissão seria o pior desfecho.
   */
  changedFiles?: (root: string) => Promise<string[]>
  log?: (entry: GuiLspLogEntry) => void
}

/** O produto da fábrica: é isto que entra no `McpApi.lsp`. */
export interface GuiLspToolkit {
  diagnostics(id: PaneIdentity, files?: string[]): Promise<string>
  definition(id: PaneIdentity, file: string, line: number, column: number): Promise<string>
  references(id: PaneIdentity, file: string, line: number, column: number): Promise<string>
  hover(id: PaneIdentity, file: string, line: number, column: number): Promise<string>
}

/** A lista de extensões como o recibo e a descrição a imprimem. */
export function lspExtensionsLabel(): string {
  return LSP_SUPPORTED_EXTENSIONS.join(' ')
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\r?\n/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function supported(file: string): boolean {
  return LSP_SUPPORTED_EXTENSIONS.includes(extname(file).toLowerCase())
}

/** Lista curta para o recibo: nomes demais viram parede de texto. */
function nameList(files: string[], max = 6): string {
  return files.length <= max
    ? files.join(', ')
    : `${files.slice(0, max).join(', ')} (+${files.length - max})`
}

function diagnosticLine(problem: LspDiagnostic): string {
  const code = problem.code ? ` ${problem.code}` : ''
  return `${problem.file}:${problem.line}:${problem.column} ${SEVERITY_LABEL[problem.severity]}${code} ${truncate(problem.message, LSP_MESSAGE_MAX_CHARS)}`
}

function locationLine(location: LspLocation): string {
  return `${location.file}:${location.line}:${location.column}`
}

/**
 * A raiz desta conversa. Vem do `cwd` da identidade — o mesmo endereço que
 * autenticou o bearer —, nunca de um argumento: se o agente pudesse escolher a
 * raiz, a cerca do confinamento não valeria nada.
 */
function rootOf(id: PaneIdentity): string | undefined {
  const cwd = typeof id.cwd === 'string' ? id.cwd.trim() : ''
  return cwd.length > 0 ? cwd : undefined
}

const NO_ROOT =
  'esta conversa não tem uma pasta de trabalho registrada — feche e reabra o chat da missão para o servidor de linguagem saber onde olhar.'

/** Erro de qualquer natureza vira TEXTO. `LspError` já carrega a receita
 *  (servidor ausente, caminho fora da raiz, servidor morto no meio) e vai
 *  verbatim; o que não for `LspError` ganha a receita genérica em vez de virar
 *  -32603, que o agente racionalizaria como "olhei e não achei nada". */
function failureText(error: unknown): string {
  if (error instanceof LspError) return error.message
  const detail = error instanceof Error ? error.message : String(error)
  return `o servidor de linguagem não conseguiu responder: ${detail} — chame de novo; se insistir, reabra o chat da missão para levantar um servidor novo.`
}

export function buildGuiLspTools(deps: GuiLspToolsDeps): GuiLspToolkit {
  const note = (entry: GuiLspLogEntry): void => {
    // Observador NUNCA derruba a chamada real (mesma regra do resto da casa).
    try {
      deps.log?.(entry)
    } catch {
      /* diário best-effort */
    }
  }

  const ids = (
    id: PaneIdentity,
    root: string,
    event: string,
    detail?: Record<string, unknown>,
    err?: string
  ): GuiLspLogEntry => ({
    event,
    paneId: id.paneId,
    ...(id.projectId ? { projectId: id.projectId } : {}),
    ...(id.missionId ? { missionId: id.missionId } : {}),
    root,
    ...(detail ? { detail } : {}),
    ...(err ? { err } : {})
  })

  /** O corpo comum das três consultas pontuais: raiz, sessão, chamada e a
   *  tradução do envelope `LspAnswer` em texto. */
  async function ask(
    id: PaneIdentity,
    event: string,
    file: string,
    line: number,
    column: number,
    run: (session: LspSessionLike) => Promise<string>
  ): Promise<string> {
    const root = rootOf(id)
    if (!root) {
      note(ids(id, '', event, { file, line, column }, NO_ROOT))
      return NO_ROOT
    }
    try {
      const session = await deps.manager.sessionFor(root)
      const answer = await run(session)
      note(ids(id, root, event, { file, line, column }))
      return answer
    } catch (error) {
      const text = failureText(error)
      note(ids(id, root, event, { file, line, column }, text))
      return text
    }
  }

  return {
    async diagnostics(id, files) {
      if (!files?.length && deps.projectVersioning?.(id.projectId) === 'none') {
        return 'Este projeto trabalha direto na pasta. Passe `files` em lsp_diagnostics com os caminhos relativos dos arquivos que deseja verificar.'
      }
      const root = rootOf(id)
      if (!root) {
        note(ids(id, '', 'lsp-diagnostics', { asked: files?.length ?? 0 }, NO_ROOT))
        return NO_ROOT
      }
      try {
        const picked = await pickFiles(deps, root, files)
        if (typeof picked === 'string') {
          // `refused`, não `err`: "nenhum arquivo modificado" é uma RESPOSTA, e
          // carimbá-la de erro encheria o diário do dono de alarme falso.
          note(ids(id, root, 'lsp-diagnostics', { asked: files?.length ?? 0, refused: picked }))
          return picked
        }
        const session = await deps.manager.sessionFor(root)
        const problems = await session.diagnostics(picked.targets)
        note(
          ids(id, root, 'lsp-diagnostics', {
            files: picked.targets.length,
            fromGit: picked.fromGit,
            dropped: picked.dropped.length,
            problems: problems.length
          })
        )
        return diagnosticsReceipt(root, picked, problems)
      } catch (error) {
        const text = failureText(error)
        note(ids(id, root, 'lsp-diagnostics', { asked: files?.length ?? 0 }, text))
        return text
      }
    },

    definition(id, file, line, column) {
      return ask(id, 'lsp-definition', file, line, column, async (session) =>
        locationsReceipt(
          await session.definition(file, line, column),
          'definição',
          'definições',
          file,
          line,
          column
        )
      )
    },

    references(id, file, line, column) {
      return ask(id, 'lsp-references', file, line, column, async (session) =>
        locationsReceipt(
          await session.references(file, line, column),
          'referência',
          'referências',
          file,
          line,
          column
        )
      )
    },

    hover(id, file, line, column) {
      return ask(id, 'lsp-hover', file, line, column, async (session) =>
        hoverReceipt(await session.hover(file, line, column), file, line, column)
      )
    }
  }
}

interface PickedFiles {
  /** O que vai ao servidor, já filtrado e dentro do teto. */
  targets: string[]
  /** O que o filtro de extensão deixou de fora — dito em voz alta no recibo. */
  dropped: string[]
  /** Veio do git (sem `files`) ou foi pedido explicitamente. */
  fromGit: boolean
  /** Havia mais arquivos do que o teto por chamada. */
  overflow: number
}

/**
 * Quais arquivos olhar. Sem `files`, os MODIFICADOS da raiz — a mesma fonte que
 * o trilho de diff do dono usa. Devolve STRING quando não há o que fazer: e
 * toda string dessas nomeia a receita.
 */
async function pickFiles(
  deps: GuiLspToolsDeps,
  root: string,
  files: string[] | undefined
): Promise<PickedFiles | string> {
  const fromGit = files === undefined || files.length === 0
  let candidates: string[]
  if (!fromGit) {
    candidates = (files ?? []).map((file) => file.trim()).filter((file) => file.length > 0)
    if (candidates.length === 0) {
      return `a lista de arquivos veio vazia — informe caminhos relativos a ${root}, ou chame sem \`files\` para eu olhar o que você modificou.`
    }
  } else {
    if (!deps.changedFiles) {
      return `não sei quais arquivos você modificou nesta raiz — chame de novo com \`files\`, informando os caminhos relativos a ${root}.`
    }
    candidates = await deps.changedFiles(root)
    if (candidates.length === 0) {
      return `nenhum arquivo modificado em ${root} — não há o que diagnosticar. Para olhar um arquivo específico mesmo assim, chame de novo com \`files\`.`
    }
  }

  const targets = candidates.filter(supported)
  const dropped = candidates.filter((file) => !supported(file))
  if (targets.length === 0) {
    return `nenhum dos ${candidates.length} arquivo(s) é de código que o servidor de linguagem fala (ele lê ${lspExtensionsLabel()}): ${nameList(dropped)}. Aponte um arquivo desses em \`files\` e eu olho.`
  }
  const overflow = Math.max(0, targets.length - LSP_DIAGNOSTICS_FILES_MAX)
  return { targets: targets.slice(0, LSP_DIAGNOSTICS_FILES_MAX), dropped, fromGit, overflow }
}

function diagnosticsReceipt(
  root: string,
  picked: PickedFiles,
  problems: LspDiagnostic[]
): string {
  const lines: string[] = []
  const scope = picked.fromGit
    ? `${picked.targets.length} arquivo(s) MODIFICADO(S) de ${root}`
    : `${picked.targets.length} arquivo(s) de ${root}`
  if (problems.length === 0) {
    lines.push(`nenhum problema em ${scope}: ${nameList(picked.targets)}.`)
  } else {
    const distinct = new Set(problems.map((problem) => problem.file)).size
    lines.push(`${problems.length} problema(s) em ${distinct} de ${scope} (lidos do disco agora):`)
    for (const problem of problems.slice(0, LSP_DIAGNOSTICS_ITEM_CAP)) {
      lines.push(diagnosticLine(problem))
    }
    if (problems.length > LSP_DIAGNOSTICS_ITEM_CAP) {
      lines.push(
        `… mostrei ${LSP_DIAGNOSTICS_ITEM_CAP} de ${problems.length} (teto de ${LSP_DIAGNOSTICS_ITEM_CAP} problemas por chamada) — conserte estes e chame de novo para ver o resto.`
      )
    }
  }
  if (picked.overflow > 0) {
    lines.push(
      `${picked.overflow} arquivo(s) ficaram para a próxima: o teto é de ${LSP_DIAGNOSTICS_FILES_MAX} por chamada — chame de novo com \`files\` para os que faltam.`
    )
  }
  if (picked.dropped.length > 0) {
    lines.push(
      `${picked.dropped.length} arquivo(s) ficaram de fora porque o servidor de linguagem não os fala (ele lê ${lspExtensionsLabel()}): ${nameList(picked.dropped)}.`
    )
  }
  return lines.join('\n')
}

function locationsReceipt(
  answer: LspAnswer<LspLocation[]>,
  singular: string,
  plural: string,
  file: string,
  line: number,
  column: number
): string {
  // O motivo do motor JÁ traz a receita (arquivo inexistente, caminho fora da
  // raiz): reescrevê-lo aqui só perderia o comando que destrava.
  if (!answer.ok) return answer.reason
  const found = answer.value
  if (found.length === 0) {
    return `nenhuma ${singular} para ${file}:${line}:${column} — confira se a linha e a coluna caem em cima do NOME do símbolo (as posições são 1-based: a primeira linha é 1, a primeira coluna é 1) e chame de novo.`
  }
  const lines = [
    `${found.length} ${found.length === 1 ? singular : plural} de ${file}:${line}:${column}:`,
    ...found.slice(0, LSP_LOCATIONS_ITEM_CAP).map(locationLine)
  ]
  if (found.length > LSP_LOCATIONS_ITEM_CAP) {
    lines.push(
      `… mostrei ${LSP_LOCATIONS_ITEM_CAP} de ${found.length} (teto de ${LSP_LOCATIONS_ITEM_CAP} por chamada).`
    )
  }
  return lines.join('\n')
}

function hoverReceipt(
  answer: LspAnswer<LspHover | null>,
  file: string,
  line: number,
  column: number
): string {
  if (!answer.ok) return answer.reason
  const hover = answer.value
  if (!hover) {
    return `o servidor não tem nada a dizer sobre ${file}:${line}:${column} — confira se a posição cai em cima do NOME do símbolo (as posições são 1-based) e chame de novo.`
  }
  return `${hover.file}:${hover.line}:${hover.column} — ${truncate(hover.text, LSP_HOVER_MAX_CHARS)}`
}
