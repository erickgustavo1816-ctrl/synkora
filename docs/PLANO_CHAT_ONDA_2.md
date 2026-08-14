# Onda 2 do chat — o que o dono escolheu (2026-08-13)

Cardápio levantado do fork **claudecodeui** (`Desktop/Synkora2`, v1.37.1) por
varredura de código, e escolhido pelo dono item a item. Este documento é o
CONTRATO da próxima leva: o que entra, por quê, e como implementar dentro da
nossa arquitetura (Electron, o main dirige os CLIs direto — não temos servidor
websocket nem Express, então nada do encanamento HTTP/SSE do fork se copia:
o que se porta é o COMPORTAMENTO e o formato de payload).

Régua de sempre: UI em PT-BR, código/identificadores em inglês; o chat é
PAPEL (`--panel` escuro é exclusivo do TerminalPane); TS strict, sem `any`;
feature nova = módulo novo (nada de inchar `GuiPane.tsx`, que já está grande).

## Estado da entrega (2026-08-14)

- **Entregues:** P1, P3–P12, P14–P17, P19–P21, P23–P26 e P29.
- **P2 — override do dono:** o feedback de “pensando” fica no fio e, durante o
  turno, o botão **Parar** ocupa o lugar de Enviar. A faixa de atividade no
  composer não é mais desejada; o Esc global continua ativo.
- **P13 — override do dono:** não revelar nem persistir raciocínio interno;
  mostrar apenas o estado transitório “o agente está pensando”.
- **P18 — subsumido:** o resultado já abre dentro do próprio card da ferramenta,
  portanto não há um segundo bloco distante para onde saltar.
- **P22 — override do dono:** uma única ação discreta copia sempre texto limpo;
  a opção de markdown foi removida.
- **P23 — entregue na forma canônica:** o composer abre um painel com tokens
  exatos, percentual e custo quando disponível; `/status` e o seletor de modelo
  continuam usando as fontes reais de cada CLI, sem comandos sintéticos.
- **P27 — adaptado ao produto atual:** a gaveta reúne os avisos e sons globais
  já suportados. Tema e exibição de raciocínio não foram inventados como novas
  preferências — o chat permanece papel e P13 foi recusado pelo dono.
- **P28 — caminho seguro escolhido:** observador passivo e limitado das capturas
  produzidas no workspace, com começar/parar/expandir. Ele não controla o PC,
  não abre navegador e não inventa URL, clique ou cursor.

Os textos abaixo preservam o contrato histórico e as ideias originais; quando
houver divergência, este registro de entrega e os overrides explícitos do dono
prevalecem.

Referência da onda 1 (já entregue, não repetir): comandos slash, perguntas com
opções, card de plano, markdown, digitação palavra a palavra, seletores de
permissão/modelo/effort, card e troca de conta.

---

## 1. Fluxo da conversa

### P1 — Fila de mensagens durante o turno · valor ALTO · custo MÉDIO
**O que muda na tela:** com o agente trabalhando, Enter não envia: enfileira.
Aparece um cartão tracejado "vai enviar quando terminar" com editar/apagar, e
no fim do turno a mensagem dispara sozinha — inclusive em missão que não está
na tela.

**Como implementar:**
- Estado por pane no store (`queued: {text, at, options}`), persistido em
  `localStorage` por paneId — o rascunho tem de sobreviver a troca de missão e
  a reload do renderer.
- As OPÇÕES do envio (modelo, effort, modo de permissão) são fotografadas no
  instante em que a mensagem entra na fila: ela sai com a régua sob a qual foi
  escrita, não com a que estiver valendo depois.
- Disparo: no redutor, a transição de `working → idle` (evento `result`) é o
  gatilho. Precisa de um despachante GLOBAL (fora do GuiPane, que só existe
  montado) — um efeito no Board/App que observa `guiPanes` e envia a fila do
  pane que acabou de fechar o turno.
- Guarda anti-envio-duplo: limpar a chave do localStorage é o "bilhete" — quem
  limpa é quem envia (o fork tropeçou exatamente aqui; copiar os refs de posse).
- Fork: `useChatComposerState.ts` (ramo de fila no handleSubmit ~706-790,
  flush ~976-1018), `chatStorage.ts`, `useQueuedMessageAutoSend.ts`,
  `QueuedMessageCard.tsx`.

