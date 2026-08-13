import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_GUI_PANE,
  useStore,
  type GuiItem,
  type GuiPaneStatus,
  type GuiPendingPerm
} from '../store'
import { prettyModel } from './PaneChrome'
import {
  asGuiEvent,
  guiApi,
  type GuiPaneSpawn,
  type GuiPermBehavior,
  type GuiPermissionMode,
  type GuiSessionEvent
} from '../guiApi'

// PANE GUI — o CHAT que substitui a TUI (Synkora 2.0).
//
// O visual é CONTRATO: docs/MOCKUP_WORKSPACE.md § "Anatomia do chat". A regra
// que esta superfície existe para não quebrar de novo ("tá parecendo um pane
// ainda, tá feio"): o chat é PAPEL. `--panel` (o painel escuro) é EXCLUSIVO do
// TerminalPane — nenhuma superfície de conversa o usa. Aqui não há barra de
// pane escura: o cabeçalho da conversa é UMA linha apagada dentro do próprio
// papel, e quem quiser envolver o chat em outro chrome (o layout do Board) só
// desliga `showHeader`.
//
// A regra de ouro do deck continua valendo: a lista de slots é plana e nunca
// se desmonta ao reorganizar — desmontar derrubaria a assinatura de `gui:live`
// e a conversa viva. Este componente NÃO cria PTY nenhum: o motor é uma sessão
// por pane no main (maestroSession/codexSession), comandada por
// `window.synkora.gui`.

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
  /** Papel desta conversa no cabeçalho fino ("dev", "reviewer", "ajudante 2",
   *  "planejamento"). Ausente = deduzido do paneId. */
  role?: string
  /** Lugar desta conversa (branch da missão). Ausente = cauda do cwd. */
  branchLabel?: string
  /** Nome do que foi injetado como 1º prompt ("002-auth.md"). Ausente =
   *  deduzido da 1ª linha do próprio prompt. */
  firstPromptLabel?: string
  /** false = o chat nasce sem o cabeçalho fino (quem envolve o pane já mostra
   *  papel/modelo/branch). O chat NUNCA depende de um chrome externo. */
  showHeader?: boolean
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

// ————— cabeçalho fino da conversa —————

/** Papel deduzido do endereço estável do pane (guiMissionContracts):
 *  `gui-dev-<short>` · `gui-reviewer-<short>` · `gui-helper-<short>-<n>` ·
 *  `gui-plan-<id8>`. Serve de default para quem monta o pane sem passar
 *  `role` — o cabeçalho nunca nasce mudo. */
function roleFromPaneId(paneId: string): string | null {
  const match = /^gui-(dev|reviewer|helper|plan)(?:-|$)/.exec(paneId)
  if (!match) return null
  if (match[1] === 'helper') {
    const n = /-(\d+)$/.exec(paneId)?.[1]
    return n && n !== '1' ? `ajudante ${n}` : 'ajudante'
  }
  return match[1] === 'plan' ? 'planejamento' : match[1]
}

