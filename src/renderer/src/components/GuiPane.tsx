import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  EMPTY_GUI_PANE,
  useStore,
  type GuiItem,
  type GuiPendingPerm,
  type MissionType,
  type Seat
} from '../store'
import {
  ownerBubbleLabel,
  ownerDeliveryStamp,
  ownerForceLabel,
  ownerForceRefusalText
} from '../guiOwnerBubble'
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
import GuiComposerNotice, { type GuiComposerNoticeValue } from './GuiComposerNotice'
import GuiAgentPulse from './GuiAgentPulse'
import GuiBrowserReferenceChips from './GuiBrowserReferenceChips'
import GuiSelectionMenu, { type GuiSelectionAction } from './GuiSelectionMenu'
import {
  GUI_QUOTE_MAX_COUNT,
  guiQuoteChipLabel,
  guiQuoteFromSelection,
  guiQuotedPrompt
} from '../guiThreadQuote'
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
import { useGuiBrowserReferences } from '../useGuiBrowserReferences'
import type { GuiBrowserReference } from '../../../shared/guiBrowserReferences'
import { useGuiDropZone } from '../useGuiDropZone'
import { useGuiComposerFit } from '../useGuiComposerFit'
import { dragTransferHasFiles, guiDropZoneLabel } from '../guiDropZone'
import type { GuiAttachResult, GuiAttachmentDescriptor, SeatUsage } from '../../../preload'
import {
  guiComposerCatalogModels,
  guiContextUsagePresentation,
  guiEffortLabel,
  guiModelForSelection,
  guiModelIsDefault,
  guiModelLabel,
  guiModelShortName
} from '../guiComposerPresentation'
import { guiContextPanelPresentation } from '../guiContextPanel'
import {
  guiExpensiveSwitchNote,
  guiHeavyConversationTip,
  guiOdometerPresentation,
  guiSeatQuotaPresentation,
  guiUsageMetersPresentation
} from '../guiCostSignals'
import {
  GUI_COMPOSER_ATTACHMENT_MAX_FILES,
  GUI_COMPOSER_ATTACHMENT_MAX_TOTAL_BYTES,
  base64FromDataUrl,
  planGuiAttachmentBatch
} from '../guiComposerAttachments'
import { shouldBlurGuiComposerOnOutsidePointerDown } from '../guiComposerFocus'
import { guiAwaitingGoDecision } from '../guiAskForGo'
import { guiHeldItems, guiWritingPaceOf, type GuiWritingPace } from '../guiStreamReveal'
import { guiComposerClearPlan } from '../guiComposerDelivery'
import { forceOneGuiQueuedMessage } from '../guiQueuedDelivery'
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
  missionType?: MissionType
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
  /** contas conhecidas + a desta conversa: só para NOMEAR a conta no
   *  cabeçalho da fotografia. A troca de conta mora na cabeça do palco
   *  (StageSeatChip, montado pelo Board), não no chat. */
  seats?: Seat[]
  seatId?: string
  /** falha da troca de conta pedida na cabeça do palco: aparece no próprio chat */
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

/**
 * A BOLHA DO DONO. Componente próprio (e não um ramo do `GuiMessage`) porque a
 * R39.1 deu a ela ESTADO: o `ler agora` fica desabilitado enquanto a chamada
 * está em voo, e a recusa do main precisa parar em algum lugar — dentro do
 * `GuiMessage`, com os `return` antecipados que ele tem, hook nenhum poderia
 * morar.
 */
function GuiOwnerBubble({
  paneId,
  item
}: {
  paneId: string
  item: Extract<GuiItem, { kind: 'user' }>
}): React.JSX.Element | null {
  // D4' (2026-09-02) — o dono: *"se eu quiser eu posso forçar, aí forçando ele
  // para o turno e lê o que eu quero falar, quando for algo urgente."* Um
  // gesto por vez: com a chamada em voo o botão desliga, senão dois cliques
  // virariam dois cortes.
  const [forcing, setForcing] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  // D6 — O RECIBO. Sob a bolha (que não muda em nada), uma linha mono conta o
  // destino da fala; sem entrega, nada é desenhado e a bolha fica idêntica à
  // de sempre. A palavra e a marca saem `aria-hidden` porque o mesmo texto já
  // viaja no nome acessível da bolha — o leitor de tela não ouve duas vezes.
  // O BOTÃO nunca entra nesse silêncio: alvo focável escondido do leitor é
  // armadilha, então ele leva o próprio nome, citando a fala.
  const stamp = ownerDeliveryStamp(item.delivery, Date.now())
  const label = ownerBubbleLabel(stamp)
  const cancelledAway = item.delivery?.state === 'cancelled'
  const forceNow = useCallback(async (): Promise<void> => {
    setForcing(true)
    setRefusal(null)
    const result = await guiApi.forceOwnerMessage(paneId, item.id)
    setForcing(false)
    // Recusa NUNCA some em silêncio: o texto do main (que nomeia a receita)
    // cai na linha de aviso da própria bolha, do lado do gesto que falhou.
    if (!result.ok) setRefusal(ownerForceRefusalText(result.error))
  }, [item.id, paneId])
  const cancel = useCallback(async (): Promise<void> => {
    setCancelling(true)
    setRefusal(null)
    const result = await guiApi.cancelOwnerMessage(paneId, item.id)
    setCancelling(false)
    if (!result.ok) setRefusal(`não deu para cancelar — ${result.error ?? 'a sessão não respondeu'}`)
  }, [item.id, paneId])
  // Cancelada = some (ordem do dono, 2026-09-16). O redutor já tira o item do
  // fio; este guarda cobre uma bolha montada com a entrega cancelada por fora.
  if (cancelledAway) return null
  return (
    <div className="gui-msg user" {...(label ? { role: 'group', 'aria-label': label } : {})}>
      <span className="gui-msg-tag">você</span>
      <GuiAttachmentChips
        attachments={item.attachments ?? []}
        className="gui-msg-attachments"
        paneId={paneId}
        presented
      />
      <GuiBrowserReferenceChips paneId={paneId} references={item.browserReferences ?? []} className="gui-msg-browser-references" />
      {item.text.trim() && <div className="gui-msg-text">{item.text}</div>}
      {stamp && (
        <span className={`gui-owner-state gui-owner-state-${stamp.tone}`}>
          <i className="gui-owner-state-mark" aria-hidden="true" />
          <span aria-hidden="true">{stamp.text}</span>
          {stamp.action && (
            <button
              type="button"
              className="gui-owner-force"
              data-tip={stamp.action.hint}
              aria-label={ownerForceLabel(item.text)}
              disabled={forcing || cancelling}
              onClick={() => void forceNow()}
            >
              {stamp.action.label}
            </button>
          )}
          {stamp.action && (
            <button type="button" className="gui-owner-force gui-owner-cancel"
              aria-label="Cancelar mensagem ainda não lida"
              data-tip="retira a mensagem: o agente não vai obedecê-la, e nada é interrompido"
              disabled={forcing || cancelling} onClick={() => void cancel()}>
              {cancelling ? 'cancelando…' : 'cancelar'}
            </button>
          )}
        </span>
      )}
      {/* Região viva SEMPRE montada (`:empty` some no CSS): nó de `role=status`
          que nasce junto com o texto costuma não ser anunciado. */}
      <div className="gui-error gui-owner-refusal" role="status">
        {refusal}
      </div>
    </div>
  )
}

