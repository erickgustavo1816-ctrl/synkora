import type { SeatUsage, UsageMeter } from '../../../preload/index'

// ————————————————————————————————————————————————————————————————————————
// LIMITES DE USO — apresentação compartilhada (titlebar e hover do SeatRail).
//
// O main manda medidores já normalizados (ver src/main/seatUsage.ts); aqui só
// viram barra. Mora num componente porque os dois lugares que mostram limite
// precisam mostrar a MESMA coisa — quando o formato do dado mudou, a versão
// duplicada no SeatRail ficou para trás e passou a exibir "sem dados".
// ————————————————————————————————————————————————————————————————————————

function Meter({ m, index }: { m: UsageMeter; index: number }): React.JSX.Element {
  const tone = m.severity >= 0.85 ? 'hot' : m.severity >= 0.6 ? 'warm' : 'cool'
  return (
    <div className="usage-meter" style={{ animationDelay: `${index * 55}ms` }}>
      <div className="meter-top">
        <span className="meter-label">
          {m.label}
          {m.window && <i className="meter-win">{m.window}</i>}
        </span>
        <span className={`meter-val ${tone}`}>
          {m.mode === 'left' ? `restam ${m.pct}%` : `${m.pct}%`}
        </span>
      </div>
      <div className={`meter-track ${m.mode}`}>
        <i className={`meter-fill ${tone}`} style={{ width: `${Math.max(2, m.pct)}%` }} />
      </div>
      {m.reset && <div className="meter-reset">reseta {m.reset}</div>}
    </div>
  )
}

interface Props {
  /** null = ainda consultando o CLI */
  info: SeatUsage | null
}

export default function UsageMeters({ info }: Props): React.JSX.Element {
  if (info === null) {
    return (
      <div className="usage-skeleton" aria-label="consultando limites">
        <i />
        <i />
      </div>
    )
  }
  if (info.meters.length > 0) {
    return (
      <>
        {info.meters.map((m, i) => (
          <Meter key={i} m={m} index={i} />
        ))}
      </>
    )
  }
  // sem medidor reconhecido: o texto cru do CLI é melhor que uma caixa vazia
  if (info.lines.length > 0) {
    return (
      <>
        {info.lines.map((l, i) => (
          <div key={i} className="usage-line muted">
            {l}
          </div>
        ))}
      </>
    )
  }
  return <div className="usage-line muted">sem dados de uso para este seat</div>
}
