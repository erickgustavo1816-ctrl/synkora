import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore, type CliStatus } from '../store'
import SynkoraMark from '../components/SynkoraMark'
import HomeField, { type FieldAnchor, type HomeFieldHandle } from '../components/HomeField'
import UniverseCard from '../components/UniverseCard'
import NewUniverseModal from '../components/NewUniverseModal'
import GuiPanelErrorBoundary from '../components/GuiPanelErrorBoundary'

// ————————————————————————————————————————————————————————————————————————
// A HOME — o SAGUÃO do universo Synkora.
//
// Ela mostra onde entrar (universos) e sinaliza o que impede o trabalho. A
// edição de contas, bibliotecas e preferências vive na central Configurações.
//
// O papel é VIVO: um campo de partículas (Canvas 2D — nunca WebGL, o orçamento
// de contextos é dos terminais) reage ao cursor e recebe gravidade das
// âncoras. E cada movimento sai de um FATO: trabalho rodando ATRAI as
// partículas, alerta REPELE (abre uma clareira em volta do card), evento do
// hub vira onda de choque. Nada aqui se mexe por enfeite.
// ————————————————————————————————————————————————————————————————————————

/** Vocabulário de matiz FECHADO em 3 — o motor só materializa três (HUE_SLOTS)
 *  e devolve −1 para a quarta. 6 = problema · 21 = o app · 145 = trabalho. */
const HUE_ALERT = 6
const HUE_APP = 21
const HUE_WORK = 145

const reduceMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

