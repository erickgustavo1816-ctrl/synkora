// A ENTREGA VISUAL APARECE NO CHAT (R36 — 2026-08-23) — a metade do RENDERER.
//
// Caso do dono (print do pane codex): o dev prometeu "demonstração visual", o
// dono perguntou "cadê?" e o modelo jurou que a imagem estava "exibida
// diretamente acima". Nada apareceu. O `![demo](caminho.png)` ATRAVESSA o
// sanitizador do chat (`img` está em GUI_MARKDOWN_TAGS, `src` em
// GUI_MARKDOWN_ATTRS) e vira um `<img>` de verdade — mas o CSP do renderer é
// `img-src 'self' data:` e um caminho de worktree não é nem 'self' nem data:.
// A requisição morre MUDA: sem borda de erro, sem console visível para o
// agente, sem nada. O modelo então ALUCINA a capacidade.
//
// A regra da casa manda que beco sem saída seja bug: ou a imagem aparece, ou a
// recusa NOMEIA o caminho e a receita. Este módulo é o primeiro passo — trocar
// a requisição condenada por um PLACEHOLDER estável, que o efeito de hidratação
// do GuiMarkdown resolve pelo canal cercado do main (`gui:fileImageData`, que
// lê os bytes dentro do cwd do pane e devolve data URL).
//
// FRONTEIRA DE SEGURANÇA (não relaxar): esta transformação roda DEPOIS do
// DOMPurify e só SUBTRAI ou renomeia atributo. Nada que o agente escreveu vira
// markup novo: o `src` dele sai do lugar onde o browser buscaria e passa a ser
// DADO (`data-gui-image`), devidamente escapado como valor de atributo. Quem
// decide se aquele arquivo pode virar pixel é o main, com a MESMA cerca do
// `fileOpen`. Nenhuma tag, atributo ou esquema novo passa a renderizar por
// causa daqui.
//
// POR QUE UM SCANNER DE STRING E NÃO UM `<template>` (o `routeChatLinksExternally`
// e o `linkifyGuiFileReferences`, vizinhos deste seam, usam template):
//   1. DETERMINISMO BYTE A BYTE. O patch de prefixo estável da R35 compara os
//      filhos de topo por `outerHTML`; qualquer bamboleio de serialização em
//      partes NÃO tocadas da mensagem faria o prefixo divergir e o chat
//      remontaria nós que a seleção do dono está segurando. Aqui, o único byte
//      que muda é o das tags `<img>` reescritas — o resto sai idêntico à
//      entrada, por construção.
//   2. A PROVA. A decisão precisa de teste em node puro (o `test:gui-chat-ui`
//      importa .ts direto, sem DOM). Um template obrigaria jsdom só para provar
//      uma reescrita de string.
// O preço é escrever um scanner de tags ciente de aspas — e ele existe porque
// um `alt` pode conter `>` e até `<img …>` literal (o serializador de HTML NÃO
// escapa `<`/`>` dentro de valor de atributo). Regex ingênua sobre `<img[^>]*>`
// se perderia exatamente nesse caso.

/** Classe da moldura da casa; a hidratação e o CSS leem esta constante. */
export const GUI_INLINE_IMAGE_CLASS = 'gui-md-image'

/** Onde a referência do agente descansa enquanto o main não a resolve. */
export const GUI_INLINE_IMAGE_ATTR = 'data-gui-image'

/** O invólucro do gesto. A imagem do fio ABRE COISA (o menu "onde abrir"), e no
 *  padrão da casa quem abre coisa é `<button>` de verdade — como o token de
 *  arquivo (`gui-file-link`), que também nasce depois da sanitização. Assim
 *  Enter e espaço ativam NATIVAMENTE: nenhum `preventDefault` no GuiMarkdown
 *  (a guarda antiga do arquivo proíbe, para o clique de link jamais ser
 *  sequestrado) e nenhuma mentira de ARIA (role=button que não responde ao
 *  teclado). */
export const GUI_INLINE_IMAGE_OPEN_CLASS = 'gui-md-image-open'

/** A referência repetida no invólucro: é ele quem recebe o gesto. */
export const GUI_INLINE_IMAGE_OPEN_ATTR = 'data-gui-image-open'

