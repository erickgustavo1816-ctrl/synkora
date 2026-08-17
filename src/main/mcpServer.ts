import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpRequestContext
} from '@modelcontextprotocol/server'
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler
} from '@modelcontextprotocol/node'
import { z } from 'zod'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import type { Hub, PaneIdentity } from './hub'
import type { PlanPatch } from './plans'

const requireFromMain = createRequire(
  typeof __filename === 'string' ? __filename : join(process.cwd(), 'package.json')
)

// Servidor MCP local do Synkora: é por AQUI que o CHAT DE PLANEJAMENTO fala com
// o app. Cada pane com identidade nasce com um bearer token próprio; o token
// identifica QUEM chama (hoje: só a role `gui-planner`, de qual projeto/missão/
// worktree) e as ferramentas agem no contexto certo. HTTP em 127.0.0.1, porta
// aleatória.
//
// O catálogo é ÚNICO e fechado (ver `buildServer`): identidade que não seja o
// planejador recebe um servidor VAZIO — nunca um erro. O antigo catálogo por
// papel (maestro/dev/review/qa/ajudante) morreu com a era F6.

/** Implementada em index.ts — as tools delegam para o harness real. */
export interface McpApi {
  hub: Hub
  // ——— kit do CHAT de planejamento (2.0, onda D — role 'gui-planner') ———
  // É o catálogo INTEIRO: nenhuma outra identidade recebe ferramenta nenhuma.
  /** Todos os planos do universo com o progresso derivado das missões. */
  listPlans: (id: PaneIdentity) => string
  /** Um plano inteiro, com o `updatedAt` que o CAS do update exige. */
  getPlan: (id: PaneIdentity, planId: string) => string
  /** APRESENTA um plano novo ao dono no chat. NUNCA cria — o clique cria. */
  proposePlan: (id: PaneIdentity, draft: unknown) => string
  /** Edita um plano existente (execução direta; CAS por updatedAt). */
  updatePlan: (
    id: PaneIdentity,
    planId: string,
    patch: PlanPatch,
    expectedUpdatedAt?: string
  ) => string
  /** Arquiva (soft) um plano. Exclusão definitiva é gesto do dono no mapa. */
  deletePlan: (id: PaneIdentity, planId: string, expectedUpdatedAt?: string) => string
  /** instrumentação CHECK 14: o app registra qual catálogo cada identidade
   *  recebeu (dedupe por pane no app — mudança de catálogo é o alarme) */
  noteCatalogServed?: (id: PaneIdentity, tools: string[]) => void
}

function text(s: string): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: s }] }
}

