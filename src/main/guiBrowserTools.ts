/**
 * O KIT `browser` DOS CHATS — as 11 ferramentas do browser embutido (H2 do
 * design `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * Este módulo é a metade que o AGENTE vê. Ele traduz a identidade do pane em
 * MISSÃO (a aba é da missão; a sessão de login é do projeto), chama o motor
 * (`browserDriver`/`browserProbe`/`browserShot`) e devolve TEXTO. Nenhuma
 * mecânica de CDP mora aqui, e nenhuma regra de produto mora lá.
 *
 * É o irmão exato do `guiLspTools.ts` (R14): o `mcpServer.ts` só REGISTRA o
 * catálogo nos dois papéis que o recebem (`gui-delegator` e `ajudante`), pelo
 * mesmo retorno antecipado do resto da casa — reviewer não roda nada (o
 * contrato dele é ler e reportar), e planner/release não abrem browser na v1.
 *
 * TRÊS CERCAS DE CONTRATO, ditas aqui porque é aqui que elas mordem:
 *
 * 1. **Nenhuma tool emite `structuredContent`.** O codex DESCARTA `content[]`
 *    quando há `structuredContent` (`openai/codex#10334`) — o texto sumiria
 *    para metade da frota do dono. Tudo é `content: [{type:'text'}]`, e a
 *    ÚNICA exceção é a imagem inline do `browser_shot`, que só entra quando o
 *    CLI do pane é o claude (o codex descartaria a imagem).
 *
 * 2. **Recusa é RESULTADO, nunca erro de protocolo**, e sempre nomeia a
 *    receita. `BROWSER_ENGINE_OFF` diz em letras maiúsculas que NADA foi
 *    aberto: um agente que racionalizasse "abri e falhou" contaria ao dono um
 *    QA que não aconteceu.
 *
 * 3. **O catálogo é fechado no boot.** Onze tools, não setenta: só as
 *    definições do `chrome-devtools-mcp` custam ~17 000 tokens em TODO prompt
 *    (pesquisa de mercado §2), e cortar 80% do catálogo rendeu à Vercel 3,5×
 *    de velocidade. Kit enxuto vence kit completo.
 *
 * ——— A QUARTA CERCA (2026-09-01): A ABA É SUA ———
 * `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`, D1/D7.
 * Toda tool trabalha na aba DESTA IDENTIDADE (`tabOf(missão, paneId)`), nunca
 * na aba ATIVA da missão. A diferença foi MEDIDA: na missão 86a05c06 (01/09) o
 * único ajudante que dirigiu o browser dividiu a mesma aba com o dev — a URL
 * alternou entre a porta 8791 (dele) e as 8159/8148/8163 (do dev) em minutos,
 * TRÊS leituras dele caíram na página do dev, e o dev o cancelou aos 20 min.
 * Consequências que moram aqui: `browser_open` perdeu o `tabId` (focar a aba de
 * outro não é ação de agente — o dono escolhe o que olhar), a lista de abas
 * passou a nomear o DONO de cada uma (consciência, não controle), e o ⚡ que
 * as tools acendem nomeia a ABA além da missão.
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { PaneIdentity } from './hub'
import {
  BrowserDriverRegistry,
  BROWSER_ACT_MAX_STEPS,
  BROWSER_FIND_MAX_HITS,
  BROWSER_READ_CEILING_CHARS,
  BROWSER_READ_DEFAULT_MAX_CHARS,
  BROWSER_WAIT_DEFAULT_MS,
  BROWSER_WAIT_MAX_MS,
  type BrowserAction,
  type BrowserActionKind,
  type BrowserDriverLog,
  type BrowserDriverSession,
  type BrowserPageLike,
  type BrowserReadOptions,
  type BrowserViewportOptions,
  type BrowserWaitOptions
} from './browserDriver'
import { PROBE_MAX_EXTRA_STYLES, type BrowserProbeParams } from './browserProbe'
// DE QUEM É A ABA (2026-09-01). Módulo PURO — importado, não espelhado: o
// espelho abaixo existe para não depender do MANAGER (que arrasta Electron), e
// `browserTabOwner.ts` não tem uma linha dele. Duas cópias do tipo do dono
// virariam duas ideias diferentes de dono na terceira correção.
import {
  browserTabOwnerLabel,
  type BrowserTabOwner
} from './browserTabOwner'
import {
  BROWSER_VIEWPORT_MAX_WIDTH,
  BROWSER_VIEWPORT_MIN_WIDTH,
  BROWSER_VIEWPORT_PRESETS,
  normalizeViewportMode,
  viewportReceipt,
  type BrowserViewportMode
} from './browserViewport'
import {
  captureBrowserShot,
  BROWSER_SHOT_DEFAULT_QUALITY,
  BROWSER_SHOT_MAX_WIDTH,
  type BrowserShotResult,
  type ShotCapturer
} from './browserShot'

// ————————————————————————— espelho do contrato da H1 —————————————————————————
//
// ESPELHO DECLARADO de `BrowserManager` (`src/main/browserPane.ts`, fatia H1 —
// o bloco de interface do design). Declarado aqui, e não importado, por uma
// razão de engenharia: este módulo continua compilando e TESTÁVEL sem o
// manager real, e o `webContents` vira exatamente as duas fatias que o motor
// usa (dirigir e capturar). O par é conferido de verdade no `index.ts`, que
// importa o tipo REAL da H1 e passa a instância — se os dois divergirem, o
// erro nasce no ponto certo: a costura.
export interface BrowserManagerTab {
  tabId: string
  webContents: BrowserPageLike & ShotCapturer
}

export interface BrowserManagerLike {
  /** OWNER-AWARE (D1): abre/reusa a aba DESTA identidade — nunca a de outro. */
  ensureTab(
    missionId: string,
    projectId: string,
    url: string | undefined,
    owner: BrowserTabOwner
  ): Promise<BrowserManagerTab>
  /** A PORTA DE ENTRADA de toda tool: a aba viva desta identidade. */
  tabOf(missionId: string, ownerPaneId: string): BrowserManagerTab | undefined
  /** A aba que o DONO está olhando. NÃO é a régua das tools desde 01/09 — está
   *  aqui porque é o que o `browser_open` usa quando a identidade não tem pane
   *  (só o dono nasce assim) e porque o espelho acompanha o contrato inteiro. */
  activeTab(missionId: string): BrowserManagerTab | undefined
  listTabs(missionId: string): {
    tabId: string
    title: string
    url: string
    active: boolean
    owner: BrowserTabOwner
    driving: boolean
  }[]
  selectTab(missionId: string, tabId: string): boolean
  closeMission(missionId: string): void
  /** D3 — a aba do ajudante morre com ele. Quem chama é o `dispose` do motor de
   *  ajudantes (fiação do índice), não este kit; o espelho acompanha porque o
   *  par é o `BrowserManager` inteiro. */
  closeTabsOf(ownerPaneId: string): number
  setAgentDriving(missionId: string, driving: boolean, tabId?: string): void
  /**
   * A GUARDA DA CAPTURA (P5), oferecida pela H1. Opcional no espelho de
   * propósito: o dublê da suíte não precisa dela, e quando ela existe é a
   * recusa RÁPIDA que evita a pendura de 5-8s da view desanexada. O relógio do
   * `browserShot` continua sendo o cinto — guarda e teto não se substituem.
   */
  captureReadiness?(
    missionId: string,
    tabId?: string
  ): { ok: true; tab: BrowserManagerTab } | { ok: false; error: string }
  /**
   * A LARGURA QUE A PÁGINA ENXERGA (2026-08-29) — a metade de `browser_viewport`
   * que NÃO é CDP. Ela mora no motor porque é geometria do painel: o zoom de
   * ajuste sai da moldura, que muda quando o dono arrasta a alça ou destaca o
   * browser (⧉). Escrever aqui é escrever o MESMO campo que o seletor do chrome
   * mostra — uma autoridade só, para o dono nunca olhar uma página emulada por
   * ordem do agente e achar que o site quebrou.
   * Opcional no espelho pelo mesmo motivo do `captureReadiness`: o dublê da
   * suíte não precisa dela, e sem ela a tool diz a verdade (não emula largura).
   */
  setViewportMode?(
    missionId: string,
    mode: BrowserViewportMode,
    /** O terceiro argumento é o que impede a caixa-preta de creditar ao DONO uma
     *  emulação que o agente ligou sozinho. */
    actor?: 'user' | 'agent',
    /** E o quarto é a ABA (2026-09-01): a largura é da SUA, não da que o dono
     *  está olhando — com a frota na mesma missão, escrever na ativa emularia a
     *  página de um vizinho. */
    tabId?: string
  ): { ok: true } | { ok: false; error: string }
  viewportOf?(missionId: string, tabId?: string): BrowserViewportMode
  /** A moldura de AGORA — o recibo precisa dela para contar a largura efetiva
   *  (o piso de zoom do Chromium morde em painel estreito). */
  viewportFrameWidth?(missionId: string): number
}

