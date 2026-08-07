import { Fragment, useEffect, useState } from 'react'
import { useStore, type Department } from '../store'
import { DEPARTMENTS, deptHueOf, deptHueVar } from '../departments'
import { ModelSelect, PolicyRow } from './ModelSelect'
import Select from './Select'
import { initialsOf, hueOf } from '../util'
import type { SkillState } from '../../../preload/index'

// Página GERAL do universo (F3.9): todas as configurações do projeto num
// lugar só — identidade (foto/nome/pasta), visão geral e as FUNÇÕES
// (departamentos) com política de modelos, skills e subagentes. O Maestro
// fica no painel lateral de altura total, ao lado.

// Skills/subagentes da função NESTE projeto (F4): só os INSTALADOS aparecem
// (a biblioteca completa, com instalar/atualizar/remover, mora em Configurações —
// vale para todos os universos). SEM ★/kit (decisão do usuário, 2026-07-30):
// todo executor e gate recebe TODAS as instaladas da função e escolhe
// sozinho — este painel é só o retrato do que a função tem disponível.
function SkillsPanel({
  dept,
  kind
}: {
  dept: Department
  kind: 'skill' | 'agent'
}): React.JSX.Element {
  const skillsLib = useStore((s) => s.skillsLib)
  const list = skillsLib.filter(
    (sk) => sk.kind === kind && sk.depts.includes(dept) && sk.installed
  )

  return (
    <div className="func-section">
      <span
        className="func-section-title"
        data-tip={
          kind === 'skill'
            ? 'Skills INSTALADAS desta função (a biblioteca completa fica em Configurações — vale para a máquina toda).\nTODAS entram automaticamente em todo executor e gate da função — a IA lê o menu e escolhe.'
            : 'SUBAGENTES especializados INSTALADOS desta função (biblioteca em Configurações).\nTODOS entram automaticamente nos executores da função (claude, via Task tool) — a IA escolhe;\nem ajudantes, o orquestrador aconselha o especialista e o dev abre com delegate.agent.'
        }
      >
        {kind === 'skill' ? 'skills instaladas' : 'subagentes instalados'}
      </span>
      <div className="chips-line">
        {list.length === 0 && (
          <span className="chips-empty">
            {kind === 'skill'
              ? 'nenhuma instalada — instale em Configurações › Skills'
              : 'nenhum instalado — instale em Configurações › Subagentes'}
          </span>
        )}
        {list.map((sk) => (
          <span key={sk.id} className="skill-chip owned skill-chip-inst">
            <span data-tip={`${sk.summary}\nfonte: ${sk.repo}`}>
              {kind === 'agent' ? `⬡ ${sk.id}` : `/${sk.id}`}
            </span>
            {sk.updateAvailable && (
              <span className="chip-upd" data-tip="versão nova na fonte — atualize em Configurações">
                ⟳
              </span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

function DeptCard({ projectId, dept }: { projectId: string; dept: Department }): React.JSX.Element {
  const d = DEPARTMENTS.find((x) => x.key === dept)!
  const policies = useStore((s) => s.policies)
  const setPolicy = useStore((s) => s.setPolicy)
  const seats = useStore((s) => s.seats)
  const deptHues = useStore((s) => s.deptHues)
  const setDeptHue = useStore((s) => s.setDeptHue)
  const skillsLib = useStore((s) => s.skillsLib)
  const [open, setOpen] = useState(false)
  const hue = deptHueOf(dept, deptHues)

  const policy = policies[dept]
  const seatName = (id?: string): string | undefined => seats.find((s) => s.id === id)?.name
  const hasPolicy = Boolean(policy?.heavy?.seatId || policy?.light?.seatId)
  // Skills e subagentes: biblioteca real (F4) — contagens só das instaladas.
  const deptSkills = skillsLib.filter((sk) => sk.kind === 'skill' && sk.depts.includes(dept))
  const instSkills = deptSkills.filter((sk) => sk.installed)
  const deptAgents = skillsLib.filter((sk) => sk.kind === 'agent' && sk.depts.includes(dept))
  const instAgents = deptAgents.filter((sk) => sk.installed)

  return (
    <div
      className={`func-card${open ? ' open' : ''}`}
      style={{ ['--dept-hue' as string]: deptHueVar(dept) }}
    >
      <button className="func-head" onClick={() => setOpen((v) => !v)}>
        <span className="func-icon">{d.icon}</span>
        <span className="func-name">/{d.name}</span>
        <span className="func-desc">{d.desc}</span>
        <span className="func-badges">
          <span
            className={`func-badge${deptSkills.some((sk) => sk.installed && sk.updateAvailable) ? ' warn' : ''}`}
            data-tip="skills instaladas para esta função (biblioteca em Configurações)"
          >
            {instSkills.length} skills
          </span>
          <span
            className={`func-badge${deptAgents.some((sk) => sk.installed && sk.updateAvailable) ? ' warn' : ''}`}
            data-tip="subagentes especializados instalados (biblioteca em Configurações)"
          >
            {instAgents.length} agentes
          </span>
          {hasPolicy ? (
            <>
              <span className="func-badge ok" data-tip="conta e modelo das tarefas PESADAS">
                ▲ {seatName(policy?.heavy?.seatId) ?? '—'} · {policy?.heavy?.model || 'padrão'}
              </span>
              <span className="func-badge ok" data-tip="conta e modelo das tarefas LEVES">
                ▽ {seatName(policy?.light?.seatId) ?? '—'} · {policy?.light?.model || 'padrão'}
              </span>
            </>
          ) : (
            <span className="func-badge warn">sem política</span>
          )}
        </span>
        <span className="func-caret">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="func-body">
          <div className="func-section">
            <span
              className="func-section-title"
              data-tip="Quem executa cada peso de tarefa — o Maestro classifica o peso, sua política decide o executor"
            >
              política de modelos
            </span>
            <div className="func-policy">
              <PolicyRow
                label="▲ pesadas"
                slot={policy?.heavy}
                onChange={(slot) => void setPolicy(projectId, dept, { ...policy, heavy: slot })}
              />
              <PolicyRow
                label="▽ leves"
                slot={policy?.light}
                onChange={(slot) => void setPolicy(projectId, dept, { ...policy, light: slot })}
              />
            </div>
          </div>
          <div className="func-section">
            <span
              className="func-section-title"
              data-tip={
                'Cor desta função em TODO o app (chips, cards do kanban, fios do mapa).\nVale para todos os universos desta máquina.'
              }
            >
              cor da função
            </span>
            <div className="hue-editor">
              <i className="hue-dot" style={{ background: `hsl(${hue} 55% 45%)` }} aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={359}
                value={hue}
                aria-label={`Matiz da função ${d.name}`}
                onChange={(e) => setDeptHue(dept, Number(e.target.value))}
              />
              <span className="hue-val">{hue}°</span>
              {deptHues[dept] !== undefined && (
                <button
                  className="btn ghost tiny"
                  data-tip={`voltar ao padrão (${d.hue}°)`}
                  onClick={() => setDeptHue(dept, null)}
                >
                  padrão
                </button>
              )}
            </div>
          </div>
          <SkillsPanel dept={dept} kind="skill" />
          <SkillsPanel dept={dept} kind="agent" />
        </div>
      )}
    </div>
  )
}

// REVIEWER DE CÓDIGO (gate 1) — pedido do usuário, 2026-07-30: seat + modelo
// + effort escolhidos aqui valem para o review de CÓDIGO de toda tarefa do
// projeto. Ausente = lane 'qa' do plano aprovado > política do QA > seat do
// dev. (Herdou o slot do antigo reviewer de integração, que morreu — o
// storage maestro:get/setReviewer é o mesmo.)
function ReviewerCard({ projectId }: { projectId: string }): React.JSX.Element {
  const seats = useStore((s) => s.seats)
  const [seatId, setSeatId] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')

  useEffect(() => {
    void window.synkora.maestro.getReviewer(projectId).then((r) => {
      setSeatId(r.seatId ?? '')
      setModel(r.model ?? '')
      setEffort(r.effort ?? '')
    })
  }, [projectId])

  const cli = seats.find((s) => s.id === seatId)?.cli ?? 'claude'
  const catalog = useStore((s) => s.catalogByCli[`${cli}:${seatId}`])
  const effortOpts =
    catalog?.models.find((m) => m.id === model)?.efforts ?? catalog?.efforts ?? []
  const save = (s: string, m: string, ef: string): void => {
    void window.synkora.maestro.setReviewer(projectId, s || undefined, m || undefined, ef || undefined)
  }

  return (
    <div className="func-card open reviewer-card">
      <div className="func-body">
        <div className="func-section">
          <span
            className="func-section-title"
            data-tip={
              'Quem revisa o CÓDIGO de cada tarefa (gate 1 — diff apenas; quem\ntesta funcionando é o QA). Sem escolha, vale a cadeia automática:\nlane qa do plano aprovado > política do QA > seat do dev'
            }
          >
            🧐 reviewer de código (gate 1)
          </span>
          <div className="func-policy">
            <div className="policy-row">
              <span className="policy-label">reviewer</span>
              <Select
                value={seatId}
                onChange={(v) => {
                  setSeatId(v)
                  setModel('')
                  setEffort('')
                  save(v, '', '')
                }}
                options={[
                  { value: '', label: '— automático (lane do plano > política do QA) —' },
                  ...seats.map((s) => ({ value: s.id, label: s.name, cli: s.cli }))
                ]}
              />
              <ModelSelect
                cli={cli}
                seatId={seatId || undefined}
                value={model}
                disabled={!seatId}
                onChange={(m) => {
                  setModel(m)
                  save(seatId, m, effort)
                }}
              />
              <Select
                value={effort}
                disabled={!seatId || effortOpts.length === 0}
                tip="effort de raciocínio do reviewer de código"
                onChange={(v) => {
                  setEffort(v)
                  save(seatId, model, v)
                }}
                options={[
                  { value: '', label: 'effort padrão' },
                  ...effortOpts.map((ef) => ({ value: ef, label: ef }))
                ]}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ProjectGeneral({ projectId }: { projectId: string }): React.JSX.Element {
  const project = useStore((s) => s.projects.find((p) => p.id === projectId))
  const setProjectPhoto = useStore((s) => s.setProjectPhoto)
  const removeProjectPhoto = useStore((s) => s.removeProjectPhoto)
  const renameProject = useStore((s) => s.renameProject)
  const relocateProject = useStore((s) => s.relocateProject)
  // Mesmo retrato do card da Home (recorte da versão corrente): a Home fica
  // montada com o projeto aberto e os canais *:changed dela mantêm isto
  // fresco; aqui só garantimos a primeira leitura.
  const stats = useStore((s) => s.homeStats[projectId])
  const loadHomeStats = useStore((s) => s.loadHomeStats)
  const [relocError, setRelocError] = useState<string | null>(null)

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
            data-tip="Trocar a foto do projeto"
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
        <div className="pg-fields">
          <input
            key={project.name}
            className="pg-name"
            defaultValue={project.name}
            data-tip="Nome do projeto — Enter ou clique fora para salvar"
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== project.name) void renameProject(projectId, v)
            }}
          />
          <div className="pg-path-row">
            <span className="pg-path" data-tip={project.path}>
              {project.path}
            </span>
            <button
              className="btn ghost tiny"
              data-tip="Alterar a pasta do projeto (renomeou/moveu fora do app?)"
              onClick={() => {
                setRelocError(null)
                void relocateProject(projectId).then(setRelocError)
              }}
            >
              📁 alterar pasta
            </button>
          </div>
          {relocError && <div className="pg-error">✗ {relocError}</div>}
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


      <div className="section-label">funções</div>
      <div className="pg-funcs">
        {DEPARTMENTS.map((d) => (
          <DeptCard key={d.key} projectId={projectId} dept={d.key} />
        ))}
      </div>

      <div className="section-label">reviewer de código</div>
      <ReviewerCard projectId={projectId} />
    </div>
  )
}
