# FASE 3 — multi-renderer (CHECK 2): plano formal da obra

Escrito 2026-08-08. Vertente B aprovada pelo dono ("meu PC tem 32GB"); ordem
vigente: FASE 3 → FASE 4 → teste de missão → push. Padrão das fases 1/2:
mapa → commits pequenos e verdes → validação.

> ESTADO FINAL (2026-08-08, mesma sessão): **OBRA CONCLUÍDA EM CÓDIGO** — os
> 6 commits saíram na ordem planejada (c0 3becc05 · c1 cce043d · c2 eda8d84 ·
> c3 92c82dd · c4 8387f47 · c5 ececd08 + re-aponte dcd4288), typecheck 0 e o
> gate completo verde (22 suítes, incl. o agregado skills-system). A Fase 4
> (QA Electron via CDP, agente Fable em worktree isolado) foi mergeada em
> 792e73a SEM conflito com a costura. Desvios conscientes do plano: SeatGate
> não força tab board (o hide por hostOverlayCount do D6 já cobre — menos
> mecanismo); `panes:attention-cleared` carrega projectId (assinatura real do
> clearPaneAttention); driver E2E corrigido no ato (exclui `?view=` do match
> de target CDP — D11). PENDENTE: validação AO VIVO pelo dono (primeiro
> `npm run dev` com a view: abrir projeto, aba Panes, missão com gates,
> agente livre, ▶ testar, ditado no canvas, crash/reload da view).

## 1. Objetivo e desenho

Dividir o renderer único em DOIS processos de renderer:

- **HOST (= "view board")**: a própria BrowserWindow de hoje — TitleBar,
  ProjectRail, Home, Settings, Universe com as abas Board (incl. a coluna
  maestro/orquestradores com seus TerminalPanes), Mapa, Versões e Arquivos.
- **VIEW "panes"**: UMA `WebContentsView` filha (`win.contentView.addChildView`)
  carregando o MESMO bundle com `?view=panes` — renderiza exclusivamente o
  canvas de Panes (PanesView + ConstellationMap + TerminalPanes de execução).

Decisão de recorte: o "Board numa view" do plano-mãe é satisfeito pelo HOST —
não nasce uma segunda view para o board. Motivos: titlebar/drag region/
`env(titlebar-area-*)` dependem do webContents da janela; os asserts de
segurança (`assertMainRendererSender`, voice) continuam válidos sem mudança; e
o ganho (2 processos, orçamento WebGL dobrado, parse de `pty:data` dividido) é
idêntico com metade da cirurgia.

O ganho do parse é AUTOMÁTICO pela arquitetura existente: `PtyManager.create`
captura o WebContents CRIADOR e faz unicast de `pty:data`/`pty:exit` para ele
(`src/main/pty.ts:285,723`). Quem monta o TerminalPane cria o PTY — a view
panes monta os de execução, o host monta maestro/orquestradores/login. Zero
mudança no caminho quente.

## 2. Fatos provados (sondas)

- probe-webcontentsview-webgl (2026-08-06): renderer PRÓPRIO por view; **16
  contextos WebGL POR view** (~107MB/view). Corolário: `WEBGL_BUDGET = 12` do
  TerminalPane é módulo-level = POR PROCESSO e fica CERTO sozinho após a
  divisão — cada view tem seu orçamento de 12. NÃO rebalancear.
- probe-webcontentsview-hidden (2026-08-08, Electron 43.1.1, este repo):
  - S2 `setVisible(false)`: layout INTACTO (getClientRects=1, rect 300×120,
    innerWidth mantido) e rAF RODANDO (62 ticks/500ms) — igual ao baseline.
    → esconder a view é `setVisible(false)`; keepalive dos panes intacto
    (o `hasRealSize` do TerminalPane continua verdadeiro).
  - S3 `removeChildView`: rAF PARA (>1500ms sem tick) — ResizeObserver/fit
    morrem juntos. NUNCA remover a view da árvore com panes vivos.
  - S4 bounds 0×0: o viewport interno NÃO encolhe (fica no último tamanho).
    Não usar como esconderijo (comportamento não-contratual).
  - Corolário do S2: rAF decorativo (paperField do mapa) roda invisível →
    a view precisa de sinal explícito de visibilidade para pausar enfeite.

