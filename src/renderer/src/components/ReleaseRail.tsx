import { useEffect, useState } from 'react'
import type { VersionReleaseRecord } from '../store'
import { releasePortraitLine } from '../releaseRailPresentation'
import DockSection from './DockSection'

// RIGHTDOCK Onda B (2026-08-22, mockup aprovado = contrato) — o trilho do
// RELEASE veste a moldura do dock: cabeçalho que diz onde o dono está + a
// seção "a subida" (quem ele é e o que faz — o miolo mínimo da R27 intacto) +
// a seção "última subida", o RETRATO da entidade R27F2 recortado por projeto.
// Contexto na hora de subir de novo: o que subiu antes, quando, com push ok?
//
// A leitura é re-derivável: uma busca ao montar + o `backlog:changed` do
// projeto (o fecho do release re-pinta o retrato sem gesto novo do dono).

export default function ReleaseRail({
  projectId,
  versionName
}: {
  projectId: string
  /** nome da versão da MISSÃO de release selecionada (quem sobe agora). */
  versionName?: string
}): React.JSX.Element {
  // `null` = ainda não lido (a seção não nasce nem pisca); `[]` = lido e o
  // projeto nunca subiu nada (a seção também não nasce — verdade, não buraco).
  const [releases, setReleases] = useState<VersionReleaseRecord[] | null>(null)

  // A metade main desta onda chega SÓ no restart do app: preload velho não tem
  // `projectReleases`, e a seção degrada com a RECEITA em vez de beco mudo.
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
          // ainda, a seção segue sem nascer — nunca um erro no trilho.
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
    <section className="release-rail dock" aria-label="Release da versão">
      <div className="dock-head">
        <span className="dock-head-kind">release</span>
        <span className="dock-head-title">· {versionName ?? 'versão'}</span>
        <span className="dock-grip" aria-hidden="true">⋮⋮</span>
      </div>

      <DockSection id="release-subida" title="a subida">
        <div className="release-rail-flow">◇ {versionName ?? '—'} · dev → main</div>
        <p className="release-rail-note">
          quem sobe é o agente (release_run) — acompanhe no chat. a aba VERSÕES
          reabre esta conversa pelo ⇪.
        </p>
      </DockSection>

      {!available && (
        <DockSection id="release-ultima" title="última subida">
          <p className="release-rail-note">
            reinicie o app (<code>npm run dev</code>) para carregar o retrato da
            última subida
          </p>
        </DockSection>
      )}
      {available && last && (
        <DockSection id="release-ultima" title="última subida">
          {/* A dica carrega o desfecho INTEIRO como o agente o leu — a linha é
              o relance; o retrato completo mora na aba Versões. */}
          <div className="release-rail-portrait" data-tip={last.outcome}>
            {releasePortraitLine(last)}
          </div>
        </DockSection>
      )}
    </section>
  )
}
