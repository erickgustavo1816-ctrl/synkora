# O MOCKUP É O CONTRATO — workspace de missão do Synkora 2.0

Aprovado pelo dono ("eu quero assim") e re-afirmado em 2026-08-14 depois de uma
execução errada ("tá parecendo um pane ainda"). Toda decisão visual do workspace se
mede CONTRA ESTE DOCUMENTO. O erro a nunca repetir: o chat NÃO é um painel escuro de
terminal — o chat é PAPEL.

## Estrutura (3 colunas dentro do Board)

```
┌ topbar ─────────────────────────────────────────────────────────────┐
│ ✦ synkora · <projeto>        [◈ v1.2] [fila ⇪ 1] [contas ●●●]       │
├──────────┬──────────────────────────────────────┬───────────────────┤
│ missões  │  CHAT (o palco — ocupa TUDO)         │ entrega           │
│ (cards)  │                                      │ +142 −18 · 6 arq  │
│          │  seletor de conversas no topo:       │ [ver diff]        │
│ plano/   │  [dev] [reviewer] [ajudante] [term]  │ [revisar·sessão   │
│          │                                      │  limpa]           │
│ + nova   │  mensagens em PAPEL, respirando      │ [+ ajudante]      │
│ missão   │  composer embaixo                    │ [terminal]        │
│          │                                      │ [⇪ fila da v1.2]  │
└──────────┴──────────────────────────────────────┴───────────────────┘
```

- Coluna esquerda ~200-240px; trilho direito ~180-220px; O CHAT FICA COM TODO O RESTO.
- Os números do projeto (◈ versão, contadores de missão, fila) são CHIPS NA TOPBAR —
  nunca um cartão ocupando o centro.

> **EMENDA DE 2026-08-15 (ordem do dono) — a cláusula acima vale no workspace de
> MISSÃO, não no ✦ geral.** O diagrama descreve a tela com uma missão selecionada:
> ali o centro é da conversa, e por isso os números moram nos chips. No ✦ geral não
> há conversa nenhuma disputando o espaço, e a tela passou a ter duas caras:
>
> - **universo sem NENHUMA missão** → o CONVITE (`ProjectGeneral`): um cartão único
>   centralizado na coluna, na mesma família visual do modal de nova missão;
> - **a partir da primeira missão, em qualquer status** → o PAINEL DO PROJETO
>   (`ProjectDashboard`): KPIs (em andamento · integradas · na fila ⇪ · arquivadas),
>   retrato compacto por versão e UMA LINHA POR MISSÃO — estado, ◈ versão, ⎇ branch
>   (ou ✎ planejamento), posição na fila e o âmbar de "esperando você".
>
> O que justifica a emenda: os chips da barra dizem QUANTAS; o painel diz QUAIS — e é
> a pergunta "qual missão está me esperando?" que o dono faz ao abrir o universo. Os
> `.ws-chips` do cabeçalho FICAM (eles são visíveis de qualquer aba). A regra de
> superfície não muda: o painel é PAPEL — `--panel`/`.term-window` continuam
> exclusivos de terminal.
>
> Na mesma ordem, a FOTO do universo deixou de ter rodapé no ✦ geral: ela se troca
> clicando no avatar do titlebar (`.tb-title-avatar`) ou no do cabeçalho do workspace
> (`.ws-avatar`) — os dois no alto da janela, alcançáveis de qualquer aba.

## Anatomia do chat (fundo PAPEL `--paper`, nunca `--panel`)

