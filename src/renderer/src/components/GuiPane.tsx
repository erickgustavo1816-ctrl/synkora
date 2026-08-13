import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EMPTY_GUI_PANE, useStore, type GuiItem, type GuiPendingPerm } from '../store'
import {
  asGuiEvent,
  guiApi,
  type GuiPaneSpawn,
  type GuiPermBehavior,
  type GuiPermissionMode,
  type GuiSessionEvent
} from '../guiApi'

// PANE GUI — o chat que substitui a TUI dentro do pane (Synkora 2.0, onda A).
//
// Mora no MESMO deck de PanesView, com o MESMO chrome (PaneChrome). A regra de
// ouro do deck continua valendo: a lista é plana e nunca se desmonta ao
// reorganizar o canvas — aqui isso importa ainda mais, porque desmontar
// derrubaria a assinatura do canal `gui:live` e a conversa viva.
//
// Este componente NÃO cria PTY nenhum: o motor é uma sessão por pane no main
// (maestroSession/codexSession), comandada por `window.synkora.gui`.

interface Props {
  paneId: string
  projectId: string
  cli: 'claude' | 'codex'
  /** Config dir isolado do seat (CLAUDE_CONFIG_DIR / CODEX_HOME). Sem ele a
   *  sessão nasceria na conta errada — o pane recusa e explica. */
  configDir?: string
  cwd: string
  model?: string
  effort?: string
  systemPrompt?: string
  resumeSessionId?: string
  firstPrompt?: string
  /** modo de permissão DESTA conversa (onda D) — ausente = 'default' */
  permissionMode?: GuiPermissionMode
  /** o dono da spec guarda a escolha: sem isto, remontar o slot voltaria ao
   *  modo antigo enquanto a sessão no main já está no novo. */
  onPermissionMode?: (mode: GuiPermissionMode) => void
}

/**
 * O replay (`gui:state`) devolve o ring buffer do main; enquanto ele viaja, o
 * canal vivo pode entregar eventos que JÁ estão nesse buffer. Casa a maior
 * cauda do replay com o começo do que ficou em espera para aplicar cada evento
 * uma vez só — sem perder o que nasceu depois da fotografia.
 */
function replayOverlap(replay: GuiSessionEvent[], buffered: GuiSessionEvent[]): number {
  const max = Math.min(replay.length, buffered.length)
  for (let k = max; k > 0; k -= 1) {
    let same = true
    for (let i = 0; i < k; i += 1) {
      if (JSON.stringify(replay[replay.length - k + i]) !== JSON.stringify(buffered[i])) {
        same = false
        break
      }
    }
    if (same) return k
  }
  return 0
}

function GuiToolCard({ item }: { item: Extract<GuiItem, { kind: 'tool' }> }): React.JSX.Element {
  const state = item.result ? (item.result.isError ? 'err' : 'ok') : 'run'
  const glyph = item.result ? (item.result.isError ? '✗' : '✓') : '◌'
  const row = (
    <>
      <span className={`gui-tool-state ${state}`}>{glyph}</span>
      <b className="gui-tool-name">{item.name}</b>
      {item.summary && <span className="gui-tool-summary">{item.summary}</span>}
    </>
  )
  if (!item.result?.text) return <div className="gui-tool">{row}</div>
  return (
    <details className="gui-tool">
      <summary>{row}</summary>
      <pre className="gui-tool-detail">{item.result.text}</pre>
    </details>
  )
}

/** Vocabulário do seletor do composer (onda D): rótulo curto para o botão e
 *  frase de uma linha para o menu — o dono escolhe SEM abrir documentação. */
const PERM_MODES: { id: GuiPermissionMode; label: string; hint: string }[] = [
  { id: 'default', label: 'padrão', hint: 'pergunta antes de agir fora do combinado' },
  { id: 'acceptEdits', label: 'edições', hint: 'edita arquivos sem perguntar; o resto pergunta' },
  { id: 'bypass', label: 'bypass', hint: 'segue reto, sem nenhuma aprovação' },
  { id: 'plan', label: 'plano', hint: 'só estuda e propõe — não escreve nada' }
]

