import { useCallback, useEffect, useState } from 'react'
import type { RestartableService, ServicesSnapshot, SynkoraPreferences } from '../../../preload/index'
import { useStore } from '../store'

type Choice<T extends string> = { value: T; label: string; hint: string }

function ChoiceRow<T extends string>({
  label,
  value,
  choices,
  onChange
}: {
  label: string
  value: T
  choices: Choice<T>[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="service-pref-row">
      <span>{label}</span>
      <div className="service-choice" role="group" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={choice.value === value ? 'active' : ''}
            aria-pressed={choice.value === value}
            title={choice.hint}
            onClick={() => onChange(choice.value)}
          >
            <strong>{choice.label}</strong>
            <small>{choice.hint}</small>
          </button>
        ))}
      </div>
    </div>
  )
}

function formatMs(value: number | null): string {
  if (value == null) return '—'
  if (value >= 1000) return `${(value / 1000).toFixed(1)} s`
  return `${Math.round(value)} ms`
}

const codeStateLabel: Record<NonNullable<ServicesSnapshot['codeIntelligence']>['state'], string> = {
  off: 'desligada',
  idle: 'sob demanda',
  active: 'ativa',
  degraded: 'atenção',
  closed: 'indisponível'
}

const mcpStateLabel: Record<ServicesSnapshot['internalMcp']['state'], string> = {
  starting: 'iniciando',
  ready: 'disponível',
  unavailable: 'indisponível'
}

const probeStateLabel: Record<ServicesSnapshot['codexProbe']['state'], string> = {
  idle: 'a validar',
  probing: 'verificando',
  ready: 'verificado',
  degraded: 'atenção'
}

const externalStateLabel: Record<ServicesSnapshot['externalServices']['state'], string> = {
  unchecked: 'sob demanda',
  available: 'disponível',
  unavailable: 'indisponível'
}

function ServiceCard({
  title,
  state,
  tone = 'ok',
  summary,
  detail,
  action,
  busy,
  onRestart
}: {
  title: string
  state: string
  tone?: 'ok' | 'idle' | 'warn'
  summary: string
  detail: string
  action: string
  busy: boolean
  onRestart: () => void
}): React.JSX.Element {
  return (
    <article className="service-status-card">
      <header>
        <span className={`service-dot ${tone}`} aria-hidden="true" />
        <div>
          <h3>{title}</h3>
          <small>{state}</small>
        </div>
      </header>
      <strong>{summary}</strong>
      <p>{detail}</p>
      <button type="button" disabled={busy} onClick={onRestart}>
        {busy ? 'aguarde…' : action}
      </button>
    </article>
  )
}

