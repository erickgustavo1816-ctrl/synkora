import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { FilePreviewResult } from '../../../preload/index'

interface Props {
  path: string | null
  preview: FilePreviewResult | null
  loading: boolean
  onReload: () => void
}

const SAFE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

function languageFor(path: string): string {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return extension || 'text'
}

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}

function formatWhen(mtime: number): string {
  return new Date(mtime).toLocaleString('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  })
}

function MarkdownContent({ content }: { content: string }): React.JSX.Element {
  const html = useMemo(() => {
    const raw = marked.parse(content, { async: false, gfm: true, breaks: false })
    return DOMPurify.sanitize(String(raw), { USE_PROFILES: { html: true } })
  }, [content])
  return <article className="md-view file-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

type CodeTokenKind = 'plain' | 'comment' | 'string' | 'keyword' | 'number' | 'literal'
interface CodeToken {
  kind: CodeTokenKind
  value: string
}

const CODE_TOKEN_PATTERN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|`(?:\\.|[^`])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:as|async|await|break|case|catch|class|const|continue|def|else|export|extends|false|finally|for|from|function|if|implements|import|in|interface|let|new|null|of|private|public|return|static|this|throw|true|try|type|undefined|var|void|while|with|yield)\b|\b\d+(?:\.\d+)?\b/gu

function tokenKind(value: string): CodeTokenKind {
  if (/^(?:\/\/|\/\*|#)/u.test(value)) return 'comment'
  if (/^[`"']/u.test(value)) return 'string'
  if (/^(?:true|false|null|undefined)$/u.test(value)) return 'literal'
  if (/^\d/u.test(value)) return 'number'
  return 'keyword'
}

function highlightCode(source: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let cursor = 0
  for (const match of source.matchAll(CODE_TOKEN_PATTERN)) {
    const value = match[0]
    const index = match.index ?? cursor
    if (index > cursor) tokens.push({ kind: 'plain', value: source.slice(cursor, index) })
    tokens.push({ kind: tokenKind(value), value })
    cursor = index + value.length
  }
  if (cursor < source.length) tokens.push({ kind: 'plain', value: source.slice(cursor) })
  return tokens
}

function CodeContent({ content, path }: { content: string; path: string }): React.JSX.Element {
  const tokens = useMemo(() => highlightCode(content), [content])
  return (
    <pre className="file-code" data-language={languageFor(path)}>
      <code>
        {tokens.map((token, index) => (
          <span key={`${index}-${token.kind}`} className={`file-code-token ${token.kind}`}>
            {token.value}
          </span>
        ))}
      </code>
    </pre>
  )
}

function EmptyPreview(): React.JSX.Element {
  return (
    <div className="files-placeholder file-preview-empty">
      <span className="files-placeholder-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24">
          <path d="M6.5 3.5h7l4 4v13h-11z" />
          <path d="M13.5 3.5v4h4M9 12h6M9 15.5h4.5" />
        </svg>
      </span>
      <p>selecione um arquivo para ler aqui</p>
      <span className="file-preview-readonly">somente leitura · nada é salvo</span>
    </div>
  )
}

function StatusPreview({ result }: { result: Extract<FilePreviewResult, { ok: true; kind: 'binary' | 'large' | 'blocked' }> }): React.JSX.Element {
  const glyph = result.kind === 'large' ? '↗' : result.kind === 'blocked' ? '⊘' : '◇'
  return (
    <div className="files-placeholder file-preview-status">
      <span className="files-placeholder-icon" aria-hidden="true">{glyph}</span>
      <p>{result.message}</p>
      <span className="file-preview-status-detail">{formatSize(result.size)} · sem edição</span>
    </div>
  )
}

export default function FilePreviewPanel({ path, preview, loading, onReload }: Props): React.JSX.Element {
  const canRenderImage =
    preview?.ok === true &&
    preview.kind === 'image' &&
    SAFE_IMAGE_MIMES.has(preview.image.mime) &&
    /^[A-Za-z0-9+/]+={0,2}$/u.test(preview.image.base64)
  const pathParts = path?.split('/') ?? []
  const fileName = pathParts.at(-1) ?? ''
  const parentPath = pathParts.slice(0, -1).join('/')

  return (
    <section className="files-reader file-preview-panel" aria-label="Prévia do arquivo">
      {!path ? (
        <EmptyPreview />
      ) : (
        <>
          <header className="files-reader-head file-preview-head">
            <span className="files-reader-path" data-tip={path}>
              <strong>{fileName}</strong>
              {parentPath && <span>{parentPath}</span>}
            </span>
            {preview?.ok === true && (
              <span className="files-reader-when">
                {formatSize(preview.size)} · {formatWhen(preview.mtime)}
              </span>
            )}
            <span className="file-preview-badge">Leitura</span>
            <button
              type="button"
              className="file-preview-reload"
              data-tip="Recarregar esta prévia"
              aria-label="Recarregar esta prévia"
              onClick={onReload}
            >
              <svg viewBox="0 0 18 18" aria-hidden="true">
                <path d="M14.25 6.25V2.9m0 0H10.9m3.35 0-2.1 2.1a5.6 5.6 0 1 0 1.15 6.05" />
              </svg>
            </button>
          </header>
          {loading ? (
            <div className="files-placeholder"><p>carregando prévia…</p></div>
          ) : preview == null ? (
            <div className="files-placeholder file-preview-status"><p>arquivo não encontrado ou indisponível</p></div>
          ) : !preview.ok ? (
            <div className="files-placeholder file-preview-status"><p>{preview.error}</p></div>
          ) : preview.kind === 'markdown' ? (
            <MarkdownContent content={preview.content} />
          ) : preview.kind === 'code' ? (
            <CodeContent content={preview.content} path={preview.path} />
          ) : preview.kind === 'text' ? (
            <pre className="file-text">{preview.content}</pre>
          ) : preview.kind === 'image' && canRenderImage ? (
            <div className="file-image-preview">
              <img
                src={`data:${preview.image.mime};base64,${preview.image.base64}`}
                alt={`Prévia de ${preview.name}`}
                decoding="async"
                referrerPolicy="no-referrer"
              />
            </div>
          ) : preview.kind === 'image' ? (
            <div className="files-placeholder file-preview-status"><p>imagem não pôde ser validada para a prévia</p></div>
          ) : (
            <StatusPreview
              result={preview as Extract<FilePreviewResult, { ok: true; kind: 'binary' | 'large' | 'blocked' }>}
            />
          )}
        </>
      )}
    </section>
  )
}