/** Estado visível no DOM (só depois da hidratação): `ready`. Enquanto ausente,
 *  o placeholder ainda não virou pixel. */
export const GUI_INLINE_IMAGE_STATE_ATTR = 'data-gui-image-state'

/** Classe da linha de recusa que substitui o placeholder impossível. */
export const GUI_INLINE_IMAGE_FAIL_CLASS = 'gui-md-image-fail'

/** Atributos que a REESCRITA controla — se vierem do agente, são descartados
 *  antes de escrevermos os nossos (atributo duplicado é o primeiro que vale no
 *  parser de HTML, então deixar os dois seria ambiguidade sem ganho). */
const RESERVED_IMAGE_ATTRS = new Set([
  'class',
  'src',
  'role',
  'tabindex',
  'title',
  GUI_INLINE_IMAGE_ATTR,
  GUI_INLINE_IMAGE_STATE_ATTR
])

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: '\u00a0',
  quot: '"'
}

function isHtmlSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f'
}

function decodedCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return null
  if (code >= 0xd800 && code <= 0xdfff) return null
  return String.fromCodePoint(code)
}

/** Decodificação suficiente para LER um valor de atributo já serializado.
 *  Não é um decodificador de HTML completo (nem precisa ser: o valor veio do
 *  serializador, que escapa `&` e `"` e mais nada) — entidade desconhecida
 *  fica como está, verbatim. */
export function decodeGuiAttributeValue(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/gu, (whole, body: string) => {
    const lower = body.toLowerCase()
    if (lower.startsWith('#x')) return decodedCodePoint(Number.parseInt(body.slice(2), 16)) ?? whole
    if (lower.startsWith('#')) return decodedCodePoint(Number.parseInt(body.slice(1), 10)) ?? whole
    return NAMED_ENTITIES[lower] ?? whole
  })
}

/** Escapa para valor de atributo entre aspas duplas. `<`/`>` também saem
 *  escapados — não é exigência do parser, é higiene: o valor vem do agente e
 *  atravessa uma string de HTML. */
export function escapeGuiAttributeValue(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/** O que o browser JÁ consegue pintar sob o CSP do renderer (`data:`) ou o que
 *  simplesmente não é arquivo do worktree e portanto não é assunto do canal do
 *  main (`https:`). Os dois passam INTOCADOS.
 *
 *  LIMITE CONHECIDO E HERDADO: o CSP atual também não deixa `https:` pintar —
 *  mas isso é exatamente o que já acontecia antes desta rodada, e mandar uma
 *  URL remota para um canal que resolve ARQUIVO dentro do cwd do pane só
 *  produziria uma recusa confusa. Fica como está, de propósito. */
export function isGuiInlineImagePassthrough(src: string): boolean {
  const value = src.trim()
  return /^data:/iu.test(value) || /^https:\/\//iu.test(value)
}

interface ParsedAttribute {
  /** minúsculo, para decidir */
  name: string
  /** a fatia EXATA da entrada (`alt="a &amp; b"`) — reemitida byte a byte */
  source: string
  /** o valor ainda escapado, como estava na entrada */
  value: string
}

interface ParsedTag {
  name: string
  closing: boolean
  attrs: ParsedAttribute[]
  /** índice logo depois do `>` */
  end: number
}

/** Lê UMA tag a partir do `<` em `start`, respeitando aspas nos valores.
 *  `null` = não é tag bem formada (a entrada continua sendo copiada verbatim,
 *  nunca reinterpretada). */
function readTag(html: string, start: number): ParsedTag | null {
  let index = start + 1
  const closing = html[index] === '/'
  if (closing) index += 1
  const nameStart = index
  while (
    index < html.length &&
    !isHtmlSpace(html[index]) &&
    html[index] !== '>' &&
    html[index] !== '/'
  ) {
    index += 1
  }
  const name = html.slice(nameStart, index).toLowerCase()
  if (!name || !/^[a-z]/u.test(name)) return null

  const attrs: ParsedAttribute[] = []
  while (index < html.length) {
    while (index < html.length && isHtmlSpace(html[index])) index += 1
    const ch = html[index]
    if (ch === undefined) return null
    if (ch === '>') return { name, closing, attrs, end: index + 1 }
    if (ch === '/') {
      if (html[index + 1] === '>') return { name, closing, attrs, end: index + 2 }
      index += 1
      continue
    }

    const attrStart = index
    while (
      index < html.length &&
      !isHtmlSpace(html[index]) &&
      html[index] !== '=' &&
      html[index] !== '>'
    ) {
      index += 1
    }
    const attrName = html.slice(attrStart, index).toLowerCase()
    let cursor = index
    while (cursor < html.length && isHtmlSpace(html[cursor])) cursor += 1
    if (html[cursor] !== '=') {
      // Atributo sem valor (`disabled`). Sem nome E sem `=` seria entrada
      // torta: paramos e a fatia inteira volta como texto.
      if (!attrName) return null
      attrs.push({ name: attrName, source: html.slice(attrStart, index), value: '' })
      continue
    }

    cursor += 1
    while (cursor < html.length && isHtmlSpace(html[cursor])) cursor += 1
    const quote = html[cursor]
    let value: string
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, cursor + 1)
      if (close < 0) return null
      value = html.slice(cursor + 1, close)
      index = close + 1
    } else {
      const valueStart = cursor
      while (cursor < html.length && !isHtmlSpace(html[cursor]) && html[cursor] !== '>') cursor += 1
      value = html.slice(valueStart, cursor)
      index = cursor
    }
    if (!attrName) continue
    attrs.push({ name: attrName, source: html.slice(attrStart, index), value })
  }
  return null
}

