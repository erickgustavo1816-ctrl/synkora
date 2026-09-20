# Contrato do Pane GUI (Synkora 2.0)

O pane GUI substitui o pane TUI: onde hoje nasce um xterm com o CLI dentro, nasce um
CHAT (mensagens, tool cards, card de permissão com botões, input). O motor é o que já
existe: `MaestroSession` (claude, stream-json) e `CodexSession` (codex, app-server),
instanciados POR PANE. Este contrato fixa os nomes e formas da costura para dois
agentes construírem em paralelo (motor/main × pane/renderer) sem colisão.

## Respostas rápidas de aprovação (2026-09-11)

Pedidos de aprovação conversacional devem usar a pergunta estruturada do CLI
(`AskUserQuestion`, `request_user_input` ou `request_user_input_async`), com a
proposta identificada na pergunta e as opções **Aprovar** e **Não aprovar**.
Uma pergunta única, de escolha única e com duas opções usa botões que enviam
a resposta diretamente. O rótulo escolhido e o ID/texto da pergunta seguem
pelo mesmo canal `gui:answerQuestion`, com a trava de envio já existente.

**Outra resposta** permite escrever um ajuste quando o pedido aceita texto
livre. Abrir o cartão, Enter sem escolha, silêncio e **Pular** não aprovam.
Perguntas múltiplas ou de múltipla escolha mantêm o fluxo de seleção e envio.
Não há inferência nova sobre o texto da IA; a barra legada de aceite mantém
seu detector e passa a oferecer também **Não aprovar**. Esses cliques não
substituem permissões de ferramentas nem os botões de integração/publicação.

## Papéis

- **Agente MOTOR** é dono de: `src/main/guiSessions.ts` (novo), seams mínimos em
  `src/main/index.ts` (handlers IPC), ajustes ADITIVOS em `src/main/maestroSession.ts`
  e `src/main/codexSession.ts`, e `src/preload/index.ts` + `index.d.ts` (namespace
  `gui`). NÃO toca no renderer.
- **Agente PANE** é dono de: `src/renderer/src/components/GuiPane.tsx` (novo),
  `src/renderer/src/guiApi.ts` (novo — accessor tipado, cópia dos tipos abaixo),
  fatia nova no `store.ts`, ramo de render no `PanesView.tsx`, estilos no
  `global.css`. NÃO toca em main/ nem preload/.

## Tipos (fonte única — copiar VERBATIM nos dois lados)

```ts
export interface GuiPaneSpawn {
  paneId: string;
  projectId: string;
  cli: 'claude' | 'codex';
  /** Config dir isolado do seat (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  configDir: string;
  /** Worktree da missão (ou raiz do projeto no planejamento). */
  cwd: string;
  model?: string;
  effort?: string;
  /** Persona/contrato curto (claude: append-system-prompt; codex: developerInstructions). */
  systemPrompt?: string;
  /** Retomar conversa existente (claude sessionId / codex thread id). */
  resumeSessionId?: string;
  /** BRIEFING da missão. NÃO abre turno: o motor o segura como pendente e o
   *  entrega colado à PRIMEIRA mensagem do dono (ver "O pane nasce mudo"). */
  firstPrompt?: string;
}

export type GuiPermBehavior = 'allow' | 'allow-always' | 'deny';

/** Evento vivo empurrado ao renderer. `evt` é o SessionEvent dos backends
 *  (maestroSession.ts — kinds: init, delta, thinking, text, tool, tool-result,
 *  permission, permission-cancel, session-id, ready, command-output, limit,
 *  result, fatal, closed). */
export interface GuiLivePayload { paneId: string; evt: unknown /* SessionEvent */ }
```

## IPC (invoke) — preload expõe como `window.synkora.gui`

