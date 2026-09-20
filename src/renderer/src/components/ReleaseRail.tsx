import { useEffect, useState } from 'react'
import type { VersionReleaseRecord } from '../store'
import { releasePortraitLine } from '../releaseRailPresentation'
import DockSection from './DockSection'
import ReleaseChangeHistory from './ReleaseChangeHistory'

// O TRILHO DO RELEASE — R27 (2026-08-20) → RIGHTDOCK Onda B (2026-08-22) →
// PAINÉIS DO WORKSPACE (2026-09-09).
//
// Ordem do dono (09/09): "não quero que seja uma coisa, outro outra — deixa
// padronizado, e no código também". O chat do release veste EXATAMENTE a
// moldura dos painéis da missão e do planejamento: este componente é o gêmeo
// do MissionDeliveryRail — a mesma raiz .delivery-rail.dock, o mesmo
// .dock-head legado (a grade do workspace o dissolve por CSS) e seções
// DockSection que viram janelas do WorkspacePanels. O release tem UMA janela,
// "Release": a subida (quem sobe e para onde) e o RETRATO da última subida (a
// entidade R27F2 recortada por projeto — contexto na hora de subir de novo).
// A alavanca de DESCARTAR mudou de casa: mora na cabeça do palco
// (ReleaseHeaderActions), na fileira em que a missão tem as suas.
//
// A leitura é re-derivável: uma busca ao montar + o "backlog:changed" do
// projeto (o fecho do release re-pinta o retrato sem gesto novo do dono).

export default function ReleaseRail({
  projectId,
  versionName,
  targetBranch
}: {
  projectId: string
  /** nome da versão da MISSÃO de release selecionada (quem sobe agora). */
  versionName?: string
  targetBranch?: string
}): React.JSX.Element {
  // "null" = ainda não lido (o retrato não nasce nem pisca); "[]" = lido e o
  // projeto nunca subiu nada (também não nasce — verdade, não buraco).
  const [releases, setReleases] = useState<VersionReleaseRecord[] | null>(null)

  // A metade main desta onda chega SÓ no restart do app: preload velho não tem
  // "projectReleases", e o retrato degrada com a RECEITA em vez de beco mudo.
  const available = Boolean(window.synkora.backlog?.projectReleases)

  useEffect(() => {
    const backlog = window.synkora.backlog
    const reader = backlog?.projectReleases
    if (!backlog || !reader) return
    let alive = true
    const read = (): void => {
      void reader(projectId)
        .then((list) => {
          if (alive) setReleases(list)
        })
        .catch(() => {
          // Leitura que tropeça preserva o que está na tela; sem nada lido
          // ainda, o retrato segue sem nascer — nunca um erro no painel.
        })
    }
    read()
    const off = backlog.onChanged((pid) => {
      if (pid === projectId) read()
    })
    return () => {
      alive = false
      off()
    }
  }, [projectId])

  // A MAIS RECENTE primeiro é contrato do store (append põe na frente).
  const last = releases?.[0]

  return (
    <div className="delivery-rail dock">
      {/* A moldura LEGADA (header V1 de duas linhas, rodada 2 do dock) — a
          mesma do trilho da missão; dentro da grade do workspace ela não é
          desenhada (workspacePanels.css): o painel tem cabeçalho próprio. */}
      <div className="dock-head">
        <div className="dock-head-l1">
          <span className="dock-head-kind">release</span>
          <span className="dock-grip" aria-hidden="true">⋮⋮</span>
        </div>
        <div className="dock-head-title" data-tip={versionName ?? 'versão'}>
          {versionName ?? 'versão'}
        </div>
      </div>

      {/* O PAINEL "RELEASE": a subida em cima; a última subida embaixo, quando
          o projeto já subiu alguma coisa. A dica do retrato carrega o desfecho
          INTEIRO como o agente o leu — a linha é o relance; o retrato completo
          mora na aba Versões. */}
      <DockSection id="release" title="release">
        <div className="release-rail-flow">◇ {versionName ?? '—'} → {targetBranch ?? 'destino no chat'}</div>
        <p className="release-rail-note">
          quem sobe é o agente (release_run) — acompanhe no chat. a aba VERSÕES
          reabre esta conversa pelo ⇪.
        </p>
        {!available && (
          <p className="release-rail-note">
            reinicie o app (<code>npm run dev</code>) para carregar o retrato da
            última subida
          </p>
        )}
        {available && last && (
          <div className="release-rail-last">
            <span className="release-rail-label">última subida</span>
            <div className="release-rail-portrait" data-tip={last.outcome}>
              {releasePortraitLine(last)}
            </div>
            <ReleaseChangeHistory changes={last.changes} />
          </div>
        )}
      </DockSection>
    </div>
  )
}
