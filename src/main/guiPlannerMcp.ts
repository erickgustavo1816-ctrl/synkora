/**
 * MCP DO CHAT DE PLANEJAMENTO (Synkora 2.0, onda D).
 *
 * O chat da era 2.0 nasceu SEM nenhuma ferramenta Synkora — por construção, não
 * por esquecimento. Esta é a primeira e única exceção, e ela é deliberadamente
 * estreita: só o pane da missão de PLANEJAMENTO recebe o servidor, e o catálogo
 * que ele enxerga é apenas o kit de planos (a cerca vive no `buildServer`, que
 * retorna cedo para a role `gui-planner`).
 *
 * O que este módulo NÃO faz, de propósito:
 * - não passa por `armPane`: aquele caminho é dos panes TUI e carrega perfil de
 *   permissão, skills e browser que não se aplicam a um chat;
 * - não entra na fila de injeção do hub: a identidade serve para AUTENTICAR e
 *   ESCOPAR, nunca para receber evento digitado (era 2.0: zero digitação);
 * - não conhece plano nenhum — isto aqui é só token, args e limpeza.
 *
 * ARMADILHA CONHECIDA (codex 0.147, sondado 2026-08-15): o valor do `-c` viaja
 * por `spawn(..., { shell: true })`, que NÃO escapa nada. Aspas embutidas
 * (`url="http://…"`) seriam comidas pelo cmd.exe; por isso os valores vão CRUS
 * — o codex tenta parsear como TOML e, falhando, usa a string literal, que é
 * exatamente o que queremos. Provado com `codex mcp list`: o servidor aparece
 * com a URL certa e auth "Bearer token".
 */
import { randomUUID } from 'crypto'
import { claudeMcpArgs, writeClaudeMcpConfig } from './mcpServer'
import type { Hub } from './hub'

/** O que o spawn do pane GUI precisa carregar para falar com o Synkora. */
export interface GuiPlannerMcp {
  /** flags extras do CLI (claude: --mcp-config; codex: -c mcp_servers.*) */
  args: string[]
  /** env extra do processo (codex lê o bearer daqui) */
  env?: Record<string, string>
}

export interface GuiPlannerMcpInput {
  paneId: string
  projectId: string
  cwd: string
  cli: 'claude' | 'codex'
  /** missão de planejamento dona da conversa (escopo da identidade) */
  missionId?: string
  seatId?: string
}

export interface GuiPlannerMcpDeps {
  hub: Hub
  /** porta do servidor MCP local; 0 = ainda subindo (o pane nasce sem tools) */
  port(): number
  /** userData/mcp — onde a config por pane do claude é gravada */
  configRoot(): string
  /** Token já emitido para este pane (ctx.paneTokens), quando existe. */
  tokenOf(paneId: string): string | undefined
  /** Guarda os artefatos por pane para o teardown revogar exatamente estes:
   *  o token (revogado no `unregisterPane`) e, no claude, o arquivo de config
   *  (apagado no `cleanPaneMcpFile` — o mesmo mapa dos panes TUI). */
  remember(paneId: string, artifacts: { token: string; mcpFile?: string }): void
}

/** Nome do env var que o codex lê para montar o header Authorization. */
export const GUI_PLANNER_TOKEN_ENV = 'SYNKORA_TOKEN'

/**
 * Registra a identidade `gui-planner` do pane e devolve as flags do spawn.
 * `undefined` = servidor ainda não subiu: o chat nasce sem tools em vez de
 * nascer apontando para uma porta que não existe (o dono continua conversando;
 * reabrir a conversa arma o MCP).
 *
 * IDEMPOTENTE POR PANE, e isso é contrato, não economia: a spec é pedida a cada
 * remontagem do chat (trocar de aba, recarregar a view), mas o fingerprint do
 * spawn não muda — o processo CONTINUA VIVO com o token que leu no nascimento.
 * Emitir um token novo aqui deixaria o arquivo de config e o processo em
 * desacordo, e o chat perderia as ferramentas sem nenhum sinal.
 */
export function armGuiPlannerMcp(
  input: GuiPlannerMcpInput,
  deps: GuiPlannerMcpDeps
): GuiPlannerMcp | undefined {
  const port = deps.port()
  if (port === 0) return undefined
  const previous = deps.tokenOf(input.paneId)
  const live = previous ? deps.hub.identityByToken(previous) : undefined
  const reusable =
    previous && live?.paneId === input.paneId && live.role === 'gui-planner' ? previous : undefined
  const token = reusable ?? randomUUID()
  deps.hub.registerPane(token, {
    paneId: input.paneId,
    projectId: input.projectId,
    role: 'gui-planner',
    cwd: input.cwd,
    ...(input.seatId ? { seatId: input.seatId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {})
  })
  if (input.cli === 'claude') {
    const mcpFile = writeClaudeMcpConfig(deps.configRoot(), input.paneId, port, token)
    deps.remember(input.paneId, { token, mcpFile })
    // `--strict-mcp-config`: o planejador não precisa dos MCPs do seat, e um
    // servidor herdado dentro de um chat com autoridade sobre planos seria
    // superfície nova que ninguém pediu.
    return { args: claudeMcpArgs(mcpFile, true) }
  }
  deps.remember(input.paneId, { token })
  return {
    args: guiPlannerCodexArgs(port),
    env: { [GUI_PLANNER_TOKEN_ENV]: token }
  }
}

/**
 * Overrides `-c` do codex. Valores SEM aspas de propósito (ver a armadilha no
 * cabeçalho); `startup_timeout_sec` repete a folga tripla dos panes de execução
 * — no boot do app o event loop do main é o gargalo, não a rede.
 */
export function guiPlannerCodexArgs(port: number): string[] {
  return [
    '-c',
    `mcp_servers.synkora.url=http://127.0.0.1:${port}/mcp`,
    '-c',
    `mcp_servers.synkora.bearer_token_env_var=${GUI_PLANNER_TOKEN_ENV}`,
    '-c',
    'mcp_servers.synkora.startup_timeout_sec=30'
  ]
}
