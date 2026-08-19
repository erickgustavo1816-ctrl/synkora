import { execFile, spawn } from 'child_process'
import { freshWindowsPath } from './winPath'

export interface CatalogModel {
  id: string
  label: string
  efforts?: string[]
  defaultEffort?: string
  /** R13: o modelo aceita o modo fast. Os dois CLIs publicam o sinal com nomes
   *  diferentes (claude: `supportsFastMode` no handshake; codex: o service tier
   *  `priority`) e o catálogo uniformiza na MESMA chave que as caps do pane
   *  usam — `CliModel` em `maestroSession.ts`, `caps.models` em
   *  `codexSession.ts`. AUSENTE = ninguém respondeu (fallback curado): sem
   *  resposta o painel não oferece um modo que gasta mais limite. */
  supportsFastMode?: boolean
}

export interface Catalog {
  models: CatalogModel[]
  efforts: string[]
}

const CLAUDE_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// Fallback só entra quando o handshake não responde. Sem NÚMERO DE VERSÃO nos
// rótulos de propósito: os aliases apontam sempre para o modelo mais novo da
// linha, e rótulo datado aqui envelhece e mente (era "Opus 4.8" com o Opus 5
// já lançado). E sem `supportsFastMode`: lista curada à mão é chute, e chute
// não liga modo caro.
export const CLAUDE_FALLBACK_MODELS: CatalogModel[] = [
  { id: 'fable', label: 'fable — o mais capaz (tarefas longas e difíceis)' },
  { id: 'opus[1m]', label: 'opus — equilíbrio do dia a dia (1M ctx)' },
  { id: 'sonnet', label: 'sonnet — eficiente para tarefas de rotina' },
  { id: 'haiku', label: 'haiku — o mais rápido (respostas curtas)' }
]

/** Mínimo do codex quando o `debug models` não responde — sem a marca de fast
 *  pela mesma razão do fallback do claude. */
export const CODEX_FALLBACK_MODELS: CatalogModel[] = [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }]

const cache = new Map<string, Promise<Catalog>>()

function run(cmd: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env, shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout))
    )
  })
}

function baseEnv(configDir?: string, cli?: 'claude' | 'codex'): Record<string, string> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: freshWindowsPath()
  }
  if (configDir && cli === 'codex') env['CODEX_HOME'] = configDir
  if (configDir && cli === 'claude') env['CLAUDE_CONFIG_DIR'] = configDir
  return env
}

/** O modelo como o handshake `initialize` do claude o publica — espelho
 *  estreito de `CliModel`, em `src/main/maestroSession.ts`, que lê o MESMO
 *  payload para as caps do pane. */
export interface ClaudeHandshakeModel {
  value?: string
  displayName?: string
  description?: string
  supportedEffortLevels?: string[]
  supportsEffort?: boolean
  supportsFastMode?: boolean
}

/**
 * A tradução do handshake para o catálogo. Pura de propósito: é a régua provada
 * em node puro (`scripts/test-gui-delegation-defaults.mjs`), longe do processo
 * filho que a alimenta.
 *
 * `supportsFastMode` só vira `true` com a AFIRMAÇÃO do CLI (sonda de 2026-08-19:
 * `default` e `opus[1m]` trazem a marca; fable, sonnet e haiku não trazem campo
 * nenhum). O `false` daqui é resposta — "este modelo não tem fast" —, diferente
 * do campo ausente do fallback, que é silêncio.
 */
export function claudeModelsFromHandshake(
  models: readonly ClaudeHandshakeModel[]
): CatalogModel[] {
  return models
    .filter((m) => m.value)
    .map((m) => ({
      id: m.value as string,
      label: m.description
        ? `${m.displayName ?? m.value} — ${m.description.length > 52 ? m.description.slice(0, 52) + '…' : m.description}`
        : (m.displayName ?? (m.value as string)),
      efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels,
      supportsFastMode: m.supportsFastMode === true
    }))
}