/** Cauda do caminho: o worktree da missão já se chama pela branch. */
function tailOf(path: string): string {
  const parts = path.split(/[\\/]+/u).filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

/** Só o que informa: parado não vira palavra na tela (o mockup mostra a linha
 *  em repouso com três campos e nada mais). */
const STATUS_TEXT: Record<GuiPaneStatus, string | null> = {
  starting: 'abrindo',
  working: 'trabalhando',
  'waiting-you': 'esperando você',
  idle: null,
  dead: 'encerrada'
}

// ————— injeção do 1º prompt —————

/** Nome curto do que foi injetado: a 1ª linha útil do briefing, sem o rótulo
 *  do contrato. Nunca inventa: sem linha legível, cai em "briefing". */
function injectionLabel(prompt: string): string {
  const line = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return 'briefing'
  const clean = line.replace(/^(MISSION|GOAL|SCOPE|PROJECT|PROJETO)\s*:\s*/iu, '').trim()
  const text = clean || line
  return text.length > 64 ? `${text.slice(0, 63)}…` : text
}

// ————— tool cards —————

/** Glifo por FAMÍLIA de ferramenta: o card lê como uma linha de trabalho
 *  ("✎ Edit · src/…"), não como um bloco de terminal. */
function toolGlyph(name: string): string {
  const n = name.toLowerCase()
  if (/(edit|write|notebook|create|update)/u.test(n)) return '✎'
  if (/(read|cat|view|notebookread)/u.test(n)) return '▤'
  if (/(bash|shell|exec|command|run)/u.test(n)) return '❯'
  if (/(grep|glob|search|find)/u.test(n)) return '⌕'
  if (/(web|fetch|http|url)/u.test(n)) return '⇗'
  if (/(task|agent|delegate|helper)/u.test(n)) return '✦'
  if (/(todo|plan)/u.test(n)) return '☰'
  return '▪'
}

function firstLine(text: string, cap: number): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return ''
  return line.length > cap ? `${line.slice(0, cap - 1)}…` : line
}

/**
 * Desfecho à direita do card. NUNCA fabrica número: só promove a contagem que
 * o próprio resultado publica (testes que passaram, linhas inseridas); fora
 * disso o sinal honesto é o ✓ verde (a ferramenta terminou) ou o erro em
 * vermelho com a 1ª linha do motivo.
 */
function toolOutcome(
  result: { text: string; isError: boolean } | undefined
): { tone: 'ok' | 'err'; label: string } | null {
  if (!result) return null
  if (result.isError) return { tone: 'err', label: firstLine(result.text, 34) || 'erro' }
  const text = result.text
  const passed = /(\d+)\s+(?:passed|passing|passaram)/iu.exec(text)
  if (passed) return { tone: 'ok', label: `✓ ${passed[1]} passed` }
  const inserted = /(\d+)\s+(?:insertions?|inserções?|linhas? adicionadas?)/iu.exec(text)
  if (inserted) return { tone: 'ok', label: `+${inserted[1]}` }
  const plus = /(?:^|\n)\s*\+(\d+)\b/u.exec(text)
  if (plus) return { tone: 'ok', label: `+${plus[1]}` }
  return { tone: 'ok', label: '✓' }
}