function buildServer(api: McpApi, identity: PaneIdentity): McpServer {
  // SEM cacheHints de tools/list (CHECK 14, 2026-08-07): o hint de cache da
  // spec 2026-07-28 estava anunciado sem nenhum cliente validado usando — e
  // no mistério "runtime_control sumiu SÓ em pane resumado" um cliente
  // recém-atualizado honrando TTL de catálogo é gatilho plausível. Custo de
  // remover: um tools/list por boot de pane. Só re-anunciar com sonda.
  const server = new McpServer({ name: 'synkora', version: '1.0.0' })

  // INSTRUMENTAÇÃO DO CATÁLOGO (CHECK 14): coleciona os nomes registrados
  // NESTA construção e avisa o app (dedupe por pane lá) — a caixa-preta
  // passa a registrar QUAL catálogo cada identidade recebeu; a próxima
  // anomalia de tool sumida se explica sozinha no journal.
  const servedTools: string[] = []
  const originalRegisterTool = server.registerTool.bind(server)
  server.registerTool = ((name: string, ...rest: unknown[]) => {
    servedTools.push(name)
    return (originalRegisterTool as (...args: unknown[]) => unknown)(name, ...rest)
  }) as typeof server.registerTool
  const finishCatalog = (): McpServer => {
    api.noteCatalogServed?.(identity, servedTools)
    return server
  }

  // ————— CHAT DE PLANEJAMENTO (2.0, onda D) — catálogo PRÓPRIO e FECHADO —————
  //
  // O pane GUI de planejamento é o primeiro chat da era 2.0 com ferramentas
  // Synkora, e ele recebe SÓ o kit de planos. O retorno antecipado é a cerca:
  // as tools abaixo são registradas dentro deste bloco, então nenhum outro
  // papel — inclusive os gates read-only — pode enxergá-las, e este papel não
  // enxerga uma linha do catálogo legado.
  if (identity.role === 'gui-planner') {
    server.registerTool(
      'list_plans',
      {
        description:
          'Os planos deste universo, com o progresso real de cada missão vinculada. Chame antes de propor qualquer coisa: propor de novo o que já está planejado é retrabalho.'
      },
      async () => text(api.listPlans(identity))
    )

    server.registerTool(
      'get_plan',
      {
        description:
          'Um plano inteiro: descrição, missões, objetivo/critérios/tier/contexto de cada uma e o updatedAt que o update_plan exige.',
        inputSchema: {
          planId: z.string().min(1).max(120).describe('id do plano (vem do list_plans)')
        }
      },
      async ({ planId }) => text(api.getPlan(identity, planId))
    )

    server.registerTool(
      'propose_plan',
      {
        description:
          'APRESENTA um plano novo ao dono, como card dentro desta conversa. NUNCA cria nada: quem cria é o clique dele. Chame só depois que ele concordar com o recorte em palavras — e então ENCERRE o turno e espere. Silêncio não é consentimento. Cada item é UMA missão entregável; os campos espelham as seções que você já escreve em plano/NNN-slug.md.',
        inputSchema: {
          title: z.string().min(1).max(120).describe('nome do plano, em PT-BR'),
          description: z
            .string()
            .max(4_000)
            .optional()
            .describe('o recorte em prosa que o dono julga sem ler código'),
          kind: z
            .enum(['mestre', 'livre'])
            .optional()
            .describe(
              "'mestre' = o plano de fundo do universo (só UM ativo); 'livre' (padrão) = um recorte que atravessa versões"
            ),
          items: z
            .array(
              z.object({
                key: z
                  .string()
                  .max(60)
                  .optional()
                  .describe('apelido curto desta missão, usado por outras em dependsOn'),
                title: z.string().min(1).max(120).describe('UMA entrega — título com "e" são duas missões'),
                objective: z.string().min(1).max(2_000).describe('seção Objetivo'),
                outOfScope: z.string().max(2_000).optional().describe('seção Fora de escopo'),
                doneCriteria: z
                  .array(z.string().max(400))
                  .max(10)
                  .optional()
                  .describe('seção Critério de pronto: binário e observável, nunca "ficou bom"'),
                tier: z.enum(['pequeno', 'medio', 'grande']).optional().describe('seção Tier'),
                context: z.string().max(2_000).optional().describe('seção Contexto'),
                dependsOn: z
                  .array(z.string().max(60))
                  .max(12)
                  .optional()
                  .describe('keys de missões ANTERIORES desta mesma lista'),
                docPath: z
                  .string()
                  .max(240)
                  .optional()
                  .describe("brief em prosa no repo, ex.: 'plano/003-fila.md'")
              })
            )
            .min(1)
            .max(24)
        }
      },
      async (draft) => text(api.proposePlan(identity, draft))
    )

    server.registerTool(
      'update_plan',
      {
        description:
          'Edita um plano que JÁ existe — isto executa na hora (editar é reversível). Mande o updatedAt que veio do get_plan: se o plano mudou nesse meio-tempo, a alteração é recusada em vez de sobrescrever o que o dono viu. O estado "concluida" e o vínculo com a missão são derivados da missão real e não se escrevem aqui. A designação de plano mestre não passa por aqui — ela é um gesto do dono no mapa.',
        inputSchema: {
          planId: z.string().min(1).max(120),
          expectedUpdatedAt: z
            .string()
            .max(64)
            .optional()
            .describe('o updatedAt lido no get_plan'),
          title: z.string().min(1).max(120).optional(),
          description: z.string().max(4_000).nullable().optional(),
          status: z.enum(['ativo', 'concluido', 'arquivado']).optional(),
          items: z
            .array(
              z.object({
                id: z.string().min(1).max(120).describe('id do item (vem do get_plan)'),
                title: z.string().min(1).max(120).optional(),
                objective: z.string().min(1).max(2_000).optional(),
                outOfScope: z.string().max(2_000).nullable().optional(),
                doneCriteria: z.array(z.string().max(400)).max(10).optional(),
                tier: z.enum(['pequeno', 'medio', 'grande']).nullable().optional(),
                context: z.string().max(2_000).nullable().optional(),
                dependsOn: z.array(z.string().max(120)).max(12).optional(),
                docPath: z.string().max(240).nullable().optional(),
                status: z
                  .enum(['planejada', 'em_andamento', 'descartada'])
                  .optional()
                  .describe('"concluida" não entra: ela vem da missão vinculada')
              })
            )
            .max(24)
            .optional(),
          addItems: z
            .array(
              z.object({
                key: z.string().max(60),
                title: z.string().min(1).max(120),
                objective: z.string().min(1).max(2_000),
                outOfScope: z.string().max(2_000).optional(),
                doneCriteria: z.array(z.string().max(400)).max(10),
                tier: z.enum(['pequeno', 'medio', 'grande']).optional(),
                context: z.string().max(2_000).optional(),
                dependsOn: z.array(z.string().max(120)).max(12),
                docPath: z.string().max(240).optional()
              })
            )
            .max(24)
            .optional(),
          removeItemIds: z
            .array(z.string().max(120))
            .max(24)
            .optional()
            .describe('item que já virou missão não sai: marque status descartada')
        }
      },
      async ({ planId, expectedUpdatedAt, ...patch }) =>
        text(api.updatePlan(identity, planId, patch as PlanPatch, expectedUpdatedAt))
    )

    server.registerTool(
      'delete_plan',
      {
        description:
          'ARQUIVA um plano (reversível): a aba some do mapa e o conteúdo fica. Exclusão definitiva não existe por ferramenta — é gesto do dono no mapa.',
        inputSchema: {
          planId: z.string().min(1).max(120),
          expectedUpdatedAt: z.string().max(64).optional()
        }
      },
      async ({ planId, expectedUpdatedAt }) =>
        text(api.deletePlan(identity, planId, expectedUpdatedAt))
    )

    return finishCatalog()
  }

  // Qualquer OUTRA identidade recebe este servidor com catálogo VAZIO — não
  // um erro: o pane continua conversando, sem ferramenta nenhuma. Era a
  // resposta honesta para um papel que não existe mais (a era F6 registrava
  // aqui os catálogos de maestro/dev/review/qa/ajudante).
  return finishCatalog()
}

