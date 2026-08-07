/**
 * Runtime de produto para o QA (gate 2) — decisão do usuário, 2026-08-06:
 * "quero um QA de verdade, não um QA que só olha código". O QA claude roda com
 * catálogo sem shell (a cerca read-only), então NINGUÉM subia o dev server e o
 * mandato visual (hover/active/focus, viewports, estados) era inexecutável —
 * caso real: o QA do design system aprovou em 2min29s lendo o diff, zero
 * navegação. O HARNESS passa a subir o script dev/preview do worktree como
 * processo próprio, entrega a URL ao QA no prompt e derruba a árvore quando o
 * pane do QA morre (ou no quit). O QA continua sem shell: capacidade sem furar
 * a cerca.
 *
 * Nota de plataforma: node moderno exige shell:true para .cmd — o spawn usa a
 * linha via shell e a morte é por taskkill /T /F (árvore inteira, mesma
 * receita da ceifa dos panes). Órfão em CRASH do app segue possível (processo
 * não entra no job object dos panes) — aceito nesta versão, anotado.
 */
import { spawn, execFile, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

interface QaRuntimeEntry {
  proc: ChildProcess
  cwd: string
  script: string
  url?: string
  outputTail: string
  /** Acumulado SEM ANSI para o match de URL — o vite imprime a porta em
   * NEGRITO DENTRO da URL ("http://localhost:" + ESC[1m + "5174") e o match
   * por chunk cru nunca casava (caso real 2026-08-06: o servidor subiu,
   * anunciou, e o detector cego derrubou um runtime saudável — três vezes). */
  cleanTail: string
}

const runtimes = new Map<string, QaRuntimeEntry>()

// GUARDA DE PROCESSO EXTERNO (fix E5×Q4 do mapa de retomada, 2026-08-06): o
// runtime entra num job object do guardião do PtyManager — crash sujo do app
// mata a árvore no kernel (antes ficava órfã; o comentário de módulo acima
// registrava o gap como aceito). O index liga o hook no boot; sem hook
// (testes/posix) tudo degrada para o killTree de sempre.
export interface QaRuntimeGuard {
  guard(name: string, pid: number): void
  unguard(name: string): void
}
let processGuard: QaRuntimeGuard | undefined
export function setQaRuntimeGuard(guard: QaRuntimeGuard): void {
  processGuard = guard
}
const guardNameOf = (taskId: string): string => `qa-runtime-${taskId.slice(0, 8)}`

const RUNTIME_SCRIPT_PRIORITY = ['dev', 'preview', 'serve', 'start'] as const
const LOCAL_URL_RE = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?[^\s'"]*)/i

/** Primeiro script de runtime declarado no package.json do worktree. */
export function detectRuntimeScript(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>
    }
    for (const name of RUNTIME_SCRIPT_PRIORITY) {
      const value = pkg.scripts?.[name]
      if (typeof value === 'string' && value.trim()) return name
    }
  } catch {
    // sem package.json legível = sem runtime detectável
  }
  return undefined
}

/** Comando de instalação pelo LOCKFILE (pnpm/yarn/bun não têm package-lock —
 * `npm ci` neles falharia; sem lockfile nenhum, npm install). */
export function installCommand(cwd: string): string {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile'
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn install --frozen-lockfile'
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock')))
    return 'bun install'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm ci'
  return 'npm install'
}

/** Corpo do script (para decidir COMO passar a porta — cada ferramenta tem a
 * sua sintaxe e `electron-vite dev` recusa `--port` com CACError). */
export function readScriptCommand(cwd: string, script: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8')) as {
      scripts?: Record<string, unknown>
    }
    const value = pkg.scripts?.[script]
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * Sufixo/prefixo de porta POR FERRAMENTA (caso real 2026-08-06: `npm run dev
 * -- --port 4002` num produto electron-vite morreu com "Unknown option
 * '--port'"). Electron abre janela própria — porta não se aplica; vite/astro
 * usam --port; next usa -p; ferramenta desconhecida recebe a convenção PORT=
 * no ambiente (CRA/express).
 */
export function portInvocation(
  scriptCommand: string,
  script: string,
  port: number | undefined,
  isWin: boolean
): { prefix: string; suffix: string; note?: string } {
  if (!port) return { prefix: '', suffix: '' }
  if (/electron-vite|\belectron\b/.test(scriptCommand))
    // CHECK 9.4 (2026-08-07): a porta escolhida VIAJA via PORT no ambiente —
    // produto PORT-aware a honra; config com strictPort pinado a ignora (a
    // nota é honesta sobre isso). Antes o prefixo vazio deixava o modal do
    // dono mudo mesmo com produto consertado.
    return {
      prefix: isWin ? `$env:PORT=${port}; ` : `PORT=${port} `,
      suffix: '',
      note: `porta ${port} enviada via PORT no ambiente — vale quando o produto a lê; config com porta pinada (strictPort) ainda a ignora`
    }
  if (/\bnext\b/.test(scriptCommand)) return { prefix: '', suffix: ` -- -p ${port}` }
  if (/\bvite\b|\bastro\b/.test(scriptCommand))
    return { prefix: '', suffix: ` -- --port ${port} --strictPort` }
  return {
    prefix: isWin ? `$env:PORT=${port}; ` : `PORT=${port} `,
    suffix: '',
    note: `ferramenta do script "${script}" não reconhecida — a porta foi passada pela convenção PORT=`
  }
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDE_CONFIG_DIR') continue
    if (key.startsWith('CLAUDE_CODE') || key === 'CLAUDECODE') delete env[key]
  }
  delete env.NO_COLOR
  return env
}

