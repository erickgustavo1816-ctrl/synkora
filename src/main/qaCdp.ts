/**
 * QA de produto ELECTRON com o app REAL via CDP (Fase 4 do nível 5 — CHECK 7c,
 * sonda positiva 2026-08-07 + sonda de implementação probe-electron-cdp.mjs
 * 2026-08-08, 4/4 verde nesta máquina):
 *
 *  - o qaRuntime sobe o produto com `--remote-debugging-port=<porta reservada>`
 *    e o wrapper @playwright/mcp do pane de QA nasce com
 *    `--cdp-endpoint http://127.0.0.1:<porta>` — o QA dirige o app DE VERDADE
 *    (preload/IPC reais; o playbook do "duplo de bridge" morre para Electron).
 *
 * POR QUE A PORTA É RESERVADA ANTES DO SPAWN DO PANE: os args do MCP do pane
 * são lacrados no armPane (claude: arquivo de config lido só no boot do CLI;
 * codex: wrapper .cmd fingerprinted por args) — não há como trocar o endpoint
 * depois. A reserva por taskId acontece no preparePhasePane (antes do armPane)
 * e o startQaRuntime CONSULTA o mesmo registro: pane e runtime sempre falam da
 * MESMA porta, inclusive através de restarts via runtime_control.
 *
 * COMO A FLAG CHEGA AO ELECTRON DO PRODUTO (conferido no electron-vite
 * instalado, dist/chunks/lib-*.js, função startElectron):
 *  - env `REMOTE_DEBUGGING_PORT` → `--remote-debugging-port=N` SÓ no script
 *    `dev` (NODE_ENV_ELECTRON_VITE === 'development');
 *  - args após o `--` do CLI viram env ELECTRON_CLI_ARGS e são anexados em
 *    dev E preview → `npm run dev -- -- --remote-debugging-port=N` (o npm come
 *    o 1º `--`; o electron-vite repassa o que vem depois do dele);
 *  - os dois juntos duplicam a flag com o MESMO valor — inofensivo no
 *    Chromium, e cobre dev (env) e preview (argv) de uma vez.
 *  Script `electron .` puro recebe a flag por UM `--` (o npm apenas anexa);
 *  nunca usar `--` duplo aí: `--` encerra o parse de switches do Chromium e a
 *  flag viraria argumento morto.
 *
 * A prova de prontidão é a linha "DevTools listening on ws://..." (stderr do
 * electron, que atravessa shell→pipe — R1 da sonda); o endpoint HTTP
 * /json/version responde imediatamente depois (R2) e o connectOverCDP enxerga
 * o preload real (R3). browser.close() do playwright SÓ desconecta (R4) — o
 * fim de rodada do QA derruba o app via runtime_control {action:"stop"}.
 */
import { createServer } from 'net'
import { join } from 'path'

/** Detector canônico de script Electron (fonte única — antes duplicado em
 *  portInvocation e no runtime_control). */
const ELECTRON_SCRIPT_RE = /electron-vite|\belectron\b/
export function isElectronScript(scriptCommand: string): boolean {
  return ELECTRON_SCRIPT_RE.test(scriptCommand)
}
export function isElectronViteScript(scriptCommand: string): boolean {
  return /electron-vite/.test(scriptCommand)
}

/** Como entregar `--remote-debugging-port` ao processo electron do produto,
 *  por ferramenta (racional no cabeçalho do módulo). Script não-Electron
 *  devolve vazio — CDP não se aplica. */
export function cdpInvocation(
  scriptCommand: string,
  port: number
): { suffix: string; env: Record<string, string> } {
  if (isElectronViteScript(scriptCommand))
    return {
      suffix: ` -- -- --remote-debugging-port=${port}`,
      env: { REMOTE_DEBUGGING_PORT: String(port) }
    }
  if (isElectronScript(scriptCommand))
    return { suffix: ` -- --remote-debugging-port=${port}`, env: {} }
  return { suffix: '', env: {} }
}

