# Fase 1 — Playwright MCP local e fixado

Data: 2026-07-31  
Plataforma: Windows x64, Node 24.13.0, Electron 43.1.1  
Versão fixada: `@playwright/mcp` 0.0.78

## Resultado

A abertura normal de pane não usa mais `npx`, `@latest`, registry ou download. O
Synkora inicia diretamente o CLI instalado em `dependencies`; no Electron, apenas
o filho MCP recebe `ELECTRON_RUN_AS_NODE=1`.

O Playwright Test só é oferecido quando a própria worktree declara e contém uma
instalação física compatível. A dependência transitiva do Synkora não habilita o
test runner por acidente. Instalações npm e pnpm, versões antigas sem
`run-test-mcp-server` e caminhos fora da worktree fazem fallback sem bloquear o
pane.

## Antes e depois

| Cenário | Fase 0 | Fase 1 | Redução |
|---|---:|---:|---:|
| MCP externo isolado até `tools/list` | 1.306,143 ms | 206,593 ms | 84,2% |
| 1 pane estrito: MCP externo | 1.251,887 ms | 206,673 ms | 83,5% |
| 1 pane estrito: primeiro frame | 1.590,847 ms | 552,714 ms | 65,3% |
| 8 panes estritos: MCP externo (mediana) | 1.570,248 ms | 248,693 ms | 84,2% |
| 8 panes estritos: primeiro frame (mediana) | 2.011,809 ms | 725,694 ms | 63,9% |
| 32 MCPs externos (mediana) | 3.324,124 ms | 434,713 ms | 86,9% |

A meta de redução mínima de 50% foi superada em todos os cenários comparáveis.
O lote de 32 panes também terminou por completo nesta rodada. A falha intermitente
`0xC0000005` observada na Fase 0 pertence ao backend ConPTY do benchmark; o
script isola cada lote e registra a falha sem esconder os dados do MCP.

## Equivalência e empacotamento

O handshake real (`initialize`, `initialized`, `tools/list`) produziu exatamente
24 ferramentas em desenvolvimento e no aplicativo empacotado. Os nomes ordenados
têm o mesmo SHA-256 nos dois ambientes:

`12d23fea9d8d1a1de3f44863dc00cf393f0a2165323838cf93fed30a6a4cc237`

O build de validação foi criado separadamente em `release/phase1/win-unpacked`,
preservando releases anteriores. Foram verificados fisicamente no
`app.asar.unpacked` o entrypoint do MCP, `playwright`, `playwright-core`, seus
bundles e `browsers.json`. O cache `%LOCALAPPDATA%\\ms-playwright`, os diretórios
`.local-browsers` e os PIDs de browsers permaneceram inalterados: nenhum browser
foi baixado ou iniciado durante a validação.

Os wrappers Codex são versionados por hash do comando, argumentos e ambiente;
configs Claude recebem a mesma especificação direta. Caminhos com espaços,
apóstrofo e caracteres TOML foram validados sem retornar ao shell/npm.

## Evidências

- [`phase0-mcp.json`](phase0-mcp.json) e [`phase1-mcp.json`](phase1-mcp.json)
- [`phase0-pane-startup.json`](phase0-pane-startup.json) e
  [`phase1-pane-startup.json`](phase1-pane-startup.json)
- [`phase1-playwright-dev.json`](phase1-playwright-dev.json)
- [`phase1-playwright-dist.json`](phase1-playwright-dist.json)

## Critérios de aceite

- [x] zero `npx -y ...@latest` no caminho normal de runtime;
- [x] zero download ao abrir pane;
- [x] MCP de browser preservado, com catálogo idêntico;
- [x] Playwright Test preservado somente em projetos compatíveis;
- [x] redução superior a 50%;
- [x] desenvolvimento e aplicativo empacotado validados por handshake real.