### P2 — Indicador de atividade + Esc global · valor ALTO · custo BAIXO
**O que muda na tela:** faixa colada no topo do composer enquanto o turno roda:
ponto pulsando, verbo girando a cada ~4s (pensando/analisando/trabalhando…),
cronômetro em números tabulares e botão parar com a dica `esc`. Esc interrompe
de qualquer lugar do app.

**Como implementar:**
- Componente novo (`GuiActivityBar.tsx`), alimentado por `gui.status` +
  um `startedAt` que o store carimba na transição para `working`.
- O verbo girando é cosmético; quando o backend manda texto de status real, ele
  VENCE o verbo genérico (nunca inventar atividade por cima de fato).
- Esc: listener em fase de captura no App, que resolve o pane ativo e chama
  `interruptGuiPane`. Cuidado: Esc dentro do card de pergunta já significa
  "pular" — a checagem do card vem primeiro.
- Cantos superiores do composer quadrados enquanto a faixa está no ar (é o que
  faz ela parecer colada, não flutuando).
- Fork: `ActivityIndicator.tsx`, `ChatInterface.tsx:264-282`, `Shimmer.tsx`.

### P3 — Paginação e rolagem estável · valor ALTO · custo MÉDIO
**O que muda na tela:** conversa longa abre com as últimas ~100 mensagens e
busca mais 20 ao subir, SEM a tela pular; pílula "carregar todas as N" no topo,
que some sozinha; botão de voltar ao fim quando você está no meio.

**Como implementar:**
- Hoje o teto é `GUI_ITEM_CAP = 400` no store e o ring do main guarda ~500
  eventos: paginação de verdade exige uma FONTE além do ring — ou subimos o cap
  e paginamos o que já está em memória (barato, resolve 90%), ou lemos o
  transcript JSONL do CLI no main (caro, mas é o único jeito de ver conversa de
  boot anterior). **Decisão: começar pela versão em memória.**
- Anti-pulo: `useLayoutEffect` que restaura `scrollTop` pela diferença de
  `scrollHeight` depois de prepender, com trava de reentrância.
- Rolagem inicial: re-rolar ao fim a cada quadro enquanto `scrollHeight` ainda
  cresce (markdown e imagens reflowam depois da pintura), com teto de ~1s.
- Fork: `useChatSessionState.ts:328-470`, `LoadAllMessagesOverlay.tsx`.

### P4 — Rascunho por missão · valor MÉDIO · custo BAIXO
**O que muda na tela:** o que você digitou e não enviou fica salvo ao trocar de
missão e volta quando você retorna.

**Como implementar:** `localStorage` por paneId (`synkora.guiDraft.<paneId>`),
gravado com debounce; envelope de escrita que trata `QuotaExceededError`
descartando rascunhos antigos antes de tentar de novo. Fork: `chatStorage.ts`.

---

## 2. Composer

### P5 — Menções @arquivo · valor ALTO · custo MÉDIO
**O que muda na tela:** digitar `@` abre a busca de arquivos do projeto (nome
ou trecho de caminho); o caminho escolhido fica DESTACADO em azul dentro do
próprio campo de texto.

**Como implementar:**
- Lista de arquivos: IPC novo no main (`missions:workspaceTree` ou reuso do
  `workspaceFiles`), com cache por worktree — varrer a cada tecla é proibido.
- O destaque é o truque do fork: uma `div` sobreposta ao textarea com o texto
  transparente e as menções pintadas, com scroll sincronizado — não é editor
  rico. Copiar `renderInputWithMentions` + `syncInputOverlayScroll`.
- Teclado igual ao menu de comandos que já existe (setas/Tab/Enter/Esc), e o
  handler das menções roda DEPOIS do de comandos.
- Fork: `useFileMentions.tsx` (273 linhas), `ChatComposer.tsx:285-310, 368-372`.

### P6 — Anexos e print colado · valor ALTO · custo MÉDIO
**O que muda na tela:** arrastar arquivo na conversa ou colar um print manda a
imagem para o agente; a mensagem enviada mostra miniatura clicável (abre grande)
e chip de download para arquivo comum.

