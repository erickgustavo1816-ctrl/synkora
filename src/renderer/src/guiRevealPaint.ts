// O PINTOR DA CAUDA (a metade DOM da escrita do chat — guiStreamReveal.ts é a
// régua pura). Roda DEPOIS do patch de prefixo estável do markdown (R35) e só
// toca o ÚLTIMO bloco de topo, que é o único volátil durante o streaming:
//   - envolve as últimas palavras reveladas em <span class="gui-word-in"> com
//     `animation-delay` NEGATIVO igual à idade do passo — o fade continua do
//     valor atual em vez de recomeçar a cada repintura (apple-design: animar do
//     valor apresentado, nunca do alvo);
//   - pendura o caret (<span class="gui-caret">) no fim do texto do bloco.
// O prefixo (todos os blocos anteriores) fica INTOCADO: é isso que preserva a
// seleção do dono e evita que o patch remonte o que já estava escrito.
//
// Sem sanitização nova: nada aqui interpreta HTML — só divide nós de TEXTO que
// o pipeline já pintou e os embrulha em spans vazios de atributos além do
// estilo de idade.

import type { GuiRevealStep } from './guiStreamReveal'
import { guiRevealFadePlan } from './guiStreamReveal'

const TEXT_NODE = 3
const ELEMENT_NODE = 1
export const GUI_WORD_IN_CLASS = 'gui-word-in'
export const GUI_CARET_CLASS = 'gui-caret'

/** Blocos que não recebem caret nem fade (o texto deles é código/verbatim). */
const VERBATIM_TAGS = new Set(['PRE', 'CODE', 'TABLE'])

function lastTopBlock(container: HTMLElement): Element | null {
  for (let index = container.childNodes.length - 1; index >= 0; index -= 1) {
    const node = container.childNodes[index]
    if (node.nodeType === ELEMENT_NODE) return node as Element
  }
  return null
}

/** Desfaz os spans de um bloco (os nós de texto voltam a ser contínuos). */
function unwrapPaint(block: Element): void {
  for (const caret of Array.from(block.querySelectorAll(`.${GUI_CARET_CLASS}`))) caret.remove()
  for (const span of Array.from(block.querySelectorAll(`.${GUI_WORD_IN_CLASS}`))) {
    const parent = span.parentNode
    if (!parent) continue
    while (span.firstChild) parent.insertBefore(span.firstChild, span)
    span.remove()
  }
  block.normalize()
}

function textNodesOf(root: Node, out: Text[]): void {
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === TEXT_NODE) out.push(child as Text)
    else if (child.nodeType === ELEMENT_NODE && !VERBATIM_TAGS.has((child as Element).tagName)) textNodesOf(child, out)
  }
}

/** As palavras de um nó de texto como intervalos [início, fim), da esquerda. */
function wordRanges(value: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  const re = /\S+/gu
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) ranges.push({ start: match.index, end: match.index + match[0].length })
  return ranges
}

/**
 * PINTA A CAUDA. `history` são os passos recentes do escritor (palavras + quando);
 * `caret` diz se o texto ainda está sendo revelado. Idempotente: cada chamada
 * desfaz a pintura anterior do bloco antes de refazer.
 */
export function paintGuiRevealTail(
  container: HTMLElement,
  history: readonly GuiRevealStep[],
  options: { caret: boolean; fade: boolean; now?: number }
): void {
  const block = lastTopBlock(container)
  if (!block) return
  unwrapPaint(block)
  if (VERBATIM_TAGS.has(block.tagName)) return

  const doc = container.ownerDocument
  if (options.fade) {
    const plan = guiRevealFadePlan(history, options.now ?? performance.now())
    // Do passo mais NOVO para o mais velho: as últimas N palavras do bloco são
    // do passo mais recente, as N anteriores do passo anterior, e assim por
    // diante — contamos palavras do fim para o começo.
    const steps = plan.slice().reverse()
    const nodes: Text[] = []
    textNodesOf(block, nodes)
    let stepIndex = 0
    let remaining = steps[0]?.words ?? 0
    for (let n = nodes.length - 1; n >= 0 && stepIndex < steps.length; n -= 1) {
      const node = nodes[n]
      const value = node.nodeValue ?? ''
      const ranges = wordRanges(value)
      // As palavras deste nó, da direita para a esquerda, com o passo de cada uma.
      const assigned: { start: number; end: number; ageMs: number }[] = []
      for (let r = ranges.length - 1; r >= 0 && stepIndex < steps.length; r -= 1) {
        assigned.push({ ...ranges[r], ageMs: steps[stepIndex].ageMs })
        remaining -= 1
        if (remaining <= 0) {
          stepIndex += 1
          remaining = steps[stepIndex]?.words ?? 0
        }
      }
      if (assigned.length === 0) continue
      // Reconstrói o nó: [texto antes][span palavra][texto entre]… da esquerda.
      assigned.reverse()
      const fragment = doc.createDocumentFragment()
      let cursor = 0
      for (const word of assigned) {
        if (word.start > cursor) fragment.appendChild(doc.createTextNode(value.slice(cursor, word.start)))
        const span = doc.createElement('span')
        span.className = GUI_WORD_IN_CLASS
        span.style.animationDelay = `-${Math.round(word.ageMs)}ms`
        span.textContent = value.slice(word.start, word.end)
        fragment.appendChild(span)
        cursor = word.end
      }
      if (cursor < value.length) fragment.appendChild(doc.createTextNode(value.slice(cursor)))
      node.replaceWith(fragment)
    }
  }

  if (options.caret) {
    const caret = doc.createElement('span')
    caret.className = GUI_CARET_CLASS
    caret.setAttribute('aria-hidden', 'true')
    // No fim do último elemento inline aberto (um <strong> que ainda fecha) ou
    // do próprio bloco: o caret acompanha a última palavra, não a linha de baixo.
    let host: Element = block
    while (host.lastElementChild && !VERBATIM_TAGS.has(host.lastElementChild.tagName) &&
      host.lastChild === host.lastElementChild && host.lastElementChild.tagName !== 'BR' &&
      host.lastElementChild.tagName !== 'IMG') {
      host = host.lastElementChild
    }
    host.appendChild(caret)
  }
}

/** Limpa a pintura (fim da revelação ou desmontagem). */
export function clearGuiRevealPaint(container: HTMLElement): void {
  const block = lastTopBlock(container)
  if (block) unwrapPaint(block)
}
