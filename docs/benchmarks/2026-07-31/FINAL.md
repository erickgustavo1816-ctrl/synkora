# Validação final — plano MCP/LSP

Data: 2026-07-31. O plano foi executado na ordem obrigatória, da Fase 0 à
Fase 5, sem reset, checkout ou descarte das alterações que já existiam no
worktree.

## Resultado por fase

| Fase | Resultado |
|---|---|
| 0 — medir | Baseline reproduzível de MCP, LSP e startup de panes, com privacidade allowlisted e falhas nativas registradas sem ocultação. |
| 1 — remover `npx @latest` | Playwright MCP `0.0.78` virou dependência de runtime exata e é iniciado diretamente. Nenhum download ou resolução de registry ocorre ao abrir pane. |
| 2 — LSP compartilhado | Manager TypeScript/JavaScript por worktree, sete tools compactas, pooling, isolamento, sincronização, TTL, restart e fallback textual. |
| 3 — outras linguagens | Nenhuma foi instalada: a evidência disponível não justificou custo permanente adicional. A borda comum ficou pronta para extensão futura. |
| 4 — MCP dual-era | Servidor único com legado e MCP `2026-07-28`, detecção de capacidade do cliente, cache privado, cancelamento e fallback legado. |
| 5 — controles e observabilidade | Tela Serviços, preferências persistidas, restart isolado, linguagens observadas nos documentos abertos e métricas agregadas sem conteúdo sensível. |

Relatórios detalhados: [baseline](./BASELINE.md), [Fase 1](./PHASE1.md),
[Fase 2](./PHASE2.md), [Fase 3](./PHASE3.md), [Fase 4](./PHASE4.md) e
[Fase 5](./PHASE5.md).

## Matriz final de panes

O ensaio usa ConPTY e PTY reais, mas troca a TUI do agente por um marcador
determinístico para não consumir turnos de modelo. Os tempos são medianas até o
primeiro output; nos panes estritos, a última coluna mede o MCP externo até
`tools/list`.

| Cenário | Panes | Primeiro output | MCP externo | Resultado |
|---|---:|---:|---:|---|
| Livre | 1 | 148,859 ms | n/a | passou |
| Livre | 8 | 211,200 ms | n/a | passou |
| Maestro/orquestrador | 1 | 142,328 ms | n/a | passou |
| Maestro/orquestrador | 4 | 162,946 ms | n/a | passou |
| Estrito com browser | 1 | 1.232,488 ms | 901,978 ms | passou |
| Estrito com browser | 8 | 1.504,995 ms | 1.074,803 ms | passou no retry registrado |
| Estrito com browser | 32 | 3.721,707 ms | 2.260,993 ms | passou na matriz principal |

O Playwright isolado ficou pronto em **198,395 ms** no benchmark final, contra
**1.306,143 ms** no baseline: redução de aproximadamente **84,8%**, com as
mesmas 24 ferramentas. No pacote final, o handshake completo até `tools/list`
levou **217,294 ms**, sem stderr.

Artefatos: [`final-pane-startup.json`](./final-pane-startup.json),
[`final-pane-retry8.json`](./final-pane-retry8.json),
[`final-pane-retry32.json`](./final-pane-retry32.json) e
[`final-mcp.json`](./final-mcp.json).

### Instabilidade nativa preservada nos resultados

O backend ConPTY continua apresentando, de forma intermitente e sensível a
timing, o crash nativo `0xC0000005` em alta concorrência. Ele já existia no
baseline. Na coleta final:

- livre/32 caiu na matriz principal e no retry extra;
- estrito/8 caiu na primeira tentativa e passou no retry;
- estrito/32 passou na matriz principal e caiu no retry extra;
- maestro/32 passou nas duas tentativas relevantes;
- o MCP externo isolado completou com 32 clientes mesmo quando o worker PTY
  caiu.

Assim, todos os tamanhos exigidos pelo plano têm uma execução completa, mas o
flaky nativo adicional não é apresentado como corrigido.

## LSP final

O benchmark atravessa a borda real entregue às tools MCP: manager, LSP,
normalização, ordenação, paginação e serialização compacta.

- primeiro request frio: **48,465 ms**;
- 30 rodadas quentes por operação, além das matrizes concorrentes;
- maior p95 quente sequencial: **3,465 ms** (`references`), abaixo da meta de
  100 ms;
- maior p95 por request em concorrência 32: **50,488 ms** (`symbols`);
- 8.841 requests, 1 start, 8.840 reusos e 0 falha no ensaio principal;
- 32 owners na mesma worktree compartilharam 1 processo;
- 2, 4 e 8 owners na mesma worktree compartilharam exatamente 1 processo;
- 2, 4 e 8 worktrees diferentes usaram exatamente 2, 4 e 8 processos, com
  respostas isoladas;
