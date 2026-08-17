import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// A PRIMEIRA VERSÃO DO PROJETO — a régua do dono (2026-08-17) e as duas telas
// que a obedecem.
//
// A ordem, nas palavras dele: o campo LIVRE (digitável) só existe enquanto o
// projeto tem ZERO versões — é o produto que CHEGA numerado ("posso colocar um
// projeto que já esteja na 1.20"). Criada a primeira, o campo some para sempre
// e sobram as sugestões calculadas da mais alta.
//
// O que esta suíte prende:
//   (1) a RÉGUA, que é uma só — duas cópias divergiriam, e a do modal nasceria
//       com um trio fixo que o main recusa em projeto que já lançou;
//   (2) o CONTRATO DE FONTE do modal de missão nova: no projeto virgem ele
//       OFERECE o picker e cria a versão escolhida ANTES da missão. Antes
//       disso o motor semeava "V1.0" sozinho (`ensureDefaultVersion`) e
//       roubava a janela do campo livre — o dono nunca via a pergunta.
//
// Módulo puro por import DINÂMICO: num código sem ele o arquivo ainda roda e
// cada contrato de fonte reprova por conta própria.

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

/** O CÓDIGO sem comentários: uma proibição se mede no que RENDERIZA, e o
 *  comentário que explica a regra não pode reprovar o arquivo que a obedece. */
const withoutComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1')

const rule = () => import('../src/renderer/src/versionChoice.ts')

const version = (name, status = 'aberta') => ({ name, status })

/** o corpo da função `submit` do modal — a ordem das escritas se mede aqui,
 *  não no arquivo inteiro (que também fala de versão no formulário) */
function submitBody(src) {
  const start = src.indexOf('async function submit(')
  assert.notEqual(start, -1, 'a função submit sumiu do NewMissionModal')
  const end = src.indexOf('\n  }', start)
  assert.notEqual(end, -1, 'o fim da função submit não foi encontrado')
  return src.slice(start, end)
}

/* ---------- 1. a régua: quem pode escrever o próprio número ---------- */

test('projeto VIRGEM: primeira oferta + o número próprio liberado', async () => {
  const { versionSuggestions, allowsOwnVersionNumber } = await rule()

  // Nem todo produto nasce 1.0 (decisão de 2026-08-06): alfa/beta começam no
  // 0.x e o semver segue dali. V1.0 vem PRIMEIRO — é a pré-seleção do modal.
  assert.deepEqual(
    versionSuggestions([]).map((option) => option.label),
    ['V1.0', 'V0.1.0', 'V0.0.1']
  )
  assert.ok(versionSuggestions([]).every((option) => option.kind.length > 0))
  assert.equal(allowsOwnVersionNumber([]), true)
})

test('criada a primeira versão, o número próprio SOME — lançada conta igual', async () => {
  const { allowsOwnVersionNumber } = await rule()

  // "ZERO versões" é literal: aberta e lançada existem do mesmo jeito. Uma
  // contagem só de abertas devolveria o campo livre ao projeto que já lançou
  // tudo o que tinha, e o número dele já é conhecido.
  assert.equal(allowsOwnVersionNumber([version('V1.0')]), false)
  assert.equal(allowsOwnVersionNumber([version('V1.20', 'lancada')]), false)
})