const PERM_MODE_LABEL: Record<GuiPermissionMode, string> = {
  default: 'padrão',
  acceptEdits: 'edições',
  bypass: 'bypass',
  plan: 'plano'
}

const PERM_LABEL: Record<GuiPermBehavior | 'cancelada', string> = {
  allow: 'permitido desta vez',
  'allow-always': 'permitido sempre (nesta sessão)',
  deny: 'negado',
  cancelada: 'cancelado pelo CLI'
}

function GuiMessage({ item }: { item: GuiItem }): React.JSX.Element {
  if (item.kind === 'tool') return <GuiToolCard item={item} />
  if (item.kind === 'permission') {
    return (
      <div className={`gui-perm-mark ${item.behavior === 'deny' ? 'deny' : ''}`}>
        ⛭ {item.toolName}: {PERM_LABEL[item.behavior]}
      </div>
    )
  }
  if (item.kind === 'user') {
    return (
      <div className="gui-msg user">
        <span className="gui-msg-tag">você</span>
        <div className="gui-msg-text">{item.text}</div>
      </div>
    )
  }
  if (item.kind === 'note') return <div className="gui-note">{item.text}</div>
  if (item.kind === 'error') return <div className="gui-error">✗ {item.text}</div>
  return (
    <div className="gui-msg assistant">
      <div className="gui-msg-text">{item.text}</div>
    </div>
  )
}

function GuiPermCard({
  perm,
  onChoose
}: {
  perm: GuiPendingPerm
  onChoose: (behavior: GuiPermBehavior) => void
}): React.JSX.Element {
  return (
    <div className="gui-perm">
      <div className="gui-perm-head">
        <b>{perm.toolName}</b> {perm.description}
      </div>
      {perm.reason && <div className="gui-perm-reason">motivo: {perm.reason}</div>}
      {perm.inputPretty && perm.inputPretty !== '{}' && (
        <details className="gui-perm-input">
          <summary>ver o pedido completo</summary>
          <pre className="gui-tool-detail">{perm.inputPretty}</pre>
        </details>
      )}
      <div className="gui-perm-actions">
        <button className="gui-btn primary" onClick={() => onChoose('allow')}>
          permitir
        </button>
        {perm.canAlways && (
          <button className="gui-btn" onClick={() => onChoose('allow-always')}>
            sempre
          </button>
        )}
        <button className="gui-btn deny" onClick={() => onChoose('deny')}>
          negar
        </button>
      </div>
    </div>
  )
}