| Canal | Assinatura | Efeito |
|---|---|---|
| `gui:create` | `(spawn: GuiPaneSpawn) => {ok, error?}` | instancia a sessão do pane; emite eventos em seguida |
| `gui:configureExecutor` | `(paneId, {model?, effort?}) => {ok, model?, effort?}` | troca confirmada no processo vivo, sem respawn nem linha visual |
| `gui:send` | `(paneId, text, messageId, attachments?) => {ok}` | turno novo idempotente por `messageId`; o main revalida os anexos antes de citar qualquer caminho ao CLI |
| `gui:deliverQueued` | `(paneId, {id,text,at,options,attachments}) => {ok}` | reaplica permissão/executor e envia a fotografia inteira da fila sob uma única trava |
| `gui:permission` | `(paneId, requestId, behavior: GuiPermBehavior) => {ok}` | responde o card de permissão |
| `gui:interrupt` | `(paneId) => {ok}` | interrompe o turno |
| `gui:kill` | `(paneId) => {ok}` | encerra a sessão do pane |
| `gui:state` | `(paneId) => {events: GuiLivePayload['evt'][]}` | replay p/ remontagem (main guarda ring buffer ~500 eventos por pane) |
| `gui:fileOpen` | `(paneId, reference, selectedPath?, mode?: 'auto' \| 'preview' \| 'browser') => GuiFileOpenResult` | revalida o arquivo na raiz da conversa; `auto` abre artefatos renderizáveis no browser da missão e código no leitor; `preview` pede o leitor e `browser` pede a prévia explícita |
| `gui:attach` | `(paneId, payload: GuiAttachPayload) => {ok, attachment?, error?}` | anexo do composer: grava/referencia e devolve descritor durável |
| `gui:attachFolder` | `(paneId) => {ok, attachment?, cancelled?, error?}` | abre o diálogo nativo e referencia qualquer pasta local, sem copiar a árvore |
| `gui:answerPlanProposal` | `(paneId, requestId, approve, text?) => {ok, error?}` | desfecho do card de PROPOSTA DE PLANO (2026-08-15): `approve=true` cria o Plan (o draft autoritativo sai do RING do pane, nunca do renderer) e injeta o recibo na conversa; `approve=false` exige `text` e devolve a prosa do dono ao agente |

### Proposta de plano (2026-08-15, missão de planejamento)

O pane de PLANEJAMENTO nasce com o MCP `gui-planner` (catálogo mínimo:
`list_plans`/`get_plan`/`propose_plan`/`update_plan`/`delete_plan`; cerca de
early-return no buildServer — nenhum outro papel vê essas tools). `propose_plan`
NUNCA cria: o main injeta no ring o evento `plan-proposal {requestId, draft}`
(draft = `{title, description?, kind, items[{key, title, objective, outOfScope?,
doneCriteria[], tier?, context?, dependsOn[] /* keys de itens ANTERIORES */,
docPath?}]}`), que atravessa os CINCO ESPELHOS como os irmãos
permission/question/plan-review e vira o `GuiPlanProposalCard` no fio. Diferença
deliberada do trio: `plan-proposal` NÃO bloqueia o CLI, então sobrevive ao
`result` no ring; um `propose_plan` novo SUPERSEDE a proposta pendente do mesmo
pane (eco factual `stale`). O desfecho volta como `interaction-resolved`
`{kind:'plan-proposal', approve, planId?, planTitle?}`.

COREOGRAFIA DO CARD (2026-08-16, ordem do dono depois de ver o card nascer no
meio da fala e sumir): a proposta chega COM O AGENTE AINDA FALANDO — a tool
responde na hora e o turno segue. Três regras, e as três são obrigatórias:

1. A isenção terminal vale nos DOIS ESPELHOS, não só no anel. O redutor do
   renderer conserva `plan-proposal` em `result`, `fatal` e `closed`
   (`retainGuiInteractionsAfterTurnEnd`); só as pendências que BLOQUEIAM o CLI
   morrem com o turno. Espelhos discordando = card que some sozinho.
2. Pendência que não bloqueia não deixa o fio "parado". O meio do turno decide
   status por `guiInteractionBlocksTurn`, nunca por "a fila tem alguém": com a
   proposta contando como parada, todo delta seguinte virava `waiting-you`.
3. A APRESENTAÇÃO espera o turno fechar (`isGuiTurnActive` = `working` ou
   stream aberto). O card fica na fila o tempo todo, aparece embaixo da resposta
   pronta e FICA — atravessando os turnos seguintes — até o dono decidir; e,
   enquanto está invisível, não suspende o composer. O PLANNING_CONTRACT manda
   o agente fechar a fala anunciando o plano logo abaixo.

O caminho de persistência já atendia a isso e continua sendo cerca: o evento
entra em `guiTranscriptCheckpoint`, passa por `isGuiPersistedEvent` (draft
TOTAL) e o `snapshot()` reproduz as pendências POR ÚLTIMO — um `result`
histórico nunca apaga o card durante a remontagem.

### Anexos (`gui:attach`)

