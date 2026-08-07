# Fase 2 — Code Intelligence Manager e TypeScript/JavaScript

Data da validação: 2026-07-31. Artefatos brutos:
[`phase2-lsp.json`](./phase2-lsp.json) e
[`phase2-dist-lsp.json`](./phase2-dist-lsp.json).

## Resultado

A Fase 2 entregou a borda comum de inteligência estrutural para Claude e
Codex, com um processo TypeScript 7 compartilhado por worktree, caminhos
confinados à raiz autorizada, sincronização e versionamento de documentos,
paginação determinística, TTL, limites de pool e invalidação explícita antes da
remoção de worktrees.

O acceptance test compilado com **TypeScript 7.0.2**, `module: Node16` e
`moduleResolution: Node16` passou integralmente, sem retry na remoção dos
fixtures:

```text
tests 8 · pass 8 · fail 0
```

Ele verificou automaticamente:

- dois owners na mesma raiz reutilizando um único servidor;
- fechamento de um owner sem encerrar o servidor ainda usado pelo outro;
- duas raízes isoladas, invalidação seletiva e encerramento após o TTL;
- duas worktrees Git divergentes consultadas a frio e em paralelo, com dois
  starts exatos, hover específico de cada branch e referências confinadas;
- subida através de um `package.json` folha sem dependências até o manifesto do
  projeto, fallback TS7 empacotado quando `node_modules` não existe e recusa
  segura de TS6 sem `typescript-language-server` local;
- paginação, caminhos relativos, rejeição de escape por `..` e aceitação do
  arquivo interno válido `..foo.ts`;
- normalização de falha de spawn com NUL para `LspTransportError`;
- handshake real do cliente TS7 encerrando com código 0, prendendo a assimetria
  `shutdown` sem `params` / `exit` com `params: null`;
- invalidação do cache de diagnósticos na mudança de versão e descarte de uma
  publicação tardia de versão anterior;
- diagnóstico ficando stale após alteração no disco e respostas compactas.

Comandos reproduzíveis:

```text
npm run test:code-intelligence:compile
npm run test:code-intelligence
npm run bench:code-intelligence
npm run dist:dir -- --config.directories.output=release/phase2
node scripts/probe-packaged-typescript-lsp.mjs --output docs/benchmarks/2026-07-31/phase2-dist-lsp.json
```

O runner compila os fontes reais em uma pasta temporária usando o compilador
local fixado no projeto; não usa `npx`, registry ou download. A pasta temporária
é removida ao final.

## Benchmark pela borda real

A execução final foi iniciada em `2026-07-31T21:38:26.433Z`. A medição inclui
`CodeIntelligenceManager` e `formatCodeQueryResult`: consulta LSP,
normalização/ordenação, paginação e JSON compacto entregue pela tool MCP. Não é
apenas um request LSP direto.

Ambiente:

- Node 24.13.0, Windows x64, 32 CPUs lógicas;
- TypeScript 7.0.2 nativo;
- fixture TypeScript estrita com definição, referências, interface/implementação
  e hierarquia de chamadas;
- uma rodada de aquecimento por operação;
- 30 rodadas quentes por operação e por cenário;
- concorrência 1, 8 e 32;
- 8.827 requests no total;
- um start, 8.826 reusos, zero restart e zero falha;
- 32 sessões/owners e um único processo no pool.

O primeiro request frio — spawn, initialize, abertura do documento, diagnóstico
e compactação — levou **45,934 ms**.

| Operação | Mediana quente | p95 quente | p95 c=8 por request | p95 c=32 por request | p95 do lote c=32 |
|---|---:|---:|---:|---:|---:|
| Diagnósticos | 1,668 ms | 1,987 ms | 10,106 ms | 32,066 ms | 53,481 ms |
| Definição | 1,912 ms | 4,186 ms | 19,956 ms | 69,889 ms | 111,153 ms |
| Referências | 3,970 ms | 5,277 ms | 21,256 ms | 67,278 ms | 116,047 ms |
| Símbolos | 3,999 ms | 5,125 ms | 23,600 ms | 75,180 ms | 136,294 ms |
| Hover | 1,870 ms | 7,981 ms | 21,186 ms | 73,486 ms | 110,118 ms |
| Implementações | 3,982 ms | 5,066 ms | 19,073 ms | 68,011 ms | 110,241 ms |
| Hierarquia de chamadas | 3,923 ms | 6,118 ms | 27,536 ms | 68,672 ms | 115,955 ms |

