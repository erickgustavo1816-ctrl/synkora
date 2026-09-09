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
- **Lei** — REVOGADA em 2026-09-08 (ADR-0008). Era a skill obrigatória numa
  ocasião (UI ⇒ impeccable). Hoje não há lei de skill: fica o PADRÃO
  declarado na persona (interface pede UMA direção de design escolhida pela
  obra; pular é decisão dita). Impeccable é slot comum da prateleira.
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

## Skills 3.0 (ADRs 0008–0011 em docs/adr/, 2026-09-08)

- **Prateleira** — o que o kit do dono virou: o cardápio que entra no worktree
  no spawn é ponto de PARTIDA, nunca cerca. A tela de gestão continua sendo
  dela.
- **Catálogo da casa** — as ~275 skills curadas e verificadas na fonte na era
  F6, agora como DADO offline (`skillsCatalogData.json`): nome, para que
  serve (PT-BR + EN), onde baixar pinado. É a segunda camada da busca.
- **Harness da missão** — o conjunto de skills que o AGENTE monta para UMA
  missão: prateleira → biblioteca → catálogo → web, declarado no mini-plano
  (ocasião → skill → por quê). "Nenhuma skill" é harness válido, dito.
- **Playbook da missão** — skill AUTORAL `mission-playbook` no worktree:
  direção, referências do dono, regras extraídas do que foi puxado, checklist
  de pronto. Sobrevive a restart e vai a cada ajudante.
- **Puxar / descartar** — `skill_pull` traz uma skill (id, URL do GitHub ou
  pasta autoral) para o worktree DESTA conversa, pinada por sha;
  `skill_discard` a remove. Nunca tocam a biblioteca da máquina.
- **Skill efêmera** — a skill puxada vive no worktree e morre com ele (ou com
  o descarte / a conclusão do planejamento). O que fica é o RASTRO.
- **Rastro** — nota no fio (`❖ skill puxada pelo agente: id · repo @ sha7`),
  linha no diário e `.synkora/harness.json` da conversa. "Guardar na
  biblioteca" é gesto do dono, pinado no mesmo sha.
- **Método do planejamento** — a linha que o planejador diz antes de propor:
  SIMPLES (corta direto) × ABSTRATO (entrevista/grill/modelagem antes).

