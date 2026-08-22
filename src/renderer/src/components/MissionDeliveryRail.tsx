import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { missionTypeOf, type GuiItem, type Mission } from '../store'
import { missionWorkspace, type MissionWorkspaceSummary } from '../missionWorkspace'
import { guiSubagentSidebarEntries } from '../guiSubagentSidebar'
import DockSection from './DockSection'
import { MISSION_STATUS_LABEL as STATUS_LABEL } from '../missionPresentation'
import {
  agentHasTheBall,
  agentIsResolving,
  integrationQueueNote,
  integrationShortLine,
  integrationStateWord,
  type IntegrationQueueRow
} from '../integrationQueuePresentation'
import MissionCommitHistory from './MissionCommitHistory'
import GuiSubagentSidebar from './GuiSubagentSidebar'
import GuiFileContextMenu, { useFileContextMenu } from './GuiFileContextMenu'
import GuiFileQuickReader from './GuiFileQuickReader'
import { fileContextOptions, type FileContextTarget } from '../guiFileContextMenu'
import type { FileTreeRoot } from '../../../preload/index'

// TRILHO DE ENTREGA (Synkora 2.0, onda B; enriquecido na onda D) — a coluna da
// DIREITA do mockup.
//
// Vale só para missão DIRETA: ela não tem card de plano nem kanban, então o
// que sobra do board é exatamente isto — o estado da branch e as alavancas de
// entrega. Missão legada continua com a linha `.mission-actions` de sempre.
//
// ONDA D: o cabeçalho passou a mostrar o DIFF VIVO da branch (+N −M · X
// arquivos) com um expansor "ver arquivos". A pergunta que o dono fazia antes
// de todo ⇪ ("o que mudou aí?") tinha uma única resposta possível: abrir um
// terminal e rodar git. Agora ela está na tela onde a decisão é tomada.
//
// ONDA W3 (2026-08-18, ordem do dono): as duas alavancas de AGENTE mudaram de
// natureza. O botão ✦ ajudante MORREU — quem abre ajudante é o agente do chat,
// pelo `delegate` do MCP, porque é o único caminho em que o dono vê modelo,
// effort e conta na lateral; nenhum subagente vira aba. E o 🧐 revisar parou de
// abrir conversa: ele dá um TOQUE no agente (mensagem do DONO no chat) pedindo
// o ajudante de revisão. O trilho, portanto, não abre mais pane de conversa
// nenhum — ele só fala com a conversa que já existe.

// A palavra de estado mudou para `../missionPresentation` (2026-08-15): o
// painel do projeto usa a mesma, e "integrada" aqui com "concluída" lá seriam
// dois nomes para o mesmo fato.

/** Glifo + rótulo por status do git. Status desconhecido cai no neutro: o
 *  vocabulário do motor pode crescer sem quebrar esta lista. */
const FILE_STATUS: Record<string, { glyph: string; label: string; cls: string }> = {
  A: { glyph: '+', label: 'novo', cls: 'add' },
  '?': { glyph: '+', label: 'novo (ainda fora do git)', cls: 'add' },
  M: { glyph: '~', label: 'alterado', cls: 'mod' },
  D: { glyph: '−', label: 'apagado', cls: 'del' },
  R: { glyph: '→', label: 'renomeado', cls: 'mov' },
  C: { glyph: '⧉', label: 'copiado', cls: 'mov' },
  U: { glyph: '!', label: 'em conflito', cls: 'err' }
}

function fileStatus(status: string): { glyph: string; label: string; cls: string } {
  return FILE_STATUS[status] ?? { glyph: '·', label: status, cls: 'mod' }
}

