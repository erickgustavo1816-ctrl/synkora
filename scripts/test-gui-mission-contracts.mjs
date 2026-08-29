import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEPENDENCY_DELIVERIES_HEADER,
  GUI_MISSION_ROLES,
  MISSION_PLANNING_NOT_QUEUEABLE,
  MISSION_TYPES,
  guiMissionFirstPrompt,
  guiMissionPaneId,
  guiMissionRoleOf,
  guiSeatNeedsExecutorReset,
  guiMissionSystemPrompt,
  guiPlanningFirstPrompt,
  guiPlanningPaneId,
  guiPlanningSystemPrompt,
  guiReleaseSystemPrompt,
  isGuiMissionPaneId,
  isGuiMissionRole,
  isGuiPlanningPaneId,
  isMissionType,
  missionConflictRecipe,
  missionIntegrationNote,
  missionIntegrationStimulus,
  missionShortId,
  planApprovedReceipt,
  missionTypeOf,
  resumeSessionIdFor,
  routeGuiMissionPane
} from '../src/main/guiMissionContracts.ts'

const MISSION = '7e31d314-1111-2222-3333-444455556666'
const OTHER = 'aaaaaaaa-1111-2222-3333-444455556666'
const PROJECT = 'c0dad302-9999-8888-7777-666655554444'

// A CONVENÇÃO DE paneId é o endereço do resume: o guiSessions grava
// paneId → sessionId, então id instável = conversa nascendo em branco a cada
// reabertura da missão. Estes casos são o contrato dos dois lados.

test('dev e reviewer têm paneId determinístico por missão', () => {
  assert.equal(missionShortId(MISSION), '7e31d314')
  assert.equal(guiMissionPaneId('dev', MISSION), 'gui-dev-7e31d314')
  assert.equal(guiMissionPaneId('reviewer', MISSION), 'gui-reviewer-7e31d314')
  // chamar de novo devolve o MESMO id — é o que faz o resume cair na conversa
  assert.equal(guiMissionPaneId('dev', MISSION), guiMissionPaneId('dev', MISSION))
})

test('ajudante é o único papel plural e nunca sequestra o vizinho', () => {
  assert.equal(guiMissionPaneId('helper', MISSION), 'gui-helper-7e31d314-1')
  assert.equal(guiMissionPaneId('helper', MISSION, 1), 'gui-helper-7e31d314-1')
  assert.equal(guiMissionPaneId('helper', MISSION, 3), 'gui-helper-7e31d314-3')
  assert.notEqual(guiMissionPaneId('helper', MISSION, 1), guiMissionPaneId('helper', MISSION, 2))
  // índice inválido nunca vira id quebrado
  for (const bad of [0, -2, Number.NaN, undefined]) {
    assert.equal(guiMissionPaneId('helper', MISSION, bad), 'gui-helper-7e31d314-1')
  }
})

test('o ceifar reconhece TODOS os panes da missão e nenhum de outra', () => {
  for (const paneId of [
    guiMissionPaneId('dev', MISSION),
    guiMissionPaneId('reviewer', MISSION),
    guiMissionPaneId('helper', MISSION, 1),
    guiMissionPaneId('helper', MISSION, 7)
  ]) {
    assert.equal(isGuiMissionPaneId(paneId, MISSION), true, paneId)
    assert.equal(isGuiMissionPaneId(paneId, OTHER), false, paneId)
  }
  // pane de outra natureza jamais entra na ceifa da missão
  for (const alheio of ['maestro-proj--7e31d314', 'dev-7e31d314', 'gui-dev-7e31d31', '']) {
    assert.equal(isGuiMissionPaneId(alheio, MISSION), false, alheio)
  }
})

test('o papel se lê de volta do paneId', () => {
  assert.equal(guiMissionRoleOf('gui-dev-7e31d314'), 'dev')
  assert.equal(guiMissionRoleOf('gui-reviewer-7e31d314'), 'reviewer')
  assert.equal(guiMissionRoleOf('gui-helper-7e31d314-2'), 'helper')
  assert.equal(guiMissionRoleOf('maestro-proj--7e31d314'), undefined)
})

test('papel desconhecido é recusado antes de virar pane', () => {
  for (const role of GUI_MISSION_ROLES) assert.equal(isGuiMissionRole(role), true)
  for (const bad of ['maestro', 'qa', '', null, undefined, 7]) {
    assert.equal(isGuiMissionRole(bad), false)
  }
})

// CONTRATOS: curtos de propósito, um por papel, e a cerca do reviewer é a que
// o dono mandou escrever ("revisar a qualidade do que foi entregue, APENAS").

test('cada papel tem contrato próprio e todos respondem em PT-BR', () => {
  const seen = new Set()
  for (const role of GUI_MISSION_ROLES) {
    const contract = guiMissionSystemPrompt(role)
    assert.ok(contract.length > 200, `${role}: contrato vazio demais`)
    // O TETO subiu de 2400 para 2600 UMA vez, em 2026-08-18, para caber a ORDEM
    // PERMANENTE DA DELEGAÇÃO — a MESMA seção nos três papéis (ordem do dono:
    // "todo chat que eu criar nunca mais abre subagente dele"). E de 2600 para
    // 3000 na MESMA data, no 2º teste ao vivo, para caber a régua do PINO ("ele
    // teria que abrir os cinco do padrão que eu mandei"): duas linhas novas e a
    // do list_seats reescrita. E de 3000 para 3200 na noite do MESMO dia, pelo
    // 5º teste: a linha da ENTREGA EM ARQUIVO + o correio que chega sozinho
    // ("cada ajudante que terminar, avisar o orquestrador... pra não poluir o
    // chat"). E de 3200 para 3700 na mesma noite (rodada 6, o CICLO REDONDO:
    // "não faz só um remendo, faz um planejamento por trás"), pelas duas linhas
    // de parar/retomar/descartar — o dev mede 3636. E de 3700 para 4200 na
    // rodada 7 (2026-08-18, validação ao vivo — achado 3), pelas duas linhas do
    // INSUMO ("o arquivo não tem que ficar lá, a não ser que seja uma
    // implementação"): o dev mede 4110. E de 4200 para 5600 na rodada 9
    // (2026-08-19), pela seção do INTEGRADOR — que só o DEV recebe ("quando eu
    // clico em subir, o certo é avisar o agente e o AGENTE sobe; qualquer erro,
    // ELE arruma"): o dev mede 5462, o reviewer 4022 e o ajudante 3511. E de
    // 5600 para 6500 na R25 (2026-08-20), pela DOUTRINA DE CUSTO — a auditoria
    // mediu o orquestrador re-lendo ~192k por chamada, 139 vezes numa janela de
    // 5h, e a persona é a metade que o modelo lê do empurrão para delegar cedo:
    // o dev mede 6352, o reviewer 4912 e o ajudante 4401. E de 6500 para 7200
    // em 2026-08-23, pela REGRA DO FRATRICÍDIO — o agente de uma auditoria
    // derrubou o Synkora DUAS vezes na mesma noite com `Get-Process electron |
    // Stop-Process` (limpava o app que testava; o hospedeiro também é
    // electron.exe): o dev mede ~7000, o ajudante ~5040. E de 7200 para 8200
    // na R31 (2026-08-23), pela VOZ DO DONO — as três queixas verbatim ("eu
    // mando e ele lê três horas depois", "ele leu mas não responde", "ele só
    // sai fazendo sem comentar"): o dev mede 8010, o reviewer 5876 e o
    // ajudante 6059. E de 8200 para 8700 na R36 (2026-08-23), pela ENTREGA
    // VISUAL — o dev codex jurou "está exibida diretamente acima" e nada
    // apareceu; a linha ensina que visual não referenciado NÃO existe na tela
    // do dono (dev 8459, ajudante 6508). E de 8700 para 10300 na R37
    // (2026-08-23), pelo MUNDO — o dev codex, na v0.1.1, anunciou sozinho
    // "será publicada como 0.1.2" ("quem decide isso sou eu"), e a ordem do
    // dono moldou a forma: "ao invés de ficar remendando, explica para ele
    // como é o synkora, onde ele está e como funciona". TODO contrato abre com
    // THE WORLD YOU ARE IN + a linha ONDE VOCÊ ESTÁ do papel; versão é do
    // dono, bump é do app, mecânica não escrita se PERGUNTA (dev 9751,
    // ajudante 7756, reviewer 7120). E de 10300 para 11400 em 2026-08-29, pelo
    // CARDÁPIO DE SKILLS (Skills 2.0, ADRs 0001/0002/0005): o kit do tipo de
    // chat passa a chegar pela PASTA do worktree e o modelo precisa da régua de
    // USO — a ocasião como gatilho, playbook em vez de enfeite, e a LEI do
    // `impeccable` em quem estiliza (dev 10985, ajudante 8990; o reviewer não
    // recebe nem cardápio nem lei e continua exatamente em 7120). O teto
    // continua sendo contra CONSTITUIÇÃO: régua nova do dono cabe, discurso não.
    assert.ok(contract.length < 11400, `${role}: contrato virou constituição`)
    assert.ok(/PT-BR/.test(contract), `${role}: sem a regra do idioma`)
    assert.equal(seen.has(contract), false, `${role}: contrato repetido`)
    seen.add(contract)
  }
})

test('o reviewer nunca legisla capacidade que a missão não prometeu', () => {
  const contract = guiMissionSystemPrompt('reviewer')
  assert.match(contract, /NEVER LEGISLATE/)
  assert.match(contract, /do NOT edit the product/i)
})

test('o dev espera aval antes de trabalho grande e trabalha só no worktree', () => {
  const contract = guiMissionSystemPrompt('dev')
  assert.match(contract, /MINI-PLAN/)
  assert.match(contract, /ONLY inside this worktree/i)
})