- 5 ciclos de invalidação e recriação passaram, totalizando 6 starts e 0
  falha.

| Operação | Mediana quente | p95 quente | p95 por request em c=32 |
|---|---:|---:|---:|
| Diagnósticos | 1,708 ms | 2,142 ms | 31,504 ms |
| Definição | 1,759 ms | 2,100 ms | 33,184 ms |
| Referências | 2,500 ms | 3,465 ms | 35,346 ms |
| Símbolos | 2,244 ms | 3,196 ms | 50,488 ms |
| Hover | 1,835 ms | 2,250 ms | 35,210 ms |
| Implementações | 1,949 ms | 2,325 ms | 41,990 ms |
| Hierarquia de chamadas | 2,421 ms | 2,745 ms | 38,516 ms |

Artefato: [`final-lsp.json`](./final-lsp.json).

## MCP dual-era

O servidor final usa `@modelcontextprotocol/server`,
`@modelcontextprotocol/node` e o cliente de teste na versão exata **2.0.0**.
No mesmo listener passaram 16 clientes legados e 16 modernos simultâneos:

| Etapa | Legado mediana / p95 | Moderno mediana / p95 |
|---|---:|---:|
| Conexão/negociação | 4,696 / 8,838 ms | 2,176 / 4,134 ms |
| Primeiro `tools/list` | 3,394 / 5,804 ms | 3,010 / 6,363 ms |

Também passaram bearer ausente/inválido/revogado, confinamento da identidade ao
bearer, `Host`/`Origin` externos, rota exata, cache privado sem segundo request,
cancelamento em 41,684 ms e desconexão durante chamada pendente. O Codex local
`0.146.0` e o Claude Code local `2.1.220` permanecem no legado detectado; o modo
`auto` nunca injeta uma feature não comprovada.

Artefato: [`phase4-mcp.json`](./phase4-mcp.json).

## Aplicativo empacotado

O artefato final está em `release/final/win-unpacked`. Depois da última
correção, o pacote foi regenerado e os runtimes internos foram exercitados de
forma real:

- TypeScript nativo **7.0.2**, 108 declaration libraries, handshake LSP por
  stdio, shutdown e exit limpos, código 0 e zero stderr;
- Playwright MCP **0.0.78**, catálogo de 24 ferramentas com o mesmo hash do
  desenvolvimento, handshake completo e zero stderr;
- pacotes MCP servidor/node **2.0.0** presentes no `app.asar`.

Artefatos: [`final-dist-lsp.json`](./final-dist-lsp.json) e
[`final-dist-playwright.json`](./final-dist-playwright.json).

## Verificações finais

Passaram após a última alteração de código:

```text
npm run typecheck
npm run build
npm run test:code-intelligence       # 8/8
npm run test:mcp-protocol            # 5/5
npm run test:mcp-dual-era            # 32 clientes
npm run test:playwright-runtime
npm run dist:dir -- --config.directories.output=release/final
```

A tela Serviços também foi operada no Electron real: mudança e restauração das
preferências, fallback textual, detalhes recolhíveis e restart do MCP mantendo
a porta foram verificados. A UI empacotada não foi automatizada; os dois
runtimes críticos do pacote foram testados diretamente.

## Privacidade, segurança e limites

- os JSONs finais não contêm caminho de usuário, bearer, token, chave, prompt,
  output, conteúdo de arquivo/terminal ou payload LSP;
- os 29 marcos reais de startup inspecionados também não continham campos nem
  padrões proibidos;
- a detecção de linguagens vem dos documentos efetivamente abertos; vazio é
  exibido como nenhuma linguagem detectada;
- durante restart/falha, a disponibilidade do MCP é retirada antes de fechar o
  listener e só volta após o novo servidor subir;
- não foi feito smoke pago de missões com modelos Claude/Codex; as missões A/B
  sugeridas foram substituídas por fixtures determinísticas e hashes de
  resposta. Tokens de modelo, portanto, não foram fabricados nem estimados;
- não houve ensaio prolongado de RSS/Private Bytes nem remoção física de uma
  worktree enquanto o LSP estava ativo;
- `npm audit --omit=dev` ainda reporta 2 vulnerabilidades moderadas no caminho
  do servidor Hono/MCP, sem correção publicada para a cadeia instalada. A
  auditoria completa reporta também 1 vulnerabilidade alta em dependência de
  empacotamento. Nenhum `audit fix` amplo foi aplicado automaticamente.
