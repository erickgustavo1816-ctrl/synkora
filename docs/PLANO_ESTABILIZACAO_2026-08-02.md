# Plano de estabilização do Synkora — 02/08/2026

> Estado deste documento: planejamento somente. Nenhuma correção descrita aqui foi executada em 01/08/2026.

## Objetivo

Tornar o fluxo de cards recuperável e explicável, restabelecer a comunicação completa dos agentes Codex e criar uma caixa-preta que permita acompanhar e reconstruir um problema sem depender de screenshots ou da memória do usuário.

O trabalho será deliberadamente limitado a três frentes:

1. observabilidade mínima e confiável;
2. paridade das ferramentas MCP entre Claude e Codex;
3. recuperação correta de cards e fases depois de falha, merge bloqueado ou reinício do aplicativo.

Não será feito um novo dashboard grande nem uma reescrita do orquestrador.

## Sintomas que precisam ser reproduzidos

- O Synkora fechou e, ao reabrir, não ficou claro se o card de front estava pronto, aprovado ou em qual fase deveria continuar.
- Um trabalho aparentemente já implementado, revisado e aprovado pelo QA voltou para backlog/estado interrompido depois de um merge bloqueado.
- O orquestrador não conseguiu atualizar ou retomar o mesmo card e abriu outro Executor apenas para verificar o trabalho existente e reportar sem alterar nada.
- Uma revisão recuperada recebeu um diff imutável vazio, embora o commit indicado contivesse alterações, e por isso tentou reprovar uma entrega que já existia.
- Um Revisor Codex recebeu mensagens do orquestrador, mas nasceu sem `synkora.report` e depois informou também não possuir shell/leitura para verificar o commit.
- Claude para Claude funcionou; o caminho que envolve Codex não teve as mesmas ferramentas e garantias.
- Na sessão exibida, o próprio orquestrador relatou commits fora do fluxo de cards e uma branch que o motor deixou de reconhecer. Isso será tratado como evidência a verificar, não como diagnóstico definitivo.

## Regra para amanhã

Antes de tentar corrigir o comportamento, vamos ligar a caixa-preta e reproduzir um caso curto. Cada hipótese deverá ser confirmada por eventos registrados. Não vamos corrigir por tentativa e erro olhando apenas o estado final do board.

## Caixa-preta: o que será registrado

Será criado um único diário local, append-only, em JSONL, acompanhado de uma versão resumida legível. Cada evento terá horário, sequência e os identificadores disponíveis de projeto, missão, card, tentativa, fase, pane, agente e ticket de integração.

Entram no diário somente ações observáveis e mudanças de estado:

- boot, fechamento limpo, crash e recuperação do aplicativo;
- criação, remount e encerramento de pane/processo;
- papel, CLI, modelo e fase solicitados para cada agente;
- geração e carregamento da configuração MCP;
- handshake de capacidades e lista dos recursos obrigatórios disponíveis ou ausentes;
- envio, entrega e confirmação de mensagens entre agentes;
- tentativa de uso de ferramentas essenciais, inclusive `synkora.report`;
- estado anterior e posterior de card, fase, missão e fila, com ator e motivo;
- início/fim de DEV, revisão, QA, finalização e integração;
- commit base, commit entregue, fingerprint do conteúdo, limpeza da árvore e resumo do diff;
- tentativa de merge, resultado, bloqueio e decisão de recuperação;
- reinício e reconciliação do estado persistido com Git/worktree;
- intervenções e autorizações manuais.

Não serão gravados segredos, tokens ou raciocínio interno da IA. Prompts e saída de terminal não serão despejados integralmente no diário: em erro, haverá apenas um trecho limitado e sanitizado, mais hashes e metadados suficientes para correlação. Os arquivos terão rotação e retenção limitada.

Também haverá uma ação simples de “exportar diagnóstico”, reunindo diário, snapshot sanitizado do estado, versões, saúde MCP e evidências Git relevantes. A primeira versão não precisa de um painel novo: o diário poderá ser acompanhado ao vivo pelo Codex enquanto o problema é reproduzido.

## Sequência exata de execução amanhã

