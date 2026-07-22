import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, type MaestroEvent } from '../store'
import { DEPT_BY_KEY } from '../departments'

// Peças compartilhadas do "espelho de sessão" (painel do Maestro, modal de
// tarefa e panes de execução): linha de log, seletor de permissão e o painel
// completo de um TaskRun.

export function MaestroLine({
  evt,
  sayTag = 'maestro>'
}: {
  evt: MaestroEvent
  sayTag?: string
}): React.JSX.Element {
  if (evt.kind === 'cmd')
    return (
      <div className="m-line cmd">
        <span className="prompt-char">$</span> {evt.text}
      </div>
    )
  if (evt.kind === 'say')
    return (
      <div className="m-line say">
        <span className="say-tag">{sayTag}</span> {evt.text}
      </div>
    )
  if (evt.kind === 'ok') return <div className="m-line ok">✓ {evt.text}</div>
  if (evt.kind === 'err') return <div className="m-line err">✗ {evt.text}</div>
  if (evt.kind === 'tool') {
    // Ferramenta REAL do painel de fundo: label bonito + input completo expandível.
    if (evt.detail) {
      return (
        <details className="m-line tool">
          <summary>
            <span className="m-tag maestro">[tool]</span> {evt.text}
          </summary>
          <pre className="tool-detail">{evt.detail}</pre>
        </details>
      )
    }
    return (
      <div className="m-line tool">
        <span className="m-tag maestro">[tool]</span> {evt.text}
      </div>
    )
  }
  if (evt.kind === 'out') return <div className="m-line out">↳ {evt.text}</div>
  if (evt.kind === 'ask') return <div className="m-line ask">⛭ {evt.text}</div>
  const hue = evt.tag && evt.tag !== 'maestro' ? DEPT_BY_KEY[evt.tag].hue : undefined
  return (
    <div className="m-line">
      <span
        className={`m-tag ${evt.tag === 'maestro' ? 'maestro' : ''}`}
        style={hue !== undefined ? { ['--dept-hue' as string]: hue } : undefined}
      >
        [{evt.tag}]
      </span>{' '}
      {evt.text}
    </div>
  )
}

// Pedido de permissão do CLI espelhado na UI: as opções são as mesmas do
// painel real (permitir / permitir sempre / negar), com teclado ↑↓ + Enter.
export function PermPicker({
  perm,
  onChoose
}: {
  perm: {
    toolName: string
    description: string
    inputPretty: string
    reason?: string
    canAlways: boolean
  }
  onChoose: (choice: 'allow' | 'allow-always' | 'deny') => void
}): React.JSX.Element {
  const options = useMemo(
    () => [
      { value: 'allow' as const, label: 'permitir desta vez' },
      ...(perm.canAlways
        ? [{ value: 'allow-always' as const, label: 'permitir e não perguntar de novo (sessão)' }]
        : []),
      { value: 'deny' as const, label: 'negar' }
    ],
    [perm.canAlways]
  )
  const [index, setIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
    setIndex(0)
  }, [perm])

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setIndex((i) => (i + delta + options.length) % options.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onChoose(options[index].value)
    }
  }

  return (
    <div className="model-picker perm-picker" ref={ref} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="m-line muted">// pedido de permissão — ↑↓ e Enter</div>
      <div className="perm-head">
        <b>{perm.toolName}</b> {perm.description}
      </div>
      {perm.reason && <div className="m-line muted">// motivo: {perm.reason}</div>}
      {perm.inputPretty && perm.inputPretty !== '{}' && (
        <details className="perm-input">
          <summary>ver input completo</summary>
          <pre className="tool-detail">{perm.inputPretty}</pre>
        </details>
      )}
      {options.map((o, i) => (
        <button
          key={o.value}
          className={`picker-item${i === index ? ' active' : ''}${o.value === 'deny' ? ' deny' : ''}`}
          onClick={() => onChoose(o.value)}
          onMouseEnter={() => setIndex(i)}
        >
          {i === index ? '❯ ' : '  '}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Espelho completo de um TaskRun: log ao vivo + aprovações + steering + parar. */
export default function RunPanel({ taskId }: { taskId: string }): React.JSX.Element | null {
  const run = useStore((s) => s.taskRuns[taskId])
  const answerRunPerm = useStore((s) => s.answerRunPerm)
  const sendToRun = useStore((s) => s.sendToRun)
  const interruptRun = useStore((s) => s.interruptRun)
  const closeRun = useStore((s) => s.closeRun)
  const [steer, setSteer] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [run?.events, run?.stream])

  if (!run) return null

  return (
    <>
      <div className="run-log" ref={logRef}>
        {run.events.map((evt, i) => (
          <MaestroLine key={i} evt={evt} sayTag="executor>" />
        ))}
        {run.stream && (
          <div className="m-line say">
            <span className="say-tag">executor&gt;</span> {run.stream}
            <span className="stream-cursor">▍</span>
          </div>
        )}
        {run.status === 'running' && !run.stream && !run.perm && (
          <div className="m-line muted blink">▍</div>
        )}
      </div>
      {run.perm && <PermPicker perm={run.perm} onChoose={(c) => void answerRunPerm(taskId, c)} />}
      <div className="task-modal-exec run-actions">
        <span className="prompt-char">$</span>
        <input
          className="run-steer"
          placeholder={
            run.status === 'running'
              ? 'instrução para o executor (steering)…'
              : 'pedir ajuste ou continuação ao executor…'
          }
          value={steer}
          onChange={(e) => setSteer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && steer.trim()) {
              void sendToRun(taskId, steer.trim())
              setSteer('')
            }
          }}
        />
        {run.status === 'running' ? (
          <button className="btn" onClick={() => void interruptRun(taskId)}>
            ⏹ parar
          </button>
        ) : (
          <button
            className="btn ghost"
            title="Encerra a sessão do executor (o transcript fica em .synkora/runs)"
            onClick={() => void closeRun(taskId)}
          >
            encerrar executor
          </button>
        )}
      </div>
    </>
  )
}
