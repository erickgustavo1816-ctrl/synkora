import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// CONVERSA DE MISSÃO ENCERRADA — o contrato do clique e o da leitura congelada.
//
// Duas metades, e as duas importam:
//  1. a CLASSIFICAÇÃO do clique (módulo puro, matriz status × direct × kind);
//  2. a linha de carga do modo somente-leitura no GuiPane — o retorno que
//     acontece ANTES da decisão de abrir sessão. Sem ele, `shouldCreateGuiSession`
//     de um pane morto-mas-gravado (exists && !alive) é TRUE e LER a conversa de
//     uma missão arquivada RESSUSCITARIA o CLI.
//
// Cada teste lê a sua própria fonte (nada de leitura no topo do arquivo) e
// importa o módulo puro dentro do próprio teste: assim, quando um contrato
// quebra, o relatório acusa ESSE contrato em vez de morrer na carga e esconder
// os outros.

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/gu, '\n')

test('o clique no card de missão tem TRÊS destinos — e a arquivada 2.0 é um deles', async () => {
  const { missionCardAccess, MISSION_CARD_TIP } = await import(
    '../src/renderer/src/missionCardAccess.ts'
  )

  // viva: abre no board, como sempre
  assert.equal(missionCardAccess({ status: 'ativa' }), 'live')
  assert.equal(missionCardAccess({ status: 'ativa', direct: true }), 'live')
  assert.equal(missionCardAccess({ status: 'integrando', direct: true }), 'live')

  // encerrada COM conversa 2.0 gravada: fotografia somente-leitura
  assert.equal(missionCardAccess({ status: 'arquivada', direct: true }), 'frozen-chat')
  assert.equal(missionCardAccess({ status: 'concluida', direct: true }), 'frozen-chat')

  // legada (sem o carimbo 2.0): não existe conversa para abrir
  assert.equal(missionCardAccess({ status: 'arquivada' }), 'inert')
  assert.equal(missionCardAccess({ status: 'concluida' }), 'inert')
  assert.equal(missionCardAccess({ status: 'arquivada', direct: false }), 'inert')

  // ARMADILHA DE NOME: `kind: 'direta'` é registro de agente livre (nasce
  // concluído, sem branch e sem conversa) — confundi-lo com `direct: true`
  // ofereceria um chat que nunca existiu.
  assert.equal(missionCardAccess({ status: 'concluida', direct: true, kind: 'direta' }), 'inert')
  assert.equal(missionCardAccess({ status: 'arquivada', direct: true, kind: 'direta' }), 'inert')
  assert.equal(missionCardAccess({ status: 'concluida', kind: 'direta' }), 'inert')

  // três destinos, três verdades: tooltip repetido é alavanca que mente
  const tips = [MISSION_CARD_TIP.live, MISSION_CARD_TIP['frozen-chat'], MISSION_CARD_TIP.inert]
  assert.equal(new Set(tips).size, 3)
  assert.equal(MISSION_CARD_TIP.inert, 'Missão encerrada — sem conversa guardada')
  assert.match(MISSION_CARD_TIP['frozen-chat'], /somente leitura/u)
})

test('os endereços das conversas da missão são determinísticos e usam o teto do main', async () => {
  const { missionChatAddresses, MAX_MISSION_HELPER_PANES } = await import(
    '../src/renderer/src/guiMissionPanes.ts'
  )
  const addresses = missionChatAddresses('1f3a9c2b-1111-2222-3333-444455556666')
  const ids = addresses.map((address) => address.paneId)

  assert.deepEqual(ids.slice(0, 2), ['gui-dev-1f3a9c2b', 'gui-reviewer-1f3a9c2b'])
  assert.equal(ids.length, 2 + MAX_MISSION_HELPER_PANES)
  assert.equal(ids[2], 'gui-helper-1f3a9c2b-1')
  assert.equal(ids[ids.length - 1], `gui-helper-1f3a9c2b-${MAX_MISSION_HELPER_PANES}`)
  assert.deepEqual(
    addresses.slice(0, 4).map((address) => address.label),
    ['agente', 'revisor', 'ajudante', 'ajudante 2']
  )

  // O espelho tem de valer o mesmo que o original: teto menor deixaria o
  // ajudante do fim invisível para sempre; maior procuraria endereço que o
  // main nunca aloca.
  assert.match(
    read('../src/main/ipc/missions.ts'),
    new RegExp(`MAX_MISSION_HELPERS = ${MAX_MISSION_HELPER_PANES}\\b`, 'u')
  )
})