```ts
type GuiAttachPayload =
  | { kind: 'clipboard-image' }                          // o main lê o clipboard nativo
  | { kind: 'file'; name: string; bytesBase64: string }   // arquivo escolhido/solto
  // pasta não atravessa este payload: a seleção é feita por `gui:attachFolder`

type GuiAttachmentDescriptor = {
  id: string
  kind: 'file' | 'image' | 'folder'
  name: string
  path: string
  size: number | null
}

interface GuiAttachResult {
  ok: boolean
  attachment?: GuiAttachmentDescriptor
  cancelled?: boolean
  error?: string
}
```

- Destino de arquivos: `<cwd do pane>/.synkora/attachments`, com o cwd vindo do REGISTRO de
  sessões (`GuiSessionRegistry.cwdOf`) — nunca de um caminho do renderer; pane
  sem sessão é recusado. A pasta é criada na hora e `.synkora` entra no
  git-exclude antes da primeira escrita.
- O composer guarda descritores por pane (inclusive durante reload/troca de
  missão) e os mostra como chips removíveis; o texto humano não recebe caminhos
  escondidos. Ao enviar, os mesmos descritores acompanham a fila P1 e a bolha
  do usuário. Só então o main monta as referências físicas para o CLI.
- Pasta é somente uma referência real, sem cópia de árvore, e pode estar em
  qualquer diretório local escolhido pelo dono no diálogo nativo. Links
  simbólicos/junctions no alvo ou em qualquer trecho do caminho são recusados.
- `path` continua absoluto e exclusivamente interno ao main. O renderer pode
  persistir o descritor para recuperar a interface, mas não ganha autoridade:
  existência, tipo, link e limites são revalidados no envio.
- Anexo nunca sobrescreve anexo: nome colidido ganha sufixo `-1`, `-2`…
- Symlink/junction nos diretórios é recusado; o destino físico precisa continuar
  dentro do cwd e o arquivo nasce com criação exclusiva (`wx`).
- Teto de **50 MB por arquivo** (`GUI_ATTACHMENT_MAX_BYTES`), aplicado também
  ao tamanho bruto e ao formato estrito do base64 ANTES de alocar o buffer; no
  máximo 20 anexos e 50 MB de arquivos por mensagem.
- Falhas de anexação aparecem em um aviso não modal acima do composer, em portal,
  com mensagem curta e nome abreviado quando necessário. O aviso some após 5 s,
  pode ser fechado pelo dono, renova o prazo em uma nova falha e não toma foco
  nem altera a altura do campo de mensagem.
- Mensagens só com anexos (arquivo ou pasta), inclusive na fila, não desenham
  uma bolha de texto vazia. Espaços e quebras de linha sem palavras também
  contam como texto vazio. Os anexos alinham à direita com o rótulo do dono,
  inclusive quando ocupam várias linhas; legenda e controles de entrega continuam visíveis.
- O blackbox registra somente `kind` e sucesso/falha: nunca path, nome ou erro
  bruto de filesystem.
- As decisões puras (nome seguro, unicidade, teto) moram em
  `src/main/guiAttachments.ts` e são cobertas por `npm run test:gui-sessions`.

## Push (main → renderer)

- Canal **`gui:live`** com `GuiLivePayload`, enviado via `ctx.pushAll` (a panes view
  monta o pane; o host espelha status). O renderer acumula o estado por paneId.
- O preload (dono: agente MOTOR) expõe a subscrição:
  `window.synkora.gui.onLive(cb: (p: GuiLivePayload) => void): () => void`
  (retorna unsubscribe; mesmo padrão dos `on*` existentes). O agente PANE consome
  APENAS via o accessor tipado de `guiApi.ts`.

## Regras do motor

- **O PANE NASCE MUDO** (ordem do dono). `gui:create` abre o processo e NÃO
  manda nada: nenhum `turn-started`, nenhum `send`. O `firstPrompt` fica
  PENDENTE na entrada do pane (`pendingBriefing`) e sai colado à primeira
  mensagem do dono, num turno só — assim ele escolhe conta/modelo/effort/
  permissão num chat parado, e o agente recebe contrato e pedido juntos. O
  pendente ATRAVESSA respawn (trocar a permissão antes de escrever, entrega da
  fila com modo novo, remontagem): a herança é do ENTRY, porque
  `inheritConversation` e a entrega da fila zeram `firstPrompt` de propósito.
  `/clear` descarta o pendente — trocar de conversa é deliberado. O splice fica
  DEPOIS do `/clear` e do roteamento de slash: comando que não chega ao modelo
  não queima o briefing; e o teto de tamanho é conferido ANTES de qualquer
  marco no fio, para que uma recusa não deixe turno fantasma nem perca o
  briefing.
