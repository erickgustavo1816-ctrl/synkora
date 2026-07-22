import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PaneKind } from '../store'
import '@xterm/xterm/css/xterm.css'

interface Props {
  paneId: string
  cwd: string
  kind: PaneKind
  seatId?: string
  taskId?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  logFile?: string
  /** chamado quando o usuário digita no pane (limpa o alerta de aprovação) */
  onUserInput?: () => void
}

export default function TerminalPane({
  paneId,
  cwd,
  kind,
  seatId,
  taskId,
  initialPrompt,
  model,
  cliArgs,
  logFile,
  onUserInput
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#211f1a',
        foreground: '#efe8d6',
        cursor: '#d96c3f',
        selectionBackground: 'rgba(217, 108, 63, 0.35)'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    // Ctrl+V com IMAGEM no clipboard: repassa o byte 0x16 ao CLI (o Claude
    // Code lê o clipboard do sistema e anexa a imagem). Com texto, o paste
    // normal do xterm segue valendo.
    term.attachCustomKeyEventHandler((ev) => {
      if (
        ev.type === 'keydown' &&
        ev.ctrlKey &&
        !ev.shiftKey &&
        ev.key.toLowerCase() === 'v' &&
        window.synkora.clipboard.hasImage()
      ) {
        window.synkora.pty.write(paneId, '\x16')
        return false
      }
      return true
    })

    term.open(container)
    fit.fit()

    // Assina os eventos ANTES de criar o PTY para não perder o output inicial.
    const offData = window.synkora.pty.onData((id, data) => {
      if (id === paneId) term.write(data)
    })
    const offExit = window.synkora.pty.onExit((id, exitCode) => {
      if (id === paneId) term.write(`\r\n\x1b[90m[processo encerrado · código ${exitCode}]\x1b[0m\r\n`)
    })

    void window.synkora.pty
      .create({
        id: paneId,
        cwd,
        kind,
        seatId,
        taskId,
        initialPrompt,
        model,
        cliArgs,
        logFile,
        cols: term.cols,
        rows: term.rows
      })
      .then(() => window.synkora.pty.resize(paneId, term.cols, term.rows))

    const disposeInput = term.onData((data) => {
      window.synkora.pty.write(paneId, data)
      onUserInput?.()
    })

    const observer = new ResizeObserver(() => {
      fit.fit()
      window.synkora.pty.resize(paneId, term.cols, term.rows)
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      disposeInput.dispose()
      offData()
      offExit()
      window.synkora.pty.kill(paneId)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, cwd, kind, seatId, taskId, initialPrompt, model, cliArgs, logFile])

  return <div ref={containerRef} className="terminal-host" />
}
