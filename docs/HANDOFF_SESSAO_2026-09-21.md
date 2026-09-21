# HANDOFF — Sessão 2026-09-21 (a primeira missão do Synkora sobre o Synkora)

Missão "Atualização do Synkora", aberta pelo dono no Synkora INSTALADO (0.1.0)
sobre o próprio repositório. Orquestrador Fable com dois ajudantes gpt-6-astra
(pino do painel): `updater-main` (motor do atualizador) e `ci-and-skills`
(skills empacotadas + Action). Front-end e costuras pelo orquestrador.
Playbook da missão em `.claude/skills/mission-playbook/`.

## Os três pedidos do dono

1. **Print**: toda missão nova abria com "⚠ não consegui preparar
   'better-writing'… e mais 8" — DUAS vezes.
2. **Vídeo**: a animação da fala "escreveu duas vezes".
3. **Atualizador**: versão no canto inferior esquerdo (rail dos universos),
   baixa sozinho do GitHub, instala dentro do Synkora, sem instalador na tela.
   Decisões dele (cartão): releases num repo público separado
   (`synkora-releases`, o código continua privado) e skills EMPACOTADAS no
   instalador. Depois de aprovar o mockup da escrita: "queria que tivesse na
   config como configurar a velocidade, a cadência".

## Diagnósticos (provados)

- **Skills**: o app empacotado tem userData próprio (`%LOCALAPPDATA%\Synkora`,
  decisão de 2026-08-08) e a biblioteca lá tinha 1 skill; o kit semeado cita 16
  que só existiam em `%APPDATA%\synkora` (dev). Caixa-preta do instalado:
  `skills-sync failures: 12`. A nota saía duas vezes porque a troca do modo de
  permissão RESPAWNA o pane (`gui-session-closed reason: respawn`) e cada
  nascimento roda o sync + a nota.
- **Escrita**: cada `GuiStreamText` tinha o próprio `setInterval` de 52 ms —
  o commentary (item 1) e a fala seguinte (item 2) digitavam JUNTOS (folhas de
  contato do vídeo em 10 fps); ao terminar, o pai trocava o container de
  streaming pelo final e o `rise` do `.gui-msg` tocava de novo (o "pisca").
- **Mini-plano sumido** (bug 3 relatado no meio): o JSONL da própria sessão do
  claude mostra a mensagem com dois blocos `thinking` + `tool_use`, SEM bloco
  de texto — o plano ficou no canal de raciocínio (que o chat esconde por
  regra). Não é perda do Synkora. Mitigação de processo: o plano vai também
  dentro do cartão de pergunta.

## Entregue

### A escrita do chat (renderer + settings)

- `guiStreamReveal.ts` (puro): UM escritor por conversa (`guiWriterIndex`,
  `guiHeldItems`), cadência adaptativa por tempo (`guiRevealWordsThisTick`:
  base em palavras/s; passo maior só quando o pendente estoura `maxLagMs`;
  texto completo drena em 600 ms; nunca meia palavra), régua das preferências
  (`guiWritingPaceOf`).
- `guiRevealPaint.ts` (DOM): depois do patch de prefixo estável (R35), envolve
  as últimas palavras do ÚLTIMO bloco em `.gui-word-in` com `animation-delay`
  negativo (o fade continua do valor atual) e pendura o `.gui-caret` no fim do
  texto. `GuiMarkdown` ganhou `onPainted`.
- `GuiStreamText.tsx`: um componente, um container, do primeiro delta à
  mensagem parada (`stream` sai, cor assenta por transição; botão de copiar
  dentro). `GuiPane`: `guiHeldItems` no fio + decisões (pergunta/plano/
  proposta) esperam o escritor drenar (`writerBusy`); permissão NÃO espera.
- Ajustes › Aparência › **Escrita do chat** (`ChatWritingSettings.tsx`):
  velocidade (0–60 palavras/s, 0 = instantâneo), atraso máximo (0,3–3 s),
  "a palavra assenta". `settingsCore.ts` + espelho no preload.