test('daí em diante as sugestões saem da MAIS ALTA e nunca repetem uma existente', async () => {
  const { versionSuggestions } = await rule()

  // O caso do dono: projeto que chegou na 1.20 e teve o número escrito à mão.
  assert.deepEqual(
    versionSuggestions([version('V1.20'), version('V1.3', 'lancada')]).map((o) => o.label),
    ['V1.20.1', 'V1.21', 'V2.0']
  )
  // prefixo do produto preservado (com "v" e sem "v" são grafias diferentes)
  assert.deepEqual(
    versionSuggestions([version('2.4.1')]).map((o) => o.label),
    ['2.4.2', '2.5', '3.0']
  )
  // nome sem padrão numérico ("MVP") não ordena — e não impede as sugestões
  assert.deepEqual(
    versionSuggestions([version('MVP'), version('V1.0')]).map((o) => o.label),
    ['V1.0.1', 'V1.1', 'V2.0']
  )
  // …e um projeto SÓ com nome de código continua tendo por onde sair: sem
  // número nenhum não há de onde contar, então volta a primeira oferta.
  assert.deepEqual(
    versionSuggestions([version('MVP')]).map((o) => o.label),
    ['V1.0', 'V0.1.0', 'V0.0.1']
  )

  // sugestão nenhuma repete um nome que já existe — o main recusaria o clique
  for (const list of [
    [version('V1.0')],
    [version('V1.2'), version('V1.3')],
    [version('v2'), version('v2.0.1', 'lancada')]
  ]) {
    const existing = new Set(list.map((v) => v.name.toLowerCase()))
    for (const option of versionSuggestions(list))
      assert.ok(!existing.has(option.label.toLowerCase()), `${option.label} já existe na lista`)
  }
})

/* ---------- 2. a lateral e o modal consomem a MESMA régua ---------- */

test('a régua não foi copiada: as duas telas importam o módulo', async () => {
  const [view, modal] = await Promise.all([
    source('src/renderer/src/components/BacklogView.tsx'),
    source('src/renderer/src/components/NewMissionModal.tsx')
  ])

  for (const [name, src] of [
    ['BacklogView', view],
    ['NewMissionModal', modal]
  ]) {
    assert.match(
      src,
      /import \{[^}]*versionSuggestions[^}]*\} from '\.\.\/versionChoice'/u,
      `${name} precisa consumir a régua compartilhada`
    )
  }

  // e a cópia local morreu junto (era ela que o modal iria duplicar)
  assert.doesNotMatch(view, /^function parseVer\(/mu)
  assert.doesNotMatch(view, /^function cmpVer\(/mu)
})

/* ---------- 3. o modal OFERECE a primeira versão em vez de deixar semear --- */

