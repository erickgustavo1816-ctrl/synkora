import { execFile } from 'child_process'
import { app } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { cliVersionDrift } from './cliVersionDrift'
import { freshWindowsPath } from './winPath'

/** CLIs que os panes executam — mantê-los atualizados é o que faz um modelo
 *  NOVO (ex.: Opus 5) aparecer no catálogo/seletor sem intervenção manual. */
export type CliName = 'claude' | 'codex'

export const CLIS: CliName[] = ['claude', 'codex']

export type CliState =
  /** ainda não checado nesta sessão */
  | 'unknown'
  /** rodando `<cli> update` agora */
  | 'updating'
  /** checado e já estava na última versão */
  | 'current'
  /** uma versão nova entrou (from → version): esta rodada a instalou, OU o
   *  vigia pós-boot viu o binário mudar por fora do app (2026-09-01) */
  | 'updated'
  /** CLI não encontrado no PATH */
  | 'missing'
  /** o update falhou (detail traz a última linha da saída) */
  | 'failed'

export interface CliStatus {
  cli: CliName
  /** versão em uso AGORA (null = CLI ausente) */
  version: string | null
  /** versão anterior — só quando esta rodada instalou algo */
  from?: string
  state: CliState
  /** última linha útil da saída do update (avisos do instalador) */
  detail?: string
  checkedAt: number
}

// Os CLIs se atualizam sozinhos por comando oficial (ambos validados em
// 2026-07-24): `claude update` (npm-global ou native, ele mesmo resolve) e
// `codex update` (baixa o instalador oficial em modo não-interativo).
const UPDATE_ARGS: Record<CliName, string[]> = { claude: ['update'], codex: ['update'] }
const VERSION_RE = /(\d+\.\d+\.\d+)/

const status = new Map<CliName, CliStatus>(
  CLIS.map((cli) => [cli, { cli, version: null, state: 'unknown', checkedAt: 0 }])
)
let listener: ((all: CliStatus[]) => void) | null = null
let running: Promise<CliStatus[]> | null = null

function env(): Record<string, string> {
  const e: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: freshWindowsPath()
  }
  // Mesmo motivo do pty.ts: herdar os marcadores de sessão-filha do Claude
  // Code faz o CLI filho rodar em modo degradado.
  for (const key of Object.keys(e)) if (key.startsWith('CLAUDE_CODE_')) delete e[key]
  delete e['CLAUDECODE']
  return e
}

function run(
  cli: CliName,
  args: string[],
  timeout: number
): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cli,
      args,
      {
        env: env(),
        shell: process.platform === 'win32',
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true
      },
      (err, stdout, stderr) =>
        resolve({ ok: !err, out: `${stdout ?? ''}\n${stderr ?? ''}`.trim() })
    )
  })
}

/** Última linha com conteúdo — os instaladores encerram com o veredito. Em
 *  FALHA, prefere a última linha de erro com conteúdo próprio: o instalador do
 *  codex ecoa o comando powershell inteiro na linha final ("Error: 'powershell
 *  -ExecutionPolicy Bypass…'") e o motivo real (rede, arquivo em uso) fica nas
 *  linhas anteriores — era esse eco que aparecia truncado na UI. */
function lastLine(out: string, failed = false): string | undefined {
  const lines = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return undefined
  if (failed) {
    const err = [...lines].reverse().find((l) => /error|fail/i.test(l) && !l.includes('install.ps1'))
    if (err) return err.slice(0, 200)
  }
  return lines[lines.length - 1].slice(0, 200)
}

/** Falha fica registrada POR INTEIRO em userData/cli-update.log — o `detail`
 *  da UI carrega uma linha só, e diagnosticar a próxima falha sem a saída
 *  completa é adivinhação. Nunca derruba a rodada. */
function logFailure(cli: CliName, attempt: number, out: string): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'cli-update.log'),
      `\n[${new Date().toISOString()}] ${cli} update falhou (tentativa ${attempt})\n${out.slice(-8000)}\n`
    )
  } catch {
    // log é diagnóstico, não funcionalidade
  }
}

function set(cli: CliName, patch: Partial<CliStatus>): CliStatus {
  const next: CliStatus = { ...(status.get(cli) as CliStatus), ...patch, cli }
  status.set(cli, next)
  listener?.(getCliStatus())
  return next
}

