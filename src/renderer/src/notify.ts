/**
 * Plim de atenção (pedido do usuário, 2026-08-06): som MINIMALISTA quando um
 * agente precisa do dono — pergunta do Maestro/orquestrador (ask_user) ou pane
 * pedindo permissão. Sintetizado na hora via Web Audio (zero assets): duas
 * senoides curtas em quinta (E6→B6), ganho baixo, ~0,25s. Throttle de 2s —
 * rajada de eventos nunca vira metralhadora sonora. Electron não exige gesto
 * do usuário para áudio (autoplayPolicy default 'no-user-gesture-required');
 * qualquer falha de áudio é silenciosa por definição.
 */
let ctx: AudioContext | null = null
let lastChimeAt = 0

export function playAttentionChime(): void {
  const now = Date.now()
  if (now - lastChimeAt < 2_000) return
  lastChimeAt = now
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const t = ctx.currentTime
    const notes: Array<[freq: number, at: number, dur: number]> = [
      [1318.5, 0, 0.09],
      [1975.5, 0.08, 0.18]
    ]
    for (const [freq, at, dur] of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t + at)
      gain.gain.linearRampToValueAtTime(0.07, t + at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + at + dur)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t + at)
      osc.stop(t + at + dur + 0.05)
    }
  } catch {
    // sem áudio disponível — o sinal visual continua
  }
}

/**
 * Blip de MARCO (pedido do usuário, 2026-08-06): "um barulhinho bem fraquinho"
 * quando o fluxo avança sem precisar de resposta — reviewer entrou, QA entrou,
 * missão integrou. Uma nota só, ganho ~metade do plim, nota diferente por
 * marco para o ouvido aprender o vocabulário sem olhar. Throttle por tipo.
 */
const BLIP_FREQ: Record<'review' | 'qa' | 'done', number> = {
  review: 880, // A5 — revisor entrou
  qa: 1108.7, // C#6 — QA entrou
  done: 1318.5 // E6 — algo integrou/terminou
}
const lastBlipAt: Partial<Record<keyof typeof BLIP_FREQ, number>> = {}

export function playSoftBlip(kind: keyof typeof BLIP_FREQ): void {
  const now = Date.now()
  if (now - (lastBlipAt[kind] ?? 0) < 1_500) return
  lastBlipAt[kind] = now
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = BLIP_FREQ[kind]
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(0.035, t + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 'done' ? 0.22 : 0.12))
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.3)
  } catch {
    // sem áudio disponível — o sinal visual continua
  }
}