// ————————————————————————————— o contrato do kit —————————————————————————————

/** Onde o browser desta conversa vive: missão (aba) + projeto (sessão) + raiz
 *  (onde o `browser_shot` grava) + o DONO da aba (quem é esta conversa). */
export interface BrowserTarget {
  missionId: string
  projectId: string
  root: string
  /** A IDENTIDADE, em forma de dono de aba (D1). `paneId` é o pane desta
   *  conversa — é ele que decide QUAL aba as tools dirigem. */
  owner: BrowserTabOwner
}

export interface GuiBrowserToolkit {
  /** D7 — sem `tabId`: com uma aba por identidade, focar a aba de outro não é
   *  ação do agente (o dono escolhe o que olhar no chrome). */
  open(id: PaneIdentity, input: { url?: string }): Promise<string>
  read(id: PaneIdentity, input: BrowserReadOptions): Promise<string>
  find(id: PaneIdentity, input: { query: string; role?: string }): Promise<string>
  act(
    id: PaneIdentity,
    input: { actions: BrowserAction[]; read?: BrowserReadOptions }
  ): Promise<string>
  probe(id: PaneIdentity, input: BrowserProbeParams): Promise<string>
  shot(
    id: PaneIdentity,
    input: {
      name?: string
      ref?: number
      selector?: string
      format?: 'jpeg' | 'png'
      quality?: number
      maxWidth?: number
    }
  ): Promise<BrowserShotResult>
  viewport(id: PaneIdentity, input: BrowserViewportOptions): Promise<string>
  console(
    id: PaneIdentity,
    input: { onlyErrors?: boolean; pattern?: string; limit?: number }
  ): Promise<string>
  network(
    id: PaneIdentity,
    input: { urlPattern?: string; onlyFailures?: boolean; limit?: number; requestId?: string }
  ): Promise<string>
  evaluate(id: PaneIdentity, input: { expression: string }): Promise<string>
  wait(id: PaneIdentity, input: BrowserWaitOptions): Promise<string>
}