export function getCliStatus(): CliStatus[] {
  return CLIS.map((cli) => status.get(cli) as CliStatus)
}

export function onCliStatus(cb: ((all: CliStatus[]) => void) | null): void {
  listener = cb
}

export async function readVersion(cli: CliName): Promise<string | null> {
  const { out } = await run(cli, ['--version'], 25_000)
  return out.match(VERSION_RE)?.[1] ?? null
}

/** Checa a versão de um CLI e instala a mais nova se houver. Idempotente:
 *  o próprio comando do CLI não faz nada quando já está em dia. */
export async function updateCli(cli: CliName): Promise<CliStatus> {
  const from = await readVersion(cli)
  if (!from) {
    return set(cli, { version: null, from: undefined, state: 'missing', checkedAt: Date.now() })
  }
  set(cli, { version: from, from: undefined, state: 'updating', detail: undefined })
  let { ok, out } = await run(cli, UPDATE_ARGS[cli], 5 * 60_000)
  let to = (await readVersion(cli)) ?? from
  // Falha sem instalar nada é quase sempre transitória (rede no instante do
  // boot, binário momentaneamente em uso — caso real: codex 0.145→0.146 falhou
  // na rodada do boot e rodou limpo em seguida, 2026-07-29). UMA segunda
  // tentativa antes de acender "falhou" na UI.
  if (!ok && to === from) {
    logFailure(cli, 1, out)
    await new Promise((r) => setTimeout(r, 5_000))
    ;({ ok, out } = await run(cli, UPDATE_ARGS[cli], 5 * 60_000))
    to = (await readVersion(cli)) ?? from
    if (!ok && to === from) logFailure(cli, 2, out)
  }
  const failed = !ok && to === from
  return set(cli, {
    version: to,
    from: to !== from ? from : undefined,
    state: to !== from ? 'updated' : ok ? 'current' : 'failed',
    detail: lastLine(out, failed),
    checkedAt: Date.now()
  })
}

/** Roda o update dos dois CLIs em paralelo. Chamadas concorrentes compartilham
 *  a mesma rodada (o botão da UI não briga com a checagem do boot). */
export function updateAllClis(): Promise<CliStatus[]> {
  if (running) return running
  running = Promise.all(CLIS.map((cli) => updateCli(cli)))
    .then(() => getCliStatus())
    .finally(() => {
      running = null
    })
  return running
}

/** Uma rodada de update já está em andamento? */
export function isUpdatingClis(): boolean {
  return running !== null
}

export interface CliVersionWatch {
  /** Uma leitura AGORA (fora do relógio) — quem abre um pane chama. */
  check(): Promise<void>
  stop(): void
}

/**
 * O VIGIA DE VERSÃO PÓS-BOOT (2026-09-01). Caso real: o Fable 5.1 saiu, o
 * `claude` foi atualizado por fora do app e o Synkora — de pé desde a véspera
 * — seguiu servindo o catálogo do binário velho até um restart, porque a
 * versão só era lida no boot. Aqui ela é re-lida no relógio e a cada pane que
 * nasce; mudança vira `set(...)`, que é o MESMO caminho de uma rodada de
 * update: o `onCliStatus` do index derruba o cache do catálogo e o renderer
 * esquece as listas. A régua é a de `cliVersionDrift` (pura, testada).
 *
 * `read` entra por injeção para a costura ser provável sem binário; o padrão
 * é o `--version` real. Uma rodada de update em curso é dona da verdade — o
 * vigia não fala por cima dela.
 */
export function startCliVersionWatch(opts: {
  intervalMs: number
  read?: (cli: CliName) => Promise<string | null>
}): CliVersionWatch {
  const read = opts.read ?? readVersion
  let checking: Promise<void> | null = null
  const check = (): Promise<void> => {
    if (checking) return checking
    checking = (async () => {
      if (running) return
      for (const cli of CLIS) {
        const current = status.get(cli) as CliStatus
        const drift = cliVersionDrift(current, await read(cli))
        if (drift) set(cli, { ...drift, checkedAt: Date.now() })
      }
    })().finally(() => {
      checking = null
    })
    return checking
  }
  const timer = setInterval(() => void check(), opts.intervalMs)
  timer.unref()
  return { check, stop: () => clearInterval(timer) }
}