export default function Home(): React.JSX.Element {
  const projects = useStore((s) => s.projects)
  const seats = useStore((s) => s.seats)
  const settings = useStore((s) => s.settings)
  const panesByProject = useStore((s) => s.panesByProject)
  const paneActivity = useStore((s) => s.paneActivity)
  const paneAttention = useStore((s) => s.paneAttention)
  const loadHomeStats = useStore((s) => s.loadHomeStats)
  const openSettings = useStore((s) => s.openSettings)

  const fieldRef = useRef<HomeFieldHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorsRef = useRef(new Map<string, HTMLElement>())
  const hoverRef = useRef<string | null>(null)

  const [clis, setClis] = useState<CliStatus[]>([])
  // ONDA D: criar universo virou um passo com decisão (link do GitHub
  // opcional), então deixou de ser só o seletor de pasta.
  const [novoOpen, setNovoOpen] = useState(false)

  // ---- âncoras: cada card registra sua caixa; o campo mede e vira gravidade --
  const anchor = useCallback((key: string, el: HTMLElement | null): void => {
    if (el) {
      el.dataset.anchor = key
      anchorsRef.current.set(key, el)
    } else {
      anchorsRef.current.delete(key)
    }
  }, [])

  /** Monta a lista de poços a partir do estado ATUAL do store. Lê por
   *  `getState()` de propósito: assim a função é estável e nenhum efeito
   *  precisa re-assinar quando um pane muda de estado. */
  const pushWells = useCallback((): void => {
    const s = useStore.getState()
    const at = (key: string): HTMLElement | null => anchorsRef.current.get(key) ?? null
    const hovered = hoverRef.current
    const list: FieldAnchor[] = []

    const anySeatBroken = s.seats.some((x) => x.status === 'expirado')
    const anyWork = Object.values(s.paneActivity).some((v) => v === 'run')

    // a marca: o app respirando só quando há trabalho de verdade acontecendo
    list.push({
      el: at('brand'),
      radius: 200,
      strength: anySeatBroken ? 0.1 : anyWork ? 0.42 : 0.2,
      hue: HUE_APP,
      pulse: anyWork
    })

    for (const p of s.projects) {
      const panes = s.panesByProject[p.id] ?? []
      const vivos = panes.filter((x) => s.paneActivity[x.id] !== 'dead')
      const pedindo = vivos.some((x) => s.paneAttention[x.id])
      const rodando = vivos.some((x) => s.paneActivity[x.id] === 'run')
      const key = `project:${p.id}`
      const el = at(key)
      if (!el) continue
      if (p.missing) {
        list.push({ el, radius: 150, strength: -0.6, hue: HUE_ALERT })
      } else if (pedindo) {
        // atenção REPELE: abre uma clareira em volta do card, impossível de não ver
        list.push({ el, radius: 160, strength: -0.75, hue: HUE_ALERT, pulse: true })
      } else if (rodando) {
        list.push({ el, radius: 160, strength: 0.46, hue: HUE_WORK, pulse: true })
      } else if (hovered === key) {
        list.push({ el, radius: 210, strength: 0.4 })
      }
    }

    fieldRef.current?.setAnchors(list)
  }, [])

  // Re-mede a gravidade a cada render (o render só acontece quando algo do
  // store que a Home lê muda) — e no scroll, porque o canvas é fixo e são os
  // cards que se movem por cima dele.
  useEffect(pushWells)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const onScroll = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        pushWells()
      })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [pushWells])

  // Retrato de cada universo (missões/tarefas/versão): leitura de JSON já em
  // memória no main, mas escalonada para não competir com a primeira pintura.
  useEffect(() => {
    const timers = projects.map((p, i) =>
      window.setTimeout(() => void loadHomeStats(p.id), 60 * i)
    )
    return () => timers.forEach((t) => window.clearTimeout(t))
  }, [projects, loadHomeStats])

  useEffect(() => {
    const offTasks = window.synkora.tasks.onChanged((pid) => void loadHomeStats(pid))
    const offMissions = window.synkora.missions.onChanged((pid) => void loadHomeStats(pid))
    const offBacklog = window.synkora.backlog.onChanged((pid) => void loadHomeStats(pid))
    return () => {
      offTasks()
      offMissions()
      offBacklog()
    }
  }, [loadHomeStats])

  // Versão dos CLIs: a Home NÃO mostra o readout (isso é o `clis ▾` do
  // titlebar) — lê só para poder AVISAR quando o CLI sumiu do PATH ou o update
  // falhou, que é um fato que trava o trabalho. Versão nova derruba o catálogo
  // de modelos, que vem do binário, e vira uma onda no campo.
  const clearCatalogs = useStore((s) => s.clearCatalogs)
  useEffect(() => {
    if (!window.synkora?.cli) return
    void window.synkora.cli.status().then(setClis)
    return window.synkora.cli.onStatus((all) => {
      setClis((prev) => {
        const before = prev.map((c) => c.version).join()
        const now = all.map((c) => c.version).join()
        if (before && before !== now) {
          clearCatalogs()
          fieldRef.current?.shockAt(anchorsRef.current.get('brand') ?? null, {
            hue: HUE_APP,
            strength: 1.1
          })
        }
        return all
      })
    })
  }, [clearCatalogs])

  // ---- ondas de choque: só em TRANSIÇÃO, nunca na primeira passada --------
  const prevSeats = useRef<Map<string, string> | null>(null)
  useEffect(() => {
    const now = new Map(seats.map((s) => [s.id, s.status]))
    const prev = prevSeats.current
    prevSeats.current = now
    // abrir o app com 3 contas expiradas não pode virar fogos de artifício
    if (!prev) return
    for (const [id, status] of now) {
      const before = prev.get(id)
      if (before === status) continue
      const el = anchorsRef.current.get('brand') ?? null
      if (before === undefined) fieldRef.current?.shockAt(el, { hue: HUE_APP, strength: 0.8 })
      else if (status === 'expirado') fieldRef.current?.shockAt(el, { hue: HUE_ALERT, strength: 1.2 })
      else if (status === 'logado') fieldRef.current?.shockAt(el, { hue: HUE_WORK, strength: 0.9 })
    }
  }, [seats])

  const prevProjects = useRef<Set<string> | null>(null)
  useEffect(() => {
    const now = new Set(projects.map((p) => p.id))
    const prev = prevProjects.current
    prevProjects.current = now
    if (!prev) return
    for (const id of now) {
      if (prev.has(id)) continue
      fieldRef.current?.shockAt(anchorsRef.current.get(`project:${id}`) ?? null, {
        hue: HUE_APP,
        strength: 0.9
      })
    }
  }, [projects])

  // Permissão pendente em QUALQUER universo — inclusive num que está de fundo.
  const prevAttention = useRef<Set<string> | null>(null)
  useEffect(() => {
    const now = new Set(Object.keys(paneAttention).filter((k) => paneAttention[k]))
    const prev = prevAttention.current
    prevAttention.current = now
    if (!prev) return
    for (const paneId of now) {
      if (prev.has(paneId)) continue
      const owner = Object.keys(panesByProject).find((pid) =>
        (panesByProject[pid] ?? []).some((p) => p.id === paneId)
      )
      if (owner) {
        fieldRef.current?.shockAt(anchorsRef.current.get(`project:${owner}`) ?? null, {
          hue: HUE_ALERT,
          strength: 1.15
        })
      }
    }
  }, [paneAttention, panesByProject])

  // O HUB é o que justifica a Home animar: missão integrando num universo de
  // fundo é invisível hoje (o único consumidor filtra por projeto aberto).
  useEffect(() => {
    return window.synkora.hub.onEvent((evt) => {
      const el = anchorsRef.current.get(`project:${evt.projectId}`) ?? null
      if (!el) return
      if (evt.kind === 'merge' || evt.kind === 'report') {
        fieldRef.current?.shockAt(el, { hue: HUE_WORK, strength: 1.25 })
      } else if (evt.kind === 'error') {
        fieldRef.current?.shockAt(el, { hue: HUE_ALERT, strength: 1.1 })
      }
    })
  }, [])

  // ---- coreografia de entrada: UMA vez por sessão -------------------------
  // A Home fica MONTADA (display:none) enquanto um projeto está aberto, e
  // display:none → flex REINICIA animação CSS: sem esta trava, toda volta à
  // Home replayaria a entrada inteira. A classe entra depois que a coreografia
  // acaba (as keyframes só existem sob `.home:not(.booted)`).
  const homeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = homeRef.current
    if (!el) return
    const id = window.setTimeout(() => el.classList.add('booted'), 1400)
    return () => window.clearTimeout(id)
  }, [])

  // ---- alerta do topo: só existe quando existe o fato --------------------
  const seatExpirado = seats.find((s) => s.status === 'expirado')
  const cliQuebrado = clis.find((c) => c.state === 'missing' || c.state === 'failed')
  const projetoSumido = projects.find((p) => p.missing)
  const imagemQuebrada =
    settings?.imageProvider === 'openrouter' && !settings.openrouterKeyConfigured
      ? 'openrouter sem chave de API — a tool generate_image não vai gerar nada'
      : settings?.imageProvider === 'codex' && seats.every((s) => s.cli !== 'codex')
        ? 'geração de imagens aponta para o codex, mas não há nenhuma conta codex'
        : null

  function scrollTo(key: string): void {
    anchorsRef.current
      .get(key)
      ?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' })
  }

  const alerta = seatExpirado
    ? {
        text: `a conta "${seatExpirado.name}" está com o login expirado`,
        action: 'refazer login',
        run: () => openSettings('accounts')
      }
    : cliQuebrado
      ? {
          text: `o CLI ${cliQuebrado.cli} ${
            cliQuebrado.state === 'missing' ? 'não está no PATH' : 'falhou ao atualizar'
          }`,
          action: '⟳ checar agora',
          run: () => void window.synkora.cli.update().then(setClis)
        }
      : projetoSumido
        ? {
            text: `a pasta do universo "${projetoSumido.name}" não existe mais`,
            action: 'ver universo',
            run: () => scrollTo(`project:${projetoSumido.id}`)
          }
        : imagemQuebrada
          ? { text: imagemQuebrada, action: 'ajustar', run: () => openSettings('images') }
          : null

  // ---- vitais -------------------------------------------------------------
  const panesVivos = Object.values(panesByProject)
    .flat()
    .filter((p) => paneActivity[p.id] !== 'dead')
  const universosVivos = Object.keys(panesByProject).filter((pid) =>
    (panesByProject[pid] ?? []).some((p) => paneActivity[p.id] !== 'dead')
  ).length
  const expiradas = seats.filter((s) => s.status === 'expirado').length

  return (
    <div
      className={`home${alerta ? ' has-alert' : ''}`}
      ref={homeRef}
      onPointerMove={(e) => {
        fieldRef.current?.pointerAt(e.clientX, e.clientY)
        // hover fora do React: mudar de card não pode re-renderizar a tela
        const el = (e.target as HTMLElement).closest?.('[data-anchor]') as HTMLElement | null
        const key = el?.dataset.anchor ?? null
        if (key !== hoverRef.current) {
          hoverRef.current = key
          pushWells()
        }
      }}
      onPointerLeave={() => {
        fieldRef.current?.pointerAt(null, null)
        if (hoverRef.current !== null) {
          hoverRef.current = null
          pushWells()
        }
      }}
    >
      <HomeField ref={fieldRef} />
      <div className="home-paper" aria-hidden="true" />

      <div className="home-scroll" ref={scrollRef}>
        <div className="home-inner">
          <header className="home-hero">
            <span className="hero-sigil" ref={(el) => anchor('brand', el)}>
              <SynkoraMark size={26} />
            </span>
            <div className="hero-word">
              <div className="brand">SYNKORA</div>
              <div className="brand-sub">ambiente de desenvolvimento agêntico</div>
            </div>
            <div className="hero-vitals">
              <button className="vital" onClick={() => scrollTo('universos')}>
                <b>{projects.length}</b>
                <span>{projects.length === 1 ? 'universo' : 'universos'}</span>
              </button>
              <button
                className={`vital ${expiradas > 0 || seats.length === 0 ? 'warn' : ''}`}
                onClick={() => openSettings('accounts')}
              >
                <b>{seats.length}</b>
                <span>
                  {seats.length === 0
                    ? 'crie a primeira conta'
                    : expiradas > 0
                      ? `contas · ${expiradas} expirada`
                      : seats.length === 1
                        ? 'conta'
                        : 'contas'}
                </span>
              </button>
              <button className="vital" onClick={() => scrollTo('universos')}>
                <b>{panesVivos.length}</b>
                <span>
                  {panesVivos.length === 0
                    ? 'nenhum painel aberto'
                    : `painéis vivos em ${universosVivos} ${universosVivos === 1 ? 'universo' : 'universos'}`}
                </span>
              </button>
            </div>
          </header>

          {alerta && (
            <div className="home-alert">
              <span className="ha-dot" />
              <span className="ha-text">{alerta.text}</span>
              <button className="btn ghost tiny" onClick={alerta.run}>
                {alerta.action}
              </button>
            </div>
          )}

          <div className="section-label" ref={(el) => anchor('universos', el)}>
            universos · {projects.length}
          </div>

          <div className="universe-grid">
            {projects.map((p, i) => (
              <GuiPanelErrorBoundary
                key={p.id}
                paneId={`home:universe:${p.id}`}
                label="o card do universo"
              >
                <UniverseCard projectId={p.id} index={i} anchor={anchor} />
              </GuiPanelErrorBoundary>
            ))}
            <button className="universe-card add" onClick={() => setNovoOpen(true)}>
              <span className="add-plus">+</span>
              <span className="add-title">novo universo</span>
              <span className="add-hint">pasta do projeto · GitHub opcional</span>
            </button>
          </div>

        </div>
      </div>

      {novoOpen && (
        <GuiPanelErrorBoundary
          paneId="overlay:home:new-universe"
          label="o novo universo"
          onClose={() => setNovoOpen(false)}
        >
          <NewUniverseModal onClose={() => setNovoOpen(false)} />
        </GuiPanelErrorBoundary>
      )}
    </div>
  )
}
