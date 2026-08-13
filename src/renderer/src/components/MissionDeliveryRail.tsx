import type { Mission } from '../store'

// TRILHO DE ENTREGA (Synkora 2.0, onda B) — a coluna da DIREITA do mockup.
//
// Vale só para missão DIRETA: ela não tem card de plano nem kanban, então o
// que sobra do board é exatamente isto — o estado da branch e as alavancas de
// entrega. Missão legada continua com a linha `.mission-actions` de sempre.

const STATUS_LABEL: Record<Mission['status'], string> = {
  ativa: 'em andamento',
  integrando: 'integrando agora',
  concluida: 'integrada',
  arquivada: 'arquivada'
}

export default function MissionDeliveryRail({
  mission,
  versionLabel,
  queueLabel,
  guiAvailable,
  shellAvailable,
  testServerOpen,
  onIntegrate,
  onReview,
  onHelper,
  onTerminal,
  onTestServer,
  onKillTestServer,
  onArchive
}: {
  mission: Mission
  versionLabel?: string
  queueLabel?: string
  /** ponte do chat viva? sem ela revisar/ajudante não têm o que abrir */
  guiAvailable: boolean
  /** ponte do `missions:shellSpec` viva? sem ela o terminal não tem o que abrir */
  shellAvailable: boolean
  /** já existe um pane de servidor de teste desta missão */
  testServerOpen: boolean
  onIntegrate: () => void
  onReview: () => void
  onHelper: () => void
  onTerminal: () => void
  onTestServer: () => void
  onKillTestServer: () => void
  onArchive: () => void
}): React.JSX.Element {
  const integration = mission.integration
  const live = mission.status === 'ativa'

  return (
    <div className="delivery-rail">
      <div className="dr-head">
        <span className="dr-title">entrega</span>
        <span className={`dr-status ${mission.status}`}>{STATUS_LABEL[mission.status]}</span>
      </div>

      <div className="dr-facts">
        <span className="dr-branch" data-tip={`Worktree da missão: ${mission.worktree ?? '—'}`}>
          ⎇ {mission.branch ?? 'sem branch'}
        </span>
        {mission.baseBranch && <span className="dr-base">base: {mission.baseBranch}</span>}
        {versionLabel && <span className="dr-version">◈ {versionLabel}</span>}
        {queueLabel && <span className="dr-queue">{queueLabel}</span>}
      </div>

      {/* ⇪ — a porteira é MECÂNICA: o agente pode pedir, mas só o clique do
          dono enfileira. Missão direta não tem card de plano para "concluir",
          então a única condição é a missão estar viva; árvore suja é recusada
          pelo servidor com a mensagem exata do que falta commitar. */}
      {live && !integration && (
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
          {mission.pendingIntegrationApproval ? '⇪ aprovar integração' : '⇪ fila da versão'}
        </button>
      )}
      {live && integration && (
        <button
          className="btn tiny dr-btn dr-integrate"
          disabled={integration.state !== 'sync_required'}
          data-tip={integration.lastError ?? queueLabel}
          onClick={onIntegrate}
        >
          {integration.state === 'blocked'
            ? integration.owner === 'orchestrator'
              ? '⚠ reparo pendente'
              : '⚠ Maestro decidindo'
            : integration.state === 'sync_required'
              ? '↻ retomar fila'
              : `⇪ fila #${integration.position}`}
        </button>
      )}

      {live && (
        <>
          {/* Revisor = conversa NOVA sobre o que a branch entregou. Nasce limpa
              de propósito: quem revisa não pode herdar o contexto de quem
              escreveu. Reabrir volta o foco para a rodada em andamento. */}
          <button
            className="btn tiny dr-btn"
            disabled={!guiAvailable}
            data-tip={
              guiAvailable
                ? 'Abre um revisor em conversa LIMPA sobre o diff desta branch (ele não herda o contexto do agente)'
                : 'reinicie o app (npm run dev) para habilitar o chat da missão'
            }
            onClick={onReview}
          >
            🧐 revisar · sessão limpa
          </button>
          <button
            className="btn tiny dr-btn"
            disabled={!guiAvailable}
            data-tip={
              guiAvailable
                ? 'Abre mais um agente no MESMO worktree para trabalhar em paralelo'
                : 'reinicie o app (npm run dev) para habilitar o chat da missão'
            }
            onClick={onHelper}
          >
            ✦ ajudante
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

      {(mission.status === 'ativa' || mission.status === 'arquivada') && (
        <button
          className={`btn tiny dr-btn ${live ? 'dr-quiet' : ''}`}
          data-tip={live ? 'Arquivar a missão (branch preservada)' : 'Reativar a missão'}
          onClick={onArchive}
        >
          {live ? '⊟ arquivar' : '↩ reativar'}
        </button>
      )}
    </div>
  )
}