- Sessão POR PANE num `Map<paneId, …>`; `matches()` nunca reaproveita entre panes.
- As classes de sessão ganham `opts.idleTimeoutMs?: number` (0 = desliga) — ADITIVO,
  default preserva o comportamento atual dos chamadores existentes. Panes GUI usam 0
  (chat aberto não morre por tédio).
- Evento `thinking` ganha `text?: string` opcional (delta do raciocínio) quando o
  backend fornecer — aditivo, sem quebrar consumidores atuais.
- O main persiste `paneId → {sessionId, cli, model, effort}` (inclusive `null`
  para “padrão” explícito) e a fotografia limitada do
  transcript visível no documento `userData/gui-sessions.json` (padrão
  jsonStore). A morte do pane NÃO apaga nenhum dos dois: reabrir retoma o
  contexto do CLI e remonta o mesmo fio na tela. O documento retém no máximo
  64 fotografias / 32 MiB no total (as mais antigas saem primeiro).
- A mesma entrada do pane guarda somente a última fotografia canônica de
  contexto (`context-usage` ou `result`, com tokens e janela, vinculada ao
  `sessionId`). Ao reabrir a mesma identidade, o marco `session-restarted`
  reaplica essa fotografia antes do primeiro novo envio; `/clear`, compactação,
  troca de CLI/identidade ou perda do resume a removem. Transcript antigo de
  outra identidade nunca alimenta a régua.
- JANELA DE CONTEXTO É MEDIÇÃO, NÃO HEURÍSTICA DE STRING (Claude). A janela
  autoritativa vem do próprio CLI em `result.modelUsage[<modelo>].contextWindow`,
  indexada pelo `model` que o `system/init` anunciou — o mapa também traz modelos
  de tarefas auxiliares (haiku de título), então ler "o primeiro" mede o modelo
  errado. O `init` acontece antes de existir medição e carrega só um PISO curado
  por família (`claudeCuratedContextWindow`): marcador `[1m]` → 1M; haiku → 200K;
  fable/mythos/opus/sonnet → 1M; desconhecido → 200K conservador. Trocar de modelo
  reemite `init` e o `result` seguinte remede — a janela acompanha nos dois
  sentidos. SONDADO em `scripts/probe-claude-caps-context.mjs` (2.1.233,
  2026-08-15): o handshake `initialize` NÃO informa janela por modelo, e o `model`
  do init vem RESOLVIDO sem garantia do sufixo (`claude-fable-5[1m]` chega como
  `claude-fable-5`) — era essa a origem do "Fable 5 com 200k". Re-sondar a cada
  update de CLI antes de editar a tabela. O Codex segue com o
  `modelContextWindow` real do `tokenUsage` — nada a fazer lá.
  O PISO VALE SÓ ATÉ A PRIMEIRA MEDIÇÃO DO PROCESSO: o `init` REPETE a cada
  turno (inclusive nos ciclos autônomos), então reanunciá-lo apagaria a janela
  medida a cada volta — e o piso acabava PERSISTIDO na fotografia como se fosse
  medição. A sessão lembra a medição do modelo corrente e o init posterior
  anuncia ELA; trocar de modelo descarta a lembrança (medição do modelo antigo
  não vale para o novo) e o piso do modelo novo volta a valer até o `result`
  dele. Fotografia de conversa MORTA também não pinta a régua: a remontagem
  para respawn zera o par tokens/janela e espera o `session-restarted`, que é
  quem sabe se a conversa será retomada.
- `/clear` (e `/new` no Codex) cria conversa nova e apaga juntos o resume e o
  fio daquele pane. Arquivar só encerra o processo e preserva ambos; excluir
  definitivamente a missão ou o projeto também purga seus registros.
- Env do filho: mesmas higienes do pty (deletar `CLAUDE_CODE_*`/`CLAUDECODE`; nunca
  herdar marcador de child session).

## Subagentes em background (ciclo de vida)

A tool `Agent` do Claude roda em SEGUNDO PLANO por padrão (CLI 2.1.233). O
`tool_result` do despacho é só um RECIBO — confundi-lo com conclusão foi a
regressão de 2026-08-14 (lateral vazia com os agentes trabalhando, plim precoce,
falso erro no chat). Todo o ciclo de vida vem de SINAL ESTRUTURAL do protocolo,
nunca de heurística sobre nome de tool ou texto.