1. **Cabeçalho fino da conversa**: `dev · opus 4.8 · mission/1f3a` em texto apagado
   (`--ink` ~55%), UMA linha, sem barra escura de pane.

   > **Emenda 2026-09-08 (ordem do dono: "muita informação, tudo repetido; a única
   > coisa que gosto são os botões")**: a linha fina MORREU, e com ela o cabeçalho
   > próprio do chat. A cabeça do palco é UMA fileira de ~40px:
   > `[lateral] [pílulas de conversa] ··· [● estado do turno · relógio] [logo do
   > CLI + conta ▾] │ [⇪ ▷ ⌕ ▭ ⋮]`. Só notícia vira palavra (parado = nada);
   > modelo e effort moram no composer; a branch mora no trilho de entrega; o ⎇
   > que copiava o id da missão foi dispensado. Palco estreito (< 640px) guarda
   > só os sinais; pílulas de sobra quebram para baixo. Mockup aprovado com o CSS
   > real: `scripts/harness/stage-head.html` (módulos `MissionStageHead`,
   > `StageRoundStatus`, `StageSeatChip`).
2. **Injeção/1º prompt**: cartão sutil cinza-tinta `📄 002-auth.md · injetada como 1º
   prompt` (fundo rgba(ink, .05), borda rgba(ink, .12), radius 6).
   > **Emenda 2026-09-09**: a FALA DO DONO é laranja — fundo `accent 22%` sobre
   > papel, borda `accent 75%`, texto em ink (branco sobre o acento reprova o
   > AA em 13px) e o rótulo "VOCÊ" em `accent-deep` — para "destacar bem o que
   > é meu e o que é da IA". E o "ir para o fim" virou um botão redondo de 30px
   > só com a seta, no canto do fio: o pill com texto flutuava por cima das
   > frases.

3. **Mensagem do dev**: texto direto no papel, ink, line-height ~1.5. Perguntas com
   botões inline quando fizer sentido (ex.: mini-plano → [aprovar] [ajustar], borda
   accent, fundo papel).
4. **Tool cards**: linha compacta, fundo rgba(ink, .06), radius 6, ícone + `Edit ·
   src/auth/AuthContext.tsx` + resultado à direita (`+84` verde, `✓ 14 passed` verde,
   erro vermelho). NUNCA um bloco escuro.
5. **Card de permissão**: borda `--accent`, fundo rgba(accent, .10), ícone de mão +
   `permissão: <comando>`, botões [permitir] (accent) [sempre] (ink) [negar]
   (vermelho) — altura de botão pequena, uppercase opcional.
6. **Streaming**: texto ink apagado + cursor `▍` piscando.
7. **Composer**: input claro com borda rgba(ink, .28), placeholder "dirija o dev — ou
   peça um reviewer", mic à direita, botão enviar quadrado accent com seta branca,
   seletor de modo de permissão (⛭ padrão) discreto à esquerda do input.

## Seletor de conversas (o "escolher qual chat")

Linha fina no topo do palco: pílulas por conversa aberta da missão — `dev` ·
`reviewer` · `ajudante 1..n` · `terminal` (terminal abre o TerminalPane NO MESMO
palco). No ✦ geral: `planejamento`. Pílula ativa = fundo ink, texto papel; inativas =
borda ink. Fechar conversa pelo ✕ na própria pílula (com confirmação quando viva).

## Mapa

A aba MAPA mostra O PLANEJAMENTO — o quadro de rotas: linha = versão (aberta em
destaque, lançada apagada ✓), colunas = backlog · rodando · fila ⇪ · integrada,
ficha = missão (dot de status; âmbar pulsando quando espera o dono). Clique na ficha
abre a missão no Board. SEM constelação, SEM física (a constelação fica dormente no
código).

## Paleta (a de sempre)

papel `#efe9dc` · ink `#26241f` · accent `#d96c3f` · ok `#3e9b5f` · err `#b54036` ·
warn `#d9a23f` · mono Cascadia. Painel escuro `--panel` é EXCLUSIVO de terminal
(TerminalPane) — nenhuma superfície de chat o usa.

O err tem PAR: `--err` (`#b54036`) é o de papel, 4,63:1 — o `#c4453a` de antes
media 4,08:1 e reprovava o piso AA de texto pequeno. `--err-on-dark` (`#e8897f`)
é o mesmo vermelho para painel escuro (6,14:1 sobre `--panel`), porque o de
papel cai para 2,77:1 lá. Texto vermelho em superfície escura usa o par escuro.
