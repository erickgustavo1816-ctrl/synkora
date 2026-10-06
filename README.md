# Synkora

**Synkora** é um ADE (*Agentic Development Environment*) para desktop: um ambiente onde você organiza projetos e conversa com agentes de IA que trabalham no seu código, cada missão isolada no seu próprio worktree Git.

> **English summary:** Synkora is a desktop Agentic Development Environment built with Electron, React and TypeScript. It runs AI coding CLIs (Claude Code and Codex) inside a GUI chat, gives each task ("mission") its own isolated Git worktree, and lets you use several CLI accounts ("seats") side by side. It is a personal project in active development, released under the MIT License.

## Status

Projeto pessoal em desenvolvimento ativo (versão `0.2.2`). O alvo principal hoje é **Windows**. Há instruções para gerar o app em **macOS com Apple Silicon** ([docs/INSTALAR_MACOS.md](docs/INSTALAR_MACOS.md)), mas a primeira execução nativa no Mac ainda precisa ser validada.

Espere mudanças frequentes. A interface e a documentação interna são em português; código e identificadores, em inglês.

## O que ele faz

- **Projetos como universos.** Cada projeto tem as suas missões, documentos e histórico.
- **Missões em chat.** Cada missão abre um chat com um agente rodando sobre um CLI de IA (Claude Code ou Codex), trabalhando num worktree Git isolado. Também há um modo para projetos sem Git, uma missão por vez direto na pasta.
- **Várias contas lado a lado ("seats").** Cada conta de CLI usa o seu próprio diretório de configuração isolado.
- **Delegação sem abas.** O agente principal pode delegar fatias de trabalho para ajudantes em segundo plano por meio de um servidor MCP local.
- **Fila de integração.** O resultado de uma missão volta para o projeto por uma fila de integração.
- **Painéis auxiliares.** Terminais shell da missão, navegador embutido e painel mobile (emulador Android e, no macOS, simulador iOS).
- **Skills.** Biblioteca de skills que os agentes podem usar por missão.
- **Atualização automática** do app instalado no Windows.

## Tecnologias

Electron, electron-vite, React 19 e TypeScript (strict). A persistência é feita em arquivos JSON no diretório de dados do usuário, sem banco de dados nativo. Os terminais usam `@lydell/node-pty`.

## Como rodar

Pré-requisitos:

- **Node.js 22.12 ou superior** (Node 24 LTS atende);
- Git;
- pelo menos um CLI de IA instalado e autenticado na sua máquina: [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) ou Codex.

```sh
git clone https://github.com/erickgustavo1816-ctrl/synkora.git
cd synkora
npm ci
npm run dev
```

Outros comandos:

| Comando | O que faz |
|---|---|
| `npm run typecheck` | Verificação de tipos do main/preload e do renderer |
| `npm run test:gui-system` | Verificação principal: typecheck e as suítes de teste do sistema |
| `npm run build` | Build de produção |
| `npm run dist` | Gera o instalador localmente, sem publicar |

O Synkora não traz contas nem credenciais. Ele usa os CLIs que você já instalou e autenticou.

## Estrutura

- `src/main/` — processo principal do Electron: janelas, IPC, stores, sessões dos CLIs, servidor MCP local, worktrees.
- `src/preload/` — ponte `window.synkora` entre o main e a interface.
- `src/renderer/src/` — interface em React.
- `build/skills/` — skills empacotadas com o app (várias de terceiros; veja abaixo).
- `docs/` — planos, decisões (`docs/adr/`) e registros de sessão do desenvolvimento.

## Segurança

Para relatar uma vulnerabilidade, **não abra uma issue pública**. Veja [SECURITY.md](SECURITY.md).

## Licença

O código do Synkora é distribuído sob a [licença MIT](LICENSE).

O repositório também inclui trabalhos de terceiros (skills e o servidor do scrcpy), cada um sob a sua própria licença. Créditos e textos completos em [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
