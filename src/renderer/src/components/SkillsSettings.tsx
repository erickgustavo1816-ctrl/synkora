import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store'
import { InlineNotice } from './NoticeStack'
import {
  chatActiveCount,
  chatSlotCount,
  checkKitAddition,
  checkSkillFolderUrl,
  chatLabel,
  kitChatBlocks,
  libraryRows,
  prunableSkillIds,
  skillsWithBom,
  wingLabel,
  OCCASION_MAX,
  SKILLS_BOM_NOTE,
  SKILLS_KIT_RULE,
  SKILLS_LAW_BADGE,
  SKILLS_LAW_NOTE,
  type SkillChatType,
  type SkillDevWing,
  type SkillsKitChatBlock,
  type SkillsKitGroup,
  type SkillsKitSlot,
  type SkillsLibraryRow
} from '../skillsSettingsModel'

// SKILLS 2.0 — A TELA DE GESTÃO (ADR-0006).
//
// Duas cartas, na ordem em que o dono pergunta:
//   1. O KIT — o que cada tipo de conversa recebe, por OCASIÃO. É a leitura do
//      dia. A LEI (impeccable, ADR-0005) mora aqui como ficha FIXA: sem toggle,
//      porque mudar lei é doutrina registrada, não clique.
//   2. A BIBLIOTECA — o que esta máquina tem: instalar por URL (a única rede da
//      feature), busca, "adicionar ao kit" e a PODA, no rodapé, com overlay de
//      confirmação em portal (window.confirm quebra o foco no Windows).
//
// A regra visível fica na cara do kit: o sync roda no SPAWN, então conversa já
// aberta ficou com a pasta que recebeu no boot.

const CHATS: SkillChatType[] = ['dev', 'planejamento']
const WINGS: SkillDevWing[] = ['execucao', 'orquestracao']

function pastas(n: number): string {
  return n === 1 ? '1 pasta' : `${n} pastas`
}

function slots(n: number): string {
  return n === 1 ? '1 slot' : `${n} slots`
}

/* ------------------------------------------------------------ o kit ------ */

/** o aviso de BOM: a pasta está lá, mas o CLI não lê o frontmatter dela */
function BomFlag(): React.JSX.Element {
  return (
    <span className="skill-bom" data-tip={SKILLS_BOM_NOTE} aria-label={SKILLS_BOM_NOTE}>
      <i aria-hidden="true">⚠</i>
      bom
    </span>
  )
}

function KitSlotRow({
  slot,
  chat,
  busy,
  bom,
  onToggle,
  onRemove
}: {
  slot: SkillsKitSlot
  chat: SkillChatType
  busy: boolean
  bom: boolean
  onToggle: (chat: SkillChatType, slot: SkillsKitSlot) => void
  onRemove: (chat: SkillChatType, slot: SkillsKitSlot) => void
}): React.JSX.Element {
  // A LEI tem FORMA própria, não só cor: sem coluna de controle, com o selo no
  // lugar do toggle e a doutrina escrita embaixo — quem bate o olho vê que ali
  // não há o que clicar.
  if (slot.law)
    return (
      <li className="skill-slot is-law">
        <span className="skill-slot-occasion">{slot.occasion}</span>
        <span className="skill-slot-idcell">
          <code className="skill-slot-id">{slot.id}</code>
          {bom && <BomFlag />}
        </span>
        <span className="skill-slot-law">
          <i aria-hidden="true">◆</i>
          {SKILLS_LAW_BADGE}
        </span>
        <small className="skill-slot-lawnote">{SKILLS_LAW_NOTE}</small>
      </li>
    )

  return (
    <li className={`skill-slot${slot.enabled ? ' is-on' : ''}`}>
      <span className="skill-slot-occasion">{slot.occasion}</span>
      <span className="skill-slot-idcell">
        <code className="skill-slot-id">{slot.id}</code>
        {bom && <BomFlag />}
      </span>
      <button
        type="button"
        className="skill-switch"
        role="switch"
        aria-checked={slot.enabled}
        aria-label={`${slot.id} no kit de ${chatLabel(chat)}`}
        disabled={busy}
        onClick={() => onToggle(chat, slot)}
      >
        <em>{slot.enabled ? 'ligado' : 'desligado'}</em>
        <i aria-hidden="true">
          <b />
        </i>
      </button>
      <button
        type="button"
        className="uc-act danger"
        disabled={busy}
        data-tip="Tirar do kit (a skill continua na biblioteca)"
        aria-label={`Tirar ${slot.id} do kit de ${chatLabel(chat)}`}
        onClick={() => onRemove(chat, slot)}
      >
        ×
      </button>
    </li>
  )
}

