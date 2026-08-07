import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import type { DocFile } from '../store'
import type { TerminalMarkdownTarget } from '../../../preload/index'
import { onMarkdownOpen, takeMarkdownOpen } from '../projectFileNavigation'

// Aba ARQUIVOS: os .md do projeto (planos que o Maestro escreve, dossiê,
// docs, transcripts) listados e abertos DENTRO do Synkora, renderizados
// bonitos no tema papel — sem precisar de editor externo.

const GROUP_LABEL: Record<DocFile['group'], string> = {
  projeto: 'raiz do projeto',
  docs: 'docs/',
  synkora: '.synkora (maestro)',
  transcripts: 'transcripts de execução'
}

const GROUP_ORDER: DocFile['group'][] = ['synkora', 'docs', 'projeto', 'transcripts']

function fmtWhen(mtime: number): string {
  const d = new Date(mtime)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('pt-BR')
}

interface Props {
  projectId: string
}

export default function FilesView({ projectId }: Props): React.JSX.Element {
  const [docs, setDocs] = useState<DocFile[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [terminalDoc, setTerminalDoc] = useState<TerminalMarkdownTarget | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentMtime, setContentMtime] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [readerRevision, setReaderRevision] = useState(0)
  const activeFileRef = useRef<HTMLButtonElement | null>(null)

  const bridgeOk = Boolean(window.synkora.files)

  const refresh = useCallback(async () => {
    if (!window.synkora.files) return
    const list = await window.synkora.files.listDocs(projectId)
    setDocs(list)
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openFromTerminal = useCallback((target: TerminalMarkdownTarget): void => {
    setSelected(null)
    setTerminalDoc(target)
    setReaderRevision((value) => value + 1)
  }, [])

  useEffect(() => {
    const queued = takeMarkdownOpen(projectId)
    if (queued) openFromTerminal(queued)
    return onMarkdownOpen(projectId, openFromTerminal)
  }, [openFromTerminal, projectId])

  // Se o .md já faz parte do catálogo normal, seleciona sua posição real na
  // lista. Arquivos válidos fora das pastas indexadas continuam no grupo
  // efêmero "aberto do terminal" logo acima.
  useEffect(() => {
    if (
      terminalDoc?.root === 'project' &&
      docs.some((doc) => doc.path === terminalDoc.path)
    ) {
      setSelected(terminalDoc.path)
      setTerminalDoc(null)
    }
  }, [docs, terminalDoc])

  // A navegação veio de um clique explícito no terminal: mantém o arquivo
  // selecionado visível na lista e entrega o foco de teclado para a nova aba.
  useEffect(() => {
    if (!selected && !terminalDoc) return
    const frame = requestAnimationFrame(() => {
      activeFileRef.current?.focus({ preventScroll: true })
      activeFileRef.current?.scrollIntoView({ block: 'nearest' })
    })
    return () => cancelAnimationFrame(frame)
  }, [selected, terminalDoc])

  useEffect(() => {
    if ((!selected && !terminalDoc) || !window.synkora.files) return
    let stale = false
    setLoading(true)
    setContent(null)
    setContentMtime(null)
    const request = terminalDoc
      ? window.synkora.files.readTerminalDoc(
          projectId,
          terminalDoc.paneId,
          terminalDoc.root,
          terminalDoc.path
        )
      : window.synkora.files.readDoc(projectId, selected as string)
    void request
      .then((doc) => {
        if (stale) return
        setContent(doc?.content ?? '_arquivo não encontrado (foi movido/apagado?)_')
        setContentMtime(doc?.mtime ?? null)
        setLoading(false)
      })
      .catch(() => {
        if (stale) return
        setContent('_não foi possível abrir este arquivo agora_')
        setLoading(false)
      })
    return () => {
      stale = true
    }
  }, [projectId, readerRevision, selected, terminalDoc])

  // marked (GFM) + DOMPurify: o markdown vem de agentes/arquivos locais — o
  // sanitize evita qualquer HTML embutido esperto virar script no renderer.
  const html = useMemo(() => {
    if (content == null) return ''
    const raw = marked.parse(content, { async: false, gfm: true, breaks: false })
    return DOMPurify.sanitize(raw)
  }, [content])

  if (!bridgeOk) {
    return (
      <div className="ws-empty">
        <p className="empty-title">Arquivos indisponíveis</p>
        <p className="hint">
          Reinicie o app (<code>npm run dev</code>) para carregar a API nova de arquivos.
        </p>
      </div>
    )
  }

  const grouped = GROUP_ORDER.map((g) => ({
    group: g,
    files: docs.filter((d) => d.group === g)
  })).filter((g) => g.files.length > 0)

  const current = selected ? docs.find((d) => d.path === selected) : undefined
  const activePath = terminalDoc?.displayPath ?? selected
  const activeMtime = contentMtime ?? current?.mtime

  return (
    <div className="files-view">
      <aside className="files-list">
        <div className="files-list-head">
          <span className="files-title">arquivos .md</span>
          <button className="term-btn ghost-dim" data-tip="Recarregar a lista" onClick={() => void refresh()}>
            ↻
          </button>
        </div>
        {terminalDoc && (
          <div className="files-group">
            <div className="files-group-label">aberto do terminal</div>
            <button
              ref={activeFileRef}
              className="files-item active"
              data-tip={terminalDoc.displayPath}
              onClick={() => setReaderRevision((value) => value + 1)}
            >
              <span className="files-item-name">{terminalDoc.name}</span>
              <span className="files-item-when">agora</span>
            </button>
          </div>
        )}
        {grouped.length === 0 && (
          <div className="files-empty">
            nenhum .md encontrado — peça um plano ao Maestro (ele salva em .synkora/) ou rode 📚
            estudar
          </div>
        )}
        {grouped.map(({ group, files }) => (
          <div key={group} className="files-group">
            <div className="files-group-label">{GROUP_LABEL[group]}</div>
            {files.map((f) => (
              <button
                key={f.path}
                ref={selected === f.path ? activeFileRef : undefined}
                className={`files-item ${selected === f.path ? 'active' : ''}`}
                data-tip={f.path}
                onClick={() => {
                  setTerminalDoc(null)
                  setSelected(f.path)
                }}
              >
                <span className="files-item-name">{f.name}</span>
                <span className="files-item-when">{fmtWhen(f.mtime)}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <section className="files-reader">
        {!activePath ? (
          <div className="files-placeholder">
            <span className="files-placeholder-icon">▤</span>
            <p>escolha um arquivo ao lado para ler aqui, formatado</p>
          </div>
        ) : (
          <>
            <div className="files-reader-head">
              <span className="files-reader-path" data-tip={activePath}>
                {activePath}
              </span>
              {activeMtime != null && (
                <span className="files-reader-when">atualizado {fmtWhen(activeMtime)}</span>
              )}
              <button
                className="term-btn ghost-dim"
                data-tip="Recarregar este arquivo"
                onClick={() => setReaderRevision((value) => value + 1)}
              >
                ↻
              </button>
            </div>
            {loading ? (
              <div className="files-placeholder">
                <p>carregando…</p>
              </div>
            ) : (
              <article className="md-view" dangerouslySetInnerHTML={{ __html: html }} />
            )}
          </>
        )}
      </section>
    </div>
  )
}
