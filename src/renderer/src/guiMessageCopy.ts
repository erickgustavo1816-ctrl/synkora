import { marked, type Token, type Tokens } from 'marked'

export type GuiMessageCopyFormat = 'markdown' | 'text'

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
    const codePoint = (raw: string, radix: number): string => {
      const code = Number.parseInt(raw, radix)
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return codePoint(entity.slice(2), 16)
    }
    if (entity.startsWith('#')) {
      return codePoint(entity.slice(1), 10)
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

// DOMPurify descarta o conteudo destes elementos quando eles sao removidos.
// O modo "Copiar texto" precisa seguir a mesma fronteira: texto que nao aparece
// na resposta sanitizada tambem nao pode reaparecer silenciosamente no clipboard.
const HIDDEN_HTML_TAGS = new Set([
  'annotation-xml',
  'audio',
  'colgroup',
  'desc',
  'foreignobject',
  'head',
  'iframe',
  'math',
  'mi',
  'mn',
  'mo',
  'ms',
  'mtext',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
  'script',
  'selectedcontent',
  'style',
  'svg',
  'template',
  'title',
  'video',
  'xmp'
])
const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

interface HtmlFrame {
  tag: string
  hidden: boolean
}

function htmlHidden(stack: HtmlFrame[]): boolean {
  return stack[stack.length - 1]?.hidden === true
}

function applyHtmlTag(raw: string, stack: HtmlFrame[]): { recognized: boolean; lineBreak: boolean } {
  if (/^<!--[\s\S]*-->$/u.test(raw)) return { recognized: true, lineBreak: false }
  const match = /^<\s*(\/?)\s*([a-z][\w:-]*)([\s\S]*?)(\/?)\s*>$/iu.exec(raw)
  if (!match) return { recognized: false, lineBreak: false }
  const closing = Boolean(match[1])
  const tag = match[2].toLowerCase()
  if (closing) {
    // HTML bem formado fecha em LIFO. Fechamento torto não abre conteúdo que
    // estava oculto; além de fail-closed, isto mantém a travessia O(n).
    if (stack[stack.length - 1]?.tag === tag) stack.pop()
    return { recognized: true, lineBreak: tag === 'br' }
  }
  const hidden = htmlHidden(stack) || HIDDEN_HTML_TAGS.has(tag)
  if (!match[4] && !VOID_HTML_TAGS.has(tag)) stack.push({ tag, hidden })
  return { recognized: true, lineBreak: tag === 'br' && !hidden }
}

/** Extrai somente texto VISÍVEL de HTML cru sem executar ou montar esse HTML. */
function visibleHtmlText(text: string, stack: HtmlFrame[] = []): string {
  let output = ''
  let cursor = 0
  while (cursor < text.length) {
    const opening = text.indexOf('<', cursor)
    if (opening < 0) {
      if (!htmlHidden(stack)) output += decodeEntities(text.slice(cursor))
      break
    }
    if (opening > cursor && !htmlHidden(stack)) {
      output += decodeEntities(text.slice(cursor, opening))
    }
    if (text.startsWith('<!--', opening)) {
      const end = text.indexOf('-->', opening + 4)
      cursor = end < 0 ? text.length : end + 3
      continue
    }
    let quote = ''
    let end = opening + 1
    for (; end < text.length; end += 1) {
      const char = text[end]
      if (quote) {
        if (char === quote) quote = ''
      } else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
    }
    if (end >= text.length) {
      if (!htmlHidden(stack)) output += decodeEntities(text.slice(opening))
      break
    }
    const tag = text.slice(opening, end + 1)
    const transition = applyHtmlTag(tag, stack)
    if (!transition.recognized && !htmlHidden(stack)) {
      output += decodeEntities(tag)
    } else if (transition.lineBreak && !output.endsWith('\n')) output += '\n'
    cursor = end + 1
  }
  return output
}

function visibleText(text: string, stack: HtmlFrame[] = []): string {
  return text.includes('<') ? visibleHtmlText(text, stack) : decodeEntities(text)
}

function childTokens(token: Token): Token[] {
  const candidate = (token as { tokens?: unknown }).tokens
  return Array.isArray(candidate) ? (candidate as Token[]) : []
}

function tokenText(token: Token): string {
  const value = (token as { text?: unknown }).text
  return typeof value === 'string' ? value : ''
}

function renderInline(tokens: Token[], htmlStack: HtmlFrame[] = []): string {
  return tokens.map((token) => renderInlineToken(token, htmlStack)).join('')
}

function renderInlineToken(token: Token, htmlStack: HtmlFrame[]): string {
  if (token.type !== 'html' && htmlHidden(htmlStack)) return ''
  switch (token.type) {
    case 'text':
      return childTokens(token).length
        ? renderInline(childTokens(token), htmlStack)
        : visibleText(tokenText(token), htmlStack)
    case 'escape':
    case 'codespan':
      return decodeEntities(tokenText(token))
    case 'strong':
    case 'em':
    case 'del':
    case 'link':
      return renderInline(childTokens(token), htmlStack) || decodeEntities(tokenText(token))
    case 'image':
      return decodeEntities(tokenText(token))
    case 'br':
      return '\n'
    case 'checkbox':
      return (token as Tokens.Checkbox).checked ? '☑ ' : '☐ '
    case 'html':
      return visibleHtmlText(tokenText(token) || token.raw, htmlStack)
    default:
      return childTokens(token).length
        ? renderInline(childTokens(token), htmlStack)
        : visibleText(tokenText(token) || token.raw, htmlStack)
  }
}

function indentContinuation(text: string, indent: string): string {
  return text.split('\n').map((line, index) => (index === 0 ? line : `${indent}${line}`)).join('\n')
}

function renderList(token: Tokens.List, depth: number, htmlStack: HtmlFrame[]): string {
  const indent = '  '.repeat(depth)
  return token.items
    .map((item, index) => {
      const marker = token.ordered ? `${Number(token.start || 1) + index}.` : '•'
      const task = item.task ? (item.checked ? '☑ ' : '☐ ') : ''
      const bodyParts: string[] = []
      const nested: string[] = []
      for (const child of item.tokens) {
        if (child.type === 'checkbox') continue
        if (child.type === 'list') nested.push(renderList(child as Tokens.List, depth + 1, htmlStack))
        else bodyParts.push(renderBlockToken(child, depth + 1, htmlStack))
      }
      const body = bodyParts.join('\n').trim()
      const first = `${indent}${marker} ${task}${indentContinuation(body, `${indent}  `)}`.trimEnd()
      return nested.length ? `${first}\n${nested.join('\n')}` : first
    })
    .join('\n')
}

function renderTable(token: Tokens.Table, htmlStack: HtmlFrame[]): string {
  const row = (cells: Tokens.TableCell[]): string =>
    cells.map((cell) => renderInline(cell.tokens, htmlStack).trim()).join(' | ')
  return [row(token.header), ...token.rows.map(row)].filter(Boolean).join('\n')
}

function renderBlockToken(token: Token, depth = 0, htmlStack: HtmlFrame[] = []): string {
  switch (token.type) {
    case 'space':
    case 'def':
      return ''
    case 'code':
      return (token as Tokens.Code).text
    case 'heading':
    case 'paragraph':
      return renderInline(childTokens(token), htmlStack) || visibleText(tokenText(token), htmlStack)
    case 'blockquote':
      return renderBlocks((token as Tokens.Blockquote).tokens, htmlStack)
    case 'list':
      return renderList(token as Tokens.List, depth, htmlStack)
    case 'table':
      return renderTable(token as Tokens.Table, htmlStack)
    case 'hr':
      return '—'
    case 'html':
      return visibleHtmlText(tokenText(token) || token.raw, htmlStack)
    default:
      return childTokens(token).length
        ? renderInline(childTokens(token), htmlStack)
        : visibleText(tokenText(token) || token.raw, htmlStack)
  }
}

function renderBlocks(tokens: Token[], htmlStack: HtmlFrame[] = []): string {
  return tokens
    .map((token) => renderBlockToken(token, 0, htmlStack))
    .filter((text) => text.length > 0)
    .join('\n\n')
}

/**
 * Conversão pela AST do mesmo parser usado na tela. Cercas e marcadores saem;
 * o conteúdo de código, rótulos de links e estrutura de listas permanecem.
 */
export function guiMarkdownToPlainText(markdown: string): string {
  if (!markdown) return ''
  try {
    return renderBlocks(marked.lexer(markdown, { gfm: true }), []).replace(/^\n+|\n+$/gu, '')
  } catch {
    // Falha do parser não pode reintroduzir HTML oculto no clipboard.
    return visibleText(markdown).replace(/^\n+|\n+$/gu, '')
  }
}

export function guiMessageCopyPayload(
  markdown: string,
  format: GuiMessageCopyFormat
): string {
  return format === 'markdown' ? markdown : guiMarkdownToPlainText(markdown)
}

export async function writeGuiMessageCopy(
  writeText: (text: string) => Promise<void>,
  markdown: string,
  format: GuiMessageCopyFormat
): Promise<void> {
  await writeText(guiMessageCopyPayload(markdown, format))
}