## 3. Inventário de canais main→renderer (32 vivos) e destino pós-corte

Fato estrutural: `ctx.push` existe no contrato (`mainContext.ts:256`) e tem
ZERO call sites — todo emissor usa `uiSender.send`/`webContents.send` direto
(~104 sites). A costura de roteamento precisa NASCER (c0).

Destinos: **B** = só host/board · **P** = só view panes · **A** = ambas
(broadcast) · **O** = overlay (janela própria, fora do corte).

| Canal | Destino | Nota |
|---|---|---|
| `pty:data`, `pty:exit`, `pty:reset` | unicast | JÁ roteados pelo wc capturado no `pty:create` — não tocar |
| `panes:stats`, `pane:lastlines`, `pty:effort`, `pty:model` | **A** | hoje cavalgam no sender do pty:create; chrome dos DOIS lados consome (Board 1893-1916, PanesView 1152-1156, ConstellationMap) |
| `tasks:attention` | **A** | pulso em Board/rail/Home/Universe E PanesView |
| `seats:changed` | **A** | emitido só em ipc/pty.ts:528 (login expirado) |
| `panes:open`, `panes:close`, `panes:closeById` | **A** | as duas views mantêm `panesByProject`; só a view panes MONTA |
| `tasks:changed` | **A** | Board/Home + buildNodes do canvas (41 sites de emissão) |
| `missions:changed`, `projects:flowChanged` | **A** | idem (nodes/headers) |
| `skills:changed` | B | biblioteca é board/Home |
| `hub:event` | **A** | chime (host) + celebrações do mapa (panes) |
| `hub:communication` | **P** | só ConstellationMap consome |
| `maestro:event/live/ctx`, `missions:*`, `backlog:changed`, `cli:status`, `maestro:userQuestion`, `progress:open-target`, `progress:snapshot-changed`(main), `voice:*`(main) | B | superfícies do host |
| `voice:overlay-*`, `progress:overlay-*` | O | janelas próprias, intocadas |
| `policies:changed` | — | canal MORTO (assinado, nunca emitido) — fora do mapa, não mexer |

Canais NOVOS da fase (nomes definitivos):

- `panes-view:layout` (host→main, send): `{ visible, bounds }` — o HOST é o
  dono da geometria (placeholder da aba panes medido por ResizeObserver) e da
  visibilidade (aba ativa && sem overlay global do host).
- `panes-view:state` (host→main→view): recorte do uiState que a view precisa —
  `{ openProjectId, mountedProjects, remountNonce }`. O main CACHEIA o último
  e reentrega no `did-finish-load` da view (crash/reload da view recupera).
- `panes-view:shown` (main→view): boolean — gate do rAF decorativo (mapa).
- `settings:changed` (main→A): broadcast após `settings:set` (fonte do
  terminal muda nos dois lados).
- `panes:activity` (view→main→A): transições run/idle/dead reportadas pela
  view (dona dos panes de execução) — Board.livePaneOf/Home/rail precisam.
- `panes:attention-cleared` (view→main→A): clearPaneAttention deixa de ser
  local (rail/abas do host param de pulsar).
- `panes:request-close` (host→main): ■ derrubar/× vindos de Board/Backlog —
  o main ecoa `panes:closeById` broadcast; a view desmonta e o unmount mata o
  PTY (caminho atual).
- `panes:open-free` (main→A): nascimento de pane sem fase (agente livre,
  test server) — TODO nascimento passa a viajar por evento do main (D4).
- `files:navigate` (view→main→host): clique em link .md num terminal do
  canvas → aba Arquivos do host (substitui o registro módulo-level
  `projectFileNavigation` que não cruza processos).
- `panes-view:free-agent` etc. NÃO existem: modais globais continuam no host
  (ver D6).