function killTree(proc: ChildProcess): void {
  const pid = proc.pid
  if (!pid) return
  if (process.platform === 'win32') {
    // CEIFA POR VARREDURA (caso real 2026-08-06: dois Electron do produto
    // ÓRFÃOS na tela do usuário — taskkill /T não atravessa pai já morto, a
    // armadilha provada na sonda F6.8): enumera a árvore VIVA por parentesco
    // (BFS via Win32_Process) e mata FOLHA→RAIZ, cada PID individualmente.
    const script =
      `$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; ` +
      `$q = New-Object System.Collections.Queue; $q.Enqueue(${pid}); $list = @(); ` +
      `while ($q.Count -gt 0) { $p = $q.Dequeue(); $list += $p; ` +
      `$all | Where-Object { $_.ParentProcessId -eq $p } | ForEach-Object { $q.Enqueue($_.ProcessId) } }; ` +
      `[array]::Reverse($list); ` +
      `$list | ForEach-Object { try { Stop-Process -Id $_ -Force -ErrorAction Stop } catch {} }`
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      () => {
        // melhor esforço — processos podem já ter morrido
      }
    )
  } else {
    try {
      proc.kill('SIGTERM')
    } catch {
      // já morto
    }
  }
}

/**
 * Sobe o runtime e espera a URL local aparecer no stdout (vite/electron-vite a
 * imprimem). TIMEOUT ADAPTATIVO (caso real 2026-08-06: vite frio ficou 60s+
 * em "Re-optimizing dependencies" e o teto fixo matou um runtime que ia
 * subir): enquanto o processo VIVE e ainda emite saída, a espera continua;
 * 45s de SILÊNCIO sem URL = falha real; teto duro de 5min. Sem URL, o
 * processo é derrubado — QA sem runtime deve saber que NÃO tem como validar
 * visualmente, nunca fingir.
 */