### 1. Preservar o caso atual antes de tocar no sistema

1. Abrir este documento e tratar as telas enviadas como o caso de referência.
2. Localizar o projeto, a missão, o card, os panes, os worktrees e os commits envolvidos.
3. Copiar os registros existentes e fotografar o estado persistido do board, das fases e da fila de integração.
4. Registrar os commits base e entregue, o estado das árvores e os vereditos que ainda existem.
5. Não limpar, reiniciar, reenfileirar ou corrigir nada enquanto essa evidência não estiver preservada.

Resultado esperado: teremos uma fotografia confiável do problema atual e poderemos voltar a ela se qualquer tentativa mudar o estado.

### 2. Criar a caixa-preta central do Synkora

1. Criar um gravador único de eventos estruturados, em vez de espalhar mensagens soltas por stores e terminais.
2. Dar a cada execução uma cadeia de identificação: projeto, missão, card, tentativa, fase, pane, agente e ticket de integração.
3. Registrar toda mudança de estado com: estado anterior, estado seguinte, ator, motivo e evidência usada.
4. Instrumentar o nascimento e encerramento de processos, a configuração MCP, os reports, as mensagens entre agentes, os checkpoints, os commits e as tentativas de merge.
5. Adicionar snapshots sanitizados nos pontos críticos e trechos limitados de erro, sem tokens, segredos ou raciocínio interno.
6. Criar rotação dos arquivos para a caixa-preta não crescer indefinidamente.
7. Criar uma ação simples para exportar um pacote de diagnóstico completo.
8. Criar um monitor que o Codex desta conversa consiga acompanhar enquanto você usa o Synkora.

Resultado esperado: diante de um bug, eu conseguirei reconstruir a sequência completa e dizer exatamente onde o estado divergiu.

### 3. Reproduzir os problemas com a caixa-preta ligada

1. Reproduzir primeiro o nascimento de um Revisor Codex sem `synkora.report`.
2. Confirmar separadamente se a mensagem do orquestrador chegou, se o MCP carregou, se o report foi registrado e se o agente tinha leitura do commit.
3. Reproduzir o fechamento e a reabertura do Synkora durante uma fase do card.
4. Reproduzir o merge bloqueado depois de DEV, revisão e QA.
5. Comparar a linha do tempo registrada com o que aparece no board e nos panes.
6. Só então confirmar as causas; nenhuma conclusão será baseada apenas no texto produzido por um agente.

Resultado esperado: cada problema relatado terá uma causa confirmada por eventos, e não uma hipótese baseada no resultado final.

### 4. Corrigir a preparação MCP dos agentes Codex

1. Comparar o caminho de criação de panes Claude e Codex, incluindo remount e recuperação após reinício.
2. Definir as capacidades obrigatórias de cada papel. Revisor e QA precisam, no mínimo, conseguir ler a entrega e registrar o veredito pelo `synkora.report`.
3. Fazer o processo principal testar essas capacidades antes de iniciar a fase e antes de entregar o briefing ao agente.
4. Impedir que um Revisor ou QA seja aberto parcialmente equipado.
5. Se a preparação falhar, manter o card na mesma fase, registrar a causa, mostrar um erro claro e oferecer uma nova tentativa segura.
6. Confirmar entrega e resposta das mensagens entre Claude, Codex e orquestrador.
7. Tratar remount e reconexão como uma nova validação de capacidades, sem confiar no estado da sessão anterior.

Resultado esperado: Codex e Claude cumprem o mesmo contrato operacional, e a ausência de MCP nunca vira uma sessão inútil ou um silêncio no pipeline.

### 5. Corrigir a retomada do mesmo card

1. Persistir checkpoints explícitos: entrega do DEV, aprovação da revisão, aprovação do QA e integração pendente.
2. Associar cada checkpoint ao commit e ao fingerprint exatos da entrega.
3. Quando o merge falhar depois do QA, colocar o mesmo card em um estado de reparo/retry de integração.
4. Não voltar o card para DEV e não abrir outro Executor apenas para confirmar que o trabalho já existe.
5. Preservar revisão e QA quando o commit/fingerprint não tiver mudado.
6. Se a entrega realmente mudar, invalidar somente os checkpoints posteriores que dependem dela.
7. Criar uma operação própria para o orquestrador acrescentar contexto de recuperação sem reescrever o briefing bloqueado de uma fase em andamento.
8. Fazer a recuperação comparar o commit entregue, evitando gerar diff vazio quando o trabalho está em um commit já conhecido.