**Como implementar:**
- **Metade do caminho JÁ EXISTE**: `gui:attach` grava em
  `<cwd>/.synkora/attachments` e devolve o caminho absoluto (teto 10MB, nome
  único, git-invisível). Falta a UI: dropzone na área do chat, `onPaste` de
  imagem, cartões de anexo acima da bolha da mensagem e o lightbox.
- Descritores durável no estado do pane (para o anexo sobreviver à fila do P1).
- Fork: `ComposerAttachment.tsx`, `ChatMessageImages.tsx`, `ChatMessageFiles.tsx`;
  `image-attachments.ts` mostra como montar o bloco de conteúdo por CLI (claude
  streaming input × codex input items) — vale ler antes de decidir se mandamos
  o caminho no texto (hoje) ou o conteúdo no protocolo.

### P7 — Lembrar esta permissão · valor ALTO · custo BAIXO
**O que muda na tela:** ao permitir algo, virar regra permanente daquela
conversa (ex.: `Bash(git commit:*)`), em vez de perguntar toda vez.

**Como implementar:** o botão "sempre" já existe e usa `updatedPermissions` com
as `permission_suggestions` do CLI. O que falta é (a) MOSTRAR a regra que será
gravada antes de clicar, e (b) gerar a regra quando o CLI não sugere nada —
`Bash(<primeiros dois tokens>:*)`. Fork: `chatPermissions.ts:5-20`.

**NÃO escolhido neste bloco:** Tab ciclando o modo de permissão.

---

## 3. Cards de ferramenta

### P8 — Agrupar ferramentas repetidas · valor ALTO · custo BAIXO
**O que muda na tela:** sete leituras seguidas viram uma linha: `Read ×7 ·
a.ts, b.ts, +5`. Clicou, abre os cards individuais.

**Como implementar:** transformação PURA sobre `gui.items` na renderização
(`groupConsecutiveTools`), nunca no store — o estado continua sendo a verdade
crua. Regra que faz a diferença: item INVISÍVEL (raciocínio escondido) não
quebra a sequência, senão o codex, que intercala raciocínio, nunca agruparia.
Fork: `toolGrouping.ts` (81 linhas), `ToolGroupContainer.tsx`.

### P9 — Linha de comando com saída embutida · valor ALTO · custo BAIXO
**O que muda na tela:** comando de terminal vira uma linha compacta com `$`,
comando cortado, status e "N linhas"; clicando, a saída abre ali dentro.

**Como implementar:** componente próprio para tools da família bash, escolhido
pelo mesmo `toolGlyph` que já classifica. Erro ganha borda vermelha mas NÃO
abre sozinho (decisão do fork, e está certa: erro que se abre sozinho empurra o
resto da conversa para fora da tela). Fork: `BashCommandDisplay.tsx`.

### P10 — Diff colorido · valor ALTO · custo BAIXO
**O que muda na tela:** edição de arquivo aparece como diff de verdade
(verde/vermelho, com o nome do arquivo no título), não como JSON.

**Como implementar:** para Edit/Write/ApplyPatch, ler `old_string`/`new_string`
(ou o patch) do input da tool e renderizar diff por linha com calha `+`/`−`.
Cálculo memoizado por id da tool. Fork: `ToolDiffViewer.tsx`,
`messageTransforms.ts` (`createCachedDiffCalculator`).

### P11 — Caixa de subagente · valor ALTO · custo MÉDIO
**O que muda na tela:** quando o agente delega, o trabalho do ajudante fica
numa caixa própria: prompt, "agora: Grep / padrão" com ponto pulsando, e
"concluído (N ferramentas)" no fim.

**Como implementar:** DEPENDE DE PROTOCOLO — o main precisa propagar
`parent_tool_use_id` do stream do claude para o evento `tool`, e o store passa
a aninhar filhos sob o pai. É a única peça desta lista que mexe no motor.
Fork: `SubagentContainer.tsx`, `claude-runtime.provider.js:292-301`.

---

## 4. Erros, raciocínio e leitura

### P12 — Erro que não trava · valor ALTO · custo BAIXO
Erro de ferramenta vira linha vermelha compacta que abre no clique; e falha de
protocolo/transporte entra como mensagem de erro no fio E limpa o estado de
"trabalhando" — o indicador nunca mais gira para sempre. Distinguir NEGADO
(você disse não) de FALHOU: badge diferente, texto diferente.
Fork: `ToolErrorDisplay.tsx`, `deriveToolStatus` em `ToolRenderer.tsx:50-67`.

