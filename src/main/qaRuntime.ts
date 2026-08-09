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
import { RuntimeOwnershipRegistry } from './runtimeOwnership'
import { cdpInvocation, isElectronScript, matchDevToolsListening, qaCdpPortFor } from './qaCdp'

interface QaRuntimeEntry {
  proc: ChildProcess
  guardName: string
  guardReleased: boolean
  killRequested: boolean
  cwd: string
  script: string
  url?: string
  /** Fase 4 (CHECK 7c): endpoint HTTP do CDP quando o produto é Electron e o
   * card tem porta reservada — o pane de QA nasceu com --cdp-endpoint aqui. */
  cdpEndpoint?: string
  outputTail: string
  /** Acumulado SEM ANSI para o match de URL — o vite imprime a porta em
   * NEGRITO DENTRO da URL ("http://localhost:" + ESC[1m + "5174") e o match
   * por chunk cru nunca casava (caso real 2026-08-06: o servidor subiu,
   * anunciou, e o detector cego derrubou um runtime saudável — três vezes). */
  cleanTail: string
}

const runtimes = new RuntimeOwnershipRegistry<QaRuntimeEntry>()
const latestStartRequest = new Map<string, number>()
let startRequestGeneration = 0

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
function beginStartRequest(taskId: string): number {
  startRequestGeneration += 1
  latestStartRequest.set(taskId, startRequestGeneration)
  return startRequestGeneration
}

function invalidateStartRequest(taskId: string): void {
  startRequestGeneration += 1
  latestStartRequest.set(taskId, startRequestGeneration)
}

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
  if (isElectronScript(scriptCommand))
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

/** Libera somente a geração capturada. Callbacks antigos nunca tocam no
 * runtime que a substituiu, mas ainda fecham seu próprio job/processo. */
function releaseQaRuntimeEntry(
  taskId: string,
  entry: QaRuntimeEntry,
  terminate: boolean
): void {
  runtimes.deleteIfCurrent(taskId, entry)
  if (!entry.guardReleased) {
    entry.guardReleased = true
    processGuard?.unguard(entry.guardName)
  }
  if (terminate && !entry.killRequested) {
    entry.killRequested = true
    killTree(entry.proc)
  }
}

