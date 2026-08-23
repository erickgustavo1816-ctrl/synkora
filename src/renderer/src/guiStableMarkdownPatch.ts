// PATCH DE PREFIXO ESTÁVEL DO MARKDOWN DO CHAT (R35 — 2026-08-23).
//
// Queixa do dono, terceira rodada da família: "quando a IA tá falando eu não
// consigo selecionar"; "seleciono de baixo pra cima, do nada vira de cima pra
// baixo"; "arrastei, soltei e ele solta a seleção". A R34 (freio de scroll)
// estava certa e era NECESSÁRIA — mas era metade do problema.
//
// A outra metade é DOM, não scroll: `GuiStreamText` re-renderiza o
// `GuiMarkdown` a cada tick da máquina de escrever e o markdown era pintado
// por `dangerouslySetInnerHTML`. String nova ⇒ React troca o innerHTML
// INTEIRO ⇒ todos os nós da mensagem em streaming são destruídos e recriados,
// várias vezes por segundo. Seleção que toca a subárvore morre na hora; o
// arrasto ancorado nela re-ancora no ponteiro (o "vira de cima pra baixo"); e
// o tick logo depois do mouseup apaga a seleção recém-feita.
//
// A régua daqui: no streaming, de um tick para o outro só o ÚLTIMO bloco de
// topo muda — todo o resto já está escrito e sai idêntico do pipeline. Então
// comparamos filho a filho de topo, preservamos o prefixo igual INTACTO (os
// mesmos nós, a mesma identidade de DOM, a mesma seleção) e só mexemos a
// partir da primeira diferença.
//
// LIMITE ACEITO E DOCUMENTADO: o bloco que ainda CRESCE continua volátil —
// não se segura seleção dentro da palavra que está sendo digitada. Tudo o que
// já fechou bloco fica firme.
//
// FRONTEIRA DE SEGURANÇA: este módulo NÃO sanitiza e NÃO relaxa sanitização —
// ele recebe o html que o pipeline do `GuiMarkdown` já passou por
// marked → DOMPurify → roteamento de links → tokens de arquivo, e nada mais.
// Nenhum caminho novo de HTML entra no chat por aqui.

/** Tipos de nó por número — o renderer roda em DOM, mas a metade PURA deste
 *  módulo é testada em node puro, onde `Node` não existe como global. */
const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** A DECISÃO, pura e sem DOM (R35.2): quantos filhos de topo do começo são
 *  idênticos e portanto NÃO podem ser tocados. Recebe as chaves serializadas
 *  dos filhos atuais e as do html novo; devolve o tamanho do prefixo comum.
 *
 *  Não tenta ser um diff esperto (mover/casar blocos no meio): no streaming a
 *  mutação é sempre no fim, e um casamento frouxo no meio arriscaria remontar
 *  justamente o que se quer preservar. Prefixo comum é o invariante honesto. */
export function guiStablePrefixPlan(
  oldChildren: readonly string[],
  newChildren: readonly string[]
): { keep: number } {
  const limit = Math.min(oldChildren.length, newChildren.length)
  let keep = 0
  while (keep < limit && oldChildren[keep] === newChildren[keep]) keep += 1
  return { keep }
}

function isElementNode(node: ChildNode): node is Element {
  return node.nodeType === ELEMENT_NODE
}

/** A chave de um filho de topo. O prefixo discrimina a ESPÉCIE do nó: o
 *  pipeline real emite texto solto no topo — `marked` separa os blocos com
 *  "\n" e esses viram Text nodes irmãos dos `<p>`/`<pre>`/`<ul>` (sondado em
 *  binário: `marked.parse('# a\n\nb')` → `"<h1>a</h1>\n<p>b</p>\n"`). Comparar
 *  só `children` (elementos) desalinharia os índices e faria o aplicador
 *  remover o nó errado. */
export function guiStableNodeKey(node: ChildNode): string {
  if (isElementNode(node)) return `e:${node.outerHTML}`
  if (node.nodeType === TEXT_NODE) return `t:${node.nodeValue ?? ''}`
  // Comentário e afins: DOMPurify já os remove, mas uma chave por tipo+valor
  // mantém o aplicador correto se o pipeline algum dia passar a emiti-los.
  return `n${node.nodeType}:${node.nodeValue ?? ''}`
}

/** A APLICAÇÃO, fina (R35.2): monta um template DESTACADO com o html novo,
 *  pergunta o plano à função pura, deixa o prefixo igual intocado e troca só a
 *  cauda. Um caminho só — streaming e render final (R35.3): o último patch
 *  converge no html completo, sem modo duplo.
 *
 *  O html chega JÁ sanitizado pelo pipeline do chamador. */
export function applyGuiStableMarkdown(container: HTMLElement, html: string): void {
  const doc = container.ownerDocument
  const template = doc.createElement('template')
  template.innerHTML = html

  const fresh = Array.from(template.content.childNodes)
  const current = Array.from(container.childNodes)
  const { keep } = guiStablePrefixPlan(current.map(guiStableNodeKey), fresh.map(guiStableNodeKey))

  // Nada mudou: não encostar no DOM é o caso mais comum entre uma mensagem
  // pronta e o re-render do pai.
  if (keep === current.length && keep === fresh.length) return

  // De trás pra frente a partir da primeira diferença: a lista viva de filhos
  // do container não pode ser percorrida enquanto encolhe pela frente.
  for (let index = current.length - 1; index >= keep; index -= 1) current[index].remove()

  if (keep >= fresh.length) return
  const tail = doc.createDocumentFragment()
  for (let index = keep; index < fresh.length; index += 1) tail.appendChild(fresh[index])
  container.appendChild(tail)
}
