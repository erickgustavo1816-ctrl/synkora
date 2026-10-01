import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type Mission, type Version } from '../store'
import Select from './Select'
import './SheetModal.css'
import './MissionVersionChangeModal.css'

export default function MissionVersionChangeModal({ mission, versions, onClose }: {
  mission: Mission
  versions: Version[]
  onClose: () => void
}): React.JSX.Element {
  const changeMissionVersion = useStore((state) => state.changeMissionVersion)
  const [choices, setChoices] = useState<Version[]>([])
  const [targetVersionId, setTargetVersionId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const pending = useRef(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const currentVersion = versions.find((version) => version.id === mission.versionId)
  const destinations = choices.filter((version) => version.id !== mission.versionId)
  const canSubmit = !loading && !loadError && !submitting && destinations.some((version) => version.id === targetVersionId)

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null
    dialogRef.current?.focus({ preventScroll: true })
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    if (submitting) dialogRef.current?.focus({ preventScroll: true })
  }, [submitting])

  useEffect(() => {
    let current = true
    setLoading(true)
    setLoadError('')
    setTargetVersionId('')
    const readChoices = window.synkora.missions?.versionChoices
    if (!readChoices) {
      setLoading(false)
      setLoadError('Reinicie o Synkora para carregar as versões disponíveis.')
      return
    }
    void readChoices(mission.projectId)
      .then((result) => { if (current) setChoices(result.versions) })
      .catch(() => { if (current) setLoadError('Não foi possível carregar as versões. Tente novamente.') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [mission.projectId, mission.versionId, attempt])

  function close(): void {
    if (!pending.current) onClose()
  }

  async function submit(): Promise<void> {
    if (!canSubmit || pending.current) return
    pending.current = true
    setSubmitting(true)
    setSubmitError('')
    try {
      const result = await changeMissionVersion(mission.id, targetVersionId)
      if (result.ok) onClose()
      else setSubmitError(result.error)
    } finally {
      pending.current = false
      setSubmitting(false)
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return
    const dialog = dialogRef.current
    const controls = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled)'))
    const first = controls[0]
    const last = controls.at(-1)
    if (!first) {
      event.preventDefault()
      dialog.focus()
    } else if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
      event.preventDefault()
      const target = event.shiftKey ? last : first
      target?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className="overlay mission-version-change-overlay" onClick={close}>
      <div
        ref={dialogRef}
        className="sheet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={submitting}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sm-head">
          <h2 className="mission-version-change-title" id={titleId}>Alterar versão</h2>
          <button className="sm-close" aria-label="Fechar alteração de versão" disabled={submitting} onClick={close}>×</button>
        </div>
        <p className="sm-lead mission-version-change-mission-title">{mission.title}</p>
        <p className="mission-version-change-current">Versão atual: <strong>{currentVersion?.name ?? mission.versionId ?? 'Sem versão'}</strong></p>
        <p className="mission-version-change-description" id={descriptionId}>
          A conversa e o trabalho permanecem nesta missão, com a mesma branch e os mesmos arquivos e commits.
          A próxima integração usará a versão escolhida como destino, com as verificações de conflitos habituais.
        </p>
        <div className="mission-version-change-field">
          <span className="field-label">Versão de destino</span>
          <Select
            tip="Versão de destino"
            value={targetVersionId}
            options={destinations.map((version) => ({ value: version.id, label: `◈ ${version.name}`, hint: version.theme }))}
            placeholder={loading ? 'Carregando versões…' : 'Escolha outra versão'}
            disabled={loading || Boolean(loadError) || submitting || destinations.length === 0}
            onChange={(value) => { if (!pending.current) { setTargetVersionId(value); setSubmitError('') } }}
          />
        </div>
        {loadError && <div className="mission-version-change-error" role="alert">
          <p>{loadError}</p>
          <button className="btn ghost tiny" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button>
        </div>}
        {!loading && !loadError && destinations.length === 0 && <p className="mission-version-change-description" role="status">
          Nenhuma outra versão aberta está disponível neste projeto. Abra uma versão na aba Versões e tente novamente.
        </p>}
        {submitError && <p className="mission-version-change-error" role="alert">{submitError}</p>}
        <div className="sm-actions mission-version-change-actions">
          <button className="btn ghost" disabled={submitting} onClick={close}>cancelar</button>
          <span className="sm-meta" role="status">{submitting ? 'Alterando versão…' : loading ? 'Carregando versões…' : ''}</span>
          <button className="btn accent" disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? 'Alterando…' : 'Alterar versão'}
          </button>
        </div>
      </div>
    </div>, document.body
  )
}