export interface McpServerHandle {
  port: number
  close: () => Promise<void>
}

type AuthenticatedIncomingMessage = IncomingMessage & { auth?: AuthInfo }

function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null
  const token = header.slice(7).trim()
  return token && !/\s/u.test(token) ? token : null
}

function isMcpPath(url: string | undefined): boolean {
  if (!url) return false
  try {
    return new URL(url, 'http://127.0.0.1').pathname === '/mcp'
  } catch {
    return false
  }
}


function identityForRequest(api: McpApi, context: McpRequestContext): PaneIdentity {
  const authInfo = context.authInfo
  const identity = authInfo ? api.hub.identityByToken(authInfo.token) : undefined
  if (!identity || identity.paneId !== authInfo?.clientId) {
    throw new Error('authenticated Synkora pane is unavailable')
  }
  return identity
}

/** Sobe o servidor MCP dual-era, stateless por request. */
export function startMcpServer(api: McpApi, preferredPort = 0): Promise<McpServerHandle> {
  const validateHost = localhostHostValidation()
  const validateOrigin = localhostOriginValidation()
  const mcpHandler = createMcpHandler(
    (context) => buildServer(api, identityForRequest(api, context)),
    {
      legacy: 'stateless',
      responseMode: 'auto',
      onerror: () => console.warn('[mcp] request failed')
    }
  )
  const nodeHandler = toNodeHandler(mcpHandler, {
    onerror: () => console.warn('[mcp] HTTP adapter failed')
  })
  const httpServer = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end()
      else if (!res.writableEnded) res.end()
    })
  })

  // Caminho ÚNICO: POST /mcp autenticado por bearer. O antigo GET /mail-wait
  // (o waiter de background do correio F6) morreu com o correio.
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return
    if (!isMcpPath(req.url)) {
      res.writeHead(404).end()
      return
    }
    const token = bearerToken(req.headers.authorization)
    const identity = token ? api.hub.identityByToken(token) : undefined
    if (!token || !identity) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'token do Synkora inválido ou pane encerrado' },
          id: null
        })
      )
      return
    }

    const authenticatedRequest = req as AuthenticatedIncomingMessage
    authenticatedRequest.auth = {
      token,
      clientId: identity.paneId,
      scopes: ['synkora:pane'],
      // A factory ignora o snapshot e revalida o token diretamente no Hub.
      extra: { identity }
    } satisfies AuthInfo
    await nodeHandler(authenticatedRequest, res)
  }

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(preferredPort, '127.0.0.1', () => {
      const addr = httpServer.address()
      if (!addr || typeof addr !== 'object') {
        void mcpHandler.close()
        reject(new Error('porta do MCP indisponível'))
        return
      }

      let closePromise: Promise<void> | null = null
      resolve({
        port: addr.port,
        close: () => {
          if (closePromise) return closePromise
          const closeHttp = new Promise<void>((resolveClose, rejectClose) => {
            httpServer.close((error) => {
              if (error) rejectClose(error)
              else resolveClose()
            })
          })
          closePromise = Promise.all([closeHttp, mcpHandler.close()]).then(() => undefined)
          return closePromise
        }
      })
    })
  })
}