// O MUNDO ONDE VOCÊ ESTÁ (R37, 2026-08-23). O caso: o dev codex, na v0.1.1,
// anunciou sozinho "a correção agora será publicada como 0.1.2" ("quem decide
// isso sou eu"). A ordem do dono moldou a forma: "ao invés de ficar
// remendando, explica para ele como é o synkora, onde ele está e como
// funciona — lembrando que o agente de release e de planejamento são
// diferentes e também precisam saber onde eles estão". TODO contrato abre com
// o MUNDO + a linha ONDE VOCÊ ESTÁ do próprio papel.
test('R37 — os CINCO papéis conhecem o mundo: Synkora, onde estão, o que o app decide', () => {
  const prompts = {
    dev: guiMissionSystemPrompt('dev'),
    reviewer: guiMissionSystemPrompt('reviewer'),
    helper: guiMissionSystemPrompt('helper'),
    planner: guiPlanningSystemPrompt(),
    release: guiReleaseSystemPrompt()
  }
  for (const [seat, prompt] of Object.entries(prompts)) {
    assert.match(prompt, /THE WORLD YOU ARE IN — SYNKORA:/u, `${seat}: sem o mundo`)
    assert.match(prompt, /WHERE YOU ARE:/u, `${seat}: não sabe onde está`)
    assert.match(
      prompt,
      /NEVER decide the product version/u,
      `${seat}: não sabe que versão é do dono`
    )
    assert.match(
      prompt,
      /bumps the manifest, lockfile and tag BY ITSELF/u,
      `${seat}: não sabe que o bump é do app`
    )
    assert.match(
      prompt,
      /ASK the owner instead of inventing the mechanism/u,
      `${seat}: não manda perguntar em vez de inventar`
    )
    // O mundo abre o contrato — explicação antes de qualquer regra.
    assert.ok(prompt.startsWith('THE WORLD YOU ARE IN'), `${seat}: o mundo não abre o contrato`)
  }
  // Cada papel sabe o SEU lugar — as linhas são distintas de propósito.
  assert.match(prompts.dev, /the DEVELOPER chat of ONE mission/u)
  assert.match(prompts.reviewer, /read-only eyes/u)
  assert.match(prompts.helper, /a headless HELPER inside ONE mission/u)
  assert.match(prompts.planner, /BEFORE missions exist/u)
  assert.match(prompts.release, /operating the PROJECT FOLDER itself/u)
})

// A ENTREGA VISUAL (R36, 2026-08-23). O print do dono: o dev codex jurou "a
// demonstração está exibida diretamente acima" e NADA apareceu — o chat não
// renderizava imagem de worktree (CSP) e o modelo alucinou a capacidade. A
// metade mecânica é da R36 (imagem referenciada renderiza; caminho vira
// token); esta linha é a metade do MODELO: visual sem referência não existe.
test('R36 — dev e ajudante sabem que entrega visual é ARQUIVO referenciado, nunca promessa', () => {
  for (const role of ['dev', 'helper']) {
    const contract = guiMissionSystemPrompt(role)
    assert.match(contract, /VISUAL deliverable/u, `${role}: sem a linha da entrega visual`)
    assert.match(contract, /!\[…\]\(relative\/path\.png\)/u, `${role}: não ensina a referência de imagem`)
    assert.match(contract, /NEVER claim something is "shown above"/u, `${role}: não proíbe a promessa vazia`)
  }
})

// A VOZ DO DONO (R31, 2026-08-23). A metade mecânica é da rodada (composer
// envia na hora + o CLI steera — sonda probe-claude-owner-midturn); esta é a
// metade do MODELO, porque a mesma sonda provou que entrega não é obediência:
// em haiku o modelo leu a ordem no meio do turno e terminou com um DONE seco.
test('R31 — a voz do dono: os três papéis respondem SEMPRE e narram o passo a passo', () => {
  for (const role of GUI_MISSION_ROLES) {
    const contract = guiMissionSystemPrompt(role)
    assert.match(contract, /ALWAYS ANSWER, ALWAYS NARRATE/, `${role}: sem o bloco da voz do dono`)
    assert.match(contract, /MIDDLE of your turn/, `${role}: não avisa que a fala chega no meio do turno`)
    assert.match(contract, /ANSWER FIRST/, `${role}: não ordena responder antes de qualquer outra tool`)
    assert.match(contract, /gets a reply in words/, `${role}: não obriga resposta a TODA mensagem`)
    assert.match(contract, /NARRATE as you work/, `${role}: não ordena narrar o passo a passo`)
    assert.match(contract, /one line per step is cheap/i, `${role}: não reconcilia com a doutrina de custo`)
  }
})

// ORDEM PERMANENTE DA DELEGAÇÃO (2026-08-18 — design D4). O dono: "deixe claro
// pra todo chat que eu criar que ele NUNCA MAIS vai abrir subagentes dele — ele
// vai abrir via MCP, porque via MCP eu vejo na lateral o MODELO e o EFFORT que
// subiu; o nativo (Claude E Codex) não me mostra nada". A seção é UMA só e
// viaja IDÊNTICA nos três papéis; o chat de planejamento não delega e não a
// recebe. A cerca mecânica (--disallowedTools / features.multi_agent=false)
// mora no spawn — esta é a metade que o modelo lê.

const DELEGATION_HEADER = 'DELEGATION — STANDING ORDER FROM THE OWNER:'

/** O bloco compartilhado, lido da FONTE (o teste nunca guarda uma cópia dele). */
function delegationSection(contract) {
  const at = contract.indexOf(DELEGATION_HEADER)
  return at < 0 ? undefined : contract.slice(at)
}

/**
 * A PERSONA DO AJUDANTE — o outro lado da mesma régua, e ela mora no
 * `guiDelegationWiring` (nasce junto dos adaptadores dos dois CLIs). Importar
 * aquele módulo aqui puxaria maestro/codex/catálogo/seats para dentro de uma
 * suíte que roda em `--experimental-strip-types`, então o teste lê a FONTE,
 * ancorado no nome do export: se ele mudar de casa, este assert cai primeiro.
 *
 * Devolve o TEXTO que o ajudante recebe (as linhas do array coladas como o
 * `.join('\n')` faz), nunca a sintaxe do TypeScript.
 */
function helperPersona() {
  const source = readFileSync(
    new URL('../src/main/guiDelegationWiring.ts', import.meta.url),
    'utf8'
  )
  const block = source.match(/export const GUI_HELPER_PERSONA = \[[\s\S]*?\n\]\.join\('\\n'\)/u)
  assert.ok(block, 'GUI_HELPER_PERSONA saiu de guiDelegationWiring.ts — o teste perdeu o alvo')
  const lines = [...block[0].matchAll(/^\s*'((?:[^'\\]|\\.)*)',?\s*$/gmu)].map((match) => match[1])
  assert.ok(lines.length > 5, 'a persona não foi lida linha a linha')
  return lines.join('\n')
}

/** UMA regra da persona (com as linhas de continuação dela), pelo começo do
 *  texto. Sem este recorte, um `assert.match` no bloco inteiro passaria por
 *  causa da regra VIZINHA — e as vizinhas já dizem "NEVER" e ".synkora/". */
function personaRule(persona, head) {
  return persona.split('\n- ').find((rule) => rule.startsWith(head))
}

test('a ordem da delegação viaja idêntica nos três papéis', () => {
  const sections = GUI_MISSION_ROLES.map((role) => {
    const section = delegationSection(guiMissionSystemPrompt(role))
    assert.ok(section, `${role}: sem a ordem permanente da delegação`)
    return section
  })
  // FONTE ÚNICA: nenhum papel tem a própria versão da ordem do dono
  for (const section of sections) assert.equal(section, sections[0])
  // e ela FECHA o contrato — nada se pendura depois da ordem permanente
  for (const role of GUI_MISSION_ROLES) {
    assert.ok(
      guiMissionSystemPrompt(role).endsWith(sections[0]),
      `${role}: a ordem não é a última palavra do contrato`
    )
  }
  // tight de propósito: ela viaja em TODO spawn de chat de missão. O teto subiu
  // de 1400 para 1800 UMA vez (2026-08-18, 2º teste ao vivo) pela régua do PINO
  // e de 1800 para 2000 na noite do mesmo dia, pela linha da ENTREGA EM ARQUIVO
  // + correio. E de 2000 para 2500 na mesma noite (rodada 6, o CICLO REDONDO),
  // pelas DUAS linhas de parar/retomar/descartar: a seção media 2448 — os dois
  // tetos andam juntos, sempre. E de 2500 para 3000 na rodada 7 (validação ao
  // vivo, achado 3), pelas duas linhas do INSUMO: a seção mede 2922. Discurso
  // continua sem espaço aqui.
  assert.ok(sections[0].length > 600, 'a ordem ficou vaga demais')
  assert.ok(sections[0].length < 3000, 'a ordem permanente virou constituição')
})

// A ENTREGA VEM SOZINHA, E VEM EM ARQUIVO (2026-08-18, 5º teste ao vivo).
//
// Caso real: dois ajudantes encerraram enquanto o delegador estava DENTRO do
// turno esperando um terceiro no long-poll; o despertador segurou o aviso (não
// se interrompe turno vivo) e o agente disse ao dono "nenhum terminou" com a
// lateral mostrando três rodando. As duas ordens dele viraram uma linha só aqui:
// o encerramento pega carona no próximo resultado de tool, e a entrega mora num
// ARQUIVO (memória feedback-agente-saida-em-arquivo: payload inline gigante já
// queimou uma rodada de 35 minutos).

