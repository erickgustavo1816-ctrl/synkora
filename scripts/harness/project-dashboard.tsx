import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectDashboard from '../../src/renderer/src/components/ProjectDashboard'
import type { MissionColumnEntry } from '../../src/renderer/src/components/MissionColumn'
import type { Mission, VersionStats } from '../../src/renderer/src/store'
import type { PlanView } from '../../src/renderer/src/planContract'

// O PAINEL DO PROJETO com o componente REAL e dados sintéticos (mockup
// aprovado: docs/mockups/painel-projeto-2026-09-26.html). Dois estados — a
// versão pronta do print do dono (dados reais daquele dia) e um exemplo com
// trabalho vivo — em duas larguras da folha. Sem IPC: a gaveta "Mudanças" lê
// uma ponte fixa. Servido por scripts/harness-serve.mjs
// (/project-dashboard.html → /project-dashboard.js + /project-dashboard.css).

const sha = (seed: string): string => seed.repeat(40).slice(0, 40)
;(window as unknown as { synkora: unknown }).synkora = {
  missions: {
    workspaceFiles: async () => ({
      ok: true,
      summary: {
        ahead: 2,
        insertions: 318,
        deletions: 96,
        files: [
          { path: 'src/renderer/src/components/ProjectDashboard.tsx', status: 'M' },
          { path: 'src/renderer/src/components/ProjectDashboard.css', status: 'A' }
        ]
      }
    }),
    workspaceFileDiff: async () => ({ ok: false }),
    commits: async () => ({
      ok: true,
      commits: [
        { sha: sha('a1'), parents: [sha('b2')], subject: 'feat(dashboard): group missions by version line', at: '2026-09-26T21:12:00.000Z' },
        { sha: sha('b2'), parents: [sha('c3')], subject: 'docs(mockups): project panel proposal', at: '2026-09-26T20:40:00.000Z' }
      ]
    }),
    commitDiff: async () => ({ ok: false })
  }
}

const V = { v10: 'v-010', v11: 'v-011', v12: 'v-012', v13: 'v-013', v14: 'v-014' }
const NAMES: Record<string, string> = {
  [V.v10]: 'V0.1.0', [V.v11]: 'V0.1.1', [V.v12]: 'V0.1.2', [V.v13]: 'V0.1.3', [V.v14]: 'V0.1.4'
}

function mission(id: string, title: string, patch: Partial<Mission>): Mission {
  return {
    id,
    projectId: 'synkora',
    title,
    status: 'concluida',
    branch: `mission/${id}`,
    createdAt: '2026-09-21T12:00:00.000Z',
    updatedAt: '2026-09-26T20:00:00.000Z',
    ...patch
  } as Mission
}

// As 10 missões reais do print (26/09): 2 na V0.1.4, 3 na V0.1.3, 2 + 2 + 1.
const HISTORY: Mission[] = [
  mission('72dafdc7', 'Arrumar UI', { versionId: V.v14, createdAt: '2026-09-26T18:00:00.000Z', completedAt: '2026-09-26T20:22:31.000Z' }),
  mission('aa216d5b', 'Bug de missões antigas', { versionId: V.v14, createdAt: '2026-09-26T17:40:00.000Z', completedAt: '2026-09-26T19:32:09.000Z' }),
  mission('8659b9ea', 'Arrumar', { versionId: V.v13, completedAt: '2026-09-22T21:43:20.000Z' }),
  mission('0e1630d7', 'Notificação', { versionId: V.v13, completedAt: '2026-09-22T21:43:07.000Z' }),
  mission('12f1417c', 'Bug claude', { versionId: V.v13, completedAt: '2026-09-22T16:40:17.000Z' }),
  mission('02e791c5', 'Nova feature', { versionId: V.v12, completedAt: '2026-09-21T18:57:33.000Z' }),
  mission('54d586fa', 'Bug', { versionId: V.v12, completedAt: '2026-09-21T19:56:02.000Z' }),
  mission('12c54cad', 'Teste', { versionId: V.v11, completedAt: '2026-09-21T16:39:39.000Z' }),
  mission('a1871b4d', 'Arrumar bug', { versionId: V.v11, completedAt: '2026-09-21T17:47:31.000Z' }),
  mission('7066ae09', 'Atualização do Synkora', { versionId: V.v10, completedAt: '2026-09-21T15:54:08.000Z' })
]