function stopCurrentQaRuntime(taskId: string): void {
  const entry = runtimes.get(taskId)
  if (entry) releaseQaRuntimeEntry(taskId, entry, true)
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
): Promise<{ url?: string; cdpEndpoint?: string; error?: string }> {
  stopCurrentQaRuntime(taskId)
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
  const scriptCommand = readScriptCommand(cwd, script)
  const inv = port
    ? portInvocation(scriptCommand, script, port, false)
    : { prefix: '', suffix: '' }
  // CDP (Fase 4, sonda probe-electron-cdp 4/4): card com porta CDP reservada
  // + script Electron → o app do produto sobe com --remote-debugging-port na
  // MESMA porta que o pane de QA recebeu em --cdp-endpoint. A prontidão deixa
  // de ser a URL do dev server e vira a linha "DevTools listening" (stderr do
  // electron, que atravessa shell→pipe — provado na sonda R1).
  const cdpPort = qaCdpPortFor(taskId)
  const cdp =
    cdpPort && isElectronScript(scriptCommand) ? cdpInvocation(scriptCommand, cdpPort) : undefined
  const commandLine = `${needsInstall ? `${installCommand(cwd)} && ` : ''}npm run ${script}${inv.suffix}${cdp?.suffix ?? ''}`
  let proc: ChildProcess
  try {
    proc = spawn(commandLine, {
      cwd,
      env: {
        ...sanitizedEnv(),
        ...(port ? { PORT: String(port) } : {}),
        ...(cdp?.env ?? {})
      },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    return Promise.resolve({
      error: error instanceof Error ? error.message : String(error)
    })
  }
  const entry: QaRuntimeEntry = {
    proc,
    guardName: runtimes.nextGuardName('qa-runtime', taskId.slice(0, 8)),
    guardReleased: false,
    killRequested: false,
    cwd,
    script,
    outputTail: '',
    cleanTail: ''
  }
  runtimes.set(taskId, entry)
  // shell:true → o pid é o do shell; filhos (npm/vite) herdam a membership do
  // job porque o assign acontece antes de eles nascerem.
  if (proc.pid) processGuard?.guard(entry.guardName, proc.pid)
  return new Promise((resolve) => {
    const HARD_CAP_MS = 300_000
    const SILENCE_MS = 45_000
    // Em modo CDP a URL do dev server é informação acessória: a prontidão que
    // o pane consegue USAR é o endpoint que ele recebeu em --cdp-endpoint.
    const readiness = cdp ? 'o endpoint CDP (linha "DevTools listening")' : 'URL local'
    const startedAt = Date.now()
    let lastOutputAt = Date.now()
    let settled = false
    const finish = (result: { url?: string; cdpEndpoint?: string; error?: string }): void => {
      if (settled) return
      settled = true
      clearInterval(watchdog)
      if (!result.url && !result.cdpEndpoint) {
        releaseQaRuntimeEntry(taskId, entry, true)
      }
      resolve(result)
    }
    const watchdog = setInterval(() => {
      const now = Date.now()
      if (now - startedAt > HARD_CAP_MS) {
        finish({
          error: `o script "${script}" não anunciou ${readiness} em ${Math.round(HARD_CAP_MS / 1000)}s (teto duro) — última saída: ${entry.outputTail.slice(-400) || '(vazia)'}`
        })
      } else if (now - lastOutputAt > SILENCE_MS) {
        finish({
          error: `o script "${script}" ficou ${Math.round(SILENCE_MS / 1000)}s em silêncio sem anunciar ${readiness} — última saída: ${entry.outputTail.slice(-400) || '(vazia)'}`
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
        // Em modo CDP a URL do vite chega ANTES de o electron abrir —
        // registrar sem encerrar: quem encerra é a linha DevTools (ou timeout).
        if (!cdp) finish({ url: match[1] })
      }
      if (cdp && cdpPort) {
        const devtools = matchDevToolsListening(entry.cleanTail)
        if (devtools) {
          if (devtools.port === cdpPort) {
            entry.cdpEndpoint = `http://127.0.0.1:${cdpPort}`
            finish({ url: entry.url, cdpEndpoint: entry.cdpEndpoint })
          } else {
            // Porta divergente = o pane de QA está ligado num endpoint que
            // não existe — derrubar e explicar vale mais que um QA cego.
            finish({
              error: `o CDP do produto anunciou na porta ${devtools.port}, mas o pane de QA foi ligado em ${cdpPort} — o produto ignora --remote-debugging-port? Reporte bloqueada citando esta linha`
            })
          }
        }
      }
    }
    proc.stdout?.on('data', onChunk)
    proc.stderr?.on('data', onChunk)
    proc.on('exit', (code) => {
      releaseQaRuntimeEntry(taskId, entry, false)
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
      releaseQaRuntimeEntry(taskId, entry, false)
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
): Promise<{ url?: string; cdpEndpoint?: string; error?: string }> {
  const requestGeneration = beginStartRequest(taskId)
  let result = await startQaRuntimeAttempt(taskId, cwd, script, port)
  if (latestStartRequest.get(taskId) !== requestGeneration) {
    return { error: 'inicialização substituída por uma solicitação mais recente' }
  }
  let retries = 0
  while (
    !result.url &&
    result.error &&
    /Port \d+ is already in use/i.test(result.error) &&
    retries < 2 &&
    latestStartRequest.get(taskId) === requestGeneration
  ) {
    retries++
    const free = await findFreePort()
    if (!free || latestStartRequest.get(taskId) !== requestGeneration) break
    result = await startQaRuntimeAttempt(taskId, cwd, script, free)
    if (latestStartRequest.get(taskId) !== requestGeneration) {
      return { error: 'inicialização substituída por uma solicitação mais recente' }
    }
  }
  return result
}

/** Runtimes vivos do harness — para nomear QUEM segura uma porta pinada
 * (colisão dono×QA e QA×QA do CHECK 9, 2026-08-07). */
export function activeQaRuntimes(): Array<{
  taskId: string
  cwd: string
  url?: string
  cdpEndpoint?: string
}> {
  return [...runtimes.entries()].map(([taskId, entry]) => ({
    taskId,
    cwd: entry.cwd,
    url: entry.url,
    cdpEndpoint: entry.cdpEndpoint
  }))
}

export function qaRuntimeOf(
  taskId: string
): { url?: string; cdpEndpoint?: string; cwd: string } | undefined {
  const entry = runtimes.get(taskId)
  return entry ? { url: entry.url, cdpEndpoint: entry.cdpEndpoint, cwd: entry.cwd } : undefined
}

export function stopQaRuntime(taskId: string): void {
  invalidateStartRequest(taskId)
  stopCurrentQaRuntime(taskId)
}

export function stopAllQaRuntimes(): void {
  for (const taskId of [...runtimes.keys()]) stopQaRuntime(taskId)
}
