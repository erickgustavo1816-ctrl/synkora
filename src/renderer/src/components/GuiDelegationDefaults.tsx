import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useStore, type Seat, type SeatCli } from '../store'
import CliMark from './CliMark'
import { prettyModel } from './PaneChrome'
import { guiApi } from '../guiApi'
import { guiModelShortName } from '../guiComposerPresentation'
import {
  guiDelegationModelGroups,
  guiDelegationSummary,
  guiFleetModelPatch,
  guiFleetPlan,
  guiFleetSeatPatch,
  type GuiDelegationCatalog,
  type GuiDelegationDefaultsValue,
  type GuiDelegationModelNamer,
  type GuiFleetSeat
} from '../guiDelegationDefaults'
import GuiFleetSelect, { type GuiFleetSelectOption } from './GuiFleetSelect'

// A ABA "ajudantes ˄" — o padrão dos ajudantes (D8 do design vinculante
// `.synkora/reports/DESIGN_SUBAGENTES_SEM_ABA_2026-08-18.md`), redesenhada
// por ordem do dono em 2026-09-08 depois de três mockups reprovados:
//
//   "eu queria que tivesse um ajudante. Na hora que eu clicasse, fizesse uma
//    animação subindo essa parte de ajudantes, como se estivesse saindo de
//    dentro dele, subindo. E aí sim, lá eu teria os selects pra selecionar
//    um, aparece o outro select, selecionei um, aparece o outro. E no final,
//    um botãozinho de fast, se eu deixo ativado ou não."
//
// A aba é a TAMPA: em repouso é um pequeno tab em cima do input. Clicar faz o
// cartão desdobrar POR BAIXO dela enquanto ela sobe (a caixa é ancorada no
// composer e cresce para cima, `grid-template-rows: 0fr → 1fr`). Dentro, os
// selects nascem UM DE CADA VEZ — conta › modelo (só os daquela conta) ›
// effort (só os níveis daquele modelo) › fast (interruptor, só se o modelo
// aceita) —, lado a lado no chat largo e um embaixo do outro no estreito. O
// "limpar" mora na linha da aba, na ponta direita, para nunca sobrar uma linha
// fantasma no cartão (ordem dele). Mockup aprovado com o CSS real:
// scripts/harness/helpers-defaults.html.
//
// O que NÃO mudou: o pino é a palavra do dono e o pedido explícito do agente
// continua vencendo (cadeia explícito > painel > herdado em
// `guiDelegationWiring`); a fotografia canônica vem do main a cada gravação; e
// o catálogo é o REAL da conta escolhida (catalog.ts), não as caps do pane.
// A CONTA entrou no pino nesta rodada: `delegateSeat` em `guiSessions.ts`.

/**
 * A FONTE ÚNICA DO NOME DIGNO — as duas metades da régua do composer, do jeito
 * que o seletor de modelo as usa. Nada é reescrito aqui. A VERSÃO vem do id
 * canônico que o catálogo publica ("claude-opus-5" → "Opus 5"; pedido do dono
 * de 09/09: "quero ver o nome do modelo formatado, bonitinho"), e o `default`
 * do claude ganha a mesma voz do composer: "padrão da conta · Fable 5.1".
 */
const MODEL_NAMER: GuiDelegationModelNamer = ({ id, displayName, resolvedModel }) => {
  const short = guiModelShortName(
    { value: id, displayName, resolvedModel: resolvedModel ?? id },
    prettyModel(id)
  )
  if (!/^default\b/iu.test(displayName || id)) return short
  return short && !/^default\b/iu.test(short) ? `padrão da conta · ${short}` : 'padrão da conta'
}

const TAB_TIP =
  'Com que conta, modelo, effort e fast os ajudantes deste chat abrem quando o agente não pede outros. O pedido dele sempre vence.'

/** Teto de espera pelo `transitionend` do desdobrar (240ms + folga): com
 *  reduced-motion não há transição, e sem o teto o corpo ficaria cortando os
 *  menus para sempre. */
const SETTLE_FALLBACK_MS = 320

type FleetMenu = 'seat' | 'model' | 'effort' | null

function Chevron(): React.JSX.Element {
  return (
    <svg
      className="chev"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 6.5 5 3.5l3 3" />
    </svg>
  )
}

