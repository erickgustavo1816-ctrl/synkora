import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_GUI_PANE,
  useStore,
  type GuiItem,
  type GuiPaneStatus,
  type GuiPendingPerm,
  type Seat
} from '../store'
import { formatGuiElapsed } from '../guiActivity'
import { prettyModel } from './PaneChrome'
import CliMark from './CliMark'
import GuiMarkdown from './GuiMarkdown'
import GuiStreamText from './GuiStreamText'
import GuiQuestionCard from './GuiQuestionCard'
import GuiPlanCard from './GuiPlanCard'
import GuiPlanProposalCard from './GuiPlanProposalCard'
import { GuiToolCard, GuiToolGroupCard } from './GuiToolCard'
import GuiMessageCopy from './GuiMessageCopy'
import GuiErrorLine from './GuiErrorLine'
import GuiQueuedMessageCard from './GuiQueuedMessageCard'
import GuiAttachmentChips from './GuiAttachmentChips'
import GuiJsonCard from './GuiJsonCard'
import GuiSlashMenu from './GuiSlashMenu'
import GuiContextPanel from './GuiContextPanel'
import GuiDelegationDefaults from './GuiDelegationDefaults'
import GuiFileMentionMenu from './GuiFileMentionMenu'
import GuiMentionOverlay from './GuiMentionOverlay'
import { guiPaneDelegates } from '../guiDelegationDefaults'
import {
  completeSlashCommand,
  filterSlashCommands,
  isSlashQueryDismissed,
  slashDismissalAt,
  slashQueryAt,
  type SlashDismissal
} from '../guiSlashAutocomplete'
import { syncInputOverlayScroll } from '../guiFileMentions'
import { useGuiFileMentions } from '../useGuiFileMentions'
import { guiCopyableAssistantId } from '../guiMessageCopyPresentation'
import { guiThinkingPresentation } from '../guiThinkingPresentation'
import { guiBackgroundWorkPresentation } from '../guiBackgroundWorkPresentation'
import {
  groupConsecutiveGuiTools,
  type GuiPresentationItem,
  type GuiRenderItem
} from '../guiToolPresentation'
import { nestGuiSubagentTools } from '../guiSubagentPresentation'
import { normalizeGuiSubagentSidebar } from '../guiSubagentSidebar'
import { guiHistoryPageRequest, guiPrunedNoticeText } from '../guiHistoryReader'
import {
  noteGuiPaneInteraction,
  registerGuiEscapeTarget
} from '../guiEscape'
import {
  canComposeGuiMessage,
  canSendGuiMessage,
  guiDeadComposerPlaceholder,
  isGuiTurnActive,
  needsGuiReviveBeforeSend,
  shouldApplyGuiBufferedEvent,
  shouldCreateGuiSession
} from '../guiTransport'
import {
  appendGuiPresentationSeq,
  isGuiPresentationTerminal,
  isGuiTranscriptPresented
} from '../guiPresentation'
import {
  GUI_PROMPT_MAX_CHARS,
  asGuiEvent,
  guiApi,
  type GuiCliCommand,
  type GuiPaneSpawn,
  type GuiPermBehavior,
  type GuiPermissionMode,
  type GuiSessionEvent
} from '../guiApi'
import { useGuiDraft } from '../useGuiDraft'
import { useGuiComposerAttachments } from '../useGuiComposerAttachments'
import type { GuiAttachmentDescriptor } from '../../../preload'
import {
  guiContextUsagePresentation,
  guiModelForSelection,
  guiModelIsDefault,
  guiModelLabel,
  guiModelShortName
} from '../guiComposerPresentation'
import { guiContextPanelPresentation } from '../guiContextPanel'
import {
  GUI_COMPOSER_ATTACHMENT_MAX_FILES,
  GUI_COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES,
  base64FromDataUrl,
  planGuiAttachmentBatch
} from '../guiComposerAttachments'
import { shouldBlurGuiComposerOnOutsidePointerDown } from '../guiComposerFocus'
import { guiAwaitingGoDecision } from '../guiAskForGo'
import { guiComposerClearPlan } from '../guiComposerDelivery'
import { parseGuiJsonCard } from '../guiJsonCard'
import { useGuiTranscriptWindow } from '../useGuiTranscriptWindow'

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
  /** briefing da missão: NÃO abre turno — o motor o segura e envia colado à
   *  primeira mensagem do dono. Aqui ele só é anunciado no fio. */
  firstPrompt?: string
  /** modo de permissão DESTA conversa (onda D) — ausente = 'default' */
  permissionMode?: GuiPermissionMode
  /** R11: modo FAST desta conversa — flag de spawn como o permissionMode
   *  (trocar respawna com resume). Ausente = off. */
  fast?: boolean
  /** ferramentas Synkora deste pane (só a missão de planejamento recebe). O
   *  pane não as interpreta: leva o campo intacto de volta ao `gui:create`. */
  mcp?: GuiPaneSpawn['mcp']
  /** o dono da spec guarda a escolha: sem isto, remontar o slot voltaria ao
   *  modo antigo enquanto a sessão no main já está no novo. */
  onPermissionMode?: (mode: GuiPermissionMode) => void
  /** R11: o dono da spec guarda a escolha do fast (par do onPermissionMode). */
  onFastMode?: (fast: boolean) => void
  /** modelo/effort trocados no composer — mesma razão do modo acima. */
  onExecutorChange?: (patch: { model?: string; effort?: string }) => void
  /** contas disponíveis + a desta conversa: o cabeçalho troca a conta sem
   *  sair do chat (ausente = o cabeçalho não oferece troca). */
  seats?: Seat[]
  seatId?: string
  onChangeSeat?: (seatId: string) => void
  /** troca de conta em voo: bloqueia duplo clique e mostra falha no próprio chat */
  seatChanging?: boolean
  seatError?: string
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
  /** Visibilidade real no deck; o main usa para o título `[pronto]`. */
  active?: boolean
  /** FOTOGRAFIA CONGELADA (missão encerrada, aba Versões): o pane replaya o
   *  transcript gravado e NÃO abre sessão nenhuma — nada de composer, de
   *  cards de decisão nem de troca de conta. Ler não pode ressuscitar. */
  readOnly?: boolean
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

/** Ferramentas cujo card genérico NÃO se mostra: elas têm superfície própria
 *  (o card de pergunta e o card de plano). O ITEM continua na lista — o
 *  pareamento do tool-result depende da ordem —, só não se desenha. */
const INTERACTIVE_TOOLS = new Set([
  'askuserquestion',
  'exitplanmode',
  'exit_plan_mode',
  // a proposta de plano tem card próprio (rico, com as missões abrindo): o
  // card cru da tool mostraria o mesmo JSON ao lado dele
  'propose_plan',
  'mcp__synkora__propose_plan'
])

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
  {
    id: 'bypass',
    label: 'acesso completo',
    glyph: '!',
    hint: 'acesso irrestrito à internet e a qualquer arquivo no seu computador'
  },
  { id: 'plan', label: 'plano', glyph: '☰', hint: 'só estuda e propõe — não escreve nada' }
]

const PERM_MODE_LABEL: Record<GuiPermissionMode, string> = {
  default: 'padrão',
  acceptEdits: 'edições',
  bypass: 'acesso completo',
  plan: 'plano'
}

const PERM_MODE_GLYPH: Record<GuiPermissionMode, string> = {
  default: '✋',
  acceptEdits: '✎',
  bypass: '!',
  plan: '☰'
}

const PERM_LABEL: Record<GuiPermBehavior | 'cancelada', string> = {
  allow: 'permitido desta vez',
  'allow-always': 'permitido sempre (nesta sessão)',
  deny: 'negado',
  cancelada: 'cancelado pelo CLI'
}

function GuiMessage({
  paneId,
  item,
  showCopy,
  onRevealComplete,
  onRevealProgress
}: {
  paneId: string
  item: GuiItem
  showCopy: boolean
  onRevealComplete: (itemId: string, length: number) => void
  onRevealProgress: () => void
}): React.JSX.Element | null {
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
        <GuiAttachmentChips
          attachments={item.attachments ?? []}
          className="gui-msg-attachments"
          paneId={paneId}
          presented
        />
        <div className="gui-msg-text">{item.text}</div>
      </div>
    )
  }
  if (item.kind === 'note') return <div className="gui-note">{item.text}</div>
  if (item.kind === 'error') return <GuiErrorLine text={item.text} />
  if (item.kind !== 'assistant') return null
  const revealing = item.live || item.animateFrom < item.text.length
  if (revealing) {
    return (
      <GuiStreamText
        paneId={paneId}
        text={item.text}
        initialShown={item.animateFrom}
        complete={!item.live}
        onComplete={() => onRevealComplete(item.id, item.text.length)}
        onProgress={onRevealProgress}
      />
    )
  }
  const jsonCard = parseGuiJsonCard(item.text)
  return (
    <div className="gui-msg dev">
      <div className="gui-msg-text">
        {jsonCard ? (
          <GuiJsonCard formatted={jsonCard.formatted} />
        ) : (
          <GuiMarkdown paneId={paneId} text={item.text} />
        )}
      </div>
      {showCopy && item.text.trim() && (
        <GuiMessageCopy markdown={item.text} />
      )}
    </div>
  )
}

type GuiThreadRenderItem = GuiRenderItem

/** Subagente pertence exclusivamente à lateral enquanto trabalha. A árvore
 *  factual continua no store para status/pareamento, mas raiz e descendentes
 *  não interrompem nem duplicam a conversa principal. */