Todas as sete operações passaram o critério de **p95 quente por request abaixo
de 100 ms**. Em c=32, todos os p95 individuais também ficaram abaixo de 100 ms.
O tempo de parede do lote inteiro é uma métrica distinta e foi preservado
separadamente no JSON; o maior p95 de lote em c=32 foi **136,294 ms**, em
símbolos.

Cada operação produziu um único hash de resposta em todas as rodadas e
concorrências. A fixture devolveu definição (1), referências (2), símbolos (8),
hover (1), implementações (1) e hierarquia de chamadas (2); o diagnóstico limpo
devolveu zero item, como esperado.

## Runtime empacotado

`dist:dir` concluiu com a saída em `release/phase2/win-unpacked`. Na primeira
tentativa, o `electron-builder` havia podado os `lib.*.d.ts` exigidos pelo
executável nativo. O hook allowlisted `scripts/after-pack.cjs` passou a restaurar
somente essas bibliotecas ao lado do runtime desempacotado; o empacotamento
então passou.

O probe executado diretamente sobre esse artefato confirmou:

- **108** arquivos `lib*.d.ts`, incluindo `lib.d.ts`;
- `tsc.exe --version` = **7.0.2**;
- LSP real por stdio e framing `Content-Length`;
- respostas válidas a `initialize` e `shutdown`, notificações `initialized` e
  `exit`, encerramento limpo com código 0 e zero byte em stderr.

O `shutdown` é um `RequestType0`: o cliente omite `params` no JSON, conforme
exigido pelo servidor TS7. A notificação `exit` mantém `params: null`, necessário
para esse runtime retornar código 0. O probe não persiste URIs, caminho
temporário, conteúdo-fonte ou payload LSP.

## Integração com conclusão de tarefas

O gate de `report(done)` considera cada arquivo TS/JS alterado desde a base Git,
incluindo commits, staged, alterações locais e untracked. Com servidor
compatível, bloqueia conclusão quando faltam diagnósticos atuais ou quando a
consulta falha; indisponibilidade real preserva o fallback. Sem base Git
confiável, usa o estado agregado do owner. A resolução de `appRoot` no app
empacotado não depende de `process.cwd()`.

## Critérios de aceite

| Critério do plano | Estado | Evidência/limite |
|---|---|---|
| Dois panes na mesma worktree reutilizam servidor | Passou | acceptance com dois owners; benchmark com 32 owners e um processo |
| Duas worktrees do mesmo projeto usam servidores isolados | Passou | fixture Git com branches divergentes, concorrência a frio, dois processos e dois starts |
| Referências nunca cruzam branch | Passou | hover preservou os marcadores exclusivos; referências ficaram na `sample.ts` da worktree autorizada |
| Fechar um pane não mata servidor ainda usado | Passou | primeiro owner fechado, processo permaneceu para o segundo |
| Processo ocioso encerra por TTL | Passou | último owner fechado, disposals aguardados e pool chegou a zero sem retry de filesystem |
| Claude e Codex recebem respostas equivalentes | Passou na borda comum | ambos usam o mesmo manager/formatador; hashes foram determinísticos, sem smoke pago dos dois modelos |
| p95 quente abaixo de 100 ms | Passou | sete operações; também passou por request em c=32 |
| Pane continua funcional com falha ou ausência de LSP | Passou no contrato, sem PTY real | `SERVER_UNAVAILABLE` é compacto e recuperável; TS6 incompatível falhou fechado e o gate manteve fallback |
| TypeScript 7 existe no app empacotado | Passou | 108 bibliotecas, versão 7.0.2 e handshake stdio completo no `win-unpacked` |

Não foram automatizados nesta validação:

- RSS/Private Bytes dos filhos sob pressão prolongada;
- remoção de uma worktree Git enquanto o LSP ainda está ativo;
- smoke pago com contas/modelos Claude e Codex;
- falha de LSP dentro de um PTY real;
- invocação de `report(done)` por um modelo real antes/depois de
  `code_diagnostics`.

Esses limites não foram marcados como aprovados por inferência.

## Privacidade

Os dois JSONs foram verificados para não conter:

- caminho absoluto ou pasta temporária;
- texto da fixture, URI ou payload LSP;
- bearer token, `SYNKORA_TOKEN` ou chave de API.

Persistem apenas versões, ambiente agregado, tempos, contagens, tamanhos,
resultados booleanos e hashes SHA-256 das respostas compactas.
