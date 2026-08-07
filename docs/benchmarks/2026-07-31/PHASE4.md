# Fase 4 — MCP 2026-07-28 em modo dual

Data da validação: 2026-07-31. Resultado bruto:
[`phase4-mcp.json`](./phase4-mcp.json).

## Resultado

O servidor interno foi migrado do SDK monolítico v1 para os pacotes exatos
`@modelcontextprotocol/server`, `@modelcontextprotocol/node` e
`@modelcontextprotocol/client` **2.0.0**. O mesmo handler HTTP serve as duas
eras, com uma única fábrica de ferramentas e sem duplicar catálogos:

- legado: `initialize` → `notifications/initialized` → `tools/list`;
- moderno: `server/discover` → `tools/list`, fixado em `2026-07-28` no teste;
- 16 clientes de cada era funcionaram simultaneamente no mesmo listener.

O benchmark legado existente também foi repetido após a migração. Seus quatro
perfis e 12 cenários continuaram negociando `2025-06-18`; o cliente oficial v2
usado na nova matriz escolheu `2025-11-25` para a própria conexão legada. As
duas revisões legadas são aceitas pelo mesmo build.

Comandos reproduzíveis:

```text
npm run test:mcp-protocol
npm run test:mcp-dual-era
npm run bench:mcp -- --rounds 1
```

## Compatibilidade e segurança

A matriz usa o cliente oficial v2 e o servidor real de
`src/main/mcpServer.ts`. Ela passou para:

- chamada de ferramenta nas duas eras e ordem determinística do catálogo;
- bearer ausente, inválido e revogado retornando `401`;
- token de outro pane mantendo a identidade do dono do bearer;
- argumentos falsos de `paneId` e `cwd` sem substituir a identidade do Hub;
- `Host` e `Origin` externos retornando `403`;
- rota parecida, mas diferente de `/mcp`, retornando `404`;
- cancelamento moderno por `AbortSignal` em **41,684 ms**, seguido de nova
  chamada válida no mesmo cliente;
- desconexão durante chamada pendente encerrando a promessa, sem hang;
- 32 clientes concorrentes, divididos em 16 legados e 16 modernos.

O catálogo permaneceu equivalente entre agente livre, dev, review, QA e
ajudante, com **24 ferramentas**. O PM recebeu 27 e o orquestrador de missão,
28. Os nomes e hashes de cada perfil estão no JSON bruto.

## Cache moderno

`tools/list` e `server/discover` anunciam `ttlMs: 300000` e
`cacheScope: private`. Uma segunda chamada `listTools()` do cliente moderno
foi atendida do cache e gerou **zero request HTTP adicional**. Respostas
legadas não receberam os campos modernos.

## Latência

Foram executadas 30 conexões completas por era no mesmo ambiente local:

| Etapa | Legado mediana / p95 | Moderno mediana / p95 |
|---|---:|---:|
| Conexão/negociação | 4,696 / 8,838 ms | 2,176 / 4,134 ms |
| Primeiro `tools/list` | 3,394 / 5,804 ms | 3,010 / 6,363 ms |

O ganho observado é pequeno em termos absolutos: cerca de **2,5 ms** na
mediana da negociação e **0,4 ms** no primeiro catálogo. O benefício principal
desta fase é compatibilidade e cache explícito, não uma promessa de aceleração
perceptível do pane.

## Detecção dos clientes

O Synkora sonda `codex --version` e `codex features list` por seat, com cache de
10 minutos e single-flight. A revisão moderna só é considerada disponível
quando a versão é pelo menos `0.147.0-alpha.1` **e** a linha exata
`mcp_2026_07_28` existe. `auto` exige ainda que a feature já esteja ativa;
`legacy` força a desativação somente quando a capacidade foi comprovada; o
modo experimental só injeta `--enable` quando a mesma prova passou.

Neste ambiente, Codex `0.146.0` anuncia a feature como desligada, mas fica
abaixo do primeiro build com implementação real. O resultado efetivo é legado,
inclusive no opt-in experimental, sem impedir a abertura do pane. Claude Code
`2.1.220` permanece no caminho legado. Voltar para `legacy` é apenas uma
configuração e não requer downgrade do aplicativo.

## Privacidade

O artefato bruto não contém bearer, token, chave, `CODEX_HOME`, caminho de
worktree ou payload de arquivo. Persistem apenas versões, métodos, nomes/hashes
de ferramentas, resultados booleanos, contagens e tempos agregados.