## 4. Decisões de desenho (D1–D11)

- **D1** Host = view board; UMA WebContentsView nova (`?view=panes`), mesmo
  bundle, mesmo preload (discriminação por query param — padrão já provado
  pelos overlays em main.tsx:9-57).
- **D2** Esconder = `setVisible(false)` (sonda S2); `panes-view:shown` pausa
  enfeite; nunca removeChildView/bounds-zero com panes vivos.
- **D3** Costura de push: `ctx.pushBoard/pushPanes/pushAll` reais;
  `pushPanes` cai no board enquanto a view não existir (compat, zero
  comportamento com 1 view). Os 45 `bindUiSender(e.sender)` oportunistas
  MORREM (redundantes desde o binding por `did-finish-load`, F5.5); o
  `bindUiSender` do did-finish-load fica.
- **D4** Donos: a view panes é DONA da montagem dos panes de execução (o
  TerminalPane dela chama `pty:create`); o host mantém `panesByProject` como
  ESPELHO alimentado pelos MESMOS eventos broadcast (nunca monta terminal de
  execução). Nascimento e fechamento de pane SEMPRE viajam por evento do main
  (`panes:open`/`panes:open-free`/`panes:closeById`).
- **D5** Estado: a view roda o MESMO store.ts; carrega via os MESMOS invokes
  idempotentes (projects/seats/settings/tasks/missions) guiada pelos mesmos
  `*:changed`; o `openProjectId` dela vem do `panes-view:state`. `panesUi`/
  `mapLayout` (localStorage) são exclusivos da view — chaves já disjuntas.
- **D6** Overlays: som (notify) é EXCLUSIVO do host (throttles são por
  processo — dois assinantes = plim dobrado). Cada view monta seu
  TooltipLayer. PhaseSeatModal mora na view (já é do canvas). Modais/popovers
  GLOBAIS do host (popovers do TitleBar, menu ✦ Agente, FreeAgentModal,
  SeatGate) com a aba panes ativa: o host sinaliza overlay-aberto e a view é
  ESCONDIDA temporariamente (placeholder pinta fundo neutro na cor do canvas
  → o hide é discreto). FreeAgentModal/TestServerModal FICAM no host; o
  spec resultante nasce via `panes:open-free`.
- **D7** Segurança: `trustedRendererView` ganha `'panes'` no union e o
  branch 'main' segue exigindo zero query params; permission handlers da
  session viram membership test {host, panesView} (clipboard/etc. valem na
  view); will-navigate/windowOpenHandler idênticos na view; asserts
  main-only (settings/services/voice/progress/blackbox) continuam HOST-only.
- **D8** `paneActivity`/`clearPaneAttention` viram relay via main (volume
  baixo — transições, não chunks).
- **D9** SynVoice: ditado em terminal do canvas via registro de alvo no main
  (a view reporta o pane focado) + relay do texto para a view executar o
  paste (commit próprio, c5).
- **D10** `WEBGL_BUDGET=12` fica intacto (por processo — sonda WebGL).
- **D11** E2E driver (scripts/e2e): confere que mira o host (URL sem
  `?view=`); a view nova não pode roubar o target CDP.

## 5. Corte em commits (cada um verde: typecheck node+web + suítes)

- **F3-c0 — costura de push no main (zero comportamento)**: cria
  `pushBoard/pushPanes/pushAll` reais (panesSender ainda null); remove os 45
  `bindUiSender(e.sender)`; migra para `pushAll` os canais classificados A
  (§3), incluindo tirar `panes:stats`/`pane:lastlines`/`tasks:attention`/
  `pty:effort`/`pty:model`/`seats:changed`/`panes:closeById`/`tasks:changed`
  do sender capturado do pty (ipc/pty.ts + pty.ts — pty:data/exit/reset NÃO
  se tocam); `panes:open`/`panes:close` idem. Com uma view só, pushAll ≡
  uiSender: nenhum comportamento muda.
