import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore, type Seat, type SeatCli } from '../store'
import CliMark from './CliMark'
import { guiApi } from '../guiApi'
import {
  guiDelegationEffortOptions,
  guiDelegationModelGroups,
  guiDelegationModelOption,
  guiDelegationSummary,
  type GuiDelegationCatalog,
  type GuiDelegationDefaultsValue
} from '../guiDelegationDefaults'

// A ABINHA DO PADRÃO DOS AJUDANTES (D8 do design vinculante
// `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`).
//
// Ordem do dono (18/08, tarde): "como padrão vai vir eles; caso eu queira
// outros, aí eu falo". Aqui ele carimba UM modelo e UM effort para toda
// delegação DESTE chat; o pedido explícito do agente continua vencendo, e o
// recibo da tool diz de onde cada valor veio (explícito / painel / herdado).
//
// Ela nasce RECOLHIDA por decisão: é um pino que se mexe uma vez e se esquece —
// ocupar uma coluna permanente do chat seria cobrar atenção todo dia por uma
// escolha de minuto. E o catálogo é o REAL dos DOIS CLIs (catalog.ts), não as
// caps do pane: cross-CLI é cidadão de primeira classe, então um chat claude
// carimba `gpt-*` sem cerimônia.
//
// A montagem é do chat, mas o componente não depende dela: ele só precisa do
// paneId e das contas. Quando o rail direito existir, ele muda de casa sem
// mudar de código.

const CLI_LABEL: Record<SeatCli, string> = {
  claude: 'claude',
  codex: 'codex'
}

