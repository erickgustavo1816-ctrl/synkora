# CONTEXT.md — glossário do domínio (linguagem ubíqua)

Nascido na sessão grill-with-docs de 2026-08-21 (Skills 2.0). Termo novo entra
quando cristaliza; termo que conflitar com este glossário é chamado na hora.

## Skills 2.0 (ADRs 0001–0007 em docs/adr/)

- **Biblioteca** — o conjunto instalado em `%APPDATA%\synkora\skills\lib`.
  Após a poda do v1 (refinamento do dono), a biblioteca É o kit aprovado —
  uma skill excelente por ocasião; as ~400 da era F6 saem do disco (fontes
  pinadas documentadas no SKILLS.md permitem reinstalar qualquer uma).
  Cresce só por instalação manual do dono, pinada por sha.
- **Kit** — o subconjunto CURADO da biblioteca que um tipo de chat recebe
  (dev / planejamento; release não tem). Curto por lei. Vive como DADO
  (userData), semeado pela proposta aprovada no veto do dono.
- **Ala** — as duas metades do kit dev: EXECUÇÃO (técnicas por domínio) e
  ORQUESTRAÇÃO (planejar/designar a frota). Sempre presentes as duas; o modo
  (dev solo × orquestrador) é o momento, nunca um campo.
- **Cardápio** — o que o agente VÊ: nome + uma linha por skill do kit,
  servido nativamente pelo CLI a partir da pasta sincronizada no worktree.
- **Lei** — skill OBRIGATÓRIA numa ocasião, fixa na persona (nunca no toggle
  da tela). Única no v1: UI ⇒ impeccable. O resto do cardápio é julgamento do
  agente (revisão do dono na mesma sessão: orquestração NÃO é lei — o ofício
  comum é planejar/destrinchar, e a mecânica de delegação mora na persona).
- **Ocasião** — o momento de trabalho que pede uma skill (ex.: "vai mexer em
  UI", "vai delegar"). Leis são por ocasião, nunca por missão inteira.
- **Sync** — a materialização do kit na pasta de skills do worktree da missão
  no spawn (git-excluded). Falha de sync NUNCA é silenciosa: nota no chat.
  Toggle da tela vale para o próximo spawn, não re-sincroniza conversa aberta.
- **Destrinchar** — o ofício comum aos dois modos do chat dev e ao chat de
  planejamento: quebrar o trabalho em fatias executáveis (pra frota ou pra
  si). É servido por skill de PLANEJAMENTO do cardápio, nunca por lei. A
  mecânica de delegação da casa (gui-delegator, fatias disjuntas, ciclo
  redondo, orquestrador barato) mora na PERSONA. Skills de mercado que
  ensinam o subagente NATIVO do CLI seguem vetadas (caminho cercado).
