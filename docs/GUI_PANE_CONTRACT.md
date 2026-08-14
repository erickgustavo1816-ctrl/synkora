# Contrato do Pane GUI (Synkora 2.0)

O pane GUI substitui o pane TUI: onde hoje nasce um xterm com o CLI dentro, nasce um
CHAT (mensagens, tool cards, card de permissão com botões, input). O motor é o que já
existe: `MaestroSession` (claude, stream-json) e `CodexSession` (codex, app-server),
instanciados POR PANE. Este contrato fixa os nomes e formas da costura para dois
agentes construírem em paralelo (motor/main × pane/renderer) sem colisão.

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
  /** Primeiro turno injetado logo após o spawn (ex.: conteúdo do plano da missão). */
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
| `gui:attach` | `(paneId, payload: GuiAttachPayload) => {ok, attachment?, error?}` | anexo do composer: grava/referencia e devolve descritor durável |
| `gui:attachFolder` | `(paneId) => {ok, attachment?, cancelled?, error?}` | abre o diálogo nativo e referencia qualquer pasta local, sem copiar a árvore |

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
- Teto de **10 MB por arquivo** (`GUI_ATTACHMENT_MAX_BYTES`), aplicado também
  ao tamanho bruto e ao formato estrito do base64 ANTES de alocar o buffer; no
  máximo 20 anexos e 50 MB de arquivos por mensagem.
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
- `/clear` (e `/new` no Codex) cria conversa nova e apaga juntos o resume e o
  fio daquele pane. Arquivar só encerra o processo e preserva ambos; excluir
  definitivamente a missão ou o projeto também purga seus registros.
- Env do filho: mesmas higienes do pty (deletar `CLAUDE_CODE_*`/`CLAUDECODE`; nunca
  herdar marcador de child session).

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

## O que NÃO entra nesta onda

Abrir o pane GUI a partir de missão (onda B), layout de missões à esquerda (onda B),
remoção de maestro/orquestrador (onda B/C).
