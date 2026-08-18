import { useCallback, useEffect, useState } from 'react'
import { missionTypeOf, type GuiItem, type Mission } from '../store'
import { missionWorkspace, type MissionWorkspaceSummary } from '../missionWorkspace'
import { MISSION_STATUS_LABEL as STATUS_LABEL } from '../missionPresentation'
import MissionCommitHistory from './MissionCommitHistory'
import GuiSubagentSidebar from './GuiSubagentSidebar'

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

export default function MissionDeliveryRail({
  mission,
  versionLabel,
  queueLabel,
  guiAvailable,
  reviewReady,
  shellAvailable,
  testServerOpen,
  subagentItems = [],
  reloadToken,
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

  // ——— diff vivo da branch (onda D) ———
  const [summary, setSummary] = useState<MissionWorkspaceSummary | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [diffBusy, setDiffBusy] = useState(false)

  const refreshDiff = useCallback(async (): Promise<void> => {
    // Planejamento nem pergunta: o motor responderia "esta missão não tem
    // worktree aberto", e essa recusa correta viraria um erro na tela.
    if (planning || !missionWorkspace.available()) {
      setDiffError(null)
      setSummary(null)
      return
    }
    setDiffBusy(true)
    const res = await missionWorkspace.files(mission.id)
    setDiffBusy(false)
    if (!res.ok) {
      setDiffError(res.error ?? 'não deu para ler o diff desta branch')
      return
    }
    setDiffError(null)
    setSummary(res.summary ?? null)
  }, [mission.id, planning])

  // Mede ao entrar na missão e a cada sinal do Board (⇪, arquivar…). Abrir a
  // lista re-mede também: quem abre quer o estado de AGORA, não o do minuto
  // passado.
  useEffect(() => {
    void refreshDiff()
  }, [refreshDiff, reloadToken])

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

      {/* DIFF VIVO: o que esta branch mudou, sem sair da tela da decisão. */}
      {(diffLabel || diffError) && (
        <div className="dr-diff">
          {diffError ? (
            <span className="dr-diff-error">// {diffError}</span>
          ) : (
            <>
              <span
                className="dr-diff-stat"
                data-tip={
                  summary
                    ? `${summary.ahead} ${summary.ahead === 1 ? 'commit' : 'commits'} à frente de ${
                        mission.baseBranch ?? 'base'
                      }`
                    : undefined
                }
              >
                {diffLabel}
              </span>
              {summary && (
                <button
                  className="dr-diff-toggle"
                  aria-expanded={filesOpen}
                  data-tip={filesOpen ? 'Esconder a lista' : 'Ver os arquivos que esta branch mudou'}
                  onClick={() => {
                    const next = !filesOpen
                    setFilesOpen(next)
                    if (next) void refreshDiff()
                  }}
                >
                  {filesOpen ? '▾ ver arquivos' : '▸ ver arquivos'}
                </button>
              )}
            </>
          )}
        </div>
      )}
      {filesOpen && summary && (
        <div className="dr-files">
          {files.length === 0 && <span className="dr-files-empty">nada mudou ainda</span>}
          {files.map((file) => {
            const st = fileStatus(file.status)
            return (
              <span key={file.path} className="dr-file" data-tip={`${st.label}: ${file.path}`}>
                <i className={`dr-file-status ${st.cls}`} aria-hidden="true">
                  {st.glyph}
                </i>
                <span className="dr-file-path">{file.path}</span>
              </span>
            )
          })}
        </div>
      )}

      {/* P24: fotografia visual do histórico próprio da missão. O main já
          recortou `base..HEAD` e a expansão pede o patch de um SHA completo;
          o rail só exibe, nunca stageia, commita ou altera o worktree. */}
      {!planning && <MissionCommitHistory missionId={mission.id} reloadToken={reloadToken} />}

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
          {integration.state === 'blocked'
            ? integration.owner === 'orchestrator'
              ? '⚠ reparo pendente'
              : '⚠ decisão pendente'
            : integration.state === 'sync_required'
              ? '↻ retomar fila'
              : `⇪ fila #${integration.position}`}
        </button>
      )}
      {/* Nota de fila/conflito logo abaixo do ⇪ — é ali que a pergunta nasce. */}
      {!planning && queueLabel && <span className="dr-queue">{queueLabel}</span>}
      {!planning && integration?.lastError && (
        <span className="dr-conflict">⚠ {integration.lastError}</span>
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
