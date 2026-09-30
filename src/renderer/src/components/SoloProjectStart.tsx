import { useEffect, useRef, useState } from 'react'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import {
  SOLO_SUMMARY_MISSING,
  soloStartDraft,
  type SoloHistoryRow,
  type SoloStartDraft
} from '../soloProjectModel'
import './SoloProject.css'

// O INÍCIO DO UNIVERSO SEM VERSIONAMENTO (cenas 2 e 3 do mockup aprovado).
//
// Uma FOLHA DE ESCREVER, não um convite em cartão: título + objetivo numa
// superfície com a mesma pele do composer do chat — começar a missão é
// escrever a primeira fala. Conta e modelo ficam para dentro da missão (o
// GuiSeatPick de sempre). Título vazio não trava o botão: o clique diz, colado
// ao campo, o que falta.
//
// Embaixo, o HISTÓRICO como livro-razão: data à esquerda em números tabulares,
// título e a frase do resumo (sem resumo, a linha diz isso). A missão que
// acabou de ser finalizada entra no topo com um filete de acento que se apaga.

type StartInput = Extract<SoloStartDraft, { ok: true }>['input']

export default function SoloProjectStart({
  folder,
  rows,
  justFinishedId,
  autoFocus,
  onStart,
  onRead
}: {
  /** o nome da pasta onde o agente edita */
  folder: string
  rows: readonly SoloHistoryRow[]
  /** a missão finalizada agora há pouco (ganha o filete que se apaga) */
  justFinishedId: string | null
  /** a folha nasce com o cursor no título (tela à vista do dono) */
  autoFocus: boolean
  /** cria a missão; devolve a recusa do main, ou null quando nasceu */
  onStart: (input: StartInput) => Promise<string | null>
  onRead: (missionId: string) => void
}): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [goal, setGoal] = useState('')
  const [needTitle, setNeedTitle] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const focusOnMount = useRef(autoFocus)

  useEffect(() => {
    if (focusOnMount.current) titleRef.current?.focus()
  }, [])

  async function submit(): Promise<void> {
    if (busy) return
    const draft = soloStartDraft(title, goal)
    if (!draft.ok) {
      setNeedTitle(true)
      titleRef.current?.focus()
      return
    }
    setError(null)
    setBusy(true)
    try {
      const refusal = await onStart(draft.input)
      if (refusal) setError(refusal)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="solo-start">
      <div className="solo-col">
        <h1 className="ss-h1">Nova missão</h1>
        <p className="ss-sub">
          O agente trabalha direto na pasta <b>{folder}</b>. Uma missão por vez.
        </p>

        <form
          className={`ss-sheet${needTitle ? ' need-title' : ''}`}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault()
              void submit()
            }
          }}
        >
          <label className="ss-field">
            <span className="ss-label">Título</span>
            <input
              ref={titleRef}
              className="ss-title"
              type="text"
              value={title}
              placeholder="ex.: reescrever a seção de preços"
              autoComplete="off"
              aria-invalid={needTitle || undefined}
              aria-describedby={needTitle ? 'solo-need-title' : undefined}
              onChange={(event) => {
                setTitle(event.target.value)
                if (event.target.value.trim()) setNeedTitle(false)
              }}
            />
            {needTitle && (
              <span className="ss-need" id="solo-need-title" role="alert">
                Dê um título para a missão.
              </span>
            )}
          </label>
          <label className="ss-field">
            <span className="ss-label">
              Objetivo <small>(opcional) · o agente lê antes de começar</small>
            </span>
            <textarea
              className="ss-goal"
              rows={2}
              value={goal}
              placeholder="ex.: três planos lado a lado, sem o desconto anual"
              onChange={(event) => setGoal(event.target.value)}
            />
          </label>
          {error && (
            <p className="ss-error" role="alert">
              {error}
            </p>
          )}
          <div className="ss-foot">
            <span className="ss-note">Conta e modelo você escolhe dentro da missão.</span>
            <span className="ss-kbd" aria-hidden="true">
              <kbd>Ctrl</kbd> <kbd>Enter</kbd>
            </span>
            <button className="btn accent" type="submit" disabled={busy}>
              {busy ? 'Iniciando…' : 'Iniciar missão'}
              <WorkspaceIcon name="arrow" />
            </button>
          </div>
        </form>

        {rows.length === 0 ? (
          <p className="ss-how">
            O agente edita os arquivos desta pasta na hora. Quando o trabalho estiver pronto, você
            finaliza a missão, ela vai para o histórico e esta tela volta.
          </p>
        ) : (
          <section className="solo-log" aria-labelledby="solo-log-h">
            <div className="log-head">
              <h2 className="log-title-h" id="solo-log-h">Finalizadas</h2>
              <span className="log-count">{rows.length}</span>
            </div>
            <ol className="log-list">
              {rows.map((row) => (
                <li key={row.id} className={row.id === justFinishedId ? 'just' : undefined}>
                  <button type="button" className="log-row" aria-label={row.label} onClick={() => onRead(row.id)}>
                    <span className="log-when">
                      <b>{row.day}</b>
                      {row.time}
                    </span>
                    <span className="log-text">
                      <span className="log-name">{row.title}</span>
                      <span className={`log-sum${row.summary ? '' : ' none'}`}>
                        {row.summary ?? SOLO_SUMMARY_MISSING}
                      </span>
                    </span>
                    <span className="log-go">
                      ler
                      <WorkspaceIcon name="arrow" />
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}
      </div>
    </div>
  )
}