- Mockup aprovado: `docs/mockups/chat-writer-2026-09-21.html`.

### O atualizador (main + preload + renderer + CI)

- `src/main/appUpdate.ts` (controlador injetável sobre electron-updater 6.8.9:
  checa 15 s após o boot e a cada 6 h; autoDownload; instala em silêncio com
  `quitAndInstall(true, true)` DEPOIS do guard de quit do mobile; erros em
  PT-BR; caixa-preta `app-update`) + `src/main/ipc/appUpdate.ts` (4 handlers
  guardados; push `app-update:status`) + preload `appUpdate` + costura no
  `index.ts` antes do IPC misc. Dev = `unsupported` com motivo.
- `AppUpdateBadge.tsx` + `appUpdatePresentation.ts` (puro) no pé do
  `ProjectRail`: em dia (número quieto) · verificando · disponível/baixando
  (↓ + barra de 2 px) · pronto (pílula no acento, pulso lento) · falha (! âmbar);
  clique em "pronto" abre folha de confirmação (portal) → `install()`.
- `electron-builder.yml`: `publish` (github, `erickgustavo1816-ctrl/
  synkora-releases`, releaseType release) + `extraResources build/skills →
  skills`; `dist` local com `--publish never`.
- `.github/workflows/release.yml`: push em `main` → lê `version` → se a release
  `v<version>` não existe em `synkora-releases`: typecheck, build,
  `electron-builder --win --publish always` (token `RELEASES_TOKEN`), artifact
  de diagnóstico; inicializa o repo público vazio com um README só na primeira
  vez. Ações pinadas por SHA.
- `docs/ATUALIZACAO_AUTOMATICA.md`: o fluxo e a configuração única do dono.

### Skills no app instalado (main)

- `build/skills/<id>` (16 pastas, 213 arquivos, 3,2 MB, `BUNDLE.json` com
  procedência, `.gitattributes * -text`) → `resources/skills`.
- `src/main/skillsBundle.ts`: `seedBundledSkills` (puro; nunca sobrescreve a
  biblioteca do dono; recusa links; manifesto pelo helper atômico existente) +
  `seedBundledSkillsAtBoot` costurado no `index.ts` logo após `endBootStores()`.
- `guiSpawnSkills.ts`: a nota de falha sai UMA vez por pane por boot
  (`deduped` na caixa-preta).

## Provas

- Red-first comprovado: fences do chat (3 asserções velhas quebradas antes),
  settings (campos novos ausentes), skills-bundle e spawn-skills (nota dupla e
  módulo inexistente), app-update (módulo inexistente).
- Suítes: `test:gui-stream-writer` 9 + prova NATIVA (Electron offscreen: dois
  parágrafos em sequência, mesmo nó DOM do primeiro delta ao fim, um caret só;
  capturas `.synkora/reports/chat-writer-{mid,end}-2026-09-21.png`);
  `test:app-update-badge` 8 + prova nativa (pé do rail, 4 estados, folha de
  confirmação; capturas `app-update-badge-*-2026-09-21.png`);
  `test:app-update` 23; `test:skills-bundle` 16; chat-ui 156; settings 7;
  typecheck verde. Gate raiz: ver "Estado do gate" abaixo.

## Pendências

- **Configuração única no GitHub (do dono)**: criar o repo público
  `synkora-releases` vazio; token fine-grained com Contents: Read and write
  nele; secret `RELEASES_TOKEN` no repo privado. Sem isso a Action para com a
  mensagem certa.
- **A primeira versão com o atualizador ainda entra pelo instalador**: o 0.1.0
  instalado não sabe se atualizar. A partir da próxima, o selo cuida.
- Não validado ao vivo (por design desta missão): a instalação NSIS silenciosa
  de ponta a ponta e o boot do app instalado semeando a biblioteca — ambos são
  a próxima release.
- O app do dono precisa de RESTART para main/preload novos (HMR só no renderer).

## Estado do gate

(preenchido ao fim da sessão — ver o commit.)
