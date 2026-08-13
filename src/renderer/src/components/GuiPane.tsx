import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_GUI_PANE,
  useStore,
  type GuiItem,
  type GuiPaneStatus,
  type GuiPendingPerm,
  type Seat
} from '../store'
import { prettyModel } from './PaneChrome'
import CliMark from './CliMark'
import GuiMarkdown from './GuiMarkdown'
import GuiStreamText from './GuiStreamText'
import GuiQuestionCard from './GuiQuestionCard'
import GuiPlanCard from './GuiPlanCard'
import GuiSlashMenu, { filterSlashCommands, slashName, slashQueryAt } from './GuiSlashMenu'
import {
  asGuiEvent,
  guiApi,
  type GuiCliCommand,
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
// TerminalPane — nenhuma superfície de conversa o usa.
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
  /** modelo/effort trocados no composer — mesma razão do modo acima. */
  onExecutorChange?: (patch: { model?: string; effort?: string }) => void
  /** contas disponíveis + a desta conversa: o cabeçalho troca a conta sem
   *  sair do chat (ausente = o cabeçalho não oferece troca). */
  seats?: Seat[]
  seatId?: string
  onChangeSeat?: (seatId: string) => void
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

// ————— cabeçalho da conversa —————

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

/** Ferramentas cujo card genérico NÃO se mostra: elas têm superfície própria
 *  (o card de pergunta e o card de plano). O ITEM continua na lista — o
 *  pareamento do tool-result depende da ordem —, só não se desenha. */
const INTERACTIVE_TOOLS = new Set(['askuserquestion', 'exitplanmode', 'exit_plan_mode'])

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
 *  frase de uma linha para o menu — o dono escolhe SEM abrir documentação.
 *  O glifo carrega a identidade (o dono pediu os modos bonitos): mão que
 *  pergunta, lápis que edita, seta que segue reto, prancheta que só planeja. */
const PERM_MODES: { id: GuiPermissionMode; label: string; glyph: string; hint: string }[] = [
  { id: 'default', label: 'padrão', glyph: '✋', hint: 'pergunta antes de agir fora do combinado' },
  {
    id: 'acceptEdits',
    label: 'edições',
    glyph: '✎',
    hint: 'edita arquivos sem perguntar; o resto pergunta'
  },
  { id: 'bypass', label: 'bypass', glyph: '⏩', hint: 'segue reto, sem nenhuma aprovação' },
  { id: 'plan', label: 'plano', glyph: '☰', hint: 'só estuda e propõe — não escreve nada' }
]

const PERM_MODE_LABEL: Record<GuiPermissionMode, string> = {
  default: 'padrão',
  acceptEdits: 'edições',
  bypass: 'bypass',
  plan: 'plano'
}

const PERM_MODE_GLYPH: Record<GuiPermissionMode, string> = {
  default: '✋',
  acceptEdits: '✎',
  bypass: '⏩',
  plan: '☰'
}

const PERM_LABEL: Record<GuiPermBehavior | 'cancelada', string> = {
  allow: 'permitido desta vez',
  'allow-always': 'permitido sempre (nesta sessão)',
  deny: 'negado',
  cancelada: 'cancelado pelo CLI'
}

function GuiMessage({ item }: { item: GuiItem }): React.JSX.Element | null {
  if (item.kind === 'tool') {
    if (INTERACTIVE_TOOLS.has(item.name.toLowerCase())) return null
    return <GuiToolCard item={item} />
  }
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
  if (item.kind === 'question') {
    return (
      <div className="gui-answered">
        <span className="ga-head">
          <span aria-hidden="true">❓</span>
          {item.header?.trim() || 'pergunta respondida'}
        </span>
        {item.entries.length === 0 ? (
          <span className="ga-skip">você pulou</span>
        ) : (
          <span className="ga-chips">
            {item.entries.map((entry) => (
              <span key={entry.question} className="ga-chip" data-tip={entry.question}>
                {entry.answer}
              </span>
            ))}
          </span>
        )}
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
      <div className="gui-msg-text">
        <GuiMarkdown text={item.text} />
      </div>
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
  onExecutorChange,
  seats,
  seatId,
  onChangeSeat,
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
  const answerGuiQuestion = useStore((s) => s.answerGuiQuestion)
  const answerGuiPlan = useStore((s) => s.answerGuiPlan)
  const interruptGuiPane = useStore((s) => s.interruptGuiPane)

  // MODO DE PERMISSÃO (onda D) + MODELO/EFFORT (2.0): estado local para os
  // botões responderem na hora, semeados pela spec. O pai guarda a escolha na
  // spec dele — por isso os efeitos só re-semeiam quando a PROP muda.
  const [mode, setMode] = useState<GuiPermissionMode>(permissionMode ?? 'default')
  const [openMenu, setOpenMenu] = useState<'mode' | 'model' | 'effort' | 'seat' | null>(null)
  const [busyMenu, setBusyMenu] = useState<'mode' | 'model' | 'effort' | null>(null)
  const [liveModel, setLiveModel] = useState<string | undefined>(model)
  const [liveEffort, setLiveEffort] = useState<string | undefined>(effort)
  useEffect(() => {
    setMode(permissionMode ?? 'default')
  }, [permissionMode])
  useEffect(() => {
    setLiveModel(model)
  }, [model])
  useEffect(() => {
    setLiveEffort(effort)
  }, [effort])

  // A spec do spawn muda no MÁXIMO junto com o pane; guardá-la em ref evita
  // que uma prop nova re-dispare o efeito de montagem (que reabriria sessão).
  const spawnRef = useRef<GuiPaneSpawn>({
    paneId,
    projectId,
    cli,
    configDir: configDir ?? '',
    seatId,
    cwd,
    model: liveModel,
    effort: liveEffort,
    systemPrompt,
    resumeSessionId,
    firstPrompt,
    permissionMode: mode
  })

  spawnRef.current = {
    paneId,
    projectId,
    cli,
    configDir: configDir ?? '',
    seatId,
    cwd,
    model: liveModel,
    effort: liveEffort,
    systemPrompt,
    resumeSessionId,
    firstPrompt,
    permissionMode: mode
  }

  const [draft, setDraft] = useState('')
  const [pinned, setPinned] = useState(true)
  const [slashIndex, setSlashIndex] = useState(0)
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
  }, [gui.items, gui.stream, gui.thinking, gui.perm, gui.question, gui.planReview])

  // textarea que cresce com o texto (Enter envia, Shift+Enter quebra linha).
  // Teto alto e SEM barra de rolagem (ordem do dono): a caixa cresce até um
  // terço da tela em vez de virar uma janelinha com scroll.
  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(300, ta.scrollHeight)}px`
  }, [draft])

  const dead = gui.status === 'dead'
  const working = gui.status === 'working' || gui.status === 'starting'
  // Pergunta e plano SUSPENDEM o composer: é a linguagem do Claude GUI que o
  // dono pediu — o que está na tela é a coisa a responder, não uma caixa de
  // texto que compete com ela.
  const awaitingCard = Boolean(gui.question || gui.planReview)

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

  // ————— autocomplete de comandos —————
  const slashQuery = useMemo(() => {
    if (!draft.startsWith('/') && !/\s\/\S*$/u.test(draft)) return null
    const el = inputRef.current
    const cursor = el ? el.selectionStart : draft.length
    return slashQueryAt(draft, cursor ?? draft.length)
  }, [draft])

  const slashMatches = useMemo(() => {
    if (!slashQuery || !gui.caps?.commands?.length) return []
    return filterSlashCommands(gui.caps.commands, slashQuery.query).slice(0, 40)
  }, [gui.caps, slashQuery])

  const slashOpen = slashMatches.length > 0
  useEffect(() => {
    setSlashIndex(0)
  }, [slashQuery?.query])

  /** Completar NUNCA envia: insere `/nome ` e devolve o cursor ao composer —
   *  os argumentos vêm depois, digitados por quem chamou. */
  const pickCommand = useCallback(
    (command: GuiCliCommand): void => {
      if (!slashQuery) return
      const el = inputRef.current
      const cursor = el?.selectionStart ?? draft.length
      const before = draft.slice(0, slashQuery.at)
      const after = draft.slice(cursor)
      const inserted = `${slashName(command)} `
      setDraft(`${before}${inserted}${after}`)
      window.setTimeout(() => {
        const pos = before.length + inserted.length
        el?.focus({ preventScroll: true })
        el?.setSelectionRange(pos, pos)
      }, 0)
    },
    [draft, slashQuery]
  )

  const submit = useCallback((): void => {
    const text = draft.trim()
    if (!text || dead) return
    setDraft('')
    send(text)
  }, [draft, dead, send])

  /**
   * TROCA EM VOO (modo, modelo, effort): re-emite `gui:create` com o MESMO
   * paneId e o campo novo. O motor trata a mudança de fingerprint respawnando
   * a sessão COM resume — a conversa continua, a régua é outra. A linha no
   * transcript existe porque uma troca silenciosa seria indistinguível de bug.
   */
  const applySpawnChange = useCallback(
    async (
      which: 'mode' | 'model' | 'effort',
      patch: Partial<GuiPaneSpawn>,
      okText: string
    ): Promise<void> => {
      setOpenMenu(null)
      if (busyMenu || dead) return
      setBusyMenu(which)
      const res = await guiApi.create({ ...spawnRef.current, ...patch })
      setBusyMenu(null)
      handleGuiLive(
        paneId,
        res.ok
          ? { type: 'command-output', text: `${okText} — sessão retomada` }
          : {
              type: 'limit',
              text: `não deu para aplicar a troca: ${res.error ?? 'motivo desconhecido'}`
            }
      )
    },
    [busyMenu, dead, handleGuiLive, paneId]
  )

  const changeMode = useCallback(
    (next: GuiPermissionMode): void => {
      if (next === mode) {
        setOpenMenu(null)
        return
      }
      setMode(next)
      onPermissionMode?.(next)
      void applySpawnChange(
        'mode',
        { permissionMode: next },
        `modo de permissão: ${PERM_MODE_LABEL[next]}`
      )
    },
    [applySpawnChange, mode, onPermissionMode]
  )

  const changeModel = useCallback(
    (next: string): void => {
      if (next === (liveModel ?? '')) {
        setOpenMenu(null)
        return
      }
      const value = next || undefined
      // Modelo novo pode não ter o effort atual — carregar um nível que ele
      // não suporta faria o spawn nascer recusado pelo CLI.
      const supported =
        gui.caps?.models.find((m) => m.value === value)?.supportedEffortLevels ?? []
      const keepEffort = liveEffort && supported.includes(liveEffort) ? liveEffort : undefined
      setLiveModel(value)
      setLiveEffort(keepEffort)
      onExecutorChange?.({ model: value, effort: keepEffort })
      void applySpawnChange(
        'model',
        { model: value, effort: keepEffort },
        `modelo: ${value ? prettyModel(value) : 'padrão da conta'}`
      )
    },
    [applySpawnChange, gui.caps, liveEffort, liveModel, onExecutorChange]
  )

  const changeEffort = useCallback(
    (next: string): void => {
      if (next === (liveEffort ?? '')) {
        setOpenMenu(null)
        return
      }
      const value = next || undefined
      setLiveEffort(value)
      onExecutorChange?.({ effort: value })
      void applySpawnChange('effort', { effort: value }, `effort: ${value ?? 'padrão do modelo'}`)
    },
    [applySpawnChange, liveEffort, onExecutorChange]
  )

  // fechar menus clicando fora (mesmo padrão dos dropdowns do app)
  const paneRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!openMenu) return
    const onDocDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!paneRef.current?.contains(target)) {
        setOpenMenu(null)
        return
      }
      if (!(target instanceof Element)) return
      if (!target.closest('.gui-menu-host')) setOpenMenu(null)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [openMenu])

  const goToEnd = useCallback((): void => {
    const el = logRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    pinnedRef.current = true
    setPinned(true)
  }, [])

  const headRole = role?.trim() || roleFromPaneId(paneId)
  const headModel = gui.model || liveModel
  const headWhere = branchLabel?.trim() || tailOf(cwd)
  const headStatus = STATUS_TEXT[gui.status]
  const account = gui.caps?.account
  const seat = seats?.find((s) => s.id === seatId)
  const modelOptions = gui.caps?.models ?? []
  const effortOptions =
    modelOptions.find((m) => m.value === (liveModel ?? ''))?.supportedEffortLevels ?? []

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
    if (gui.status !== 'idle' || gui.perm || gui.stream || awaitingCard) return false
    for (let i = gui.items.length - 1; i >= 0; i -= 1) {
      const item = gui.items[i]
      if (item.kind === 'user') return false
      if (item.kind === 'assistant') return asksForGo(item.text)
    }
    return false
  }, [gui.items, gui.status, gui.perm, gui.stream, awaitingCard])

  const empty = gui.items.length === 0 && !gui.stream && !gui.perm && !injection && !awaitingCard

  return (
    <div className="gui-pane" ref={paneRef}>
      {showHeader && (
        <div className="gui-head">
          <span className="gui-head-cli" aria-hidden="true">
            <CliMark cli={cli} size={13} />
          </span>
          {headRole && <span className="gui-head-role">{headRole}</span>}

          {/* A CONTA da conversa: clicar troca de seat sem sair do chat. */}
          {seats?.length && onChangeSeat ? (
            <span className="gui-menu-host gui-head-seat">
              <button
                className={`gui-head-seat-btn${openMenu === 'seat' ? ' open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'seat'}
                data-tip={'Conta desta conversa. Trocar mantém a conversa quando o CLI é o mesmo.'}
                onClick={() => setOpenMenu((v) => (v === 'seat' ? null : 'seat'))}
              >
                <span className="ghs-name">{seat?.name ?? 'escolher conta'}</span>
                {account?.email && <span className="ghs-mail">{account.email}</span>}
                {account?.subscriptionType && (
                  <span className="ghs-plan">{account.subscriptionType}</span>
                )}
                <span className="ghs-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {openMenu === 'seat' && (
                <div className="gui-menu gui-seat-menu" role="menu">
                  {seats.map((option) => (
                    <button
                      key={option.id}
                      className={`gui-menu-item${option.id === seatId ? ' active' : ''}`}
                      role="menuitem"
                      onClick={() => {
                        setOpenMenu(null)
                        if (option.id !== seatId) onChangeSeat(option.id)
                      }}
                    >
                      <CliMark cli={option.cli} size={12} />
                      <b>{option.name}</b>
                      <span>{option.cli}</span>
                    </button>
                  ))}
                  <span className="gui-menu-foot">
                    mesma família de CLI: a conversa vai junto para a conta nova · CLI diferente: a
                    conversa recomeça
                  </span>
                </div>
              )}
            </span>
          ) : (
            seat?.name && <span className="gui-head-where">{seat.name}</span>
          )}

          {headModel && <span className="gui-head-model">{prettyModel(headModel)}</span>}
          {liveEffort && <span className="gui-head-effort">{liveEffort}</span>}
          {headWhere && <span className="gui-head-where">{headWhere}</span>}
          {headStatus && (
            <span className={`gui-head-status ${gui.status}`}>
              <i className="ghs-dot" aria-hidden="true" />
              {headStatus}
            </span>
          )}
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

            {gui.stream && <GuiStreamText text={gui.stream} />}

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

            {gui.planReview && (
              <GuiPlanCard
                plan={gui.planReview.plan}
                onDecide={(approve) => void answerGuiPlan(projectId, paneId, approve)}
              />
            )}

            {gui.question && (
              <GuiQuestionCard
                questions={gui.question.questions}
                onAnswer={(answers) => void answerGuiQuestion(projectId, paneId, answers)}
                onSkip={() => void answerGuiQuestion(projectId, paneId, {})}
              />
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

      {!awaitingCard && (
        <div className="gui-composer">
          {slashOpen && (
            <GuiSlashMenu
              commands={slashMatches}
              index={slashIndex}
              onPick={pickCommand}
              onHover={setSlashIndex}
            />
          )}
          <div className="gui-composer-inner">
            {/* A FAMÍLIA DE CONTROLES da conversa: permissão · modelo · effort.
                O interruptor global do universo morreu — quem decide o quanto o
                agente pode agir, e com que motor, é cada chat, aqui. */}
            <div className="gui-menu-host">
              <button
                className={`gui-mode-btn mode-${mode}`}
                disabled={dead || Boolean(busyMenu)}
                data-tip={`Permissão desta conversa: ${PERM_MODE_LABEL[mode]}\nTrocar retoma a mesma conversa com a regra nova.`}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'mode'}
                aria-label={`Permissão desta conversa: ${PERM_MODE_LABEL[mode]}`}
                onClick={() => setOpenMenu((v) => (v === 'mode' ? null : 'mode'))}
              >
                <span aria-hidden="true">{PERM_MODE_GLYPH[mode]}</span>
                <span className="gui-mode-text">
                  {busyMenu === 'mode' ? 'trocando…' : PERM_MODE_LABEL[mode]}
                </span>
              </button>
              {openMenu === 'mode' && (
                <div className="gui-menu gui-mode-menu" role="menu">
                  {PERM_MODES.map((option) => (
                    <button
                      key={option.id}
                      className={`gui-menu-item mode-${option.id}${
                        option.id === mode ? ' active' : ''
                      }`}
                      role="menuitem"
                      onClick={() => changeMode(option.id)}
                    >
                      <span className="gmi-glyph" aria-hidden="true">
                        {option.glyph}
                      </span>
                      <b>{option.label}</b>
                      <span>{option.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="gui-menu-host">
              <button
                className="gui-mode-btn mode-model"
                disabled={dead || Boolean(busyMenu)}
                data-tip={'Modelo desta conversa.\nTrocar retoma a mesma conversa no modelo novo.'}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'model'}
                onClick={() => setOpenMenu((v) => (v === 'model' ? null : 'model'))}
              >
                <span aria-hidden="true">◆</span>
                <span className="gui-mode-text">
                  {busyMenu === 'model'
                    ? 'trocando…'
                    : liveModel
                      ? prettyModel(liveModel)
                      : 'modelo'}
                </span>
              </button>
              {openMenu === 'model' && (
                <div className="gui-menu gui-mode-menu" role="menu">
                  <button
                    className={`gui-menu-item${liveModel ? '' : ' active'}`}
                    role="menuitem"
                    onClick={() => changeModel('')}
                  >
                    <b>padrão da conta</b>
                    <span>o modelo que o CLI escolher</span>
                  </button>
                  {modelOptions.map((option) => (
                    <button
                      key={option.value}
                      className={`gui-menu-item${option.value === liveModel ? ' active' : ''}`}
                      role="menuitem"
                      onClick={() => changeModel(option.value)}
                    >
                      <b>{option.displayName || option.value}</b>
                      {option.description && <span>{option.description}</span>}
                    </button>
                  ))}
                  {modelOptions.length === 0 && (
                    <span className="gui-menu-foot">
                      a lista de modelos chega quando o CLI termina de abrir
                    </span>
                  )}
                </div>
              )}
            </div>

            {effortOptions.length > 0 && (
              <div className="gui-menu-host">
                <button
                  className="gui-mode-btn mode-effort"
                  disabled={dead || Boolean(busyMenu)}
                  data-tip={'Esforço de raciocínio desta conversa.'}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === 'effort'}
                  onClick={() => setOpenMenu((v) => (v === 'effort' ? null : 'effort'))}
                >
                  <span aria-hidden="true">◇</span>
                  <span className="gui-mode-text">
                    {busyMenu === 'effort' ? 'trocando…' : (liveEffort ?? 'effort')}
                  </span>
                </button>
                {openMenu === 'effort' && (
                  <div className="gui-menu gui-mode-menu" role="menu">
                    <button
                      className={`gui-menu-item${liveEffort ? '' : ' active'}`}
                      role="menuitem"
                      onClick={() => changeEffort('')}
                    >
                      <b>padrão do modelo</b>
                    </button>
                    {effortOptions.map((option) => (
                      <button
                        key={option}
                        className={`gui-menu-item${option === liveEffort ? ' active' : ''}`}
                        role="menuitem"
                        onClick={() => changeEffort(option)}
                      >
                        <b>{option}</b>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

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
                  : 'dirija o dev — / abre os comandos'
              }
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // O menu de comandos manda no teclado enquanto está aberto:
                // Enter ali COMPLETA, nunca envia.
                if (slashOpen) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSlashIndex((i) => (i + 1) % slashMatches.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
                    return
                  }
                  if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault()
                    pickCommand(slashMatches[slashIndex] ?? slashMatches[0])
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setSlashIndex(0)
                    setDraft((text) => `${text} `)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                  e.preventDefault()
                  submit()
                }
              }}
            />

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
      )}
    </div>
  )
}
