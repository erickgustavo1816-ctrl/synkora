# Baseline da Fase 0 — MCP, LSP e startup de panes

Data da coleta: 2026-07-31. Este baseline foi obtido **antes** de retirar
`npx @latest` do caminho de abertura dos panes.

## Ambiente

| Item | Valor |
|---|---|
| Synkora | 0.1.0 |
| Commit | `41f1a2657f8e36f87ad48878e9ce713f874f858f` (`main`, worktree sujo) |
| Node do benchmark | 24.13.0 |
| Electron / Node do Electron | 43.1.1 / 24.18.0 |
| Claude Code | 2.1.220 |
| Codex CLI | 0.146.0 |
| TypeScript | 7.0.2, LSP nativo `tsc.exe --lsp --stdio` |
| SDK MCP | 1.29.0 |
| Windows | 10.0.26200 x64, 32 CPUs lógicas |

Os artefatos completos são
[`phase0-mcp.json`](./phase0-mcp.json),
[`phase0-lsp.json`](./phase0-lsp.json) e
[`phase0-pane-startup.json`](./phase0-pane-startup.json).

## MCP interno legado

Cada perfil passou por 3 warmups e 30 lotes medidos em concorrência 1, 8 e
32. Cada cliente executou `initialize`, `notifications/initialized` e
`tools/list` no servidor real de `src/main/mcpServer.ts`.

| Perfil | Ferramentas | Bytes de `tools/list` | c=1 init/list mediana | c=8 init/list mediana | c=32 init/list mediana |
|---|---:|---:|---:|---:|---:|
| Livre | 17 | 13.968 | 1,91 / 2,50 ms | 10,68 / 17,38 ms | 44,24 / 60,94 ms |
| Maestro/PM | 20 | 13.493 | 1,06 / 1,50 ms | 8,17 / 12,39 ms | 35,63 / 54,28 ms |
| Orquestrador | 21 | 17.864 | 1,28 / 1,84 ms | 10,28 / 19,16 ms | 48,04 / 67,44 ms |
| Estrito | 17 | 13.968 | 1,10 / 1,56 ms | 8,58 / 16,67 ms | 42,38 / 58,14 ms |

O catálogo estrito interno é idêntico ao livre; a diferença de custo do
pane estrito vem do MCP externo. No caminho atual,
`npx -y @playwright/mcp@latest` levou **1.306,14 ms** do pedido até
`tools/list`: 1.292,99 ms até `initialize` e 5,68 ms na lista. O servidor
negociou MCP 2025-06-18 e publicou 24 ferramentas.

## LSP TypeScript nativo

Um único servidor aquecido atendeu todas as consultas. Foram 1 warmup e 30
rodadas sequenciais por operação, seguidas por lotes 1/8/32 contra a mesma
instância. O initialize frio levou **18,06 ms** desde o spawn e **13,64 ms**
desde o envio da requisição.

| Operação | Mediana quente | p95 quente | Resposta compactada pelo benchmark |
|---|---:|---:|---:|
| Símbolos | 8,30 ms | 12,05 ms | 207 itens / 511.809 bytes brutos |
| Referências | 0,68 ms | 0,93 ms | 3 itens / 439 bytes |
| Definição | 0,14 ms | 0,19 ms | 1 item / 343 bytes |
| Hover | 0,19 ms | 0,25 ms | 1 item / 166 bytes |
| Diagnóstico | 0,15 ms | 0,28 ms | 1 item / 211 bytes |

Em concorrência 32, o p95 por requisição foi 109,52 ms para símbolos e
permaneceu abaixo de 8 ms nas outras quatro operações. O payload de símbolos
confirma que a integração deve limitar e paginar respostas antes de colocá-las
no contexto do agente.

## Startup sintético de pane

O ensaio usa PTY real e um marcador determinístico no lugar de uma TUI de
agente, portanto não consome turnos de IA. `primeiro frame` é o primeiro
marcador recebido pelo terminal sintético; os traces reais do aplicativo ficam
no JSONL de performance e são agregados pelo mesmo script.

| Cenário | Panes | Lote | Primeiro frame mediana / p95 | MCP externo até `tools/list` mediana / p95 |
|---|---:|---:|---:|---:|
| Livre | 1 | 204,30 ms | 145,81 / 145,81 ms | n/a |
| Livre | 8 | 328,68 ms | 235,94 / 246,22 ms | n/a |
| Maestro | 1 | 213,03 ms | 143,12 / 143,12 ms | n/a |
| Maestro | 8 | 295,45 ms | 200,95 / 210,00 ms | n/a |
| Maestro | 32 | 818,43 ms | 631,64 / 687,63 ms | n/a |
| Estrito | 1 | 1.655,45 ms | 1.590,85 / 1.590,85 ms | 1.251,89 / 1.251,89 ms |
| Estrito | 8 | 2.162,24 ms | 2.011,81 / 2.076,78 ms | 1.570,25 / 1.669,04 ms |

### Falha observada em 32 panes

O backend `conpty.dll` caiu de forma nativa e intermitente com exit code
`0xC0000005` (3221225477) nos lotes livre/32 e estrito/32. O script agora roda
cada lote Windows em subprocesso, portanto registra a falha sem derrubar nem
perder o baseline. Maestro/32 completou nesta coleta, o que reforça que o erro
é sensível a concorrência/timing.

Como o crash apagou as amostras do worker estrito/32, a disponibilidade externa
foi medida em lote separado: 32 clientes chegaram a `tools/list` em 6.446,73 ms
de wall-clock, com mediana 3.324,12 ms e p95 4.164,26 ms. Esses valores não
foram somados artificialmente a um tempo de pane.

## Privacidade e interpretação

Os logs e JSONs não contêm cwd, argv completo, prompt, resposta, ANSI, token
bearer, chave de API, headers de autenticação ou payload LSP/MCP. Só foram
persistidos versões, metadados allowlisted, contagens, bytes, hashes e tempos
monotônicos.

A conclusão da Fase 0 é clara: o handshake do MCP interno custa poucos
milissegundos; o maior custo removível é a preparação externa por `npx
@latest`. O LSP nativo é rápido o bastante para um pool compartilhado, desde
que as respostas sejam compactadas. A instabilidade de ConPTY em alta
concorrência é um risco independente que precisa permanecer visível nas
comparações seguintes.