### P13 — Raciocínio recolhível · valor MÉDIO · custo BAIXO
O "pensando" vira gaveta fechada com o texto dentro (hoje mostramos só os
últimos 160 caracteres em itálico). Preferência global "mostrar raciocínio"
para desligar de vez. Fork: `MessageComponent.tsx:313-338`, `Reasoning.tsx`.

### P14 — Aviso de limite em português · valor MÉDIO · custo BAIXO
A linha crua `Claude AI usage limit reached|1234567890` vira "seu limite volta
às 14:00 de hoje (horário de São Paulo)". Fork: `chatFormatting.ts`
(`formatUsageLimitText`).

### P15 — JSON formatado · valor BAIXO · custo BAIXO
Resposta que é só JSON aparece formatada num cartão de código.
Fork: `MessageComponent.tsx:340-371`.

---

## 5. Busca e navegação

### P16 — Paleta Cmd+K · valor ALTO · custo MÉDIO
**O que muda na tela:** um atalho abre busca geral com páginas — ações do app,
arquivos, sessões, commits, branches — e busca no TEXTO das conversas antigas,
levando direto à mensagem encontrada.

**Como implementar:**
- A busca no histórico é a joia: no fork ela é SSE sobre os JSONL do CLI; aqui
  vira IPC no main varrendo `<configDir>/projects/<slug>/*.jsonl` (claude) e os
  rollouts do codex — mais simples que a versão deles.
- Ir até a mensagem: `searchTarget` no store + rolagem por id de item.
- Registro de ações aberto, para painéis registrarem os comandos deles.
- Fork: `CommandPalette.tsx` (373 linhas), `sources/*`, `PaletteOpsContext.tsx`.

### P17 — Abrir arquivo citado no chat · valor MÉDIO · custo BAIXO
Clicar num caminho que o agente escreveu abre o arquivo — resolvendo nome curto
(`foo.ts`) contra a árvore do projeto por sufixo. Casa com o P20 (preview).
Fork: `useFileOpenResolver.ts`.

### P18 — Âncora "ver resultado" · valor BAIXO · custo BAIXO
No card de entrada de uma busca do agente, link que pula para o resultado dela
mais abaixo no fio (`id="tool-result-<id>"` + `scroll-mt`).

---

## 6. Avisos

### P19 — Notificação do sistema · valor ALTO · custo BAIXO
**O que muda na tela:** aviso do Windows por tipo de evento (terminou / precisa
de você / falhou), com o NOME DA MISSÃO no título, sem repetir o mesmo aviso.

**Como implementar:** `desktopNotifications.ts` já existe e já é chamado na
permissão e na pergunta. Falta: evento de TURNO CONCLUÍDO e de FALHA, chave de
dedupe por `<tipo>:<paneId>` numa janela de ~20s, e preferências por tipo nos
ajustes. Fork: `notification-orchestrator.service.js`,
`NotificationsSettingsTab.tsx`.

### P20 — Som próprio por evento · valor MÉDIO · custo BAIXO
Sons distintos para "turno terminou" e "precisa de você", sintetizados em Web
Audio (sem arquivo). **Já temos** `notify.ts` com plim e blips — falta ligar nos
eventos do chat e dar interruptor. Fork: `notificationSound.ts`.

### P21 — Título da janela avisa · valor MÉDIO · custo BAIXO
A janela passa a mostrar `[pronto]` quando um trabalho termina com você em
outra aba; limpa ~2s depois de você voltar, e persiste se a janela estava em
segundo plano. Fork: `pageTitleNotification.ts`.

---

## 7. Copiar e medir

### P22 — Copiar mensagem (markdown ou texto) · valor MÉDIO · custo BAIXO
Botão de copiar em cada resposta, com escolha entre markdown e texto limpo — a
conversão para texto preserva o conteúdo dos blocos de código e tira cercas,
links e asteriscos. Fork: `MessageCopyControl.tsx` (`convertMarkdownToPlainText`).