// Lista REAL de modelos do Claude: handshake initialize do stream-json (a
// mesma fonte do seletor /model do TUI), com o config do seat. Não gasta
// tokens — o processo morre assim que a resposta chega.
function claudeHandshakeModels(configDir?: string): Promise<CatalogModel[] | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value: CatalogModel[] | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // já morreu
      }
      resolve(value)
    }
    const child = spawn(
      'claude',
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { env: baseEnv(configDir, 'claude'), shell: process.platform === 'win32' }
    )
    const timer = setTimeout(() => finish(null), 15_000)
    child.on('error', () => finish(null))
    child.on('close', () => finish(null))
    child.stdin.write(
      JSON.stringify({
        type: 'control_request',
        request_id: 'catalog-init',
        request: { subtype: 'initialize' }
      }) + '\n'
    )
    let buf = ''
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const evt = JSON.parse(line) as {
            type?: string
            response?: {
              request_id?: string
              response?: { models?: ClaudeHandshakeModel[] }
            }
          }
          if (evt.type === 'control_response' && evt.response?.request_id === 'catalog-init') {
            const models = claudeModelsFromHandshake(evt.response.response?.models ?? [])
            finish(models.length > 0 ? models : null)
            return
          }
        } catch {
          // linha parcial
        }
      }
    })
  })
}

async function claudeCatalog(configDir?: string): Promise<Catalog> {
  const [models, help] = await Promise.all([
    claudeHandshakeModels(configDir),
    run('claude', ['--help'], baseEnv(configDir, 'claude')).catch(() => '')
  ])
  let efforts = CLAUDE_FALLBACK_EFFORTS
  const match = help.match(/--effort <level>[\s\S]{0,200}?\(([a-z,\s]+)\)/)
  if (match) {
    const parsed = match[1].split(',').map((s) => s.trim()).filter(Boolean)
    if (parsed.length >= 3) efforts = parsed
  }
  const fromModels = [...new Set((models ?? []).flatMap((m) => m.efforts ?? []))]
  return {
    models: models ?? CLAUDE_FALLBACK_MODELS,
    efforts: fromModels.length >= 3 ? fromModels : efforts
  }
}

/** O modelo como `codex debug models` o despeja: snake_case do CLI, e não o
 *  camelCase do app-server que `src/main/codexSession.ts` lê. */
export interface CodexDebugModel {
  slug?: string
  display_name?: string
  visibility?: string
  default_reasoning_level?: string
  supported_reasoning_levels?: { effort?: string }[]
  /** Os planos de atendimento do modelo — `priority` É o fast do codex (sonda
   *  de 2026-08-19 no binário: gpt-5.6-sol traz `[{id:'priority',name:'Fast'}]`,
   *  o mesmo sinal que o app-server publica como `serviceTiers`). */
  service_tiers?: { id?: string }[]
}

/** A tradução do `debug models` para o catálogo — pura pelo mesmo motivo da
 *  irmã do claude. Modelo invisível na lista do CLI não entra. */
export function codexModelsFromDebug(models: readonly CodexDebugModel[]): CatalogModel[] {
  return models
    .filter((m) => m.slug && m.visibility === 'list')
    .map((m) => ({
      id: m.slug as string,
      label: m.display_name ?? (m.slug as string),
      efforts: (m.supported_reasoning_levels ?? [])
        .map((l) => l.effort)
        .filter((e): e is string => Boolean(e)),
      defaultEffort: m.default_reasoning_level,
      supportsFastMode: (m.service_tiers ?? []).some((tier) => tier?.id === 'priority')
    }))
}

// Catálogo REAL do Codex: `codex debug models` despeja o catálogo em JSON,
// com reasoning levels suportados por modelo.
async function codexCatalog(configDir?: string): Promise<Catalog> {
  try {
    const raw = await run('codex', ['debug', 'models'], baseEnv(configDir, 'codex'))
    const parsed = JSON.parse(raw) as { models?: CodexDebugModel[] }
    const models = codexModelsFromDebug(parsed.models ?? [])
    const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))]
    if (models.length > 0) {
      return { models, efforts: efforts.length ? efforts : ['low', 'medium', 'high'] }
    }
  } catch {
    // codex indisponível — fallback mínimo
  }
  return { models: CODEX_FALLBACK_MODELS, efforts: ['minimal', 'low', 'medium', 'high'] }
}

/** Esquece as listas já consultadas — o próximo `getCatalog` pergunta ao CLI
 *  de novo. Chamado depois de todo update de CLI: modelo novo (ex.: Opus 5)
 *  só existe no handshake da versão nova, e o cache é eterno por processo. */
export function clearCatalogCache(): void {
  cache.clear()
}

export function getCatalog(cli: 'claude' | 'codex', configDir?: string): Promise<Catalog> {
  const key = `${cli}:${configDir ?? ''}`
  let promise = cache.get(key)
  if (!promise) {
    promise = cli === 'claude' ? claudeCatalog(configDir) : codexCatalog(configDir)
    cache.set(key, promise)
    // Falhou? Não envenena o cache para sempre.
    promise.catch(() => cache.delete(key))
  }
  return promise
}