### Envelopes reais (capturados ao vivo, 132 envelopes)

| Envelope | Campos que importam | Papel |
|---|---|---|
| `system/task_started` | `task_id`, `tool_use_id`, `subagent_type`, `task_type`, `description`, `prompt` | ÚNICO envelope que une os dois espaços de id |
| ACK `user`/`tool_result` | `tool_use_result.isAsync`, `.status` (`async_launched`), `.agentId` (**== task_id**) | recibo de despacho |
| `system/task_updated` · `task_progress` | `task_id`, `patch.status` | andamento; NUNCA terminal |
| `system/task_notification` | `task_id`, `tool_use_id`, `status`, `summary`, `output_file`, `usage` | TERMINAL factual (o outro que tem os dois ids) |
| `system/background_tasks_changed` | `tasks[].task_id` | fotografia COMPLETA e autoritativa das tarefas vivas |

Traps do protocolo, todas fixadas em `npm run test:gui-sessions`:

- **`tasks` OMITIDO com o conjunto vazio** — `if (env.tasks)` nunca enxerga o
  zero. Ausência (ou payload torto) é conjunto VAZIO, senão o último agente
  fica imortal.
- **`status` é enum ABERTO** (`AgentOutput` em `sdk-tools.d.ts` é união por
  `status`): encerrar em QUALQUER valor terminal, nunca comparar com
  `"completed"` para decidir SE encerra — só para decidir COMO.
- **A fotografia chega ~1ms ANTES do `task_notification` do mesmo agente**
  (triplo atômico medido). A reconciliação decide só depois que o chunk inteiro
  atravessa o parser; a idempotência do encerramento resolve a corrida e o
  resumo verdadeiro vence.
- **`system/init` REPETE por ciclo, com o MESMO `session_id`** — a cada
  conclusão o CLI abre um turno raiz novo. Init NUNCA é ponto de reset.
- **O texto desses ciclos autônomos é RAIZ legítima** (inclusive a síntese
  final) e FICA no fio. Filho não emite delta: `parent_tool_use_id` é `null` em
  100% dos `stream_event`, e o filho entrega só a mensagem final, pós-hoc, com
  linhagem no topo do envelope.
- **O `result` raiz tem ZERO campo sobre background** (dump completo conferido).
- `--forward-subagent-text` existe e fica DESLIGADO (só aumentaria a superfície).

### `tool-result` ganha o ciclo de vida (contrato dos dois lados)

```ts
agentStatus?: 'launched' | 'settled'   // ausente = tool-result comum e Codex
agentTaskId?: string                   // task_id do CLI; presente sempre que agentStatus existir
```

- `launched` — recibo de despacho: `isError: false` e **`outcome` OMITIDO**. É a
  ausência de desfecho que diz "ainda trabalhando"; o card fica aberto e a
  lateral mostra o agente.
- `settled` — terminal factual (notificação, reconciliação ou cancelamento) com
  `outcome` + `isError` coerentes. Só aqui a entrada sai da lateral.
- Payload sem os campos novos se comporta EXATAMENTE como antes — é essa regra
  que mantém o Codex e todo tool-result comum intactos.
- **Nunca unificar os dois backends numa inferência compartilhada**: no Codex o
  pai só recebe `tool-result` no fim factual (`finishCollabParent`), então lá
  "pai tem result" JÁ é o terminal. O shape é espelhado, a lógica não.

### `continues` e o plim

`result.continues = fila de turnos do usuário não vazia **OU** registro de
agentes de fundo ativos`. Processos `local_bash`, como o servidor de preview,
não prolongam o turno depois da resposta final. Um tipo desconhecido continua
sendo tratado como trabalho ativo, de forma conservadora. O sequenciador de avisos (`guiNotices.ts`) já
parqueia em `continues: true` e drena no terminal final — com o `continues`
honesto ele passa a dar **um plim por turno lógico**, sem conhecer subagente.

