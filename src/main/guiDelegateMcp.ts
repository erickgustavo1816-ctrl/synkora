/**
 * MCP DE DELEGAÇÃO do chat de missão (subagentes sem aba, 2026-08-18).
 *
 * Ordem do dono (18/08): "deixe claro pra todo chat que eu criar que ele NUNCA
 * MAIS vai abrir subagentes dele — ele vai abrir subagentes via MCP. Porque via
 * MCP eu vejo na lateral o MODELO e o EFFORT que subiu; o nativo (Claude E
 * Codex) não me mostra nada."
 *
 * Este módulo é a metade de SPAWN dessa ordem, e ela tem dois movimentos que só
 * fazem sentido juntos:
 *   1. TIRA o subagente nativo do chat (a cerca por CLI, abaixo);
 *   2. DEVOLVE a capacidade pelo catálogo `gui-delegator` do `mcpServer`.
 * Fazer só o (1) capa o chat; fazer só o (2) deixa duas portas abertas e o dono
 * cego na metade delas.
 *
 * É um CLONE deliberado do `guiPlannerMcp`: mesmo token por pane, mesma
 * idempotência por spawn, mesmo teardown (o `unregisterPane` revoga, o
 * `cleanPaneMcpFile` apaga). O que muda é a role, a cerca e os tetos de tool.
 *
 * TUDO ABAIXO É MEDIDO (sondas de 2026-08-18 no scratchpad: probe-claude-fence,
 * probe-codex-fence, probe-helper-matrix) — nenhum número aqui é chute.
 */
import { randomUUID } from 'crypto'
import { claudeMcpArgs, writeClaudeMcpConfig } from './mcpServer'
import { GUI_PLANNER_TOKEN_ENV, guiPlannerCodexArgs } from './guiPlannerMcp'
import type { GuiPlannerMcp, GuiPlannerMcpDeps } from './guiPlannerMcp'
import { guiMissionRoleOf, missionTypeOf } from './guiMissionContracts'
import { LSP_TOOL_NAMES } from './guiLspTools'

/** A cerca anti-subagente-nativo do claude (sonda 2026-08-18: cerca de 1-2
 *  nomes NÃO basta — o modelo desvia por RemoteTrigger etc.; esta lista de 12
 *  zerou os tool_use de agente preservando Read/Write/Edit/Bash/Glob/Grep/
 *  Skill/WebFetch/WebSearch/AskUserQuestion/TaskCreate/Update/List). ToolSearch
 *  entra por decisão de design: sem ele as tools MCP nascem deferred. */
export const CLAUDE_NATIVE_AGENT_FENCE: readonly string[] = [
  'Task',
  'Agent',
  'Workflow',
  'SendMessage',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'ScheduleWakeup',
  'Monitor',
  'TaskOutput',
  'TaskStop',
  'ToolSearch'
]

/**
 * O teto de UMA chamada de tool MCP no claude é de EXATOS 60 000 ms por default
 * (sonda D2/D3: dois pedidos muito diferentes cortados em 60 013 e 60 015 ms).
 * O long-poll do `helper_result` vai a 240s, então o teto tem de subir — e a
 * única alavanca é esta variável de ambiente, que sobrevive à higiene de env do
 * spawn (não casa `^CLAUDE_CODE_`). Provado: com 300 000 o mesmo pedido que
 * falhava passou limpo em 120 017 ms.
 */
export const GUI_DELEGATE_CLAUDE_TOOL_TIMEOUT_MS = 300_000

/**
 * O codex não tem teto default abaixo de 130s (medido), mas a chave
 * `tool_timeout_sec` AMARRA quando presente (provado baixando para 10s e vendo
 * os dois caminhos falharem em ~10s). Declaramos 300 para o long-poll caber com
 * folga e para o número ser EXPLÍCITO em vez de depender de um default que a
 * próxima versão do binário pode inventar.
 */
export const GUI_DELEGATE_CODEX_TOOL_TIMEOUT_SEC = 300

/**
 * A cerca do codex, em valor de `-c`. SEM ESPAÇO por obrigação: os overrides
 * viajam por `spawn(..., { shell: true })`, que não escapa nada — um espaço
 * aqui é picado pelo cmd.exe e o app-server trava no `initialize` (medido).
 * É o CINTO; o suspensório é o `suppressNativeAgents` do `CodexSession`, que
 * manda a mesma chave dentro do `thread/start`/`thread/resume`.
 */
