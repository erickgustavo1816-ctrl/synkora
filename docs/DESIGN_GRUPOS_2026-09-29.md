# Grupos de universos — design técnico (2026-09-29)

Missão "Nova features de Grupos". **O mockup é o contrato visual**:
`docs/mockups/grupos-universos-2026-09-29.html` (aprovado pelo dono; última
revisão no commit `885acde`). Abrir no browser e seguir as NOTAS dele.

## Decisões do dono (não reabrir)

- **Rail estilo Discord.** Arrastar um universo sobre outro cria um grupo
  (pasta). A pasta fechada mostra uma grade 2×2. Clicar abre a pasta como uma
  cápsula e clicar no ícone de pasta do topo fecha. Arrastar para fora tira do
  grupo. **Um grupo com 1 universo continua; um grupo vazio some.**
- **Nome à la iPhone.** Um grupo novo nasce "grupo N" e a folha de nome abre
  com o texto selecionado. **Cor opcional:** `PROJECT_GROUP_HUES` mais a
  neutra, que é o padrão.
- **Geometria da pasta = Discord** (medida no recorte do dono):
  - pasta de 46 px, com fundo **mais claro que as miniaturas** e sem contorno
    (`#413d35`; com cor, `hsl(h 18% 28%)`);
  - miniaturas de 18 px com raio de 7 px e vão de 2 px, com fundo
    `hsl(hue 30% 18%)` (mais escuro que a pasta);
  - com mais de 4 universos: 3 miniaturas e um `+N`.
- **Hover da pasta:** SÓ o nome do grupo. **Hover do universo:** nome e estado.
  Sai a linha "clique direito: definir foto".
- **Clique direito no rail vira menu:**
  - universo: `definir foto…`, a lista "mover para grupo", `+ novo grupo…` e
    `tirar de X`;
  - grupo: `renomear e cor…`, `abrir/fechar no rail` e `desfazer grupo`.
- **Nome sob a pasta:** preferência `railGroupNames` em Ajustes, ligada por
  padrão.
- **Topo da Home idêntico ao atual.** Abaixo dele vem o **índice**:
  - uma busca e os controles FILTRAR (estado + período de criação), ORDEM e
    visão (por grupo | todos juntos);
  - as **abas de grupo** sobre uma régua, com a contagem que obedece aos
    outros filtros;
  - os filtros ativos viram **etiquetas removíveis**, com
    "mostrando N de M · limpar tudo".
- **A ordem "atividade recente" do mockup vira "abertos por último"**
  (`lastOpenedAt`). `Mission.updatedAt` NÃO é atividade (ver o comentário em
  `store.ts`).
- **Na Home ficam lembrados** a aba, os filtros, a ordem e a visão
  (localStorage). O texto da busca não fica.
- Mover de grupo na Home é pelo `···` do card. Arrastar cards na Home fica
  fora desta missão.

## Contratos já no código (commit `1e1bc3f`)

- `src/shared/projectLayout.ts`: vocabulário (`ProjectLayout`,
  `ProjectLayoutOp`, `ProjectLayoutDropTarget`, `PROJECT_GROUP_HUES`,
  `PROJECT_GROUP_NAME_MAX`).
- `window.synkora.projectLayout.{get, apply, onChanged}` (preload), com os
  canais `projectLayout:get`, `projectLayout:apply` e `projectLayout:changed`.
- `src/renderer/src/projectLayoutStore.ts`: `useProjectLayout` com
  `{ layout, sheetGroupId, sheetSelectName, load, apply, openGroupSheet,
  closeGroupSheet }`.
- `settings.railGroupNames` (em `main/settingsCore.ts` e no espelho do preload).

## Frente A — dados (main)

Arquivos: `src/shared/projectLayoutOps.ts` (NOVO, puro),
`src/main/projectLayoutStore.ts` (NOVO), `src/main/ipc/projectLayout.ts`
(NOVO), `src/main/index.ts` (registro), `src/main/ipc/projects.ts`
(reconciliar depois de criar ou remover), `src/renderer/src/store.ts` (SÓ o
`touchOpened` em `openProject`), `src/renderer/src/devMock.ts` (layout em
memória usando as ops), `scripts/test-project-layout.mjs` (NOVO).

- `applyProjectLayoutOp(layout, op, { newId })` é **imutável** e nunca lança.
  Um id desconhecido devolve o layout igual. Grupos vazios são podados ao fim
  de TODA operação.
- O nome de grupo novo é o primeiro "grupo N" livre, comparando sem
  maiúsculas nem acentos.
- `renameGroup` apara o texto e corta em 24 caracteres. Nome vazio mantém o
  anterior.