O registro vive em `src/main/guiClaudeTasks.ts` (módulo puro, uma instância por
sessão, zerado em todo spawn — tarefa de fundo morre com o processo e nunca é
retomada). Só os DOIS joins registram (`task_started` e o ACK); a fotografia
reconcilia mas nunca adota tarefa desconhecida (sem `tool_use_id` não haveria
card para fechar). Interrupção confirmada, `closed`, `fatal` e dispose drenam
tudo e fecham cada card como `cancelled` ANTES do terminal correspondente.
Se a raiz já terminou, uma interrupção atua somente sobre os agentes ainda
ativos; um servidor de preview sozinho não exige confirmação de interrupção.
Terminais e confirmações atrasados são idempotentes e não encerram um turno
mais novo. A normalização de `turn-continuation` no main preserva a atividade
factual de agentes nativos e delegados via MCP antes de liberar o composer.

### Codex: o wire REAL dos sub-agentes

O Codex NÃO tem notificação de colaboração dedicada — tudo viaja nos frames
genéricos `item/started|completed`. O `collabAgentToolCall` existe, mas em
produção só chega com `tool: "wait"` ("o pai está bloqueado"), sempre com
`agentsStates: {}` e `receiverThreadIds: []`: inútil para identidade e para
encerramento. O caminho legado continua no código (config futura pode voltar a
emiti-lo), e ao lado dele mora o ingest do wire observado ao vivo (sonda ×3 no
`codex app-server` 0.147 + schema gerado pelo próprio binário).

| Frame | Campos que importam | Papel |
|---|---|---|
| `item/started` · `item/completed` com `item.type === "subAgentActivity"` (thread RAIZ) | `agentThreadId`, `agentPath`, `kind` (`started`\|`interacted`\|`interrupted`) | ÚNICO sinal de SPAWN. O par chega com payload IDÊNTICO ~1ms depois — dedupe por `agentThreadId` |
| qualquer frame com `threadId` do FILHO | `turn/started`, `item/*`, `item/agentMessage/delta`, `thread/tokenUsage/updated`, `thread/status/changed` | TRABALHO do sub-agente; hoje era 100% descartado pela guarda de thread |
| `turn/completed` com `threadId` do FILHO | `turn.status`, `turn.items[]` (último `agentMessage` com `phase: "final_answer"`) | TERMINAL FACTUAL — o único |

Traps do protocolo, todas fixadas em `npm run test:gui-sessions`:

- **`subAgentActivity` NÃO tem kind terminal** e `closeAgent` nunca foi
  observado ao vivo: quem esperar por um "close" vaza card para sempre. Quem
  encerra é o `turn/completed` do filho.
- **Não existe tool_use de spawn no wire**: o card do pai usa o id SINTÉTICO
  `codex-agent:<agentThreadId>` — estável entre frames e sem colisão com id de
  item do protocolo.
- **`agentsStates` chega SEMPRE vazio** e `model`/`prompt`/`reasoningEffort`
  vêm `null` em todo frame collab. O único nome humano é o ÚLTIMO SEGMENTO do
  `agentPath` (`/root/calculo` → `calculo`); `thread/started` de filho nunca é
  emitido, então nickname/role não existem para a UI.
- **`TurnStatus` e `CollabAgentStatus` são enums ABERTOS**: valor terminal
  desconhecido encerra como falha, nunca pendura. `notFound` (agente que sumiu
  do servidor) encerra; `pendingInit` não é desfecho.
- **O primeiro `turn/completed` da conexão costuma ser de um FILHO** — toda
  sonda futura precisa filtrar por `threadId === raiz` ou perde a cauda.
- Ferramenta feita rerunnável: `codex app-server generate-json-schema --out
  <dir>` (e `generate-ts`) emite o contrato autoritativo do binário INSTALADO.
  É o passo 1 de qualquer investigação de protocolo do Codex — nunca mais
  fixture escrita de memória. Sonda em `scripts/probe-codex-collab-agents.mjs`.

O registro vive em `src/main/guiCodexAgents.ts` (módulo puro, uma instância por
sessão, morto com o processo). O ingest emite:

- **spawn** → `tool` `{ name: 'spawn_agent', toolUseId: 'codex-agent:<id>',
  input: { name, agent_type: 'codex', path } }`. A lateral já mostra qualquer
  card com esse nome e metadados; nenhuma mudança de renderer foi necessária.
- **ferramenta do filho** → `tool`/`tool-result` com
  `parentToolUseId: 'codex-agent:<id>'` — vira a linha de atividade da lateral,
  e o chat já esconde todo card com `parentToolUseId`.
- **terminal** → `tool-result` no id sintético, com a resposta final do filho
  como texto. **Fala de filho NUNCA vira `text`/`delta`/`thinking`**, e o
  `tokenUsage` dele nunca toca a régua de contexto da raiz.

