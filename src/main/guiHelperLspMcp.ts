/**
 * O KIT LSP DO AJUDANTE (R14, seção L3 do design
 * `.synkora/reports/DESIGN_COPIA_E_LSP_R14_2026-08-19.md`).
 *
 * Ordem do dono (19/08): "voltar com o LSP, tanto para agente quanto para
 * sub-agente". Este módulo é a metade dos AJUDANTES: um bearer por ajudante,
 * papel `ajudante` no hub, raiz = o worktree dele, e as flags que apontam os
 * dois CLIs para o servidor MCP HTTP local.
 *
 * A CERCA DO D1 CONTINUA FECHADA, e é por isso que este módulo existe separado
 * do motor: o `GuiHelperSpawnRequest` (guiHelperSessions.ts) NÃO ganhou campo de
 * ferramenta nenhum. O kit é DERIVADO do registro do próprio ajudante (id, cwd,
 * projeto, delegador) DENTRO do adaptador — o chamador não pede, não escolhe e
 * não consegue passar. Frota que abre frota continua impossível por DUAS vias:
 *   1. o pedido não tem por onde carregar um catálogo;
 *   2. o papel `ajudante` não tem `delegate` no servidor (o catálogo por papel
 *      vive no `mcpServer.ts`; antes de ele existir, o papel recebe catálogo
 *      VAZIO — o ajudante autentica e não enxerga uma linha).
 *
 * É um IRMÃO do `guiPlannerMcp`/`guiDelegateMcp` (mesmo token por identidade,
 * mesmas flags por CLI, mesma limpeza), com uma diferença que muda tudo: o pane
 * de um chat VIVE e re-arma idempotente; o ajudante é um PROCESSO que nasce e
 * morre, então cada vida ganha token novo e toda morte revoga o anterior.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { claudeMcpArgs, writeClaudeMcpConfig } from './mcpServer'
import { GUI_PLANNER_TOKEN_ENV, guiPlannerCodexArgs } from './guiPlannerMcp'
import { BROWSER_TOOL_NAMES } from './guiBrowserTools'
import { LSP_TOOL_NAMES } from './guiLspTools'
import { SKILL_TOOL_NAMES } from './guiSkillKit'
import type { GuiHelperCli } from './guiHelperSessions'
import type { Hub } from './hub'

/**
 * As QUATRO tools do kit, no nome base do servidor. A FONTE é uma só
 * (`LSP_TOOL_NAMES`, em `guiLspTools.ts` — a mesma que o catálogo do papel
 * `ajudante` registra no `mcpServer.ts`): as ondas L2/L3 nasceram em worktrees
 * separados com duas listas à mão, e a integração as unificou de propósito —
 * divergir em silêncio significaria um card de permissão para o dono no meio
 * de uma sessão headless, que é justamente o beco que a pré-sanção evita.
 */
export const GUI_HELPER_LSP_TOOLS: readonly string[] = LSP_TOOL_NAMES

/**
 * Os mesmos quatro nomes como o claude os chama (`mcp__<servidor>__<tool>`; o
 * servidor é `synkora`, escrito por `writeClaudeMcpConfig`).
 *
 * A PRÉ-SANÇÃO NÃO É CONFORTO, É SOBREVIVÊNCIA: sem `--allowedTools`, uma tool
 * MCP em `permissionMode: 'default'` levanta `can_use_tool` (medido no claude
 * 2.1.234, sonda `probe-elicit/claude` registrada no `guiDelegateMcp`). Num chat
 * o dono clica; numa sessão de AJUDANTE não há ninguém para responder — e o
 * motor traduz pedido de permissão em desfecho fatal (`HELPER_PERMISSION_DEAD_END`).
 * Ou seja: sem esta lista, o primeiro `lsp_diagnostics` MATA o ajudante.
 */
