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
import type { Hub } from './hub'

/** O que o spawn do pane GUI precisa carregar para falar com o Synkora. */
export interface GuiPlannerMcp {
  /** flags extras do CLI (claude: --mcp-config; codex: -c mcp_servers.*) */
  args: string[]
  /** env extra do processo (codex lê o bearer daqui) */
  env?: Record<string, string>
}

// `GuiPlannerMcpInput` morava aqui e morreu com o arm (2026-08-30): o input do
// planejador é o `GuiDelegateMcpInput`, o mesmo dos outros chats.

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

// `armGuiPlannerMcp` morava aqui: o arm próprio do kit de planos, SEM cerca e
// sem pré-sanção. Ele MORREU em 2026-08-30, quando o planejador entrou no
// regime da delegação (ordem do dono: "coloque os ajudantes também para eu
// selecionar") — o pane dele arma pelo `armGuiDelegateMcp` com o papel
// `gui-planner`, que traz as duas cercas anti-subagente-nativo, o teto de tool
// do long-poll e a pré-sanção por papel (planos + ajudantes + LSP). O que fica
// aqui é o que os DOIS arms sempre compartilharam: os tipos, o env do token e
// os `-c` base do codex.

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