function guiThreadRenderItems(items: readonly GuiItem[]): GuiThreadRenderItem[] {
  const rendered: GuiThreadRenderItem[] = []
  let regular: GuiPresentationItem[] = []
  const flush = (): void => {
    rendered.push(...groupConsecutiveGuiTools(regular))
    regular = []
  }
  for (const item of nestGuiSubagentTools(items)) {
    if (item.kind === 'subagent') {
      flush()
      continue
    }
    if (item.kind === 'tool' && item.subagent) {
      flush()
      continue
    }
    // Filho cujo pai saiu da janela (poda do cap, replay parcial) não vira raiz
    // do chat: a linhagem declarada basta para ele continuar sendo do agente.
    if (item.kind === 'tool' && item.parentToolUseId) {
      flush()
      continue
    }
    regular.push(item)
  }
  flush()
  return rendered
}

function GuiPermCard({
  perm,
  onChoose,
  disabled = false
}: {
  perm: GuiPendingPerm
  onChoose: (behavior: GuiPermBehavior) => void
  disabled?: boolean
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
      {perm.permissionRule && (
        <div className="gui-perm-rule">
          sempre vai gravar: <code>{perm.permissionRule}</code>
        </div>
      )}
      {perm.inputPretty && perm.inputPretty !== '{}' && (
        <details className="gui-perm-input">
          <summary>ver o pedido completo</summary>
          <pre className="gui-tool-detail">{perm.inputPretty}</pre>
        </details>
      )}
      <div className="gui-perm-actions">
        <button className="gui-btn primary" disabled={disabled} onClick={() => onChoose('allow')}>
          permitir
        </button>
        {perm.canAlways && (
          <button className="gui-btn" disabled={disabled} onClick={() => onChoose('allow-always')}>
            sempre
          </button>
        )}
        <button className="gui-btn deny" disabled={disabled} onClick={() => onChoose('deny')}>
          negar
        </button>
      </div>
    </div>
  )
}

/** Os dois glifos do botão de envio moram na MESMA grade de 16, desenhados à
 *  mão em SVG inline — sem emoji, sem biblioteca de ícones. Mesma caixa nos dois
 *  estados: trocar enviar por interromper no meio do turno não move um pixel do
 *  rodapé. O traço de 2 unidades cai em pixel inteiro no tamanho de render, que
 *  é o que mantém a seta nítida ao lado da tipografia mono. */
function SendGlyph(): React.JSX.Element {
  return (
    <svg
      className="gui-send-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 8h9" />
      <path d="m8.5 4.5 3.5 3.5-3.5 3.5" />
    </svg>
  )
}

function StopGlyph(): React.JSX.Element {
  return (
    <svg
      className="gui-send-glyph"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  )
}

function readGuiFileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`não deu para ler ${file.name}`))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? base64FromDataUrl(reader.result) : null
      if (!result) {
        reject(new Error(`não deu para ler ${file.name}`))
        return
      }
      resolve(result)
    }
    reader.readAsDataURL(file)
  })
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
  fast,
  mcp,
  onPermissionMode,
  onFastMode,
  onExecutorChange,
  seats,
  seatId,
  onChangeSeat,
  seatChanging = false,
  seatError,
  role,
  branchLabel,
  firstPromptLabel,
  showHeader = true,
  active = false,
  readOnly = false
}: Props): React.JSX.Element {
  const slashMenuId = useId()
  const mentionMenuId = useId()
  const gui = useStore((s) => s.guiPanes[paneId]) ?? EMPTY_GUI_PANE
  const handleGuiLive = useStore((s) => s.handleGuiLive)
  const replayGuiPane = useStore((s) => s.replayGuiPane)
  const markGuiSpawned = useStore((s) => s.markGuiSpawned)
  const finishGuiReveal = useStore((s) => s.finishGuiReveal)
  const queueGuiMessage = useStore((s) => s.queueGuiMessage)
  const discardGuiQueuedMessage = useStore((s) => s.discardGuiQueuedMessage)
  const retryGuiQueuedMessage = useStore((s) => s.retryGuiQueuedMessage)
  const claimGuiQueuedMessage = useStore((s) => s.claimGuiQueuedMessage)
  const acknowledgeGuiQueuedMessage = useStore((s) => s.acknowledgeGuiQueuedMessage)
  const restoreGuiQueuedMessage = useStore((s) => s.restoreGuiQueuedMessage)
  const sendGuiMessage = useStore((s) => s.sendGuiMessage)
  const answerGuiPerm = useStore((s) => s.answerGuiPerm)
  const answerGuiQuestion = useStore((s) => s.answerGuiQuestion)
  const answerGuiPlan = useStore((s) => s.answerGuiPlan)
  const answerGuiPlanProposal = useStore((s) => s.answerGuiPlanProposal)
  const interruptGuiPane = useStore((s) => s.interruptGuiPane)
  const historyTarget = useStore((s) =>
    s.guiHistoryTarget?.paneId === paneId ? s.guiHistoryTarget : null
  )
  const clearGuiHistoryTarget = useStore((s) => s.clearGuiHistoryTarget)
  const showGuiHistoryTarget = useStore((s) => s.showGuiHistoryTarget)
  const appendGuiHistoryPage = useStore((s) => s.appendGuiHistoryPage)

  useEffect(() => {
    // Fotografia congelada não tem sessão do outro lado: anunciar visibilidade
    // alimentaria o título `[pronto]` de um pane que não vai ficar pronto.
    if (readOnly) return
    guiApi.visibility(paneId, active)
    return () => guiApi.visibility(paneId, false)
  }, [active, paneId, readOnly])

  // MODO DE PERMISSÃO (onda D) + MODELO/EFFORT (2.0): estado local para os
  // botões responderem na hora, semeados pela spec. O pai guarda a escolha na
  // spec dele — por isso os efeitos só re-semeiam quando a PROP muda.
  const [mode, setMode] = useState<GuiPermissionMode>(permissionMode ?? 'default')
  // R11: o fast segue o padrão do mode — estado local semeado pela prop, o
  // dono da spec guarda a escolha via onFastMode.
  const [fastOn, setFastOn] = useState<boolean>(fast ?? false)
  const [openMenu, setOpenMenu] = useState<
    'attach' | 'mode' | 'model' | 'effort' | 'seat' | 'context' | null
  >(null)
  const [busyMenu, setBusyMenu] = useState<'mode' | 'model' | 'effort' | 'fast' | null>(null)
  const [liveModel, setLiveModel] = useState<string | undefined>(model)
  const [liveEffort, setLiveEffort] = useState<string | undefined>(effort)
  const executorRequestRef = useRef(0)
  useEffect(() => {
    setMode(permissionMode ?? 'default')
  }, [permissionMode])
  useEffect(() => {
    setFastOn(fast ?? false)
  }, [fast])
  useEffect(() => {
    setLiveModel(model)
  }, [model])
  useEffect(() => {
    setLiveEffort(effort)
  }, [effort])
  useEffect(() => {
    if (!gui.executorKnown) return
    setLiveModel(gui.executorModel ?? undefined)
    setLiveEffort(gui.effort ?? undefined)
  }, [gui.effort, gui.executorKnown, gui.executorModel])
  useEffect(
    () => () => {
      executorRequestRef.current += 1
    },
    []
  )

  // A spec do spawn muda no MÁXIMO junto com o pane; guardá-la em ref evita
  // que uma prop nova re-dispare o efeito de montagem (que reabriria sessão).
  //
  // OS DOIS LITERAIS CARREGAM O SPAWN INTEIRO. Campo que o main acrescenta e
  // este componente não repete morre aqui em silêncio — TypeScript não acusa
  // campo opcional omitido num literal novo, e foi assim que o `mcp` do
  // planejamento se perdeu. A cerca de paridade do test:gui-chat-ui lê estes
  // dois blocos; a semente também, porque uma remontagem reconstruiria o
  // spawn por ela.
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
    permissionMode: mode,
    fast: fastOn || undefined,
    mcp
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
    permissionMode: mode,
    fast: fastOn || undefined,
    mcp
  }

  const { draft, setDraft, clearDraft } = useGuiDraft(paneId)
  const { attachments, setAttachments, clearAttachments } = useGuiComposerAttachments(paneId)
  const [submitPending, setSubmitPending] = useState(false)
  const submitInFlightRef = useRef(false)
  const latestDraftRef = useRef(draft)
  const latestAttachmentsRef = useRef(attachments)
  latestDraftRef.current = draft
  latestAttachmentsRef.current = attachments
  const [attaching, setAttaching] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [pendingPresentationSeqs, setPendingPresentationSeqs] = useState<number[]>([])
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState === 'visible'
  )
  const [pinned, setPinned] = useState(true)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashCursor, setSlashCursor] = useState(() => draft.length)
  const [slashDismissal, setSlashDismissal] = useState<SlashDismissal | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const mentionOverlayRef = useRef<HTMLDivElement>(null)
  const pendingSlashCursorRef = useRef<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const composerSurfaceRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const {
    visibleItems,
    totalItems,
    hasMoreBefore,
    onScroll: onTranscriptScroll,
    loadAll,
    goToEnd,
    keepPinnedToEnd
  } = useGuiTranscriptWindow({
    items: gui.items,
    logRef,
    pinnedRef,
    onPinnedChange: setPinned
  })
  const historySelectedRef = useRef<HTMLDivElement>(null)
  const historyThreadRef = useRef<HTMLDivElement>(null)
  // R24 — o LEITOR da conversa completa: abrir (linha do topo) e paginar
  // (faixa de bytes). Estado local de propósito: é gesto, não fio.
  const [historyOpening, setHistoryOpening] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyPaging, setHistoryPaging] = useState<'before' | 'after' | null>(null)
  const [historyPageNote, setHistoryPageNote] = useState<string | null>(null)
  /** Altura da lista ANTES da página anterior entrar — sem ela, prepender
   *  falas empurra o texto que o dono está lendo para fora da vista. */
  const historyPrependHeightRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    if (!historyTarget) return
    historySelectedRef.current?.scrollIntoView({ block: 'center' })
  }, [historyTarget?.targetCursor, historyTarget?.targetMessageId])

  useLayoutEffect(() => {
    const previousHeight = historyPrependHeightRef.current
    historyPrependHeightRef.current = null
    const thread = historyThreadRef.current
    if (previousHeight === null || !thread) return
    // Prepend não é navegação: a fala que estava sob os olhos continua ali.
    thread.scrollTop += thread.scrollHeight - previousHeight
  }, [historyTarget?.messages])

  const openFullHistory = useCallback(async (): Promise<void> => {
    const reader = window.synkora?.history?.loadForPane
    if (!reader) {
      setHistoryError('esta janela não tem a ponte de histórico — reabra o Synkora')
      return
    }
    setHistoryOpening(true)
    setHistoryError(null)
    // Leitura nova não herda a compensação de scroll de uma página anterior.
    historyPrependHeightRef.current = null
    try {
      const result = await reader(paneId)
      if (!result.ok || !result.provider || !result.sessionId || !result.messages) {
        setHistoryError(result.error ?? 'não consegui abrir a conversa completa agora')
        return
      }
      setHistoryPageNote(null)
      showGuiHistoryTarget({
        paneId,
        sessionId: result.sessionId,
        provider: result.provider,
        messages: result.messages,
        targetMessageId: result.targetMessageId ?? '',
        targetCursor: result.targetCursor ?? 0,
        truncated: result.truncated === true,
        hasMoreBefore: result.hasMoreBefore === true,
        hasMoreAfter: result.hasMoreAfter === true
      })
    } catch {
      setHistoryError('não consegui abrir a conversa completa agora')
    } finally {
      setHistoryOpening(false)
    }
  }, [paneId, showGuiHistoryTarget])

  const loadHistoryPage = useCallback(
    async (direction: 'before' | 'after'): Promise<void> => {
      if (historyPaging) return
      const reader = window.synkora?.history?.loadForPane
      const request = historyTarget
        ? guiHistoryPageRequest(historyTarget.messages, direction)
        : null
      if (!reader || !request) {
        setHistoryPageNote('não consegui carregar esse trecho agora — reabra a conversa completa')
        return
      }
      setHistoryPaging(direction)
      setHistoryPageNote(null)
      try {
        const result = await reader(paneId, request)
        if (!result.ok || !result.messages) {
          setHistoryPageNote(result.error ?? 'não consegui carregar esse trecho agora')
          return
        }
        if (result.messages.length === 0) {
          // Faixa só de ferramenta: o botão continua e o clique seguinte anda
          // mais um pedaço — o dono nunca fica sem próximo passo.
          setHistoryPageNote(
            direction === 'before'
              ? 'esse trecho não tinha falas — clique de novo para continuar subindo'
              : 'esse trecho não tinha falas — clique de novo para continuar descendo'
          )
        }
        if (direction === 'before') {
          historyPrependHeightRef.current = historyThreadRef.current?.scrollHeight ?? null
        }
        appendGuiHistoryPage(paneId, {
          direction,
          messages: result.messages,
          hasMore:
            direction === 'before' ? result.hasMoreBefore === true : result.hasMoreAfter === true
        })
      } catch {
        setHistoryPageNote('não consegui carregar esse trecho agora')
      } finally {
        setHistoryPaging(null)
      }
    },
    [appendGuiHistoryPage, historyPaging, historyTarget, paneId]
  )

  useEffect(() => {
    const update = (): void => setDocumentVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  // Clicar no papel passivo fora do composer não muda `activeElement` no
  // navegador. Nesse gesto explícito, liberar o foco evita que `:focus-within`
  // mantenha a borda ativa; teclado e alvos internos ficam intocados.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const activeElement = document.activeElement
      if (
        shouldBlurGuiComposerOnOutsidePointerDown(
          composerSurfaceRef.current,
          activeElement,
          event.target
        ) &&
        activeElement instanceof HTMLElement
      ) {
        activeElement.blur()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  // ————— assinatura do canal + replay na montagem —————
  useEffect(() => {
    let alive = true
    let replayed = false
    const buffered: { seq: number | null; evt: GuiSessionEvent }[] = []
    setPendingPresentationSeqs([])

    const notePresentation = (seq: number | null, evt: GuiSessionEvent): void => {
      if (seq === null || !isGuiPresentationTerminal(evt)) return
      setPendingPresentationSeqs((current) => appendGuiPresentationSeq(current, seq))
    }

    const off = guiApi.onLive((payload) => {
      if (!payload || payload.paneId !== paneId) return
      const evt = asGuiEvent(payload.evt)
      if (!evt) return
      // Assinar ANTES do replay é o que garante zero buraco: o que chegar
      // durante a viagem fica em espera e entra logo depois, sem duplicar.
      if (!replayed)
        buffered.push({ seq: Number.isSafeInteger(payload.seq) ? payload.seq : null, evt })
      else {
        handleGuiLive(paneId, evt)
        notePresentation(Number.isSafeInteger(payload.seq) ? payload.seq : null, evt)
      }
    })

    void (async () => {
      const replay = await guiApi.state(paneId)
      if (!alive) return
      replayGuiPane(
        paneId,
        replay.events.map((event) => event.evt),
        replay.exists && !replay.alive
      )
      for (const event of replay.events) {
        const evt = asGuiEvent(event.evt)
        if (evt) notePresentation(event.seq, evt)
      }
      replayed = true
      for (const event of buffered) {
        if (shouldApplyGuiBufferedEvent(event.seq, replay.cursor)) {
          handleGuiLive(paneId, event.evt)
          notePresentation(event.seq, event.evt)
        }
      }
      buffered.length = 0

      // LINHA DE CARGA do modo somente-leitura: a fotografia PARA AQUI.
      // `shouldCreateGuiSession` de um pane morto-mas-gravado (exists && !alive)
      // é TRUE — sem este retorno, abrir a conversa de uma missão encerrada
      // RESSUSCITARIA o CLI, possivelmente num worktree que já não existe.
      if (readOnly) return

      // Sessão já viva (remontagem, reload do renderer) tem histórico: nunca
      // se abre outra por cima. O `spawned` cobre o caso do pane novo.
      if (!shouldCreateGuiSession(replay.exists, replay.alive)) return
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
  }, [paneId, handleGuiLive, replayGuiPane, markGuiSpawned, readOnly])

  const transcriptPresented = isGuiTranscriptPresented(gui.items)
  useEffect(() => {
    // Ler o que já aconteceu não confirma apresentação de nada: o main não tem
    // sessão para receber o recibo, e a missão pode voltar a viver depois.
    if (readOnly) return
    const canAcknowledge = !active || !documentVisible || transcriptPresented
    if (!canAcknowledge || pendingPresentationSeqs.length === 0) return
    const acknowledged = pendingPresentationSeqs
    setPendingPresentationSeqs((current) =>
      current.filter((seq) => !acknowledged.includes(seq))
    )
    for (const seq of acknowledged) guiApi.presented(paneId, seq)
  }, [active, documentVisible, paneId, pendingPresentationSeqs, readOnly, transcriptPresented])

  // O hook mantém a âncora quando a janela muda; conteúdo vivo e reflow de
  // stream continuam usando a mesma regra de ficar no fim quando pinados.
  useLayoutEffect(() => {
    keepPinnedToEnd()
  }, [
    gui.items,
    gui.perm,
    gui.planReview,
    gui.question,
    gui.stream,
    gui.thinking,
    keepPinnedToEnd
  ])

  // textarea que cresce com o texto (Enter envia, Shift+Enter quebra linha).
  // Teto alto e SEM barra de rolagem (ordem do dono): a caixa cresce até um
  // terço da tela em vez de virar uma janelinha com scroll.
  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(300, ta.scrollHeight)}px`
    if (mentionOverlayRef.current) syncInputOverlayScroll(ta, mentionOverlayRef.current)
  }, [draft])

  // Apos a mudanca controlada do texto, posiciona o cursor antes da pintura.
  // Assim a consulta concluida nao aparece outra vez no intervalo do DOM antigo.
  useLayoutEffect(() => {
    const cursor = pendingSlashCursorRef.current
    if (cursor === null) return
    const ta = inputRef.current
    if (!ta) return
    const nextCursor = Math.min(cursor, draft.length)
    ta.focus({ preventScroll: true })
    ta.setSelectionRange(nextCursor, nextCursor)
    pendingSlashCursorRef.current = null
  }, [draft])

  const dead = gui.status === 'dead'
  const opening = gui.status === 'starting' || !gui.ready
  const working = gui.status === 'working'
  const turnOpen = working || gui.status === 'waiting-you'
  // A TROCA DE CONTA NUNCA É BECO (R21.2, queixa do dono: "não consigo trocar
  // a conta; o mouse vira uma bolinha rodando eternamente"). Trocar no meio do
  // turno é LEGÍTIMO — é a fuga do rate limit —, e o main já aguenta: o
  // `missions:setChatSeat` não tem guarda de ocupação nenhuma (sondado), ele
  // transplanta a conversa e MATA as sessões vivas. Só o renderer trancava.
  // O tip diz a verdade nova em vez de esconder o botão atrás do turno.
  const seatTip = turnOpen
    ? 'Trocar interrompe o turno atual e retoma a MESMA conversa na conta nova (mesmo CLI).'
    : 'Conta desta conversa. Trocar mantém a conversa quando o CLI é o mesmo.'
  const spawnChangeLocked =
    dead || turnOpen || attaching || Boolean(busyMenu) || Boolean(gui.queued)
  const canSend = canSendGuiMessage(gui.status, gui.ready)
  // R23.2 — O COMPOSER NÃO TRANCA NO PANE MORTO. `canSend` continua sendo "o
  // transporte está aberto AGORA?" (é ela que o botão da fila usa); quem manda
  // no composer é `canCompose`, porque no morto ENVIAR é o gesto que reabre a
  // MESMA conversa.
  const canCompose = canComposeGuiMessage(gui.status, gui.ready)
  const canSubmit =
    canCompose && busyMenu === null && !attaching && !submitPending && gui.queued === null
  // A PROPOSTA DE PLANO não bloqueia o CLI, então ela chega no MEIO da fala —
  // e mostrá-la ali atropelava a resposta em curso (o dono viu o card "bugar e
  // sumir"). Decisão dele: o agente termina de falar, e SÓ ENTÃO o card
  // aparece embaixo da resposta — e FICA, atravessando os turnos seguintes,
  // até ele decidir. O card pendente segue na fila o tempo todo; só a
  // APRESENTAÇÃO espera o turno fechar.
  const planProposalCard = isGuiTurnActive(gui.status, gui.stream) ? null : gui.planProposal
  // Pergunta e plano SUSPENDEM o composer: é a linguagem do Claude GUI que o
  // dono pediu — o que está na tela é a coisa a responder, não uma caixa de
  // texto que compete com ela. Card ainda invisível não suspende nada.
  const awaitingCard = Boolean(gui.question || gui.planReview || planProposalCard)

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const message = text.trim()
      if ((!message && attachments.length === 0) || !canSubmit) return false
      pinnedRef.current = true
      setPinned(true)
      // R23.2 — PANE MORTO RENASCE NO ENVIO (ordem do dono depois do incidente
      // de 2026-08-19: o composer travou e a única fuga era trocar de conta).
      // NADA de botão novo: enviar É o gesto. O respawn é o MESMO da troca de
      // modo/⚡ (R11/R12 — `guiApi.create` com o spawnRef atual, que o main
      // resolve para a MESMA conversa pelo `inheritedResumeSessionId`, e a
      // retomada é QUIETA). A falha NÃO engole a mensagem: `false` devolve o
      // rascunho ao composer e o motivo entra no fio com a receita.
      if (needsGuiReviveBeforeSend(gui.status)) {
        // A MESMA cerca da montagem: sem conta, reabrir cairia na conta padrão
        // do CLI — troca silenciosa de assento, nunca.
        if (!spawnRef.current.configDir) {
          handleGuiLive(paneId, {
            type: 'limit',
            text: 'este pane não tem conta (config dir) definida — escolha uma conta no cabeçalho e envie de novo'
          })
          return false
        }
        const revived = await guiApi.create(spawnRef.current)
        if (!revived.ok) {
          handleGuiLive(paneId, {
            type: 'limit',
            text: `não deu para reabrir a conversa: ${revived.error ?? 'motivo desconhecido'} — sua mensagem ficou no composer; tente enviar de novo`
          })
          return false
        }
        return sendGuiMessage(paneId, message, undefined, attachments, true)
      }
      if (turnOpen) {
        return Boolean(
          queueGuiMessage(paneId, message, {
            model: liveModel ?? null,
            effort: liveEffort ?? null,
            permissionMode: mode
          }, attachments)
        )
      }
      return sendGuiMessage(paneId, message, undefined, attachments)
    },
    [
      canSubmit,
      attachments,
      gui.status,
      handleGuiLive,
      liveEffort,
      liveModel,
      mode,
      paneId,
      queueGuiMessage,
      sendGuiMessage,
      turnOpen
    ]
  )

  // PULA A FILA (ordem do dono, 18/08: "tem mensagem que eu não quero esperar
  // ele terminar"): o bilhete sai AGORA, dentro do turno vivo — o caminho
  // direto de envio steera nos dois CLIs (codex turn/steer, claude enfileira
  // na própria stream), e o main não trava envio por turno. O protocolo é o
  // MESMO do dispatcher (claim → envio → ack/restore): o "enviando…", o erro
  // com "tentar novamente" e a lease anti-disputa vêm de graça.
  const sendQueuedNow = useCallback(async () => {
    const owner = `send-now-${globalThis.crypto.randomUUID()}`
    const claimed = claimGuiQueuedMessage(paneId, owner)
    if (!claimed) return
    const ok = await sendGuiMessage(paneId, claimed.text, claimed.id, claimed.attachments)
    if (ok) {
      acknowledgeGuiQueuedMessage(paneId, claimed.id, owner)
      return
    }
    restoreGuiQueuedMessage(
      paneId,
      claimed,
      'não consegui entrar no turno — a ponte do chat recusou a mensagem',
      owner
    )
  }, [
    acknowledgeGuiQueuedMessage,
    claimGuiQueuedMessage,
    paneId,
    restoreGuiQueuedMessage,
    sendGuiMessage
  ])

  // ————— autocomplete de comandos —————
  const slashQuery = useMemo(() => {
    return slashQueryAt(draft, Math.min(slashCursor, draft.length))
  }, [draft, slashCursor])

  const activeSlashQuery = isSlashQueryDismissed(slashDismissal, draft, slashQuery)
    ? null
    : slashQuery

  const slashMatches = useMemo(() => {
    if (!activeSlashQuery || !gui.caps?.commands?.length) return []
    return filterSlashCommands(gui.caps.commands, activeSlashQuery.query).slice(0, 40)
  }, [activeSlashQuery, gui.caps])

  const slashOpen = slashMatches.length > 0
  const fileMentions = useGuiFileMentions(paneId, draft, slashCursor, slashOpen)
  const mentionOpen = fileMentions.open
  const dismissSlashMenu = useCallback((): void => {
    if (!slashQuery) return
    setSlashDismissal(slashDismissalAt(draft, slashQuery.at))
    setSlashIndex(0)
  }, [draft, slashQuery])
  const escapeStateRef = useRef({ working: false, questionOpen: false, menuOpen: false })
  const dismissEscapeMenuRef = useRef<() => void>(() => undefined)
  escapeStateRef.current = {
    working: gui.status === 'working',
    // Esc da pergunta já significa PULAR; o listener global nunca sequestra.
    questionOpen: Boolean(gui.question),
    // Menu slash/dropdown tem sua própria semântica de Esc.
    menuOpen: slashOpen || mentionOpen || Boolean(openMenu)
  }
  dismissEscapeMenuRef.current = () => {
    if (openMenu) {
      setOpenMenu(null)
      return
    }
    if (slashOpen) dismissSlashMenu()
    else if (mentionOpen) fileMentions.dismiss()
  }
  useEffect(() => {
    const element = paneRef.current
    if (!element) return
    return registerGuiEscapeTarget(
      paneId,
      element,
      () => escapeStateRef.current,
      () => interruptGuiPane(paneId),
      () => dismissEscapeMenuRef.current()
    )
  }, [interruptGuiPane, paneId])

  useEffect(() => {
    setSlashIndex(0)
  }, [activeSlashQuery?.at, activeSlashQuery?.query])

  /** Completar NUNCA envia: insere `/nome ` e devolve o cursor ao composer —
   *  os argumentos vêm depois, digitados por quem chamou. */
  const pickCommand = useCallback(
    (command: GuiCliCommand): void => {
      if (!slashQuery) return
      const el = inputRef.current
      const cursor = el?.selectionStart ?? slashCursor
      const completion = completeSlashCommand(draft, cursor, command)
      if (!completion) return
      pendingSlashCursorRef.current = completion.cursor
      setSlashCursor(completion.cursor)
      setSlashDismissal(completion.dismissal)
      setSlashIndex(0)
      setDraft(completion.text)
    },
    [draft, slashCursor, slashQuery]
  )

  /** A seleção de arquivo só edita o token @; Enter/Tab nunca chegam ao envio. */
  const pickMention = useCallback(
    (path: string): void => {
      const cursor = inputRef.current?.selectionStart ?? slashCursor
      const completion = fileMentions.complete(path, cursor)
      if (!completion) return
      pendingSlashCursorRef.current = completion.cursor
      setSlashCursor(completion.cursor)
      setDraft(completion.text)
    },
    [fileMentions, setDraft, slashCursor]
  )

  const submit = useCallback((): void => {
    const text = draft.trim()
    if ((!text && attachments.length === 0) || !canSubmit || submitInFlightRef.current) return

    const draftSnapshot = draft
    const attachmentSnapshot = attachments.map((attachment) => ({ ...attachment }))
    submitInFlightRef.current = true
    setSubmitPending(true)
    void send(text)
      .then((accepted) => {
        const clear = guiComposerClearPlan(
          accepted,
          latestDraftRef.current,
          draftSnapshot,
          latestAttachmentsRef.current,
          attachmentSnapshot
        )
        // O usuário pode continuar digitando enquanto o IPC confirma. Limpar
        // somente a fotografia realmente entregue, nunca texto novo.
        if (clear.draft) clearDraft()
        if (clear.attachments) clearAttachments()
      })
      .finally(() => {
        submitInFlightRef.current = false
        setSubmitPending(false)
      })
  }, [attachments, canSubmit, clearAttachments, clearDraft, draft, send])

  const finishAttachments = useCallback((next: readonly GuiAttachmentDescriptor[]): string | null => {
    if (next.length === 0) return null
    const ids = new Set(attachments.map((attachment) => attachment.id))
    const capabilities = new Set(attachments.map((attachment) => attachment.capability))
    const merged = [...attachments]
    let totalBytes = attachments.reduce((total, attachment) => total + (attachment.size ?? 0), 0)
    let hitCountLimit = false
    let hitSizeLimit = false
    for (const attachment of next) {
      if (ids.has(attachment.id) || capabilities.has(attachment.capability)) continue
      if (merged.length >= GUI_COMPOSER_ATTACHMENT_MAX_FILES) {
        hitCountLimit = true
        continue
      }
      if (totalBytes + (attachment.size ?? 0) > GUI_COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES) {
        hitSizeLimit = true
        continue
      }
      ids.add(attachment.id)
      capabilities.add(attachment.capability)
      totalBytes += attachment.size ?? 0
      merged.push(attachment)
    }
    setAttachments(merged)
    window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0)
    if (hitCountLimit) return `você pode manter no máximo ${GUI_COMPOSER_ATTACHMENT_MAX_FILES} anexos`
    if (hitSizeLimit) return 'os anexos do composer ultrapassam o limite de 50 MB'
    return null
  }, [attachments, setAttachments])

  const attachFiles = useCallback(
    async (fileList: FileList | readonly File[] | null): Promise<void> => {
      const selection = planGuiAttachmentBatch(Array.from(fileList ?? []))
      if (selection.accepted.length === 0 && selection.errors.length === 0) return
      if (attaching || busyMenu || submitPending) return
      setOpenMenu(null)
      setAttaching(true)
      setAttachmentError(null)
      const attached: GuiAttachmentDescriptor[] = []
      const errors = [...selection.errors]
      for (const file of selection.accepted) {
        try {
          const bytesBase64 = await readGuiFileBase64(file)
          const result = await guiApi.attach(paneId, {
            kind: 'file',
            name: file.name || 'anexo',
            bytesBase64
          })
          if (result.ok && result.attachment) attached.push(result.attachment)
          else errors.push(result.error ?? `não deu para anexar ${file.name}`)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `não deu para anexar ${file.name}`)
        }
      }
      const attachmentProblem = finishAttachments(attached)
      if (attachmentProblem) errors.push(attachmentProblem)
      setAttachmentError(errors.length > 0 ? errors.join(' · ') : null)
      setAttaching(false)
    },
    [attaching, busyMenu, finishAttachments, paneId, submitPending]
  )

  const attachFolder = useCallback(async (): Promise<void> => {
    if (attaching || busyMenu || submitPending) return
    setOpenMenu(null)
    setAttaching(true)
    setAttachmentError(null)
    try {
      const result = await guiApi.attachFolder(paneId)
      if (result.cancelled) return
      if (result.ok && result.attachment) setAttachmentError(finishAttachments([result.attachment]))
      else setAttachmentError(result.error ?? 'não deu para anexar a pasta')
    } catch {
      setAttachmentError('não deu para escolher a pasta')
    } finally {
      setAttaching(false)
    }
  }, [attaching, busyMenu, finishAttachments, paneId, submitPending])

  /** Permissão é configuração de PROCESSO nos dois CLIs e ainda exige
   *  respawn com resume. Modelo/effort usam o caminho vivo separado abaixo. */
  const applySpawnChange = useCallback(
    async (
      which: 'mode' | 'model' | 'effort' | 'fast',
      patch: Partial<GuiPaneSpawn>,
      /** `null` = troca SEM nota no fio (R12/A3): quando o próprio botão fica
       *  aceso, o estado dele já é o recibo. A FALHA nunca é silenciosa. */
      okText: string | null
    ): Promise<void> => {
      setOpenMenu(null)
      if (spawnChangeLocked) return
      setBusyMenu(which)
      const res = await guiApi.create({ ...spawnRef.current, ...patch })
      setBusyMenu(null)
      if (res.ok) {
        if (okText !== null) {
          handleGuiLive(paneId, { type: 'command-output', text: `${okText} — sessão retomada` })
        }
        return
      }
      handleGuiLive(paneId, {
        type: 'limit',
        text: `não deu para aplicar a troca: ${res.error ?? 'motivo desconhecido'}`
      })
    },
    [handleGuiLive, paneId, spawnChangeLocked]
  )

  /** Modelo/effort são overrides do próximo turno. O main espera o ACK do
   *  backend e só então devolve a seleção canônica: sem respawn, sem linha
   *  sintética e sem atualizar o botão de forma otimista. */
  const applyExecutorChange = useCallback(
    async (
      which: 'model' | 'effort',
      patch: { model?: string | null; effort?: string | null }
    ): Promise<void> => {
      setOpenMenu(null)
      if (spawnChangeLocked) return
      setBusyMenu(which)
      const request = ++executorRequestRef.current
      const res = await guiApi.configureExecutor(paneId, patch)
      if (request !== executorRequestRef.current) return
      setBusyMenu(null)
      if (!res.ok) {
        handleGuiLive(paneId, {
          type: 'limit',
          text: `não deu para aplicar a troca: ${res.error}`
        })
        return
      }
      const nextModel = res.model ?? undefined
      const nextEffort = res.effort ?? undefined
      setLiveModel(nextModel)
      setLiveEffort(nextEffort)
      onExecutorChange?.({ model: nextModel, effort: nextEffort })
    },
    [handleGuiLive, onExecutorChange, paneId, spawnChangeLocked]
  )

  // R11: o toggle ⚡. Fast é flag de spawn (o binário não troca em voo — a
  // sonda probe-fast provou), então o caminho é o MESMO do modo de permissão:
  // respawn com resume, a conversa continua de onde está.
  // R12/A3: sucesso não escreve no fio — o botão aceso É o recibo; só a falha
  // fala (item de erro dentro do `applySpawnChange`).
  const changeFast = useCallback(
    (next: boolean): void => {
      if (spawnChangeLocked || next === fastOn) return
      setFastOn(next)
      onFastMode?.(next)
      void applySpawnChange('fast', { fast: next || undefined }, null)
    },
    [applySpawnChange, fastOn, onFastMode, spawnChangeLocked]
  )

  const changeMode = useCallback(
    (next: GuiPermissionMode): void => {
      if (spawnChangeLocked) {
        setOpenMenu(null)
        return
      }
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
    [applySpawnChange, mode, onPermissionMode, spawnChangeLocked]
  )

  const changeModel = useCallback(
    (next: string): void => {
      if (spawnChangeLocked) {
        setOpenMenu(null)
        return
      }
      const currentModel = gui.executorKnown ? gui.executorModel ?? undefined : liveModel
      const currentEffort = gui.executorKnown ? gui.effort ?? undefined : liveEffort
      if (next === (currentModel ?? '')) {
        setOpenMenu(null)
        return
      }
      const value = next || undefined
      // Modelo novo pode não ter o effort atual — carregar um nível que ele
      // não suporta faria o spawn nascer recusado pelo CLI.
      const supported =
        gui.caps?.models.find((m) => m.value === value)?.supportedEffortLevels ?? []
      const keepEffort = currentEffort && supported.includes(currentEffort) ? currentEffort : undefined
      void applyExecutorChange('model', {
        model: value ?? null,
        effort: keepEffort ?? null
      })
    },
    [
      applyExecutorChange,
      gui.caps,
      gui.effort,
      gui.executorKnown,
      gui.executorModel,
      liveEffort,
      liveModel,
      spawnChangeLocked
    ]
  )

  const changeEffort = useCallback(
    (next: string): void => {
      if (spawnChangeLocked) {
        setOpenMenu(null)
        return
      }
      const currentEffort = gui.executorKnown ? gui.effort ?? undefined : liveEffort
      if (next === (currentEffort ?? '')) {
        setOpenMenu(null)
        return
      }
      const value = next || undefined
      void applyExecutorChange('effort', { effort: value ?? null })
    },
    [applyExecutorChange, gui.effort, gui.executorKnown, liveEffort, spawnChangeLocked]
  )

  useEffect(() => {
    // A guarda é dos SELETORES DE EXECUTOR (conta/modelo/effort/modo): a
    // escolha deles não pode mudar no meio de um turno, então o menu fecha
    // quando o turno começa. O painel de CONTEXTO é leitura pura — não muda
    // nada do próximo turno — e fechá-lo junto era efeito colateral: o popover
    // piscava aberto e morria, levando o foco com ele, justamente enquanto o
    // número que ele mostra está mudando.
    if (working && openMenu && openMenu !== 'attach' && openMenu !== 'context') setOpenMenu(null)
  }, [openMenu, working])

  // fechar menus clicando fora (mesmo padrão dos dropdowns do app)
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

  const renderItems = useMemo(() => guiThreadRenderItems(visibleItems), [visibleItems])
  const copyableAssistantId = useMemo(
    () =>
      guiCopyableAssistantId({
        items: gui.items,
        status: gui.status,
        stream: gui.stream,
        thinking: gui.thinking,
        awaitingInteraction: Boolean(
          gui.perm || gui.question || gui.planReview || gui.interactionSubmitting
        )
      }),
    [
      gui.interactionSubmitting,
      gui.items,
      gui.perm,
      gui.planReview,
      gui.question,
      gui.status,
      gui.stream,
      gui.thinking
    ]
  )
  const activityRunning = gui.status === 'working' && gui.startedAt !== null
  // O TIMER DE RODADA VIVO (R11): o dono lê há quanto tempo a rodada roda —
  // inclusive esperando resposta dele (waiting-you preserva o startedAt, e a
  // espera é parte da rodada). Tique de 1s só enquanto o relógio está armado;
  // fora disso o intervalo nem existe.
  const roundArmed = !readOnly && gui.startedAt !== null
  const [roundNow, setRoundNow] = useState(() => Date.now())
  useEffect(() => {
    if (!roundArmed) return
    setRoundNow(Date.now())
    const timer = setInterval(() => setRoundNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [roundArmed])
  const roundElapsed =
    roundArmed && gui.startedAt !== null
      ? formatGuiElapsed(Math.max(0, roundNow - gui.startedAt))
      : null
  const thinkingPresentation = useMemo(
    () =>
      guiThinkingPresentation({
        status: gui.status,
        stream: gui.stream,
        activeAssistantId: gui.activeAssistantId,
        thinking: gui.thinking,
        activityText: gui.activityText,
        awaitingInteraction: Boolean(
          gui.perm || gui.question || gui.planReview || gui.interactionSubmitting
        )
      }),
    [
      gui.activeAssistantId,
      gui.activityText,
      gui.interactionSubmitting,
      gui.perm,
      gui.planReview,
      gui.question,
      gui.status,
      gui.stream,
      gui.thinking
    ]
  )
  // MESMA fonte de verdade da lateral de entrega: ficha presente = agente ainda
  // trabalhando. A normalização varre o fio inteiro (nunca a janela visível, que
  // pode ter podado o card do pai), então memoiza por `items`.
  const liveSubagents = useMemo(() => normalizeGuiSubagentSidebar(gui.items), [gui.items])
  const backgroundWork = useMemo(
    () => guiBackgroundWorkPresentation({ status: gui.status, liveSubagents }),
    [gui.status, liveSubagents]
  )

  const headRole = role?.trim() || roleFromPaneId(paneId)
  const selectedModelOverride = gui.executorKnown
    ? gui.executorModel ?? undefined
    : liveModel
  const selectedModel = selectedModelOverride ?? gui.model ?? liveModel
  const selectedEffort = gui.executorKnown ? gui.effort ?? undefined : liveEffort
  const modelOptions = gui.caps?.models ?? []
  const modelDefaultOption = useMemo(
    () => modelOptions.find((option) => guiModelIsDefault(option)),
    [modelOptions]
  )
  const modelChoiceOptions = useMemo(
    () => modelOptions.filter((option) => !guiModelIsDefault(option)),
    [modelOptions]
  )
  const selectedModelOption = guiModelForSelection(modelOptions, selectedModelOverride)
  const modelUsesDefault =
    selectedModelOverride === undefined || guiModelIsDefault(selectedModelOption)
  // Conversa no padrão da conta não tem opção escolhida: quem responde pelas
  // capacidades do modelo ali é a ficha do próprio default.
  const effectiveModelOption =
    selectedModelOption ?? (modelUsesDefault ? modelDefaultOption : undefined)
  const modelDefaultIdentity = modelDefaultOption
    ? guiModelShortName(modelDefaultOption)
    : ''
  const modelDefaultLabel =
    modelDefaultIdentity && !/^default\b/iu.test(modelDefaultIdentity)
      ? `padrão da conta · ${modelDefaultIdentity}`
      : 'padrão da conta'
  const headModel = selectedModel
  const headWhere = branchLabel?.trim() || tailOf(cwd)
  // Na fotografia o estado vivo não existe: o replay de um pane gravado deixa
  // `starting` (a preparação de respawn que nunca vai acontecer), e escrever
  // "abrindo" ali seria mentira de tela. Quem diz que é leitura é o cabeçalho
  // de quem hospeda a fotografia.
  const headStatus = readOnly ? null : STATUS_TEXT[gui.status]
  const account = gui.caps?.account
  const seat = seats?.find((s) => s.id === seatId)
  const liveModelLabel = modelUsesDefault
    ? modelDefaultLabel === 'padrão da conta'
      ? modelDefaultLabel
      : modelDefaultLabel.replace(/^padrão da conta/u, 'padrão')
    : selectedModel
      ? guiModelLabel(modelOptions, selectedModel, prettyModel(selectedModel))
      : 'modelo'
  const headModelLabel = headModel
    ? guiModelLabel(modelOptions, headModel, prettyModel(headModel))
    : ''
  const effortOptions =
    guiModelForSelection(modelOptions, selectedModel)?.supportedEffortLevels ?? []
  const contextUsage = guiContextUsagePresentation(gui.contextTokens, gui.contextWindow)
  const contextPanel = guiContextPanelPresentation(
    gui.contextTokens,
    gui.contextWindow,
    gui.costUsd
  )
  const queuedMessage = gui.queued
  const queuedOptionsLabel = queuedMessage
    ? [
        queuedMessage.options.model ?? 'modelo padrão',
        queuedMessage.options.effort ?? 'effort padrão',
        PERM_MODE_LABEL[queuedMessage.options.permissionMode as GuiPermissionMode] ??
          queuedMessage.options.permissionMode
      ].join(' · ')
    : undefined

  // A ABINHA DO PADRÃO DOS AJUDANTES (D8) só existe em chat que DELEGA. O sinal
  // é derivado dos args do MCP pelo mesmo motivo que a cerca do codex é
  // (`guiSpawnSuppressesNativeAgents`): campo novo no spawn precisaria ser
  // repetido à mão em quatro listas do renderer, e foi o silêncio delas que já
  // deixou o chat de planejamento sem ferramenta por uma noite inteira.
  const delegatesHelpers = useMemo(() => guiPaneDelegates(mcp), [mcp])

  const injection = useMemo(() => {
    const text = firstPrompt?.trim()
    // Conversa RETOMADA não recebe 1º prompt (o briefing já está lá dentro):
    // anunciar injeção nesse caso seria mentira de tela.
    if (!text || resumeSessionId) return null
    return { label: firstPromptLabel?.trim() || injectionLabel(text), text }
  }, [firstPrompt, firstPromptLabel, resumeSessionId])

  /** O briefing ainda NÃO saiu: o motor o segura até a primeira mensagem do
   *  dono, e é a chegada dessa mensagem que o consome. A bolha do dono no fio
   *  é a mesma condição que o main usa, então tela e motor contam a mesma
   *  história sem um canal novo. */
  const briefingPending = Boolean(injection) && !gui.items.some((item) => item.kind === 'user')

  /** Última fala do dev pedindo um "pode seguir" — só com o turno FECHADO e
   *  nada pendente; é isso que torna os botões inline uma resposta, não um
   *  atalho no meio do trabalho. A régua de "isto é um pedido de aceite?" mora
   *  em `guiAskForGo` (precisão antes de cobertura: clicar em aprovar ENVIA
   *  uma frase que o dono não escreveu). */
  const askingGo = useMemo(
    () =>
      guiAwaitingGoDecision(gui.items, {
        status: gui.status,
        perm: Boolean(gui.perm),
        stream: Boolean(gui.stream),
        awaitingCard
      }),
    [gui.items, gui.status, gui.perm, gui.stream, awaitingCard]
  )

  // A injeção deixou de suprimir o vazio: o pane que nasce mudo PRECISA dizer
  // o que fazer, senão lê como chat quebrado com um `<details>` solto em cima.
  const empty = gui.items.length === 0 && !gui.stream && !gui.perm && !awaitingCard

  /** NADA de decidir aqui: ou o dono está lendo o histórico local por cima da
   *  conversa (`historyTarget`), ou o pane inteiro é fotografia congelada.
   *  Vale para TODA superfície que responde ao agente — inclusive as três que o
   *  overlay de histórico nunca precisou cobrir (plano, pergunta e "pode
   *  seguir"): `settleGuiReplay` não limpa `perm`/`question`/`planReview`, então
   *  um transcript que morreu no meio de uma decisão renderiza o card vivo. */
  const inert = Boolean(historyTarget) || readOnly

  return (
    <div
      className="gui-pane"
      ref={paneRef}
      data-gui-pane-id={paneId}
      onFocusCapture={() => noteGuiPaneInteraction(paneId)}
      onPointerDownCapture={() => noteGuiPaneInteraction(paneId)}
    >
      {showHeader && (
        <div className="gui-head">
          <span className="gui-head-cli" aria-hidden="true">
            <CliMark cli={cli} size={13} />
          </span>
          {headRole && <span className="gui-head-role">{headRole}</span>}

          {/* A CONTA da conversa: clicar troca de seat sem sair do chat — o que
              não existe na fotografia congelada, onde não há sessão para
              transplantar; ali sobra o NOME da conta, que é fato gravado. */}
          {!readOnly && seats?.length && onChangeSeat ? (
            <span className="gui-menu-host gui-head-seat">
              <button
                className={`gui-head-seat-btn${openMenu === 'seat' ? ' open' : ''}`}
                disabled={seatChanging || busyMenu !== null || attaching}
                aria-haspopup="menu"
                aria-expanded={openMenu === 'seat'}
                data-tip={seatTip}
                onClick={() => setOpenMenu((v) => (v === 'seat' ? null : 'seat'))}
              >
                <span className="ghs-name">
                  {seatChanging ? 'trocando conta…' : (seat?.name ?? 'escolher conta')}
                </span>
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
                      disabled={seatChanging || busyMenu !== null || attaching}
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

          {headModel && <span className="gui-head-model">{headModelLabel}</span>}
          {selectedEffort && <span className="gui-head-effort">{selectedEffort}</span>}
          {headWhere && <span className="gui-head-where">{headWhere}</span>}
          {headStatus && (
            <span className={`gui-head-status ${gui.status}`}>
              <i className="ghs-dot" aria-hidden="true" />
              {headStatus}
              {/* R11: o relógio da rodada mora COLADO no estado — "trabalhando
                  · 4:12" é a resposta de relance a "há quanto tempo?". Fora da
                  região viva de leitor de tela pelo mesmo motivo do cronômetro
                  da lateral: narrar o relógio a cada segundo é tortura. */}
              {roundElapsed && (
                <span className="gui-head-round" aria-hidden="true">
                  · {roundElapsed}
                </span>
              )}
            </span>
          )}
        </div>
      )}

      {seatError && (
        <div className="gui-seat-error" role="alert">
          não deu para trocar a conta: {seatError}
        </div>
      )}

      {/* O palco é a âncora do "ir para o fim": preso ao .gui-pane, o botão
          cairia POR CIMA do card de permissão (que nasce entre o fio e o
          composer). Aqui ele acompanha o fim do fio, sempre. */}
      <div className="gui-stage">
        <div className="gui-log" ref={logRef} onScroll={onTranscriptScroll}>
          <div className="gui-thread">
            {/* R24.1 — A PODA FALA. O anel do main guarda uma janela do fio;
                quando ela estoura, o começo da conversa sai da tela. A linha
                diz isso onde a dor acontece (o topo) e traz a receita junto:
                o transcript local do CLI ainda tem a conversa inteira. Vale
                também na fotografia congelada — ler não ressuscita nada. */}
            {gui.prunedEvents > 0 && (
              <div className="gui-thread-pruned-slot">
                <button
                  type="button"
                  className="gui-thread-pruned"
                  onClick={() => void openFullHistory()}
                  disabled={historyOpening || Boolean(historyTarget)}
                  aria-label={`${guiPrunedNoticeText(gui.prunedEvents)} — ver conversa completa`}
                >
                  <span className="gtp-truth">{guiPrunedNoticeText(gui.prunedEvents)}</span>
                  <span className="gtp-action">
                    {historyOpening ? 'abrindo…' : 'ver conversa completa'}
                  </span>
                </button>
                {historyError && (
                  <p className="gui-thread-pruned-error" role="status">
                    {historyError}
                  </p>
                )}
              </div>
            )}

            {hasMoreBefore && (
              <button
                type="button"
                className="gui-transcript-load-all"
                onClick={loadAll}
                aria-label={`Carregar todas as ${totalItems} mensagens`}
              >
                carregar todas as {totalItems}
              </button>
            )}

            {empty && (
              <div className="gui-empty">
                {readOnly ? (
                  // A poda do histórico (LRU por espaço) é real e chega
                  // primeiro justamente nas conversas mais antigas: dizer
                  // isso é melhor do que um chat em branco, que se lê como
                  // defeito novo.
                  'esta conversa não está mais guardada (o histórico tem limite de espaço)'
                ) : gui.status === 'starting' || !gui.ready ? (
                  'abrindo a conversa…'
                ) : briefingPending ? (
                  // O chat abriu e não falou: o dono precisa saber que isso é
                  // o desenho (ele escolhe conta/modelo antes de gastar turno)
                  // e que o briefing não se perdeu no caminho.
                  <>
                    ambiente pronto — escreva para começar
                    <span className="gui-empty-sub">
                      o briefing desta missão vai junto com a sua primeira mensagem
                    </span>
                  </>
                ) : (
                  'conversa vazia — escreva abaixo para começar'
                )}
              </div>
            )}

            {injection && (
              <details className="gui-inject">
                <summary>
                  <span aria-hidden="true">📄</span>
                  <span className="gui-inject-name">{injection.label}</span>
                  <span className="gui-inject-tag">
                    {briefingPending ? 'vai com a sua primeira mensagem' : 'enviado com a sua 1ª mensagem'}
                  </span>
                </summary>
                <pre className="gui-inject-body">{injection.text}</pre>
              </details>
            )}

            {renderItems.map((item) =>
              item.kind === 'tool-group' ? (
                <GuiToolGroupCard key={item.id} group={item} />
              ) : (
                <GuiMessage
                  key={item.id}
                  paneId={paneId}
                  item={item}
                  showCopy={item.kind === 'assistant' && item.id === copyableAssistantId}
                  onRevealComplete={(itemId, length) =>
                    finishGuiReveal(paneId, itemId, length)
                  }
                  onRevealProgress={keepPinnedToEnd}
                />
              )
            )}

            {/* Um indicador vivo por vez. Com subagente de fundo o verbo genérico
                ("preparando a resposta") seria falso — quem trabalha é o agente
                lá atrás —, então a linha de fundo VENCE e a de pensar cede. */}
            {thinkingPresentation && !backgroundWork && (
              <div className="gui-thinking" role="status">
                <span className="gui-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="gui-thinking-label">{thinkingPresentation.label}</span>
              </div>
            )}

            {/* Enquanto houver subagente vivo o fio nunca parece terminado —
                inclusive com o turno raiz já fechado (`continues`) ou com um
                card esperando o dono. Some no instante do último settle. */}
            {backgroundWork && (
              <div
                className="gui-background-work"
                role="status"
                data-subagent-count={backgroundWork.count}
              >
                <span className="gui-dots" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="gui-background-work-label">{backgroundWork.label}</span>
              </div>
            )}

            {!inert && gui.planReview && (
              <GuiPlanCard
                paneId={paneId}
                plan={gui.planReview.plan}
                disabled={Boolean(gui.interactionSubmitting)}
                onDecide={(approve) => void answerGuiPlan(projectId, paneId, approve)}
              />
            )}

            {!inert && planProposalCard && (
              <GuiPlanProposalCard
                draft={planProposalCard.draft}
                disabled={Boolean(gui.interactionSubmitting)}
                onDecide={(approve, note) =>
                  void answerGuiPlanProposal(projectId, paneId, approve, note)
                }
              />
            )}

            {!inert && gui.question && (
              <GuiQuestionCard
                questions={gui.question.questions}
                disabled={Boolean(gui.interactionSubmitting)}
                onAnswer={(answers) => void answerGuiQuestion(projectId, paneId, answers)}
                onSkip={() => void answerGuiQuestion(projectId, paneId, {})}
              />
            )}

            {!inert && askingGo && (
              <div className="gui-ask">
                <span className="gui-ask-label">esta conversa está esperando você</span>
                <div className="gui-ask-actions">
                  <button
                    className="gui-btn primary"
                    disabled={!canSubmit}
                    onClick={() => send('aprovado — pode seguir.')}
                  >
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

        {historyTarget && (
          <section
            className="gui-history-overlay"
            aria-label="Conversa arquivada"
            data-history-session-id={historyTarget.sessionId}
          >
            <header className="gui-history-head">
              <span>
                <b>conversa arquivada</b>
                <small>
                  {historyTarget.provider === 'claude' ? 'Claude' : 'Codex'} · somente falas
                  suas e do assistente
                </small>
              </span>
              <button
                type="button"
                onClick={() => clearGuiHistoryTarget(paneId)}
                aria-label="Voltar à conversa atual"
              >
                voltar à conversa atual
              </button>
            </header>
            {/* Corte SEM saída continua avisando; corte COM saída (R24.3) fala
                pelos próprios botões de página, que dizem o que fazer. */}
            {historyTarget.truncated &&
              !historyTarget.hasMoreBefore &&
              !historyTarget.hasMoreAfter && (
                <p className="gui-history-limited" role="status">
                  Trecho parcial: o histórico ultrapassou o limite seguro de leitura.
                </p>
              )}
            {historyPageNote && (
              <p className="gui-history-limited" role="status">
                {historyPageNote}
              </p>
            )}
            <div className="gui-history-thread" ref={historyThreadRef}>
              {historyTarget.hasMoreBefore && (
                <button
                  type="button"
                  className="gui-history-page"
                  onClick={() => void loadHistoryPage('before')}
                  disabled={historyPaging !== null}
                >
                  {historyPaging === 'before' ? 'carregando…' : 'carregar mais antigas'}
                </button>
              )}
              {historyTarget.messages.map((message) => {
                const selected =
                  message.id === historyTarget.targetMessageId &&
                  message.cursor === historyTarget.targetCursor
                return (
                  <div
                    key={`${message.id}:${message.cursor}`}
                    ref={selected ? historySelectedRef : undefined}
                    className={`gui-history-message ${message.role}${selected ? ' selected' : ''}`}
                    data-history-message-id={message.id}
                    data-history-cursor={message.cursor}
                  >
                    <span>{message.role === 'user' ? 'você' : 'assistente'}</span>
                    <p>{message.text}</p>
                  </div>
                )
              })}
              {historyTarget.hasMoreAfter && (
                <button
                  type="button"
                  className="gui-history-page"
                  onClick={() => void loadHistoryPage('after')}
                  disabled={historyPaging !== null}
                >
                  {historyPaging === 'after' ? 'carregando…' : 'carregar mais novas'}
                </button>
              )}
            </div>
          </section>
        )}
      </div>

      {!inert && gui.perm && (
        <GuiPermCard
          perm={gui.perm}
          disabled={Boolean(gui.interactionSubmitting)}
          onChoose={(behavior) => void answerGuiPerm(projectId, paneId, behavior)}
        />
      )}

      {!inert && queuedMessage && (
        <GuiQueuedMessageCard
          message={queuedMessage}
          optionsLabel={queuedOptionsLabel}
          onEdit={() => {
            discardGuiQueuedMessage(paneId, queuedMessage.id)
            setDraft(queuedMessage.text)
            setAttachments(queuedMessage.attachments)
            window.setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 0)
          }}
          onDelete={() => discardGuiQueuedMessage(paneId, queuedMessage.id)}
          onRetry={() => retryGuiQueuedMessage(paneId, queuedMessage.id)}
          onSendNow={() => void sendQueuedNow()}
          sendNowDisabled={!canSend}
        />
      )}

      {!inert && !awaitingCard && (
        <div className="gui-composer">
          {slashOpen && (
            <GuiSlashMenu
              id={slashMenuId}
              commands={slashMatches}
              index={slashIndex}
              onPick={pickCommand}
              onHover={setSlashIndex}
            />
          )}
          {mentionOpen && !slashOpen && (
            <GuiFileMentionMenu
              id={mentionMenuId}
              files={fileMentions.matches}
              index={fileMentions.index}
              loading={fileMentions.loading}
              error={fileMentions.error}
              onPick={pickMention}
              onHover={fileMentions.setIndex}
            />
          )}
          {/* O pino do dono para a frota deste chat: encostado no composer,
              recolhido, do lado em que a lateral de subagentes vai morar. */}
          {delegatesHelpers && <GuiDelegationDefaults paneId={paneId} seats={seats} />}
          <div
            className="gui-composer-surface"
            ref={composerSurfaceRef}
            onDragOver={(event) => {
              if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault()
            }}
            onDrop={(event) => {
              const files = event.dataTransfer.files
              if (files.length === 0) return
              event.preventDefault()
              void attachFiles(files)
            }}
          >
            <div className="gui-composer-inner">
              {draft && (
                <GuiMentionOverlay ref={mentionOverlayRef} text={draft} files={fileMentions.files} />
              )}
              <textarea
                ref={inputRef}
                className="gui-input"
                data-mentions={draft ? 'active' : undefined}
                rows={1}
                maxLength={GUI_PROMPT_MAX_CHARS}
                spellCheck={false}
                value={draft}
                aria-label="Mensagem para esta conversa"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={slashOpen || mentionOpen}
                aria-controls={slashOpen ? slashMenuId : undefined}
                aria-owns={mentionOpen ? mentionMenuId : undefined}
                aria-activedescendant={
                  slashOpen
                    ? `${slashMenuId}-option-${slashIndex}`
                    : mentionOpen && fileMentions.matches.length > 0
                      ? `${mentionMenuId}-option-${fileMentions.index}`
                      : undefined
                }
                placeholder={
                  dead
                    ? guiDeadComposerPlaceholder(gui.exitCode)
                    : opening
                      ? 'a conversa está abrindo — você já pode escrever'
                      : 'dirija o dev — / abre os comandos'
                }
                onChange={(e) => {
                  setSlashCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
                  setDraft(e.currentTarget.value)
                }}
                onSelect={(e) => {
                  setSlashCursor(e.currentTarget.selectionStart ?? e.currentTarget.value.length)
                }}
                onScroll={(e) => {
                  const input = e.currentTarget
                  if (mentionOverlayRef.current) syncInputOverlayScroll(input, mentionOverlayRef.current)
                }}
                onPaste={(event) => {
                  const images = Array.from(event.clipboardData.files).filter((file) =>
                    file.type.startsWith('image/')
                  )
                  if (images.length === 0) return
                  event.preventDefault()
                  void attachFiles(images)
                }}
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
                      dismissSlashMenu()
                      return
                    }
                  }
                  if (mentionOpen) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault()
                      if (fileMentions.matches.length > 0) {
                        fileMentions.setIndex((fileMentions.index + 1) % fileMentions.matches.length)
                      }
                      return
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault()
                      if (fileMentions.matches.length > 0) {
                        fileMentions.setIndex(
                          (fileMentions.index - 1 + fileMentions.matches.length) %
                            fileMentions.matches.length
                        )
                      }
                      return
                    }
                    if (e.key === 'Tab' || e.key === 'Enter') {
                      e.preventDefault()
                      const path = fileMentions.matches[fileMentions.index]
                      if (path) pickMention(path)
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      fileMentions.dismiss()
                      return
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
                    e.preventDefault()
                    submit()
                  }
                }}
              />

              <GuiAttachmentChips
                attachments={attachments}
                className="gui-composer-attachments"
                onRemove={
                  submitPending
                    ? undefined
                    : (attachmentId) =>
                        setAttachments((current) =>
                          current.filter((attachment) => attachment.id !== attachmentId)
                        )
                }
              />

              <div className="gui-menu-host gui-composer-attach">
                <input
                  ref={fileInputRef}
                  className="gui-file-input"
                  type="file"
                  multiple
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => {
                    void attachFiles(event.currentTarget.files)
                    event.currentTarget.value = ''
                  }}
                />
                <button
                  className="gui-sq gui-attach-btn"
                  type="button"
                  disabled={dead || opening || attaching || submitPending || busyMenu !== null}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === 'attach'}
                  aria-label="Adicionar anexo"
                  data-tip={attaching ? 'Anexando…' : 'Adicionar anexo'}
                  onClick={() => setOpenMenu((value) => (value === 'attach' ? null : 'attach'))}
                >
                  <span aria-hidden="true">+</span>
                </button>
                {openMenu === 'attach' && (
                  <div className="gui-menu gui-mode-menu gui-attach-menu" role="menu">
                    <button
                      className="gui-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setOpenMenu(null)
                        fileInputRef.current?.click()
                      }}
                    >
                      <span className="gmi-glyph" aria-hidden="true">
                        ↥
                      </span>
                      <b>Arquivos</b>
                      <span>adicionar do computador</span>
                    </button>
                    <button
                      className="gui-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={() => void attachFolder()}
                    >
                      <span className="gmi-glyph" aria-hidden="true">
                        ▱
                      </span>
                      <b>Pasta</b>
                      <span>referenciar sem copiar a árvore</span>
                    </button>
                  </div>
                )}
              </div>

              {/* A FAMÍLIA DE CONTROLES da conversa: permissão · modelo · effort.
                  O interruptor global do universo morreu — quem decide o quanto o
                  agente pode agir, e com que motor, é cada chat, aqui. */}
              <div className="gui-menu-host gui-composer-mode">
                <button
                  className={`gui-mode-btn mode-${mode}`}
                  disabled={spawnChangeLocked}
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

              {contextPanel && contextUsage && (
                <GuiContextPanel
                  className="gui-composer-context"
                  usage={contextPanel}
                  label={contextUsage.label}
                  open={openMenu === 'context'}
                  onOpenChange={(nextOpen) => setOpenMenu(nextOpen ? 'context' : null)}
                />
              )}

              <div className="gui-menu-host gui-composer-model">
                <button
                  className="gui-mode-btn mode-model"
                  disabled={spawnChangeLocked}
                  data-tip={'Modelo usado no próximo turno.'}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === 'model'}
                  aria-label={`Modelo desta conversa: ${liveModelLabel}`}
                  onClick={() => setOpenMenu((v) => (v === 'model' ? null : 'model'))}
                >
                  <span aria-hidden="true">◆</span>
                  <span className="gui-mode-text">{liveModelLabel}</span>
                </button>
                {openMenu === 'model' && (
                  <div className="gui-menu gui-mode-menu" role="menu">
                    <button
                      className={`gui-menu-item${modelUsesDefault ? ' active' : ''}`}
                      role="menuitem"
                      aria-label={modelDefaultLabel}
                      onClick={() => changeModel('')}
                    >
                      <b>{modelDefaultLabel}</b>
                    </button>
                    {modelChoiceOptions.map((option) => {
                      const optionLabel = guiModelShortName(option, option.value)
                      return (
                        <button
                          key={option.value}
                          className={`gui-menu-item${option.value === selectedModelOverride ? ' active' : ''}`}
                          type="button"
                          role="menuitem"
                          title={option.resolvedModel ?? option.value}
                          aria-label={optionLabel}
                          onClick={() => changeModel(option.value)}
                        >
                          <b>{optionLabel}</b>
                        </button>
                      )
                    })}
                    {modelOptions.length === 0 && (
                      <span className="gui-menu-foot">
                        a lista de modelos chega quando o CLI termina de abrir
                      </span>
                    )}
                  </div>
                )}
              </div>

              {effortOptions.length > 0 && (
                <div className="gui-menu-host gui-composer-effort">
                  <button
                    className="gui-mode-btn mode-effort"
                    disabled={spawnChangeLocked}
                    data-tip={'Esforço de raciocínio desta conversa.'}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === 'effort'}
                    aria-label={`Esforço de raciocínio desta conversa: ${
                      selectedEffort ?? 'padrão do modelo'
                    }`}
                    onClick={() => setOpenMenu((v) => (v === 'effort' ? null : 'effort'))}
                  >
                    <span aria-hidden="true">◇</span>
                    <span className="gui-mode-text">
                      {selectedEffort ?? 'effort'}
                    </span>
                  </button>
                  {openMenu === 'effort' && (
                    <div
                      className="gui-menu gui-mode-menu gui-effort-menu"
                      role="menu"
                      aria-label="Níveis de esforço"
                    >
                      <button
                        className={`gui-menu-item${selectedEffort ? '' : ' active'}`}
                        role="menuitem"
                        onClick={() => changeEffort('')}
                      >
                        <b>padrão do modelo</b>
                      </button>
                      {effortOptions.map((option) => (
                        <button
                          key={option}
                          className={`gui-menu-item${option === selectedEffort ? ' active' : ''}`}
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

              {/* R11 — o TOGGLE ⚡ (ordem do dono): visível quando o modelo da
                  conversa tem fast (a chave é UMA nos dois CLIs) — e sempre que
                  já está ligado, senão desligar ficaria sem botão. Trocar é
                  flag de spawn: respawn com resume, como o modo de permissão.
                  R12/A1: INTERRUPTOR, não etiqueta — o botão é sempre só o
                  glifo (o rótulo que nascia ao ligar empurrava os vizinhos), e
                  o estado fala pelo contorno de `.gui-fast-btn.on` + o
                  `aria-pressed`. R12/A2: a dica cabe em UMA linha. R13/A3: o
                  gate lê o modelo EFETIVO — olhar só a opção escolhida escondia
                  o ⚡ em toda conversa no padrão da conta, mesmo com o default
                  tendo fast. */}
              {(fastOn || effectiveModelOption?.supportsFastMode === true) && (
                <button
                  className={`gui-mode-btn gui-fast-btn${fastOn ? ' on' : ''}`}
                  disabled={spawnChangeLocked || busyMenu === 'fast'}
                  aria-pressed={fastOn}
                  data-tip={
                    fastOn
                      ? 'desligar o modo fast'
                      : cli === 'claude'
                        ? 'modo fast — gasta mais limite (vira Opus 5)'
                        : 'modo fast — gasta mais limite'
                  }
                  aria-label={fastOn ? 'Desligar o modo fast' : 'Ligar o modo fast'}
                  onClick={() => changeFast(!fastOn)}
                >
                  <span aria-hidden="true">⚡</span>
                </button>
              )}

              {/* UMA peça em dois estados: mesma caixa, mesmo lugar, mesma
                  grade dos controles ao lado. Enviar é a decisão do dono (por
                  isso o acento); interromper fala pela cor do erro, em voz
                  baixa — contorno tingido, nunca um botão vermelho cheio
                  piscando para quem só está lendo a resposta. */}
              <button
                className={`gui-sq gui-send${activityRunning ? ' stop' : ''}`}
                type="button"
                disabled={
                  activityRunning
                    ? false
                    : (!draft.trim() && attachments.length === 0) || !canSubmit
                }
                data-tip={
                  activityRunning
                    ? 'Interromper resposta · Esc'
                    : opening
                      ? 'Aguarde a conversa abrir'
                      : turnOpen
                        ? gui.queued
                          ? 'Já existe uma mensagem na fila'
                          : 'Colocar na fila · Enter'
                        : 'Enviar · Enter'
                }
                aria-label={
                  activityRunning
                    ? 'Interromper resposta'
                    : turnOpen
                      ? 'Colocar mensagem na fila'
                      : 'Enviar mensagem'
                }
                aria-keyshortcuts={activityRunning ? 'Escape' : undefined}
                onClick={activityRunning ? () => void interruptGuiPane(paneId) : submit}
              >
                {activityRunning ? <StopGlyph /> : <SendGlyph />}
              </button>
              {attachmentError && (
                <div className="gui-attach-error" role="alert">
                  {attachmentError}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
