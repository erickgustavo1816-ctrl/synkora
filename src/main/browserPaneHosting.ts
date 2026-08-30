/**
 * BROWSER EMBUTIDO — A MÁQUINA DE HOST (metade de `./browserPane`, cortada em
 * 2026-08-29 por regra da casa: aquele arquivo cruzou ~1000 linhas de novo
 * quando o pop-out chegou).
 *
 * Aqui mora TUDO que decide **ONDE A PÁGINA ESTÁ PENDURADA**: o roteamento de
 * `attach`/`detach` para o host atual, a geometria da janela destacada e os dois
 * gestos do dono — ⧉ `popOut` e ⇤ `dockBack`. O motor (`createBrowserManager`,
 * no irmão) continua dono do resto: abas, notas, ⚡, captura e o retângulo do
 * dock.
 *
 * ——— o corte é de ENDEREÇO, não de contrato ———
 * Nenhum tipo público mudou de casa e `./browserPane` NÃO re-exporta nada daqui:
 * o que sai deste módulo é consumido por UM arquivo só (o irmão). Quem importa
 * `browserPane` não muda uma linha — a superfície pública dele é byte a byte a
 * mesma de antes do corte (conferido por `tsc --declaration`).
 *
 * ——— a fatia do registro da missão ———
 * `BrowserHostedMission` é a PARTE do registro que esta máquina governa (host,
 * os dois retângulos, o carimbo de relato velho). O `MissionRecord` do motor a
 * ESTENDE — uma definição só, sem espelho para sair de sincronia.
 *
 * ESPELHO DECLARADO (o mesmo arranjo do `./browserPaneHost`): os tipos do
 * CONTRATO do dono (`BrowserPanelRect`, `BrowserHostKind`, …) continuam morando
 * em `./browserPane` e chegam aqui como import de TIPO — apagado no emit, então
 * não existe ciclo em tempo de execução: a única aresta viva é
 * `browserPane → browserPaneHosting`.
 *
 * ——— sem UMA linha de Electron ———
 * Como o irmão, este módulo só fala com `BrowserViewHost`/`BrowserPopoutHost`.
 * É isso que deixa o gate (`scripts/test-browser-pane.mjs`) exercitar o ⧉, o
 * reencaixe e as três curas da sonda com hosts FALSOS, em node puro, sem subir
 * janela nenhuma.
 */
import type { BlackboxEventInput } from './blackbox'
import type {
  BrowserDockBackReason,
  BrowserGestureResult,
  BrowserHostKind,
  BrowserPanelRect
} from './browserPane'
import type {
  BrowserPopoutHandle,
  BrowserPopoutHost,
  BrowserViewHandle,
  BrowserViewHost
} from './browserPaneHost'

// ————————————————————————————————————————————————————————————————
// A fatia do registro da missão que esta máquina governa
// ————————————————————————————————————————————————————————————————

/** Um retângulo com a pergunta "e está à vista?" junto. */
export interface BrowserMissionLayout {
  rect: BrowserPanelRect
  visible: boolean
}

/** O que a máquina de host precisa saber de uma aba: a view (que ela move) e se
 *  o `webContents` ainda está de pé (para contar as abas vivas). */
export interface BrowserHostedTab {
  readonly tabId: string
  readonly view: BrowserViewHandle
  readonly wc: { isDestroyed(): boolean }
}

/** A missão, do ponto de vista de QUEM SEGURA A PÁGINA. O `MissionRecord` do
 *  motor estende isto (mesma definição, sem espelho). */
export interface BrowserHostedMission {
  readonly missionId: string
  readonly projectId: string
  readonly tabs: readonly BrowserHostedTab[]
  readonly activeTabId: string | null
  host: BrowserHostKind
  /** UM RETÂNGULO POR HOST. Guardar os dois é o que faz o reencaixe voltar no
   *  lugar certo no MESMO quadro, sem esperar o ResizeObserver do dock acordar
   *  — e o que impede o retângulo de uma janela de ser aplicado na outra. */
  dockLayout: BrowserMissionLayout | null
  popoutLayout: BrowserMissionLayout | null
  /** Último host cujo relato de geometria foi ignorado (registro UMA vez por
   *  transição: o ResizeObserver relata a cada quadro e encheria o diário). */
  staleReported: BrowserHostKind | null
}

// ————————————————————————————————————————————————————————————————
// A costura com o motor — o que a máquina pede emprestado
// ————————————————————————————————————————————————————————————————

/** `M` é o registro COMPLETO do motor (que estende a fatia daqui): assim o
 *  irmão passa as funções dele sem um único cast, e esta máquina continua
 *  enxergando só a fatia que governa. */