// ————— O TRILHO MEDE SOZINHO (onda W4, 2026-08-18 — bug ao vivo do dono) —————
//
// Ele viu um commit nascer e um arquivo aparecer, e o trilho seguiu dizendo
// "+0 −0 · 0 arquivos" até ele SAIR da aba e VOLTAR: o único gatilho de
// re-medida era o `reloadToken` do Board, que só anda quando o próprio dono
// clica em alguma coisa. Nas palavras dele: "tudo ali tem que atualizar em
// tempo real; não tenho que sair e voltar pra ver o que tá acontecendo".
//
// TRÊS gatilhos, um caminho de medida só:
//   (a) ATIVIDADE da conversa da missão (agente + o que os ajudantes assentam
//       no fio dele) — chega como `activityToken` do Board, com debounce de
//       CAUDA: uma rajada de deltas mede uma vez, no silêncio depois dela;
//   (b) POLL LENTO enquanto o trilho está À VISTA — a doutrina do
//       reconciliador (F6.13): nenhum passo depende de entrega única. Turno
//       longo e contínuo (que nunca cala e por isso nunca fecha o debounce)
//       é exatamente o buraco que este gatilho tapa;
//   (c) o `reloadToken` de sempre — o clique do dono (⇪, arquivar…).

/** Cauda do debounce da atividade: maior que o intervalo entre deltas de um
 *  turno (para a rajada medir UMA vez) e curta o bastante para o dono não
 *  sentir atraso depois que o agente cala. */
const RAIL_ACTIVITY_DEBOUNCE_MS = 2_500

/** Reconciliador do trilho, no mesmo princípio do board ativo da F6.13: o
 *  push pode se perder, o estado não. Só roda com o trilho À VISTA. */
const RAIL_POLL_MS = 15_000

/** Impressão digital do worktree. É ela que decide se o HISTÓRICO precisa
 *  re-ler: sem esse portão, o poll de 15s fecharia o commit expandido do dono
 *  (e a janela de diff aberta) a cada volta, sem novidade nenhuma na branch.
 *  Commit novo sempre move o `ahead`; arquivo novo/alterado move a lista. */
function workspaceFingerprint(summary: MissionWorkspaceSummary | null): string {
  if (!summary) return ''
  return [
    summary.ahead,
    summary.insertions,
    summary.deletions,
    summary.files.map((file) => `${file.status}:${file.path}`).join('|')
  ].join('|')
}