/** Linha de prontidão do CDP no tee acumulado (sem ANSI). A porta anunciada
 *  precisa bater com a reservada — divergência = pane ligado no endpoint
 *  errado, melhor falhar com explicação do que aprovar às cegas.
 *  O sufixo /devtools/browser/<uuid> é OBRIGATÓRIO no match: chunk cortado no
 *  meio da porta ("ws://127.0.0.1:5") casaria com porta TRUNCADA e viraria
 *  erro fatal espúrio de porta divergente — só a linha completa vale. */
const DEVTOOLS_LISTENING_RE =
  /DevTools listening on (ws:\/\/[^\s'"]+\/devtools\/browser\/[0-9a-fA-F-]+)/
export function matchDevToolsListening(
  cleanTail: string
): { wsUrl: string; port: number } | undefined {
  const match = DEVTOOLS_LISTENING_RE.exec(cleanTail)
  if (!match) return undefined
  try {
    const port = Number(new URL(match[1]).port)
    if (Number.isInteger(port) && port > 0) return { wsUrl: match[1], port }
  } catch {
    // URL malformada no meio do tee — espera o resto do chunk
  }
  return undefined
}

// ------------------------------------------------------------------
// Registro de portas CDP reservadas, por taskId. Memória apenas: pane e
// runtime morrem juntos, e um respawn de pane re-executa preparePhasePane
// (args regenerados) — a reserva re-usa a mesma porta enquanto o app vive.
// ------------------------------------------------------------------
const reservedCdpPorts = new Map<string, number>()

function bindFreePort(): Promise<number | undefined> {
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

/** Reserva (ou devolve a já reservada) a porta CDP do card. Porta provada
 *  livre AGORA por bind de teste; colisão entre a reserva e o launch é rara e
 *  o erro do runtime nomeia o endpoint — runtime_control cobre o re-try. */
export async function reserveQaCdpPort(taskId: string): Promise<number | undefined> {
  const existing = reservedCdpPorts.get(taskId)
  if (existing) return existing
  const port = await bindFreePort()
  if (port) reservedCdpPorts.set(taskId, port)
  return port
}

export function qaCdpPortFor(taskId: string | undefined): number | undefined {
  return taskId ? reservedCdpPorts.get(taskId) : undefined
}

export function qaCdpEndpointFor(taskId: string | undefined): string | undefined {
  const port = qaCdpPortFor(taskId)
  return port ? `http://127.0.0.1:${port}` : undefined
}

export function releaseQaCdpPort(taskId: string): void {
  reservedCdpPorts.delete(taskId)
}

/** Para o mapa humano de portas (portMap): quem é o dono de cada CDP. */
export function qaCdpReservations(): Array<{ taskId: string; port: number }> {
  return [...reservedCdpPorts.entries()].map(([taskId, port]) => ({ taskId, port }))
}

/**
 * Decorador ÚNICO dos args do @playwright/mcp por pane — usado pelos DOIS
 * gravadores da config (mcpPaneArgs no armPane E a regravação anti-corrida do
 * pty:create). Antes cada um montava o seu e o remount DROPAVA o --output-dir
 * (a lição F6.8i valia só no primeiro caminho); com o --cdp-endpoint a
 * divergência viraria QA cego ao app real — por isso a fonte é uma só.
 *  - `--output-dir <cwd>/.playwright-mcp`: evidência nunca nasce git-visível.
 *  - `--cdp-endpoint`: panes de QA E de DEV do card com porta reservada
 *    (pedido do dono 2026-08-10: "o QA abre o app, mas o DEV ainda abre o
 *    chrome") — em produto Electron os dois dirigem o app REAL; quem sobe o
 *    produto com a flag é o próprio agente (QA via runtime_control/harness,
 *    dev pelo shell com a receita do prompt).
 */
export function decorateBrowserLaunchArgs(
  baseArgs: string[],
  opts: { cwd?: string; role?: string; taskId?: string }
): string[] {
  const args = [...baseArgs]
  if (opts.cwd) args.push('--output-dir', join(opts.cwd, '.playwright-mcp'))
  if (opts.role === 'qa' || opts.role === 'dev') {
    const endpoint = qaCdpEndpointFor(opts.taskId)
    if (endpoint) args.push('--cdp-endpoint', endpoint)
  }
  return args
}