- Referência depois do destacamento: tire o item e SÓ ENTÃO localize a
  referência. Se a referência for o próprio grupo esvaziado, insira antes de
  podar.
- `reconcileProjectLayout(layout, projectIds)`:
  - remove ids desconhecidos das entradas e de `lastOpenedAt`;
  - deduplica (vence a primeira ocorrência);
  - acrescenta os universos novos no FIM, soltos, na ordem de `projectIds`;
  - poda grupos vazios e saneia nome e cor.
- `sanitizeProjectLayout(raw: unknown)` é tolerante e nunca lança (arquivo
  corrompido = layout vazio).
- Persistência em `userData/project-layout.json` via `persistJsonStore`. O
  `get` sempre devolve o layout reconciliado com `ProjectStore.list()`.
- Depois de `apply`, e quando a reconciliação muda algo, envia
  `projectLayout:changed` para todas as janelas.

## Frente B — rail (renderer)

Arquivos: `components/ProjectRail.tsx`, `components/ProjectRail.css`, e os
NOVOS `components/RailGroupFolder.tsx`, `components/RailGroupSheet.tsx`,
`components/RailContextMenu.tsx`, `railDragModel.ts` (puro),
`useRailDrag.ts`, `railGroupPresentation.ts` (puro) e
`scripts/test-rail-groups.mjs`.

- **Arrastar:** os limiares, a linha de 3 px no acento, o fantasma, a pílula
  "soltar: …", a rolagem automática, o Esc que cancela, os 5 px de tolerância
  e a supressão do clique pós-arraste são todos os do mockup
  (`computeTarget`).
- **Sem layout carregado:** o rail desenha a lista plana de `projects`.
- **Continua valendo:** a atenção e a atividade de cada universo, o ícone
  cinza de pasta sumida, a pílula do ativo, o Home fixo e as bordas esmaecidas.
- **Pasta fechada que contém o universo aberto:** ganha a pílula, e a
  miniatura dele ganha um anel.
- **Sinal agregado da pasta:** atenção > rodando > pausado > pasta sumida.
- **Miniaturas:** mostram `project.photo` quando existe; sem foto, a inicial
  sobre a cor.
- **Folha do grupo:**
  - portal ancorado ao lado da pasta, com bico;
  - nome grande e centralizado (máx. 24), selecionado quando `sheetSelectName`;
  - Enter, `pronto` ou clique fora gravam; Esc desfaz o nome e a cor;
  - a cor aplica na hora; `desfazer grupo` também está ali.
- **Menu:** portal; teclado (tecla ContextMenu ou Shift+F10, setas, Esc).
  Nunca `window.confirm`.

## Frente C — Home e Ajustes (renderer)

Arquivos: `screens/Home.tsx`, `components/UniverseCard.tsx`, e os NOVOS
`components/HomeIndexBar.tsx`, `components/HomeGroupSection.tsx`,
`components/HomeIndex.css` e `homeIndexModel.ts` (puro). Mais o NOVO
`components/RailGroupSettings.tsx`, `screens/Settings.tsx` (montar o ajuste)
e `scripts/test-home-index.mjs`.

- **As âncoras do campo de partículas continuam:** `project:<id>` e
  `universos`.
- **Estados:**
  - rodando = algum painel com `paneActivity === 'run'`;
  - precisa de você = algum `paneAttention`;
  - com missão ativa = `homeStats[pid].missoesAtivas > 0`;
  - pasta sumida = `project.missing`.
- **Período:** conta a partir de `project.createdAt`.
- **Busca:** ignora acentos e procura no nome, na pasta e no grupo, com
  `<mark>` no nome e na pasta do card.
- **Visão por grupo:** seções na ordem do layout e "sem grupo" por último. O
  nome da seção renomeia ali mesmo. O `···` da seção abre o menu do grupo.
- **Uma aba de grupo escolhida:** a grade vem sem cabeçalho.
- **Card:** ganha uma linha própria com a etiqueta do grupo (na visão "todos
  juntos") e a data ("criado 24 set 2026", ou "aberto há 2 h" na ordem
  "abertos por último").
- **Menu do card:** ganha "mover para grupo". O `+ novo grupo…` chama
  `createGroup` e em seguida `openGroupSheet(id, true)`.
- **Ajustes:** interruptor "Nome do grupo sob a pasta" →
  `patchSettings({ railGroupNames })`.

## Testes e regras

- Cada frente tem uma suíte `node --test` pura, que falha sem a
  implementação. O ORQUESTRADOR liga as suítes no `package.json` e no gate.
- Nenhuma dependência nova. Seletores zustand com referência estável.
  Overlays via portal. Nada de `global.css` (CSS novo em arquivo novo).
  Nunca rodar o app do dono.