export const GUI_HELPER_LSP_CLAUDE_ALLOWED_TOOLS: readonly string[] = [
  // O BROWSER DA CASA (build de 2026-08-29): o catálogo do papel `ajudante`
  // serve as browser_* (QA delegado é o caso real), então a pré-sanção as
  // cobre pela MESMA fonte que o mcpServer registra — sem elas aqui, o
  // primeiro `browser_read` de um ajudante claude morreria no can_use_tool,
  // a lição exata deste cabeçalho.
  ...GUI_HELPER_LSP_TOOLS,
  ...BROWSER_TOOL_NAMES,
  // SKILLS 3.0 (2026-09-08): o catálogo do papel `ajudante` serve as `skill_*`
  // (o briefing dele já lista o harness da missão, mas uma fatia pode precisar de
  // um playbook que ninguém previu). Derivadas da MESMA fonte, pela lição deste
  // cabeçalho: sem elas aqui, o primeiro `skill_search` de um ajudante claude
  // morreria no can_use_tool — e a morte é o desfecho, não um aviso.
  ...SKILL_TOOL_NAMES
].map((tool) => `mcp__synkora__${tool}`)

/**
 * O endereço do ajudante no hub. NÃO é um pane e não pode parecer um: o prefixo
 * `gui-` é reservado à convenção de missão (`guiMissionRoleOf` casaria
 * `gui-helper-<id8>-<n>`, que é um pane de terminal de missão, coisa de outra
 * era) e o prefixo `helper:` é do CARD da lateral. Nada de `:` nem `/`: este id
 * vira NOME DE ARQUIVO da config do claude (armadilha do Windows paga em 08-17).
 */
export const GUI_HELPER_MCP_PANE_PREFIX = 'helper-mcp-'

export function guiHelperMcpPaneId(helperId: string): string {
  return `${GUI_HELPER_MCP_PANE_PREFIX}${helperId}`
}

/** O que o spawn do ajudante carrega para falar com o Synkora. */
export interface GuiHelperLspKit {
  /** Identidade registrada no hub — a chave da revogação. */
  paneId: string
  /** Bearer deste ajudante, desta vida. */
  token: string
  /** Flags extras do CLI (claude: --mcp-config; codex: -c mcp_servers.*). */
  args: string[]
  /** Env extra do processo (o codex lê o bearer daqui). */
  env?: Record<string, string>
  /** Config JSON do claude, para o disarm apagar exatamente esta. */
  mcpFile?: string
}

export interface GuiHelperLspInput {
  helperId: string
  projectId: string
  /** Quem abriu este ajudante — viaja na identidade para a correlação. */
  delegatorPaneId: string
  /** Worktree do ajudante: é a RAIZ à qual o motor LSP confina os caminhos. */
  cwd: string
  cli: GuiHelperCli
  seatId?: string
}

/**
 * A fatia do Hub que este módulo tem autoridade para usar: registrar e revogar
 * identidade. Publicar evento não é assunto de kit de ferramenta — declarar a
 * fatia é o que impede isso de crescer sem alguém decidir.
 */
export type GuiHelperLspHub = Pick<Hub, 'registerPane' | 'unregisterPane'>

export interface GuiHelperLspDeps {
  hub: GuiHelperLspHub
  /** Porta do servidor MCP local; 0 = ainda subindo (o ajudante nasce sem kit). */
  port(): number
  /** userData/mcp — onde a config por identidade do claude é gravada. */
  configRoot(): string
}

/**
 * ARMA o ajudante: identidade no hub + flags do CLI. `undefined` = ele nasce SEM
 * ferramenta, e isso é a saída honesta em três casos — servidor fora do ar,
 * escrita da config recusada e arquivo que não sobreviveu à escrita.
 *
 * A prova do arquivo é a lição de 2026-08-17 (o chat mudo): o claude recebe
 * `--mcp-config <arquivo>` e MORRE com exit 1 se ele não existir. Um ajudante que
 * morre no boot custa uma fatia de trabalho inteira; um ajudante sem LSP só
 * trabalha como trabalhava ontem.
 *
 * A revogação preventiva na primeira linha é cinto: uma vida anterior deste
 * mesmo ajudante (interrompida, retomada) não pode deixar um bearer válido para
 * trás — o `unregisterPane` é idempotente e um id nunca registrado só devolve
 * `undefined`.
 */