`turn/completed` da RAIZ fica RETIDO enquanto houver sub-agente vivo (mesma
mecânica do `deferredCollabResult`); o último settle drena. Todo caminho de
registro tem dreno garantido: `turn/completed` do filho, `subAgentActivity`
`interrupted`, turno raiz que não concluiu (interrupção/falha leva os filhos
junto), `closed`, `fatal` e dispose — e cada card de ferramenta do filho que
ficou sem retorno fecha JUNTO com o pai, senão o terminal do turno inventaria o
erro de órfão.

**Cerca A10**: evento emitido pelo Codex NUNCA carrega `agentStatus`/
`agentTaskId` — esses campos são do contrato Claude, onde "pai tem result"
ainda não é terminal. No Codex o `tool-result` do pai JÁ é o terminal factual.
Os dois backends espelham o SHAPE e nunca compartilham módulo de inferência.

### A regra dos cinco espelhos

A união de eventos é copiada em CINCO lugares. Esquecer um faz o evento morrer
em silêncio na hidratação ou no reducer:

1. `SessionEvent` — `src/main/maestroSession.ts`
2. `GuiSessionEvent` — `src/renderer/src/guiApi.ts`
3. `asGuiEvent` (validador do vivo) — `src/renderer/src/guiApi.ts`
4. `isGuiPersistedEvent` (validador do disco) — `src/main/guiSessions.ts`
5. reducer da fatia `guiPanes` — `src/renderer/src/store.ts`

Campo novo entra nos cinco na mesma mudança, com o validador aceitando somente o
vocabulário fechado (`agentStatus` ∈ {`launched`,`settled`}; `agentTaskId`
string de 1 a 256). Envelope de subtype DESCONHECIDO continua passando o guard e
virando no-op silencioso — isso é desejado, não descuido.

## Regras do pane (renderer)

- `Pane.kind?: 'tui' | 'gui'` (ausente = tui). `PanesView` renderiza `GuiPane` no
  lugar de `TerminalPane` quando `kind === 'gui'`. Mesmo deck, mesmo chrome
  (`PaneChrome`: badges de modelo/effort/contexto vêm dos eventos `init`/`result`).
- Visual papel: composer plano, com uma borda no padrão do app e sem sombra;
  `+` e permissão à esquerda, contexto/modelo/effort e envio no rodapé. O input
  fica sem borda interna (Enter envia, Shift+Enter quebra linha).
- Permissão pendente → mesmo pulso `needs-perm` dos panes de hoje (store
  `paneAttention`).
- Estado por pane no store (fatia `guiPanes: Record<paneId, …>`), alimentado pelo
  listener de `gui:live` + replay de `gui:state` na montagem.
- Enter durante `working` grava UMA mensagem em `synkora.guiQueue.<paneId>` com
  modelo/effort/permissão fotografados. Um despachante nas raízes dos dois
  renderers toma o bilhete por uma lease recuperável e entrega o envelope
  inteiro ao main quando o pane vira `idle`. O envelope permanece durável até o
  ACK. Se o renderer fechar, outra janela o reclama depois do prazo. O main
  coalesce entregas concorrentes do mesmo id e grava um recibo com TTL maior que
  a validade do envelope; retry/ACK perdido continua idempotente mesmo depois de
  restart ou evicção do transcript. Vencer a lease permite a retomada, mas não
  libera Editar/Apagar: essas ações só voltam depois de ACK ou falha explícita.
  Falha libera a lease no mesmo envelope com
  erro visível e só tenta novamente após a ação explícita do dono (também é
  possível editar ou apagar).
- Envio direto também espera `{ok:true}` do main antes de limpar texto e chips.
  Falha conserva a fotografia inteira; se o dono continuar digitando enquanto o
  ACK viaja, o conteúdo novo nunca é apagado pela resposta antiga.
- Rascunho não enviado vive em `synkora.guiDraft.<paneId>`, com debounce e
  descarte dos rascunhos mais antigos quando a quota local acaba.
- Cada superfície principal e cada `GuiPane`/`TerminalPane` fica dentro de um
  limite de erro recuperável; detalhes crus da exceção nunca aparecem nem vão
  para log, e apenas o painel defeituoso cai.
- Fechar o pane chama `gui:kill` (via fluxo de fechar existente).

## Browser: observações e verificações econômicas (2026-09-11)