/**
 * O recorte é o EFEITO DE MONTAGEM do GuiPane — o arquivo inteiro não serve:
 * `guiApi.create` também é citado em comentário e o pane vivo continua tendo o
 * direito de abrir sessão. Marcador que não resolve FALHA ALTO: recorte que
 * degrada em silêncio é guarda morto fingindo estar vivo.
 */
const MOUNT_START = 'const replay = await guiApi.state(paneId)'
const MOUNT_END = 'const res = await guiApi.create(spawn)'

function mountEffectRegion(source) {
  const start = source.indexOf(MOUNT_START)
  assert.notEqual(start, -1, `marcador inicial sumiu de GuiPane.tsx: ${MOUNT_START}`)
  const end = source.indexOf(MOUNT_END, start)
  assert.notEqual(end, -1, `marcador final sumiu de GuiPane.tsx: ${MOUNT_END}`)
  return source.slice(start, end)
}

/** null = a fotografia congelada para antes de abrir sessão. */
function frozenMountProblem(region) {
  const guard = region.indexOf('if (readOnly) return')
  const decision = region.indexOf('shouldCreateGuiSession(')
  if (guard === -1) return 'o retorno antecipado de readOnly sumiu do efeito de montagem'
  if (decision === -1) return 'a decisão de abrir sessão sumiu do recorte'
  if (guard > decision) return 'o retorno de readOnly caiu DEPOIS da decisão de abrir sessão'
  return null
}

test('ler uma conversa congelada não abre sessão: o retorno vem ANTES da decisão', () => {
  const region = mountEffectRegion(read('../src/renderer/src/components/GuiPane.tsx'))
  assert.equal(frozenMountProblem(region), null)

  // CONTROLE NEGATIVO 1: sem a linha de carga, o guarda tem de acusar (o
  // `replace` que não achar seu alvo derruba este assert junto).
  assert.notEqual(frozenMountProblem(region.replace('if (readOnly) return', '// sem guarda')), null)

  // CONTROLE NEGATIVO 2: a ORDEM é o que protege. Guarda depois da decisão
  // deixa `guiApi.create` acontecer — e é exatamente esse o bug.
  const late = `${region.replace('if (readOnly) return', '')}\n      if (readOnly) return\n`
  assert.notEqual(frozenMountProblem(late), null)
})