### P23 — Medidor de tokens + painéis /cost /status /models · valor MÉDIO · custo MÉDIO
Pílula no composer com o consumo da conversa (`12.4K`), tooltip com o número
exato; clicando, abre o painel de custo/status/modelos. Os dados já chegam
(`result.contextTokens/contextWindow/costUsd` no store) — falta a superfície.
Fork: `TokenUsageSummary.tsx`, `CommandResultModal.tsx`.

---

## 8. Git, arquivos e app

### P24 — Histórico visual de commits · valor MÉDIO · custo MÉDIO
**Escolha do dono: SÓ o histórico, sem stage/commit.** Os commits da missão com
gráfico de linhas (lanes/arestas) e o diff de cada um ao expandir. Somos donos
do `missions:commits` e do `missions:fileDiff` — falta o desenho do grafo.
Fork: `utils/commitGraph.ts`, `view/history/CommitGraphStrip.tsx`.
**FORA:** painel de git completo e mensagem de commit por IA (não escolhidos).

### P25 — Preview de arquivo (sem editar) · valor MÉDIO · custo MÉDIO
**Escolha do dono: LER, nunca editar.** Abrir arquivo do projeto num painel
lateral com código colorido, markdown renderizado e preview de imagem —
sem editor, sem salvar (risco zero de estragar o worktree por acidente).
Casa com P17. Reusar o `md-view` do FilesView para markdown.

### P26 — Menu do botão direito na árvore · valor MÉDIO · custo MÉDIO
Renomear, excluir, criar arquivo/pasta, copiar caminho e baixar pasta como zip.
ATENÇÃO: isto ESCREVE no disco — cada ação precisa de guarda de caminho (só
dentro do projeto/worktree) e confirmação própria (nunca `window.confirm`, que
quebra o foco no Windows). Fork: `file-tree/`.

### P27 — Ajustes rápidos na lateral · valor MÉDIO · custo BAIXO
Gaveta que sai da borda com os interruptores do dia a dia (tema, o que mostrar
no chat, sons) sem abrir a tela cheia de ajustes. Fork: `quick-settings-panel/`.

### P28 — Agente verifica no navegador · valor ALTO · custo ALTO
**O que muda na tela:** o agente dirige um navegador real e você acompanha por
print ao vivo (URL, título, o que ele clicou, posição do cursor), com
começar/parar e expandir.

**Como implementar:** nós JÁ temos Playwright MCP nos panes e a Fase 4 (QA por
CDP no app Electron real). O que falta é a JANELA: um painel que assina os
screenshots. Caminho mais barato: o agente já salva prints em
`.synkora/attachments`/`.playwright-mcp` — um painel que observa a pasta e
mostra o último print entrega 80% do valor sem MCP novo. Avaliar antes de
construir a ponte completa. Fork: `browser-use/`.

### P29 — Painel que cai sozinho · valor MÉDIO · custo BAIXO
Cada painel embrulhado num limite de erro: se um quebra, só ele mostra o erro
em vez de derrubar o app. Fork: `main-content/view/ErrorBoundary.tsx`.

---

## Não escolhidos (ficam de reserva, com motivo)

- **Tab cicla o modo de permissão** — o menu já resolve.
- **Gestão de sessões** (renomear, copiar id, arquivar, conversas recentes) —
  o dono não marcou; a coluna de missões já é o índice dele.
- **Exportar conversa** (MD/HTML/PDF) — não marcado.
- **Painel de git completo** e **mensagem de commit por IA** — trocados pelo
  histórico visual.
- **Árvore + editor lateral** — trocado pelo preview sem edição.
- **Login do CLI embutido**, **gerenciar MCP**, **gerenciar skills** — não
  marcados nesta leva.
- **Ver parâmetros crus** — não marcado.
- Do fork, já descartados por serem nossos ou irrelevantes: seats, missões/
  versões/fila/mapa, voz, TaskMaster, PWA/mobile, i18n, multi-tab do Electron.

## Ordem sugerida de execução

1. **Leva A (barata e sentida a cada minuto):** P2, P8, P9, P10, P12, P22,
   P19, P20, P21, P29.
2. **Leva B (o composer fica completo):** P1, P4, P5, P6, P7.
3. **Leva C (leitura e busca):** P3, P13, P14, P15, P16, P17, P18, P23.
4. **Leva D (painéis):** P24, P25, P26, P27, P11 (mexe no motor), P28 (avaliar
   o caminho barato antes).
