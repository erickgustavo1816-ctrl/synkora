import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type ProjectCreateOutcome } from '../store'
import {
  createErrorSlot,
  errorSentence,
  folderCheckAfterError,
  newUniverseRequest,
  NO_FOLDER,
  versioningSwitchView,
  type CreateErrorSlot,
  type FolderCheck
} from '../newUniverseModel'
import WorkspaceIcon from '../workspace/WorkspaceIcon'
import { folderName } from '../util'
import { InlineNotice } from './NoticeStack'
import './SheetModal.css'
import './NewUniverseModal.css'

// NOVO UNIVERSO — o "+" da Home e do rail passam por aqui. Duas decisões no
// nascimento (mockup aprovado: docs/mockups/projeto-sem-versao-2026-09-30.html,
// cena 1):
//
// - VERSIONAR COM GIT (2026-09-30): ligado é o universo de sempre (missões em
//   paralelo, isoladas, entregues por versão); desligado é o universo SEM
//   VERSIONAMENTO (uma missão por vez, editando a pasta direto). Pasta com Git
//   trava o interruptor ligado, com o motivo. A escolha é definitiva.
// - LINK DO GITHUB (onda D, opcional, só no ligado): com link o main conecta o
//   repositório no nascimento (clone na pasta vazia, remoto na pasta cheia).
//
// A falha de push/auth NÃO cancela nada: o universo já existe e o aviso chega
// nesta mesma folha. A falha dura (clone, recusa) aparece ONDE quebrou e o
// botão volta a funcionar.

interface CreateError {
  slot: CreateErrorSlot | 'folder'
  text: string
}

/** Os dois desenhos que o WorkspaceIcon não tem, na mesma gramática (viewBox
 *  20, traço 1.4, pontas redondas). */
function SheetGlyph({ name }: { name: 'folder' | 'star' }): React.JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === 'folder' ? (
        <path d="M2.5 5.5v10h15v-8.5h-7.5l-2-2h-5.5z" />
      ) : (
        <path d="M10 2.5c.6 4.4 3.1 6.9 7.5 7.5-4.4.6-6.9 3.1-7.5 7.5-.6-4.4-3.1-6.9-7.5-7.5 4.4-.6 6.9-3.1 7.5-7.5z" />
      )}
    </svg>
  )
}

