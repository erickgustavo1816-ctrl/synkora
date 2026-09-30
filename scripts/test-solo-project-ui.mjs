import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { build } from 'esbuild'
import React from 'react'
import { act, create } from 'react-test-renderer'

// A TELA DO UNIVERSO SEM VERSIONAMENTO (2026-09-30) — componentes de verdade,
// renderizados, mais os contratos de fonte que um teste de render não pega.
//
//  1. o Universe escolhe a tela pela MODALIDADE (o versionado segue no Board);
//  2. o Início: título vazio diz o que falta, Ctrl+Enter cria, recusa do main
//     aparece colada à folha, o livro-razão lê e abre;
//  3. o FINALIZAR: parado = cancelar/finalizar; no meio do turno o BOTÃO muda
//     (esperar/interromper), a recusa do main aparece na folha, Esc cancela;
//  4. cercas: todo campo do spawn chega ao GuiPane do modo, a leitura nunca
//     abre sessão, e nenhuma superfície de git (trilho, fila, histórico de
//     commits, revisão) é montada ou chamada pelos arquivos do modo.
//
// Código velho: os componentes SoloProject* não existem e o Universe não
// conhece a modalidade — cada teste reprova por conta própria.

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/gu, '\n')
const withoutComments = (src) => src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1')

/** Troca módulos por stubs (o esbuild lê o filtro como regex do Go: sem `u`). */
function stubs(map) {
  return {
    name: 'solo-stubs',
    setup(b) {
      for (const [spec, contents] of Object.entries(map)) {
        const filter = new RegExp(`^${spec.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`)
        b.onResolve({ filter }, () => ({ path: spec, namespace: 'solo-stub' }))
      }
      b.onLoad({ filter: /.*/, namespace: 'solo-stub' }, (args) => ({ contents: map[args.path], loader: 'jsx' }))
    }
  }
}

async function bundle(entry, map = {}) {
  const result = await build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
    loader: { '.css': 'empty' }, external: ['react', 'react/jsx-runtime', 'react-dom'], plugins: [stubs(map)]
  })
  return result.outputFiles[0].text
}

function run(code, globals = {}) {
  const loaded = { exports: {} }
  const names = Object.keys(globals)
  new Function('require', 'module', 'exports', ...names, code)(
    (id) => (id === 'react-dom' ? { createPortal: (node) => node } : createRequire(import.meta.url)(id)),
    loaded, loaded.exports, ...names.map((name) => globals[name])
  )
  return loaded.exports
}

const textOf = (node) => (typeof node === 'string' ? node : (node.children ?? []).map(textOf).join(''))

test('o Universe escolhe a tela pela modalidade: sem versionamento tem tela própria, o versionado segue no Board', async () => {
  const code = await bundle('src/renderer/src/screens/Universe.tsx', {
    '../store': `export const useStore = (selector) => selector(globalThis.__universeState)`,
    '../components/Board': `export default function Board() { return <div data-screen="board" /> }`,
    '../components/SoloProject': `export default function SoloProject({ project }) { return <div data-screen="solo" data-project={project.id} /> }`,
    '../components/FilesView': `export default function FilesView() { return null }`,
    '../components/BacklogView': `export default function BacklogView() { return null }`,
    '../components/UniverseMapView': `export default function UniverseMapView() { return null }`,
    '../components/GuiPanelErrorBoundary': `export default function B({ children }) { return children }`
  })
  const Universe = run(code).default
  const state = (projects) => ({
    projects, universeTabByProject: {}, missionsByProject: {}, missions: [], homeStats: {},
    setUniverseTab() {}, renameProject() {}, relocateProject() {}, setProjectPhoto() {}, loadHomeStats: async () => {}
  })
  const screens = (tree) => tree.root.findAll((node) => typeof node.type === 'string' && node.props['data-screen'])
    .map((node) => node.props['data-screen'])

  globalThis.__universeState = state([{ id: 'p1', name: 'Synkora', path: 'C:/s', createdAt: '' }])
  let tree
  await act(() => { tree = create(React.createElement(Universe, { projectId: 'p1' })) })
  assert.deepEqual(screens(tree), ['board'], 'o versionado continua no Board')
  assert.ok(tree.root.findAll((node) => node.type === 'button' && textOf(node) === 'Mapa').length === 1)

  globalThis.__universeState = state([{ id: 'p1', name: 'Proposta', path: 'C:/p', createdAt: '', versioning: 'none' }])
  await act(() => { tree = create(React.createElement(Universe, { projectId: 'p1' })) })
  assert.deepEqual(screens(tree), ['solo'], 'sem versionamento: nem Board, nem Mapa, nem Versões')
  assert.equal(tree.root.findAll((node) => node.type === 'button' && textOf(node) === 'Mapa').length, 0)
})