test('modo somente-leitura deixa a conversa inteira inerte, sem inventar estado vivo', () => {
  const source = read('../src/renderer/src/components/GuiPane.tsx')

  assert.match(source, /readOnly\?: boolean/u)
  assert.match(source, /const inert = Boolean\(historyTarget\) \|\| readOnly/u)

  // As três superfícies que o overlay de histórico nunca precisou cobrir:
  // `settleGuiReplay` não limpa perm/question/planReview, então um transcript
  // que morreu no meio de uma decisão renderizaria o card VIVO.
  assert.match(source, /\{!inert && gui\.planReview &&/u)
  assert.match(source, /\{!inert && gui\.question &&/u)
  assert.match(source, /\{!inert && askingGo &&/u)
  // e as três que já eram gateadas por historyTarget continuam gateadas
  assert.match(source, /\{!inert && gui\.perm &&/u)
  assert.match(source, /\{!inert && queuedMessage &&/u)
  assert.match(source, /\{!inert && !awaitingCard &&/u)
  assert.doesNotMatch(source, /!historyTarget &&/u)

  // nenhum sinal de vida fabricado: sem visibilidade (título [pronto]), sem
  // recibo de apresentação e sem o estado `abrindo` que o replay deixa.
  assert.match(source, /if \(readOnly\) return\n\s*guiApi\.visibility\(paneId, active\)/u)
  assert.match(source, /if \(readOnly\) return\n\s*const canAcknowledge/u)
  // (2026-09-08) o cabeçalho do GuiPane virou só FATOS: o estado do turno e a
  // troca de conta moram na cabeça do palco (Board), que a fotografia não tem.
  assert.doesNotMatch(source, /gui-head-status|STATUS_TEXT|StageRoundStatus/u)
  assert.doesNotMatch(source, /onChangeSeat|StageSeatChip/u)
  const viewer = read('../src/renderer/src/components/ArchivedMissionChat.tsx')
  assert.doesNotMatch(
    viewer,
    /StageRoundStatus|StageSeatChip/u,
    'a fotografia não inventa estado vivo nem oferece troca de conta'
  )

  // vazio HONESTO: a poda do histórico é real, e chat em branco se lê como
  // defeito novo.
  assert.match(source, /esta conversa não está mais guardada/u)
})

test('o viewer congelado só lê: nada de create, kill ou drop', () => {
  const source = read('../src/renderer/src/components/ArchivedMissionChat.tsx')

  assert.match(source, /guiApi\.state\(/u)
  assert.doesNotMatch(source, /guiApi\.(create|send|kill|interrupt|permission|visibility)/u)
  assert.doesNotMatch(source, /dropGuiPane|missions\.guiSpec|guiSpec\(/u)

  // GuiPane congelado, dentro do limite isolado (este arquivo não entra no
  // censo do test-gui-panel-boundary — o par vive aqui).
  assert.match(source, /<GuiPanelErrorBoundary[\s\S]*<GuiPane/u)
  assert.match(source, /readOnly/u)
  assert.match(source, /active=\{false\}/u)

  // reativar devolve a conversa ao board: duas montagens do mesmo paneId
  // brigariam pela mesma chave de `guiPanes`, então a leitura sai de cena.
  assert.match(source, /liveStatus === 'arquivada' \|\| liveStatus === 'concluida'/u)
  assert.match(source, /onClose\(\)/u)
  assert.match(source, /className="overlay" onClick=\{onClose\}/u)

  // nada roda aqui: papel, nunca painel de terminal
  assert.doesNotMatch(source, /term-window|--panel/u)
  assert.doesNotMatch(source, /window\.(confirm|alert)/u)
  assert.match(source, /não está mais guardada/u)
})

test('a aba Versões classifica o clique e avisa que excluir apaga a conversa', () => {
  const source = read('../src/renderer/src/components/BacklogView.tsx')

  assert.match(source, /missionCardAccess\(m\)/u)
  assert.match(source, /data-tip=\{MISSION_CARD_TIP\[access\]\}/u)
  assert.match(source, /access === 'frozen-chat'/u)
  assert.match(source, /<ArchivedMissionChat mission=\{chatViewer\} onClose=\{closeChatViewer\} \/>/u)

  // o booleano único morreu: era ele que deixava a arquivada clicável
  assert.doesNotMatch(source, /const clickable = m\.status !== 'concluida'/u)

  // 🗑 é o ÚNICO apagador do transcript (arquivar guarda) — o modal diz isso,
  // e só para quem TEM conversa gravada: missão legada nunca teve.
  assert.match(source, /missionCardAccess\(confirmDelete\) === 'frozen-chat' &&/u)
  assert.match(source, /A conversa desta missão será apagada junto/u)
  assert.doesNotMatch(source, /window\.(confirm|alert)/u)
})

// R27 — o registro interno da subida NUNCA é missão de superfície: não vira
// card, não vira aba, não conta em retrato nenhum. A régua mora AQUI, no
// módulo puro da classificação, e as telas a consomem em vez de reescrevê-la.
test('R27 — o registro de release não é missão de superfície', async () => {
  const access = await import('../src/renderer/src/missionCardAccess.ts')
  assert.equal(
    typeof access.isReleaseMissionRecord,
    'function',
    'a régua existe e mora na classificação'
  )
  assert.equal(access.isReleaseMissionRecord({ missionType: 'release' }), true)
  assert.equal(access.isReleaseMissionRecord({ missionType: 'dev' }), false)
  assert.equal(access.isReleaseMissionRecord({}), false)
})