export default function MissionDeliveryRail({
  mission,
  versionLabel,
  queueLabel,
  queueRows = [],
  guiAvailable,
  reviewReady,
  shellAvailable,
  testServerOpen,
  subagentItems = [],
  reloadToken,
  visible = true,
  activityToken,
  onIntegrate,
  onReview,
  onTerminal,
  onTestServer,
  onKillTestServer,
  onArchive,
  onConclude
}: {
  mission: Mission
  versionLabel?: string
  queueLabel?: string
  /** A ORDEM REAL da fila de integração do projeto, já resolvida pelo Board
   *  (rodada 9). É ela que ocupou o lugar do véu "essa missão tá sendo
   *  integrada": o dono lê quem está na frente sem nada travar a tela. */
  queueRows?: readonly IntegrationQueueRow[]
  /** ponte do chat viva? sem ela o toque do 🧐 revisar não sai daqui */
  guiAvailable: boolean
  /** a conversa do AGENTE está aberta e pronta para receber mensagem? o 🧐
   *  revisar entra nela como uma fala do dono, então sem chat de pé não há
   *  gesto — e o porquê vai na dica, nunca num clique que não faz nada. */
  reviewReady: boolean
  /** ponte do `missions:shellSpec` viva? sem ela o terminal não tem o que abrir */
  shellAvailable: boolean
  /** já existe um pane de servidor de teste desta missão */
  testServerOpen: boolean
  /** transcript factual da conversa ativa; a seção some quando não há subagentes */
  subagentItems?: readonly GuiItem[]
  /** o Board incrementa depois do ⇪ (e de qualquer ação que mexa na branch):
   *  o diffstat re-mede sem o dono precisar clicar em nada */
  reloadToken?: number
  /** o trilho está NA TELA? O Board fica montado fora da aba e fora do projeto
   *  ativo (desmontar mataria as conversas), então quem sabe disso é ele — e
   *  sem esta palavra o poll abriria `git` para universo que ninguém olha.
   *  Padrão `true`: prop esquecida nunca deixa o trilho parado (o desfecho
   *  ruim é uma leitura barata a mais, nunca o bug que esta onda veio matar). */
  visible?: boolean
  /** contador que só ANDA quando aconteceu alguma coisa nas conversas desta
   *  missão (mensagem, resultado de ferramenta, ajudante que assenta no fio).
   *  O trilho não lê evento nenhum: ele faz o debounce de cauda em cima deste
   *  número e mede o worktree quando a rajada acaba. */
  activityToken?: number
  onIntegrate: () => void
  /** dá o toque de revisão no chat do agente (nunca abre pane) */
  onReview: () => void
  onTerminal: () => void
  onTestServer: () => void
  onKillTestServer: () => void
  onArchive: () => void
  /** planejamento: conclui num clique (missão encerra; plano/ e a aba do mapa ficam) */
  onConclude?: () => void
}): React.JSX.Element {
  const integration = mission.integration
  const live = mission.status === 'ativa'
  // MISSÃO DE PLANEJAMENTO (2.0): sem branch, sem worktree e fora da fila —
  // diff, revisão, terminal e ⇪ não têm objeto aqui. O trilho dela é uma linha
  // de natureza + a alavanca de encerrar; o entregável dela (plano/) já está no
  // repo desde que a conversa escreveu.
  const planning = missionTypeOf(mission) === 'planejamento'

  // ——— diff vivo da branch (onda D; medida viva na W4) ———
  const [summary, setSummary] = useState<MissionWorkspaceSummary | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffBusy, setDiffBusy] = useState(false)
  // RIGHTDOCK — o diff INLINE da linha clicada (seção TRABALHO). Um por vez:
  // clicar a mesma linha fecha; clicar outra troca. Duplo clique segue sendo
  // o leitor de arquivo de sempre.
  const [inlineDiff, setInlineDiff] = useState<{
    path: string
    busy: boolean
    diff?: string
    truncated?: boolean
    error?: string
  } | null>(null)
  const inlineDiffRef = useRef(inlineDiff)
  inlineDiffRef.current = inlineDiff
  // Contador PRÓPRIO do histórico: ele só anda quando a fotografia da branch
  // muda de verdade. Somado ao `reloadToken` do Board — os dois só crescem,
  // então a soma muda exatamente quando um deles muda — é o que o
  // `MissionCommitHistory` recebe.
  const [historyBump, setHistoryBump] = useState(0)
  // A janela do app está mesmo na frente? Minimizada/atrás de outro app, medir
  // é gastar `git` para ninguém (mesmo padrão do GuiPane).
  const [docVisible, setDocVisible] = useState(() => document.visibilityState === 'visible')

  // Alvo corrente: uma medida do worktree ANTERIOR que chega atrasada não pode
  // pintar o trilho da missão que o dono acabou de abrir.
  const missionRef = useRef(mission.id)
  missionRef.current = mission.id
  // COALESCÊNCIA: uma medida em voo por vez. Sem isto, o poll e a atividade
  // abririam dois `git` concorrentes no mesmo worktree.
  const measuringRef = useRef(false)
  const dirtyRef = useRef(false)
  // A impressão digital pertence a UMA missão: sem o carimbo do dono dela, a
  // primeira medida da missão seguinte compararia contra a fotografia da
  // anterior e mandaria o histórico re-ler uma leitura que ele já fez sozinho.
  const fingerprintRef = useRef<{ id: string; mark: string } | null>(null)

  // ——— ABRIR ARQUIVO ONDE O DONO QUISER (rodada 7, C1) ———
  //
  // A lista de "ver arquivos" era texto morto: o dono lia o nome do `.html` que
  // a missão produziu e não tinha saída nenhuma. Agora cada linha é alavanca —
  // clique ABRE no app (leitor de papel, o mesmo da aba Arquivos) e o botão
  // direito dá as outras duas saídas (programa padrão do sistema, mostrar na
  // pasta). O caminho é sempre RELATIVO ao worktree: quem tem caminho físico é
  // o main, que resolve a raiz pelo id da missão.
  const railRoot = useMemo<FileTreeRoot>(
    () => ({ kind: 'mission', missionId: mission.id }),
    [mission.id]
  )
  const [reader, setReader] = useState<string | null>(null)
  const openInApp = useCallback((target: FileContextTarget): void => setReader(target.path), [])
  const fileMenu = useFileContextMenu(openInApp)

  const measure = useCallback(async (): Promise<void> => {
    // Planejamento nem pergunta: o motor responderia "esta missão não tem
    // worktree aberto", e essa recusa correta viraria um erro na tela.
    if (planning || !missionWorkspace.available()) {
      setDiffError(null)
      setSummary(null)
      fingerprintRef.current = null
      return
    }
    // Gatilho durante o voo não abre leitura nova: marca sujo e sai — quem
    // está no ar re-roda UMA vez ao terminar, já com o estado de agora.
    if (measuringRef.current) {
      dirtyRef.current = true
      return
    }
    measuringRef.current = true
    const id = mission.id
    try {
      do {
        dirtyRef.current = false
        setDiffBusy(true)
        const res = await missionWorkspace.files(id)
        // Trocou de missão no meio da viagem: este resultado não é mais desta
        // tela. O `finally` abaixo ainda solta a trava.
        if (missionRef.current !== id) return
        setDiffBusy(false)
        if (!res.ok) {
          // O placar anterior FICA na tela: `git` que tropeça num poll de
          // fundo não pode apagar a fotografia boa que o dono já está lendo.
          setDiffError(res.error ?? 'não deu para ler o diff desta branch')
          continue
        }
        setDiffError(null)
        // Payload torto (motor antigo, campo faltando) também preserva o que
        // está na tela — trocar número bom por vazio seria o mesmo pisca.
        if (!res.summary) continue
        setSummary(res.summary)
        const mark = workspaceFingerprint(res.summary)
        const seen = fingerprintRef.current
        // A branch ANDOU → o histórico re-lê. Igual → ninguém encosta nele (é
        // o que mantém o commit expandido aberto durante o poll).
        if (seen && seen.id === id && seen.mark !== mark) setHistoryBump((n) => n + 1)
        fingerprintRef.current = { id, mark }
      } while (dirtyRef.current)
    } finally {
      measuringRef.current = false
      setDiffBusy(false)
    }
  }, [mission.id, planning])

  // Missão nova: a fotografia da anterior não pode sobreviver nem um frame —
  // "medindo o diff…" é honesto, número de OUTRA branch não. (Declarado ANTES
  // do efeito de medida de propósito: efeitos rodam na ordem em que aparecem.)
  useEffect(() => {
    setSummary(null)
    setDiffError(null)
    fingerprintRef.current = null
    // Leitura aberta pertence à missão que a abriu: sobreviver à troca deixaria
    // o dono lendo um arquivo de OUTRO worktree com o nome certo na moldura.
    setReader(null)
    setInlineDiff(null)
  }, [mission.id])

  // RIGHTDOCK — abre/fecha o diff inline de um arquivo. Resposta atrasada de
  // outro caminho (o dono já clicou noutra linha) não pinta a tela.
  const openFileDiff = useCallback(
    (path: string): void => {
      const current = inlineDiffRef.current
      if (current?.path === path && !current.busy) {
        setInlineDiff(null)
        return
      }
      setInlineDiff({ path, busy: true })
      void missionWorkspace.fileDiff(mission.id, path).then((res) => {
        setInlineDiff((latest) =>
          latest?.path === path
            ? res.ok
              ? { path, busy: false, diff: res.diff ?? '', truncated: res.truncated }
              : { path, busy: false, error: res.error ?? 'não deu para ler o diff deste arquivo' }
            : latest
        )
      })
    },
    [mission.id]
  )

  // A FROTA (fichas dos ajudantes) já morava no trilho; a seção só a veste e
  // conta a verdade no resumo — encerrada inclui entregue, negada e parada.
  const frota = useMemo(() => guiSubagentSidebarEntries(subagentItems), [subagentItems])
  const frotaRunning = frota.filter((entry) => entry.status === 'running').length
  const frotaSummary =
    frota.length === 0
      ? undefined
      : frotaRunning === frota.length
        ? `${frotaRunning} trabalhando`
        : frotaRunning === 0
          ? `${frota.length} encerrada${frota.length === 1 ? '' : 's'}`
          : `${frotaRunning} trabalhando · ${frota.length - frotaRunning} encerrada${
              frota.length - frotaRunning === 1 ? '' : 's'
            }`

  // (c) GATILHO DE SEMPRE: entrar na missão e cada sinal do Board (⇪,
  // arquivar…). Abrir a lista re-mede também: quem abre quer o estado de
  // AGORA, não o do minuto passado.
  useEffect(() => {
    void measure()
  }, [measure, reloadToken])

  // (a) ATIVIDADE, com debounce de CAUDA: cada evento novo rearma o relógio e
  // a faxina cancela o anterior, então uma rajada de deltas vira UMA medida —
  // no silêncio depois dela, que é justamente quando o commit já caiu.
  // Este gatilho NÃO olha para a visibilidade (o poll é que olha): o número
  // avança só quando há agente trabalhando, a cauda dá no máximo uma leitura
  // por silêncio, e assim voltar para a missão já encontra a conta feita.
  const activityRef = useRef(activityToken)
  useEffect(() => {
    if (activityToken === activityRef.current) return
    activityRef.current = activityToken
    const timer = window.setTimeout(() => void measure(), RAIL_ACTIVITY_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [activityToken, measure])

  useEffect(() => {
    const update = (): void => setDocVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  // O trilho continua MONTADO fora da aba (desmontar mataria as conversas), e
  // leitura e menu são PORTAIS em `document.body`: sem esta porta eles ficariam
  // pendurados por cima da tela que o dono abriu depois.
  const dismissMenu = fileMenu.dismiss
  useEffect(() => {
    if (visible) return
    setReader(null)
    dismissMenu(false)
  }, [visible, dismissMenu])

  // (b) POLL LENTO — só à vista, e devolvendo o intervalo ao sair de cena.
  useEffect(() => {
    if (!visible || !docVisible || planning) return
    // Voltar à vista mede NA HORA: esperar o primeiro tique seria a mesma
    // espera de que o dono reclamou.
    void measure()
    const timer = window.setInterval(() => void measure(), RAIL_POLL_MS)
    return () => window.clearInterval(timer)
  }, [visible, docVisible, planning, measure])

  const files = summary?.files ?? []
  const diffLabel = summary
    ? `+${summary.insertions} −${summary.deletions} · ${files.length} ${
        files.length === 1 ? 'arquivo' : 'arquivos'
      }`
    : diffBusy
      ? 'medindo o diff…'
      : null

  // RIGHTDOCK — o resumo da ENTREGA continua contando a verdade recolhido:
  // fila/estado quando existem, "fila vazia" quando não.
  const entregaSummary = queueLabel ?? (integration ? integrationStateWord(integration) : 'fila vazia')

  return (
    <div className="delivery-rail dock">
      {/* RIGHTDOCK (mockup aprovado = contrato): a moldura diz ONDE o dono
          está; o ⋮⋮ lembra o pega de largura (a mecânica mora intacta no
          ResizableRightRail). */}
      <div className="dock-head">
        <span className="dock-head-kind">{planning ? 'planejamento' : 'missão'}</span>
        <span className="dock-head-title">· {mission.title}</span>
        <span className={`dr-status ${mission.status}`}>{STATUS_LABEL[mission.status]}</span>
        <span className="dock-grip" aria-hidden="true">⋮⋮</span>
      </div>

      {/* A natureza no lugar onde o diff estaria: é a resposta para "o que sai
          daqui?" numa missão que não produz branch. */}
      {planning && (
        <DockSection id="planejamento" title="planejamento">
          <div className="dr-facts dr-planning">
            <span className="dr-branch" data-tip="A conversa roda na RAIZ do projeto: sem branch e sem worktree">
              ✎ escreve <code>plano/</code> na raiz do projeto
            </span>
          </div>
        </DockSection>
      )}

      {!planning && (
        <DockSection id="entrega" title="entrega" summary={entregaSummary}>
          <div className="dr-facts">
            <span className="dr-branch" data-tip={`Worktree da missão: ${mission.worktree ?? '—'}`}>
              ⎇ {mission.branch ?? 'sem branch'}
            </span>
            {summary && (
              <span
                className="dock-chip"
                data-tip={`${summary.ahead} ${summary.ahead === 1 ? 'commit' : 'commits'} desta branch à frente de ${mission.baseBranch ?? 'base'}`}
              >
                ↑{summary.ahead} à frente
              </span>
            )}
          </div>
          {(mission.baseBranch || versionLabel) && (
            <div className="dr-facts dr-facts-sub">
              {mission.baseBranch && <span className="dr-base">base: {mission.baseBranch}</span>}
              {versionLabel && <span className="dr-version">◈ {versionLabel}</span>}
            </div>
          )}

          {/* ⇪ é o PRIMÁRIO da entrega; as alavancas de trabalho viram ícones
              com a MESMA dica e as MESMAS guardas de sempre. A porteira segue
              MECÂNICA: o agente pode pedir, só o clique do dono enfileira. */}
          {live && (
            <div className="dock-acts">
              {!integration && (
                <button
                  className={`btn tiny dr-btn dr-integrate dock-primary${
                    mission.pendingIntegrationApproval ? ' approve-pending' : ''
                  }`}
                  data-tip={
                    mission.pendingIntegrationApproval
                      ? 'O agente pediu a integração — o merge SÓ anda com o SEU clique (porteira mecânica)'
                      : 'Colocar esta branch na fila serial de integração da versão'
                  }
                  onClick={onIntegrate}
                >
                  {mission.pendingIntegrationApproval
                    ? '⇪ aprovar integração'
                    : `⇪ fila da ${versionLabel ?? 'versão'}`}
                </button>
              )}
              {integration && (
                <button
                  className="btn tiny dr-btn dr-integrate dock-primary"
                  disabled={integration.state !== 'sync_required'}
                  data-tip={integration.lastError ?? queueLabel}
                  onClick={onIntegrate}
                >
                  {/* Cabeça da fila NÃO diz mais "⇪ fila #1" (rodada 9): ali a
                      bola já é do AGENTE, e o dono acompanha no fio. */}
                  {integration.state === 'blocked'
                    ? integration.owner === 'orchestrator'
                      ? '⚠ reparo pendente'
                      : '⚠ decisão pendente'
                    : integration.state === 'sync_required'
                      ? '↻ retomar fila'
                      : agentHasTheBall(integration)
                        ? integrationStateWord(integration)
                        : `⇪ ${integrationShortLine(integration)}`}
                </button>
              )}
              <button
                className="btn tiny dr-btn dock-icon"
                disabled={!guiAvailable || !reviewReady}
                data-tip={
                  !guiAvailable
                    ? 'reinicie o app (npm run dev) para habilitar o chat da missão'
                    : !reviewReady
                      ? 'a conversa do agente precisa estar aberta e pronta — o toque entra nela como uma mensagem sua'
                      : 'Revisar: manda no chat do agente, como mensagem SUA, o pedido de UM ajudante de revisão pelo MCP — código limpo, sem QA. Ele roda na lateral e volta com os achados.'
                }
                onClick={onReview}
              >
                🧐
              </button>
              <button
                className="btn tiny dr-btn dock-icon"
                disabled={!shellAvailable}
                data-tip={
                  shellAvailable
                    ? 'Terminal comum no worktree desta missão (sem agente) — o pane vai para a aba Panes'
                    : 'reinicie o app (npm run dev) para habilitar o terminal da missão'
                }
                onClick={onTerminal}
              >
                ▷
              </button>
              {testServerOpen ? (
                <button
                  className="btn tiny dr-btn dock-icon dr-danger"
                  data-tip="Derrubar o servidor de teste desta missão (fecha o pane e a árvore de processos)"
                  onClick={onKillTestServer}
                >
                  ■
                </button>
              ) : (
                <button
                  className="btn tiny dr-btn dock-icon"
                  data-tip="Terminal de teste: sobe o servidor DESTA branch para você testar. Você escolhe a porta; fechar o pane derruba o servidor."
                  onClick={onTestServer}
                >
                  ▶
                </button>
              )}
              <button
                className="btn tiny dr-btn dock-icon dr-quiet"
                data-tip="Arquivar a missão (branch preservada)"
                onClick={onArchive}
              >
                ⊟
              </button>
            </div>
          )}
          {mission.status === 'arquivada' && (
            <button className="btn tiny dr-btn" data-tip="Reativar a missão" onClick={onArchive}>
              ↩ reativar
            </button>
          )}

          {/* Nota de fila/conflito logo abaixo do ⇪ — é ali que a pergunta nasce. */}
          {queueLabel && <span className="dr-queue">{queueLabel}</span>}
          {integration?.lastError && <span className="dr-conflict">⚠ {integration.lastError}</span>}

          {/* A FILA DA <versão> — a ORDEM REAL (rodada 9). Cada linha diz a
              posição, de quem é e em que pé está. */}
          {queueRows.length > 0 && (
            <div className="dr-queue-list">
              <span className="dr-queue-head">fila da {versionLabel ?? 'versão'}</span>
              {queueRows.map((row) => {
                const stuck = row.ticket.state === 'blocked'
                const working = !stuck && (row.ticket.state === 'merging' || agentHasTheBall(row.ticket))
                const alarmed = stuck || agentIsResolving(row.ticket)
                return (
                  <span
                    key={row.missionId}
                    className={`dr-queue-row${row.mine ? ' mine' : ''}`}
                    data-tip={`${row.title}\n${integrationQueueNote(row.ticket)}`}
                  >
                    <i
                      className={`dr-queue-dot${working ? ' working' : ''}${stuck ? ' stuck' : ''}`}
                      aria-hidden="true"
                    />
                    <b className="dr-queue-pos">#{row.position}</b>
                    <span className="dr-queue-title">{row.title}</span>
                    <span className={`dr-queue-state${alarmed ? ' warn' : ''}`}>
                      {integrationStateWord(row.ticket)}
                    </span>
                  </span>
                )
              })}
            </div>
          )}
        </DockSection>
      )}

      {/* TRABALHO — o diff vivo vira seção: os arquivos SEMPRE à vista (com a
          seção aberta), ± por arquivo, clique abre o DIFF aqui e duplo clique
          lê o arquivo. W4 intacta: número na tela nunca pisca sob re-medida. */}
      {!planning && (
        <DockSection id="trabalho" title="trabalho" summary={diffLabel ?? undefined}>
          {diffError && (
            <span className={`dr-diff-error${summary ? ' dr-diff-stale' : ''}`}>// {diffError}</span>
          )}
          <div className="dr-files">
            {summary && files.length === 0 && <span className="dr-files-empty">nada mudou ainda</span>}
            {files.map((file) => {
              const st = fileStatus(file.status)
              const target: FileContextTarget = {
                projectId: mission.projectId,
                root: railRoot,
                path: file.path,
                status: file.status
              }
              // Apagado não tem arquivo para LER (o diff continua existindo):
              // `aria-disabled` no gesto de leitura, dica explica o porquê.
              const openable = fileContextOptions(target).length > 0
              const delta =
                file.insertions !== undefined || file.deletions !== undefined
                  ? { add: file.insertions ?? 0, del: file.deletions ?? 0 }
                  : null
              return (
                <div className="dr-file-wrap" key={file.path}>
                  <button
                    type="button"
                    className={`dr-file${inlineDiff?.path === file.path ? ' open' : ''}`}
                    aria-disabled={!openable && inlineDiff?.path !== file.path}
                    data-tip={
                      openable
                        ? `${st.label}: ${file.path}\nclique abre o diff aqui · duplo clique lê o arquivo · botão direito abre fora do app`
                        : `${st.label}: ${file.path}\nclique abre o diff aqui — não existe mais nesta branch, então não há arquivo para ler`
                    }
                    onClick={() => openFileDiff(file.path)}
                    onDoubleClick={() => {
                      if (openable) setReader(file.path)
                    }}
                    onContextMenu={(event) => fileMenu.openFromPointer(event, target)}
                    onKeyDown={(event) => fileMenu.openFromKeyboard(event, target)}
                  >
                    <i className={`dr-file-status ${st.cls}`} aria-hidden="true">
                      {st.glyph}
                    </i>
                    <span className="dr-file-path">{file.path}</span>
                    {delta && (
                      <span className="dr-file-delta">
                        {delta.add > 0 && <span className="add">+{delta.add}</span>}
                        {delta.del > 0 && <span className="del">−{delta.del}</span>}
                      </span>
                    )}
                  </button>
                  {inlineDiff?.path === file.path && (
                    <div className="dr-inline-diff">
                      {inlineDiff.busy ? (
                        <span className="dl">lendo o diff…</span>
                      ) : inlineDiff.error ? (
                        <span className="dl">// {inlineDiff.error}</span>
                      ) : inlineDiff.diff?.trim() ? (
                        inlineDiff.diff
                          .replace(/\n$/u, '')
                          .split('\n')
                          .map((line, index) => (
                            <span
                              key={index}
                              className={`dl${
                                line.startsWith('+') ? ' a' : line.startsWith('-') ? ' d' : ''
                              }`}
                            >
                              {line}
                            </span>
                          ))
                      ) : (
                        <span className="dl">sem diferenças contra a base</span>
                      )}
                      {inlineDiff.truncated && (
                        <span className="dl dr-inline-trunc">— cortado no teto do motor —</span>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {/* A recusa do sistema mora ao pé da lista, onde o gesto aconteceu. */}
            {fileMenu.notice && <span className="dr-file-notice">// {fileMenu.notice}</span>}
          </div>
        </DockSection>
      )}
      {fileMenu.menu && (
        <GuiFileContextMenu
          target={fileMenu.menu.target}
          options={fileMenu.menu.options}
          x={fileMenu.menu.x}
          y={fileMenu.menu.y}
          onChoose={fileMenu.choose}
          onDismiss={fileMenu.dismiss}
        />
      )}
      {reader && (
        <GuiFileQuickReader
          projectId={mission.projectId}
          root={railRoot}
          path={reader}
          onClose={() => setReader(null)}
        />
      )}

      {/* P24: fotografia visual do histórico próprio da missão — vive como
          seção IRMÃ do trabalho (o mockup mostra o trabalho vivo; o histórico
          é a mesma verdade, por commit). W4 intacta: `historyBump` só cresce
          quando a fotografia da branch MUDA. */}
      {!planning && (
        <DockSection id="historico" title="histórico" summary={summary ? `${summary.ahead} commit${summary.ahead === 1 ? '' : 's'}` : undefined}>
          <MissionCommitHistory
            missionId={mission.id}
            reloadToken={(reloadToken ?? 0) + historyBump}
          />
        </DockSection>
      )}

      {/* FROTA — as fichas que JÁ moravam no trilho, vestidas de seção; o
          resumo conta a verdade com a seção recolhida. Sem ajudante nenhum, a
          seção nem nasce (dock enxuto > seção vazia). */}
      {!planning && frota.length > 0 && (
        <DockSection id="frota" title="frota" summary={frotaSummary}>
          <GuiSubagentSidebar items={subagentItems} />
        </DockSection>
      )}

      {/* PLANEJAMENTO tem DOIS desfechos (ordem do dono, 2026-08-17): CONCLUIR
          é o caminho feliz de um clique; ARQUIVAR é a pausa (retomar ou
          excluir depois). Ficam fora das seções: são o rodapé da conversa. */}
      {planning && live && onConclude && (
        <button
          className="btn tiny dr-btn"
          data-tip="Encerra esta sessão de planejamento: a missão conclui e some da coluna; o plano/ fica no repo e o plano continua no mapa"
          onClick={onConclude}
        >
          ✔ concluir planejamento
        </button>
      )}
      {planning && (mission.status === 'ativa' || mission.status === 'arquivada') && (
        <button
          className={`btn tiny dr-btn ${live ? 'dr-quiet' : ''}`}
          data-tip={
            live
              ? 'Pausa esta sessão de planejamento para retomar depois — ou excluir de vez; o plano/ fica no repo'
              : 'Reabrir esta sessão de planejamento'
          }
          onClick={onArchive}
        >
          {live ? '⊟ arquivar planejamento' : '↩ reabrir planejamento'}
        </button>
      )}
    </div>
  )
}