/**
 * Os ONZE nomes, em UM lugar só. A pré-sanção do claude
 * (`GUI_DELEGATE_CLAUDE_ALLOWED_TOOLS`) e as suítes leem daqui — lista
 * duplicada à mão é exatamente como uma tool nova volta a levantar card de
 * permissão para o dono no gesto que ele acabou de pedir (lição da R14).
 */
export const BROWSER_TOOL_NAMES: readonly string[] = [
  'browser_open',
  'browser_read',
  'browser_find',
  'browser_act',
  'browser_probe',
  'browser_shot',
  'browser_viewport',
  'browser_console',
  'browser_network',
  'browser_eval',
  'browser_wait'
]

/**
 * A resposta quando o harness ainda não ligou o motor do browser. É RESULTADO,
 * não erro de protocolo (mesma doutrina de `DELEGATION_ENGINE_OFF` e amigos):
 * o chat continua conversando e o agente lê a frase, em vez de racionalizar um
 * -32603 como "abri o browser e falhou".
 */
export const BROWSER_ENGINE_OFF =
  'o motor do browser ainda não está ligado — reinicie o app para reabrir esta conversa com as ferramentas de browser. NADA foi aberto, NADA foi navegado e NENHUMA tela foi verificada: não relate QA visual nenhum ao dono.'

/** O browser é o painel de UMA missão. Endereço órfão não abre nada. */
export const BROWSER_NO_MISSION =
  'esta conversa não está ligada a uma missão — o browser embutido é o painel de UMA missão (a aba é dela; a sessão de login é do projeto). NADA foi aberto.'

/**
 * A recusa de quem ainda não tem A SUA aba (D1). Ela nomeia a receita — e diz
 * "SUA" de propósito: até 01/09 as tools caíam na aba ATIVA da missão, e a
 * medição daquele dia (missão 86a05c06) mostrou o agente lendo a página do dev
 * e relatando-a como se fosse a dele. Nenhuma tool tem verbo para a aba alheia.
 */
export const BROWSER_NO_TAB =
  'a SUA aba do browser não está aberta nesta missão. Receita: chame browser_open com a URL que você quer verificar — ele abre A SUA aba (o dono a vê aparecer no painel BROWSER) e já devolve a leitura inicial da página. As abas dos outros aparecem na lista do browser_open, mas você não dirige nenhuma delas.'

// ————————————————————————————— a implementação —————————————————————————————

export interface GuiBrowserToolsDeps {
  manager: BrowserManagerLike
  /** Missão/projeto/raiz desta identidade. O AJUDANTE herda do delegador: ele
   *  trabalha no mesmo worktree e deve enxergar o mesmo browser. */
  resolveTarget(id: PaneIdentity): BrowserTarget | undefined
  /** O CLI do pane. Só o claude recebe a imagem inline — o codex a descarta
   *  (`openai/codex#10334`), e mandá-la seria pagar banda por nada. */
  cliOf(id: PaneIdentity): 'claude' | 'codex' | undefined
  log?: BrowserDriverLog
}

/** Quanto o ⚡ do chrome fica aceso depois da última ação do agente. */
const AGENT_DRIVING_LINGER_MS = 2_000

/**
 * Os presets do agente → o MESMO vocabulário do seletor do dono (o botão que
 * ele clica é o mesmo estado que esta tool escreve).
 *
 * `desktop` MUDOU DE SENTIDO em 2026-08-29 e a mudança é deliberada: ele
 * emulava "o tamanho real do painel" (que é o `auto` de hoje) e agora emula
 * 1280 lógicos, que é o que alguém quer dizer ao pedir desktop num painel de
 * 400px. Quem quer a moldura de verdade pede `auto`.
 */
const VIEWPORT_PRESET_WIDTHS: Record<string, BrowserViewportMode> = {
  auto: 'auto',
  mobile: 375,
  tablet: 768,
  desktop: 1280
}

/**
 * O que o agente pediu, em modo do motor. Três respostas possíveis, e as três
 * importam: `undefined` = não pediu largura nenhuma (só tema), `null` = pediu
 * uma que não existe (recusa com receita), ou o modo.
 */
function viewportModeFrom(input: BrowserViewportOptions): BrowserViewportMode | null | undefined {
  if (input.width !== undefined) {
    const mode = normalizeViewportMode(input.width)
    return mode ?? null
  }
  if (input.preset === undefined) return undefined
  return VIEWPORT_PRESET_WIDTHS[input.preset] ?? null
}