export interface BrowserHostMachineContext<M extends BrowserHostedMission> {
  /** As janelas do pop-out. Ausente = app sem pop-out (o gesto recusa com
   *  receita em vez de estourar) — é assim que o gate roda sem janela. */
  popouts?: BrowserPopoutHost
  /** O host da JANELA DO APP (resolvido lazy pelo motor). */
  viewHost(): BrowserViewHost
  mission(missionId: string): M | undefined
  missions(): Iterable<M>
  liveTabs(mission: M): readonly BrowserHostedTab[]
  /** O aplicador de geometria do motor (ele decide dock × pop-out e chama de
   *  volta o `applyPopoutLayout` daqui). */
  applyLayout(mission: M): void
  /** Título da página ativa — a barra da janela destacada conta a mesma verdade
   *  que a aba. */
  activeTitle(mission: M): string
  /** Clampa o retângulo relatado à área útil de quem o hospeda. */
  clampTo(rect: BrowserPanelRect, size: { width: number; height: number } | null): BrowserPanelRect
  /** A LARGURA QUE A PÁGINA ENXERGA sai do zoom, e o zoom sai da MOLDURA — que
   *  é outra na janela destacada. Destacar e reencaixar têm de refazer o fit no
   *  mesmo passo do `setBounds`, senão a página fica com o zoom da moldura de
   *  onde ela saiu. Quem sabe a receita é o motor (`./browserViewport`). */
  fitViewport(mission: M, frameWidth: number): void
  record(event: string, input: Omit<BlackboxEventInput, 'cat' | 'event'>): void
  changed(missionId: string): void
}

export interface BrowserHostMachine<M extends BrowserHostedMission = BrowserHostedMission> {
  attachView(mission: BrowserHostedMission, view: BrowserViewHandle): void
  detachView(mission: BrowserHostedMission, view: BrowserViewHandle): void
  applyPopoutLayout(mission: M): void
  /** ⧉ DESTACAR: a MESMA página salta para uma janela própria. */
  popOut(missionId: string): BrowserGestureResult
  /** REENCAIXAR: a página volta para o dock e a janela fecha. */
  dockBack(missionId: string, reason?: BrowserDockBackReason): BrowserGestureResult
}

// ————————————————————————————————————————————————————————————————
// A máquina
// ————————————————————————————————————————————————————————————————

