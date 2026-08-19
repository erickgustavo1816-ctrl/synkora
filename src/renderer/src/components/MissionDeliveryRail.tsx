import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { missionTypeOf, type GuiItem, type Mission } from '../store'
import { missionWorkspace, type MissionWorkspaceSummary } from '../missionWorkspace'
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
  const [filesOpen, setFilesOpen] = useState(false)
  const [diffBusy, setDiffBusy] = useState(false)
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
  }, [mission.id])

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

  return (
    <div className="delivery-rail">
      <div className="dr-head">
        <span className="dr-title">{planning ? 'planejamento' : 'entrega'}</span>
        <span className={`dr-status ${mission.status}`}>{STATUS_LABEL[mission.status]}</span>
      </div>

      {/* A natureza no lugar onde o diff estaria: é a resposta para "o que sai
          daqui?" numa missão que não produz branch. */}
      {planning && (
        <div className="dr-facts dr-planning">
          <span className="dr-branch" data-tip="A conversa roda na RAIZ do projeto: sem branch e sem worktree">
            ✎ escreve <code>plano/</code> na raiz do projeto
          </span>
        </div>
      )}

      {/* DIFF VIVO: o que esta branch mudou, sem sair da tela da decisão.
          O ramo do `summary` vem PRIMEIRO de propósito (W4): com número na
          tela, nem "medindo o diff…" nem um erro passageiro tomam o lugar
          dele — re-medir a cada 15s não pode piscar debaixo da leitura. */}
      {(diffLabel || diffError) && (
        <div className="dr-diff">
          {summary ? (
            <>
              <span
                className="dr-diff-stat"
                data-tip={`${summary.ahead} ${
                  summary.ahead === 1 ? 'commit' : 'commits'
                } à frente de ${mission.baseBranch ?? 'base'}`}
              >
                {diffLabel}
              </span>
              <button
                className="dr-diff-toggle"
                aria-expanded={filesOpen}
                data-tip={filesOpen ? 'Esconder a lista' : 'Ver os arquivos que esta branch mudou'}
                onClick={() => {
                  const next = !filesOpen
                  setFilesOpen(next)
                  if (next) void measure()
                }}
              >
                {filesOpen ? '▾ ver arquivos' : '▸ ver arquivos'}
              </button>
            </>
          ) : diffError ? (
            <span className="dr-diff-error">// {diffError}</span>
          ) : (
            <span className="dr-diff-stat">{diffLabel}</span>
          )}
        </div>
      )}
      {/* Falha DEPOIS de já haver número: o placar fica e a queixa desce para a
          própria linha. Apagar a fotografia boa por um `git` que tropeçou seria
          justamente o pisca que esta onda veio matar — e sumir com o aviso
          esconderia uma falha que insiste. */}
      {summary && diffError && <span className="dr-diff-error dr-diff-stale">// {diffError}</span>}
      {filesOpen && summary && (
        <div className="dr-files">
          {files.length === 0 && <span className="dr-files-empty">nada mudou ainda</span>}
          {files.map((file) => {
            const st = fileStatus(file.status)
            const target: FileContextTarget = {
              projectId: mission.projectId,
              root: railRoot,
              path: file.path,
              status: file.status
            }
            // Apagado nesta branch não tem o que abrir (nem pasta para mostrar):
            // a linha continua legível, só não vira gesto. `aria-disabled` em vez
            // de `disabled` porque botão desabilitado não emite hover — e a dica
            // que EXPLICA o porquê morreria junto.
            const openable = fileContextOptions(target).length > 0
            return (
              <button
                key={file.path}
                type="button"
                className="dr-file"
                aria-disabled={!openable}
                data-tip={
                  openable
                    ? `${st.label}: ${file.path}\nclique lê aqui · botão direito abre fora do app`
                    : `${st.label}: ${file.path}\nnão existe mais nesta branch — não há o que abrir`
                }
                onClick={() => {
                  if (openable) setReader(file.path)
                }}
                onContextMenu={(event) => fileMenu.openFromPointer(event, target)}
                onKeyDown={(event) => fileMenu.openFromKeyboard(event, target)}
              >
                <i className={`dr-file-status ${st.cls}`} aria-hidden="true">
                  {st.glyph}
                </i>
                <span className="dr-file-path">{file.path}</span>
              </button>
            )
          })}
          {/* A recusa do sistema mora ao pé da lista, onde o gesto aconteceu. */}
          {fileMenu.notice && <span className="dr-file-notice">// {fileMenu.notice}</span>}
        </div>
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

      {/* P24: fotografia visual do histórico próprio da missão. O main já
          recortou `base..HEAD` e a expansão pede o patch de um SHA completo;
          o rail só exibe, nunca stageia, commita ou altera o worktree.
          W4: o histórico anda pelos MESMOS gatilhos do diffstat — a medida é
          uma só —, mas o `historyBump` só cresce quando a fotografia da branch
          MUDA. Os dois contadores são monotônicos, então a soma muda
          exatamente quando um deles muda. */}
      {!planning && (
        <MissionCommitHistory
          missionId={mission.id}
          reloadToken={(reloadToken ?? 0) + historyBump}
        />
      )}

      {!planning && <GuiSubagentSidebar items={subagentItems} />}

      {!planning && (
        <div className="dr-facts">
          <span className="dr-branch" data-tip={`Worktree da missão: ${mission.worktree ?? '—'}`}>
            ⎇ {mission.branch ?? 'sem branch'}
          </span>
          {mission.baseBranch && <span className="dr-base">base: {mission.baseBranch}</span>}
          {versionLabel && <span className="dr-version">◈ {versionLabel}</span>}
        </div>
      )}

      {live && !planning && (
        <>
          {/* REVISAR = um TOQUE no agente desta missão (ordem do dono, 18/08).
              O clique não abre nada: ele manda no chat, como mensagem DO DONO,
              o pedido de UM ajudante de revisão pelo `delegate` do MCP, com o
              mandato estrito de code review (o texto é contrato e mora em
              `missionReviewNudge`). A sessão do revisor continua nascendo LIMPA
              — headless, sem herdar o contexto de quem escreveu o código —, só
              que como ajudante na lateral, e não como mais uma aba: é assim que
              modelo, effort e conta dele ficam visíveis. */}
          <button
            className="btn tiny dr-btn"
            disabled={!guiAvailable || !reviewReady}
            data-tip={
              !guiAvailable
                ? 'reinicie o app (npm run dev) para habilitar o chat da missão'
                : !reviewReady
                  ? 'a conversa do agente precisa estar aberta e pronta — o toque entra nela como uma mensagem sua'
                  : 'Manda no chat do agente, como mensagem SUA, o pedido de UM ajudante de revisão pelo MCP: código limpo, bem escrito, refatoração — sem QA.\nEle roda na lateral, em sessão headless nova, e volta com os achados por gravidade.'
            }
            onClick={onReview}
          >
            🧐 revisar
          </button>
          {/* Terminal CRU no worktree (`missions:shellSpec`): shell de verdade,
              sem CLI, sem persona e sem MCP — para o dono rodar git, um script
              solto ou olhar um arquivo com as próprias mãos. Nasce no deck de
              panes como qualquer outro pane shell. */}
          <button
            className="btn tiny dr-btn"
            disabled={!shellAvailable}
            data-tip={
              shellAvailable
                ? 'Abre um terminal comum no worktree desta missão (sem agente) — o pane vai para a aba Panes'
                : 'reinicie o app (npm run dev) para habilitar o terminal da missão'
            }
            onClick={onTerminal}
          >
            ▷ terminal
          </button>
          {/* Utilidade irmã: sobe o SCRIPT do projeto (o mesmo ▶ testar de
              sempre) num pane de terminal, com a porta escolhida no modal. */}
          {testServerOpen ? (
            <button
              className="btn tiny dr-btn dr-danger"
              data-tip="Derrubar o servidor de teste desta missão (fecha o pane e a árvore de processos)"
              onClick={onKillTestServer}
            >
              ■ derrubar teste
            </button>
          ) : (
            <button
              className="btn tiny dr-btn"
              data-tip="Sobe o servidor DESTA branch num terminal para você testar. Você escolhe a porta; fechar o pane derruba o servidor."
              onClick={onTestServer}
            >
              ▶ terminal de teste
            </button>
          )}
        </>
      )}

      {/* ⇪ — o mockup põe a integração DEPOIS de um divisor, em acento: é a
          alavanca irreversível do trilho, e ela não se confunde com as de
          trabalho acima. A porteira é MECÂNICA: o agente pode pedir, mas só o
          clique do dono enfileira. Missão direta não tem card de plano para
          "concluir", então a única condição é a missão estar viva; árvore suja
          é recusada pelo servidor com a mensagem exata do que falta commitar. */}
      {live && !planning && <div className="dr-divider" aria-hidden="true" />}
      {live && !planning && !integration && (
        <button
          className={`btn tiny dr-btn dr-integrate${
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
      {live && !planning && integration && (
        <button
          className="btn tiny dr-btn dr-integrate"
          disabled={integration.state !== 'sync_required'}
          data-tip={integration.lastError ?? queueLabel}
          onClick={onIntegrate}
        >
          {/* Cabeça da fila NÃO diz mais "⇪ fila #1" (rodada 9): ali a bola já
              é do AGENTE — ou ele está subindo a branch, ou resolvendo o
              conflito —, e o dono acompanha isso no fio, não numa janela. */}
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
      {/* Nota de fila/conflito logo abaixo do ⇪ — é ali que a pergunta nasce. */}
      {!planning && queueLabel && <span className="dr-queue">{queueLabel}</span>}
      {!planning && integration?.lastError && (
        <span className="dr-conflict">⚠ {integration.lastError}</span>
      )}

      {/* A FILA DA <versão> — a ORDEM REAL (rodada 9, 2026-08-19).
          O véu que travava o board no "integrando" morreu; quem conta o que
          está acontecendo é esta lista, e o TRABALHO em si aparece no fio da
          conversa do agente. Cada linha diz a posição, de quem é e em que pé
          está — cabeça de fila com erro se lê como o AGENTE resolvendo, nunca
          como um "integrando" congelado. Nenhuma animação nova: o único
          movimento é o `tb-status-pulse` que o app já usa para "trabalhando". */}
      {!planning && queueRows.length > 0 && (
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

      {/* ARQUIVAR — a única alavanca que a missão de PLANEJAMENTO também tem
          (por isso este bloco é o único do trilho sem `!planning`: diff,
          revisão, terminal e ⇪ não têm objeto sem worktree).
          Ela se chamava "⊟ concluir planejamento" e o dono, procurando
          arquivar, leu o trilho inteiro sem achar o que procurava (2026-08-17):
          duas palavras para o MESMO ato — o clique sempre foi o mesmo
          `archiveMission` — deixavam a alavanca invisível para quem não sabia
          que concluir era arquivar. Sem confirmação, como na missão de dev: o
          gesto se desfaz no próprio trilho. */}
      {/* PLANEJAMENTO tem DOIS desfechos (ordem do dono, 2026-08-17): CONCLUIR
          é o caminho feliz de um clique — a missão encerra, sai da coluna, o
          plano/ fica no repo e o plano segue no mapa (nada de excluir depois);
          ARQUIVAR é a pausa — retomar futuramente ou excluir de vez. */}
      {planning && live && onConclude && (
        <button
          className="btn tiny dr-btn"
          data-tip="Encerra esta sessão de planejamento: a missão conclui e some da coluna; o plano/ fica no repo e o plano continua no mapa"
          onClick={onConclude}
        >
          ✔ concluir planejamento
        </button>
      )}
      {(mission.status === 'ativa' || mission.status === 'arquivada') && (
        <button
          className={`btn tiny dr-btn ${live ? 'dr-quiet' : ''}`}
          data-tip={
            live
              ? planning
                ? 'Pausa esta sessão de planejamento para retomar depois — ou excluir de vez; o plano/ fica no repo'
                : 'Arquivar a missão (branch preservada)'
              : planning
                ? 'Reabrir esta sessão de planejamento'
                : 'Reativar a missão'
          }
          onClick={onArchive}
        >
          {live
            ? planning
              ? '⊟ arquivar planejamento'
              : '⊟ arquivar'
            : planning
              ? '↩ reabrir planejamento'
              : '↩ reativar'}
        </button>
      )}
    </div>
  )
}