test('o picker de primeira versão só nasce com a lista de elegíveis VAZIA', async () => {
  const modal = withoutComments(await source('src/renderer/src/components/NewMissionModal.tsx'))

  // A condição inteira, e cada perna dela importa: planejamento não pertence a
  // versão nenhuma, versão travada (aba Versões) já existe, e perguntar antes
  // de as duas leituras pousarem ofereceria o trio a um projeto que tem versão.
  const gate = modal.match(/const needsFirstVersion =[\s\S]*?\r?\n\r?\n/u)
  assert.ok(gate, 'o gate `needsFirstVersion` sumiu do modal')
  assert.match(gate[0], /!lockVersion/u)
  assert.match(gate[0], /!planning/u)
  assert.match(gate[0], /eligibleVersions\.length === 0/u)
  assert.match(gate[0], /!versionDataLoading/u)
  assert.match(gate[0], /!versionChoicesError/u)
  // e "as duas leituras pousaram" é literal: a lista completa é quem sabe se o
  // projeto é virgem, e as elegíveis são quem sabe se há destino
  assert.match(modal, /const versionDataLoading = versionChoicesLoading \|\| versionsLoading/u)

  // o seletor de destino e o picker são EXCLUDENTES: os dois juntos diriam ao
  // dono que a versão já existe e que ele precisa escolhê-la, ao mesmo tempo
  assert.match(modal, /\{!lockVersion && !needsFirstVersion && \(/u)
  assert.match(modal, /\{needsFirstVersion && \(/u)
})

test('o campo livre do modal obedece à mesma régua da lateral', async () => {
  const modal = withoutComments(await source('src/renderer/src/components/NewMissionModal.tsx'))

  assert.match(modal, /const ownNumberAllowed = allowsOwnVersionNumber\(versions\)/u)
  assert.match(modal, /\{ownNumberAllowed && \(/u)
  // as sugestões FICAM nos dois casos — o que some é o campo
  assert.match(modal, /firstVersionOptions\.map/u)
  // V1.0 pré-selecionada: a primeira sugestão entra sozinha no estado
  assert.match(modal, /firstVersionOptions\[0\]\?\.label/u)
})

test('a versão nasce ANTES da missão, e a recusa do main BLOQUEIA a criação', async () => {
  const body = submitBody(withoutComments(await source('src/renderer/src/components/NewMissionModal.tsx')))

  const createVersionAt = body.indexOf('backlog.createVersion(')
  const createMissionAt = body.indexOf('createMission(')
  assert.notEqual(createVersionAt, -1, 'o modal precisa criar a versão escolhida')
  assert.notEqual(createMissionAt, -1, 'o modal continua criando a missão')
  assert.ok(
    createVersionAt < createMissionAt,
    'a versão é escrita ANTES da missão — missão sem destino é o que se evita'
  )

  // recusa do main (nome vazio, duplicado, abaixo da lançada) sai pelo mesmo
  // aviso do modal e ENCERRA o gesto: nada de missão órfã de versão.
  assert.match(
    body,
    /if \(!createdVersion\.ok\) \{[\s\S]{0,200}?setSubmitError\(createdVersion\.error\)[\s\S]{0,80}?return/u
  )
  // e a versão escolhida viaja EXPLÍCITA — o fallback do motor não decide nada
  assert.match(body, /versionId: planning \? undefined : chosenVersionId \|\| undefined/u)
})

test('uma escrita de versão por gesto — o segundo clique não cria a segunda', async () => {
  const modal = withoutComments(await source('src/renderer/src/components/NewMissionModal.tsx'))
  const body = submitBody(modal)

  // `createVersion` persiste. Sem trava, o duplo clique no botão criava DUAS
  // versões (a segunda recusada por nome duplicado, com a missão já perdida no
  // meio do caminho).
  assert.match(body, /if \(submitting\) return/u)
  assert.match(body, /setSubmitting\(true\)/u)
  assert.match(modal, /disabled=\{[^}]*submitting[^}]*\}/u)
  // e o botão volta a aceitar clique quando o gesto falha
  assert.match(body, /setSubmitting\(false\)/u)
})

test('a promessa de semeadura silenciosa saiu da tela', async () => {
  const modal = await source('src/renderer/src/components/NewMissionModal.tsx')
  // o arquivo mistura acento literal e escape `\u00XX` — a busca precisa ler
  // as duas grafias, senão a frase escapada atravessaria o teste
  const copy = modal.replace(/\\u([0-9a-fA-F]{4})/gu, (_, code) =>
    String.fromCharCode(parseInt(code, 16))
  )

  // O texto antigo descrevia exatamente o que o dono mandou parar: "ao criar, o
  // Synkora abrirá a próxima versão automaticamente".
  assert.doesNotMatch(copy, /próxima será criada/u)
  assert.doesNotMatch(copy, /abrirá a próxima versão automaticamente/u)
  assert.doesNotMatch(copy, /o Synkora abre a próxima versão/u)
})

/* ---------- 4. o arranjo do picker dentro do modal ---------- */

test('o picker herda a roupa do modal sem herdar a caixa alta do rótulo', async () => {
  const css = await source('src/renderer/src/global.css')

  // O bloco mora dentro de `.mission-version-choice`, que é CAIXA ALTA — o
  // rótulo pede isso, o número digitado e o exemplo dentro dele não.
  const input = css.match(/\n\.mission-first-version-input\s*\{([^}]*)\}/u)
  assert.ok(input, 'o campo do número próprio do modal não tem regra')
  assert.match(input[1], /text-transform:\s*none/u)
  assert.match(input[1], /font-family:\s*var\(--mono\)/u)

  // o exemplo dentro do campo é TEXTO que se lê: o cinza do navegador mede
  // 3,5:1 no papel, e o piso do placeholder é o mesmo do corpo
  const placeholder = css.match(/\n\.mission-first-version-input::placeholder\s*\{([^}]*)\}/u)
  assert.ok(placeholder, 'o exemplo do campo ficou no cinza do navegador')
  assert.match(placeholder[1], /color:\s*var\(--ink-2\)/u)

  // as sugestões quebram linha em vez de estourar a largura do modal
  const opts = css.match(/\n\.mission-first-version-opts\s*\{([^}]*)\}/u)
  assert.ok(opts, 'a fileira de sugestões do modal não tem regra')
  assert.match(opts[1], /flex-wrap:\s*wrap/u)
})