export default function GuiPane({
  paneId,
  projectId,
  cli,
  configDir,
  cwd,
  model,
  effort,
  systemPrompt,
  resumeSessionId,
  firstPrompt,
  permissionMode,
  onPermissionMode
}: Props): React.JSX.Element {
  const gui = useStore((s) => s.guiPanes[paneId]) ?? EMPTY_GUI_PANE
  const handleGuiLive = useStore((s) => s.handleGuiLive)
  const replayGuiPane = useStore((s) => s.replayGuiPane)
  const markGuiSpawned = useStore((s) => s.markGuiSpawned)
  const sendGuiMessage = useStore((s) => s.sendGuiMessage)
  const answerGuiPerm = useStore((s) => s.answerGuiPerm)
  const interruptGuiPane = useStore((s) => s.interruptGuiPane)

  // A spec do spawn muda no MÁXIMO junto com o pane; guardá-la em ref evita
  // que uma prop nova re-dispare o efeito de montagem (que reabriria sessão).
  const spawnRef = useRef<GuiPaneSpawn>({
    paneId,
    projectId,
    cli,
    configDir: configDir ?? '',
    cwd,
    model,
    effort,
    systemPrompt,
    resumeSessionId,
    firstPrompt,
    permissionMode: permissionMode ?? 'default'
  })

  // MODO DE PERMISSÃO (onda D): estado local para o botão responder na hora,
  // semeado pela spec. O pai (quando existe) guarda a escolha na spec dele —
  // por isso o efeito só re-semeia quando a PROP muda de fato.
  const [mode, setMode] = useState<GuiPermissionMode>(permissionMode ?? 'default')
  const [modeOpen, setModeOpen] = useState(false)
  const [modeBusy, setModeBusy] = useState(false)
  useEffect(() => {
    setMode(permissionMode ?? 'default')
  }, [permissionMode])

  spawnRef.current = {
    paneId,
    projectId,
    cli,
    configDir: configDir ?? '',
    cwd,
    model,
    effort,
    systemPrompt,
    resumeSessionId,
    firstPrompt,
    permissionMode: mode
  }

  const [draft, setDraft] = useState('')
  const [pinned, setPinned] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // ————— assinatura do canal + replay na montagem —————
  useEffect(() => {
    let alive = true
    let replayed = false
    const buffered: GuiSessionEvent[] = []

    const off = guiApi.onLive((payload) => {
      if (!payload || payload.paneId !== paneId) return
      const evt = asGuiEvent(payload.evt)
      if (!evt) return
      // Assinar ANTES do replay é o que garante zero buraco: o que chegar
      // durante a viagem fica em espera e entra logo depois, sem duplicar.
      if (!replayed) buffered.push(evt)
      else handleGuiLive(paneId, evt)
    })

    void (async () => {
      const events = await guiApi.state(paneId)
      if (!alive) return
      replayGuiPane(paneId, events)
      replayed = true
      const skip = replayOverlap(events, buffered)
      for (const evt of buffered.slice(skip)) handleGuiLive(paneId, evt)
      buffered.length = 0

      // Sessão já viva (remontagem, reload do renderer) tem histórico: nunca
      // se abre outra por cima. O `spawned` cobre o caso do pane novo.
      if (events.length || useStore.getState().guiPanes[paneId]?.spawned) return
      markGuiSpawned(paneId)
      const spawn = spawnRef.current
      if (!spawn.configDir) {
        handleGuiLive(paneId, {
          type: 'fatal',
          text: 'este pane não tem conta (config dir) definida — escolha uma conta e abra de novo'
        })
        return
      }
      const res = await guiApi.create(spawn)
      if (!alive || res.ok) return
      handleGuiLive(paneId, {
        type: 'fatal',
        text: res.error ?? 'não deu para abrir a sessão deste pane'
      })
    })()

    return () => {
      alive = false
      off()
    }
  }, [paneId, handleGuiLive, replayGuiPane, markGuiSpawned])

  // ————— rolagem: gruda no fim, salvo quando o usuário subiu para ler —————
  const onScroll = useCallback((): void => {
    const el = logRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    pinnedRef.current = atBottom
    setPinned((current) => (current === atBottom ? current : atBottom))
  }, [])

  useLayoutEffect(() => {
    const el = logRef.current
    if (!el || !pinnedRef.current) return
    el.scrollTop = el.scrollHeight
  }, [gui.items, gui.stream, gui.thinking, gui.perm])

  // textarea que cresce com o texto (Enter envia, Shift+Enter quebra linha)
  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(168, ta.scrollHeight)}px`
  }, [draft])

  const dead = gui.status === 'dead'
  const working = gui.status === 'working' || gui.status === 'starting'

  const submit = useCallback((): void => {
    const text = draft.trim()
    if (!text || dead) return
    setDraft('')
    pinnedRef.current = true
    setPinned(true)
    void sendGuiMessage(paneId, text)
  }, [draft, dead, paneId, sendGuiMessage])

  /**
   * TROCA DE MODO EM VOO (onda D): re-emite `gui:create` com o MESMO paneId e
   * o modo novo. O motor trata a mudança de fingerprint respawnando a sessão
   * COM resume — a conversa continua, o modo é outro. A linha no transcript
   * existe porque uma troca silenciosa seria indistinguível de um bug.
   */
  const changeMode = useCallback(
    async (next: GuiPermissionMode): Promise<void> => {
      setModeOpen(false)
      if (next === mode || modeBusy || dead) return
      setModeBusy(true)
      setMode(next)
      onPermissionMode?.(next)
      const res = await guiApi.create({ ...spawnRef.current, permissionMode: next })
      setModeBusy(false)
      handleGuiLive(
        paneId,
        res.ok
          ? {
              type: 'command-output',
              text: `modo de permissão: ${PERM_MODE_LABEL[next]} — sessão retomada`
            }
          : {
              type: 'limit',
              text: `não deu para trocar o modo de permissão: ${res.error ?? 'motivo desconhecido'}`
            }
      )
    },
    [mode, modeBusy, dead, onPermissionMode, paneId, handleGuiLive]
  )

  // fechar o menu clicando fora (mesmo padrão dos dropdowns do app)
  const modeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!modeOpen) return
    const onDocDown = (e: MouseEvent): void => {
      if (!modeRef.current?.contains(e.target as Node)) setModeOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [modeOpen])

  const goToEnd = useCallback((): void => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setPinned(true)
  }, [])

  const empty = gui.items.length === 0 && !gui.stream && !gui.perm

  return (
    <div className="gui-pane">
      <div className="gui-log" ref={logRef} onScroll={onScroll}>
        {empty && (
          <div className="gui-note">
            {gui.status === 'starting'
              ? 'abrindo a sessão…'
              : 'conversa vazia — escreva abaixo para começar'}
          </div>
        )}
        {gui.items.map((item) => (
          <GuiMessage key={item.id} item={item} />
        ))}
        {gui.stream && (
          <div className="gui-msg assistant">
            <div className="gui-msg-text">
              {gui.stream}
              <span className="stream-cursor">▍</span>
            </div>
          </div>
        )}
        {gui.thinking && !gui.stream && (
          <div className="gui-thinking">
            <span className="gui-thinking-dot" />
            pensando{gui.thinkingText ? `: ${gui.thinkingText.slice(-160)}` : '…'}
          </div>
        )}
      </div>

      {!pinned && (
        <button className="gui-to-end" onClick={goToEnd}>
          ▼ ir para o fim
        </button>
      )}

      {gui.perm && (
        <GuiPermCard
          perm={gui.perm}
          onChoose={(behavior) => void answerGuiPerm(projectId, paneId, behavior)}
        />
      )}

      <div className="gui-composer">
        {/* PERMISSÃO POR CONVERSA (onda D): o interruptor global do universo
            morreu — quem decide o quanto o agente pode agir sozinho é cada
            chat, aqui, ao lado do que se vai escrever. */}
        <div className="gui-perm-mode" ref={modeRef}>
          <button
            className={`gui-btn gui-mode-btn mode-${mode}`}
            disabled={dead || modeBusy}
            data-tip={`Permissão desta conversa: ${PERM_MODE_LABEL[mode]}\nTrocar retoma a mesma conversa com a regra nova.`}
            aria-haspopup="menu"
            aria-expanded={modeOpen}
            onClick={() => setModeOpen((v) => !v)}
          >
            ⛭ {modeBusy ? 'trocando…' : PERM_MODE_LABEL[mode]}
          </button>
          {modeOpen && (
            <div className="gui-mode-menu" role="menu">
              {PERM_MODES.map((option) => (
                <button
                  key={option.id}
                  className={`gui-mode-item${option.id === mode ? ' active' : ''}`}
                  role="menuitem"
                  onClick={() => void changeMode(option.id)}
                >
                  <b>{option.label}</b>
                  <span>{option.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <textarea
          ref={inputRef}
          className="gui-input"
          rows={1}
          value={draft}
          disabled={dead}
          placeholder={
            dead
              ? 'sessão encerrada — feche o pane e abra outro'
              : 'escreva aqui · Enter envia · Shift+Enter quebra linha'
          }
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {working ? (
          <button
            className="gui-btn"
            data-tip="Interromper o turno em andamento"
            onClick={() => void interruptGuiPane(paneId)}
          >
            ⏹ parar
          </button>
        ) : (
          <button className="gui-btn primary" disabled={!draft.trim() || dead} onClick={submit}>
            enviar
          </button>
        )}
      </div>
    </div>
  )
}