// ————— injeção da config MCP por CLI —————

export interface McpStdioLaunch {
  command: string
  args: string[]
  env?: Record<string, string>
  version?: string
}

/** Resolve o MCP de browser empacotado pelo Synkora. Nunca consulta registry.
 *  Ausência degrada para pane sem esse servidor; não impede o terminal. */
export function resolveBundledPlaywrightMcp(): McpStdioLaunch | undefined {
  try {
    const packageFile = requireFromMain.resolve('@playwright/mcp/package.json')
    const manifest = JSON.parse(readFileSync(packageFile, 'utf-8')) as {
      name?: string
      version?: string
      bin?: Record<string, string> | string
    }
    if (manifest.name !== '@playwright/mcp') return undefined
    const bin =
      typeof manifest.bin === 'string'
        ? manifest.bin
        : manifest.bin?.['playwright-mcp'] ?? 'cli.js'
    const cli = unpackedRuntimePath(join(dirname(packageFile), bin))
    if (!existsSync(cli)) return undefined
    return electronNodeLaunch(cli, [], manifest.version)
  } catch {
    return undefined
  }
}

/** Resolve SOMENTE uma dependência declarada e instalada pela worktree. O
 *  caminho direto impede subir para o Playwright transitivo do Synkora; no
 *  layout pnpm, a resolução parte do @playwright/test já validado. Nunca
 *  executa gerenciador de pacotes. */