function startQaRuntimeAttempt(
  taskId: string,
  cwd: string,
  script: string,
  port?: number
): Promise<{ url?: string; error?: string }> {
  stopQaRuntime(taskId)
  // Worktree sem node_modules: sem o bootstrap, o script resolveria binários
  // pelo PATH herdado (o electron-vite do PRÓPRIO Synkora vazou num caso
  // real) ou morreria — instalação pelo lockfile primeiro.
  let needsInstall = false
  try {
    needsInstall = !existsSync(join(cwd, 'node_modules'))
  } catch {
    // sem acesso = deixa o npm decidir
  }
  // Porta pedida (runtime_control do QA): sufixo por ferramenta quando ela
  // aceita; a convenção PORT= vai SEMPRE no env (inofensiva onde ignorada).
  const inv = port
    ? portInvocation(readScriptCommand(cwd, script), script, port, false)
    : { prefix: '', suffix: '' }
  const commandLine = `${needsInstall ? `${installCommand(cwd)} && ` : ''}npm run ${script}${inv.suffix}`
  let proc: ChildProcess
  try {
    proc = spawn(commandLine, {
      cwd,
      env: { ...sanitizedEnv(), ...(port ? { PORT: String(port) } : {}) },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return Promise.resolve({
      error: error instanceof Error ? error.message : String(error)
    })
  }
  const entry: QaRuntimeEntry = { proc, cwd, script, outputTail: '', cleanTail: '' }
  runtimes.set(taskId, entry)
  // shell:true → o pid é o do shell; filhos (npm/vite) herdam a membership do
  // job porque o assign acontece antes de eles nascerem.
  if (proc.pid) processGuard?.guard(guardNameOf(taskId), proc.pid)
  return new Promise((resolve) => {
    const HARD_CAP_MS = 300_000
    const SILENCE_MS = 45_000
    const startedAt = Date.now()
    let lastOutputAt = Date.now()
    let settled = false
    const finish = (result: { url?: string; error?: string }): void => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      if (!result.url) {
        stopQaRuntime(taskId)
      }
      resolve(result)
    }
    const watchdog = setInterval(() => {
      const now = Date.now()
      if (now - startedAt > HARD_CAP_MS) {
        finish({
          error: `o script "${script}" não anunciou URL local em ${Math.round(HARD_CAP_MS / 1000)}s (teto duro) — última saída: ${entry.outputTail.slice(-400) || '(vazia)'}`
        })
      } else if (now - lastOutputAt > SILENCE_MS) {
        finish({
          error: `o script "${script}" ficou ${Math.round(SILENCE_MS / 1000)}s em silêncio sem anunciar URL — última saída: ${entry.outputTail.slice(-400) || '(vazia)'}`
        })
      }
    }, 5_000)
    watchdog.unref?.()
    const onChunk = (chunk: Buffer | string): void => {
      const text = String(chunk)
      lastOutputAt = Date.now()
      entry.outputTail = (entry.outputTail + text).slice(-4000)
      // Match SEM ANSI e sobre o ACUMULADO: o vite põe ESC[1m dentro da URL
      // (porta em negrito) e a URL pode chegar cortada entre dois chunks —
      // qualquer um dos dois cegava o detector (3 falsos-negativos reais em
      // 2026-08-06, derrubando servidor saudável).
      entry.cleanTail = (
        entry.cleanTail + text.replace(/\[[0-9;]*[A-Za-z]/g, '')
      ).slice(-8000)
      const match = LOCAL_URL_RE.exec(entry.cleanTail)
      if (match) {
        entry.url = match[1]
        finish({ url: match[1] })
      }
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk)
    proc.on('exit', (code) => {
      runtimes.delete(taskId)
      processGuard?.unguard(guardNameOf(taskId))
      // Porta ocupada por runtime IRMÃO (caso real 2026-08-07: produto com
      // strictPort pinado serializou os QAs visuais e o erro cru não dizia
      // QUEM segurava a 5174) — nomeia o dono para o veredito/orquestrador.
      const portBusy = /Port (\d+) is already in use/i.exec(entry.cleanTail)
      const holders = [...runtimes.entries()].filter(([otherId]) => otherId !== taskId)
      const holderNote =
        portBusy && holders.length > 0
          ? ` · porta ${portBusy[1]} OCUPADA por outro runtime do harness (${holders
              .map(([otherId, other]) => `card ${otherId.slice(0, 8)}${other.url ? ` em ${other.url}` : ''}`)
              .join(', ')}) — produto com porta PINADA serializa os QAs visuais: re-tente runtime_control quando aquele gate fechar, ou reporte bloqueada citando o card que segura a porta`
          : ''
      finish({
        error: `o script "${script}" terminou (exit ${code ?? '?'}) antes de anunciar URL — última saída: ${entry.outputTail.slice(-400) || '(vazia)'}${holderNote}`
      })
    })
    proc.on('error', (error) => {
      runtimes.delete(taskId)
      finish({ error: error.message })
    })
  })
}

/** Porta comprovadamente livre AGORA (bind de teste no SO e solta). */
function findFreePort(): Promise<number | undefined> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(undefined))
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : undefined
      probe.close(() => resolve(port))
    })
  })
}

/**
 * CAÇA AUTOMÁTICA DE PORTA (decisão do dono, 2026-08-07: "nem que tente
 * 20/30, uma hora acha uma porta livre" — mecânica, não boa vontade do
 * modelo): na falha "Port X is already in use", re-tenta sozinho com uma
 * porta LIVRE do SO, até 2 vezes, antes de devolver erro. Produto com
 * strictPort PINADO falha idêntico nas re-tentativas (ele recusa qualquer
 * porta) — o erro final mantém o dono da porta nomeado e o veredito
 * bloqueada continua o desfecho certo nesse caso.
 */
export async function startQaRuntime(
  taskId: string,
  cwd: string,
  script: string,
  port?: number
): Promise<{ url?: string; error?: string }> {
  let result = await startQaRuntimeAttempt(taskId, cwd, script, port)
  let retries = 0
  while (
    !result.url &&
    result.error &&
    /Port \d+ is already in use/i.test(result.error) &&
    retries < 2
  ) {
    retries++
    const free = await findFreePort()
    if (!free) break
    result = await startQaRuntimeAttempt(taskId, cwd, script, free)
  }
  return result
}

/** Runtimes vivos do harness — para nomear QUEM segura uma porta pinada
 * (colisão dono×QA e QA×QA do CHECK 9, 2026-08-07). */
export function activeQaRuntimes(): Array<{ taskId: string; cwd: string; url?: string }> {
  return [...runtimes.entries()].map(([taskId, entry]) => ({
    taskId,
    cwd: entry.cwd,
    url: entry.url
  }))
}

export function qaRuntimeOf(taskId: string): { url?: string; cwd: string } | undefined {
  const entry = runtimes.get(taskId)
  return entry ? { url: entry.url, cwd: entry.cwd } : undefined
}

export function stopQaRuntime(taskId: string): void {
  const entry = runtimes.get(taskId)
  if (!entry) return
  runtimes.delete(taskId)
  // 1ª camada: fechar o job mata a árvore NO KERNEL (kill-on-close);
  // killTree segue como cinto (guardião morto/posix/nascidos pré-assign).
  processGuard?.unguard(guardNameOf(taskId))
  killTree(entry.proc)
}

export function stopAllQaRuntimes(): void {
  for (const taskId of [...runtimes.keys()]) stopQaRuntime(taskId)
}
