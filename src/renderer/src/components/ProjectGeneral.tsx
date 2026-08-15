import { useStore } from '../store'
import { initialsOf, hueOf } from '../util'

// ✦ GERAL = A PORTA DE ENTRADA DO UNIVERSO (ordem do dono, 2026-08-15).
//
// "Não quero mais aquela página geral — a landing do projeto tem que ser a
// pessoa criando uma missão." O RETRATO POR VERSÃO (◈ V1.0 · N missões · em
// execução · concluídas) que ocupava esta tela mudou de casa: foi para a aba
// VERSÕES, onde ele convive com as versões que descreve ("uma página inteira
// para aquilo não faz sentido"). O mockup já mandava o mesmo recado —
// docs/MOCKUP_WORKSPACE.md: "os números do projeto são CHIPS NA TOPBAR, nunca
// um cartão ocupando o centro" — e a barra do universo já os carrega.
//
// O que sobra aqui é o CONVITE: uma frase, a explicação do que é uma missão e
// o botão que abre o MESMO modal da coluna da esquerda (quem guarda o estado
// do modal é o Board — esta tela só pede a abertura). A foto do universo fica
// como rodapé discreto: é a única alavanca de identidade que vive dentro do
// workspace (o rail e a Home também trocam a foto, mas nenhum dos dois está
// aqui dentro).

export default function ProjectGeneral({
  projectId,
  missionCount,
  onNewMission
}: {
  projectId: string
  /** missões VIVAS do universo — decide o convite (a primeira × mais uma) */
  missionCount: number
  onNewMission: () => void
}): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)
  const removeProjectPhoto = useStore((s) => s.removeProjectPhoto)

  if (!project) return <></>

  const first = missionCount === 0

  return (
    <div className="project-general">
      <section className="pg-start">
        <p className="pg-start-title">{first ? 'crie a primeira missão' : 'abra uma missão'}</p>
        <p className="pg-start-text">
          {first ? (
            <>
              Todo trabalho deste universo nasce como missão: uma conversa com o agente já
              dentro de um worktree próprio. No modal você escolhe <b>produto</b> — branch
              isolada, que entra na fila ⇪ quando ficar pronta — ou <b>planejamento</b>, a
              conversa que escreve o <code>plano/</code> na raiz.
            </>
          ) : (
            <>
              As missões abertas estão na coluna ao lado — clique numa para voltar à conversa
              dela. Frente nova de trabalho pede missão nova, com worktree próprio.
            </>
          )}
        </p>
        <button
          className="btn accent pg-start-cta"
          data-tip={
            'Nova missão: branch e worktree próprios, com o agente já dentro.\n' +
            'No modal dá para escolher PLANEJAMENTO — a conversa que escreve o plano/ na raiz.'
          }
          onClick={onNewMission}
        >
          + nova missão
        </button>
      </section>

      {/* Rodapé de identidade: a foto do universo. Discreta de propósito — o
          centro desta tela é o convite acima, não o retrato do projeto. */}
      <div className="pg-identity">
        <button
          className="pg-avatar"
          style={{ ['--card-hue' as string]: hueOf(project.name) }}
          data-tip="Trocar a foto do universo"
          onClick={() => void setProjectPhoto(projectId)}
        >
          {project.photo ? <img src={project.photo} alt="" draggable={false} /> : initialsOf(project.name)}
        </button>
        <span className="pg-identity-hint">foto do universo — clique para trocar</span>
        {project.photo && (
          <button
            className="pg-photo-remove"
            data-tip="Remover a foto (volta às iniciais)"
            onClick={() => void removeProjectPhoto(projectId)}
          >
            × remover
          </button>
        )}
      </div>
    </div>
  )
}