function GuiMessage({
  paneId,
  item,
  showCopy,
  pace,
  onRevealComplete,
  onRevealProgress,
  onWriterBusy
}: {
  paneId: string
  item: GuiItem
  showCopy: boolean
  pace: GuiWritingPace
  onRevealComplete: (itemId: string, length: number) => void
  onRevealProgress: () => void
  onWriterBusy: (itemId: string, busy: boolean) => void
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
  if (item.kind === 'user') return <GuiOwnerBubble paneId={paneId} item={item} />
  if (item.kind === 'note') return <div className="gui-note">{item.text}</div>
  if (item.kind === 'error') return <GuiErrorLine text={item.text} />
  if (item.kind !== 'assistant') return null
  // A FALA É UM COMPONENTE SÓ, do primeiro delta à mensagem parada (mockup de
  // 2026-09-21): trocar o container ao terminar fazia o `rise` tocar de novo.
  // A única exceção é o card JSON, que só existe com o texto completo.
  const revealing = item.live || item.animateFrom < item.text.length
  const jsonCard = revealing ? null : parseGuiJsonCard(item.text)
  if (jsonCard) {
    return (
      <div className="gui-msg dev">
        <div className="gui-msg-text">
          <GuiJsonCard formatted={jsonCard.formatted} />
        </div>
        {showCopy && item.text.trim() && <GuiMessageCopy markdown={item.text} />}
      </div>
    )
  }
  return (
    <GuiStreamText
      paneId={paneId}
      text={item.text}
      initialShown={item.animateFrom}
      complete={!item.live}
      pace={pace}
      showCopy={showCopy}
      onComplete={() => onRevealComplete(item.id, item.text.length)}
      onProgress={onRevealProgress}
      onBusy={(busy) => onWriterBusy(item.id, busy)}
    />
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

/** A seta que POUSA: mesma grade de 16 e o mesmo traço de 2 dos glifos do
 *  envio — a placa de soltar fala a língua do rodapé, não a de um ícone
 *  emprestado. */
function DropGlyph(): React.JSX.Element {
  return (
    <svg
      className="gui-drop-glyph"
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
      <path d="M8 2.5v8" />
      <path d="m4.5 7 3.5 3.5L11.5 7" />
      <path d="M3 13.5h10" />
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
  missionType,
  fast,
  mcp,
  onPermissionMode,
  onFastMode,
  onExecutorChange,
  seats,
  seatId,
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
  const setGuiComposerBusy = useStore((s) => s.setGuiComposerBusy)
  const finishGuiReveal = useStore((s) => s.finishGuiReveal)
  const queueGuiMessage = useStore((s) => s.queueGuiMessage)
  const discardGuiQueuedMessage = useStore((s) => s.discardGuiQueuedMessage)
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
  // O CATÁLOGO REAL da conta (o mesmo do painel D8) — é o fallback dos menus de
  // modelo/effort enquanto as caps do CLI não chegam (o "abrindo" do boot frio
  // pode durar minutos atrás do waitForCliStable).
  const catalogByCli = useStore((s) => s.catalogByCli)
  const loadCatalog = useStore((s) => s.loadCatalog)

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
  const [selectedMode, setMode] = useState<GuiPermissionMode>(permissionMode ?? 'default')
  const mode = missionType === 'release' && selectedMode === 'plan' ? 'default' : selectedMode
  const [livePlan, setLivePlan] = useState(false)
  const displayedMode = missionType === 'release' && livePlan && gui.status !== 'dead' ? 'plan' : mode
  // R11: o fast segue o padrão do mode — estado local semeado pela prop, o
  // dono da spec guarda a escolha via onFastMode.
  const [fastOn, setFastOn] = useState<boolean>(fast ?? false)
  const [openMenu, setOpenMenu] = useState<
    'attach' | 'mode' | 'model' | 'effort' | 'context' | null
  >(null)
  const [busyMenu, setBusyMenu] = useState<'mode' | 'model' | 'effort' | 'fast' | null>(null)
  const [liveModel, setLiveModel] = useState<string | undefined>(model)
  const [liveEffort, setLiveEffort] = useState<string | undefined>(effort)
  const executorRequestRef = useRef(0)
  // A TROCA CARIMBADA DURANTE O "abrindo" (foto do dono, 2026-08-30): com o
  // spawn ainda atrás do waitForCliStable não existe sessão para receber o
  // configureExecutor — clicar dava "este pane não tem sessão aberta", um beco.
  // O clique agora fica AQUI ('' = padrão) e um efeito o aplica assim que a
  // conversa estiver de pé e livre — a ação é re-derivável, nunca perdida em
  // silêncio nem recusada sem receita.
  const pendingExecutorRef = useRef<{ model?: string; effort?: string } | null>(null)
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

  // R25.2 — A COTA DO SEAT DESTA CONVERSA, sem NENHUMA chamada nova. `usagePeek`
  // lê só o cache que o poller do main já mantém (hover do SeatRail, titlebar,
  // list_seats da delegação): cache frio devolve `null` e a linha não aparece.
  // SEM RELÓGIO NOVO de propósito — a leitura acontece quando a conversa muda
  // de estado (abrir, começar e terminar um turno), que é quando o dono olha.
  const [seatQuota, setSeatQuota] = useState<SeatUsage | null>(null)
  useEffect(() => {
    // Ponte antiga degrada INERTE (janela dev/HMR: renderer novo sobre um
    // preload que ainda não expõe `usagePeek`) — chamar `undefined` aqui
    // derrubaria o pane inteiro em vez de só esconder a linha da cota.
    const peek: ((id: string) => Promise<SeatUsage | null>) | undefined =
      window.synkora.seats.usagePeek
    if (!seatId || typeof peek !== 'function') {
      setSeatQuota(null)
      return
    }
    let alive = true
    void peek(seatId)
      .then((info) => {
        if (alive) setSeatQuota(info)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [seatId, gui.status])

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
  const { references: browserReferences, error: browserReferenceError,
    remove: removeBrowserReference, consume: consumeBrowserReferences } = useGuiBrowserReferences(paneId)
  const [submitPending, setSubmitPending] = useState(false)
  const submitInFlightRef = useRef(false)
  const latestDraftRef = useRef(draft)
  const latestAttachmentsRef = useRef(attachments)
  latestDraftRef.current = draft
  latestAttachmentsRef.current = attachments
  const [attaching, setAttaching] = useState(false)
  // A CABEÇA DO PALCO troca a conta (StageSeatChip) e não enxerga este
  // composer: publicar o "ocupado" (troca de executor ou anexo em voo) é o que
  // a impede de transplantar a conversa no meio da operação.
  useEffect(() => {
    if (readOnly) return
    setGuiComposerBusy(paneId, busyMenu !== null || attaching)
  }, [attaching, busyMenu, paneId, readOnly, setGuiComposerBusy])
  const [attachmentError, setAttachmentError] = useState<GuiComposerNoticeValue | null>(null)
  const reportAttachmentError = useCallback((message: string | null) => {
    // A new object restarts the timer even when the same file is rejected again.
    setAttachmentError(message ? { message } : null)
  }, [])
  const dismissAttachmentError = useCallback(() => setAttachmentError(null), [])
  // R33 — CITAÇÃO DO FIO. Por pane e SÓ em memória (decisão nomeada no
  // design): re-selecionar é barato, e a citação vive segundos entre o gesto
  // e o envio — persisti-la como o rascunho seria peso sem dor real.
  const [quotes, setQuotes] = useState<string[]>([])
  const [quoteNotice, setQuoteNotice] = useState<string | null>(null)
  const [selectionMenu, setSelectionMenu] = useState<{
    x: number
    y: number
    text: string
  } | null>(null)
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
  // These cards and the history reader remove the composer without unmounting
  // GuiPane. Reattach its observers when the editable surface comes back.
  const planProposalCard = isGuiTurnActive(gui.status, gui.stream) ? null : gui.planProposal
  const awaitingCard = Boolean(gui.question || gui.planReview || planProposalCard)
  const composerVisible = !readOnly && !historyTarget && !awaitingCard
  const composerFit = useGuiComposerFit(composerSurfaceRef, composerVisible)
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
      setLivePlan(replay.alive && replay.permissionMode === 'plan')
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
    gui.queued,
    gui.stream,
    gui.thinking,
    keepPinnedToEnd
  ])

  // textarea que cresce com o texto (Enter envia, Shift+Enter quebra linha).
  // A caixa cresce até 300px; depois, a barra visível permite percorrer todo
  // o rascunho e mantém o texto pintado alinhado à posição do cursor.
  useLayoutEffect(() => {
    const ta = inputRef.current
    if (!composerVisible || !ta) return
    const resize = (): void => {
      ta.style.height = 'auto'
      ta.style.height = `${Math.min(300, ta.scrollHeight)}px`
      if (mentionOverlayRef.current) syncInputOverlayScroll(ta, mentionOverlayRef.current)
    }
    resize()
    let width = ta.clientWidth
    const observer = new ResizeObserver(() => {
      if (ta.clientWidth === width) return
      width = ta.clientWidth
      resize()
    })
    observer.observe(ta)
    return () => observer.disconnect()
  }, [draft, composerVisible])

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
  // A TROCA DE CONTA (R21.2: nunca é beco, trocar no meio do turno é legítimo)
  // mudou de casa em 2026-09-08: mora no StageSeatChip da cabeça do palco.
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

  // R33 — CITAÇÃO DO FIO: seleção + botão direito no fio viram "copiar" ou
  // chip de citação no composer ("eu falo sobre essa parte que ele falou").
  // O menu só abre com seleção viva DENTRO do fio; sem seleção o gesto segue
  // o de sempre — e o token de arquivo continua com o menu próprio dele, que
  // intercepta antes de chegar aqui.
  const onThreadContextMenu = useCallback((event: React.MouseEvent): void => {
    const selection = window.getSelection()
    const container = logRef.current
    if (!selection || selection.isCollapsed || !container) return
    if (!container.contains(selection.anchorNode) || !container.contains(selection.focusNode))
      return
    const text = guiQuoteFromSelection(selection.toString())
    if (!text) return
    event.preventDefault()
    setSelectionMenu({ x: event.clientX, y: event.clientY, text })
  }, [])

  const onSelectionAction = useCallback(
    (action: GuiSelectionAction): void => {
      const current = selectionMenu
      setSelectionMenu(null)
      if (!current) return
      if (action === 'copy') {
        void navigator.clipboard?.writeText(current.text)
        return
      }
      // Teto cheio recusa COM a receita — citação do dono nunca some calada.
      if (quotes.length >= GUI_QUOTE_MAX_COUNT) {
        setQuoteNotice(
          `máximo de ${GUI_QUOTE_MAX_COUNT} citações penduradas — remova uma (✕) para citar outra`
        )
        window.setTimeout(() => setQuoteNotice(null), 4000)
        return
      }
      setQuotes((existing) =>
        existing.length >= GUI_QUOTE_MAX_COUNT ? existing : [...existing, current.text]
      )
      // O trecho virou chip: a seleção pintada já cumpriu o papel — e solta o
      // freio do scroll (R34) para o fio voltar a seguir o fim.
      window.getSelection()?.removeAllRanges()
      // O gesto termina no composer: é lá que ele vai falar sobre o trecho.
      inputRef.current?.focus({ preventScroll: true })
    },
    [quotes.length, selectionMenu]
  )

  const send = useCallback(
    async (text: string, referenceSnapshot: GuiBrowserReference[]): Promise<boolean> => {
      const message = text.trim()
      if ((!message && attachments.length === 0 && referenceSnapshot.length === 0) || !canSubmit) return false
      // R33 — as citações penduradas entram NA FRENTE do texto: uma verdade
      // só (a bolha mostra exatamente o que o modelo leu). Slash cru viaja
      // sem citação — comando é do binário, não conversa.
      const outgoing = message.startsWith('/') ? message : guiQuotedPrompt(quotes, message)
      pinnedRef.current = true
      setPinned(true)
      // Keep a busy-turn message local until delivery so its X can really
      // cancel it. Read now explicitly claims this same durable envelope.
      if (turnOpen) {
        const queued = queueGuiMessage(paneId, outgoing, {
          model: liveModel ?? null,
          effort: liveEffort ?? null,
          permissionMode: mode
        }, attachments, referenceSnapshot)
        if (queued) setQuotes([])
        else handleGuiLive(paneId, {
          type: 'limit',
          text: 'não deu para colocar na fila — sua mensagem continua no campo de texto; confira a conversa e tente enviar novamente'
        })
        return Boolean(queued)
      }
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
        setLivePlan(false)
        const revivedSent = await sendGuiMessage(paneId, outgoing, undefined, attachments, true, referenceSnapshot)
        if (revivedSent) setQuotes([])
        return revivedSent
      }
      const sent = await sendGuiMessage(paneId, outgoing, undefined, attachments, false, referenceSnapshot)
      if (sent) setQuotes([])
      return sent
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
      quotes,
      sendGuiMessage,
      turnOpen
    ]
  )

  // This explicit gesture overrides the queue timing and forces reading.
  // The queue claim excludes cancellation and duplicate dispatchers.
  const sendQueuedNow = useCallback(async () => {
    const owner = `read-now-${globalThis.crypto.randomUUID()}`
    await forceOneGuiQueuedMessage({
      claim: () => claimGuiQueuedMessage(paneId, owner),
      // O bilhete já tem identidade durável. O eco autoritativo do main cria
      // a bolha, e o retry usa o MESMO id mesmo depois de uma resposta perdida.
      deliver: (claimed) => guiApi.send(paneId, claimed.text, claimed.id, claimed.attachments, claimed.browserReferences),
      force: (messageId) => guiApi.forceOwnerMessage(paneId, messageId),
      onForceError: (error) => handleGuiLive(paneId, {
        type: 'limit', text: ownerForceRefusalText(error)
      }),
      ack: (claimed) => acknowledgeGuiQueuedMessage(paneId, claimed.id, owner),
      restore: (claimed, error) => restoreGuiQueuedMessage(paneId, claimed, error, owner)
    })
  }, [
    acknowledgeGuiQueuedMessage,
    claimGuiQueuedMessage,
    handleGuiLive,
    paneId,
    restoreGuiQueuedMessage
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
    if ((!text && attachments.length === 0 && browserReferences.length === 0) || !canSubmit || submitInFlightRef.current) return

    const draftSnapshot = draft
    const attachmentSnapshot = attachments.map((attachment) => ({ ...attachment }))
    const referenceSnapshot = structuredClone(browserReferences)
    submitInFlightRef.current = true
    setSubmitPending(true)
    void send(text, referenceSnapshot)
      .then(async (accepted) => {
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
        // Só os IDs desta fotografia deixam o rascunho. Uma nova seleção
        // recebida durante o ACK continua pendente para a próxima mensagem.
        if (accepted) await consumeBrowserReferences(referenceSnapshot)
      })
      .finally(() => {
        submitInFlightRef.current = false
        setSubmitPending(false)
      })
  }, [attachments, browserReferences, canSubmit, clearAttachments, clearDraft, consumeBrowserReferences, draft, send])

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

  /** O lote de anexos, seja qual for a porta de entrada: a régua de
   *  quantidade/tamanho é cobrada ANTES de ler um byte, cada item sobe por
   *  `upload`, e o erro de um não derruba os outros. */
  const attachBatch = useCallback(
    async (
      files: readonly File[],
      upload: (file: File) => Promise<GuiAttachResult>
    ): Promise<void> => {
      const selection = planGuiAttachmentBatch(files)
      if (selection.accepted.length === 0 && selection.errors.length === 0) return
      if (attaching || busyMenu || submitPending) return
      setOpenMenu(null)
      setAttaching(true)
      reportAttachmentError(null)
      const attached: GuiAttachmentDescriptor[] = []
      const errors = [...selection.errors]
      for (const file of selection.accepted) {
        try {
          const result = await upload(file)
          if (result.ok && result.attachment) attached.push(result.attachment)
          else errors.push(result.error ?? `não deu para anexar ${file.name}`)
        } catch (error) {
          errors.push(error instanceof Error ? error.message : `não deu para anexar ${file.name}`)
        }
      }
      const attachmentProblem = finishAttachments(attached)
      if (attachmentProblem) errors.push(attachmentProblem)
      reportAttachmentError(errors.length > 1
        ? `${errors[0]} (+${errors.length - 1} outros erros)`
        : errors[0] ?? null)
      setAttaching(false)
    },
    [attaching, busyMenu, finishAttachments, reportAttachmentError, submitPending]
  )

  /** Arquivo ESCOLHIDO (input) ou COLADO (print): os bytes sobem pelo
   *  renderer, porque aqui não existe caminho — só o File. */
  const attachFiles = useCallback(
    (fileList: FileList | readonly File[] | null): Promise<void> =>
      attachBatch(Array.from(fileList ?? []), async (file) =>
        guiApi.attach(paneId, {
          kind: 'file',
          name: file.name || 'anexo',
          bytesBase64: await readGuiFileBase64(file)
        })
      ),
    [attachBatch, paneId]
  )

  /** Item SOLTO no chat (2026-09-04, "não deu para ler Documentos da Luma"):
   *  pasta arrastada chega como File sem bytes e o FileReader morria nela. O
   *  File vai INTEIRO ao preload, que tira dele o caminho real (webUtils) — o
   *  main decide se é pasta (vira referência, como no diálogo) ou arquivo
   *  (copiado para .synkora/attachments). Nenhum caminho é digitado aqui. */
  const attachDropped = useCallback(
    (files: readonly File[]): Promise<void> =>
      attachBatch(files, (file) => guiApi.attachDropped(paneId, file)),
    [attachBatch, paneId]
  )

  const attachFolder = useCallback(async (): Promise<void> => {
    if (attaching || busyMenu || submitPending) return
    setOpenMenu(null)
    setAttaching(true)
    reportAttachmentError(null)
    try {
      const result = await guiApi.attachFolder(paneId)
      if (result.cancelled) return
      if (result.ok && result.attachment) reportAttachmentError(finishAttachments([result.attachment]))
      else reportAttachmentError(result.error ?? 'não deu para anexar a pasta')
    } catch {
      reportAttachmentError('não deu para escolher a pasta')
    } finally {
      setAttaching(false)
    }
  }, [attaching, busyMenu, finishAttachments, paneId, reportAttachmentError, submitPending])

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
        setLivePlan(false)
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

  /** A TROCA NA JANELA DO "abrindo": o clique vira carimbo em vez de erro.
   *  `true` = ficou carimbado (o chamador para por aqui); o efeito abaixo o
   *  aplica quando a conversa estiver de pé e livre. */
  const deferExecutorChange = useCallback(
    (patch: { model?: string; effort?: string }): boolean => {
      if (gui.status !== 'starting') return false
      pendingExecutorRef.current = { ...pendingExecutorRef.current, ...patch }
      handleGuiLive(paneId, {
        type: 'command-output',
        text: 'a conversa ainda está abrindo — carimbei a troca e aplico assim que ela estiver de pé'
      })
      return true
    },
    [gui.status, handleGuiLive, paneId]
  )

  // O RECONCILIADOR do carimbo: sai do "abrindo" e a conversa está livre →
  // aplica pelo MESMO caminho vivo (configureExecutor, com ACK). 'working'
  // espera o turno acabar (o main recusaria com "aguarde a resposta atual");
  // um pane que morreu no meio descarta — reabrir recomeça do spawn gravado.
  useEffect(() => {
    const pending = pendingExecutorRef.current
    if (!pending) return
    if (gui.status === 'starting' || gui.status === 'working') return
    if (gui.status === 'dead') {
      pendingExecutorRef.current = null
      return
    }
    pendingExecutorRef.current = null
    const model = pending.model === undefined ? undefined : pending.model || undefined
    let effort = pending.effort === undefined ? undefined : pending.effort || undefined
    if (pending.model !== undefined && pending.effort === undefined) {
      // O mesmo movimento do changeModel, agora com as caps vivas: modelo novo
      // só carrega o effort atual quando o suporta.
      const supported =
        gui.caps?.models.find((m) => m.value === model)?.supportedEffortLevels ?? []
      const current = gui.executorKnown ? gui.effort ?? undefined : liveEffort
      effort = current && supported.includes(current) ? current : undefined
    }
    void applyExecutorChange(
      pending.model !== undefined ? 'model' : 'effort',
      pending.model !== undefined
        ? { model: model ?? null, effort: effort ?? null }
        : { effort: effort ?? null }
    )
  }, [
    applyExecutorChange,
    gui.caps,
    gui.effort,
    gui.executorKnown,
    gui.status,
    liveEffort
  ])

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
      if (next === mode && next === displayedMode) {
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
    [applySpawnChange, displayedMode, mode, onPermissionMode, spawnChangeLocked]
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
      // "abrindo": não há sessão para o configureExecutor — o clique vira
      // carimbo e o reconciliador o aplica quando a conversa ficar de pé.
      if (deferExecutorChange({ model: next })) {
        setOpenMenu(null)
        return
      }
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
      deferExecutorChange,
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
      // "abrindo": mesmo desvio do modelo — carimba e aplica quando abrir.
      if (deferExecutorChange({ effort: next })) {
        setOpenMenu(null)
        return
      }
      const value = next || undefined
      void applyExecutorChange('effort', { effort: value ?? null })
    },
    [applyExecutorChange, deferExecutorChange, gui.effort, gui.executorKnown, liveEffort, spawnChangeLocked]
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

  // UM ESCRITOR POR CONVERSA (mockup aprovado em 2026-09-21): enquanto a fala da
  // vez tem texto pendente na tela, tudo que vem DEPOIS dela no fio espera —
  // falas, cartões de ferramenta e as decisões abaixo. O escritor avisa quando
  // ainda tem trabalho (`onBusy`); a régua de quem é o escritor e do que fica
  // retido é pura (`guiHeldItems`). Um stream que morreu no meio já revelou
  // tudo que recebeu, então nunca segura um cartão.
  const settings = useStore((s) => s.settings)
  const writingPace = useMemo(() => guiWritingPaceOf(settings), [settings])
  const [writerBusyId, setWriterBusyId] = useState<string | null>(null)
  const onWriterBusy = useCallback((itemId: string, busy: boolean) => {
    setWriterBusyId((current) => (busy ? itemId : current === itemId ? null : current))
  }, [])
  const writerBusy = writerBusyId !== null
  const renderItems = useMemo(
    () => guiThreadRenderItems(guiHeldItems(visibleItems, writerBusy)),
    [visibleItems, writerBusy]
  )
  const copyableAssistantId = useMemo(
    () =>
      guiCopyableAssistantId({
        items: gui.items,
        status: gui.status,
        stream: gui.stream,
        thinking: gui.thinking,
        awaitingInteraction: Boolean(
          gui.perm || (gui.question && gui.question.blocking !== false) || gui.planReview || gui.interactionSubmitting
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
  const stopInsteadOfSend = activityRunning && !draft.trim() && attachments.length === 0 && browserReferences.length === 0
  // O TIMER DE RODADA VIVO (R11) mudou de casa em 2026-09-08: mora no
  // StageRoundStatus da cabeça do palco, colado ao estado do turno. O PULSO
  // (o rabo do fio) lê o estado canônico direto — `guiAgentPulse` decide.
  const awaitingInteraction = Boolean(
    gui.perm || (gui.question && gui.question.blocking !== false) || gui.planReview || gui.interactionSubmitting
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
  // ANTES DAS CAPS, O CATÁLOGO (foto do dono, 2026-08-30): no "abrindo" do
  // boot frio os menus ficavam vazios e o chip de effort SUMIA por minutos. O
  // fallback é a lista REAL da conta (a mesma do painel D8), vestida na forma
  // das caps — e morre sozinho quando as caps chegam, que são a palavra do CLI.
  // A ENTRADA do catálogo desta conta entra como dependência do efeito de
  // propósito: quando o CLI muda de versão o app esquece as listas
  // (`clearCatalogs`), e é o sumiço da entrada que faz este pane pedir a nova.
  const catalogEntry = catalogByCli[`${cli}:${seatId ?? ''}`]
  useEffect(() => {
    if (readOnly || gui.caps || catalogEntry) return
    void loadCatalog(cli, seatId)
  }, [catalogEntry, cli, gui.caps, loadCatalog, readOnly, seatId])
  const catalogFallbackModels = useMemo(
    () => (gui.caps ? [] : guiComposerCatalogModels(catalogEntry)),
    [catalogEntry, gui.caps]
  )
  const modelOptions = gui.caps?.models ?? catalogFallbackModels
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
  // R25 — as duas leituras de COTA que o painel ganhou, e a nota que os menus
  // de troca passam a mostrar. Todas derivadas: nenhuma pede nada a ninguém.
  const odometer = guiOdometerPresentation(gui.convCalls, gui.convWeightTokens, gui.contextTokens)
  const usageMeters = guiUsageMetersPresentation(gui.usage)
  const seatQuotaPanel = guiSeatQuotaPresentation(seatQuota, Date.now())
  const switchNote = guiExpensiveSwitchNote(gui.contextTokens)
  // R25.3b — a conversa pesada avisa no MEDIDOR (tooltip + forma + painel),
  // nunca mais como nota no fio (ordem do dono, 2026-09-16).
  const heavyTip = guiHeavyConversationTip(gui.contextTokens)
  // O ⚡ é INTERRUPTOR e não tem menu onde pendurar a nota da troca cara: ela
  // entra na dica dele. O botão segue clicável — advisory, nunca guarda.
  const fastBaseTip = fastOn
    ? 'desligar o modo fast'
    : cli === 'claude'
      ? 'modo fast — gasta mais limite (vira Opus 5)'
      : 'modo fast — gasta mais limite'
  const fastTip = switchNote ? `${fastBaseTip} · ${switchNote}` : fastBaseTip
  const queuedMessage = gui.queued
  // The main echo replaces the queued bubble without showing the same message
  // twice while its durable ACK is still crossing the bridge.
  const queuedMessageVisible = queuedMessage && !gui.items.some(
    (item) => item.kind === 'user' && item.id === queuedMessage.id
  )

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
  const empty = gui.items.length === 0 && !gui.queued && !gui.stream && !gui.perm && !awaitingCard

  /** NADA de decidir aqui: ou o dono está lendo o histórico local por cima da
   *  conversa (`historyTarget`), ou o pane inteiro é fotografia congelada.
   *  Vale para TODA superfície que responde ao agente — inclusive as três que o
   *  overlay de histórico nunca precisou cobrir (plano, pergunta e "pode
   *  seguir"): `settleGuiReplay` não limpa `perm`/`question`/`planReview`, então
   *  um transcript que morreu no meio de uma decisão renderiza o card vivo. */
  const inert = Boolean(historyTarget) || readOnly

  // A ZONA DE SOLTAR (2026-09-04): o PANE INTEIRO aceita o arrasto de arquivos
  // e pastas enquanto o composer pode receber anexo — a mesma régua do botão +.
  // A fase (`ready` = arrasto em qualquer canto da janela, `over` = por cima do
  // pane) vem do relógio do hook, nunca do dragleave ruidoso do Chromium.
  const canAcceptDrop =
    active &&
    !inert &&
    !awaitingCard &&
    !dead &&
    !opening &&
    !attaching &&
    !submitPending &&
    busyMenu === null
  const dropPhase = useGuiDropZone(paneRef, canAcceptDrop)

  return (
    <div
      className="gui-pane"
      ref={paneRef}
      data-gui-pane-id={paneId}
      data-drop={dropPhase === 'idle' ? undefined : dropPhase}
      onFocusCapture={() => noteGuiPaneInteraction(paneId)}
      onPointerDownCapture={() => noteGuiPaneInteraction(paneId)}
      onDragOver={(event) => {
        if (!canAcceptDrop || !dragTransferHasFiles(event.dataTransfer.types)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={(event) => {
        if (!canAcceptDrop || !dragTransferHasFiles(event.dataTransfer.types)) return
        event.preventDefault()
        const files = Array.from(event.dataTransfer.files)
        if (files.length > 0) void attachDropped(files)
      }}
    >
      {/* O CABEÇALHO DE FATOS: só a FOTOGRAFIA o pede (ArchivedMissionChat).
          No palco vivo a cabeça é do Board (MissionStageHead, uma fileira) e
          este chat nasce com showHeader=false. Nada aqui é ação: a troca de
          conta e o estado do turno moram na cabeça do palco desde 2026-09-08. */}
      {showHeader && (
        <div className="gui-head">
          <span className="gui-head-cli" aria-hidden="true">
            <CliMark cli={cli} size={13} />
          </span>
          {headRole && <span className="gui-head-role">{headRole}</span>}
          {seat?.name && <span className="gui-head-where">{seat.name}</span>}
          {headModel && <span className="gui-head-model">{headModelLabel}</span>}
          {selectedEffort && <span className="gui-head-effort">{guiEffortLabel(selectedEffort)}</span>}
          {headWhere && <span className="gui-head-where">{headWhere}</span>}
        </div>
      )}

      {seatError && (
        <div className="gui-seat-error" role="alert">
          não deu para trocar a conta: {seatError}
        </div>
      )}

      {/* R33 — o menu da seleção (portal no body; a posição vem do cursor). */}
      {selectionMenu && (
        <GuiSelectionMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          onChoose={onSelectionAction}
          onDismiss={() => setSelectionMenu(null)}
        />
      )}

      {/* O palco é a âncora do "ir para o fim": preso ao .gui-pane, o botão
          cairia POR CIMA do card de permissão (que nasce entre o fio e o
          composer). Aqui ele acompanha o fim do fio, sempre. */}
      <div className="gui-stage">
        <div
          className="gui-log"
          ref={logRef}
          onScroll={onTranscriptScroll}
          onContextMenu={onThreadContextMenu}
        >
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
                  pace={writingPace}
                  onRevealComplete={(itemId, length) =>
                    finishGuiReveal(paneId, itemId, length)
                  }
                  onRevealProgress={keepPinnedToEnd}
                  onWriterBusy={onWriterBusy}
                />
              )
            )}

            {!inert && queuedMessage && queuedMessageVisible && (
              <GuiQueuedMessageCard
                paneId={paneId}
                key={queuedMessage.id}
                message={queuedMessage}
                onCancel={() => discardGuiQueuedMessage(paneId, queuedMessage.id)}
                onReadNow={() => void sendQueuedNow()}
                readNowDisabled={!canSend}
              />
            )}

            {/* O PULSO DO AGENTE: o que ele faz AGORA, com um gesto por ação e
                o relógio desde o último sinal público. Pai e ajudantes têm
                atividade própria: o pulso do pai só existe enquanto o turno
                dele está ativo, mesmo com trabalho de fundo. */}
            <GuiAgentPulse
              active={!inert}
              status={gui.status}
              turnActive={gui.turnActive}
              stream={gui.stream}
              activeAssistantId={gui.activeAssistantId}
              thinking={gui.thinking}
              contextCompacting={gui.contextCompacting}
              activityText={gui.activityText}
              awaitingInteraction={awaitingInteraction}
              items={gui.items}
              publicSilenceSince={gui.publicSilenceSince}
              onResize={keepPinnedToEnd}
            />

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

            {!inert && gui.planReview && !writerBusy && (
              <GuiPlanCard
                paneId={paneId}
                plan={gui.planReview.plan}
                disabled={Boolean(gui.interactionSubmitting)}
                onDecide={(approve) => void answerGuiPlan(projectId, paneId, approve)}
              />
            )}

            {!inert && planProposalCard && !writerBusy && (
              <GuiPlanProposalCard
                draft={planProposalCard.draft}
                disabled={Boolean(gui.interactionSubmitting)}
                onDecide={(approve, note) =>
                  void answerGuiPlanProposal(projectId, paneId, approve, note)
                }
              />
            )}

            {!inert && gui.question && !writerBusy && (
              <GuiQuestionCard
                key={gui.question.requestId}
                paneId={paneId}
                plan={gui.question.plan}
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
                    onClick={() => send('aprovado — pode seguir.', [])}
                  >
                    aprovar
                  </button>
                  <button
                    className="gui-btn"
                    disabled={!canSubmit}
                    onClick={() => send('Não aprovo a proposta que você acabou de apresentar. Não prossiga com ela.', [])}
                  >
                    não aprovar
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

        {/* "ir para o fim" é um botão redondo só com a seta, no canto do fio:
            o pill com texto flutuava por cima das frases (queixa do dono,
            09/09). O nome mora na dica e no rótulo acessível. */}
        {!pinned && (
          <button
            type="button"
            className="gui-to-end"
            aria-label="Ir para o fim da conversa"
            data-tip="Ir para o fim"
            onClick={goToEnd}
          >
            <svg
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M2.5 4.5 6 8l3.5-3.5" />
            </svg>
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
          {/* O pino do dono para a frota deste chat: a aba "ajudantes ˄" em
              cima do input, que sobe e desdobra os selects (2026-09-08). */}
          {delegatesHelpers && (
            <GuiDelegationDefaults paneId={paneId} seats={seats} cli={cli} seatId={seatId} />
          )}
          <div className="gui-composer-surface" ref={composerSurfaceRef}>
            {/* A PLACA DE POUSO: aparece no composer porque é AQUI que o chip
                vai nascer; o alvo de verdade é o pane inteiro (handlers na
                raiz) e a placa não intercepta o ponteiro. */}
            {dropPhase !== 'idle' && (
              <div className="gui-drop-pad" data-phase={dropPhase} aria-hidden="true">
                <svg className="gui-drop-pad-frame" aria-hidden="true" focusable="false">
                  <rect />
                </svg>
                <span className="gui-drop-pad-label">
                  <DropGlyph />
                  {guiDropZoneLabel(dropPhase)}
                </span>
              </div>
            )}
            <div className="gui-composer-inner" data-fit={composerFit}>
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

              {/* R33 — as citações do fio penduradas na resposta. Linha PRÓPRIA
                  do grid (área `quotes` — lição R13: filho sem área nomeada
                  cai no spacer). O title carrega o trecho; o ✕ respeita o
                  envio em voo como os anexos. */}
              {(quotes.length > 0 || quoteNotice) && (
                <div className="gui-composer-quotes">
                  {/* Sem title/tooltip nos chips (ordem do dono, 23/08) — a
                      prévia basta, e a bolha mostra o trecho inteiro no envio. */}
                  <ul className="gui-quote-chips">
                    {quotes.map((quote, index) => (
                      <li key={`${index}-${quote.slice(0, 24)}`} className="gui-quote-chip">
                        <span className="gui-quote-glyph" aria-hidden="true">
                          ❝
                        </span>
                        <span className="gui-quote-label">{guiQuoteChipLabel(quote)}</span>
                        <button
                          type="button"
                          className="gui-quote-remove"
                          aria-label="Remover citação"
                          disabled={submitPending}
                          onClick={() =>
                            setQuotes((current) => current.filter((_, at) => at !== index))
                          }
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                  {quoteNotice && (
                    <span className="gui-quote-notice" role="status">
                      {quoteNotice}
                    </span>
                  )}
                </div>
              )}

              {(attachments.length > 0 || browserReferences.length > 0) && <div className="gui-composer-attachments">
              <GuiBrowserReferenceChips
                paneId={paneId}
                references={browserReferences}
                disabled={submitPending}
                onRemove={(id) => void removeBrowserReference(id)}
              />
              <GuiAttachmentChips
                attachments={attachments}
                paneId={paneId}
                previewable={active}
                previewAnchorRef={composerSurfaceRef}
                onRemove={
                  submitPending
                    ? undefined
                    : (attachmentId) =>
                        setAttachments((current) =>
                          current.filter((attachment) => attachment.id !== attachmentId)
                        )
                }
              />
              </div>}

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
                  className={`gui-mode-btn mode-${displayedMode}`}
                  disabled={spawnChangeLocked}
                  data-tip={`Permissão desta conversa: ${PERM_MODE_LABEL[displayedMode]}\nTrocar retoma a mesma conversa com a regra nova.`}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === 'mode'}
                  aria-label={`Permissão desta conversa: ${PERM_MODE_LABEL[displayedMode]}`}
                  onClick={() => setOpenMenu((v) => (v === 'mode' ? null : 'mode'))}
                >
                  <span aria-hidden="true">{PERM_MODE_GLYPH[displayedMode]}</span>
                  <span className="gui-mode-text">
                    {busyMenu === 'mode' ? 'trocando…' : PERM_MODE_LABEL[displayedMode]}
                  </span>
                  <span className="gui-mode-short" aria-hidden="true">
                    {displayedMode === 'bypass' ? 'completo' : PERM_MODE_LABEL[displayedMode]}
                  </span>
                </button>
                {openMenu === 'mode' && (
                  <div className="gui-menu gui-mode-menu" role="menu">
                    {PERM_MODES.filter((option) => missionType !== 'release' || option.id !== 'plan').map((option) => (
                      <button
                        key={option.id}
                        className={`gui-menu-item mode-${option.id}${
                          option.id === displayedMode ? ' active' : ''
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
                  odometer={odometer}
                  usageMeters={usageMeters}
                  seat={seatQuotaPanel}
                  heavy={heavyTip}
                  open={openMenu === 'context'}
                  onOpenChange={(nextOpen) => setOpenMenu(nextOpen ? 'context' : null)}
                />
              )}

              <div className="gui-menu-host gui-composer-model">
                <button
                  className="gui-mode-btn mode-model"
                  disabled={spawnChangeLocked}
                  data-tip={`Modelo usado no próximo turno: ${liveModelLabel}`}
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
                    {/* R25.3b — ADVISORY, nunca guarda: modelo/effort/⚡ entram
                        na chave do prompt-cache, então trocar numa conversa
                        grande re-escreve o contexto inteiro. O número aparece
                        antes do clique; o clique segue livre. */}
                    {switchNote && <span className="gui-menu-foot gui-menu-cost">{switchNote}</span>}
                  </div>
                )}
              </div>

              {/* O chip de effort NÃO some no "abrindo" (foto do dono,
                  2026-08-30): sem caps e sem catálogo ainda, o nível carimbado
                  no spawn continua visível — sumir lia como effort perdido. */}
              {(effortOptions.length > 0 || (!gui.caps && Boolean(selectedEffort))) && (
                <div className="gui-menu-host gui-composer-effort">
                  <button
                    className="gui-mode-btn mode-effort"
                    disabled={spawnChangeLocked}
                    data-tip={'Esforço de raciocínio desta conversa.'}
                    aria-haspopup="menu"
                    aria-expanded={openMenu === 'effort'}
                    aria-label={`Esforço de raciocínio desta conversa: ${
                      guiEffortLabel(selectedEffort)
                    }`}
                    onClick={() => setOpenMenu((v) => (v === 'effort' ? null : 'effort'))}
                  >
                    <span aria-hidden="true">◇</span>
                    <span className="gui-mode-text">
                      {guiEffortLabel(selectedEffort)}
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
                          <b>{guiEffortLabel(option)}</b>
                        </button>
                      ))}
                      {switchNote && (
                        <span className="gui-menu-foot gui-menu-cost">{switchNote}</span>
                      )}
                      {/* espelho do menu de modelos: espera não é defeito.
                          DEPOIS do rodapé de custo de propósito — o recorte
                          das opções (test:gui-effort-menu-layout) termina no
                          switchNote e não pode ver span nenhum. */}
                      {effortOptions.length === 0 && (
                        <span className="gui-menu-foot">
                          os níveis chegam quando o CLI termina de abrir
                        </span>
                      )}
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
                  data-tip={fastTip}
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
                className={`gui-sq gui-send${stopInsteadOfSend ? ' stop' : ''}`}
                type="button"
                disabled={
                  stopInsteadOfSend
                    ? false
                    : (!draft.trim() && attachments.length === 0 && browserReferences.length === 0) || !canSubmit
                }
                data-tip={
                  stopInsteadOfSend
                    ? 'Interromper resposta · Esc'
                    : opening
                      ? 'Aguarde a conversa abrir'
                      : turnOpen
                        ? gui.queued
                          ? 'Já existe uma mensagem na fila'
                          : 'Enviar mensagem · Enter'
                        : 'Enviar · Enter'
                }
                aria-label={
                  stopInsteadOfSend
                    ? 'Interromper resposta'
                    : 'Enviar mensagem'
                }
                aria-keyshortcuts={stopInsteadOfSend ? 'Escape' : undefined}
                onClick={stopInsteadOfSend ? () => void interruptGuiPane(paneId) : () => submit()}
              >
                {stopInsteadOfSend ? <StopGlyph /> : <SendGlyph />}
              </button>
              {attachmentError && (
                <GuiComposerNotice notice={attachmentError} anchorRef={composerSurfaceRef} onDismiss={dismissAttachmentError} />
              )}
              {browserReferenceError && <div className="gui-attach-error" role="status">{browserReferenceError}</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
