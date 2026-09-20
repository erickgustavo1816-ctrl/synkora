import type { VersionDelivery } from '../store'
import './VersionMissionDeliveries.css'

/** Persisted delivery notes, also readable after the mission chat is removed. */
export default function VersionMissionDeliveries({ deliveries }: {
  deliveries: readonly VersionDelivery[]
}): React.JSX.Element {
  return (
    <div className="vs-block">
      <span className="vs-block-title">o que já subiu nesta versão</span>
      {deliveries.map((delivery) => (
        <details key={delivery.id} className="vs-mission-delivery">
          <summary className="vs-delivery">
            <span>{delivery.title}</span>
            <time className="vs-delivery-date" dateTime={delivery.at}>
              {new Date(delivery.at).toLocaleString('pt-BR')}
            </time>
          </summary>
          <p className={`vs-mission-summary${delivery.summary?.trim() ? '' : ' pending'}`}>
            {delivery.summary?.trim() || 'Resumo ainda não registrado.'}
          </p>
        </details>
      ))}
    </div>
  )
}