const startCode = () => bundle('src/renderer/src/components/SoloProjectStart.tsx')

test('o Início: título vazio diz o que falta, Ctrl+Enter cria, e a recusa do main fica colada à folha', async () => {
  const Start = run(await startCode()).default
  const calls = []
  let answer = null
  const props = (over = {}) => ({
    folder: 'proposta-clinica', rows: [], justFinishedId: null, autoFocus: false,
    onStart: async (input) => { calls.push(input); return answer }, onRead() {}, ...over
  })
  let tree
  await act(() => { tree = create(React.createElement(Start, props()), { createNodeMock: () => ({ focus() {} }) }) })
  assert.match(textOf(tree.root.findByProps({ className: 'ss-sub' })), /direto na pasta proposta-clinica\. Uma missão por vez\./u)
  // sem histórico, a frase de como o modo funciona; nada de "Finalizadas"
  assert.equal(tree.root.findAll((n) => n.props.className === 'ss-how').length, 1)
  assert.equal(tree.root.findAll((n) => n.props.className === 'solo-log').length, 0)

  const form = tree.root.findByType('form')
  await act(async () => { form.props.onSubmit({ preventDefault() {} }) })
  assert.equal(calls.length, 0, 'título vazio não cria nada')
  assert.equal(textOf(tree.root.findByProps({ role: 'alert' })), 'Dê um título para a missão.')

  const field = (name) => tree.root.find((n) => n.type !== undefined && String(n.props.className ?? '').split(' ').includes(name))
  const title = field('ss-title')
  await act(async () => { title.props.onChange({ target: { value: '  Reescrever preços ' } }) })
  assert.equal(tree.root.findAll((n) => n.props.role === 'alert').length, 0, 'digitar apaga o aviso')
  await act(async () => { field('ss-goal').props.onChange({ target: { value: 'três planos' } }) })
  await act(async () => { form.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} }) })
  assert.deepEqual(calls, [{ title: 'Reescrever preços', goal: 'três planos', direct: true, missionType: 'dev' }])

  answer = 'Este projeto não é versionado e já tem uma missão aberta. Finalize a missão aberta para começar outra.'
  await act(async () => { form.props.onSubmit({ preventDefault() {} }) })
  assert.equal(textOf(tree.root.findByProps({ className: 'ss-error' })), answer)
})