export default function GuiDelegationDefaults({
  paneId,
  seats,
  cli,
  seatId
}: {
  paneId: string
  /** Contas do app: a lista da etapa da conta, e quem responde pelo catálogo
   *  (a lista de modelos é da CONTA, não do binário solto). */
  seats?: Seat[]
  /** O CLI da CONVERSA: manda no catálogo enquanto a conta é "a da conversa". */
  cli: SeatCli
  /** A conta da conversa — é ela que "a da conversa" nomeia na dica. */
  seatId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  /** o desdobrar acabou: só então o corpo deixa os menus vazarem dele */
  const [settled, setSettled] = useState(false)
  const [menu, setMenu] = useState<FleetMenu>(null)
  /** o dono respondeu a etapa da conta nesta abertura (mesmo "a da conversa") */
  const [reachedModel, setReachedModel] = useState(false)
  const [defaults, setDefaults] = useState<GuiDelegationDefaultsValue>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** o catálogo já RESPONDEU (com lista ou com falha) nesta abertura */
  const [catalogSettled, setCatalogSettled] = useState(false)
  const catalogByCli = useStore((s) => s.catalogByCli)
  const loadCatalog = useStore((s) => s.loadCatalog)
  const host = useRef<HTMLDivElement>(null)
  const fleetRef = useRef<HTMLDivElement>(null)
  const sheetId = useId()

  useEffect(() => {
    let alive = true
    void guiApi.delegationDefaults(paneId).then((value) => {
      if (alive) setDefaults(value ?? {})
    })
    return () => {
      alive = false
    }
  }, [paneId])

  const fleetSeats = useMemo<GuiFleetSeat[]>(
    () => (seats ?? []).map((seat) => ({ id: seat.id, name: seat.name, cli: seat.cli })),
    [seats]
  )
  const pinnedSeat = defaults.seat ? fleetSeats.find((seat) => seat.id === defaults.seat) : undefined
  const conversationSeat = seatId ? fleetSeats.find((seat) => seat.id === seatId) : undefined

  /** O CLI que manda no catálogo e a conta cujo config dir responde por ele:
   *  a carimbada; senão a da conversa (se for desse CLI); senão a primeira
   *  logada do CLI. Ids PRIMITIVOS como dependência dos efeitos — `seats` é um
   *  array recriado a cada render do pai. */
  const catalogCli: SeatCli = pinnedSeat?.cli ?? cli
  const catalogSeatId =
    pinnedSeat?.id ??
    (conversationSeat?.cli === catalogCli ? conversationSeat.id : undefined) ??
    (
      seats?.find((seat) => seat.cli === catalogCli && seat.status === 'logado') ??
      seats?.find((seat) => seat.cli === catalogCli)
    )?.id

  /** Catálogo quando a aba ABRE — e também quando há PINO para nomear (a dica
   *  da aba recolhida é lida por leitor de tela; sem catálogo o nome digno não
   *  existe). Chat sem pino e sem abrir não paga processo nenhum. */
  const needsCatalog = open || Boolean(defaults.model)
  useEffect(() => {
    if (!needsCatalog) return
    let alive = true
    setCatalogSettled(false)
    const done = (): void => {
      if (alive) setCatalogSettled(true)
    }
    void loadCatalog(catalogCli, catalogSeatId).then(done, done)
    return () => {
      alive = false
    }
  }, [catalogCli, catalogSeatId, loadCatalog, needsCatalog])

  const groups = useMemo(() => {
    const catalog = catalogByCli[`${catalogCli}:${catalogSeatId ?? ''}`]
    const catalogs: GuiDelegationCatalog[] = catalog
      ? [{ cli: catalogCli, models: catalog.models, efforts: catalog.efforts }]
      : []
    return guiDelegationModelGroups(catalogs, MODEL_NAMER)
  }, [catalogByCli, catalogCli, catalogSeatId])

  const plan = guiFleetPlan({
    defaults,
    conversationCli: cli,
    seats: fleetSeats,
    groups,
    reachedModel
  })
  const summary = guiDelegationSummary(defaults, groups, fleetSeats)
  const pinned = Boolean(defaults.seat || defaults.model || defaults.effort || defaults.fast)
  /** Pino que o catálogo carregado não conhece. Ele CONTINUA valendo no motor,
   *  então esconder seria o estado mais enganoso da aba. */
  const pinnedOutsideCatalog = Boolean(defaults.model) && !plan.pinnedOption && groups.length > 0

  // ————— o desdobrar: a aba sobe, o cartão sai de dentro dela —————
  useEffect(() => {
    if (!open) {
      setSettled(false)
      return
    }
    const node = fleetRef.current
    const done = (): void => setSettled(true)
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === node && event.propertyName === 'grid-template-rows') done()
    }
    node?.addEventListener('transitionend', onEnd)
    const timer = window.setTimeout(done, SETTLE_FALLBACK_MS)
    return () => {
      node?.removeEventListener('transitionend', onEnd)
      window.clearTimeout(timer)
    }
  }, [open])

  // Clique fora fecha (menu aberto primeiro, depois a aba); Escape idem.
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (host.current?.contains(event.target as Node)) return
      setMenu(null)
      setOpen(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (menu) setMenu(null)
      else setOpen(false)
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', key)
    }
  }, [menu, open])

  const apply = useCallback(
    async (patch: {
      seat?: string | null
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
      // A fotografia CANÔNICA vem do main: a aba nunca fica mostrando uma
      // escolha que o disco recusou.
      setDefaults({
        seat: result.seat,
        model: result.model,
        effort: result.effort,
        fast: result.fast
      })
    },
    [paneId]
  )

  // As decisões de cada etapa são régua PURA (guiDelegationDefaults.ts), provada
  // em node longe do app; aqui só se aplica o patch que ela devolve.
  const chooseSeat = useCallback(
    (seat: string | null): void => {
      // Responder a etapa da conta — mesmo com "a da conversa" — abre a do modelo.
      setReachedModel(true)
      const patch = guiFleetSeatPatch(defaults, fleetSeats, cli, seat)
      if (patch) void apply(patch)
    },
    [apply, cli, defaults, fleetSeats]
  )

  const chooseModel = useCallback(
    (model: string | null): void => {
      const patch = guiFleetModelPatch(defaults, plan.modelOptions, groups.length > 0, model)
      if (patch) void apply(patch)
    },
    [apply, defaults, groups.length, plan.modelOptions]
  )

  // ————— as opções de cada etapa —————
  const seatOptions: GuiFleetSelectOption[] = [
    {
      id: '',
      label: 'a da conversa',
      ghost: true,
      tip: conversationSeat
        ? `A conta desta conversa (${conversationSeat.name}) — a de sempre.`
        : 'A conta desta conversa — a de sempre.'
    },
    ...fleetSeats.map((seat) => ({
      id: seat.id,
      label: seat.name,
      detail: seat.cli,
      mark: <CliMark cli={seat.cli} size={11} />
    }))
  ]
  const modelOptions: GuiFleetSelectOption[] = [
    ...(plan.modelInheritAllowed
      ? [{ id: '', label: 'o da conversa', ghost: true, tip: 'O modelo desta conversa, seja ele qual for.' }]
      : []),
    // Só o NOME no menu (pedido do dono: "não quero ver essa parte da direita");
    // o id cru e a descrição do catálogo ficam na dica, para quem procura.
    ...plan.modelOptions.map((option) => {
      const tip = [option.detail, option.id !== option.name ? option.id : null]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
      return { id: option.id, label: option.name, ...(tip ? { tip } : {}) }
    })
  ]
  const effortOptions: GuiFleetSelectOption[] = [
    { id: '', label: 'padrão do modelo', ghost: true },
    ...plan.effortOptions.map((level) => ({ id: level, label: level }))
  ]

  const modelValue = plan.pinnedOption?.name ?? defaults.model
  const modelFoot = pinnedOutsideCatalog
    ? `carimbado ${defaults.model} — fora do catálogo carregado, e ainda valendo`
    : groups.length === 0
      ? catalogSettled
        ? 'nenhum CLI respondeu com uma lista de modelos'
        : 'consultando os modelos da conta…'
      : undefined
  const effortLocked = plan.effortOptions.length === 0
  const effortValue = effortLocked
    ? groups.length === 0
      ? 'os níveis chegam com o catálogo'
      : plan.pinnedOption
        ? `${plan.pinnedOption.name} não aceita effort`
        : 'modelo fora do catálogo'
    : (defaults.effort ?? 'padrão do modelo')

  return (
    <div className="gui-fleet-host" ref={host}>
      <div
        className="gui-fleet"
        data-open={open ? 'true' : 'false'}
        data-settled={settled ? 'true' : 'false'}
        ref={fleetRef}
      >
        <div className="gui-fleet-head">
          <button
            type="button"
            className="gui-fleet-tab"
            aria-expanded={open}
            aria-controls={sheetId}
            aria-label={`Padrão dos ajudantes: ${busy ? 'gravando…' : summary}`}
            data-tip={TAB_TIP}
            onClick={() => {
              setMenu(null)
              setOpen((value) => !value)
            }}
          >
            <span className="name">ajudantes</span>
            {/* A configuração EM USO, visível com a aba abaixada (pedido do
                dono: "não sei qual configuração eu tô usando"). Com pino, em
                tinta cheia e com a marca do CLI da conta; herdando, apagada. */}
            <span className={pinned ? 'sum pinned' : 'sum'}>
              {pinnedSeat && <CliMark cli={pinnedSeat.cli} size={11} />}
              <span className="sum-text">
                {busy ? 'gravando…' : pinned ? summary : 'herdam da conversa'}
              </span>
            </span>
            <Chevron />
          </button>
          {/* "limpar" na linha da aba, na ponta: sem ele no cartão não sobra
              linha fantasma quando os campos quebram (ordem do dono). */}
          {open && (
            <button
              type="button"
              className="gui-fleet-clear"
              disabled={busy || !pinned}
              onClick={() => void apply({ seat: null, model: null, effort: null, fast: null })}
            >
              limpar
            </button>
          )}
        </div>

        <div
          className="gui-fleet-body"
          id={sheetId}
          role="group"
          aria-label="Padrão dos ajudantes"
          aria-busy={busy || undefined}
          inert={open ? undefined : true}
        >
          <div className="gui-fleet-card">
            <GuiFleetSelect
              id={`${sheetId}-seat`}
              label="conta"
              value={plan.seatOutsideList ? (defaults.seat ?? '') : (pinnedSeat?.name ?? 'a da conversa')}
              valueMark={pinnedSeat ? <CliMark cli={pinnedSeat.cli} size={11} /> : undefined}
              ghost={!defaults.seat}
              disabled={busy}
              tip={
                plan.seatOutsideList
                  ? 'Conta que este app não conhece mais — e ainda valendo no motor. Escolha outra ou limpe.'
                  : undefined
              }
              open={menu === 'seat'}
              onOpenChange={(next) => setMenu(next ? 'seat' : null)}
              options={seatOptions}
              selectedId={defaults.seat ?? ''}
              onPick={(id) => chooseSeat(id || null)}
              foot={fleetSeats.length === 0 ? 'nenhuma conta cadastrada' : undefined}
            />
            {plan.showModel && (
              <GuiFleetSelect
                id={`${sheetId}-model`}
                label="modelo"
                value={modelValue ?? (plan.modelInheritAllowed ? 'o da conversa' : 'escolher')}
                ghost={!defaults.model}
                disabled={busy}
                open={menu === 'model'}
                onOpenChange={(next) => setMenu(next ? 'model' : null)}
                options={modelOptions}
                selectedId={defaults.model ?? ''}
                onPick={(id) => chooseModel(id || null)}
                foot={modelFoot}
              />
            )}
            {plan.showEffort && (
              <GuiFleetSelect
                id={`${sheetId}-effort`}
                label="effort"
                value={effortValue}
                ghost={!defaults.effort}
                disabled={busy || effortLocked}
                open={menu === 'effort'}
                onOpenChange={(next) => setMenu(next ? 'effort' : null)}
                options={effortOptions}
                selectedId={defaults.effort ?? ''}
                onPick={(id) => void apply({ effort: id || null })}
              />
            )}
            {plan.showFast && (
              <div className="gui-fleet-field switch">
                <span className="gui-fleet-label" id={`${sheetId}-fast`}>
                  fast
                </span>
                <button
                  type="button"
                  role="switch"
                  className="gui-fleet-switch"
                  aria-checked={defaults.fast === true}
                  aria-labelledby={`${sheetId}-fast`}
                  disabled={busy}
                  data-tip="Abre todo ajudante em modo fast: mais rápido e gasta mais limite."
                  onClick={() => void apply({ fast: defaults.fast === true ? null : true })}
                >
                  <span className="track" aria-hidden="true">
                    <span className="knob" />
                  </span>
                  {defaults.fast === true ? 'ligado' : 'desligado'}
                </button>
              </div>
            )}
            {error && (
              <span className="gui-fleet-error" role="alert">
                {error}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