function KitGroupBlock({
  group,
  busyKey,
  bomIds,
  onToggle,
  onRemove
}: {
  group: SkillsKitGroup
  busyKey: string | null
  bomIds: ReadonlySet<string>
  onToggle: (chat: SkillChatType, slot: SkillsKitSlot) => void
  onRemove: (chat: SkillChatType, slot: SkillsKitSlot) => void
}): React.JSX.Element {
  return (
    <div className="skill-group">
      {group.label && (
        <div className="skill-group-head">
          <h4>{group.label}</h4>
          <span className="skill-group-count">{slots(group.slots.length)}</span>
          <small>{group.hint}</small>
        </div>
      )}
      {group.slots.length === 0 ? (
        <p className="skill-empty">
          Nenhum slot aqui. Escolha uma skill na biblioteca, logo abaixo, e diga a ocasião.
        </p>
      ) : (
        <ul className="skill-slot-list">
          {group.slots.map((slot) => (
            <KitSlotRow
              key={`${group.key}:${slot.id}`}
              slot={slot}
              chat={group.chat}
              busy={busyKey === `${group.chat}:${slot.id}`}
              bom={bomIds.has(slot.id)}
              onToggle={onToggle}
              onRemove={onRemove}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function KitChatBlock({
  block,
  busyKey,
  bomIds,
  onToggle,
  onRemove
}: {
  block: SkillsKitChatBlock
  busyKey: string | null
  bomIds: ReadonlySet<string>
  onToggle: (chat: SkillChatType, slot: SkillsKitSlot) => void
  onRemove: (chat: SkillChatType, slot: SkillsKitSlot) => void
}): React.JSX.Element {
  return (
    <section className="skill-chat">
      <header className="skill-chat-head">
        <h3>{block.label}</h3>
        <span className="skill-chat-count">
          {chatActiveCount(block)} de {slots(chatSlotCount(block))} no ar
        </span>
        <small>{block.hint}</small>
      </header>
      {block.groups.map((group) => (
        <KitGroupBlock
          key={group.key}
          group={group}
          busyKey={busyKey}
          bomIds={bomIds}
          onToggle={onToggle}
          onRemove={onRemove}
        />
      ))}
    </section>
  )
}

/* ------------------------------------------------------ a biblioteca ----- */

function AddToKitForm({
  row,
  onCancel,
  onConfirm
}: {
  row: SkillsLibraryRow
  onCancel: () => void
  /** devolve o erro (null = entrou no kit e a ficha pode fechar) */
  onConfirm: (chat: SkillChatType, occasion: string, wing: SkillDevWing) => Promise<string | null>
}): React.JSX.Element {
  const [chat, setChat] = useState<SkillChatType>('dev')
  const [wing, setWing] = useState<SkillDevWing>('execucao')
  const [occasion, setOccasion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const kit = useStore((s) => s.skillsKit)

  const submit = async (): Promise<void> => {
    if (busy) return
    const check = checkKitAddition({ id: row.id, chat, wing, occasion }, kit)
    if (!check.ok) {
      setError(check.error)
      return
    }
    setBusy(true)
    setError(null)
    const failure = await onConfirm(check.chat, check.occasion, wing)
    setBusy(false)
    if (failure) setError(failure)
  }

  return (
    <div className="skill-add" role="group" aria-label={`Adicionar ${row.id} a um kit`}>
      <div className="skill-add-choices">
        <div className="skill-seg" role="group" aria-label="Tipo de conversa">
          <span className="skill-seg-label">conversa</span>
          {CHATS.map((option) => (
            <button
              key={option}
              type="button"
              className={`skill-seg-opt${chat === option ? ' is-on' : ''}`}
              aria-pressed={chat === option}
              onClick={() => {
                setChat(option)
                setError(null)
              }}
            >
              {chatLabel(option)}
            </button>
          ))}
        </div>
        {/* a ala só existe no dev: mostrar o controle desligado seria oferecer
            uma escolha que não muda nada */}
        {chat === 'dev' && (
          <div className="skill-seg" role="group" aria-label="Ala do dev">
            <span className="skill-seg-label">ala</span>
            {WINGS.map((option) => (
              <button
                key={option}
                type="button"
                className={`skill-seg-opt${wing === option ? ' is-on' : ''}`}
                aria-pressed={wing === option}
                onClick={() => setWing(option)}
              >
                {wingLabel(option)}
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="skill-add-occasion">
        <span>ocasião — a linha que o agente lê</span>
        <input
          className="pref-text-input"
          autoFocus
          maxLength={OCCASION_MAX}
          value={occasion}
          placeholder="ex.: vai mexer em UI"
          spellCheck={false}
          onChange={(event) => {
            setOccasion(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
            if (event.key === 'Escape') onCancel()
          }}
        />
      </label>

      {error && <p className="skill-add-error">{error}</p>}

      <div className="skill-add-acts">
        <button type="button" className="btn tiny" disabled={busy} onClick={() => void submit()}>
          {busy ? 'adicionando…' : 'adicionar ao kit'}
        </button>
        <button type="button" className="btn ghost tiny" disabled={busy} onClick={onCancel}>
          cancelar
        </button>
      </div>
    </div>
  )
}

function LibraryRow({
  row,
  open,
  onOpen,
  onCancel,
  onConfirm
}: {
  row: SkillsLibraryRow
  open: boolean
  onOpen: (id: string) => void
  onCancel: () => void
  onConfirm: (chat: SkillChatType, occasion: string, wing: SkillDevWing) => Promise<string | null>
}): React.JSX.Element {
  return (
    <li className={`skill-lib-row${row.inKit ? ' is-in-kit' : ''}${open ? ' is-open' : ''}`}>
      <code className="skill-lib-id">{row.id}</code>
      {row.hasBom && <BomFlag />}
      <p className="skill-lib-desc">
        {row.description.trim() || 'sem descrição legível no frontmatter'}
      </p>
      {row.inKit && (
        <span className="skill-lib-flag" data-tip="Já tem slot em algum kit">
          já no kit
        </span>
      )}
      <button
        type="button"
        className="btn ghost tiny skill-lib-add"
        aria-expanded={open}
        onClick={() => (open ? onCancel() : onOpen(row.id))}
      >
        {open ? 'fechar' : '+ ao kit'}
      </button>
      {open && <AddToKitForm row={row} onCancel={onCancel} onConfirm={onConfirm} />}
    </li>
  )
}

/* ------------------------------------------------------------- a poda ---- */

function PruneOverlay({
  doomed,
  kept,
  busy,
  error,
  onCancel,
  onConfirm
}: {
  doomed: string[]
  kept: number
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => cancelRef.current?.focus(), [])

  return createPortal(
    <div className="overlay" onClick={() => !busy && onCancel()}>
      <div
        className="task-modal confirm-modal skill-prune-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-prune-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) onCancel()
        }}
      >
        <div className="task-modal-head">
          <span className="task-dept" id="skill-prune-title">
            ✂ podar a biblioteca
          </span>
          <button
            type="button"
            className="pane-close dark-close"
            aria-label="Fechar"
            disabled={busy}
            onClick={onCancel}
          >
            ×
          </button>
        </div>

        <p className="confirm-text">
          <strong>{pastas(doomed.length)}</strong> saem da biblioteca desta máquina.
        </p>
        <p className="confirm-sub">
          Ficam as {kept} com slot em algum kit — ligadas ou desligadas. Qualquer skill volta
          depois pelo “instalar por URL”, pinada no commit de origem.
        </p>

        <ul className="skill-prune-list">
          {doomed.slice(0, 12).map((id) => (
            <li key={id}>{id}</li>
          ))}
          {doomed.length > 12 && <li className="skill-prune-more">+ {doomed.length - 12} …</li>}
        </ul>

        {error && <InlineNotice tone="error">{error}</InlineNotice>}

        <div className="task-modal-actions">
          <button type="button" className="btn ghost" ref={cancelRef} disabled={busy} onClick={onCancel}>
            cancelar
          </button>
          <span className="task-modal-meta">{kept} ficam no disco</span>
          <button type="button" className="btn danger-solid" disabled={busy} onClick={onConfirm}>
            {busy ? 'podando…' : `podar ${pastas(doomed.length)}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

/* ------------------------------------------------------------- a tela ---- */

export default function SkillsSettings(): React.JSX.Element {
  const library = useStore((s) => s.skillsLibrary)
  const kit = useStore((s) => s.skillsKit)
  const loading = useStore((s) => s.skillsLoading)
  const error = useStore((s) => s.skillsError)
  const loadSkills = useStore((s) => s.loadSkills)
  const setSkillEnabled = useStore((s) => s.setSkillEnabled)
  const addSkillToKit = useStore((s) => s.addSkillToKit)
  const removeSkillFromKit = useStore((s) => s.removeSkillFromKit)
  const installSkillFromUrl = useStore((s) => s.installSkillFromUrl)
  const pruneSkills = useStore((s) => s.pruneSkills)

  const [query, setQuery] = useState('')
  const [openRow, setOpenRow] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const [installUrl, setInstallUrl] = useState('')
  const [installBusy, setInstallBusy] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const [installed, setInstalled] = useState<string | null>(null)

  const [pruneOpen, setPruneOpen] = useState(false)
  const [pruneBusy, setPruneBusy] = useState(false)
  const [pruneError, setPruneError] = useState<string | null>(null)
  const [pruned, setPruned] = useState<number | null>(null)

  useEffect(() => {
    void loadSkills()
  }, [loadSkills])

  const blocks = useMemo(() => kitChatBlocks(kit), [kit])
  const rows = useMemo(() => libraryRows(library, kit, query), [library, kit, query])
  const doomed = useMemo(() => prunableSkillIds(library, kit), [library, kit])
  const bomIds = useMemo(() => new Set(skillsWithBom(library)), [library])

  const firstRead = !kit && library.length === 0
  const showSkeleton = loading && firstRead
  const dead = !loading && firstRead && !!error

  const toggleSlot = async (chat: SkillChatType, slot: SkillsKitSlot): Promise<void> => {
    setBusyKey(`${chat}:${slot.id}`)
    await setSkillEnabled(chat, slot.id, !slot.enabled)
    setBusyKey(null)
  }

  const dropSlot = async (chat: SkillChatType, slot: SkillsKitSlot): Promise<void> => {
    setBusyKey(`${chat}:${slot.id}`)
    await removeSkillFromKit(chat, slot.id)
    setBusyKey(null)
  }

  const addSlot = async (
    id: string,
    chat: SkillChatType,
    occasion: string,
    wing: SkillDevWing
  ): Promise<string | null> => {
    const failure = await addSkillToKit(chat, id, occasion, chat === 'dev' ? wing : undefined)
    // a ficha só fecha quando o slot ENTROU — falha mantém o que foi digitado
    if (!failure) setOpenRow(null)
    return failure
  }

  const install = async (): Promise<void> => {
    if (installBusy) return
    const check = checkSkillFolderUrl(installUrl)
    if (!check.ok) {
      setInstalled(null)
      setInstallError(check.error)
      return
    }
    setInstallBusy(true)
    setInstallError(null)
    setInstalled(null)
    const res = await installSkillFromUrl(check.url)
    setInstallBusy(false)
    if (res.ok) {
      setInstalled(res.id ?? check.folder)
      setInstallUrl('')
      return
    }
    setInstallError(res.error ?? 'a instalação não completou')
  }

  const prune = async (): Promise<void> => {
    if (pruneBusy) return
    setPruneBusy(true)
    setPruneError(null)
    const res = await pruneSkills()
    setPruneBusy(false)
    if (!res.ok) {
      setPruneError(res.error ?? 'a poda não completou')
      return
    }
    setPruned(res.removed?.length ?? 0)
    setPruneOpen(false)
  }

  return (
    <div className="skills-settings">
      {error && !dead && (
        <p className="skill-banner" role="status">
          {error}
          <button type="button" className="btn ghost tiny" onClick={() => void loadSkills()}>
            tentar de novo
          </button>
        </p>
      )}

      {/* ————— 1. O KIT ————— */}
      <section className="settings-card skill-kit-card">
        <header className="settings-card-head">
          <div>
            <span className="settings-card-kicker">cardápio por tipo de conversa</span>
            <h2>O kit de cada chat</h2>
            <p>
              Uma skill por ocasião: o agente lê a ocasião e decide sozinho quando carregar. A
              conversa de release não recebe kit nenhum, de propósito.
            </p>
          </div>
          {/* contar antes de ler o disco diria "0 slots" com cara de verdade */}
          <span className="skill-head-count">
            {showSkeleton
              ? '…'
              : slots(blocks.reduce((total, block) => total + chatSlotCount(block), 0))}
          </span>
        </header>

        <p className="skill-rule">
          <i aria-hidden="true">⇢</i>
          {SKILLS_KIT_RULE}
        </p>

        <div className="skill-kit-body">
          {showSkeleton ? (
            <div className="skill-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          ) : dead ? (
            <p className="skill-dead">
              {error}
              <button type="button" className="btn ghost tiny" onClick={() => void loadSkills()}>
                tentar de novo
              </button>
            </p>
          ) : (
            blocks.map((block) => (
              <KitChatBlock
                key={block.chat}
                block={block}
                busyKey={busyKey}
                bomIds={bomIds}
                onToggle={(chat, slot) => void toggleSlot(chat, slot)}
                onRemove={(chat, slot) => void dropSlot(chat, slot)}
              />
            ))
          )}
        </div>
      </section>

      {/* ————— 2. A BIBLIOTECA ————— */}
      <section className="settings-card skill-lib-card">
        <header className="settings-card-head">
          <div>
            <span className="settings-card-kicker">biblioteca desta máquina</span>
            <h2>Skills instaladas</h2>
            <p>
              A biblioteca é global: vale para todos os universos. Instalar não põe a skill em
              kit nenhum — o slot é escolha sua, logo abaixo de cada linha.
            </p>
          </div>
          <span className="skill-head-count">{showSkeleton ? '…' : library.length}</span>
        </header>

        <div className="skill-lib-tools">
          <label className="skill-search">
            <span>buscar</span>
            <input
              className="pref-text-input"
              type="search"
              value={query}
              placeholder="id ou assunto (ex.: debug, plano, banco)"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <label className="skill-install">
            <span>instalar por URL</span>
            <div className="skill-install-row">
              <input
                className="pref-text-input"
                type="url"
                value={installUrl}
                placeholder="https://github.com/dono/repo/tree/main/skills/nome"
                spellCheck={false}
                onChange={(event) => {
                  setInstallUrl(event.target.value)
                  setInstallError(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void install()
                  }
                }}
              />
              <button
                type="button"
                className="btn tiny"
                disabled={installBusy || !installUrl.trim()}
                onClick={() => void install()}
              >
                {installBusy ? 'instalando…' : 'instalar'}
              </button>
            </div>
          </label>
        </div>

        {installError && <p className="skill-install-error">{installError}</p>}
        {installed && (
          <p className="skill-install-ok">
            ✓ <code>{installed}</code> entrou na biblioteca, pinada no commit de origem. Ela não
            vai para conversa nenhuma até ganhar um slot.
          </p>
        )}

        <div className="skill-lib-body">
          {showSkeleton ? (
            <div className="skill-skeleton" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : dead ? (
            <p className="skill-dead">A biblioteca não pôde ser lida.</p>
          ) : library.length === 0 ? (
            <p className="skill-empty">
              Esta máquina ainda não tem nenhuma skill instalada. Cole a URL da pasta de uma skill
              no GitHub, ali em cima, para trazer a primeira.
            </p>
          ) : rows.length === 0 ? (
            <p className="skill-empty">
              Nenhuma skill com “{query.trim()}”. A busca olha o id e a descrição.
            </p>
          ) : (
            <ul className="skill-lib-list">
              {rows.map((row) => (
                <LibraryRow
                  key={row.id}
                  row={row}
                  open={openRow === row.id}
                  onOpen={setOpenRow}
                  onCancel={() => setOpenRow(null)}
                  onConfirm={(chat, occasion, wing) => addSlot(row.id, chat, occasion, wing)}
                />
              ))}
            </ul>
          )}
        </div>

        <footer className="skill-lib-foot">
          <div>
            <strong>Poda</strong>
            <small>
              {doomed.length === 0
                ? 'Nada a podar: toda pasta da biblioteca tem slot em algum kit.'
                : `${pastas(doomed.length)} sem slot em kit nenhum ocupam disco à toa. A poda apaga só essas.`}
            </small>
            {pruned !== null && (
              <small className="skill-pruned">✂ {pastas(pruned)} saíram da biblioteca.</small>
            )}
          </div>
          <button
            type="button"
            className="btn tiny danger"
            disabled={doomed.length === 0 || loading}
            onClick={() => {
              setPruneError(null)
              setPruneOpen(true)
            }}
          >
            podar {pastas(doomed.length)}
          </button>
        </footer>
      </section>

      {pruneOpen && (
        <PruneOverlay
          doomed={doomed}
          kept={library.length - doomed.length}
          busy={pruneBusy}
          error={pruneError}
          onCancel={() => setPruneOpen(false)}
          onConfirm={() => void prune()}
        />
      )}
    </div>
  )
}