test('o livro-razão: ordem recebida, resumo ou a falta dele, a recém-finalizada marcada, e a linha abre a leitura', async () => {
  const Start = run(await startCode()).default
  const opened = []
  const rows = [
    { id: 'c', title: 'Reescrever a seção de preços', day: '30 set', time: '11:02', summary: 'Separei os preços em três planos.', label: 'Ler a missão Reescrever a seção de preços' },
    { id: 'b', title: 'Trocar a fonte do PDF', day: '26 set', time: '18:21', summary: null, label: 'Ler a missão Trocar a fonte do PDF' }
  ]
  let tree
  await act(() => {
    tree = create(React.createElement(Start, {
      folder: 'p', rows, justFinishedId: 'c', autoFocus: false, onStart: async () => null, onRead: (id) => opened.push(id)
    }), { createNodeMock: () => ({ focus() {} }) })
  })
  assert.equal(tree.root.findAll((n) => n.props.className === 'ss-how').length, 0)
  assert.equal(textOf(tree.root.findByProps({ className: 'log-count' })), '2')
  const items = tree.root.findAll((n) => n.type === 'li')
  assert.deepEqual(items.map((li) => li.props.className), ['just', undefined])
  const buttons = tree.root.findAll((n) => n.type === 'button' && n.props.className === 'log-row')
  assert.deepEqual(buttons.map((b) => b.props['aria-label']), rows.map((r) => r.label))
  assert.match(textOf(buttons[0]), /30 set11:02Reescrever a seção de preçosSeparei os preços em três planos\./u)
  assert.match(textOf(buttons[1]), /sem resumo: o agente não deixou um/u)
  await act(async () => { buttons[1].props.onClick() })
  assert.deepEqual(opened, ['b'])
})

async function finishHarness() {
  const code = await bundle('src/renderer/src/components/SoloProjectFinish.tsx')
  const window = new EventTarget()
  const Finish = run(code, { window, document: { body: {} } }).default
  const log = []
  const base = { title: 'Reescrever a seção de preços', risk: null, busy: false, error: null,
    onConfirm: () => log.push('confirm'), onCancel: () => log.push('cancel') }
  let tree
  const mount = async (over = {}) => {
    // uma folha por vez: a anterior sai (e leva o ouvinte do Esc junto)
    if (tree) await act(() => tree.unmount())
    await act(() => { tree = create(React.createElement(Finish, { ...base, ...over }), { createNodeMock: () => ({ focus() {} }) }) })
    return tree
  }
  return { window, log, mount, buttons: () => tree.root.findAll((n) => n.type === 'button').map((b) => ({ text: textOf(b), node: b })) }
}

test('finalizar parado: três fatos, Cancelar e Finalizar missão; Esc cancela', async () => {
  const h = await finishHarness()
  const tree = await h.mount()
  assert.match(textOf(tree.root), /Finalizar “Reescrever a seção de preços”\?/u)
  for (const fact of ['O chat do agente e os ajudantes param.', 'As edições já estão na pasta e ficam como estão.',
    'A missão vai para o histórico, só para leitura, e a tela volta para o Início.']) assert.ok(textOf(tree.root).includes(fact), fact)
  assert.equal(tree.root.findAll((n) => n.props.role === 'alert').length, 0)
  const buttons = h.buttons()
  assert.deepEqual(buttons.slice(1).map((b) => b.text), ['Cancelar', 'Finalizar missão'])
  assert.match(buttons[2].node.props.className, /\baccent\b/u)
  await act(async () => { buttons[2].node.props.onClick() })
  await act(async () => { h.window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })) })
  assert.deepEqual(h.log, ['confirm', 'cancel'])
})

test('finalizar no meio do turno muda o BOTÃO: esperar o agente ou interromper, em vermelho', async () => {
  const h = await finishHarness()
  const tree = await h.mount({ risk: {
    headline: 'O agente está no meio de uma resposta (há 2:14) e 1 ajudante ainda trabalha.',
    consequence: 'Finalizar agora interrompe os dois, e uma edição feita pela metade pode ficar na pasta.'
  } })
  assert.match(textOf(tree.root.findByProps({ className: 'fm-risk' })), /há 2:14.*interrompe os dois/u)
  const buttons = h.buttons()
  assert.deepEqual(buttons.slice(1).map((b) => b.text), ['Esperar o agente', 'Interromper e finalizar'])
  assert.match(buttons[2].node.props.className, /\bdanger\b/u)

  const busy = await h.mount({ busy: true, error: 'Não deu para encerrar o chat da missão.' })
  assert.equal(textOf(busy.root.findByProps({ className: 'fm-error' })), 'Não deu para encerrar o chat da missão.')
  assert.ok(h.buttons().every((b) => b.node.props.disabled), 'nada se clica enquanto o main finaliza')
  assert.equal(h.buttons()[2].text, 'Finalizando…')
  await act(async () => { h.window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })) })
  assert.deepEqual(h.log, [], 'Esc não abandona uma finalização em voo')
})

