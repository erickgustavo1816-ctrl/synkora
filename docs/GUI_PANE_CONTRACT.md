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
| `gui:send` | `(paneId, text) => {ok}` | turno novo (ocupado = steering/fila do próprio backend) |
| `gui:permission` | `(paneId, requestId, behavior: GuiPermBehavior) => {ok}` | responde o card de permissão |
| `gui:interrupt` | `(paneId) => {ok}` | interrompe o turno |
| `gui:kill` | `(paneId) => {ok}` | encerra a sessão do pane |
| `gui:state` | `(paneId) => {events: GuiLivePayload['evt'][]}` | replay p/ remontagem (main guarda ring buffer ~500 eventos por pane) |
| `gui:attach` | `(paneId, payload: GuiAttachPayload) => {ok, path?, error?}` | anexo do composer: grava e devolve o caminho ABSOLUTO |

### Anexos (`gui:attach`)

```ts
type GuiAttachPayload =
  | { kind: 'clipboard-image' }                          // o main lê o clipboard nativo
  | { kind: 'file'; name: string; bytesBase64: string }   // arquivo escolhido/solto
interface GuiAttachResult { ok: boolean; path?: string; error?: string }
```

- Destino: `<cwd do pane>/.synkora/attachments`, com o cwd vindo do REGISTRO de
  sessões (`GuiSessionRegistry.cwdOf`) — nunca de um caminho do renderer; pane
  sem sessão é recusado. A pasta é criada na hora e `.synkora` entra no
  git-exclude antes da primeira escrita.
- O `path` de volta é ABSOLUTO: é ele que o composer cita no prompt para o
  agente abrir o arquivo.
- Anexo nunca sobrescreve anexo: nome colidido ganha sufixo `-1`, `-2`…
- Teto de **10 MB por arquivo** (`GUI_ATTACHMENT_MAX_BYTES`), medido no base64
  ANTES de alocar o buffer; acima disso volta `{ok:false, error}` em PT-BR.
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
- O main persiste `paneId → {sessionId, cli}` num documento (`userData/gui-sessions.json`,
  padrão jsonStore) para resume pós-boot; a morte do pane NÃO apaga (resume é decisão
  de quem reabre).
- Env do filho: mesmas higienes do pty (deletar `CLAUDE_CODE_*`/`CLAUDECODE`; nunca
  herdar marcador de child session).

## Regras do pane (renderer)

- `Pane.kind?: 'tui' | 'gui'` (ausente = tui). `PanesView` renderiza `GuiPane` no
  lugar de `TerminalPane` quando `kind === 'gui'`. Mesmo deck, mesmo chrome
  (`PaneChrome`: badges de modelo/effort/contexto vêm dos eventos `init`/`result`).
- Visual papel & painel: o corpo do chat é PAINEL ESCURO (`--panel`, padrão
  .term-window), texto claro, tool cards compactos, card de permissão com borda
  `--accent` e botões permitir / sempre / negar; input embaixo (Enter envia,
  Shift+Enter quebra linha).
- Permissão pendente → mesmo pulso `needs-perm` dos panes de hoje (store
  `paneAttention`).
- Estado por pane no store (fatia `guiPanes: Record<paneId, …>`), alimentado pelo
  listener de `gui:live` + replay de `gui:state` na montagem.
- Fechar o pane chama `gui:kill` (via fluxo de fechar existente).

## O que NÃO entra nesta onda

Abrir o pane GUI a partir de missão (onda B), layout de missões à esquerda (onda B),
remoção de maestro/orquestrador (onda B/C), attachments/imagens no input (depois),
slash commands no input (depois — `gui:send` cru já cobre).