export function buildGuiBrowserTools(deps: GuiBrowserToolsDeps): GuiBrowserToolkit {
  const log = deps.log ?? ((): void => undefined)
  const registry = new BrowserDriverRegistry(log)
  const drivingTimers = new Map<string, ReturnType<typeof setTimeout>>()

  /** O ⚡ do chrome: acende ao começar a agir e apaga ~2s depois da última
   *  ação. É INDICADOR, nunca trava — o dono assume quando quiser (D5.2).
   *  Desde 01/09 ele nomeia a ABA: com uma frota na mesma missão, "alguém está
   *  dirigindo" não responde a pergunta que o dono faz olhando o painel. */
  const markDriving = (missionId: string, tabId: string): void => {
    deps.manager.setAgentDriving(missionId, true, tabId)
    const key = `${missionId}::${tabId}`
    const previous = drivingTimers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      drivingTimers.delete(key)
      deps.manager.setAgentDriving(missionId, false, tabId)
    }, AGENT_DRIVING_LINGER_MS)
    if (typeof timer.unref === 'function') timer.unref()
    drivingTimers.set(key, timer)
  }

  /**
   * A ABA DESTA CONVERSA. Com `paneId` (todo agente tem um) é a aba DELE; sem
   * ele — só o dono nasce assim, e nenhum caminho do produto chega aqui — cai
   * na aba ativa, a semântica de antes do dono de aba. Simétrico ao `ensureTab`
   * do motor, de propósito: as duas pontas degradam do mesmo jeito.
   */
  const ownTab = (target: BrowserTarget): BrowserManagerTab | undefined =>
    target.owner.paneId
      ? deps.manager.tabOf(target.missionId, target.owner.paneId)
      : deps.manager.activeTab(target.missionId)

  /** A porta de entrada de TODA tool: identidade → missão → A SUA aba viva →
   *  sessão CDP. Sem a sua aba, a recusa manda abrir A SUA (a receita). */
  const withSession = async <T>(
    id: PaneIdentity,
    run: (session: BrowserDriverSession, target: BrowserTarget, tab: BrowserManagerTab) => Promise<T>,
    onMissing: (reason: string) => T
  ): Promise<T> => {
    const target = deps.resolveTarget(id)
    if (!target) return onMissing(BROWSER_NO_MISSION)
    const tab = ownTab(target)
    if (!tab) return onMissing(BROWSER_NO_TAB)
    markDriving(target.missionId, tab.tabId)
    const session = registry.for(tab.webContents)
    await session.ensureAttached()
    return run(session, target, tab)
  }

  const failText = (reason: string): string => reason

  /**
   * A LISTA DE ABAS DA MISSÃO, com o dono de cada uma — CONSCIÊNCIA, não
   * controle (D7). O agente precisa saber que existe uma frota na mesma missão
   * (e que a página que o dono está olhando pode não ser a dele); o que ele não
   * tem é verbo para dirigir aba alheia.
   */
  const tabsBlock = (target: BrowserTarget, ownTabId: string): string => {
    const tabs = deps.manager.listTabs(target.missionId)
    if (tabs.length === 0) return ''
    const lines = tabs.map((tab) => {
      const marks = `${tab.active ? '▸' : ' '}${tab.driving ? '⚡' : ' '}`
      const mine = tab.tabId === ownTabId ? '  ← a SUA' : ''
      return `${marks} ${browserTabOwnerLabel(tab.owner)}: ${tab.title || tab.url || 'em branco'}${mine}`
    })
    return `\n\nabas desta missão (▸ = a que o dono está vendo · ⚡ = sendo dirigida):\n${lines.join(
      '\n'
    )}`
  }

  return {
    async open(id, input) {
      const target = deps.resolveTarget(id)
      if (!target) return BROWSER_NO_MISSION
      let tab: BrowserManagerTab
      try {
        // O DONO viaja com o pedido (D1): o motor reusa A DELE ou cria A DELE —
        // e a que nasce vira a ativa, para o dono ver o recém-chegado (D2).
        tab = await deps.manager.ensureTab(
          target.missionId,
          target.projectId,
          input.url,
          target.owner
        )
      } catch (error) {
        return `não consegui abrir o browser desta missão: ${
          error instanceof Error ? error.message : String(error)
        }. NADA foi aberto.`
      }
      markDriving(target.missionId, tab.tabId)
      const session = registry.for(tab.webContents)
      await session.ensureAttached()
      // Espera curta pelo carregamento: sem ela a leitura inicial fotografaria
      // o esqueleto e o agente concluiria que a página "está vazia".
      const deadline = Date.now() + 8_000
      while (Date.now() < deadline) {
        const state = await session.readyState()
        if (state === 'complete' || state === 'interactive') break
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      const initial = await session.read({ filter: 'all' })
      log({
        event: 'browser-open',
        // D6 — AUTORIA: até 01/09 o `browser-open` saía SEM `paneId` e o diário
        // não sabia quem tinha aberto o quê.
        ids: { paneId: id.paneId, missionId: target.missionId, projectId: target.projectId },
        detail: {
          missionId: target.missionId,
          tabId: tab.tabId,
          url: tab.webContents.getURL().slice(0, 200),
          owner: target.owner
        }
      })
      return `${initial}${tabsBlock(target, tab.tabId)}`
    },

    read: (id, input) => withSession(id, (session) => session.read(input), failText),

    find: (id, input) => withSession(id, (session) => session.find(input.query, input.role), failText),

    act: (id, input) =>
      withSession(id, (session) => session.act(input.actions, input.read ?? {}), failText),

    probe: (id, input) => withSession(id, (session) => session.probe(input), failText),

    async shot(id, input) {
      return withSession<BrowserShotResult>(
        id,
        async (session, target, tab) => {
          // A guarda da H2/H1 antes de qualquer trabalho: com a view fora da
          // árvore ou a janela escondida, a captura PENDURA (5-8s medidos) e o
          // agente perde a rodada. Recusar em 1ms nomeando a receita é o
          // comportamento correto — e o DOM continua vivo para read/probe.
          const readiness = deps.manager.captureReadiness?.(target.missionId, tab.tabId)
          if (readiness && !readiness.ok) {
            return { text: `${readiness.error} NADA foi gravado.` }
          }
          let clip: { x: number; y: number; width: number; height: number } | undefined
          let clipLabel: string | undefined
          if (input.ref !== undefined || input.selector) {
            const found = await session.rectFor({
              ...(input.ref !== undefined ? { ref: input.ref } : {}),
              ...(input.selector ? { selector: input.selector } : {})
            })
            if ('error' in found) return { text: `não consegui recortar: ${found.error}` }
            const rect = {
              x: Math.max(0, Math.round(found.rect.x)),
              y: Math.max(0, Math.round(found.rect.y)),
              width: Math.round(found.rect.width),
              height: Math.round(found.rect.height)
            }
            if (rect.width <= 0 || rect.height <= 0) {
              return {
                text: `o alvo do recorte tem tamanho ZERO (${rect.width}x${rect.height}) — ele não está pintando nada. Receita: chame browser_probe no mesmo alvo para ver por quê (display:none? cortado por overflow?).`
              }
            }
            clip = rect
            clipLabel = found.label
          }
          // LEI 2: o carimbo de frescor é medido ANTES da captura, sempre.
          const freshness = await session.freshness()
          return captureBrowserShot(tab.webContents, {
            root: target.root,
            missionId: target.missionId,
            ...(input.name ? { name: input.name } : {}),
            title: tab.webContents.getTitle(),
            url: tab.webContents.getURL(),
            ...(input.format ? { format: input.format } : {}),
            ...(input.quality !== undefined ? { quality: input.quality } : {}),
            ...(input.maxWidth !== undefined ? { maxWidth: input.maxWidth } : {}),
            ...(clip ? { clip } : {}),
            ...(clipLabel ? { clipLabel } : {}),
            inline: deps.cliOf(id) === 'claude',
            freshness
          })
        },
        (reason) => ({ text: reason })
      )
    },

    /**
     * `browser_viewport` = DUAS metades, e cada uma tem um dono diferente.
     *
     * A LARGURA é do MOTOR (o painel): o zoom de ajuste sai da moldura, e é o
     * mesmo estado que o dono vê e muda no seletor do chrome. A tool escreve ali
     * em vez de emular por CDP — se ela emulasse, existiriam duas verdades sobre
     * a largura e o seletor do dono mostraria uma mentira.
     *
     * O TEMA (`prefers-color-scheme`) é do DRIVER: é emulação de mídia, não
     * geometria, e ninguém no chrome manda nele.
     */
    viewport: (id, input) =>
      withSession(
        id,
        async (session, target, tab) => {
          const extras: string[] = []
          const wanted = viewportModeFrom(input)
          if (wanted === null) {
            return `largura não reconhecida — use \`preset\` (auto · mobile · tablet · desktop) ou \`width\` entre ${BROWSER_VIEWPORT_MIN_WIDTH} e ${BROWSER_VIEWPORT_MAX_WIDTH}. NADA mudou.`
          }
          if (input.colorScheme) extras.push(await session.colorScheme(input.colorScheme))
          if (wanted === undefined) {
            if (extras.length === 0) {
              return 'nada mudou — informe `preset`, `width` ou `colorScheme`.'
            }
            // Só o tema: o recibo ainda conta a largura de agora, porque é ela
            // que explica as medidas que o `browser_probe` vai devolver. E a
            // largura de agora é a DESTA aba, não a da que o dono está olhando.
            const mode = deps.manager.viewportOf?.(target.missionId, tab.tabId) ?? 'auto'
            return viewportReceipt(mode, deps.manager.viewportFrameWidth?.(target.missionId) ?? 0, extras)
          }
          const apply = deps.manager.setViewportMode?.(
            target.missionId,
            wanted,
            'agent',
            tab.tabId
          )
          if (!apply) {
            return `este harness não controla a largura da página (motor antigo) — só o tema foi aplicado.${
              extras.length ? `\n${extras.join('\n')}` : ''
            }`
          }
          if (!apply.ok) return `${apply.error}. A largura NÃO mudou.`
          return viewportReceipt(
            wanted,
            deps.manager.viewportFrameWidth?.(target.missionId) ?? 0,
            extras
          )
        },
        failText
      ),

    console: (id, input) =>
      withSession(id, async (session) => session.consoleText(input), failText),

    network: (id, input) =>
      withSession(
        id,
        async (session) =>
          input.requestId ? session.networkBody(input.requestId) : session.networkText(input),
        failText
      ),

    evaluate: (id, input) => withSession(id, (session) => session.evaluate(input.expression), failText),

    wait: (id, input) => withSession(id, (session) => session.wait(input), failText)
  }
}