/** Fim de um `<!-- … -->` / `<!doctype …>`; sem fechamento, o resto da string. */
function markupDeclarationEnd(html: string, start: number): number {
  if (html.startsWith('<!--', start)) {
    const close = html.indexOf('-->', start + 4)
    return close < 0 ? html.length : close + 3
  }
  const close = html.indexOf('>', start)
  return close < 0 ? html.length : close + 1
}

function renderImgTag(attributes: readonly string[]): string {
  return attributes.length ? `<img ${attributes.join(' ')}>` : '<img>'
}

/** A reescrita de UMA tag `<img>`. Devolve a fatia original quando não há nada
 *  a fazer — é o que mantém intocado tudo o que não é imagem local. */
function rewriteImgTag(source: string, tag: ParsedTag): string {
  const src = tag.attrs.find((attr) => attr.name === 'src')
  if (!src) return source

  const reference = decodeGuiAttributeValue(src.value).trim()
  const kept = tag.attrs.filter((attr) => !RESERVED_IMAGE_ATTRS.has(attr.name))

  // `src=""` não tem referência para hidratar E resolveria para a própria
  // página: some o atributo, some a requisição, e o resto da tag fica de pé.
  if (!reference) return renderImgTag(kept.map((attr) => attr.source))

  if (isGuiInlineImagePassthrough(reference)) return source

  const escaped = escapeGuiAttributeValue(reference)
  const image = renderImgTag([
    `class="${GUI_INLINE_IMAGE_CLASS}"`,
    `${GUI_INLINE_IMAGE_ATTR}="${escaped}"`,
    ...kept.map((attr) => attr.source)
  ])
  // O invólucro é botão de verdade: o teclado ativa sozinho e o clique cai na
  // MESMA delegação do wrapper que já serve os tokens do fio.
  return (
    `<button type="button" class="${GUI_INLINE_IMAGE_OPEN_CLASS}" ` +
    `${GUI_INLINE_IMAGE_OPEN_ATTR}="${escaped}" ` +
    `title="${escaped} · onde abrir" aria-haspopup="menu">${image}</button>`
  )
}

/**
 * A TRANSFORMAÇÃO (R36.2). Entra o html já sanitizado, sai o html com todo
 * `<img>` de caminho local virado placeholder sem `src`.
 *
 * DETERMINÍSTICA por contrato: mesma entrada ⇒ saída byte a byte igual, e os
 * bytes que não pertencem a uma tag `<img>` reescrita saem exatamente como
 * entraram. É essa propriedade que deixa o patch de prefixo estável da R35
 * enxergar os blocos já escritos como IDÊNTICOS durante o streaming.
 */
