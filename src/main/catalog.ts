import { execFile, spawn } from 'child_process'
import { freshWindowsPath } from './winPath'

export interface CatalogModel {
  id: string
  label: string
  efforts?: string[]
  defaultEffort?: string
}

export interface Catalog {
  models: CatalogModel[]
  efforts: string[]
}

const CLAUDE_FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const CLAUDE_MODELS: CatalogModel[] = [
  { id: 'fable', label: 'fable — Claude Fable 5 (máximo, 1M ctx)' },
  { id: 'opus', label: 'opus — Claude Opus 4.8' },
  { id: 'sonnet', label: 'sonnet — Claude Sonnet 5' },
  { id: 'haiku', label: 'haiku — Claude Haiku 4.5 (leve)' }
]

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
              response?: {
                models?: {
                  value?: string
                  displayName?: string
                  description?: string
                  supportedEffortLevels?: string[]
                  supportsEffort?: boolean
                }[]
              }
            }
          }
          if (evt.type === 'control_response' && evt.response?.request_id === 'catalog-init') {
            const models = (evt.response.response?.models ?? [])
              .filter((m) => m.value)
              .map((m) => ({
                id: m.value as string,
                label: m.description
                  ? `${m.displayName ?? m.value} — ${m.description.length > 52 ? m.description.slice(0, 52) + '…' : m.description}`
                  : (m.displayName ?? (m.value as string)),
                efforts: m.supportsEffort === false ? [] : m.supportedEffortLevels
              }))
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
    models: models ?? CLAUDE_MODELS,
    efforts: fromModels.length >= 3 ? fromModels : efforts
  }
}

// Catálogo REAL do Codex: `codex debug models` despeja o catálogo em JSON,
// com reasoning levels suportados por modelo.
async function codexCatalog(configDir?: string): Promise<Catalog> {
  try {
    const raw = await run('codex', ['debug', 'models'], baseEnv(configDir, 'codex'))
    const parsed = JSON.parse(raw) as {
      models?: {
        slug?: string
        display_name?: string
        visibility?: string
        default_reasoning_level?: string
        supported_reasoning_levels?: { effort?: string }[]
      }[]
    }
    const models: CatalogModel[] = (parsed.models ?? [])
      .filter((m) => m.slug && m.visibility === 'list')
      .map((m) => ({
        id: m.slug as string,
        label: m.display_name ?? (m.slug as string),
        efforts: (m.supported_reasoning_levels ?? [])
          .map((l) => l.effort)
          .filter((e): e is string => Boolean(e)),
        defaultEffort: m.default_reasoning_level
      }))
    const efforts = [...new Set(models.flatMap((m) => m.efforts ?? []))]
    if (models.length > 0) {
      return { models, efforts: efforts.length ? efforts : ['low', 'medium', 'high'] }
    }
  } catch {
    // codex indisponível — fallback mínimo
  }
  return {
    models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' }],
    efforts: ['minimal', 'low', 'medium', 'high']
  }
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
