import type { ReleaseChangeRecord } from '../../../shared/releaseChanges'

/** The journal reports saved code and declared checks, never an installer publication. */
export default function ReleaseChangeHistory({ changes }: {
  changes?: ReleaseChangeRecord[]
}): React.JSX.Element | null {
  if (!changes?.length) return null
  return (
    <div className="release-change-history" style={{ overflowWrap: 'anywhere' }}>
      <p className="release-rail-label">correções da release · {changes.length}</p>
      {changes.map((change) => (
        <details key={change.id} className="release-rail-note">
          <summary>{change.summary} · {change.state === 'saved' ? 'salva' : change.state === 'prepared' ? 'registro pendente' : 'não aplicada'}</summary>
          <p>{new Date(change.at).toLocaleString('pt-BR')} · {change.sha.slice(0, 12)} · {change.phase === 'before-release' ? 'antes da subida' : 'após a subida'}</p>
          <p>{change.reason}</p>
          <p>arquivos: {change.files.join(', ')}</p>
          <p>validação informada pelo agente: {change.validation}</p>
          {change.phase === 'after-release' && change.state === 'saved' && (
            <p>{change.pushedAt ? 'envio ao remoto confirmado' : 'salva localmente; envio ao remoto não confirmado'}</p>
          )}
        </details>
      ))}
    </div>
  )
}