test('a ordem diz que a entrega chega sozinha e mora em ARQUIVO', () => {
  for (const role of GUI_MISSION_ROLES) {
    const section = delegationSection(guiMissionSystemPrompt(role))
    assert.match(section, /\.synkora\/helpers\//, `${role}: sem o endereço da entrega`)
    assert.match(section, /\[synkora\] ajudantes:/, `${role}: sem a marca do correio`)
    assert.match(section, /tool result/i, `${role}: sem dizer POR ONDE a novidade chega`)
  }
})

// A ENTREGA DE PESQUISA É INSUMO, NUNCA PRODUTO (rodada 7, achado 3 da
// validação ao vivo do dono).
//
// Caso real: numa missão cuja entrega pedida era uma RESPOSTA NO CHAT, o
// delegador claude copiou os SEIS relatórios dos ajudantes para `reports/` e
// commitou (43d3270). Palavras dele: "o arquivo não tem que ficar lá, a não ser
// que seja uma implementação". São dois lados da mesma régua: o delegador (aqui)
// e o ajudante (GUI_HELPER_PERSONA, no guiDelegationWiring).

test('a entrega do ajudante é INSUMO do delegador: nunca commit, nunca cópia no repo', () => {
  for (const role of GUI_MISSION_ROLES) {
    const section = delegationSection(guiMissionSystemPrompt(role))
    assert.match(section, /RAW MATERIAL/i, `${role}: a entrega ainda pode passar por produto`)
    // a resposta ao dono é a do DELEGADOR, e ela vai no CHAT
    assert.match(section, /in (?:this|the) chat/i, `${role}: sem dizer ONDE o dono é respondido`)
    assert.match(section, /never commit/i, `${role}: nada impede o commit do relatório`)
    assert.match(section, /repositor/i, `${role}: copiar para o repo continua livre`)
    // TODA guarda nasce com rota de saída sancionada (CLAUDE.md): o pedido
    // explícito do dono é a dele.
    assert.match(
      section,
      /unless he|unless the owner/i,
      `${role}: a guarda ficou sem rota de saída — o dono não pode nem pedir o arquivo`
    )
    // e a faxina: o que a frota deixou para trás e não é a mudança pedida sai
    assert.match(section, /delete/i, `${role}: a frota pode deixar lixo versionado para trás`)
  }
})

test('a persona do AJUDANTE manda pesquisa para .synkora, nunca para pasta versionada', () => {
  const rule = personaRule(helperPersona(), 'RESEARCH AND CONSULTATION')
  assert.ok(rule, 'a persona do ajudante não diz onde a pesquisa dele pousa')
  assert.match(rule, /\.synkora\//u, 'sem o endereço git-invisível da pesquisa')
  assert.match(rule, /NEVER/u, 'a proibição virou sugestão')
  assert.match(rule, /versioned/iu, 'a palavra que separa os dois destinos sumiu')
  // A régua tem o LADO POSITIVO: arquivo versionado quando a TAREFA é mudar
  // código — sem ele o ajudante de implementação não saberia onde escrever.
  assert.match(
    rule,
    /when the task/iu,
    'sem a exceção, o ajudante que muda código fica sem lugar para escrever'
  )
})

// O CICLO REDONDO (2026-08-18, noite — rodada 6 do design, R6.1/R6.2/R6.3).
//
// Ordem do dono: "não faz só um remendo, faz um planejamento por trás". Parar
// deixou de ser sinônimo de perder: o ■ dele e o fechamento do app INTERROMPEM
// a frota preservando conversa, pino e entrega parcial; helper_resume a traz de
// volta e helper_cancel virou o DESCARTE explícito (apaga o arquivo de entrega).
//
// A metade mecânica é das ondas A/B; esta é a metade que o MODELO lê — sem ela
// o agente fica com a ferramenta na mão e sem saber que "volta com os
// subagentes" é um helper_resume por ajudante interrompido.

test('a ordem ensina o CICLO: parar preserva, resume retoma, cancel descarta', () => {
  for (const role of GUI_MISSION_ROLES) {
    const section = delegationSection(guiMissionSystemPrompt(role))
    assert.match(section, /INTERRUPT/, `${role}: parar ainda parece perder o trabalho`)
    assert.match(section, /helper_resume/, `${role}: sem o verbo da retomada`)
    // a frase EXATA do dono: é ela que chega ao chat depois de uma interrupção
    assert.match(section, /volta com os subagentes/, `${role}: a frase do dono não é reconhecida`)
    assert.match(section, /DISCARD/, `${role}: helper_cancel sem a semântica nova`)
    assert.match(section, /delivery file/i, `${role}: o descarte não diz o que apaga`)
    // interromper NÃO é descartar: as duas palavras não podem se confundir
    assert.match(
      section,
      /instead of discarding it/i,
      `${role}: a diferença entre pausa e descarte ficou implícita`
    )
  }
  // o planejador não delega — nem o ciclo entra no chat dele
  assert.doesNotMatch(guiPlanningSystemPrompt(), /helper_resume/u)
})

// O PINO DO PAINEL É A PALAVRA DO DONO (2026-08-18, 2º teste ao vivo dele).
// Caso real: ele carimbou "opus[1m] · high" no painel D8 e pediu "abre 5
// subagentes", sem citar modelo nenhum. O chat consultou list_seats, viu folga
// numa conta codex e abriu 4 opus + 1 gpt-5.6-luna por iniciativa própria.
// Palavras dele: "eu não especifiquei que eu queria luna — ele teria que abrir
// os cinco do padrão que eu mandei. Ele não tem que abrir da cabeça dele."
//
// A cerca aqui é PERSONA porque uma trava dura recusaria a ordem LEGÍTIMA dele
// ("abre 2 lunas"), que a camada de tool não sabe distinguir da invenção do
// agente (memória feedback-guardas-nao-capam-inteligencia). A metade mecânica é
// o advisory auditado do `guiDelegationWiring`.

test('o pino do painel é a PALAVRA DO DONO: sem pedido dele, a frota inteira abre nele', () => {
  const section = delegationSection(guiMissionSystemPrompt('dev'))
  assert.ok(section, 'sem a ordem permanente da delegação')
  assert.match(section, /PIN IS HIS WORD/, 'o pino virou sugestão')
  assert.match(section, /names no model or effort/i, 'sem a condição, a régua não se aplica a nada')
  assert.match(section, /EVERY helper/, 'a frota INTEIRA abre no pino, não a maioria dela')
})

test('espalhar frota é por CONTA da MESMA CLI — trocar de CLI é trocar o modelo dele', () => {
  const section = delegationSection(guiMissionSystemPrompt('dev'))
  // list_seats continua sendo a leitura certa antes de uma frota grande; o que
  // ela NÃO autoriza é atravessar o CLI do modelo carimbado.
  assert.match(section, /list_seats/)
  assert.match(section, /limit left/i)
  assert.match(section, /accounts of the pinned model's CLI/)
  assert.match(section, /substituting, not spreading/)
})

test('sair do pino tem DUAS saídas, e nenhuma delas é silenciosa', () => {
  for (const role of GUI_MISSION_ROLES) {
    const section = delegationSection(guiMissionSystemPrompt(role))
    // (1) o dono nomeia outro modelo AQUI, na conversa; (2) não há conta logada
    // daquele CLI. Fora disso, abrir outra coisa é decidir no lugar dele.
    assert.match(section, /only when HE names another model/, `${role}: sem a saída do pedido dele`)
    assert.match(section, /no seat of that CLI is logged/, `${role}: sem a saída da conta ausente`)
    assert.match(section, /SAY it here/, `${role}: a saída virou substituição silenciosa`)
  }
})

test('o subagente nativo é PROIBIDO pelos nomes que os binários usam', () => {
  for (const role of GUI_MISSION_ROLES) {
    const contract = guiMissionSystemPrompt(role)
    const mentions = contract
      .split('\n')
      .filter((line) => /\bTask\b|\bAgent\b|spawn_agent/.test(line))
    assert.ok(mentions.length > 0, `${role}: o nativo nem é citado`)
    // TODA menção é PROIBIÇÃO — nunca uma receita de uso
    for (const line of mentions) {
      assert.match(line, /\bnever\b/i, `${role}: menção sem negação: ${line}`)
    }
    // Os três nomes REAIS (sondas de 2026-08-18): 'Task' é o id do catálogo do
    // claude, 'Agent' é o nome que o modelo chama no tool_use, e o codex expõe
    // functions.collaboration.spawn_agent. Cercar um só deixa porta aberta.
    const fence = mentions.join('\n')
    for (const nativeName of ['Task', 'Agent', 'spawn_agent']) {
      assert.ok(fence.includes(nativeName), `${role}: sem o nome ${nativeName}`)
    }
    assert.match(
      delegationSection(contract),
      /RETIRED/,
      `${role}: a aposentadoria não é explícita`
    )
  }
})

test('a ordem nomeia o caminho MCP inteiro: abrir, ver, dirigir, colher, retomar e descartar', () => {
  const section = delegationSection(guiMissionSystemPrompt('dev'))
  assert.ok(section, 'sem a ordem permanente da delegação')
  for (const tool of [
    'delegate',
    'helpers_status',
    'helper_send',
    'helper_result',
    'helper_resume',
    'helper_cancel',
    'list_seats'
  ]) {
    assert.ok(section.includes(tool), `sem a ferramenta ${tool}`)
  }
  // as duas grafias: o codex vê o nome cru, o claude vê mcp__<servidor>__<tool>
  assert.match(section, /mcp__synkora__/)
  // O PORQUÊ da ordem — o que o dono vê na lateral e o nativo nunca mostrou
  assert.match(section, /sidebar/i)
  for (const visible of ['model', 'effort', 'account', 'activity']) {
    assert.match(section, new RegExp(visible), `a lateral mostra ${visible}`)
  }
  // "abre 5 opus" = UMA chamada com 5 ajudantes, nunca cinco chamadas
  assert.match(section, /ONE delegate with 5 helpers/)
  // cross-CLI é cidadão de primeira classe, nos dois sentidos
  assert.match(section, /[Cc]ross-CLI/)
  assert.match(section, /gpt-\*/)
  // controle total sobre o ajudante vivo (a ordem "como se fosse nativo")
  assert.match(section, /long-poll/i)
  assert.match(section, /cheap/i)
  // frota grande escolhe a conta pelo limite que SOBRA (list_seats)
  assert.match(section, /limit left/i)
  // eles dividem ESTE worktree: a fronteira é o arquivo
  assert.match(section, /file boundaries/)
  // MCP fora do ar: falar com o dono, nunca cair no nativo
  assert.match(section, /catalog/i)
  assert.match(section, /never fall back/i)
})

test('o planejador não delega: a ordem não entra no chat de plano', () => {
  const planning = guiPlanningSystemPrompt()
  assert.equal(delegationSection(planning), undefined, 'o planejador ganhou ordem de delegação')
  for (const tool of [
    'delegate',
    'helpers_status',
    'helper_send',
    'helper_result',
    'helper_resume',
    'helper_cancel',
    'list_seats'
  ]) {
    assert.equal(planning.includes(tool), false, `o planejador não tem ${tool}`)
  }
  assert.equal(/spawn_agent/.test(planning), false)
  // e o kit dele continua o de planos, intocado por esta mudança
  for (const tool of ['list_plans', 'get_plan', 'propose_plan', 'update_plan', 'delete_plan']) {
    assert.ok(planning.includes(tool), `sumiu a ferramenta ${tool}`)
  }
})

// PRIMEIRO TURNO: é o único briefing que o pane recebe.

test('o briefing do reviewer aponta o diff do que foi entregue', () => {
  const prompt = guiMissionFirstPrompt('reviewer', {
    title: 'Tela de créditos',
    goal: 'Listar os créditos por empresa',
    baseBranch: 'version/v1.2'
  })
  assert.match(prompt, /MISSION: Tela de créditos/)
  assert.match(prompt, /Listar os créditos por empresa/)
  assert.match(prompt, /git diff version\/v1\.2\.\.\.HEAD/)
})

test('sem baseBranch o reviewer cai em main em vez de um comando quebrado', () => {
  const prompt = guiMissionFirstPrompt('reviewer', { title: 'X' })
  assert.match(prompt, /git diff main\.\.\.HEAD/)
})

test('o briefing do dev restata o goal antes de qualquer tool call', () => {
  const prompt = guiMissionFirstPrompt('dev', {
    title: 'Tela de créditos',
    goal: 'Listar os créditos',
    scope: 'src/renderer',
    branch: 'mission/7e31d314'
  })
  assert.match(prompt, /SCOPE: src\/renderer/)
  assert.match(prompt, /mission\/7e31d314/)
  assert.match(prompt, /VERY FIRST output/)
})

test('o ajudante espera a fatia antes de tocar em arquivo', () => {
  const prompt = guiMissionFirstPrompt('helper', { title: 'Tela de créditos' })
  assert.match(prompt, /wait for the specific slice/i)
})

// R15 — O WORKTREE NASCE MOBILIADO: o briefing tem que dizer a verdade nova, ou
// o dev repete a rodada perdida diagnosticando "faltou instalar".

test('o briefing do dev anuncia o node_modules compartilhado por junction', () => {
  const prompt = guiMissionFirstPrompt('dev', {
    title: 'Tela de créditos',
    branch: 'mission/7e31d314'
  })
  // condicional: projeto que não é node não recebe promessa falsa
  assert.match(prompt, /When the project has node_modules at its root/u)
  assert.match(prompt, /born sharing it through a junction/u)
  // a rodada perdida que originou a frase
  assert.match(prompt, /never diagnose a missing install before checking/u)
  // e a consequência do compartilhamento: instalar aqui mexe no store do projeto
  assert.match(prompt, /NEW dependency installed here lands in the project's shared store/u)
})

// ————— R16: O CONHECIMENTO DA DEPENDÊNCIA ATRAVESSA (2026-08-19) —————
//
// O dono cronometrou ~10 minutos de dev re-derivando o que o pipeline JÁ sabia
// duas vezes. Metade da cura mora aqui: o que a missão-dependência entregou
// (fato de git, capturado na conclusão dela) viaja no briefing de quem depende.
// A régua é dura nos dois sentidos — a dependência NUNCA some do briefing, e
// briefing sem dependência tem de sair idêntico ao de antes da rodada.

const BASE_DEV_BRIEFING = {
  title: 'Fila de integração',
  goal: 'Enfileirar as missões prontas',
  branch: 'mission/7e31d314',
  baseBranch: 'version/v1.2'
}

const DELIVERY = {
  capturedAt: '2026-08-19T10:00:00.000Z',
  commits: ['feat(queue): o ticket nasce com a fotografia', 'test(queue): FIFO por universo'],
  files: ['src/main/integrationQueue.ts', 'src/renderer/src/components/Board.tsx']
}

/** As linhas do bloco de UMA dependência (sem cabeçalho nem fecho). */
function dependencyBlockLines(prompt) {
  const lines = prompt.split('\n')
  const at = lines.indexOf(DEPENDENCY_DELIVERIES_HEADER)
  if (at < 0) return []
  const rest = lines.slice(at + 1)
  const end = rest.findIndex((line) => line.startsWith('START YOUR STUDY THERE'))
  return end < 0 ? rest : rest.slice(0, end)
}

test('o briefing do dev conta o que a dependência JÁ entregou neste worktree', () => {
  const prompt = guiMissionFirstPrompt('dev', {
    ...BASE_DEV_BRIEFING,
    dependencyDeliveries: [
      {
        itemTitle: 'Store da fila',
        missionTitle: 'Fila: o store',
        goalFirstLine: 'Guardar os tickets por universo',
        delivery: DELIVERY
      }
    ]
  })
  assert.ok(prompt.includes(DEPENDENCY_DELIVERIES_HEADER), 'sumiu o bloco das dependências')
  // o GOAL continua vindo antes: o bloco é contexto do produto, não o contrato
  assert.ok(
    prompt.indexOf('GOAL:') < prompt.indexOf(DEPENDENCY_DELIVERIES_HEADER),
    'o bloco tem de vir DEPOIS do goal'
  )
  // quem entregou (item do plano + missão) e o que ela era
  assert.match(prompt, /"Store da fila" — mission "Fila: o store"/u)
  assert.match(prompt, /goal: Guardar os tickets por universo/u)
  // os FATOS do git: assuntos de commit e arquivos tocados
  for (const subject of DELIVERY.commits) assert.ok(prompt.includes(subject), subject)
  for (const file of DELIVERY.files) assert.ok(prompt.includes(file), file)
  // e a instrução que muda o comportamento: comece o estudo AQUI
  assert.match(prompt, /START YOUR STUDY THERE/u)
  assert.match(prompt, /git log/u)
  assert.match(prompt, /instead of rediscovering the repository from scratch/u)
})

test('entrega cortada pelo teto diz o TOTAL real em vez de fingir lista inteira', () => {
  const prompt = guiMissionFirstPrompt('dev', {
    ...BASE_DEV_BRIEFING,
    dependencyDeliveries: [
      {
        itemTitle: 'Store da fila',
        missionTitle: 'Fila: o store',
        delivery: { ...DELIVERY, truncated: { commits: 34, files: 52 } }
      }
    ]
  })
  assert.match(prompt, /commits \(2 of 34\):/u)
  assert.match(prompt, /files touched \(2 of 52\):/u)
})

test('dependência concluída SEM entrega registrada é nomeada com a verdade, nunca omitida', () => {
  // Pré-R16, captura que falhou, projeto sem git: a entrega existe, o resumo
  // não. Omitir a dependência devolveria o dev ao estudo do zero — o bug.
  const prompt = guiMissionFirstPrompt('dev', {
    ...BASE_DEV_BRIEFING,
    dependencyDeliveries: [
      { itemTitle: 'Store da fila', missionTitle: 'Fila: o store' },
      { itemTitle: 'Botão ⇪', missionTitle: 'Fila: o gesto', delivery: DELIVERY }
    ]
  })
  assert.match(prompt, /"Store da fila" — mission "Fila: o store"/u)
  assert.match(prompt, /No delivery summary was recorded for it/u)
  assert.match(prompt, /commits are already in this branch's history \(git log\)/u)
  // e a dependência COM entrega continua completa no mesmo bloco
  assert.match(prompt, /"Botão ⇪" — mission "Fila: o gesto"/u)
  assert.ok(prompt.includes(DELIVERY.files[0]))
})

test('o bloco de UMA dependência cabe em 30 linhas, mesmo no teto da entrega', () => {
  // O briefing é o único turno que o pane recebe: entrega grande não pode
  // empurrar a instrução do dono para fora do campo de visão do modelo.
  const prompt = guiMissionFirstPrompt('dev', {
    ...BASE_DEV_BRIEFING,
    dependencyDeliveries: [
      {
        itemTitle: 'Store da fila',
        missionTitle: 'Fila: o store',
        goalFirstLine: 'Guardar os tickets por universo',
        delivery: {
          capturedAt: DELIVERY.capturedAt,
          commits: Array.from({ length: 20 }, (_, i) => `feat(queue): passo ${i + 1}`),
          files: Array.from({ length: 40 }, (_, i) => `src/main/arquivo-${i + 1}.ts`),
          truncated: { commits: 61, files: 118 }
        }
      }
    ]
  })
  const lines = dependencyBlockLines(prompt)
  assert.ok(lines.length > 0, 'o bloco não foi encontrado')
  assert.ok(lines.length < 30, `bloco com ${lines.length} linhas — grande demais para um briefing`)
  // os arquivos cabem numa linha só; os commits é que ocupam a lista
  assert.equal(lines.filter((line) => line.startsWith('  files touched')).length, 1)
})

test('sem dependência o briefing do dev sai IDÊNTICO ao de antes da rodada', () => {
  const semCampo = guiMissionFirstPrompt('dev', { ...BASE_DEV_BRIEFING })
  assert.equal(semCampo.includes(DEPENDENCY_DELIVERIES_HEADER), false)
  // campo presente e VAZIO é a mesma coisa que campo ausente (o ipc devolve
  // undefined, mas nenhum chamador pode fabricar um bloco vazio por engano)
  assert.equal(
    guiMissionFirstPrompt('dev', { ...BASE_DEV_BRIEFING, dependencyDeliveries: [] }),
    semCampo
  )
})

test('o bloco é do DEV: reviewer e ajudante nunca o recebem', () => {
  const dependencyDeliveries = [
    { itemTitle: 'Store da fila', missionTitle: 'Fila: o store', delivery: DELIVERY }
  ]
  for (const role of ['reviewer', 'helper']) {
    const withDependencies = guiMissionFirstPrompt(role, {
      ...BASE_DEV_BRIEFING,
      dependencyDeliveries
    })
    assert.equal(withDependencies.includes(DEPENDENCY_DELIVERIES_HEADER), false, role)
    // e o texto deles não muda nem um byte por causa do campo
    assert.equal(withDependencies, guiMissionFirstPrompt(role, { ...BASE_DEV_BRIEFING }), role)
  }
})

// ————— O ⇪ DO DONO TE FAZ O INTEGRADOR (rodada 9, 2026-08-19 — design I4) —————
//
// Palavras dele: "quando eu clico em subir, o certo é avisar o agente — 'tá
// pronto pra subir' — e o AGENTE sobe. Ele vê via MCP se tem alguém na fila na
// frente dele; se é o próximo, ELE integra. Qualquer erro, ELE arruma."
//
// A seção é do DEV e só dele: reviewer e ajudante não recebem `integration_*` no
// catálogo do MCP (cerca no `mcpServer`), então prometer o verbo a eles seria
// mandá-los procurar uma ferramenta que não existe.

const INTEGRATOR_HEADER = 'INTEGRATION — WHEN THE OWNER CLICKS ⇪, YOU ARE THE INTEGRATOR:'

/** A seção do integrador, lida da FONTE, sem as seções vizinhas coladas. A
 *  fronteira de baixo é a PRÓXIMA seção que existir — desde a R25 a doutrina de
 *  custo entra entre ela e a ordem permanente da delegação. */
function integratorSection(contract) {
  const at = contract.indexOf(INTEGRATOR_HEADER)
  if (at < 0) return undefined
  const end = [COST_HEADER, DELEGATION_HEADER]
    .map((header) => contract.indexOf(header))
    .filter((index) => index > at)
    .sort((a, b) => a - b)[0]
  return end === undefined ? contract.slice(at) : contract.slice(at, end)
}

test('só o DEV vira integrador: reviewer, ajudante e planejador nunca recebem a seção', () => {
  assert.ok(integratorSection(guiMissionSystemPrompt('dev')), 'o dev perdeu a seção do ⇪')
  for (const role of ['reviewer', 'helper']) {
    assert.equal(
      integratorSection(guiMissionSystemPrompt(role)),
      undefined,
      `${role} recebeu um verbo que o catálogo dele não tem`
    )
  }
  assert.equal(integratorSection(guiPlanningSystemPrompt()), undefined)
})

test('a seção do integrador ensina o ciclo inteiro: status → run na cabeça → erro é SEU → contar', () => {
  const section = integratorSection(guiMissionSystemPrompt('dev'))
  // ler a fila antes de agir
  assert.match(section, /integration_status/u)
  // integrar SÓ na cabeça, e com a ferramenta (nunca git manual no destino)
  assert.match(section, /HEAD of the queue, call integration_run/u)
  // não é a vez: não fica em laço — o app avisa
  assert.match(section, /NOT the head yet/u)
  // o erro é dele, e ele resolve NO worktree da missão
  assert.match(section, /ANY error is YOURS to fix, in THIS worktree/u)
  assert.match(section, /call integration_run again/u)
  // ao dono se pergunta PRODUTO, não git
  assert.match(section, /PRODUCT decisions/u)
  // e o desfecho volta pra ele, no chat
  assert.match(section, /TELL HIM what happened/u)
})

test('o agente NUNCA pede nem simula o ⇪: o clique é a porteira do dono', () => {
  const section = integratorSection(guiMissionSystemPrompt('dev'))
  assert.match(section, /NEVER ask for, simulate or claim an automatic ⇪/u)
  assert.match(section, /The click is his/u)
  assert.match(section, /silence is not consent/u)
})

test('a ordem da delegação continua FECHANDO o contrato — a do integrador vem antes', () => {
  const contract = guiMissionSystemPrompt('dev')
  assert.ok(
    contract.indexOf(INTEGRATOR_HEADER) < contract.indexOf(DELEGATION_HEADER),
    'a ordem permanente da delegação tem de ser a última palavra'
  )
  assert.ok(contract.endsWith(delegationSection(guiMissionSystemPrompt('helper'))))
  // e a seção do integrador é curta como as outras: régua, não constituição
  const section = integratorSection(contract)
  assert.ok(section.length > 400, 'a seção ficou vaga demais')
  assert.ok(section.length < 2000, 'a seção do integrador virou constituição')
})

// AS DUAS SUPERFÍCIES DO ⇪. A nota é do DONO (uma linha no fio); o estímulo é do
// MODELO (bastidores, sem bolha de "VOCÊ"). Misturá-las é o que já fez o app
// aparecer falando na voz dele.

test('a NOTA do ⇪ é uma linha: o gesto, o destino e a posição', () => {
  const note = missionIntegrationNote({
    targetLabel: 'version/v1.2',
    position: 2,
    total: 3
  })
  assert.match(note, /^⇪ subir para version\/v1\.2 — entregue ao agente/u)
  assert.match(note, /#2 de 3/u)
  assert.equal(note.includes('\n'), false, 'nota é UMA linha no fio')
})

test('a NOTA da reabertura não conta o clique como novo — ela diz que ele ESPERA', () => {
  const note = missionIntegrationNote({
    targetLabel: 'main',
    position: 1,
    total: 1,
    reopened: true
  })
  assert.match(note, /⇪ pendente para main/u)
  assert.equal(/entregue ao agente/u.test(note), false)
})

test('o ESTÍMULO da cabeça manda rodar; o de quem está atrás manda esperar e diz quem falta', () => {
  const head = missionIntegrationStimulus({
    missionTitle: 'Rail da fila',
    targetLabel: 'version/v1.2',
    position: 1,
    total: 2,
    isHead: true
  })
  assert.match(head, /VOCÊ é o integrador/u)
  assert.match(head, /Rail da fila/u)
  assert.match(head, /CABEÇA da fila: chame integration_run agora/u)
  assert.match(head, /CONTE a ele/u, 'o desfecho volta para o dono no chat')

  const behind = missionIntegrationStimulus({
    missionTitle: 'Segunda entrega',
    targetLabel: 'version/v1.2',
    position: 2,
    total: 2,
    isHead: false,
    ahead: ['"Rail da fila" (queued)']
  })
  assert.match(behind, /#2 de 2/u)
  assert.match(behind, /Ainda NÃO é a sua vez/u)
  assert.match(behind, /"Rail da fila" \(queued\)/u)
  assert.match(behind, /Não chame integration_run/u)
  assert.match(behind, /o app te avisa aqui quando a vez chegar/u)
})

test('o estímulo da REABERTURA diz que o ⇪ ainda espera, em vez de inventar um clique novo', () => {
  const again = missionIntegrationStimulus({
    missionTitle: 'Rail da fila',
    targetLabel: 'main',
    position: 1,
    total: 1,
    isHead: true,
    reopened: true
  })
  assert.match(again, /reabriu e o ⇪ do dono[\s\S]*AINDA ESPERA/u)
  assert.equal(/o dono clicou ⇪/u.test(again), false)
  assert.match(again, /integration_run agora/u, 'a receita continua sendo a mesma')
})

// RECEITA DO CONFLITO: em 2.0 o bloqueio volta para quem escreveu, não para um
// orquestrador que não existe.

test('a receita do conflito nomeia as duas branches e o movimento', () => {
  const text = missionConflictRecipe({
    missionTitle: 'Tela de créditos',
    detail: 'conflito em src/a.ts, src/b.ts',
    targetBranch: 'version/v1.2',
    sourceBranch: 'mission/7e31d314'
  })
  assert.match(text, /Tela de créditos/)
  assert.match(text, /conflito em src\/a\.ts, src\/b\.ts/)
  assert.match(text, /traga version\/v1\.2 para dentro de mission\/7e31d314/)
  // RODADA 9: o fecho deixou de mandar esperar um segundo clique do dono. O
  // ticket fica na cabeça da fila e quem retoma é o próprio agente — a frase
  // antiga apontava para um gesto que o app não pede mais (beco sem saída).
  assert.match(text, /integration_run de novo/u)
  assert.match(text, /MESMA posição/u)
  assert.match(text, /re-lacre[\s\S]*autom[áa]tico e auditado/u)
  assert.equal(/aprovar de novo/u.test(text), false, 'a receita não pode pedir um segundo ⇪')
  assert.match(text, /decisão de produto/u, 'o que se pergunta ao dono é produto, não git')
})

test('o veredito do merge-tree atravessa VERBATIM quando o git o entrega', () => {
  // O `git merge-tree --name-only` imprime os caminhos e, DEPENDENDO DA
  // VERSÃO, as linhas informativas ("CONFLICT (content): …"). A receita passa
  // o bloco como veio — e este é o lugar DETERMINÍSTICO de prender isso: a
  // função é pura, o git da máquina não opina (o teste de integração antigo
  // amarrava-se à prosa opcional e quebrava conforme a versão do git).
  const text = missionConflictRecipe({
    missionTitle: 'Rail da fila',
    detail: 'CONFLITO com o destino em: base.txt',
    files: ['base.txt', 'CONFLICT (content): Merge conflict in base.txt']
  })
  assert.match(text, /CONFLITO, COMO O GIT REPORTOU:/u)
  assert.match(text, /· base\.txt/u)
  assert.match(text, /· CONFLICT \(content\): Merge conflict in base\.txt/u)
  // Sem linhas do git, o cabeçalho nem aparece — a receita continua inteira.
  const bare = missionConflictRecipe({ missionTitle: 'Rail da fila', detail: 'x' })
  assert.equal(/COMO O GIT REPORTOU/u.test(bare), false)
  assert.match(bare, /integration_run de novo/u)
})

test('a receita entrega o veredito do merge-tree como o git o escreveu — sem inventar contagem', () => {
  // MEDIDO no motor real (rodada 9): o `merge-tree --name-only` devolve os
  // arquivos conflitados E, logo depois, as linhas informativas do git; o leitor
  // do worktree entrega as duas seções juntas. Chamar isso de "2 arquivos"
  // seria um número falso, e separar por adivinhação seria heurística sobre
  // conteúdo. O bloco vai como veio, nomeado pelo que ele é.
  const text = missionConflictRecipe({
    missionTitle: 'Rail da fila',
    detail: 'conflito real',
    targetBranch: 'version/v1.2',
    sourceBranch: 'mission/7e31d314',
    files: ['src/main/index.ts', 'Auto-merging src/main/index.ts']
  })
  assert.match(text, /CONFLITO, COMO O GIT REPORTOU:/u)
  assert.match(text, /· src\/main\/index\.ts/u)
  assert.match(text, /· Auto-merging src\/main\/index\.ts/u)
  assert.equal(/\(2\)/u.test(text), false, 'a receita não pode contar o que não sabe contar')
  // sem veredito, nenhum cabeçalho órfão aparece
  assert.equal(
    /CONFLITO, COMO O GIT REPORTOU/u.test(
      missionConflictRecipe({ missionTitle: 'M', detail: 'd', files: [] })
    ),
    false
  )
})

test('sem branch conhecida a receita ainda é legível', () => {
  const text = missionConflictRecipe({ missionTitle: 'M', detail: 'destino sujo' })
  assert.match(text, /a branch de destino/)
  assert.match(text, /a branch desta missão/)
})

// RECIBO DA APROVAÇÃO DO PLANO. Ele é lido por DOIS públicos no mesmo texto: o
// agente, que precisa saber o que mudou e o que fazer daqui em diante, e o dono,
// que o vê de relance no transcript. Por isso nada de prefixo de máquina nem de
// uuid cru — era assim que o clique dele virava uma bolha "VOCÊ" ilegível.

test('o recibo do plano fala com o agente sem soar como fala do dono', () => {
  const text = planApprovedReceipt({ title: 'V1.0 completa', items: 13 })
  assert.match(text, /O dono APROVOU o plano "V1\.0 completa"/u)
  assert.match(text, /13 missões/u)
  assert.match(text, /aba no MAPA/u)
  assert.match(text, /update_plan/u)
  assert.match(text, /list_plans/u)

  // As três marcas do bug: prefixo de máquina, uuid cru e "missão(ões)".
  assert.doesNotMatch(text, /\[synkora\]/u)
  assert.doesNotMatch(
    text,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
    'o id vem do list_plans; na conversa ele é só ruído'
  )
  assert.doesNotMatch(text, /\(ões\)/u)
})

test('o recibo conta as missões no plural certo, inclusive uma só', () => {
  assert.match(planApprovedReceipt({ title: 'P', items: 1 }), /com 1 missão,/u)
  assert.match(planApprovedReceipt({ title: 'P', items: 2 }), /com 2 missões,/u)
  assert.match(planApprovedReceipt({ title: 'P', items: 0 }), /com 0 missões,/u)
})

// PLANEJAMENTO (onda C): o PM permanente saiu da frente e esta sessão ocupou a
// coluna "✦ geral". Mesma convenção de endereço estável — reabrir o universo
// tem de cair na MESMA conversa, não numa em branco.

test('o pane de planejamento tem endereço estável por projeto', () => {
  assert.equal(guiPlanningPaneId(PROJECT), 'gui-plan-c0dad302')
  assert.equal(guiPlanningPaneId(PROJECT), guiPlanningPaneId(PROJECT))
  assert.notEqual(guiPlanningPaneId(PROJECT), guiPlanningPaneId(OTHER))
})

test('o ceifar por projeto pega o planejamento e NUNCA um chat de missão', () => {
  assert.equal(isGuiPlanningPaneId(guiPlanningPaneId(PROJECT), PROJECT), true)
  assert.equal(isGuiPlanningPaneId(guiPlanningPaneId(PROJECT), OTHER), false)
  // O chat de missão roda no worktree (userData) e sobrevive a relocar/excluir
  // o projeto — se caísse nesta ceifa, o dono perderia a conversa à toa.
  for (const paneId of [
    guiMissionPaneId('dev', MISSION),
    guiMissionPaneId('reviewer', MISSION),
    guiMissionPaneId('helper', MISSION, 2)
  ]) {
    assert.equal(isGuiPlanningPaneId(paneId, PROJECT), false, paneId)
  }
  // e o inverso: o planejamento nunca entra na ceifa de uma missão
  assert.equal(isGuiPlanningPaneId(guiPlanningPaneId(PROJECT), PROJECT), true)
  assert.equal(isGuiMissionPaneId(guiPlanningPaneId(PROJECT), MISSION), false)
  assert.equal(guiMissionRoleOf(guiPlanningPaneId(PROJECT)), undefined)
})

test('o planejador PROPÕE o plano, não executa produto nem cria missão', () => {
  const contract = guiPlanningSystemPrompt()
  assert.ok(contract.length > 200, 'contrato vazio demais')
  // O TETO subiu de 3200 para 3350 UMA vez, em 2026-08-17, para caber a única
  // regra de governança que o expurgo F6 criou: "mestre" virou DESIGNAÇÃO do
  // dono, e o planejador precisa saber que propor não é designar. As duas
  // linhas de absorção de documento legado viraram UMA no mesmo movimento —
  // o teto é para conter constituição, não para proibir regra nova.
  //
  // E de 3350 para 3750 na rodada 8 (2026-08-19), pelo GRAFO: a linha magra que
  // pedia "nomeie do que depende" virou a regra inteira do dependsOn — o que a
  // tag mostra, quando ela dá check, o que a trava faz e por que o que fica sem
  // dependência é o que o dono roda em paralelo. Ela ABSORVEU a linha antiga em
  // vez de somar-se a ela, e o contrato mede 3661.
  //
  // E de 3750 para 4200 na R16 (mesma data), pelo MAPA DA FATIA: a linha que
  // pedia "aponte os arquivos que já existem" virou a ordem inteira do
  // `context` — o que existe, o que será criado, onde não mexer — mais a razão
  // (ele viaja verbatim para o briefing do dev). Absorveu a antiga, como o
  // grafo fez, e o contrato mede 4036.
  //
  // E de 4200 para 5500 na R37 (2026-08-23), pelo MUNDO: o dono mandou parar
  // de remendar e explicar a TODO papel "como é o synkora, onde ele está e
  // como funciona" — o planejador agora abre sabendo que na mesa dele missão
  // ainda não existe e que versão/bump são do dono/app. Mede 5325.
  //
  // E de 5500 para 6400 em 2026-08-29, pelo CARDÁPIO DE SKILLS (ADR-0001 e
  // 0002): o planejador PRODUZ — ele destrincha o escopo e escreve plano/ —,
  // então o menu do worktree também é dele. A LEI do `impeccable` NÃO entra
  // aqui: ele não estiliza nada. Mede 6208.
  assert.ok(contract.length < 6400, 'contrato virou constituição')
  assert.match(contract, /"mestre" is a DESIGNATION the owner grants/u)
  assert.match(contract, /only his click designates or removes it/u)
  assert.match(contract, /PROJECT_PLAN\.md/u)
  assert.match(contract, /PT-BR/)
  assert.match(contract, /ONE-OFF/)
  assert.match(contract, /do NOT execute product work/i)
  assert.match(contract, /CREATED BY THE OWNER/)
  // 2.0 onda D: o entregável estruturado é a PROPOSTA, e ela nunca cria nada —
  // quem cria é o clique do dono no card (porteira mecânica, não persona).
  assert.match(contract, /propose_plan/)
  assert.match(contract, /never creates anything/i)
  assert.match(contract, /END YOUR TURN and wait/i)
  for (const tool of ['list_plans', 'get_plan', 'update_plan', 'delete_plan']) {
    assert.ok(contract.includes(tool), `sem a ferramenta ${tool}`)
  }
  // O brief em prosa CONTINUA no repo: o JSON é a estrutura, o markdown é a
  // profundidade — um não substitui o outro (D4.6). E o roadmap.md deixou de
  // ser exigido, porque o mapa passou a ser o roadmap.
  assert.match(contract, /plano\/NNN-slug\.md/)
  assert.match(contract, /docPath/)
  assert.equal(
    /WRITE the plan into the repository/.test(contract),
    false,
    'o plano estruturado não se escreve mais como roadmap.md'
  )
  for (const section of [
    'Objetivo',
    'Fora de escopo',
    'Critério de pronto',
    'Tier',
    'Contexto'
  ]) {
    assert.ok(contract.includes(section), `sem a seção ${section}`)
  }
  // uma entrega por missão é a régua do dono ("título com 'e' = duas missões")
  assert.match(contract, /ONE DELIVERABLE PER MISSION/)
  // aval explícito antes de escrever: ausência nunca é consentimento
  assert.match(contract, /silence is not consent/i)
})

/** A descrição que o CLI lê de uma tool do catálogo MCP (o texto, nunca o zod). */
function toolDescription(source, tool) {
  const at = source.indexOf(`'${tool}',`)
  if (at < 0) return ''
  return source.slice(at).match(/description:\s*\n?\s*'((?:[^'\\]|\\.)*)'/u)?.[1] ?? ''
}

test('declarar dependência é PARTE do planejamento — persona e as duas tools ensinam', () => {
  // A queixa do dono (rodada 8): o agente PODE declarar dependsOn e quase nunca
  // declara, então o quadro não tem grafo nenhum para mostrar. A regra passa a
  // viver nos dois lugares que o agente lê: a persona e a descrição da tool.
  const contract = guiPlanningSystemPrompt()
  assert.match(contract, /dependsOn/u, 'a persona não nomeia o campo')
  assert.match(contract, /finished/iu, 'a persona não diz o que é depender: estar PRONTA antes')
  assert.match(contract, /parallel/iu, 'a persona não diz para que a dependência serve')

  const mcp = readFileSync(new URL('../src/main/mcpServer.ts', import.meta.url), 'utf8')
  for (const tool of ['propose_plan', 'update_plan']) {
    const description = toolDescription(mcp, tool)
    assert.ok(description.length > 100, `${tool} sem descrição`)
    assert.match(description, /dependsOn/u, `${tool} não ensina a declarar dependência`)
    assert.match(description, /paralelo/iu, `${tool} não diz para que ela serve`)
  }
})

/** As descrições do campo `context` nas tools de plano, lidas da FONTE. */
function contextFieldDescribes(source) {
  return [...source.matchAll(/context:\s*z[\s\S]{0,200}?\.describe\(\s*([A-Za-z_$][\w$]*|'[^']*')/gu)].map(
    (match) => match[1]
  )
}

test('o `context` de cada item é o MAPA DA FATIA — persona e as tools de plano ensinam (R16)', () => {
  // O veredito dos 10 minutos: o planejador ESTUDA o repo para escrever o item
  // e esse estudo morre com o chat de planejamento. O `context` é o único campo
  // que atravessa (planItemMissionGoal o copia VERBATIM para o goal da missão),
  // então é nele que o mapa tem de ser exigido — nos dois lugares que o agente lê.
  const contract = guiPlanningSystemPrompt()
  assert.match(contract, /MAP OF THE SLICE/u, 'a persona não pede o mapa da fatia')
  assert.match(contract, /ALREADY exists/u, 'a persona não pede o que JÁ existe nos arquivos')
  assert.match(contract, /will be created/u, 'a persona não pede o que será criado')
  assert.match(contract, /where NOT to touch/u, 'a persona não pede a fronteira')
  // e o PORQUÊ, que é o que faz o agente escrever de verdade
  assert.match(contract, /VERBATIM into the briefing/u, 'a persona não diz para onde o texto viaja')
  assert.match(contract, /re-deriving it from zero/iu, 'a persona não diz o custo de omitir')

  const mcp = readFileSync(new URL('../src/main/mcpServer.ts', import.meta.url), 'utf8')
  const describes = contextFieldDescribes(mcp)
  assert.ok(describes.length >= 3, `o campo context aparece descrito ${describes.length}x — esperava as 3 aparições (propose_plan.items, update_plan.items, update_plan.addItems)`)
  // FONTE ÚNICA: as três apontam para a MESMA constante — descrição divergente
  // por tool ensinaria uma regra diferente conforme onde o agente escreve.
  assert.equal(new Set(describes).size, 1, `as três descrições divergiram: ${describes.join(' | ')}`)
  const [name] = describes
  assert.match(name, /^[A-Za-z_$][\w$]*$/u, 'as três descrições precisam sair de uma constante única')
  const describe = new RegExp(`const ${name}\\s*=\\s*\\n?\\s*'([^']*)'`, 'u').exec(mcp)?.[1]
  assert.ok(describe && describe.length > 100, 'a descrição do context sumiu ou ficou magra demais')
  assert.match(describe, /MAPA DA FATIA/u, 'a tool não ensina o mapa')
  assert.match(describe, /JÁ existe/u)
  assert.match(describe, /será criado/u)
  assert.match(describe, /NÃO mexer/u)
  assert.match(describe, /briefing do dev/u, 'a tool não diz que o texto viaja para o dev')
})

test('o planejador é diferente de todos os contratos de missão', () => {
  const planning = guiPlanningSystemPrompt()
  for (const role of GUI_MISSION_ROLES) {
    assert.notEqual(planning, guiMissionSystemPrompt(role), `contrato repetido com ${role}`)
  }
})

test('o 1º turno do planejamento nomeia o caderno em vez de dizer "não existe"', () => {
  const fresh = guiPlanningFirstPrompt({ projectName: 'PAINEL DE GESTÃO' })
  assert.match(fresh, /PROJECT: PAINEL DE GESTÃO/)
  assert.match(fresh, /no plano\/ files yet/)
  assert.match(fresh, /VERY FIRST output/)
  // e o estudo começa pelo que já está planejado, nunca por uma proposta cega
  assert.match(fresh, /list_plans/)
  // sem versão aberta o cabeçalho não inventa uma
  assert.equal(/VERSION IN PROGRESS/.test(fresh), false)

  const resumed = guiPlanningFirstPrompt({
    projectName: 'PAINEL DE GESTÃO',
    versionName: 'v1.2',
    roadmapExists: true
  })
  assert.match(resumed, /VERSION IN PROGRESS: v1\.2/)
  // compat: o roadmap.md legado continua sendo LIDO e absorvido (D4.6)
  assert.match(resumed, /legacy plano\/roadmap\.md/)
  assert.equal(/no plano\/ files yet/.test(resumed), false)
})

// TIPO DA MISSÃO: o planejamento deixou de ser um convite que aparece sozinho
// na coluna "✦ geral" e virou algo que o dono CRIA. O carimbo é de NASCIMENTO,
// e ausência é 'dev' — senão toda missão que já está no disco mudaria de
// natureza no primeiro boot depois desta mudança.

test('missão sem carimbo é de desenvolvimento, e o carimbo só aceita o que existe', () => {
  assert.deepEqual([...MISSION_TYPES], ['dev', 'planejamento'])
  for (const type of MISSION_TYPES) assert.equal(isMissionType(type), true)
  for (const bad of ['plan', 'planning', 'DEV', '', null, undefined, 7, {}]) {
    assert.equal(isMissionType(bad), false)
  }
  // legado (o disco de hoje) e ruído nunca viram planejamento por acidente
  assert.equal(missionTypeOf(undefined), 'dev')
  assert.equal(missionTypeOf({}), 'dev')
  assert.equal(missionTypeOf({ missionType: undefined }), 'dev')
  assert.equal(missionTypeOf({ missionType: 'dev' }), 'dev')
  assert.equal(missionTypeOf({ missionType: 'planning' }), 'dev')
  assert.equal(missionTypeOf({ missionType: 'planejamento' }), 'planejamento')
})

test('missão de dev abre os três papéis no worktree isolado', () => {
  for (const role of GUI_MISSION_ROLES) {
    for (const mission of [{}, { missionType: 'dev' }, { missionType: 'planning' }]) {
      const route = routeGuiMissionPane(mission, role)
      assert.equal(route.ok, true, `${role}: recusado`)
      assert.equal(route.missionType, 'dev')
      // a razão de a missão existir: o pane NUNCA nasce na branch principal
      assert.equal(route.workspace, 'worktree')
      assert.equal(route.systemPrompt, guiMissionSystemPrompt(role))
    }
  }
})

test('missão de planejamento é UMA conversa, na raiz, com o contrato do planejador', () => {
  const planning = { missionType: 'planejamento' }
  const route = routeGuiMissionPane(planning, 'dev')
  assert.equal(route.ok, true)
  assert.equal(route.missionType, 'planejamento')
  // RAIZ do projeto: ela lê o produto inteiro e escreve plano/ — pedir
  // worktree aqui criaria uma branch que ninguém jamais mesclaria.
  assert.equal(route.workspace, 'project-root')
  assert.equal(route.systemPrompt, guiPlanningSystemPrompt())
  assert.notEqual(route.systemPrompt, guiMissionSystemPrompt('dev'))
  // e o endereço do resume continua sendo o da missão: uma conversa por missão
  assert.equal(guiMissionPaneId('dev', MISSION), `gui-dev-${missionShortId(MISSION)}`)
})

test('planejamento não abre revisor nem ajudante', () => {
  for (const role of ['reviewer', 'helper']) {
    const route = routeGuiMissionPane({ missionType: 'planejamento' }, role)
    assert.equal(route.ok, false, `${role}: deixou abrir`)
    assert.match(route.error, /uma conversa só/)
  }
})

test('papel desconhecido é recusado antes do roteamento, em qualquer tipo', () => {
  for (const mission of [{}, { missionType: 'planejamento' }]) {
    for (const bad of ['maestro', 'qa', '', null, undefined]) {
      const route = routeGuiMissionPane(mission, bad)
      assert.equal(route.ok, false)
      assert.match(route.error, /papel desconhecido/)
    }
  }
})

test('a fila explica a porta errada em vez de acusar bloqueio', () => {
  // A mesma string que o motor devolve no ⇪ — o teste lê a fonte, não uma cópia.
  assert.match(MISSION_PLANNING_NOT_QUEUEABLE, /planejamento/)
  assert.match(MISSION_PLANNING_NOT_QUEUEABLE, /não entra na fila/)
  assert.match(MISSION_PLANNING_NOT_QUEUEABLE, /plano\//)
})

// PRIMEIRO TURNO DO PLANEJAMENTO COMO MISSÃO: o convite genérico da coluna
// "✦ geral" não tinha recorte nenhum; a missão tem o que o dono escreveu.

test('o recorte que o dono escreveu na missão viaja no 1º turno', () => {
  const prompt = guiPlanningFirstPrompt({
    projectName: 'PAINEL DE GESTÃO',
    focus: 'Planejar a v1.3\nFoco em créditos e PERDCOMP'
  })
  assert.match(prompt, /WHAT THE OWNER ASKED FOR:/)
  assert.match(prompt, /Planejar a v1\.3/)
  assert.match(prompt, /Foco em créditos e PERDCOMP/)
  // sem recorte (o convite do universo) o cabeçalho não inventa a seção
  const bare = guiPlanningFirstPrompt({ projectName: 'PAINEL DE GESTÃO' })
  assert.equal(/WHAT THE OWNER ASKED FOR/.test(bare), false)
  for (const empty of ['', '   ']) {
    assert.equal(
      /WHAT THE OWNER ASKED FOR/.test(
        guiPlanningFirstPrompt({ projectName: 'X', focus: empty })
      ),
      false
    )
  }
})

// GUARDA DO RESUME: conversa gravada só vale no MESMO CLI — sessão do claude
// não se retoma no codex. Régua única do chat da missão e do planejamento.

test('resume só sobrevive quando o CLI do seat continua o mesmo', () => {
  const claude = { sessionId: 'sess-1', cli: 'claude' }
  assert.equal(resumeSessionIdFor(claude, 'claude'), 'sess-1')
  assert.equal(resumeSessionIdFor(claude, 'codex'), undefined)

  const codex = { sessionId: 'codex-thread:abc', cli: 'codex' }
  assert.equal(resumeSessionIdFor(codex, 'codex'), 'codex-thread:abc')
  assert.equal(resumeSessionIdFor(codex, 'claude'), undefined)
})

test('registro ausente ou capenga nunca vira um --resume quebrado', () => {
  assert.equal(resumeSessionIdFor(undefined, 'claude'), undefined)
  assert.equal(resumeSessionIdFor({ cli: 'claude' }, 'claude'), undefined)
  assert.equal(resumeSessionIdFor({ sessionId: '', cli: 'claude' }, 'claude'), undefined)
  assert.equal(resumeSessionIdFor({ sessionId: 'x' }, 'claude'), undefined)
})

test('troca de seat só reseta modelo e effort quando atravessa CLI', () => {
  assert.equal(guiSeatNeedsExecutorReset({ cli: 'claude' }, { cli: 'claude' }, true), false)
  assert.equal(guiSeatNeedsExecutorReset({ cli: 'claude' }, { cli: 'codex' }, true), true)
  assert.equal(guiSeatNeedsExecutorReset(undefined, { cli: 'codex' }, false), false)
  assert.equal(
    guiSeatNeedsExecutorReset(undefined, { cli: 'codex' }, true),
    true,
    'seat gravado mas removido falha fechado'
  )
})

// ————— R25.4 — A DOUTRINA DE CUSTO NA PERSONA (o empurrão para o barato) —————
//
// Auditoria de 2026-08-20: o orquestrador gastou MAIS que os executores porque
// a conversa DELE acumula contexto gigante (139 chamadas re-lendo ~192k). A
// tese do produto é o contrário: ele planeja e despacha, e o trabalho pesado
// roda no contexto DO AJUDANTE. Isto aqui é PERSONA (texto), não guarda: o
// agente continua livre — custo é julgamento, e julgamento vira advisory.

const COST_HEADER = 'COST — YOUR CONTEXT IS THE MOST EXPENSIVE RESOURCE IN THIS HOUSE:'

/** A seção de custo, lida da FONTE (o teste nunca guarda uma cópia dela). */
function costSection(contract) {
  const at = contract.indexOf(COST_HEADER)
  if (at < 0) return undefined
  const end = contract.indexOf(DELEGATION_HEADER)
  return end > at ? contract.slice(at, end).trim() : contract.slice(at).trim()
}

test('R25.4 — a doutrina de custo viaja idêntica nos papéis que delegam', () => {
  const sections = GUI_MISSION_ROLES.map((role) => {
    const section = costSection(guiMissionSystemPrompt(role))
    assert.ok(section, `${role}: sem a doutrina de custo`)
    return section
  })
  for (const section of sections) assert.equal(section, sections[0], 'fonte única, como a delegação')

  const section = sections[0]
  // O QUE ELA TEM DE DIZER, e por quê (cada linha responde a um número medido):
  // cada chamada re-lê o contexto inteiro…
  assert.match(section, /every.*(call|message)[\s\S]*re-?read|re-?reads the whole/iu)
  // …então despachar cedo é mais barato que ler/varrer você mesmo…
  assert.match(section, /delegate/u)
  // …a entrega chega em ARQUIVO e o resumo basta (o bruto é o caro)…
  assert.match(section, /file/iu)
  assert.match(section, /summary/iu)
  // …e o DONO paga cada re-leitura (a frase que fecha a régua).
  assert.match(section, /owner pays/iu)

  // Curta como as irmãs: régua, não constituição.
  assert.ok(section.length > 300, 'a doutrina ficou vaga demais')
  assert.ok(section.length < 1400, 'a doutrina virou constituição')
})

test('R25.4 — a doutrina vem ANTES da delegação e não desloca a última palavra', () => {
  for (const role of GUI_MISSION_ROLES) {
    const contract = guiMissionSystemPrompt(role)
    const cost = contract.indexOf(COST_HEADER)
    assert.ok(cost >= 0, `${role}: sem a doutrina de custo`)
    assert.ok(
      cost < contract.indexOf(DELEGATION_HEADER),
      `${role}: a ordem permanente da delegação continua sendo a última palavra`
    )
  }
  // O planejador não delega (D2) — e é a delegação que a doutrina governa.
  assert.equal(costSection(guiPlanningSystemPrompt()), undefined)
})

test('R25.4 — a doutrina é PERSONA, nunca guarda: nenhum verbo de bloqueio', () => {
  const section = costSection(guiMissionSystemPrompt('dev'))
  // Custo é JULGAMENTO (memória feedback-guardas-nao-capam-inteligencia): a
  // persona empurra, o agente decide. Proibir turno longo aqui seria capar a
  // inteligência que o dono paga para ter.
  assert.doesNotMatch(section, /you are not allowed|forbidden|you must not read/iu)
  // E ela não fala em DINHEIRO: com assinatura o CLI não reporta custo em $.
  assert.doesNotMatch(section, /\$|dollar|usd/iu)
})

// ————— A REGRA DO FRATRICÍDIO (2026-08-23, escrita com dois crashes) —————
//
// O agente de uma missão de auditoria derrubou o Synkora DUAS VEZES na mesma
// noite com `Get-Process electron | Stop-Process -Force`: ele queria limpar o
// app Electron que estava testando, e o app que o HOSPEDA também é
// electron.exe. Provado no transcript (04:03:36.872Z → child-gone em massa
// 04:03:37.874Z; segundo tiro 04:15:44). O harness não intercepta o shell
// nativo dos CLIs, então a defesa mora na PERSONA de todo papel que roda
// processo — e esta cerca impede a regra de sair dela.

test('todo papel que roda processo carrega a regra do fratricídio', async () => {
  const { guiReleaseSystemPrompt } = await import('../src/main/guiMissionContracts.ts')
  for (const [nome, prompt] of [
    ['dev', guiMissionSystemPrompt('dev')],
    ['helper', guiMissionSystemPrompt('helper')],
    ['release', guiReleaseSystemPrompt()]
  ]) {
    // A proibição nomeia as ARMAS reais (as duas formas do tiro)…
    assert.match(prompt, /Get-Process electron/u, `${nome}: a regra nomeia o tiro do PowerShell`)
    assert.match(prompt, /taskkill \/IM/u, `${nome}: a regra nomeia o tiro do taskkill`)
    // …diz o PORQUÊ (o hospedeiro é electron.exe também)…
    assert.match(prompt, /electron\.exe/u, `${nome}: a regra diz por que o tiro é fratricida`)
    // …e dá a RECEITA sancionada (PID próprio / dono da porta) — beco sem
    // saída é bug, inclusive em persona.
    assert.match(prompt, /\/PID|OwningProcess/u, `${nome}: a regra entrega a rota certa`)
  }
  // O planejamento não roda processo nenhum — a regra não entra lá à toa.
  assert.doesNotMatch(guiPlanningSystemPrompt(), /taskkill/u)
})

// ————— SKILLS 2.0 — O CARDÁPIO E A LEI (2026-08-29, ADRs 0001/0002/0005) —————
//
// O cardápio de skills chega ao chat pelo TRANSPORTE NATIVO dos CLIs (ADR-0002:
// o harness sincroniza o kit para a pasta de skills do worktree e o binário o
// lista sozinho). Então o que falta ao MODELO não é a ferramenta — é a régua de
// USO, e ela é de julgamento: ADR-0001 diz que quem escolhe do cardápio é o
// AGENTE, por ocasião, porque heurística de conteúdo é proibida nesta casa.
//
// A LEI (ADR-0005) é a única exceção, e o dono a fixou na PERSONA de propósito:
// "trabalho de UI ⇒ impeccable, sempre — nunca empilhada com outra direção
// estética". Persona e não toggle porque mudar lei é doutrina com ele (commit),
// nunca clique na tela de gestão — e a tela mostra a lei como texto FIXO
// justamente por isso.
//
// QUEM RECEBE O QUÊ é decisão registrada no design: cardápio só para quem
// PRODUZ (dev, ajudante e planejador); a lei só para quem ESTILIZA (dev e
// ajudante). O reviewer lê diff e não edita produto, e o release opera a subida
// da versão — prometer skill de estilo a eles seria mandá-los seguir um playbook
// para trabalho que o contrato deles já proíbe.

const SKILLS_HEADER = 'SKILLS — THE MENU COMES TO YOU; CHOOSING FROM IT IS YOUR JUDGEMENT:'

/**
 * O bloco do cardápio, lido da FONTE — do cabeçalho até a linha em branco que
 * separa as seções do contrato (no planejador ele fecha o texto e vai até o
 * fim). O teste nunca guarda uma cópia do bloco: é ele que prova a fonte única.
 */
function skillsSection(contract) {
  const at = contract.indexOf(SKILLS_HEADER)
  if (at < 0) return undefined
  const end = contract.indexOf('\n\n', at)
  return (end < 0 ? contract.slice(at) : contract.slice(at, end)).trim()
}

test('o cardápio é FONTE ÚNICA e chega a quem PRODUZ: dev, ajudante e planejador', () => {
  const dev = skillsSection(guiMissionSystemPrompt('dev'))
  const helper = skillsSection(guiMissionSystemPrompt('helper'))
  const planner = skillsSection(guiPlanningSystemPrompt())
  for (const [nome, section] of [
    ['dev', dev],
    ['helper', helper],
    ['planner', planner]
  ]) {
    assert.ok(section, `${nome}: sem o bloco do cardápio de skills`)
  }
  // FONTE ÚNICA, como a ordem da delegação: ninguém tem a própria versão da
  // régua. A diferença entre os que estilizam e o planejador é a LEI, e só ela
  // (provado no teste seguinte, pelo DELTA — aqui basta o prefixo comum).
  assert.equal(dev, helper, 'dev e ajudante divergiram no cardápio')
  assert.ok(dev.startsWith(planner), 'o planejador recebeu outro cardápio, não o mesmo bloco')

  // O TRANSPORTE é nativo (ADR-0002): pasta de skills do worktree, listada pelo
  // próprio CLI. Nada de tool inventada — prometer `skill_menu`/`skill_load`
  // mandaria o agente procurar ferramenta que o catálogo não tem.
  assert.match(planner, /skills folder/iu, 'o bloco não diz DE ONDE o cardápio vem')
  assert.doesNotMatch(planner, /skill_menu|skill_load/u, 'o cardápio virou tool inventada')
  // A ESCOLHA é do agente, por OCASIÃO (ADR-0001) — e ninguém roteia por ele.
  assert.match(planner, /JUDGEMENT/u, 'a escolha deixou de ser julgamento do agente')
  assert.match(planner, /OCCASION/u, 'sumiu o gatilho: a ocasião')
  assert.match(
    planner,
    /Nothing routes them to you/iu,
    'o bloco não diz que ninguém escolhe no lugar dele'
  )
  // O QUE É uma skill: playbook para SEGUIR enquanto a ocasião dura — nunca
  // enfeite citado de passagem.
  assert.match(planner, /PLAYBOOK/u, 'skill virou enfeite')
  assert.match(planner, /decoration/iu, 'sem a negação do enfeite')
  // E a régua que a lei depois carimba: direção estética não se empilha.
  assert.match(planner, /NEVER stack/u, 'empilhar direção estética voltou a ser livre')
  // Beco sem saída é bug, inclusive em persona: cardápio incompleto não trava.
  assert.match(planner, /never stops the job/iu, 'skill ausente virou impedimento')

  // Curto como as seções irmãs: régua, não constituição.
  assert.ok(planner.length > 400, 'o cardápio ficou vago demais')
  assert.ok(planner.length < 1400, 'o cardápio virou constituição')

  // E ele não desloca a última palavra do contrato (a ordem da delegação).
  for (const role of ['dev', 'helper']) {
    const contract = guiMissionSystemPrompt(role)
    assert.ok(
      contract.indexOf(SKILLS_HEADER) < contract.indexOf(DELEGATION_HEADER),
      `${role}: o cardápio passou na frente da ordem permanente da delegação`
    )
  }
})

test('a LEI é do DEV e do AJUDANTE: impeccable ANTES de estilizar, fora de qualquer toggle', () => {
  const planner = skillsSection(guiPlanningSystemPrompt())
  assert.ok(planner, 'sem o cardápio do planejador não há como medir o delta da lei')
  for (const role of ['dev', 'helper']) {
    const section = skillsSection(guiMissionSystemPrompt(role))
    assert.ok(section, `${role}: sem o bloco do cardápio, a lei não tem onde morar`)
    // O DELTA para o bloco do planejador é EXATAMENTE a lei — nem uma linha a
    // mais viaja escondida junto dela.
    const law = section.slice(planner.length).trim()
    assert.ok(law.length > 0, `${role}: sem a lei do impeccable`)
    assert.equal(law.includes('\n'), false, `${role}: a lei virou seção, e ela é UMA linha`)
    assert.match(law, /^- THE ONE LAW/u, `${role}: a lei não se anuncia como lei`)
    // A skill, nomeada como o CLI a lista (a pasta = o `name:` do frontmatter).
    assert.match(law, /`impeccable`/u, `${role}: a lei não nomeia a skill`)
    // A OCASIÃO inteira, nas palavras do dono: trabalho de UI.
    for (const occasion of ['styling', 'layout', 'motion', 'visual polish']) {
      assert.ok(law.includes(occasion), `${role}: a ocasião não cobre ${occasion}`)
    }
    // ANTES de estilizar — carregar depois de pronto é decorar, não seguir.
    assert.match(law, /BEFORE you style/u, `${role}: a lei perdeu a hora de carregar`)
    // E nunca empilhada com outra direção estética (a metade que o dono ditou).
    assert.match(
      law,
      /never stacked with another aesthetic direction/u,
      `${role}: empilhar direção estética voltou a ser possível`
    )
    // ADR-0005: ela mora na PERSONA. Mudar lei é doutrina com o dono (commit),
    // nunca clique — então o texto não pode sugerir chave para desligá-la.
    assert.match(law, /no setting/iu, `${role}: a lei ficou parecendo um toggle da tela`)
  }
  // O planejador não estiliza: ele desenha o mapa e escreve plano/. A lei não
  // entra no chat dele — nem a skill dela é citada por acidente.
  assert.doesNotMatch(guiPlanningSystemPrompt(), /impeccable/iu, 'o planejador ganhou a lei da UI')
})

test('quem não PRODUZ não recebe cardápio nem lei: reviewer e release intocados', () => {
  // Decisão registrada no design de 2026-08-29: cardápio só para quem produz. O
  // reviewer lê diff e não edita produto; o release sobe a versão pelas duas
  // ferramentas dele. Dar-lhes um playbook de estilo seria contradizer o próprio
  // contrato de cada um.
  for (const [nome, prompt] of [
    ['reviewer', guiMissionSystemPrompt('reviewer')],
    ['release', guiReleaseSystemPrompt()]
  ]) {
    assert.equal(skillsSection(prompt), undefined, `${nome}: recebeu o cardápio de skills`)
    assert.doesNotMatch(prompt, /impeccable/iu, `${nome}: recebeu a lei da UI`)
    assert.doesNotMatch(prompt, /THE ONE LAW/u, `${nome}: recebeu a lei da UI`)
  }
})