export function rewriteGuiInlineImages(html: string): string {
  if (!html || !/<img/iu.test(html)) return html

  let out = ''
  let index = 0
  while (index < html.length) {
    const lt = html.indexOf('<', index)
    if (lt < 0) {
      out += html.slice(index)
      break
    }
    out += html.slice(index, lt)

    const next = html[lt + 1]
    if (next === '!') {
      const end = markupDeclarationEnd(html, lt)
      out += html.slice(lt, end)
      index = end
      continue
    }

    const tag = next !== undefined && (next === '/' || /[A-Za-z]/u.test(next))
      ? readTag(html, lt)
      : null
    if (!tag) {
      // `<` solto no meio do texto (ou tag truncada pelo streaming): copia o
      // caractere e segue. Nada é reinterpretado.
      out += '<'
      index = lt + 1
      continue
    }

    const source = html.slice(lt, tag.end)
    out += tag.name === 'img' && !tag.closing ? rewriteImgTag(source, tag) : source
    index = tag.end
  }
  return out
}

// ————— a hidratação (a metade com DOM, aplicada pelo GuiMarkdown) —————

/** O que o cache do componente sabe sobre uma referência. */
export type GuiInlineImageState =
  | { status: 'ready'; dataUrl: string }
  | { status: 'refused'; error: string }

/** Recusa que NOMEIA o caminho e o erro — e deixa o caminho CLICÁVEL: o botão
 *  é o mesmo `gui-file-link` dos tokens do fio, então a delegação que já vive
 *  no wrapper do GuiMarkdown dá clique (ler aqui) e botão direito (onde abrir)
 *  de graça. Beco sem saída é bug. */
export function buildGuiInlineImageFailure(
  doc: Document,
  reference: string,
  error: string
): HTMLElement {
  const line = doc.createElement('span')
  line.className = GUI_INLINE_IMAGE_FAIL_CLASS
  line.append('não deu para mostrar ')

  const token = doc.createElement('button')
  token.type = 'button'
  token.className = 'gui-file-link'
  token.dataset.guiFileToken = reference
  token.title = `Abrir ${reference} no Synkora · botão direito: onde abrir`
  token.setAttribute('aria-label', `Abrir arquivo ${reference}`)
  token.setAttribute('aria-haspopup', 'menu')
  token.textContent = reference
  line.append(token)

  line.append(` — ${error}`)
  return line
}

/**
 * Aplica no container o que o cache JÁ sabe e devolve as referências que ainda
 * precisam de uma volta ao main (sem repetição, na ordem em que aparecem).
 *
 * Roda no MESMO efeito de layout do patch da R35, logo depois dele: assim uma
 * imagem já resolvida reaparece pintada no mesmo quadro em que o patch a
 * remontou — sem piscar.
 */
export function hydrateGuiInlineImages(
  container: HTMLElement,
  cache: ReadonlyMap<string, GuiInlineImageState>
): string[] {
  const pending: string[] = []
  const seen = new Set<string>()
  const doc = container.ownerDocument

  for (const node of Array.from(container.querySelectorAll(`img[${GUI_INLINE_IMAGE_ATTR}]`))) {
    const reference = node.getAttribute(GUI_INLINE_IMAGE_ATTR)
    if (!reference) continue
    const state = cache.get(reference)
    if (!state) {
      if (!seen.has(reference)) {
        seen.add(reference)
        pending.push(reference)
      }
      continue
    }
    if (state.status === 'ready') {
      // O data URL nasce no main (bytes lidos dentro do cwd do pane, mime tirado
      // dos BYTES). Aqui ele só chega ao atributo que o CSP aceita.
      if (node.getAttribute('src') !== state.dataUrl) node.setAttribute('src', state.dataUrl)
      node.setAttribute(GUI_INLINE_IMAGE_STATE_ATTR, 'ready')
      continue
    }
    // Recusa: some o gesto INTEIRO (o invólucro junto), senão sobraria um botão
    // vazio prometendo uma imagem que não existe.
    const frame = node.closest(`button[${GUI_INLINE_IMAGE_OPEN_ATTR}]`)
    const doomed = frame ?? node
    doomed.replaceWith(buildGuiInlineImageFailure(doc, reference, state.error))
  }

  return pending
}