// O EXEMPLO com trabalho vivo: as marcadas com * são fictícias.
const LIVE: Mission[] = [
  mission('1eb83ae4', 'Arrumar UI', { status: 'ativa', versionId: V.v14, createdAt: '2026-09-26T20:22:57.000Z' }),
  mission('5c1e2a90', 'Tela de login*', { status: 'ativa', versionId: V.v14, createdAt: '2026-09-25T13:00:00.000Z' }),
  mission('9b7d0c13', 'Exportar relatório*', {
    status: 'ativa',
    versionId: V.v14,
    createdAt: '2026-09-24T13:00:00.000Z',
    integration: { state: 'queued', position: 1, total: 1 }
  }),
  mission('4f00d2aa', 'Plano da V0.2*', {
    status: 'ativa',
    missionType: 'planejamento',
    branch: undefined,
    createdAt: '2026-09-26T19:00:00.000Z'
  })
]

const LIVE_ENTRIES: MissionColumnEntry[] = [
  { mission: LIVE[0], seatName: 'Erick', model: 'Opus 5.5' },
  { mission: LIVE[1], seatName: 'Conta 2', model: 'gpt-5.6', pulse: 'Posso trocar o provedor de autenticação?' },
  { mission: LIVE[2], seatName: 'Erick', model: 'Opus 5.5', queueLabel: '1º na fila da V0.1.4' },
  { mission: LIVE[3], seatName: 'Erick', model: 'Opus 5.5' }
]

function plan(id: string, title: string, kind: string, statuses: string[]): PlanView {
  return {
    id,
    projectId: 'synkora',
    title,
    kind,
    status: 'aprovado',
    origin: 'agente',
    order: 0,
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-26T12:00:00.000Z',
    items: statuses.map((status, i) => ({ id: `${id}-${i}`, title: `item ${i}`, objective: '', doneCriteria: [], status }))
  } as unknown as PlanView
}

const PLANS: PlanView[] = [
  plan('p-master', 'Plano mestre V0.2*', 'mestre', ['concluida', 'concluida', 'concluida', 'em_andamento', 'backlog', 'backlog', 'backlog', 'backlog']),
  plan('p-onb', 'Onboarding*', 'normal', ['concluida', 'concluida'])
]

const READY: VersionStats[] = [{ name: 'V0.1.4', lancada: false, missoesFeitas: 2, missoesTotal: 2 }]
const BUILDING: VersionStats[] = [{ name: 'V0.1.4', lancada: false, missoesFeitas: 2, missoesTotal: 5 }]

const noop = (): void => {}
const labelOf = (m: Mission): string | undefined => (m.versionId ? NAMES[m.versionId] : undefined)

function Sheet({ width, children }: { width: number; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="h-sheet" style={{ width }}>
      <div className="board-content">{children}</div>
    </div>
  )
}

function Harness(): React.JSX.Element {
  const [width, setWidth] = useState(1107)
  return (
    <div className="h-page">
      <div className="h-bar">
        <span className="h-label">largura da folha</span>
        {[1107, 760].map((w) => (
          <button key={w} type="button" aria-pressed={w === width} onClick={() => setWidth(w)}>
            {w} px
          </button>
        ))}
      </div>
      <p className="h-label" id="pronta">
        <b>estado 1</b> · versão pronta — dados reais do print (26/09)
      </p>
      <Sheet width={width}>
        <ProjectDashboard
          missions={HISTORY}
          entries={[]}
          versoes={READY}
          versaoNaMain="V0.1.3"
          plans={[]}
          versionLabelOf={labelOf}
          onOpenMission={noop}
          onOpenPlans={noop}
          onOpenVersions={noop}
          onTestVersion={noop}
          onNewMission={noop}
        />
      </Sheet>
      <p className="h-label" id="andamento">
        <b>estado 2</b> · com trabalho em andamento — * = fictício
      </p>
      <Sheet width={width}>
        <ProjectDashboard
          missions={[...LIVE, ...HISTORY]}
          entries={LIVE_ENTRIES}
          versoes={BUILDING}
          versaoNaMain="V0.1.3"
          plans={PLANS}
          versionLabelOf={labelOf}
          onOpenMission={noop}
          onOpenPlans={noop}
          onOpenVersions={noop}
          onTestVersion={noop}
          onNewMission={noop}
        />
      </Sheet>
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<Harness />)