export default function NewUniverseModal({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
  const createProject = useStore((s) => s.createProject)
  const ids = useId()
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  /** o dono escreveu o nome: trocar de pasta não passa por cima dele */
  const [nameEdited, setNameEdited] = useState(false)
  const [gitUrl, setGitUrl] = useState('')
  /** a vontade do dono; a pasta com Git vence (ver versioningSwitchView) */
  const [wantsGit, setWantsGit] = useState(true)
  const [check, setCheck] = useState<FolderCheck>(NO_FOLDER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<CreateError | null>(null)
  /** aviso do main depois de criar (push/auth falhou) — o universo JÁ existe */
  const [warning, setWarning] = useState<string | null>(null)
  /** só a leitura da ÚLTIMA pasta escolhida vale */
  const inspectSeq = useRef(0)

  const view = versioningSwitchView(wantsGit, check)
  const remoteOpen = view.checked

  async function pickFolder(): Promise<void> {
    let folder: string | null = null
    try {
      folder = await window.synkora.pickFolder()
    } catch {
      folder = null
    }
    if (!folder) return
    setPath(folder)
    if (!nameEdited) setName(folderName(folder))
    setError(null)
    const seq = ++inspectSeq.current
    setCheck({ state: 'checking' })
    try {
      const inspection = await window.synkora.projects.inspectFolder(folder)
      if (seq === inspectSeq.current) setCheck({ state: 'known', inspection })
    } catch {
      // main sem o canal, pasta recusada: "não sei" — quem recusa é o main
      if (seq === inspectSeq.current) setCheck({ state: 'unknown' })
    }
  }

  async function create(dropLink = false): Promise<void> {
    if (busy) return
    if (!path) {
      setError({ slot: 'folder', text: 'Escolha a pasta do universo.' })
      return
    }
    const request = newUniverseRequest({ name, path, gitUrl: dropLink ? '' : gitUrl, wantsGit }, check)
    setBusy(true)
    setError(null)
    let outcome: ProjectCreateOutcome
    try {
      outcome = await createProject(request)
    } catch {
      outcome = { ok: false, error: 'Não consegui criar o universo agora. Tente de novo.' }
    }
    setBusy(false)
    if (!outcome.ok) {
      const failure = outcome.error
      setCheck((current) => folderCheckAfterError(failure, current))
      setError({ slot: createErrorSlot(failure, request, check), text: errorSentence(failure) })
      return
    }
    if (outcome.warning) {
      setWarning(outcome.warning)
      return
    }
    onClose()
  }

  /** "crie sem o link": a saída do clone que falhou — o link sai e o
   *  universo nasce sem ele. */
  function createWithoutLink(): void {
    setGitUrl('')
    void create(true)
  }

  const errorIn = (slot: CreateError['slot']): string | null => (error?.slot === slot ? error.text : null)
  const folderError = errorIn('folder')
  const versioningError = errorIn('versioning')
  const remoteError = errorIn('remote')
  const formError = errorIn('form')
  const hintId = `${ids}-hint`
  const remoteErrId = `${ids}-remote-err`

  return createPortal(
    <div
      className="overlay"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !busy) {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        className="sheet-modal nu-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sm-head">
          <span className="sm-kind" id={`${ids}-title`}>
            <WorkspaceIcon name="plus" />
            Novo universo
          </span>
          <button type="button" className="sm-close" aria-label="Fechar" disabled={busy} onClick={onClose}>
            <WorkspaceIcon name="close" />
          </button>
        </div>

        {warning ? (
          <>
            <p className="sm-lead">O universo foi criado, mas o GitHub não fechou o ciclo.</p>
            <InlineNotice tone="warn">{warning}</InlineNotice>
            <p className="nu-note">
              Nada se perdeu: o projeto está aqui e a pasta é sua. Ajuste o remoto quando quiser.
            </p>
            <div className="sm-actions">
              <span className="sm-meta" />
              <button type="button" className="btn accent" autoFocus onClick={onClose}>
                Entendi
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sm-lead">Escolha a pasta do universo e como as missões vão trabalhar nela.</p>

            <div>
              <span className="field-label" id={`${ids}-folder`}>
                Pasta
              </span>
              <div className="nu-folder" role="group" aria-labelledby={`${ids}-folder`}>
                <button
                  type="button"
                  className="btn ghost tiny"
                  autoFocus
                  disabled={busy}
                  onClick={() => void pickFolder()}
                >
                  <SheetGlyph name="folder" />
                  Escolher pasta
                </button>
                <span className={`nu-folder-path${path ? '' : ' is-empty'}`} title={path || undefined}>
                  {path || 'nenhuma pasta escolhida'}
                </span>
              </div>
              {folderError && (
                <div className="nu-err" role="alert">
                  {folderError}
                </div>
              )}
            </div>

            <label className="nu-field">
              <span className="field-label">Nome</span>
              <input
                className="text-input"
                value={name}
                placeholder="sai do nome da pasta"
                onChange={(e) => {
                  setName(e.target.value)
                  setNameEdited(e.target.value.trim() !== '')
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create()
                }}
              />
            </label>

            <div className="nu-versioning">
              <button
                type="button"
                role="switch"
                className={`vswitch${view.locked ? ' is-locked' : ''}`}
                aria-checked={view.checked}
                aria-describedby={hintId}
                disabled={view.locked || busy}
                aria-busy={check.state === 'checking' || undefined}
                onClick={() => {
                  if (view.locked) return
                  setWantsGit(!view.checked)
                  if (error?.slot !== 'folder') setError(null)
                }}
              >
                <span className="vs-label">Versionar com Git</span>
                <span className="vs-state">
                  <span className="vs-word">
                    {view.locked && <WorkspaceIcon name="lock" />}
                    {view.word}
                  </span>
                  <span className="vs-track" aria-hidden="true">
                    <span className="vs-knob" />
                  </span>
                </span>
                <span className="vs-hint" id={hintId}>
                  {view.hint}
                </span>
              </button>
              {versioningError && (
                <div className="nu-err" role="alert" data-nu="versioning-error">
                  {versioningError}
                </div>
              )}
            </div>

            {/* o campo do GitHub pertence ao LIGADO: desligar recolhe (a forma
                mostra a consequência) e tira o campo do teclado */}
            <div
              className={`nu-remote${remoteOpen ? '' : ' is-collapsed'}`}
              data-nu="remote"
              aria-hidden={remoteOpen ? undefined : true}
              inert={remoteOpen ? undefined : true}
            >
              <div>
                <label className="nu-field">
                  <span className="field-label">
                    Link do GitHub <small>(opcional)</small>
                  </span>
                  <input
                    className={`text-input nu-remote-input${remoteError ? ' is-err' : ''}`}
                    value={gitUrl}
                    placeholder="https://github.com/voce/projeto"
                    spellCheck={false}
                    aria-invalid={remoteError ? true : undefined}
                    aria-describedby={remoteError ? remoteErrId : undefined}
                    onChange={(e) => {
                      setGitUrl(e.target.value)
                      if (error?.slot === 'remote') setError(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) void create()
                    }}
                  />
                </label>
                {remoteError && (
                  <div className="nu-err" id={remoteErrId} role="alert">
                    {remoteError} Confira o link e tente de novo, ou{' '}
                    <button type="button" className="link-btn" disabled={busy} onClick={createWithoutLink}>
                      crie sem o link
                    </button>
                    .
                  </div>
                )}
              </div>
            </div>

            {formError && (
              <div className="nu-err" role="alert">
                {formError}
              </div>
            )}

            <div className="sm-actions">
              <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>
                Cancelar
              </button>
              <span className="sm-meta">Não dá para trocar depois.</span>
              <button
                type="button"
                className="btn accent"
                disabled={busy}
                aria-busy={busy || undefined}
                onClick={() => void create()}
              >
                <SheetGlyph name="star" />
                {busy ? 'Criando…' : 'Criar universo'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