- **F3-c1 — a view nasce no main (dormente)**: módulo novo
  `src/main/panesView.ts` (criação lazy, attach, load `?view=panes` no
  padrão dos overlays, `did-finish-load`→bindPanesSender,
  `render-process-gone`→reload+blackbox, destroy no closed da janela,
  webPreferences: preload + backgroundThrottling:false + sandbox:false);
  canais `panes-view:layout/state/shown`; `trustedRendererView` +'panes';
  permission handlers/nav guards na view; blackbox `panes-view-*`. A view só
  é CRIADA no primeiro `panes-view:layout` — que nenhum renderer manda ainda
  → dormente, zero comportamento.
- **F3-c2 — o corte do renderer (o comportamento muda AQUI)**: branch
  `view=panes` no main.tsx + devMock; `PanesApp.tsx` novo (store próprio,
  assinaturas IPC sem sons, `panes:live` rehydration MOVIDA para cá,
  PanesView keepalive por projeto montado, TooltipLayer, atalhos Ctrl+Alt+*
  e zoom de fonte locais, consumo de `panes-view:state/shown`); host: a aba
  panes vira placeholder medido (`panes-view:layout`), App.tsx deixa de
  renderizar PanesView mas segue populando o espelho `panesByProject`
  (openDevPane sem montagem), overlays globais sinalizam hide (D6).
  Validação manual pesada com `npm run dev`.
- **F3-c3 — nascimentos e fechos via main**: `panes:open-free` (freeSpec/
  testServerSpec passam a emitir broadcast; addPane local do host morre),
  `panes:request-close` (■/×), runTask já coberto pelo `panes:open`
  existente.
- **F3-c4 — costuras cross-view**: `files:navigate` (link .md → Arquivos),
  mapa→board (`setUniverseTab` relay), `panes:activity` +
  `panes:attention-cleared`, SeatGate força tab board ao montar,
  `settings:changed` broadcast, gate de rAF do mapa por `panes-view:shown`.
- **F3-c5 — SynVoice cross-view** (D9).
- **F3-c6 — telemetria + validação + docs**: eventos blackbox consolidados,
  bbwatch cobre `panes-view-*`, atualização de CLAUDE.md/PLANO_NIVEL_5,
  varredura de resíduos (imports mortos do PanesView no host, CSS órfão
  anotado — remoção só se trivial), checagem E2E driver (D11).

## 6. Riscos nomeados e mitigação

- `bindUiSender` recusando a view (ui-sender-rebind-refused em loop): morre
  na c0 (remoção dos oportunistas) + a view NUNCA chama canais que rebindam.
- Rehydration dupla (`panes:live` nas duas views): host popula SÓ estado
  (montagem é da view) — `pty:create` duplicado é impossível por construção
  (create é efeito do mount do TerminalPane).
- Plim dobrado: sons só no host (D6); PanesApp não importa notify.
- View crashada perde pedidos relay (ex.: request-close no vácuo): aceito e
  anotado — o reload da view rehidrata pelo `panes:live` e o pedido se
  repete à mão; blackbox registra `panes-view-crashed`.
- Drag de gesto abortado por blur cross-view: comportamento aceito na
  entrega (gesto dentro da view não perde foco; alt-tab já abortava hoje).
  Refinar para pointercancel só se o dono sentir.
- Tooltips/popovers do host clipados pela view: coberto pelo hide de D6;
  tooltips pequenos do header podem sobrepor — cosmético, anotar se incomodar.
- Codex/SIGWINCH: NÃO há drag entre views no corte 1 (panes do board são
  maestros fixos; os do canvas nunca migram) — a sonda de repaint do codex só
  é pré-requisito do corte 2 (drag entre views), fora desta fase.

## 7. Fora do escopo (registrado para não escorregar)

- Segunda view para o Board (host já cumpre o papel).
- Drag de pane ENTRE views (migração de processo — exige sonda codex).
- Pool WebGL por visibilidade (complemento posterior do plano-mãe).
- `policies:changed` morto e CSS órfão do espelho headless (pré-existentes).