export const CODEX_NATIVE_AGENT_FENCE_ARG = 'features.multi_agent=false'

export interface GuiDelegateMcpInput {
  paneId: string
  projectId: string
  cwd: string
  cli: 'claude' | 'codex'
  missionId?: string
  seatId?: string
}

/**
 * Qual kit de ferramentas este pane recebe. É a régua ÚNICA do app: o
 * nascimento (`missions:guiSpec`) e o re-arme por spawn (`guiPlannerArm`) leem
 * daqui, para não existir a divergência que já produziu um chat mudo em 08-17.
 *
 * - `planner`   — missão de PLANEJAMENTO: o kit de planos, como sempre.
 * - `delegator` — missão de DEV (dev/reviewer/helper): o kit de ajudantes.
 * - `none`      — o resto. Chat sem ferramenta continua conversando; é o que
 *                 todo pane GUI foi até a onda D.
 *
 * AS DUAS AUSÊNCIAS SÃO `none`, de propósito: um pane órfão (missão apagada)
 * não herda autoridade por parecer com o endereço de uma que existia, e um
 * endereço que não é de missão (`gui-plan-<projeto>`, um shell) não ganha kit
 * nenhum por estar perto de uma missão.
 */
export type GuiPaneToolKind = 'planner' | 'delegator' | 'release' | 'none'

export function guiPaneToolKind(
  paneId: string,
  mission: { missionType?: string } | undefined
): GuiPaneToolKind {
  if (!mission || !guiMissionRoleOf(paneId)) return 'none'
  // O tipo da MISSÃO decide, não o papel do pane: o planejamento roda num pane
  // `gui-dev-<id8>` (papel dev, missão de planejamento) e é planejador. Missão
  // legada sem carimbo é 'dev' por definição — nada no disco muda de natureza.
  if (missionTypeOf(mission) === 'planejamento') return 'planner'
  // R10: a missão de RELEASE tem catálogo próprio (release_status/release_run)
  // — ela nunca delega nem integra missão; a subida da versão é o show inteiro.
  if (missionTypeOf(mission) === 'release') return 'release'
  return 'delegator'
}

/**
 * As QUINZE ferramentas internas dos papéis que compartilham este arm
 * (`gui-delegator` e, desde a R10, `gui-release`), no nome que o claude usa
 * (`mcp__<servidor>__<tool>`; o servidor é `synkora`, escrito por
 * `writeClaudeMcpConfig`). Elas são PRÉ-SANCIONADAS: aprovar a ferramenta do
 * próprio app não é decisão do dono, é encanamento — a mesma doutrina que faz
 * o `CodexSession` aceitar em silêncio a elicitation de aprovação do codex.
 *
 * A lista é a UNIÃO dos catálogos possíveis de um pane `gui-delegator`, e isso
 * é deliberado: o chat de DEV recebe as sete de ajudante MAIS as duas de
 * integração (R9), enquanto reviewer e ajudante recebem só as sete. Anunciar
 * aqui uma ferramenta que aquele pane não tem custa ZERO (`--allowedTools` não
 * cria catálogo, só pré-aprova nomes), e o contrário custaria caro: um card de
 * permissão para o dono no exato gesto que ele acabou de pedir.
 *
 * MEDIDO no claude 2.1.234 (sonda 2026-08-18, `scratchpad/probe-elicit/claude`):
 * sem esta flag, `permissionMode: 'default'` levanta `can_use_tool` para
 * `mcp__synkora__list_seats` (card de permissão para o dono); com ela, ZERO
 * permissões, a tool responde, e `--disallowedTools` continua valendo no mesmo
 * spawn (Task/Agent/ToolSearch ausentes de um catálogo de 25 ferramentas).
 * `--allowedTools` NÃO filtra catálogo — Bash/Read/Edit seguem lá, e seguem
 * pedindo o que sempre pediram.
 *
 * A lista é fechada de propósito: ferramenta nova no catálogo do delegador tem
 * de entrar aqui à mão, e `scripts/test-gui-delegate-mcp.mjs` prende o par.
 */
