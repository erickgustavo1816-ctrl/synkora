# Fase 5 — configuração e observabilidade

Data da validação: 2026-07-31.

## Resultado

A área global de Configurações ganhou a seção **Serviços**, seguindo a mesma
linguagem visual em papel do restante do Synkora. O estado padrão permanece:

- inteligência de código: **Automática**;
- MCP no Codex: **Automático**;
- serviços externos: **Preparação automática**;
- detalhes técnicos: recolhidos.

As preferências são persistidas com enumerações allowlisted. Valores antigos,
editados à mão ou recebidos por IPC fora dessas enumerações voltam para o
padrão seguro. Alterações concorrentes devolvem à UI o estado mais recente, sem
uma resposta lenta do desligamento do LSP sobrescrever outra preferência.

## Estado e ações

A tela resume quatro serviços sem expor configuração sensível:

1. inteligência de código, com linguagens realmente observadas nos documentos
   abertos, servidor/versão, processos e telemetria agregada;
2. MCP interno dual-era e sua porta local;
3. capacidade MCP 2026 do Codex por seat, sem revelar `CODEX_HOME`;
4. disponibilidade e versão do runtime Playwright local.

Cada cartão reinicia ou revalida somente o componente correspondente. O
desligamento da inteligência de código fecha sessões e processos e preserva o
fallback textual. O reinício do MCP mantém a mesma porta inclusive durante a
transição e após uma tentativa falha, para que os panes existentes não fiquem
apontando para um endpoint abandonado.

“Preparação automática” do Playwright significa resolver antecipadamente o
runtime local exato; nenhum browser ou processo MCP compartilhado é criado. No
modo “Sob demanda”, a checagem acontece apenas ao abrir um pane ou ao clicar em
**revalidar runtime**. A tela usa deliberadamente “Disponível sob demanda” em
vez de alegar um aquecimento que não existe.

## Métricas e privacidade

O resumo de preparação usa um ring buffer em memória, limitado a 200 marcos, e
mostra apenas amostras, mediana, p95 e primeiro frame. O estado do MCP interno é
retirado durante reinício/falha para não antecipar a marca de disponibilidade.

O snapshot padrão não contém paths. O caminho local do executável LSP só é
solicitado enquanto **Detalhes técnicos** está aberto. Nunca entram no snapshot
ou no resumo: prompt, output, conteúdo de arquivo/terminal, cwd/worktree,
token bearer, chave, variáveis de ambiente ou argumentos do cliente.

Uma auditoria dos 29 registros reais existentes em
`%APPDATA%/synkora/performance/pane-startup.jsonl` encontrou zero propriedades
proibidas e zero padrões de segredo. Os artefatos de benchmark também ficaram
sem paths de usuário e sem material de credencial.

## Validação no app real

A tela foi inspecionada e operada no Electron em 1442×902:

- navegação, hierarquia, rolagem, cartões e detalhes recolhíveis corretos;
- estados normalizados em português;
- inteligência de código desligada mostrou **Pesquisa textual preservada** e
  voltou corretamente para **Automática**;
- MCP reiniciado isoladamente permaneceu `ready` na porta **50752** antes e
  depois da ação;
- Codex `0.146.0` apareceu no fallback legado seguro;
- Playwright `0.0.78` apareceu como disponível sob demanda.

As preferências testadas foram restauradas aos padrões recomendados ao fim da
inspeção.

## Verificações automatizadas

- `npm run typecheck`: passou;
- `npm run build`: passou durante a integração e novamente na validação final;
- pacote `release/final/win-unpacked`: gerado após a última correção; probes
  reais do LSP TypeScript 7 e do Playwright MCP passaram nesse runtime;
- `npm run test:code-intelligence`: 8/8;
- `npm run test:mcp-protocol`: 5/5;
- `npm run test:playwright-runtime`: passou;
- `npm run test:mcp-dual-era`: 32 clientes simultâneos passaram.