export function resolveProjectPlaywrightTest(cwd: string | undefined): McpStdioLaunch | undefined {
  if (!cwd) return undefined
  try {
    const root = realpathSync.native(cwd)
    const packageFile = join(root, 'package.json')
    if (!existsSync(packageFile)) return undefined
    const project = JSON.parse(readFileSync(packageFile, 'utf-8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    const all = { ...project.dependencies, ...project.devDependencies, ...project.optionalDependencies }
    const declaresTest = Boolean(all['@playwright/test'])
    const declaresPlaywright = Boolean(all.playwright)
    if (!declaresTest && !declaresPlaywright) return undefined

    let cli: string | undefined
    let version: string | undefined
    let playwrightPackageFile: string
    if (declaresTest) {
      const logicalTestPackageFile = join(root, 'node_modules', '@playwright', 'test', 'package.json')
      if (!existsSync(logicalTestPackageFile)) return undefined
      const testPackageFile = realpathSync.native(logicalTestPackageFile)
      if (!pathInside(root, testPackageFile)) return undefined
      const testManifest = JSON.parse(readFileSync(testPackageFile, 'utf-8')) as {
        name?: string
        version?: string
        bin?: Record<string, string> | string
      }
      if (testManifest.name !== '@playwright/test') return undefined
      const testBin =
        typeof testManifest.bin === 'string'
          ? testManifest.bin
          : testManifest.bin?.playwright ?? 'cli.js'
      const logicalCli = join(dirname(testPackageFile), testBin)
      if (!existsSync(logicalCli)) return undefined
      cli = realpathSync.native(logicalCli)
      if (!pathInside(root, cli)) return undefined
      // Parte do layout pnpm pode não publicar root/node_modules/playwright.
      // Resolver a partir do pacote explicitamente instalado encontra apenas a
      // dependência dele, inclusive no store do gerenciador.
      playwrightPackageFile = realpathSync.native(
        createRequire(testPackageFile).resolve('playwright/package.json')
      )
      if (!pathInside(root, playwrightPackageFile)) return undefined
      version = testManifest.version
    } else {
      // Caminho lógico direto: não sobe para o Playwright transitivo do app.
      const logicalPlaywrightPackageFile = join(root, 'node_modules', 'playwright', 'package.json')
      if (!existsSync(logicalPlaywrightPackageFile)) return undefined
      playwrightPackageFile = realpathSync.native(logicalPlaywrightPackageFile)
      if (!pathInside(root, playwrightPackageFile)) return undefined
    }
    const manifest = JSON.parse(readFileSync(playwrightPackageFile, 'utf-8')) as {
      name?: string
      version?: string
      bin?: Record<string, string> | string
    }
    if (manifest.name !== 'playwright') return undefined
    if (!declaresTest) {
      const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.playwright ?? 'cli.js'
      const logicalCli = join(dirname(playwrightPackageFile), bin)
      if (!existsSync(logicalCli)) return undefined
      cli = realpathSync.native(logicalCli)
      if (!pathInside(root, cli)) return undefined
      version = manifest.version
    }
    const logicalProgram = join(dirname(playwrightPackageFile), 'lib', 'program.js')
    if (!existsSync(logicalProgram)) return undefined
    const program = realpathSync.native(logicalProgram)
    if (!pathInside(root, program)) return undefined
    if (!readFileSync(program, 'utf-8').includes('run-test-mcp-server')) return undefined
    if (!cli) return undefined
    return electronNodeLaunch(cli, ['run-test-mcp-server'], version ?? manifest.version)
  } catch {
    return undefined
  }
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function electronNodeLaunch(entrypoint: string, args: string[], version?: string): McpStdioLaunch {
  return {
    command: process.execPath,
    args: [entrypoint, ...args],
    ...(process.versions.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
    ...(version ? { version } : {})
  }
}

function unpackedRuntimePath(file: string): string {
  const marker = `${sep}app.asar${sep}`
  if (!file.includes(marker)) return file
  const unpacked = file.replace(marker, `${sep}app.asar.unpacked${sep}`)
  return existsSync(unpacked) ? unpacked : file
}

function stdioConfig(launch: McpStdioLaunch): Record<string, unknown> {
  return {
    command: launch.command,
    args: launch.args,
    ...(launch.env ? { env: launch.env } : {})
  }
}

/** claude: config JSON por pane (arquivo evita o inferno de quoting no shell). */
export function writeClaudeMcpConfig(
  baseDir: string,
  paneId: string,
  port: number,
  token: string,
  /** Browser independente de conta, resolvido da dependência fixada do app. */
  browser?: McpStdioLaunch,
  /** Test runner da worktree; ausente quando o projeto não o instalou. */
  testRunner?: McpStdioLaunch
): string {
  mkdirSync(baseDir, { recursive: true })
  // paneId vira nome de arquivo — sanitiza qualquer caractere proibido no
  // Windows (`:` etc.) para o write nunca derrubar o spawn do pane.
  const file = join(baseDir, `${paneId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  const servers: Record<string, unknown> = {
    synkora: {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${token}` }
    }
  }
  if (browser) servers['playwright'] = stdioConfig(browser)
  if (testRunner) servers['playwright-test'] = stdioConfig(testRunner)
  writeFileSync(file, JSON.stringify({ mcpServers: servers }), 'utf-8')
  return file
}

export function claudeMcpArgs(configFile: string, strict: boolean): string[] {
  const args = ['--mcp-config', configFile]
  if (strict) args.push('--strict-mcp-config')
  return args
}

/** Wrapper do Playwright MCP para o CODEX (sondado 2026-07-29): o array TOML
 *  `args=[…]` NÃO sobrevive à linha do PowerShell (as aspas internas caem e o
 *  codex vê string — "expected a sequence"); um .cmd de uma linha reduz a
 *  config a UMA string. Path com forward slashes: TOML basic string trata
 *  `\U` como escape unicode — barra normal é válida e o Windows aceita.
 *  Rust ≥1.77 (codex) spawna .cmd via cmd automaticamente. Validado:
 *  `codex -c mcp_servers.playwright.command="<path>" mcp list` → enabled. */
export function ensurePlaywrightCmd(baseDir: string, launch: McpStdioLaunch): string {
  return ensureMcpCmd(baseDir, 'playwright', launch)
}

/** Wrapper do MCP `playwright-test` para o CODEX. O target já foi resolvido e
 *  validado dentro da worktree; o wrapper nunca consulta npm nem o registry. */
export function ensurePlaywrightTestCmd(baseDir: string, launch: McpStdioLaunch): string {
  return ensureMcpCmd(baseDir, 'playwright-test', launch)
}

function ensureMcpCmd(baseDir: string, label: string, launch: McpStdioLaunch): string {
  const envEntries = Object.entries(launch.env ?? {}).sort(([a], [b]) => a.localeCompare(b))
  for (const [key, value] of envEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('nome de env inválido para wrapper MCP')
    if (/[\r\n"]/u.test(value)) throw new Error('valor de env inválido para wrapper MCP')
  }
  const values = [launch.command, ...launch.args]
  if (values.some((value) => /[\r\n"]/u.test(value))) throw new Error('caminho inválido para wrapper MCP')

  mkdirSync(baseDir, { recursive: true })
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([launch.command, launch.args, launch.env ?? {}]))
    .digest('hex')
    .slice(0, 12)
  const file = join(baseDir, `${label}-${fingerprint}.cmd`)
  const unicodeLaunch = [...values, ...envEntries.flat()].some((value) => /[^\x00-\x7f]/u.test(value))
  if (unicodeLaunch) {
    // cmd.exe interpreta .cmd pela code page OEM, então paths Unicode seriam
    // corrompidos. O batch permanece 100% ASCII e delega apenas esse caso raro
    // a um script PowerShell com BOM. `%~dp0` preserva o diretório Unicode sem
    // gravá-lo no arquivo, e -File repassa stdin/stdout/stderr e `%*`.
    const scriptName = `${label}-${fingerprint}.ps1`
    const scriptFile = join(baseDir, scriptName)
    const psLines = ["$ErrorActionPreference = 'Stop'"]
    for (const [key, value] of envEntries) {
      psLines.push(
        `[Environment]::SetEnvironmentVariable(${powershellLiteral(key)}, ${powershellLiteral(value)}, 'Process')`
      )
    }
    psLines.push(`$mcpCommand = ${powershellLiteral(launch.command)}`)
    psLines.push(`$fixedArgs = @(${launch.args.map(powershellLiteral).join(', ')})`)
    psLines.push('$allArgs = $fixedArgs + @($args)')
    psLines.push('& $mcpCommand @allArgs')
    psLines.push('exit $LASTEXITCODE')
    writeFileSync(scriptFile, `\ufeff${psLines.join('\r\n')}\r\n`, 'utf-8')

    const lines = [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0${scriptName}" %*`,
      'exit /b %errorlevel%'
    ]
    writeFileSync(file, `${lines.join('\r\n')}\r\n`, 'utf-8')
    return file.replace(/\\/g, '/')
  }

  const lines = ['@echo off', 'setlocal DisableDelayedExpansion']
  for (const [key, value] of envEntries) lines.push(`set "${key}=${value.replace(/%/g, '%%')}"`)
  lines.push(`${values.map((value) => `"${value.replace(/%/g, '%%')}"`).join(' ')} %*`)
  lines.push('exit /b %errorlevel%')
  writeFileSync(file, `${lines.join('\r\n')}\r\n`, 'utf-8')
  return file.replace(/\\/g, '/')
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** codex: override por linha de comando — não suja o config.toml do seat.
 *  O token vai pelo env SYNKORA_TOKEN (bearer_token_env_var). */
export function codexMcpArgs(
  port: number,
  browserCmd?: string,
  testRunnerCmd?: string,
  protocolArgs: readonly string[] = []
): string[] {
  const args = [
    ...protocolArgs,
    '-c',
    `mcp_servers.synkora.url="http://127.0.0.1:${port}/mcp"`,
    '-c',
    'mcp_servers.synkora.bearer_token_env_var="SYNKORA_TOKEN"',
    // "MCP startup interrupted" (visto em ajudante codex, 2026-07-29): o
    // timeout de startup default do codex é 10s — num localhost com o server
    // já de pé, estourar isso é o event loop do main ocupado na tempestade de
    // boot de panes, não rede. Folga tripla.
    '-c',
    'mcp_servers.synkora.startup_timeout_sec=30',
    // F5-F3: folga para o LONG-POLL do check_messages (o servidor segura a
    // resposta com a caixa vazia). Sonda W4 (2026-08-08) provou o knob no
    // codex 0.147; o default já aguentava 75s+ — isto é cinto, não cura.
    '-c',
    'mcp_servers.synkora.tool_timeout_sec=300'
  ]
  if (browserCmd) {
    // browser de teste também nos panes codex de execução (pedido do usuário:
    // "QA de codex não tá abrindo um chrome") — mesmo Playwright MCP do claude
    args.push('-c', `mcp_servers.playwright.command=${tomlLiteral(browserCmd)}`)
    args.push('-c', 'mcp_servers.playwright.startup_timeout_sec=60')
  }
  if (testRunnerCmd) {
    // Hífen é válido em bare keys TOML e preserva o nome/prefixo que os
    // agentes oficiais usam (`mcp__playwright-test__*`).
    args.push('-c', `mcp_servers.playwright-test.command=${tomlLiteral(testRunnerCmd)}`)
    args.push('-c', 'mcp_servers.playwright-test.startup_timeout_sec=60')
  }
  return args
}

/** Literal TOML sem aspas duplas quando possível. Isso evita a reinterpretação
 *  de `"` pelo PowerShell 5.1 em paths com espaço. O fallback codifica todos
 *  os code points, portanto também não contém whitespace para o quote nativo. */
function tomlLiteral(value: string): string {
  if (!/[\u0000-\u001f\u007f']/u.test(value)) return `'${value}'`
  const encoded = [...value]
    .map((char) => {
      const code = char.codePointAt(0)!
      return code <= 0xffff
        ? `\\u${code.toString(16).padStart(4, '0')}`
        : `\\U${code.toString(16).padStart(8, '0')}`
    })
    .join('')
  // O espaço TOML após `=` é intencional: faz o quote do PTY preservar
  // as aspas duplas no PowerShell 5.1. Sem ele o Codex receberia `\\u...`
  // literalmente em paths com apóstrofo.
  return ` "${encoded}"`
}