export function createBrowserHostMachine<M extends BrowserHostedMission>(
  ctx: BrowserHostMachineContext<M>
): BrowserHostMachine<M> {
  /** A janela destacada desta missão, quando ela É o host atual. */
  const popoutOf = (mission: BrowserHostedMission): BrowserPopoutHandle | undefined =>
    mission.host === 'popout' ? ctx.popouts?.get(mission.missionId) : undefined

  /** Anexar/desanexar vão para o host ATUAL da missão. Uma view só tem um pai:
   *  `addChildView` na outra janela JÁ é o reparent (o gesto de UM PASSO). */
  const attachView = (mission: BrowserHostedMission, view: BrowserViewHandle): void => {
    const popout = popoutOf(mission)
    if (popout) popout.attach(view)
    else ctx.viewHost().attach(view)
  }

  const detachView = (mission: BrowserHostedMission, view: BrowserViewHandle): void => {
    const popout = popoutOf(mission)
    if (popout) popout.detach(view)
    else ctx.viewHost().detach(view)
  }

  /**
   * A geometria da JANELA DESTACADA — com a CURA 2 embutida: enquanto a janela
   * está minimizada, `contentSize()` devolve `null` e NADA é recalculado.
   * `getContentBounds()` de janela minimizada devolve `width:0` (e `getBounds()`
   * mente que está tudo bem): a view receberia um retângulo de um pixel e a
   * captura passaria a responder RÁPIDO e ERRADA — 356 vezes seguidas na sonda.
   * O `restore` da janela chama isto de novo, e aí o `setBounds` refeito é a
   * cura medida.
   */
  const applyPopoutLayout = (mission: M): void => {
    const popout = ctx.popouts?.get(mission.missionId)
    if (!popout) return
    const size = popout.contentSize()
    if (!size) return
    const wanted = mission.popoutLayout
    const asked =
      wanted && wanted.rect.width > 0 && wanted.rect.height > 0 ? ctx.clampTo(wanted.rect, size) : null
    // Sem relato do cromo da janela (ou relato degenerado), a página ocupa a
    // janela INTEIRA: o pop-out nunca fica com uma faixa preta esperando
    // renderer nenhum.
    const usable = asked !== null && asked.width > 0 && asked.height > 0
    const rect = usable && asked ? asked : { x: 0, y: 0, width: size.width, height: size.height }
    const show = wanted ? wanted.visible : true
    for (const tab of mission.tabs) {
      tab.view.setBounds(rect)
      const visible = show && tab.tabId === mission.activeTabId
      if (tab.view.getVisible() !== visible) tab.view.setVisible(visible)
    }
    // A janela destacada é MUITO mais larga que o trilho: o mesmo modo "1280"
    // que ali pedia zoom de 0,31 aqui pede quase 1. O fit sai da geometria de
    // AGORA, no mesmo passo do `setBounds`.
    ctx.fitViewport(mission, rect.width)
  }

  const popOut = (missionId: string): BrowserGestureResult => {
    const mission = ctx.mission(missionId)
    if (!mission || ctx.liveTabs(mission).length === 0) {
      return {
        ok: false,
        error: 'o browser desta missão não está aberto — abra uma aba (+) antes de destacar'
      }
    }
    const popouts = ctx.popouts
    if (!popouts) {
      return {
        ok: false,
        error: 'esta versão do app não abre o browser em janela própria — reinicie o Synkora'
      }
    }
    if (mission.host === 'popout') {
      // Idempotente: clicar de novo FOCA a janela que já existe.
      const open = popouts.get(missionId)
      if (open) {
        open.focus()
        return { ok: true }
      }
      // Janela sumiu por baixo do estado (só acontece se o `closed` chegar
      // sem o `close`): a view está órfã e o resgate é reencaixar primeiro.
      dockBack(missionId, 'window-close')
    }
    const popout = popouts.open(missionId, mission.projectId)
    if (!popout) {
      return { ok: false, error: 'não deu para abrir a janela do browser — tente de novo' }
    }
    // ORDEM OBRIGATÓRIA (cura 1): a janela já voltou de `open()` VISÍVEL, e só
    // agora a view muda de casa. Mover para janela escondida PENDURA as duas
    // rotas de captura, porque a view nunca compôs um quadro ali.
    mission.host = 'popout'
    mission.popoutLayout = null
    mission.staleReported = null
    // UM PASSO por aba (sonda §P1): `addChildView` na janela nova, sem
    // `removeChildView` antes — não existe instante nenhum com a view fora de
    // árvore, que é exatamente onde a captura pendura 5-8 s.
    for (const tab of mission.tabs) popout.attach(tab.view)
    ctx.applyLayout(mission)
    popout.setTitle(ctx.activeTitle(mission))
    // O foco é o ÚLTIMO passo: a janela aparece com a página dentro, nunca
    // vazia na cara do dono.
    popout.focus()
    ctx.record('browser-popout-born', {
      actor: 'user',
      ids: { projectId: mission.projectId, missionId },
      reason: 'a página saiu do dock para uma janela própria (a MESMA view — nada recarregou)',
      detail: { tabs: ctx.liveTabs(mission).length }
    })
    ctx.changed(missionId)
    return { ok: true }
  }

  function dockBack(missionId: string, reason: BrowserDockBackReason = 'gesture'): BrowserGestureResult {
    const mission = ctx.mission(missionId)
    if (!mission) {
      return { ok: false, error: 'o browser desta missão não está aberto — não há o que reencaixar' }
    }
    // Gesto idempotente: já estar no dock é sucesso, não recusa.
    if (mission.host !== 'dock') {
      mission.host = 'dock'
      mission.popoutLayout = null
      mission.staleReported = null
      // O RETÂNGULO DO DOCK PODE TER DONO. Enquanto esta missão estava
      // destacada, o dono pode ter posto OUTRA missão no painel — e o
      // "reencaixar" pode vir da janela destacada, que não sabe disso.
      // Voltar com o `visible` lembrado pintaria a página desta por cima da
      // outra. Volta ANEXADA e invisível (lei 1: segue capturável), e o
      // relato do painel decide quem aparece no quadro seguinte.
      const taken = [...ctx.missions()].some(
        (other) =>
          other.missionId !== missionId && other.host === 'dock' && other.dockLayout?.visible === true
      )
      if (taken && mission.dockLayout) {
        mission.dockLayout = { rect: mission.dockLayout.rect, visible: false }
      }
      const host = ctx.viewHost()
      // UM PASSO de volta, pelo mesmo motivo. E ANTES do destroy da janela:
      // o Electron 43 não mata o `webContents` filho junto com ela (§P6), e a
      // view esquecida ficaria viva, invisível e com a captura pendurando.
      for (const tab of mission.tabs) host.attach(tab.view)
      ctx.applyLayout(mission)
      ctx.record('browser-docked-back', {
        actor: reason === 'mission-closed' ? 'harness' : 'user',
        ids: { projectId: mission.projectId, missionId },
        reason:
          reason === 'window-close'
            ? 'o X da janela destacada REENCAIXOU a página no dock (fechar nunca perde a página)'
            : reason === 'mission-closed'
              ? 'missão encerrada: a página voltou ao dock antes do teardown'
              : 'a página voltou do pop-out para o dock',
        detail: { tabs: ctx.liveTabs(mission).length, trigger: reason }
      })
    }
    // No-op quando o gesto NASCEU do `close` da janela (ela já está fechando).
    ctx.popouts?.close(missionId)
    ctx.changed(missionId)
    return { ok: true }
  }

  return { attachView, detachView, applyPopoutLayout, popOut, dockBack }
}