export default function GuiDelegationDefaults({
  paneId,
  seats
}: {
  paneId: string
  /** Contas do app: cada CLI consulta o catálogo com o config dir de uma delas
   *  (a lista de modelos é da CONTA, não do binário solto). */
  seats?: Seat[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [defaults, setDefaults] = useState<GuiDelegationDefaultsValue>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const catalogByCli = useStore((s) => s.catalogByCli)
  const loadCatalog = useStore((s) => s.loadCatalog)

  /** A conta que responde pelo catálogo daquele CLI: a logada vem primeiro
   *  (config dir com sessão é o que devolve a lista real da conta). O id vira
   *  DEPENDÊNCIA PRIMITIVA dos efeitos — `seats` é um array recriado a cada
   *  render do pai, e prendê-lo ao efeito re-pediria catálogo sem parar. */
  const seatIdFor = (cli: SeatCli): string | undefined =>
    (
      seats?.find((seat) => seat.cli === cli && seat.status === 'logado') ??
      seats?.find((seat) => seat.cli === cli)
    )?.id
  const claudeSeatId = seatIdFor('claude')
  const codexSeatId = seatIdFor('codex')

  useEffect(() => {
    let alive = true
    void guiApi.delegationDefaults(paneId).then((value) => {
      if (alive) setDefaults(value ?? {})
    })
    return () => {
      alive = false
    }
  }, [paneId])

  // Catálogo só quando a abinha ABRE: cada CLI pode custar um processo efêmero,
  // e um chat que nunca delega não deve pagar por isso. O store cacheia por
  // cli+conta, então reabrir não repete a consulta.
  useEffect(() => {
    if (!open) return
    void loadCatalog('claude', claudeSeatId)
    void loadCatalog('codex', codexSeatId)
  }, [claudeSeatId, codexSeatId, loadCatalog, open])

  const groups = useMemo(() => {
    const catalogs: GuiDelegationCatalog[] = []
    for (const [cli, seatId] of [
      ['claude', claudeSeatId],
      ['codex', codexSeatId]
    ] as const) {
      const catalog = catalogByCli[`${cli}:${seatId ?? ''}`]
      if (catalog) catalogs.push({ cli, models: catalog.models, efforts: catalog.efforts })
    }
    return guiDelegationModelGroups(catalogs)
  }, [catalogByCli, claudeSeatId, codexSeatId])

  const effortOptions = useMemo(
    () => guiDelegationEffortOptions(groups, defaults.model),
    [defaults.model, groups]
  )
  const pinnedOption = guiDelegationModelOption(groups, defaults.model)
  const summary = guiDelegationSummary(defaults)

  const apply = useCallback(
    async (patch: { model?: string | null; effort?: string | null }): Promise<void> => {
      setBusy(true)
      setError(null)
      const result = await guiApi.setDelegationDefaults(paneId, patch)
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      // A fotografia CANÔNICA vem do main: o painel nunca fica mostrando uma
      // escolha que o disco recusou.
      setDefaults({ model: result.model, effort: result.effort })
    },
    [paneId]
  )

  const chooseModel = useCallback(
    (model: string | null): void => {
      // Limpar o modelo limpa o effort junto: sem modelo não existe escala para
      // filtrar o nível, e um effort órfão seria um pino que a própria abinha
      // não sabe mais julgar.
      if (model === null) {
        void apply({ model: null, effort: null })
        return
      }
      if (model === defaults.model) return
      const supported = guiDelegationEffortOptions(groups, model)
      const keep = defaults.effort && supported.includes(defaults.effort) ? defaults.effort : null
      void apply({ model, effort: keep })
    },
    [apply, defaults.effort, defaults.model, groups]
  )

  return (
    <section className="gui-deleg-defaults" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className={`gui-deleg-tab${open ? ' open' : ''}`}
        aria-expanded={open}
        aria-label={`Padrão dos ajudantes: ${summary}`}
        data-tip={
          'O modelo e o effort com que os ajudantes deste chat abrem quando o agente não pede outros.'
        }
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="gui-deleg-tab-name">padrão dos ajudantes</span>
        <span className="gui-deleg-tab-value">{busy ? 'gravando…' : summary}</span>
      </button>

      {open && (
        <div className="gui-deleg-panel" role="group" aria-label="Padrão dos ajudantes">
          <p className="gui-deleg-note">
            vale quando o agente delega sem pedir modelo ou effort — o pedido dele sempre vence
          </p>

          <div className="gui-deleg-field">
            <span className="gui-deleg-label">modelo</span>
            <div className="gui-deleg-list">
              <button
                type="button"
                className={`gui-deleg-item${defaults.model ? '' : ' active'}`}
                disabled={busy}
                onClick={() => chooseModel(null)}
              >
                herdar da conversa
              </button>
              {groups.map((group) => (
                <div className="gui-deleg-group" key={group.cli}>
                  <span className="gui-deleg-group-head">
                    <CliMark cli={group.cli} size={11} />
                    <span>{CLI_LABEL[group.cli]}</span>
                  </span>
                  {group.options.map((option) => (
                    <button
                      key={`${group.cli}:${option.id}`}
                      type="button"
                      className={`gui-deleg-item${option.id === defaults.model ? ' active' : ''}`}
                      disabled={busy}
                      title={option.label}
                      onClick={() => chooseModel(option.id)}
                    >
                      {option.id}
                    </button>
                  ))}
                </div>
              ))}
              {groups.length === 0 && (
                <span className="gui-deleg-empty">
                  a lista de modelos chega quando os CLIs respondem
                </span>
              )}
            </div>
          </div>

          <div className="gui-deleg-field">
            <span className="gui-deleg-label">effort</span>
            <div className="gui-deleg-list">
              {!defaults.model ? (
                <span className="gui-deleg-empty">— escolha o modelo primeiro</span>
              ) : groups.length === 0 ? (
                // Catálogo ainda a caminho: dizer "fora do catálogo" aqui seria
                // acusar de errado um pino que pode estar perfeito.
                <span className="gui-deleg-empty">— os níveis chegam com o catálogo</span>
              ) : effortOptions.length === 0 ? (
                <span className="gui-deleg-empty">
                  — {pinnedOption ? `${pinnedOption.id} não aceita effort` : 'modelo fora do catálogo'}
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className={`gui-deleg-item${defaults.effort ? '' : ' active'}`}
                    disabled={busy}
                    onClick={() => void apply({ effort: null })}
                  >
                    padrão do modelo
                  </button>
                  {effortOptions.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={`gui-deleg-item${level === defaults.effort ? ' active' : ''}`}
                      disabled={busy}
                      onClick={() => void apply({ effort: level })}
                    >
                      {level}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          <div className="gui-deleg-foot">
            <button
              type="button"
              className="gui-deleg-clear"
              disabled={busy || (!defaults.model && !defaults.effort)}
              onClick={() => void apply({ model: null, effort: null })}
            >
              limpar
            </button>
            {error && (
              <span className="gui-deleg-error" role="alert">
                {error}
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