Resultado esperado: o card continua do último checkpoint válido e o board representa o trabalho real, sem cards artificiais ou agentes instruídos a “não fazer nada”.

### 6. Corrigir a reconciliação depois de fechamento ou crash

1. No boot, comparar o estado persistido do Synkora com processos, panes, worktrees, commits, reports e tickets de integração.
2. Para cada card incompleto, determinar o último checkpoint comprovado por evidência.
3. Marcar processos que desapareceram como interrompidos, sem interpretar o desaparecimento como sucesso ou reprovação.
4. Preservar entregas e aprovações que ainda correspondam ao mesmo commit.
5. Reabrir apenas a fase realmente pendente.
6. Registrar a decisão de recuperação na caixa-preta e mostrá-la em linguagem comum no board.
7. Se houver ambiguidade real, parar o card e pedir uma decisão explícita, em vez de escolher silenciosamente.

Resultado esperado: fechar e reabrir o Synkora não muda silenciosamente a história nem a etapa do card.

### 7. Testar as falhas que causaram a confusão

Executar e automatizar estes cenários, um por um:

1. fechar durante DEV;
2. fechar depois de DEV e antes da revisão;
3. fechar durante revisão;
4. fechar durante QA;
5. fechar depois do QA e antes do merge;
6. bloquear merge com a árvore de destino suja;
7. iniciar Codex com configuração MCP ausente ou inválida;
8. fazer remount de um pane com o mesmo ID;
9. recuperar um commit preservado cuja comparação normal resulte em diff vazio;
10. entregar uma mensagem quando o report estiver indisponível;
11. repetir a integração sem alterar o commit;
12. alterar a entrega depois da aprovação e confirmar a invalidação seletiva dos gates.

Cada cenário deverá possuir estado final esperado, eventos esperados e teste automatizado. Um cenário que terminar em estado ambíguo continuará sendo considerado falho.

### 8. Validar ao vivo com você

1. Iniciar o monitor da caixa-preta antes de usar o aplicativo.
2. Executar juntos um fluxo completo de DEV, revisão, QA e integração.
3. Provocar de propósito um bloqueio de merge.
4. Fechar e reabrir o Synkora em uma etapa controlada.
5. Eu acompanharei os eventos e explicarei, em linguagem comum, cada transição importante enquanto ela acontece.
6. Exportar o diagnóstico e verificar se ele permite reconstruir o fluxo sem recorrer às screenshots.
7. Só declarar o problema resolvido quando todos os critérios de aceite forem atendidos.

## Critérios de aceite

- Um Revisor ou QA Codex não abre sem `synkora.report` e as capacidades necessárias verificadas.
- Mensagens e reports possuem confirmação de entrega; falhas aparecem como estado, não como silêncio.
- Merge bloqueado depois de aprovação não devolve o card para DEV.
- O sistema retoma o mesmo card e o mesmo commit no checkpoint correto.
- Aprovações válidas são preservadas quando a entrega não mudou.
- Alteração real da entrega invalida apenas as fases dependentes.
- Reiniciar o aplicativo produz a mesma interpretação do estado antes e depois.
- Toda transição relevante possui ator, motivo, IDs de correlação e evidência.
- O pacote de diagnóstico permite que o Codex explique a causa sem o usuário reconstruir os fatos manualmente.
- O fluxo completo e a matriz de falhas passam antes de encerrar a sessão.

## Como começar amanhã

Ao retornar, basta pedir: **“Execute o plano de estabilização de 02/08 e comece pela caixa-preta.”**

O primeiro passo será iniciar o monitor ao vivo; nenhuma limpeza, retry ou mudança de estado do caso atual será feita antes de preservar a evidência.