/** Campos de primeiro nível de `interface X { … }` (a mesma régua da cerca de
 *  paridade do Board em test-gui-chat-ui.mjs). */
function interfaceFields(source, name) {
  const at = source.indexOf(`interface ${name} {`)
  assert.notEqual(at, -1, `interface ${name}`)
  let depth = 0
  let body = ''
  for (let i = source.indexOf('{', at); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) { body = source.slice(source.indexOf('{', at) + 1, i); break } }
  }
  const fields = []
  depth = 0
  for (const raw of body.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/[^\n]*/gu, '').split('\n')) {
    const line = raw.trim()
    if (depth === 0) { const match = /^([A-Za-z_$][\w$]*)\??\s*:/u.exec(line); if (match) fields.push(match[1]) }
    for (const ch of line) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1 }
  }
  return fields
}

test('todo campo do spawn chega ao GuiPane da missão sem versionamento', () => {
  const fields = interfaceFields(read('src/main/guiSessions.ts'), 'GuiPaneSpawn')
  assert.ok(fields.length >= 12 && fields.includes('mcp') && fields.includes('cwd'))
  const mission = read('src/renderer/src/components/SoloProjectMission.tsx')
  const opens = /<GuiPane[\s\n]/u.exec(mission)
  assert.ok(opens, 'a missão monta o <GuiPane>')
  const jsx = mission.slice(opens.index, mission.indexOf('/>', opens.index))
  const passed = new Set([...jsx.matchAll(/(?:^|\s)([a-zA-Z][\w]*)=[{"]/gu)].map((m) => m[1]))
  assert.deepEqual(fields.filter((field) => !passed.has(field)), [], 'campo do spawn que a missão deixa cair')
  assert.match(jsx, /showHeader=\{false\}/u)
  // o chat é PAPEL, dentro do limite isolado, e nunca desmonta: fragmento com chave
  assert.match(mission, /<GuiPanelErrorBoundary paneId=\{s\.spawn\.paneId\}[\s\S]*<GuiPane/u)
  assert.match(mission, /<Fragment key="mission-gui-slots">/u)
  assert.match(mission, /<Fragment key="terminal-slots">/u)
})

test('a leitura só lê: GuiPane congelado, nada de spec, create ou kill; remover pede confirmação na linha', () => {
  const reading = read('src/renderer/src/components/SoloProjectReading.tsx')
  const code = withoutComments(reading)
  assert.match(code, /useFrozenMissionChats\(mission\.id\)/u)
  assert.match(code, /<GuiPane\s+readOnly/u)
  assert.match(code, /active=\{false\}/u)
  assert.doesNotMatch(code, /guiSpec|dropGuiPane|guiApi\.(create|send|kill)|useMissionChatSlots/u)
  assert.doesNotMatch(code, /window\.(confirm|alert)/u)
  assert.match(code, /Remover do histórico\? A pasta não muda\./u)
  assert.match(code, /'Escape'/u)
  // a sonda continua morando no leitor de sempre (o modal dos versionados)
  const archived = read('src/renderer/src/components/ArchivedMissionChat.tsx')
  assert.match(archived, /export function useFrozenMissionChats/u)
  assert.match(archived, /guiApi\.state\(/u)
})

test('nenhuma superfície de git no modo: sem trilho, fila, commits, revisão ou poll do worktree', () => {
  const files = ['SoloProject', 'SoloProjectStart', 'SoloProjectMission', 'SoloProjectReading', 'SoloProjectFinish', 'SoloProjectPanels']
    .map((name) => [name, withoutComments(read(`src/renderer/src/components/${name}.tsx`))])
  for (const [name, code] of files) {
    assert.doesNotMatch(
      code,
      /MissionDeliveryRail|MissionColumn|MissionHeaderActions|ReleaseHeaderActions|ReleaseRail|ProjectDashboard|NewMissionModal|BacklogView|UniverseMapView|MissionCommitHistory/u,
      `${name} monta uma superfície do versionado`
    )
    assert.doesNotMatch(
      code,
      /missionWorkspace|missionHistory|integrateMission|backlog\.|plansApi|workspaceFiles|commitDiff|REVIEW_NUDGE|nudgeReview/u,
      `${name} chama um canal de git`
    )
    assert.doesNotMatch(code, /window\.(confirm|alert)\(/u, `${name} usa diálogo nativo`)
  }
  const mission = files.find(([name]) => name === 'SoloProjectMission')[1]
  assert.match(mission, /availableWorkspacePanels\('dev', live, 'none'\)/u, 'o cardápio de painéis é o do modo')
  const finish = read('src/renderer/src/components/SoloProjectFinish.tsx')
  assert.match(finish, /createPortal\(/u, 'a confirmação vai por portal')
})

test('a tela do modo hospeda os slots de chat e mantém a Missão montada fora da aba', () => {
  const screen = withoutComments(read('src/renderer/src/components/SoloProject.tsx'))
  assert.match(screen, /useMissionChatSlots\(\{/u)
  assert.match(screen, /soloProjectView\(missions, projectId, readingId\)/u)
  assert.match(screen, /workspace-keepalive/u)
  assert.match(screen, /inert=\{tab === 'missao' \? undefined : true\}/u)
  assert.match(screen, /<UnversionedFolderSeal size="header" \/>/u)
  assert.match(screen, /<UnversionedModeTag/u)
  assert.match(screen, /paneId=\{`view:\$\{projectId\}:arquivos`\}[\s\S]*<FilesView/u)
  // o Board usa o MESMO hook: um caminho só para abrir a conversa
  const board = read('src/renderer/src/components/Board.tsx')
  assert.match(board, /useMissionChatSlots\(\{/u)
  assert.doesNotMatch(board, /missionGui\s*\.spec\(|missionGui\.setChatSeat\(/u, 'o Board não abre conversa por fora do hook')
})

// Reprovado pelo dono (2026-09-30): o contorno do destino do SynVoice virava
// um retângulo laranja colado no texto do título, e o filete da recém-
// finalizada encostava na data. A folha mostra o foco pela borda; o filete
// mora no respiro à esquerda da coluna.
test('a folha de Início mostra o foco pela borda e o filete não encosta no texto', () => {
  const start = read('src/renderer/src/components/SoloProjectStart.tsx')
  assert.match(start, /className="ss-title synvoice-quiet"/u)
  assert.match(start, /className="ss-goal synvoice-quiet"/u)
  const global = read('src/renderer/src/global.css')
  assert.match(global, /input\.synvoice-target:not\(\[type='password'\]\):not\(\.gui-input\):not\(\.synvoice-quiet\)/u)
  assert.match(global, /textarea\.synvoice-target:not\(\.gui-input\):not\(\.synvoice-quiet\)/u)

  const css = read('src/renderer/src/components/SoloProject.css')
  assert.match(css, /\.ss-sheet:focus-within\s*\{[^}]*border-color/su, 'o foco aparece na borda da folha')
  const edge = css.match(/\.log-list li\.just::before\s*\{[^}]*\}/su)?.[0] ?? ''
  assert.match(edge, /left:\s*-\d+px/u, 'o filete fica fora da coluna de texto')
  assert.doesNotMatch(css, /\.log-row\s*\{[^}]*box-shadow/su)
  assert.doesNotMatch(css, /li\.just \.log-row\s*\{[^}]*box-shadow/su, 'nada de filete dentro da linha')
})