export function armGuiHelperLspMcp(
  input: GuiHelperLspInput,
  deps: GuiHelperLspDeps
): GuiHelperLspKit | undefined {
  const port = deps.port()
  if (port === 0) return undefined
  const paneId = guiHelperMcpPaneId(input.helperId)
  deps.hub.unregisterPane(paneId)
  const token = randomUUID()
  deps.hub.registerPane(token, {
    paneId,
    projectId: input.projectId,
    role: 'ajudante',
    cwd: input.cwd,
    delegatorPaneId: input.delegatorPaneId,
    ...(input.seatId ? { seatId: input.seatId } : {})
  })
  if (input.cli !== 'claude') {
    return { paneId, token, args: guiHelperLspCodexArgs(port), env: { [GUI_PLANNER_TOKEN_ENV]: token } }
  }
  let mcpFile: string
  try {
    mcpFile = writeClaudeMcpConfig(deps.configRoot(), paneId, port, token)
  } catch {
    // Disco cheio, permissão negada, userData sumindo: o token não pode
    // sobreviver a um kit que não existe.
    deps.hub.unregisterPane(paneId)
    return undefined
  }
  if (!existsSync(mcpFile)) {
    deps.hub.unregisterPane(paneId)
    return undefined
  }
  return { paneId, token, args: guiHelperLspClaudeArgs(mcpFile), mcpFile }
}

/**
 * REVOGA: o bearer sai do hub e a config do claude sai do disco. Chamado em TODO
 * desfecho (entrega, falha, cancelamento, interrupção, morte no nascimento) —
 * um token que sobrevivesse ao processo seria autoridade sem dono, e o
 * `helper_resume` arma outro na volta.
 *
 * Idempotente por contrato: o motor descarta o processo mais de uma vez (o
 * `dispose` do adaptador é chamado no `settle` e no `discard`), e um arquivo que
 * já sumiu é o caso NORMAL aqui.
 */
export function disarmGuiHelperLspMcp(kit: GuiHelperLspKit, deps: GuiHelperLspDeps): void {
  deps.hub.unregisterPane(kit.paneId)
  if (!kit.mcpFile) return
  try {
    unlinkSync(kit.mcpFile)
  } catch {
    // Arquivo já apagado (ou travado) nunca segura a revogação do token, que é
    // a metade que importa: sem bearer, o arquivo é uma folha de papel.
  }
}

/**
 * Flags do claude: config por arquivo + strict + a pré-sanção das quatro tools.
 *
 * `--strict-mcp-config`: o ajudante não herda os MCPs do seat. Ele já roda com a
 * mão do delegador (bypass, em geral) num worktree compartilhado; servidor de
 * terceiro entrando por herança seria superfície que ninguém pediu.
 *
 * A CERCA ANTI-NATIVO (`--disallowedTools`) NÃO mora aqui: ela é do
 * `claudeHelperArgs`, e as duas convivem no mesmo spawn (medido — a lista de
 * proibidos continua valendo com `--allowedTools` presente).
 */
export function guiHelperLspClaudeArgs(mcpFile: string): string[] {
  return [
    ...claudeMcpArgs(mcpFile, true),
    '--allowedTools',
    GUI_HELPER_LSP_CLAUDE_ALLOWED_TOOLS.join(',')
  ]
}

/**
 * Overrides `-c` do codex — os MESMOS três do chat (url, env do bearer e a folga
 * de partida), sem nada a mais: o teto de tool do delegador existe para o
 * long-poll de 240s do `helper_result`, e nenhuma pergunta de LSP chega perto
 * disso (o motor corta em 20s por pedido e 15s de diagnóstico).
 */
export function guiHelperLspCodexArgs(port: number): string[] {
  return guiPlannerCodexArgs(port)
}