function GuiToolCard({ item }: { item: Extract<GuiItem, { kind: 'tool' }> }): React.JSX.Element {
  const out = toolOutcome(item.result)
  const row = (
    <>
      <span className={`gui-tool-icon${item.result ? '' : ' run'}`} aria-hidden="true">
        {item.result ? toolGlyph(item.name) : '◌'}
      </span>
      <b className="gui-tool-name">{item.name}</b>
      {item.summary && <span className="gui-tool-sep">·</span>}
      <span className="gui-tool-summary">{item.summary}</span>
      {out && <span className={`gui-tool-out ${out.tone}`}>{out.label}</span>}
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
        <span aria-hidden="true">⛭</span>
        <span>
          {item.toolName}: {PERM_LABEL[item.behavior]}
        </span>
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
  if (item.kind === 'error') return <div className="gui-error">{item.text}</div>
  return (
    <div className="gui-msg dev">
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
  // O mockup pede `permissão: <comando>`: o comando é a descrição quando o CLI
  // a manda (é ela que carrega o `npm test` da vez); o nome da ferramenta vira
  // a etiqueta discreta à direita.
  const command = perm.description.trim() || perm.toolName
  const showTool = Boolean(perm.description.trim())
  return (
    <div className="gui-perm">
      <div className="gui-perm-head">
        <span className="gui-perm-icon" aria-hidden="true">
          ✋
        </span>
        <span className="gui-perm-title">
          permissão: <b>{command}</b>
        </span>
        {showTool && <span className="gui-perm-tool">{perm.toolName}</span>}
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

/** Marcadores de PEDIDO DE ACEITE: o dev fecha o turno com uma pergunta de
 *  seguir/parar (mini-plano, "posso implementar?"). Só aí a linha de ação
 *  inline aparece — pergunta comum de conteúdo continua sendo respondida no
 *  composer, como qualquer conversa. */
const ASK_RE =
  /\b(aprova(?:r|do|ção)?|posso (?:seguir|implementar|começar|continuar|ir)|pode (?:seguir|ir)|sigo|prossigo|confirma|de acordo|fecha(?:do)?\?|segue assim)\b/iu

function asksForGo(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.endsWith('?')) return false
  return ASK_RE.test(trimmed.slice(-320))
}

function MicGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18.2V21.5" />
    </svg>
  )
}

function SendGlyph(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 12h13.5" />
      <path d="m12.5 5.5 6.5 6.5-6.5 6.5" />
    </svg>
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
  onPermissionMode,
  role,
  branchLabel,
  firstPromptLabel,
  showHeader = true
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

  const send = useCallback(
    (text: string): void => {
      const message = text.trim()
      if (!message || dead) return
      pinnedRef.current = true
      setPinned(true)
      void sendGuiMessage(paneId, message)
    },
    [dead, paneId, sendGuiMessage]
  )

  const submit = useCallback((): void => {
    const text = draft.trim()
    if (!text || dead) return
    setDraft('')
    send(text)
  }, [draft, dead, send])

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

  /**
   * DITADO NESTE CHAT: focar o input já o registra como destino do SynVoice
   * (o listener global de `focusin` mora no SynVoice da titlebar); o comando
   * de gravar é o botão real da barra. Sem barra na janela (a WebContentsView
   * dos panes), o foco sozinho continua valendo — a transcrição cai aqui.
   */
  const dictate = useCallback((): void => {
    inputRef.current?.focus({ preventScroll: true })
    const trigger = document.querySelector<HTMLButtonElement>('.synvoice-trigger')
    if (trigger && !trigger.disabled) trigger.click()
  }, [])

  const headRole = role?.trim() || roleFromPaneId(paneId)
  const headModel = gui.model || model
  const headWhere = branchLabel?.trim() || tailOf(cwd)
  const headStatus = STATUS_TEXT[gui.status]

  const injection = useMemo(() => {
    const text = firstPrompt?.trim()
    // Conversa RETOMADA não recebe 1º prompt (o briefing já está lá dentro):
    // anunciar injeção nesse caso seria mentira de tela.
    if (!text || resumeSessionId) return null
    return { label: firstPromptLabel?.trim() || injectionLabel(text), text }
  }, [firstPrompt, firstPromptLabel, resumeSessionId])

  /** Última fala do dev pedindo um "pode seguir" — só com o turno FECHADO e
   *  nada pendente; é isso que torna os botões inline uma resposta, não um
   *  atalho no meio do trabalho. */
  const askingGo = useMemo(() => {
    if (gui.status !== 'idle' || gui.perm || gui.stream) return false
    for (let i = gui.items.length - 1; i >= 0; i -= 1) {
      const item = gui.items[i]
      if (item.kind === 'user') return false
      if (item.kind === 'assistant') return asksForGo(item.text)
    }
    return false
  }, [gui.items, gui.status, gui.perm, gui.stream])

  const empty = gui.items.length === 0 && !gui.stream && !gui.perm && !injection

  return (
    <div className="gui-pane">
      {showHeader && (
        <div className="gui-head">
          {headRole && <span className="gui-head-role">{headRole}</span>}
          {headModel && <span className="gui-head-model">{prettyModel(headModel)}</span>}
          {headWhere && <span className="gui-head-where">{headWhere}</span>}
          {headStatus && <span className={`gui-head-status ${gui.status}`}>{headStatus}</span>}
        </div>
      )}

      {/* O palco é a âncora do "ir para o fim": preso ao .gui-pane, o botão
          cairia POR CIMA do card de permissão (que nasce entre o fio e o
          composer). Aqui ele acompanha o fim do fio, sempre. */}
      <div className="gui-stage">
        <div className="gui-log" ref={logRef} onScroll={onScroll}>
          <div className="gui-thread">
            {empty && (
              <div className="gui-empty">
                {gui.status === 'starting'
                  ? 'abrindo a conversa…'
                  : 'conversa vazia — escreva abaixo para começar'}
              </div>
            )}

            {injection && (
              <details className="gui-inject">
                <summary>
                  <span aria-hidden="true">📄</span>
                  <span className="gui-inject-name">{injection.label}</span>
                  <span className="gui-inject-tag">injetada como 1º prompt</span>
                </summary>
                <pre className="gui-inject-body">{injection.text}</pre>
              </details>
            )}

            {gui.items.map((item) => (
              <GuiMessage key={item.id} item={item} />
            ))}

            {gui.stream && (
              <div className="gui-msg dev stream">
                <div className="gui-msg-text">
                  {gui.stream}
                  <span className="stream-cursor">▍</span>
                </div>
              </div>
            )}

            {gui.thinking && !gui.stream && (
              <div className="gui-thinking">
                <span className="gui-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                pensando{gui.thinkingText ? `: ${gui.thinkingText.slice(-160)}` : '…'}
              </div>
            )}

            {askingGo && (
              <div className="gui-ask">
                <span className="gui-ask-label">esta conversa está esperando você</span>
                <div className="gui-ask-actions">
                  <button className="gui-btn primary" onClick={() => send('aprovado — pode seguir.')}>
                    aprovar
                  </button>
                  <button
                    className="gui-btn"
                    onClick={() => inputRef.current?.focus({ preventScroll: true })}
                  >
                    ajustar
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {!pinned && (
          <button className="gui-to-end" onClick={goToEnd}>
            ▼ ir para o fim
          </button>
        )}
      </div>

      {gui.perm && (
        <GuiPermCard
          perm={gui.perm}
          onChoose={(behavior) => void answerGuiPerm(projectId, paneId, behavior)}
        />
      )}

      <div className="gui-composer">
        <div className="gui-composer-inner">
          {/* PERMISSÃO POR CONVERSA (onda D): o interruptor global do universo
              morreu — quem decide o quanto o agente pode agir sozinho é cada
              chat, aqui, ao lado do que se vai escrever. */}
          <div className="gui-perm-mode" ref={modeRef}>
            <button
              className={`gui-mode-btn mode-${mode}`}
              disabled={dead || modeBusy}
              data-tip={`Permissão desta conversa: ${PERM_MODE_LABEL[mode]}\nTrocar retoma a mesma conversa com a regra nova.`}
              aria-haspopup="menu"
              aria-expanded={modeOpen}
              aria-label={`Permissão desta conversa: ${PERM_MODE_LABEL[mode]}`}
              onClick={() => setModeOpen((v) => !v)}
            >
              <span aria-hidden="true">⛭</span>
              <span className="gui-mode-text">{modeBusy ? 'trocando…' : PERM_MODE_LABEL[mode]}</span>
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
            aria-label="Mensagem para esta conversa"
            placeholder={
              dead
                ? 'sessão encerrada — feche o pane e abra outro'
                : 'dirija o dev — ou peça um reviewer'
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault()
                submit()
              }
            }}
          />

          <button
            className="gui-sq gui-mic"
            disabled={dead}
            data-tip="Ditar neste chat (SynVoice)"
            aria-label="Ditar neste chat"
            onClick={dictate}
          >
            <MicGlyph />
          </button>

          {working ? (
            <button
              className="gui-sq gui-send stop"
              data-tip="Interromper o turno em andamento"
              aria-label="Interromper o turno"
              onClick={() => void interruptGuiPane(paneId)}
            >
              ■
            </button>
          ) : (
            <button
              className="gui-sq gui-send"
              disabled={!draft.trim() || dead}
              data-tip="Enviar · Enter"
              aria-label="Enviar mensagem"
              onClick={submit}
            >
              <SendGlyph />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