// ————————————————————————————— o catálogo MCP —————————————————————————————

type ToolText = { content: { type: 'text'; text: string }[] }
type ToolContent = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
}

function text(value: string): ToolText {
  return { content: [{ type: 'text', text: value }] }
}

const refField = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('o número que veio entre colchetes no browser_read desta página (ex.: [ref_7] → 7)')

const selectorField = z
  .string()
  .min(1)
  .max(300)
  .optional()
  .describe('seletor CSS, quando você prefere apontar sem passar pelo browser_read')

const ACTION_KINDS: readonly BrowserActionKind[] = [
  'click',
  'double_click',
  'right_click',
  'hover',
  'type',
  'press',
  'scroll',
  'select',
  'fill',
  'clear'
]

/**
 * Registra o kit no servidor daquele pane. Chamado pelo `buildServer` dentro
 * dos retornos antecipados de `gui-delegator` e `ajudante` — quem não é um dos
 * dois nunca vê uma linha disto.
 *
 * `toolkit` ausente = as tools CONTINUAM no catálogo e respondem com a receita
 * (`BROWSER_ENGINE_OFF`). Tool que some entre um boot e outro é o pior
 * desfecho possível: o agente racionaliza a ausência em vez de ler o motivo.
 */
export function registerBrowserKit(
  server: McpServer,
  toolkit: GuiBrowserToolkit | undefined,
  identity: PaneIdentity
): void {
  const off = (): ToolText => text(BROWSER_ENGINE_OFF)

  server.registerTool(
    'browser_open',
    {
      description:
        'ABRE A SUA ABA no browser desta missão numa URL e já devolve a leitura da página. É a primeira tool de todo QA visual: o painel BROWSER da missão aparece no dock do dono, sua aba nasce em primeiro plano e a partir daí ele vê tudo o que você faz. A ABA É SUA: você tem UMA nesta missão, e todas as outras tools do browser trabalham NELA. O dev tem a dele, cada ajudante tem a dele (e a porta de servidor dele) — ninguém navega a aba de ninguém. Idempotente: chamar de novo reusa a SUA aba morna, e só recarrega quando a URL muda. A sessão (cookies, logins) é do PROJETO e sobrevive entre missões: se o dono logou uma vez, você entra logado. Sem `url`, devolve a leitura da sua aba mais a lista das abas da missão com o dono de cada uma (é consciência, não controle: as outras você vê, não dirige). PROIBIDO abrir browser externo ou subir um playwright seu para testar UI: é para acabar com isso que este existe.',
      inputSchema: {
        url: z
          .string()
          .max(2_000)
          .optional()
          .describe(
            'endereço a abrir (http/https, ou o localhost do dev server desta missão — se você é ajudante, a SUA porta). Ausente = fica onde está'
          )
      }
    },
    async ({ url }) => (toolkit ? text(await toolkit.open(identity, { ...(url ? { url } : {}) })) : off())
  )

  server.registerTool(
    'browser_read',
    {
      description: `A SUA ABA EM TEXTO: uma linha por elemento, com \`[ref_N]\` em tudo o que se clica ou se digita. Lê SEMPRE a sua aba — nunca a que o dono está olhando, que pode ser a de outro. PREFIRA ESTA TOOL AO SCREENSHOT para conferir texto, estrutura e estado — ela é ordens de grandeza mais barata e é o que os dois CLIs leem igual. Os refs são ESTÁVEIS enquanto a página não navegar: reler devolve os mesmos números, e é por isso que você pode encadear browser_act sem re-ler. Navegou ou recarregou? Os refs viram pó e a próxima ação recusa mandando você reler. Teto de ${BROWSER_READ_DEFAULT_MAX_CHARS} caracteres por padrão, e o corte SE ANUNCIA com a receita para caber.`,
      inputSchema: {
        filter: z
          .enum(['interactive', 'all'])
          .optional()
          .describe(
            "'all' (padrão) traz texto e estrutura junto — é o que confere conteúdo; 'interactive' traz SÓ o que se clica/digita e é o corte barato numa página grande"
          ),
        scope: z
          .string()
          .max(300)
          .optional()
          .describe(
            'seletor CSS para ler só um pedaço da tela (ex.: "main", ".dock-browser"). É o jeito certo de caber no teto sem perder o que importa'
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(40)
          .optional()
          .describe('profundidade máxima da árvore (padrão 20)'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(BROWSER_READ_CEILING_CHARS)
          .optional()
          .describe(`teto de caracteres (padrão ${BROWSER_READ_DEFAULT_MAX_CHARS})`)
      }
    },
    async (input) => (toolkit ? text(await toolkit.read(identity, input)) : off())
  )

  server.registerTool(
    'browser_find',
    {
      description: `PROCURA na SUA aba por texto ou papel e devolve até ${BROWSER_FIND_MAX_HITS} elementos com ref e caixa. É o atalho barato: quando você sabe o que quer ("Salvar", "e-mail"), isto custa uma fração do browser_read inteiro. Nada casou? Aí sim leia a página — provavelmente ela não está no estado que você imagina.`,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .describe('trecho do texto ou do nome acessível (sem diferenciar maiúsculas)'),
        role: z
          .string()
          .max(40)
          .optional()
          .describe('restringe ao papel (button, link, textbox, heading…)')
      }
    },
    async ({ query, role }) =>
      toolkit
        ? text(await toolkit.find(identity, { query, ...(role ? { role } : {}) }))
        : off()
  )

  server.registerTool(
    'browser_act',
    {
      description: `AGE NA SUA ABA e JÁ DEVOLVE a leitura pós-ação — você não precisa de um browser_read separado depois. A lista é SEQUENCIAL e PARA NO PRIMEIRO ERRO: um formulário de dez campos é UMA chamada, não dez. Sempre uma LISTA, mesmo para uma ação só. Alvo por \`ref\` (do browser_read/browser_find) ou por coordenada \`x\`/\`y\`. Se o ponto do clique estiver COBERTO por outro elemento, o recibo diz quem recebeu — porque é isso que aconteceria com o dono clicando. Ref de antes de uma navegação recusa nomeando a receita. Teto de ${BROWSER_ACT_MAX_STEPS} passos por chamada.`,
      inputSchema: {
        actions: z
          .array(
            z.object({
              action: z
                .enum([ACTION_KINDS[0]!, ...ACTION_KINDS.slice(1)])
                .describe(
                  "click/double_click/right_click/hover (ponteiro) · type (digita no que tem foco ou no alvo) · press (tecla: Enter, Tab, Escape, ArrowDown, Ctrl+A…) · scroll · select (opção de um <select>) · fill (põe o valor direto no campo, com os eventos que React & cia escutam) · clear (esvazia)"
                ),
              ref: refField,
              selector: selectorField,
              x: z.number().optional().describe('coordenada X na viewport, quando não há ref'),
              y: z.number().optional().describe('coordenada Y na viewport, quando não há ref'),
              text: z.string().max(4_000).optional().describe('o que digitar (action:"type")'),
              key: z
                .string()
                .max(40)
                .optional()
                .describe('a tecla ou o acorde (action:"press"): Enter, Tab, Escape, Ctrl+A, Shift+Tab'),
              value: z
                .string()
                .max(4_000)
                .optional()
                .describe('o valor (action:"fill") ou a opção (action:"select")'),
              direction: z
                .enum(['up', 'down', 'left', 'right'])
                .optional()
                .describe('direção do scroll (padrão down)'),
              amount: z.number().int().optional().describe('pixels do scroll (padrão 400)'),
              clear: z
                .boolean()
                .optional()
                .describe('em action:"type", esvazia o campo antes de digitar')
            })
          )
          .min(1)
          .max(BROWSER_ACT_MAX_STEPS)
          .describe('os passos, na ordem em que devem acontecer'),
        filter: z
          .enum(['interactive', 'all'])
          .optional()
          .describe('o filtro da leitura pós-ação (mesmo do browser_read)'),
        scope: z
          .string()
          .max(300)
          .optional()
          .describe('o escopo CSS da leitura pós-ação — use quando só uma parte da tela importa')
      }
    },
    async ({ actions, filter, scope }) =>
      toolkit
        ? text(
            await toolkit.act(identity, {
              actions: actions as BrowserAction[],
              read: { ...(filter ? { filter } : {}), ...(scope ? { scope } : {}) }
            })
          )
        : off()
  )

  server.registerTool(
    'browser_probe',
    {
      description:
        'O VEREDITO VISUAL EM TEXTO — a tool que substitui "olhar a tela", sempre sobre a SUA aba. Sobre um elemento devolve: caixa (posição e tamanho), se está visível e dentro da viewport, CONTRASTE calculado pela WCAG contra o fundo EFETIVO (composto pelos ancestrais, com AA/AAA e o piso que faltou), TRANSBORDO (conteúdo maior que a caixa, texto cortado com reticências), CORTE por ancestral com overflow, quem está COBRINDO o ponto central, e os estilos computados que você pedir. Use isto — não screenshot — para responder "está torto?", "está cortado?", "dá para ler?": são números, e números não dependem de ninguém enxergar imagem.',
      inputSchema: {
        ref: refField,
        selector: selectorField,
        styles: z
          .array(z.string().max(60))
          .max(PROBE_MAX_EXTRA_STYLES)
          .optional()
          .describe(
            'propriedades computadas extras, no nome CSS (ex.: "gap", "grid-template-columns"). O conjunto base (cor, fundo, fonte, espaçamento, posição, overflow) já vem sempre'
          )
      }
    },
    async (input) => (toolkit ? text(await toolkit.probe(identity, input)) : off())
  )

  server.registerTool(
    'browser_shot',
    {
      description: `FOTOGRAFA A SUA ABA em ARQUIVO dentro do worktree e devolve o CAMINHO (a foto é da sua aba mesmo quando o dono está olhando outra) — cite esse caminho no chat e o DONO vê a imagem no fio da conversa. Isto é para ELE olhar: para VOCÊ decidir, use browser_probe (fato em texto) e browser_read. \`ref\`/\`selector\` recortam UM elemento. JPEG q${BROWSER_SHOT_DEFAULT_QUALITY} por padrão, largura no teto de ${BROWSER_SHOT_MAX_WIDTH}px. Todo recibo traz um CARIMBO DE FRESCOR: se o compositor não estiver pulsando (painel oculto), o aviso é explícito e você NÃO deve aprovar tela por aquela imagem.`,
      inputSchema: {
        name: z
          .string()
          .max(60)
          .optional()
          .describe('apelido curto que vira o nome do arquivo (ex.: "dock-colapsado")'),
        ref: refField,
        selector: selectorField,
        format: z
          .enum(['jpeg', 'png'])
          .optional()
          .describe('jpeg (padrão, barato) ou png (sem perda, para diferença fina de pixel)'),
        quality: z
          .number()
          .int()
          .min(20)
          .max(100)
          .optional()
          .describe(`qualidade do JPEG (padrão ${BROWSER_SHOT_DEFAULT_QUALITY})`),
        maxWidth: z
          .number()
          .int()
          .min(200)
          .max(BROWSER_SHOT_MAX_WIDTH)
          .optional()
          .describe(`teto de largura em pixels (padrão e máximo ${BROWSER_SHOT_MAX_WIDTH})`)
      }
    },
    async (input): Promise<ToolContent> => {
      if (!toolkit) return off()
      const result = await toolkit.shot(identity, input)
      const content: ToolContent['content'] = [{ type: 'text', text: result.text }]
      if (result.image) {
        content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType })
      }
      return { content }
    }
  )

  server.registerTool(
    'browser_viewport',
    {
      description:
        'MUDA A LARGURA QUE A SUA PÁGINA ENXERGA e o TEMA em uma ida (a largura é da SUA aba; a aba do dev e a de cada ajudante têm a delas): preset auto/mobile/tablet/desktop, `width` livre, e `colorScheme` claro/escuro (o `prefers-color-scheme` de verdade, não um truque de CSS). É assim que o QA de responsivo e o de tema deixam de ser duas rodadas. IMPORTANTE: o painel do browser é ESTREITO, então sem isto toda página responsiva te entrega o layout de celular — peça `desktop` antes de julgar qualquer tela. A largura NUNCA é ampliada: quando ela cabe na moldura a página fica em TAMANHO REAL, centralizada, com faixas do app dos lados (é uma moldura de dispositivo — o que estiver quebrado dentro dela é da PÁGINA); quando não cabe, a página é ESCALADA para caber. As medidas de browser_probe seguem sempre em pixels lógicos. O DONO vê esta mesma largura no seletor do chrome do browser (AUTO · 375 · 768 · 1280) e pode mudá-la a qualquer momento: é um estado só, compartilhado — não existe emulação escondida dele.',
      inputSchema: {
        preset: z
          .enum(['auto', 'mobile', 'tablet', 'desktop'])
          .optional()
          .describe(
            `auto = a largura real da moldura (sem emulação) · mobile ${BROWSER_VIEWPORT_PRESETS[0]} · tablet ${BROWSER_VIEWPORT_PRESETS[1]} · desktop ${BROWSER_VIEWPORT_PRESETS[2]}`
          ),
        width: z
          .number()
          .int()
          .min(BROWSER_VIEWPORT_MIN_WIDTH)
          .max(BROWSER_VIEWPORT_MAX_WIDTH)
          .optional()
          .describe('largura lógica à mão, quando nenhum preset serve (vence o `preset`)'),
        colorScheme: z
          .enum(['light', 'dark'])
          .optional()
          .describe('emula prefers-color-scheme — o tema que a página realmente enxerga')
      }
    },
    async (input) => (toolkit ? text(await toolkit.viewport(identity, input)) : off())
  )

  server.registerTool(
    'browser_console',
    {
      description:
        'O CONSOLE da SUA aba: logs, avisos, erros e exceções não capturadas, do momento em que o motor anexou nela. Chame SEMPRE que a tela não fez o que você esperava — metade dos "não funcionou" está escrita aqui em letras vermelhas.',
      inputSchema: {
        onlyErrors: z.boolean().optional().describe('só erro e aviso'),
        pattern: z.string().max(200).optional().describe('filtra por trecho da mensagem'),
        limit: z.number().int().min(1).max(300).optional().describe('quantas últimas mostrar (padrão 50)')
      }
    },
    async (input) => (toolkit ? text(await toolkit.console(identity, input)) : off())
  )

  server.registerTool(
    'browser_network',
    {
      description:
        'AS REQUISIÇÕES da SUA aba: método, status, tempo e tamanho, com o id de cada uma. Com `requestId`, devolve o CORPO daquela resposta. É a resposta para "a tela está vazia": ou a chamada falhou (e o status diz), ou ela voltou vazia (e o corpo diz).',
      inputSchema: {
        urlPattern: z.string().max(300).optional().describe('filtra por trecho da URL'),
        onlyFailures: z.boolean().optional().describe('só o que falhou ou voltou 4xx/5xx'),
        limit: z.number().int().min(1).max(300).optional().describe('quantas últimas mostrar (padrão 40)'),
        requestId: z
          .string()
          .max(120)
          .optional()
          .describe('o #id de uma requisição do índice — devolve o CORPO da resposta dela')
      }
    },
    async (input) => (toolkit ? text(await toolkit.network(identity, input)) : off())
  )

  server.registerTool(
    'browser_eval',
    {
      description:
        'RODA JavaScript DENTRO DA PÁGINA DA SUA ABA e devolve o resultado serializado. É para INSPEÇÃO e DEPURAÇÃO — a pergunta que nenhuma outra tool responde (o estado de um store, o valor de uma variável de CSS, uma medida sua). Não use como caminho de ação: click e digitação têm tool própria, que já observa depois. O código roda no contexto da PÁGINA, nunca no app: ele não enxerga o Synkora, e a página é conteúdo NÃO-CONFIÁVEL.',
      inputSchema: {
        expression: z
          .string()
          .min(1)
          .max(8_000)
          .describe(
            'a expressão. `await` funciona; devolva CAMPOS em vez do objeto inteiro (o resultado tem teto)'
          )
      }
    },
    async ({ expression }) =>
      toolkit ? text(await toolkit.evaluate(identity, { expression })) : off()
  )

  server.registerTool(
    'browser_wait',
    {
      description: `ESPERA a página da SUA aba chegar num estado: um texto aparecer, um seletor aparecer, a rede ficar ociosa, ou um tempo fixo. Padrão de ${BROWSER_WAIT_DEFAULT_MS}ms, teto de ${BROWSER_WAIT_MAX_MS}ms. Quando a espera estoura, a mensagem NOMEIA a receita — porque "esperei e não veio" quase sempre significa que a página quebrou, e o browser_console tem a prova.`,
      inputSchema: {
        text: z.string().max(300).optional().describe('espera este texto aparecer na página'),
        selector: z.string().max(300).optional().describe('espera este seletor CSS ficar visível'),
        networkIdle: z
          .boolean()
          .optional()
          .describe('espera a rede ficar ociosa (nenhuma requisição em voo por 500ms)'),
        ms: z
          .number()
          .int()
          .min(0)
          .max(BROWSER_WAIT_MAX_MS)
          .optional()
          .describe('espera cega, em milissegundos — o último recurso'),
        timeoutMs: z
          .number()
          .int()
          .min(200)
          .max(BROWSER_WAIT_MAX_MS)
          .optional()
          .describe(`teto desta espera (padrão ${BROWSER_WAIT_DEFAULT_MS})`)
      }
    },
    async (input) => (toolkit ? text(await toolkit.wait(identity, input)) : off())
  )
}
