import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { useStore, type Seat, type SeatCli } from '../store'
import CliMark from './CliMark'
import { prettyModel } from './PaneChrome'
import { guiApi } from '../guiApi'
import { guiModelShortName } from '../guiComposerPresentation'
import {
  guiDelegationEffortOptions,
  guiDelegationModelGroups,
  guiDelegationModelOption,
  guiDelegationSummary,
  type GuiDelegationCatalog,
  type GuiDelegationDefaultsValue,
  type GuiDelegationModelNamer
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
//
// R7 §B2 — "Tá muito feio... Opus Rochetes um milhão". O painel mostrava id CRU
// onde o composer mostra nome digno. Agora o TÍTULO é o nome (mesma régua do
// seletor do composer) e o id desce para metadado; a superfície inteira passou
// pelo `polish` da skill impeccable (papel & painel, sem animação nova).

const CLI_LABEL: Record<SeatCli, string> = {
  claude: 'claude',
  codex: 'codex'
}

/**
 * A FONTE ÚNICA DO NOME DIGNO — as duas metades da régua do composer, do jeito
 * que o seletor de modelo as usa: o nome que o catálogo escolheu primeiro, o
 * embelezador do identificador quando ele não escolheu nenhum. Nada é
 * reescrito aqui; se o composer mudar de voz, o painel muda junto.
 */
const MODEL_NAMER: GuiDelegationModelNamer = ({ id, displayName }) =>
  guiModelShortName({ value: id, displayName, resolvedModel: id }, prettyModel(id))

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
  /** Os dois catálogos já RESPONDERAM (com lista ou com falha) nesta abertura.
   *  É o que separa "esperando" de "não veio nada" — sem ele, o painel dava a
   *  mesma frase para os dois, e a espera parecia defeito. */
  const [catalogSettled, setCatalogSettled] = useState(false)
  const catalogByCli = useStore((s) => s.catalogByCli)
  const loadCatalog = useStore((s) => s.loadCatalog)
  const panelId = useId()

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

  /** Catálogo quando a abinha ABRE — e também quando há PINO para nomear. A
   *  linha recolhida é a superfície que o dono mais vê, e era ela que escrevia
   *  `opus[1m]`: sem o catálogo não existe nome digno para carregar ali. Chat
   *  sem pino e sem abrir continua não pagando processo nenhum. */
  const needsCatalog = open || Boolean(defaults.model)

  // O store cacheia por cli+conta e o main cacheia a consulta ao CLI, então
  // reabrir não repete nada — e `allSettled` é o que deixa a recusa de um CLI
  // ser uma RESPOSTA, não uma promessa solta virando rejeição sem dono.
  useEffect(() => {
    if (!needsCatalog) return
    let alive = true
    setCatalogSettled(false)
    void Promise.allSettled([
      loadCatalog('claude', claudeSeatId),
      loadCatalog('codex', codexSeatId)
    ]).then(() => {
      if (alive) setCatalogSettled(true)
    })
    return () => {
      alive = false
    }
  }, [claudeSeatId, codexSeatId, loadCatalog, needsCatalog])

  const groups = useMemo(() => {
    const catalogs: GuiDelegationCatalog[] = []
    for (const [cli, seatId] of [
      ['claude', claudeSeatId],
      ['codex', codexSeatId]
    ] as const) {
      const catalog = catalogByCli[`${cli}:${seatId ?? ''}`]
      if (catalog) catalogs.push({ cli, models: catalog.models, efforts: catalog.efforts })
    }
    return guiDelegationModelGroups(catalogs, MODEL_NAMER)
  }, [catalogByCli, claudeSeatId, codexSeatId])

  const effortOptions = useMemo(
    () => guiDelegationEffortOptions(groups, defaults.model),
    [defaults.model, groups]
  )
  const pinnedOption = guiDelegationModelOption(groups, defaults.model)
  const summary = guiDelegationSummary(defaults, groups)
  /** Pino que o catálogo carregado não conhece. Ele CONTINUA valendo no motor,
   *  então escondê-lo seria o estado mais enganoso deste painel: o dono veria
   *  "herdar da conversa" ligado enquanto um modelo está carimbado. */
  const pinnedOutsideCatalog = Boolean(defaults.model) && !pinnedOption && groups.length > 0

  const apply = useCallback(
    async (patch: {
      model?: string | null
      effort?: string | null
      fast?: boolean | null
    }): Promise<void> => {
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
      setDefaults({ model: result.model, effort: result.effort, fast: result.fast })
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
        aria-controls={panelId}
        aria-label={`Padrão dos ajudantes: ${summary}`}
        data-tip={
          'O modelo, o effort e o fast com que os ajudantes deste chat abrem quando o agente não pede outros.'
        }
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="gui-deleg-tab-name">padrão dos ajudantes</span>
        <span className="gui-deleg-tab-value">{busy ? 'gravando…' : summary}</span>
      </button>

      {open && (
        <div
          className="gui-deleg-panel"
          id={panelId}
          role="group"
          aria-label="Padrão dos ajudantes"
          aria-busy={busy || undefined}
        >
          <p className="gui-deleg-note">
            vale quando o agente delega sem pedir modelo, effort ou fast — o pedido dele sempre
            vence
          </p>

          <div className="gui-deleg-field">
            <span className="gui-deleg-label" id={`${panelId}-modelo`}>
              modelo
            </span>
            <div className="gui-deleg-list" role="group" aria-labelledby={`${panelId}-modelo`}>
              <div className="gui-deleg-chips">
                <button
                  type="button"
                  className="gui-deleg-item"
                  aria-pressed={!defaults.model}
                  disabled={busy}
                  onClick={() => chooseModel(null)}
                >
                  <span className="gui-deleg-item-name">herdar da conversa</span>
                </button>
              </div>

              {groups.map((group) => (
                <div className="gui-deleg-group" key={group.cli}>
                  <span className="gui-deleg-group-head">
                    <CliMark cli={group.cli} size={11} />
                    <span>{CLI_LABEL[group.cli]}</span>
                  </span>
                  <div className="gui-deleg-chips">
                    {group.options.map((option) => (
                      <button
                        key={`${group.cli}:${option.id}`}
                        type="button"
                        className="gui-deleg-item"
                        aria-pressed={option.id === defaults.model}
                        // A dica é a do app (portal, tema painel): o `title=`
                        // nativo é lento e some no Windows.
                        data-tip={option.detail ?? undefined}
                        // O nome falado é o que está NA TELA: repetir o id
                        // quando ele é o próprio nome faria o leitor de tela
                        // dizer "fable (fable)".
                        aria-label={
                          [
                            option.id === option.name ? option.name : `${option.name} (${option.id})`,
                            option.detail
                          ]
                            .filter(Boolean)
                            .join(' — ')
                        }
                        disabled={busy}
                        onClick={() => chooseModel(option.id)}
                      >
                        <span className="gui-deleg-item-name">{option.name}</span>
                        {option.id !== option.name && (
                          <span className="gui-deleg-item-id">{option.id}</span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              ))}

              {/* ESPERANDO ≠ VAZIO: enquanto os dois CLIs não respondem a lista
                  está a caminho; depois disso, o silêncio é ausência mesmo. */}
              {groups.length === 0 && (
                <span className="gui-deleg-empty">
                  {catalogSettled
                    ? 'nenhum CLI respondeu com uma lista de modelos'
                    : 'consultando os modelos dos CLIs…'}
                </span>
              )}

              {pinnedOutsideCatalog && (
                <p className="gui-deleg-hint" role="note">
                  carimbado <b>{defaults.model}</b> — fora do catálogo carregado, e ainda valendo
                </p>
              )}
            </div>
          </div>

          <div className="gui-deleg-field">
            <span className="gui-deleg-label" id={`${panelId}-effort`}>
              effort
            </span>
            <div className="gui-deleg-list" role="group" aria-labelledby={`${panelId}-effort`}>
              {!defaults.model ? (
                <span className="gui-deleg-empty">— escolha o modelo primeiro</span>
              ) : groups.length === 0 ? (
                // Catálogo ainda a caminho: dizer "fora do catálogo" aqui seria
                // acusar de errado um pino que pode estar perfeito.
                <span className="gui-deleg-empty">— os níveis chegam com o catálogo</span>
              ) : effortOptions.length === 0 ? (
                <span className="gui-deleg-empty">
                  —{' '}
                  {pinnedOption
                    ? `${pinnedOption.name} não aceita effort`
                    : 'modelo fora do catálogo'}
                </span>
              ) : (
                <div className="gui-deleg-chips">
                  <button
                    type="button"
                    className="gui-deleg-item"
                    aria-pressed={!defaults.effort}
                    disabled={busy}
                    onClick={() => void apply({ effort: null })}
                  >
                    <span className="gui-deleg-item-name">padrão do modelo</span>
                  </button>
                  {effortOptions.map((level) => (
                    <button
                      key={level}
                      type="button"
                      className="gui-deleg-item"
                      aria-pressed={level === defaults.effort}
                      disabled={busy}
                      onClick={() => void apply({ effort: level })}
                    >
                      <span className="gui-deleg-item-name">{level}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* R12 — o ⚡ no painel (a queixa 2 do dono revoga o "fast nunca do
              painel" da R11). Dois estados e nada mais: o pino não tem o
              terceiro estado de modelo/effort, porque não existe "fast da
              conversa" para herdar. */}
          <div className="gui-deleg-field">
            <span className="gui-deleg-label" id={`${panelId}-fast`}>
              fast
            </span>
            <div className="gui-deleg-list" role="group" aria-labelledby={`${panelId}-fast`}>
              <div className="gui-deleg-chips">
                <button
                  type="button"
                  className="gui-deleg-item"
                  aria-pressed={defaults.fast !== true}
                  disabled={busy}
                  onClick={() => void apply({ fast: null })}
                >
                  <span className="gui-deleg-item-name">desligado</span>
                </button>
                <button
                  type="button"
                  className="gui-deleg-item"
                  aria-pressed={defaults.fast === true}
                  disabled={busy}
                  data-tip="Abre todo ajudante em modo fast: mais rápido e gasta mais limite."
                  // O ⚡ é desenho: o leitor de tela ouve a escolha e o preço,
                  // nunca "raio fast".
                  aria-label="Modo fast — gasta mais limite"
                  onClick={() => void apply({ fast: true })}
                >
                  <span className="gui-deleg-item-name">⚡ fast</span>
                </button>
              </div>
              <p className="gui-deleg-note">
                o ⚡ desta conversa não chega neles: ou vem daqui, ou o ajudante abre normal
              </p>
            </div>
          </div>

          <div className="gui-deleg-foot">
            <button
              type="button"
              className="gui-deleg-clear"
              disabled={busy || (!defaults.model && !defaults.effort && !defaults.fast)}
              onClick={() => void apply({ model: null, effort: null, fast: null })}
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
