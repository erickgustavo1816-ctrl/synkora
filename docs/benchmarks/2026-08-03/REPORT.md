# Validação 2026-08-03 — LSP de cabo a rabo + MCP 100%

Sessão pedida pelo usuário antes do teste greenfield: provar que o sistema de
LSP funciona, medir quanto ele economiza de tokens com modelo REAL, e eliminar
o caso de "o pane já sabe o resultado e mesmo assim o input digita tudo de
novo".

## 1. LSP — funciona? SIM, com um bug real achado e corrigido

Aceitação e benchmark rodados nesta máquina (TypeScript 7.0.2 nativo):

- 10/10 testes de aceitação (1 NOVO, ver abaixo) · benchmark completo verde;
- p95 quente por operação ≤ 4,4 ms (meta < 100 ms) · primeira consulta fria ~50 ms;
- 32 sessões na mesma worktree → 1 processo · worktrees diferentes → processos
  isolados · 5 ciclos invalidação/recriação sem falha.

**BUG REAL (nunca pego pela aceitação antiga): referências cross-file não
funcionavam.** Sonda direta no binário tsgo (`--lsp --stdio`, sem código
Synkora) provou que o typescript-go 7.0.2 monta o programa a partir do fecho
de imports dos arquivos ABERTOS: `references` da classe `Hub` devolvia 1 item
(a própria declaração); abrindo `index.ts`, devolvia 6 em 3 arquivos. A
aceitação antiga só usava fixtures de UM arquivo e nunca viu isso.

Gatilho descoberto por sonda: um pull `textDocument/diagnostic` num arquivo
FECHADO carrega o programa daquele arquivo. **Fix no manager
(`primeDependents`)**: antes de references/implementations/call_hierarchy no
servidor nativo, um scan textual barato acha os prováveis dependentes do alvo
(quem o importa) e os esquenta com pull-diagnostics (cache por processo, TTL
30 s, tetos de arquivos/tempo). Validação: `Hub` → 6 refs em 3 arquivos;
`Hub.publish` → 145 chamadas; teste de aceitação novo com fixture
multi-arquivo (`finds references, implementations and incoming calls across
files never opened`). Benchmark pós-fix sem regressão (p95 ≤ 4,4 ms).

## 2. Quanto o LSP economiza de tokens — medido com modelo real

O FINAL.md de 2026-07-31 declarou honestamente que tokens nunca foram medidos.
Agora foram: `claude -p` headless (opus e sonnet), mesmas perguntas de
navegação num snapshot congelado do repo, braço `base` (Read/Glob/Grep) vs
braço `lsp` (mesmas tools + as 7 `code_*` reais via MCP stdio). 16 execuções,
todas com resposta CORRETA. Artefato: `ab-tokens.json`.

| Cenário | base | lsp | diferença |
|---|---:|---:|---|
| 3 perguntas de símbolo ÚNICO (×2 modelos) | ~$0,15/run | ~$0,15/run | **empate técnico** |
| símbolo ambíguo, 145 refs (`Hub.publish`), opus | $0,628 · 422k cache-read · 102 s | $0,548 · 314k · 92 s | **−13% custo · −26% contexto** |
| símbolo ambíguo, sonnet | $0,221 | $0,276 | +25% (fez LSP E grep para conferir) |
| total das 8 células | $1,743 | $1,741 | ~zero |

Comparação determinística (sem ruído de modelo): a resposta compacta de
`code_references` para as 145 chamadas tem **4.586 bytes**; o grep equivalente
despeja **25.644 bytes** no contexto — **5,6× menos bytes por consulta**.

**Leitura honesta:** neste repo (nomes únicos, bem comentado), a economia
média de tokens é ~neutra — a meta de 15–40% do plano NÃO se confirma como
média. O ganho real medido aparece em consultas de símbolo ambíguo/alto
fan-out no opus (−13% custo, −26% contexto) e na compactação por consulta
(5,6×). O que este A/B não cobre: missões inteiras com ciclo
editar→`code_diagnostics`→report (o guard proporcional substitui typechecks
inteiros no terminal) e bases com nomes ruins — onde a vantagem tende a
crescer. O valor comprovado hoje é sobretudo de CORREÇÃO: sem o fix, qualquer
resposta de referências cross-file estava simplesmente errada.

## 3. Protocolo MCP dual-era — funcionando

- `test:mcp-protocol` 5/5 · `test:mcp-dual-era` 32 clientes (16 legados + 16
  modernos no mesmo listener), 22 tools normais;
- binários locais sondados: codex 0.146.0 tem `mcp_2026_07_28` "under
  development"/false → modo `auto` fica corretamente no legado; claude 2.1.220
  idem. Nenhum pane é quebrado pelo modo automático.

## 4. "O pane já sabia e o input digitou o resultado de novo" — causa e fix

Evidência no diário da caixa-preta de HOJE (boot 4496ed13, 14:46–14:47): o
agente livre leu a saída dos ajudantes via `helper_output` (pré-report), mandou
"finalize e reporte" via `helper_send` — e quando o report chegou, a injeção
digitou o resultado COMPLETO de novo no input. Zero duplicação de
correlationId no mesmo pane (o Hub não entrega 2×): o problema era o CONTEÚDO
repetido chegando por dois canais (tool + injeção).

Três buracos fechados:

1. **Leitura pré-report reinjetava o payload inteiro** → o tracker agora
   registra TODO leitor (`noteOutputRead`) e o aviso vira modo por destino:
   `full` (nunca leu), `short` (acompanhou a saída: só o sinal de conclusão,
   sem payload), `skip` (leu APÓS o report: nada).
2. **Maestro/orquestrador nunca consumia** (só o delegador exato podia) → um
   leitor autorizado não-delegador (role maestro) agora consome a PRÓPRIA
   entrega; o publish para ele é excluído/encurtado; os demais destinos seguem
   recebendo o deles.
3. **Corrida enfileirou→injetou** (consumo entre o announce e a digitação) →
   `stillNeeded` no Hub: reavaliada no INSTANTE da injeção; consumo tardio
   descarta a entrega (desfecho `discarded` na caixa-preta) em vez de digitar.

Testes: `test:helper-completion` 14/14 (5 novos, incluindo os dois cenários do
diário). EVENTS.md/UI continuam com o evento completo; o que muda é apenas o
que é DIGITADO num pane que já conhece o resultado.

## Arquivos tocados

`src/main/codeIntelligence/manager.ts` (priming), `acceptance.test.ts`
(fixture multi-arquivo), `src/main/helperCompletion.ts` (modos por destino),
`src/main/hub.ts` (stillNeeded no drain), `src/main/index.ts` (announce por
destino + registro de leitura). Typecheck e suítes relacionadas verdes.