export const GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  'mcp__synkora__delegate',
  'mcp__synkora__list_seats',
  'mcp__synkora__helpers_status',
  'mcp__synkora__helper_result',
  'mcp__synkora__helper_send',
  // O par da interrupção (R6.2). Sem a pré-sanção do `resume`, retomar um
  // ajudante parado levantaria card de permissão para o dono — justamente no
  // gesto que ele acabou de pedir.
  'mcp__synkora__helper_resume',
  'mcp__synkora__helper_cancel',
  // R9 — o AGENTE é o integrador. Sem a pré-sanção, o ⇪ do dono levantaria um
  // card de permissão para ele aprovar a ferramenta que ele mesmo acabou de
  // acionar com o clique.
  'mcp__synkora__integration_status',
  'mcp__synkora__integration_run',
  // R10 — o chat de RELEASE. Mesma doutrina: o botão do dono abriu a conversa;
  // um card de permissão sobre a ferramenta do próprio gesto seria atrito puro.
  'mcp__synkora__release_status',
  'mcp__synkora__release_run',
  // R14 — o kit de CÓDIGO, derivado da fonte em vez de copiado: `lsp_*` é a
  // única família que os QUATRO papéis compartilham, e uma lista escrita à mão
  // aqui é exatamente como uma tool nova volta a levantar card de permissão no
  // gesto que o dono acabou de pedir. Ler código não decide nada — pedir
  // aprovação para isso seria atrito puro.
  ...LSP_TOOL_NAMES.map((tool) => `mcp__synkora__${tool}`)
]

/** Flags do claude: config por arquivo + strict + a cerca + a pré-sanção. */
export function guiDelegateClaudeArgs(mcpFile: string): string[] {
  return [
    // `--strict-mcp-config`: o chat que delega não herda MCP do seat. Servidor
    // herdado dentro de um chat com autoridade para abrir frota seria
    // superfície nova que ninguém pediu.
    ...claudeMcpArgs(mcpFile, true),
    '--disallowedTools',
    CLAUDE_NATIVE_AGENT_FENCE.join(','),
    '--allowedTools',
    GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS.join(',')
  ]
}

/** Overrides `-c` do codex: os do planejador + teto de tool + a cerca. */
export function guiDelegateCodexArgs(port: number): string[] {
  return [
    ...guiPlannerCodexArgs(port),
    '-c',
    `mcp_servers.synkora.tool_timeout_sec=${GUI_DELEGATE_CODEX_TOOL_TIMEOUT_SEC}`,
    '-c',
    CODEX_NATIVE_AGENT_FENCE_ARG
  ]
}

/**
 * Registra a identidade `gui-delegator` do pane e devolve as flags do spawn.
 * `undefined` = servidor ainda não subiu: o chat nasce sem tools em vez de
 * nascer apontando para uma porta que não existe (reabrir a conversa arma).
 *
 * IDEMPOTENTE POR PANE, e isso é contrato, não economia: a spec é pedida a cada
 * remontagem do chat, mas o fingerprint do spawn não muda — o processo CONTINUA
 * VIVO com o token que leu no nascimento. Emitir token novo aqui deixaria o
 * arquivo de config e o processo em desacordo, e o chat perderia as ferramentas
 * sem nenhum sinal. O reuso exige o MESMO papel: um endereço que já foi
 * planejador não herda o token, porque o catálogo mudaria embaixo dele.
 */
export function armGuiDelegateMcp(
  input: GuiDelegateMcpInput,
  deps: GuiPlannerMcpDeps,
  /** R10: a missão de RELEASE arma o MESMO encanamento com catálogo próprio —
   *  o papel do token decide o early-return do servidor. */
  role: 'gui-delegator' | 'gui-release' = 'gui-delegator'
): GuiPlannerMcp | undefined {
  const port = deps.port()
  if (port === 0) return undefined
  const previous = deps.tokenOf(input.paneId)
  const live = previous ? deps.hub.identityByToken(previous) : undefined
  const reusable =
    previous && live?.paneId === input.paneId && live.role === role ? previous : undefined
  const token = reusable ?? randomUUID()
  deps.hub.registerPane(token, {
    paneId: input.paneId,
    projectId: input.projectId,
    role,
    cwd: input.cwd,
    ...(input.seatId ? { seatId: input.seatId } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {})
  })
  if (input.cli === 'claude') {
    const mcpFile = writeClaudeMcpConfig(deps.configRoot(), input.paneId, port, token)
    deps.remember(input.paneId, { token, mcpFile })
    return {
      args: guiDelegateClaudeArgs(mcpFile),
      env: { MCP_TOOL_TIMEOUT: String(GUI_DELEGATE_CLAUDE_TOOL_TIMEOUT_MS) }
    }
  }
  deps.remember(input.paneId, { token })
  return {
    args: guiDelegateCodexArgs(port),
    env: { [GUI_PLANNER_TOKEN_ENV]: token }
  }
}