export default function ServicesSettings(): React.JSX.Element {
  const settings = useStore((state) => state.settings)
  const patchSettings = useStore((state) => state.patchSettings)
  const [snapshot, setSnapshot] = useState<ServicesSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<RestartableService | null>(null)
  const [includeLocalDetails, setIncludeLocalDetails] = useState(false)

  const load = useCallback(async () => {
    try {
      const next = await window.synkora.services.get(includeLocalDetails)
      setSnapshot(next)
      setError(null)
    } catch {
      setError('Não foi possível ler o estado dos serviços agora.')
    }
  }, [includeLocalDetails])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => void load(), 6_000)
    return () => window.clearInterval(timer)
  }, [load])

  const patch = <K extends keyof SynkoraPreferences>(
    key: K,
    value: SynkoraPreferences[K]
  ): void => {
    void patchSettings({ [key]: value })
      .then(load)
      .catch(() => setError('Não foi possível salvar essa preferência. Tente novamente.'))
  }

  const restart = (service: RestartableService): void => {
    setBusy(service)
    void window.synkora.services
      .restart(service)
      .then((next) => {
        setSnapshot(next)
        setError(null)
      })
      .catch(() => setError('O serviço não respondeu ao reinício. Tente novamente.'))
      .finally(() => setBusy(null))
  }

  const code = snapshot?.codeIntelligence
  const mcp = snapshot?.internalMcp
  const codex = snapshot?.codexProbe
  const external = snapshot?.externalServices
  const startup = snapshot?.paneStartup
  const codeMode = settings?.codeIntelligenceMode ?? 'automatic'
  const protocolMode = settings?.mcpProtocolMode ?? 'auto'
  const preparation = settings?.externalServicePreparation ?? 'automatic'
  const capableSeats = codex?.seats.filter((seat) => seat.capability).length ?? 0

  return (
    <div className="services-settings">
      <section className="settings-card service-preferences">
        <div className="settings-card-head">
          <div>
            <span className="settings-card-kicker">comportamento padrão</span>
            <h2>Como os agentes se preparam</h2>
            <p>Os padrões seguros funcionam sem ajuste. Use o legado como recuperação e o experimental apenas para clientes compatíveis.</p>
          </div>
        </div>
        <div className="service-pref-list">
          <ChoiceRow
            label="Inteligência de código"
            value={codeMode}
            onChange={(value) => patch('codeIntelligenceMode', value)}
            choices={[
              { value: 'automatic', label: 'Automática', hint: 'ativa quando o projeto é compatível' },
              { value: 'off', label: 'Desligada', hint: 'mantém a pesquisa textual' }
            ]}
          />
          <ChoiceRow
            label="Protocolo MCP"
            value={protocolMode}
            onChange={(value) => patch('mcpProtocolMode', value)}
            choices={[
              { value: 'auto', label: 'Automático', hint: 'moderno só quando comprovado' },
              { value: 'legacy', label: 'Legado', hint: 'modo de recuperação' },
              { value: 'modern-experimental', label: 'Experimental', hint: 'opt-in para cliente compatível' }
            ]}
          />
          <ChoiceRow
            label="Serviços externos"
            value={preparation}
            onChange={(value) => patch('externalServicePreparation', value)}
            choices={[
              { value: 'automatic', label: 'Preparação automática', hint: 'valida o runtime local no boot' },
              { value: 'on-demand', label: 'Sob demanda', hint: 'valida ao abrir o pane' }
            ]}
          />
        </div>
      </section>

      {error && <p className="services-error" role="status">{error}</p>}

      <section className="service-grid" aria-busy={!snapshot}>
        <ServiceCard
          title="Inteligência de código"
          state={codeMode === 'off' ? 'desligada' : code ? codeStateLabel[code.state] : 'carregando'}
          tone={codeMode === 'off' || code?.state === 'idle' ? 'idle' : code?.state === 'degraded' || code?.state === 'closed' ? 'warn' : 'ok'}
          summary={codeMode === 'off' ? 'Pesquisa textual preservada' : `${code?.processCount ?? 0} servidor(es) ativo(s)`}
          detail={code?.servers[0]
            ? `${code.languages.join(' e ') || 'Linguagem'} · ${code.servers[0].name} ${code.servers[0].version}`
            : 'Nenhuma linguagem detectada nesta sessão; o servidor inicia sob demanda.'}
          action="reiniciar linguagem"
          busy={busy === 'code-intelligence'}
          onRestart={() => restart('code-intelligence')}
        />
        <ServiceCard
          title="MCP interno"
          state={mcp ? mcpStateLabel[mcp.state] : 'carregando'}
          tone={mcp?.state === 'ready' ? 'ok' : 'warn'}
          summary="Legado + 2026-07-28"
          detail="Um endpoint local, autenticado separadamente para cada pane."
          action="reiniciar MCP"
          busy={busy === 'internal-mcp'}
          onRestart={() => restart('internal-mcp')}
        />
        <ServiceCard
          title="Protocolo no Codex"
          state={codex ? probeStateLabel[codex.state] : 'carregando'}
          tone={capableSeats > 0 ? 'ok' : 'idle'}
          summary={capableSeats > 0 ? `${capableSeats} conta(s) compatível(is)` : 'Fallback legado seguro'}
          detail={protocolMode === 'modern-experimental' ? 'Experimental só é ativado após a prova de capacidade.' : 'A capacidade é reavaliada quando o CLI muda de versão.'}
          action="sondar novamente"
          busy={busy === 'codex-probe'}
          onRestart={() => restart('codex-probe')}
        />
        <ServiceCard
          title="Browser e Playwright"
          state={external ? externalStateLabel[external.state] : 'carregando'}
          tone={external?.playwright.available ? 'ok' : external?.state === 'unavailable' ? 'warn' : 'idle'}
          summary={external?.playwright.available ? 'Disponível sob demanda' : external?.state === 'unavailable' ? 'Runtime indisponível' : 'Aguardando validação'}
          detail={external?.playwright.version ? `Runtime local ${external.playwright.version}; processo isolado por pane.` : 'Nenhum download acontece ao abrir um pane.'}
          action="revalidar runtime"
          busy={busy === 'external-services'}
          onRestart={() => restart('external-services')}
        />
      </section>

      <section className="settings-card startup-metrics-card">
        <div className="settings-card-head">
          <div>
            <span className="settings-card-kicker">preparação recente</span>
            <h2>Tempo até o agente responder</h2>
            <p>Resumo local da sessão atual. Prompt, saída, caminho e credenciais nunca entram nesta métrica.</p>
          </div>
        </div>
        <div className="startup-metric-strip">
          <div><span>amostras</span><strong>{startup?.samples ?? 0}</strong></div>
          <div><span>mediana</span><strong>{formatMs(startup?.p50Ms ?? null)}</strong></div>
          <div><span>p95</span><strong>{formatMs(startup?.p95Ms ?? null)}</strong></div>
          <div><span>primeiro frame</span><strong>{formatMs(startup?.milestones.terminal_first_frame.p50Ms ?? null)}</strong></div>
        </div>
      </section>

      <details
        className="service-technical"
        onToggle={(event) => setIncludeLocalDetails(event.currentTarget.open)}
      >
        <summary>Detalhes técnicos</summary>
        <div>
          <p>MCP: {mcp?.state ?? '—'}{mcp?.port ? ` · porta local ${mcp.port}` : ''}</p>
          {code?.servers.length ? code.servers.map((server, index) => (
            <p key={`${server.kind}-${index}`}>
              LSP: {server.name} {server.version} · {server.running ? 'rodando' : 'ocioso'} · {server.openDocuments} documento(s)
              {server.command ? <code>{server.command}</code> : null}
            </p>
          )) : <p>LSP: nenhum processo iniciado nesta sessão.</p>}
          {codex?.seats.length ? codex.seats.map((seat) => (
            <p key={seat.seatId}>Codex · {seat.seatName}: {seat.version ?? 'versão indisponível'} · {seat.capability ? 'moderno compatível' : 'legado'}</p>
          )) : <p>Codex: nenhum seat sondado.</p>}
        </div>
      </details>
    </div>
  )
}
