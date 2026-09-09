/** A ZONA DE SOLTAR do chat (2026-09-04 — pedido do dono: "uma animação
 *  mostrando onde soltar a pasta ou qualquer coisa que eu arraste").
 *
 *  Máquina de estados PURA por trás do hook `useGuiDropZone`: o DOM só reporta
 *  "um arrasto com arquivos passou pela janela, dentro ou fora do pane", e
 *  daqui sai a FASE que a UI pinta. O `dragleave` do Chromium é ruído — dispara
 *  a cada filho cruzado e some quando o arrasto sai da janela ou o dono aperta
 *  Esc —, então a verdade é o RELÓGIO: cada `dragover` renova um prazo curto e
 *  o silêncio devolve o repouso. Nunca fica um alvo aceso sem nada sendo
 *  arrastado. Sem DOM aqui de propósito: é o que a suíte node testa. */
export type GuiDropPhase = 'idle' | 'ready' | 'over'

/** O `dragover` parado repete a cada 350 ms ± 200 ms pela spec; o prazo cobre
 *  o pior caso com folga para a placa não piscar com o mouse imóvel. */
export const GUI_DROP_QUIET_MS = 650

export function dragTransferHasFiles(types: readonly string[] | null | undefined): boolean {
  if (!types) return false
  return Array.from(types).includes('Files')
}

export interface GuiDropTrackerDeps {
  setTimer: (callback: () => void, delayMs: number) => unknown
  clearTimer: (handle: unknown) => void
  onChange: (phase: GuiDropPhase) => void
}

export class GuiDropTracker {
  private phase: GuiDropPhase = 'idle'
  private timer: unknown = null
  private readonly deps: GuiDropTrackerDeps
  private readonly quietMs: number

  constructor(deps: GuiDropTrackerDeps, quietMs = GUI_DROP_QUIET_MS) {
    this.deps = deps
    this.quietMs = quietMs
  }

  get current(): GuiDropPhase {
    return this.phase
  }

  /** Um `dragover` com arquivos passou pela janela; `inside` = por cima do pane. */
  hover(inside: boolean): void {
    this.set(inside ? 'over' : 'ready')
    this.arm()
  }

  /** O arrasto acabou: soltou (dentro ou fora), cancelou, saiu da janela. */
  settle(): void {
    this.disarm()
    this.set('idle')
  }

  dispose(): void {
    this.settle()
  }

  private arm(): void {
    this.disarm()
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      this.set('idle')
    }, this.quietMs)
  }

  private disarm(): void {
    if (this.timer === null) return
    this.deps.clearTimer(this.timer)
    this.timer = null
  }

  private set(next: GuiDropPhase): void {
    if (this.phase === next) return
    this.phase = next
    this.deps.onChange(next)
  }
}

/** A placa fala em duas vozes: guia enquanto o arrasto anda pela janela e
 *  confirma quando está por cima do pane. Sempre nomeia a ação. */
export function guiDropZoneLabel(phase: GuiDropPhase): string {
  return phase === 'over' ? 'solte para anexar à conversa' : 'traga até aqui para anexar'
}
