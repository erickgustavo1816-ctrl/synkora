import { Fragment, useEffect } from 'react'
import { useStore } from '../store'
import { initialsOf, hueOf } from '../util'

// Página GERAL do universo — ONDA D (2026-08-13): demolida ao osso.
//
// Saíram daqui: as FUNÇÕES inteiras (política de modelos, cor, skills e
// subagentes por departamento) e o "reviewer de código" — pipeline da era F6,
// que a virada 2.0 não usa; e o NOME/PASTA do projeto, que subiram para a
// barra de abas do universo (identidade fica onde ela é sempre visível).
//
// O que sobra é o que o dono lê nesta tela: a foto do universo e o RETRATO
// POR VERSÃO. O centro do ✦ geral é a conversa de planejamento, que mora na
// coluna do Board ao lado.

export default function ProjectGeneral({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)
  const removeProjectPhoto = useStore((s) => s.removeProjectPhoto)
  // Mesmo retrato do card da Home (recorte da versão corrente): a Home fica
  // montada com o projeto aberto e os canais *:changed dela mantêm isto
  // fresco; aqui só garantimos a primeira leitura.
  const stats = useStore((s) => s.homeStats[projectId])
  const loadHomeStats = useStore((s) => s.loadHomeStats)

  useEffect(() => {
    if (!stats) void loadHomeStats(projectId)
  }, [stats, loadHomeStats, projectId])

  if (!project) return <></>

  // trabalho vivo fora de qualquer versão (tarefa solta em execução/qa) — só
  // aparece quando existe, para não sumir com trabalho de verdade
  const avulsas = stats
    ? Math.max(0, stats.emCurso - stats.versoes.reduce((a, v) => a + v.emExec, 0))
    : 0

  return (
    <div className="project-general">
      <div className="pg-identity">
        <div className="pg-avatar-wrap">
          <button
            className="pg-avatar"
            style={{ ['--card-hue' as string]: hueOf(project.name) }}
            data-tip="Trocar a foto do universo"
            onClick={() => void setProjectPhoto(projectId)}
          >
            {project.photo ? <img src={project.photo} alt="" draggable={false} /> : initialsOf(project.name)}
          </button>
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
        {/* Retrato POR VERSÃO em dev (decisão 2026-07-29): pode haver várias
            abertas ao mesmo tempo — uma linha por versão, e o acumulado de
            cada uma zera quando ela lança. A soma da história mora na aba
            Versões. */}
        <div className="pg-versions">
          {!stats || stats.versoes.length === 0 ? (
            <div className="pgv-empty">
              {stats ? 'sem versões — o trabalho aparece aqui por versão' : 'lendo…'}
            </div>
          ) : (
            <div className="pgv-grid">
              {stats.versoes.map((v) => (
                <Fragment key={v.name}>
                  <span
                    className={`pgv-name${v.lancada ? ' released' : ''}`}
                    data-tip={
                      v.lancada
                        ? 'Já lançada — o que ela entregou (está na main)'
                        : 'Versão aberta em construção'
                    }
                  >
                    ◈ {v.name}
                  </span>
                  <div
                    className="stat-tile"
                    data-tip={`missões entregues na ${v.name} / total (entregues + vivas)`}
                  >
                    <span className="stat-num">
                      {v.missoesTotal > 0 ? `${v.missoesFeitas}/${v.missoesTotal}` : '0'}
                    </span>
                    <span className="stat-label">missões</span>
                  </div>
                  <div className="stat-tile hot" data-tip={`tarefas da ${v.name} em execução/QA agora`}>
                    <span className="stat-num">{v.emExec}</span>
                    <span className="stat-label">em execução</span>
                  </div>
                  <div
                    className="stat-tile ok"
                    data-tip={`tarefas das missões da ${v.name} — concluídas/total`}
                  >
                    <span className="stat-num">
                      {v.total > 0 ? `${v.feitas}/${v.total}` : '0'}
                    </span>
                    <span className="stat-label">concluídas</span>
                  </div>
                </Fragment>
              ))}
              {avulsas > 0 && (
                <div className="pgv-loose">
                  ✧ {avulsas} em execução fora de versão (tarefas soltas)
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