O catálogo inclui `browser_check`: uma receita declarativa com até quatro
cenários, oito alvos e 24 ações no total. A receita roda localmente na aba da
identidade chamadora, verifica cada alvo e retorna um recibo limitado. Não há
uma inferência de IA por clique, espera ou largura. Falha, perda de identidade,
mudança de viewport pelo dono ou fim do orçamento suspendem os passos seguintes;
uma ação já enviada ao Chromium termina dentro do limite do driver antes de
liberar a próxima operação. O prazo não cancela comandos em voo.

`browser_read` e a leitura de `browser_open` usam observação compacta por
padrão, com corpo de até 1.500 caracteres e resposta total de até 2.000.
`scope` limita ao trecho relevante; `detail: 'full'` recupera detalhes maiores.
`baselineId` pede comparação somente com uma observação explícita ainda
compatível, não truncada e recente. Navegação, expiração, carregamento e sinais
de geometria/estilo invalidam a confirmação de estado repetido. O recibo de
igualdade é sobre as medições efetuadas, não uma comparação de todos os pixels.

Capturas de `browser_shot`/`browser_check` são artefatos para o dono por padrão.
`purpose: 'vision'` pede a imagem para análise pelo modelo. A aprovação estética
continua dependendo de inspeção visual; medidas e ausência de erro no console
não a substituem. O contrato orienta agrupar a verificação conhecida e repetir
somente após mudança, falha ou dúvida concreta. A telemetria registra operação,
duração, caracteres de retorno e quantidade de imagens, sem conteúdo da página.

## Artefatos clicáveis (2026-09-11)

Referências a HTML, imagens e mídia renderizável abrem uma aba do dono no
browser da missão. O menu oferece o browser explicitamente e mantém a leitura
do código. Ambiguidade exige selecionar o arquivo; essa seleção conserva a
intenção original. A abertura respeita o painel atual e o browser destacado.
PDF mantém a abertura anterior e a opção de programa padrão: o visualizador
nativo do Electron 43.1.1 falhou no controle com partição privada em memória,
portanto não é oferecido como prévia até haver renderização comprovada ali.

O main resolve a raiz física da conversa antes de abrir. A prévia usa um
servidor temporário em loopback para o documento selecionado e seus arquivos
estáticos permitidos, sem listar diretórios ou expor a raiz inteira. A aba de
artefato tem armazenamento efêmero próprio. A autorização é revalidada em cada
leitura; fechar a aba encerra a prévia. Endereços temporários de acesso são
redigidos em logs e retornos de ferramentas.

## Contadores de consumo (2026-09-11)

`context-usage.usage` carrega fotografias de `GuiUsageMeters` para a conversa
e a última rodada do dono. O registro no main deduplica IDs de mensagens do
Claude e calcula deltas dos totais do Codex; eventos repetidos e retomadas não
somam novamente. O renderer aplica a fotografia, sem acumular eventos.
Ausência de medição permanece indisponível, diferente de zero. A contagem
de chamadas exige IDs de requisição; registros antigos são rotulados como
registros de uso, não chamadas comprovadas.
Os metadados guardam até 2.048 IDs em 16 fontes. Se faltar identificação ou
esse limite for alcançado, a fotografia anuncia medição parcial; IDs antigos
não são descartados silenciosamente para depois serem contados novamente.

Entrada, gravação de cache, leitura de cache e saída são parcelas distintas.
Tokens-peso são uma estimativa e não equivalem ao percentual da assinatura.
Contexto ocupado, consumo da rodada, total da conversa, custo estimado informado
pelo CLI e limite real da conta são medidas separadas. Contabilidade e persistência
não fazem novas chamadas de IA nem entram no contexto do modelo.

## Compactação de contexto do Codex (2026-09-11)

O ciclo estruturado `contextCompaction` do app-server é traduzido em
`context-compaction { active }`, com escopo de thread/turno e deduplicação.
Enquanto ativo, o chat mostra **Compactando contexto…** no indicador de
atividade. A confirmação de aceite de `/compact` não encerra esse aviso.
Conclusão, interrupção, falha, novo turno ou reinício limpam a fase; o replay
de uma sessão ainda viva preserva-a, enquanto o replay para respawn a limpa.
Perguntas bloqueantes mantêm precedência sobre o indicador. Nenhuma frase do
modelo nem raciocínio interno é usado para inferir ou explicar compactação.

## O que NÃO entra nesta onda

Abrir o pane GUI a partir de missão (onda B), layout de missões à esquerda (onda B),
remoção de maestro/orquestrador (onda B/C).
