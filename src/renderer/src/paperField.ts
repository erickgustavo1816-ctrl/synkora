// ————————————————————————————————————————————————————————————————————————
// CAMPO DE PARTÍCULAS "PAPEL" — motor de fundo em Canvas 2D
//
// O EFEITO (engenharia reversa do shader GPGPU do antigravity.google, trazido
// para a linguagem "papel & painel": pontos de tinta escura sobre papel quente
// #efe9dc, nunca o inverso):
//
//   1. os pontos NÃO ficam numa grade — são amostrados por Poisson-disc
//      (blue noise), então a densidade é uniforme sem alinhamento visível;
//   2. um ANEL persegue o cursor com inércia; as partículas que caem na BANDA
//      do anel (não no disco inteiro) são empurradas radialmente para fora e
//      ao mesmo tempo crescem e escurecem — é o anel de partículas excitadas
//      que dá a assinatura visual do efeito;
//   3. uma deriva orgânica contínua vem de ruído amostrado em duas escalas
//      espaciais com o tempo avançando devagar no eixo z;
//   4. some-se uma ondulação seno/cosseno cuja AMPLITUDE CRESCE com a
//      distância do cursor (perto do cursor manda o anel; longe, a onda);
//   5. todo deslocamento decai de volta à posição de repouso a cada frame
//      (amortecimento ~0,86), então o campo SEMPRE assenta — nada acumula;
//   6. a escala de cada partícula persegue o alvo por lerp (~0,2), então nada
//      "estala": excitar e relaxar são transições, não saltos.
//
// POR QUE CANVAS 2D E NUNCA WebGL:
// o app gasta o orçamento de contextos WebGL nos terminais (xterm + WebglAddon).
// O Chromium mata o contexto MAIS ANTIGO quando o 17º nasce e NUNCA restaura —
// documentado no CLAUDE.md (WEBGL_BUDGET = 12). Um fundo em WebGL roubaria um
// contexto do orçamento e derrubaria SILENCIOSAMENTE o renderer de um terminal
// (que cairia para DOM, perdendo customGlyphs e desalinhando as caixas ╭─│╰).
// Portanto: Canvas 2D, e só. Nenhuma linha deste arquivo pode pedir 'webgl'.
//
// O motor NÃO escuta o mouse: quem alimenta pointer()/setWells()/shock() é o
// componente React dono do canvas. Assim o mesmo campo serve mapa, home e
// overlays sem brigar por listeners globais.
// ————————————————————————————————————————————————————————————————————————

export interface FieldWell {
  /** centro em px do canvas (CSS px, nao device px) */
  x: number
  y: number
  /** raio de influencia em px */
  radius: number
  /** -1..1 — positivo atrai, negativo repele */
  strength: number
  /** matiz HSL 0..360; quando presente, tinge as particulas proximas */
  hue?: number
  /** pulsa o poco (nucleo/card "respirando") */
  pulse?: boolean
}

export interface PaperFieldOptions {
  /** semente estavel: mesmo ceu toda vez que o projeto abre */
  seed: string
  /** cor base da particula, rgb 0..255 */
  ink?: [number, number, number]
  /** densidade: distancia minima entre pontos em px (default ~26) */
  spacing?: number
  /** raio do anel do cursor em px (default ~150) */
  ringRadius?: number
}

export interface PaperField {
  /** CSS px; cuida de devicePixelRatio internamente */
  resize(width: number, height: number): void
  /** null = ponteiro saiu da area */
  pointer(x: number | null, y: number | null): void
  /** substitui a lista de pocos (nucleo + cards) */
  setWells(wells: FieldWell[]): void
  /** onda de choque expansiva a partir de um ponto (evento real do app) */
  shock(x: number, y: number, opts?: { strength?: number; hue?: number }): void
  /** pausa o rAF (aba escondida) — retomar continua de onde parou */
  setPaused(paused: boolean): void
  destroy(): void
}

// ———————————————————————— constantes ————————————————————————
// Toda constante não-óbvia tem o PORQUÊ ao lado. As de força estão em
// "px por frame de 60fps": como o deslocamento é amortecido por DAMPING a cada
// frame, o deslocamento de EQUILÍBRIO de uma força constante é
// força / (1 − DAMPING) ≈ força × 7,1. É essa conta que dimensiona todas elas.

const TAU = Math.PI * 2
const FRAME_MS = 1000 / 60

/** tinta padrão = --ink (#262019) do tema papel */
const DEFAULT_INK: [number, number, number] = [38, 32, 25]
const DEFAULT_SPACING = 26
const DEFAULT_RING_RADIUS = 150

/** Teto DURO de partículas. Área maior NÃO ganha mais pontos — ganha spacing
 *  maior. É o que mantém o custo por frame previsível num monitor 4K. */
const HARD_CAP = 2600
/** Densidade do Bridson: nº de pontos ≈ k × área / dist². MEDIDO nesta
 *  implementação (k = 0,50–0,54 entre 800×600 e 1920×1080, spacing 26–60), não
 *  chutado. Arredondado PARA CIMA de propósito: superestimar a contagem faz o
 *  spacing subir um pouco mais que o necessário, e o erro cai do lado seguro —
 *  a amostragem nunca chega a truncar no cap. Truncar seria pior que ralear:
 *  o Bridson cresce a partir da semente, então parar no meio deixa um SETOR
 *  vazio do canvas em vez de um campo uniformemente mais esparso. */
const POISSON_DENSITY = 0.56
/** Candidatos por ponto ativo no Bridson. O clássico é 30; 14 mantém a
 *  qualidade blue-noise num campo de fundo e corta pela metade o engasgo do
 *  resample (que roda no meio de um gesto de arrastar a janela). */
const K_CANDIDATES = 14
/** O campo sangra para fora da tela: partícula empurrada para fora deixaria
 *  uma faixa vazia na borda, e um resize pequeno (que NÃO reamostra) precisa
 *  de folga para não abrir buraco. */
const BLEED_MUL = 1.5

const BASE_RADIUS = 1.1
/** Escala extra no pico. Era 2,1 (diâmetro máximo MEDIDO de 8,5px) e o usuário
 *  reprovou: sob o cursor as bolinhas viravam bolas. Em 0,85 o pico medido cai
 *  para ~4,6px — o dobro do repouso, que é relevo suficiente. Quem marca a
 *  passagem do anel é a OPACIDADE (HOT_ALPHA), não o tamanho. */
const EXCITED_SCALE = 0.85
/** lerp da escala: ~0,2/frame ⇒ ~90% do caminho em 10 frames. Nada "pop". */
const SCALE_LERP = 0.2
/** amortecimento do deslocamento: o campo sempre volta ao repouso */
const DAMPING = 0.86

/** inércia do anel: 0,12/frame ⇒ o anel arrasta ~8 frames atrás do cursor */
const RING_FOLLOW = 0.12
/** ponteiro saiu: a influência DESVANECE (~0,5s) em vez de estalar para 0 */
const RING_FADE = 0.06
/** meia-largura da banda, relativa ao raio. É o que faz um ANEL e não um disco. */
const RING_BAND_MUL = 0.42
/** preenchimento fraco dentro do anel — sem ele o miolo fica morto demais */
const RING_FILL = 0.22
/** empurrão radial: equilíbrio ≈ 3,6 × 7,1 ≈ 26px de afastamento no pico */
const RING_PUSH = 3.6

/** deriva do ruído: equilíbrio ≈ 4,4px — perceptível, nunca "nervoso" */
const DRIFT_PUSH = 0.62
/** escala grossa (~625px de período): a corrente geral do campo */
const NOISE_FREQ_COARSE = 0.0016
const NOISE_TIME_COARSE = 0.045
/** escala fina (~165px): o tremular local. Razão não-inteira com a grossa para
 *  os dois lattices do ruído de valor nunca coincidirem (mataria a organicidade). */
const NOISE_FREQ_FINE = 0.0061
const NOISE_TIME_FINE = 0.085
/** quanto a escala fina pode torcer a direção da corrente: ±45°. Mais que isso
 *  e as vizinhas se separam; menos e o campo inteiro anda em bloco. */
const FLOW_DETAIL = Math.PI * 0.5

/**
 * ONDULAÇÃO AMBIENTE — é ela que mantém o campo VIVO com o mouse parado
 * (pedido explícito do usuário: "levemente se mexendo para um lado e para o
 * outro"). Cada partícula tem fase própria, então elas vão e voltam em ritmos
 * diferentes em vez de marchar juntas.
 * Equilíbrio ≈ push/(1−damping) ≈ 6,8px de excursão; período espacial ~700px
 * (vizinhas acompanham, o campo não "chia"); ~0,42 rad/s ≈ um ciclo a cada 15s.
 */
const RIPPLE_PUSH = 0.95
const RIPPLE_K = 0.009
const RIPPLE_W = 0.42
/** Alcance em que o cursor "cala" a ondulação. Era 3× o raio do anel (450px) e
 *  congelava metade da tela em volta do mouse — agora só a vizinhança imediata,
 *  onde o anel manda mesmo. */
const RIPPLE_CALM_MUL = 1.1

/** poço com strength 1 puxa ~23px no centro */
const WELL_PUSH = 3.2
const WELL_EXC = 0.9
/** respiração do poço pulsante: ~1,9 rad/s ≈ 3,3s por ciclo */
const PULSE_W = 1.9

const SHOCK_SPEED = 380
const SHOCK_LIFE = 1.1
/** espessura da frente: mais fina viraria um "pulo" de 1 frame por partícula */
const SHOCK_THICK = 46
const SHOCK_PUSH = 7.5
/** teto de ondas vivas; a mais antiga cai (clique repetido não vira DoS) */
const MAX_SHOCKS = 12

/** repouso SUTIL: o campo é fundo, não conteúdo */
const REST_ALPHA_MIN = 0.1
const REST_ALPHA_MAX = 0.18
/** Com as bolinhas menores (EXCITED_SCALE 0,85), o anel do cursor precisa de um
 *  pouco mais de tinta para continuar legível — a troca é deliberada: contraste
 *  em vez de tamanho. */
const HOT_ALPHA = 0.74

// Baldes de desenho. Um balde custa só um contador Int32 — o que custa é o
// fill(), e só os NÃO-VAZIOS são emitidos. MEDIDO: 3 fills/frame em repouso,
// ~47 com anel + 8 poços matizados, ~99 no pior caso (ondas cobrindo a tela).
// ~100 draw calls é barato perto do custo de rasterização, então vale gastar
// 12 níveis de alfa: com 8 apareceria banda justamente na faixa 0,10–0,18,
// que é onde o campo em repouso vive e onde o olho é mais sensível.
const ALPHA_STEPS = 12
const HUE_SLOTS = 3
const TINT_LEVELS = 3
const COLOR_SLOTS = 1 + HUE_SLOTS * TINT_LEVELS
const BUCKETS = COLOR_SLOTS * ALPHA_STEPS
const ALPHA_MIN = 0.08
const ALPHA_SPAN = 0.58
const TINT_MIX = [0.34, 0.66, 1] as const
/** matiz do tema papel: saturação/luz baixas — cor saturada berra no papel */
const TINT_S = 0.55
const TINT_L = 0.42
/** abaixo disso a partícula fica na tinta base (evita tingir o campo inteiro) */
const TINT_MIN = 0.18
/** matizes quantizadas em 15° para dois poços quase iguais dividirem um slot */
const HUE_QUANT = 15

// ESCOLHA MEDIDA (Chromium/Skia real, 1300 pontos r≈1,1, dpr 2, 400 iterações):
//   path com moveTo+arc + 1 fill ... 0,445 ms
//   path com rect + 1 fill ........ 0,126 ms   ← 3,5× mais rápido
//   fillRect × N (N draw calls) ... 0,301 ms
// Então o ponto pequeno é RECT. O porém, também medido: um quadrado de lado 2r
// cobre 20–37% MAIS pixels que o círculo de raio r — o campo inteiro
// engrossaria, e a sutileza é o ponto dele. A correção é casar a ÁREA
// (lado = r·√π em vez de 2r): medido, a cobertura fica dentro de ±3% do
// círculo em toda a faixa de repouso (r 0,88–1,375) e ±8% no pior caso.
// Assim o rect é 3,5× mais barato SEM pesar mais na tela.
/** meio-lado do quadrado de mesma ÁREA que o círculo de raio r: √π / 2 */
const SQ_HALF = Math.sqrt(Math.PI) / 2
/** acima deste raio o canto do quadrado começa a aparecer ⇒ volta para o arc.
 *  Em repouso o raio vai no máximo a 1,375 (BASE × sizeVar), então o campo
 *  parado é 100% rect e só a partícula EXCITADA (onde o olho vai) paga o arc. */
const RECT_MAX_R = 1.6

/** média móvel acima disso = frame caro; degrada uma vez */
const SLOW_MS = 9
const PROBE_FRAMES = 30
const MAX_DEGRADE = 2
const DEGRADE_MUL = 1.25

// ———————————————————————— utilidades puras ————————————————————————

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x < edge0 ? 0 : 1
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/** mulberry32 com semente derivada da string — MESMA convenção do starField em
 *  panesNodes.ts, para o "céu" ser idêntico em toda abertura do projeto. */
function makeRandom(seed: string): () => number {
  let s = seedInt(seed)
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedInt(seed: string): number {
  let s = 0
  for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0
  return s >>> 0
}

/** Hash inteiro → 0..1. SEM tabela de permutação de propósito: um lookup em 8
 *  posições espalhadas de um array custa cache miss por partícula; imul puro
 *  fica em registrador e é o que segura o orçamento de frame. */
function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h = seed + Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(iz, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** fade de Perlin (smootherstep): derivada 1ª E 2ª nulas nos nós, então o
 *  lattice do ruído de valor não aparece como grade. */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

/**
 * Ruído de VALOR 3D (não simplex): 8 amostras de lattice + interpolação. É a
 * troca certa aqui — simplex custa mais código e mais ops por amostra, e o
 * artefato de grade do ruído de valor some porque (a) o fade é smootherstep,
 * (b) somamos duas escalas de frequência incomensuráveis e (c) o resultado
 * vira ÂNGULO de um deslocamento de ~4px, não uma altura visível.
 */
function noise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const ux = fade(x - ix)
  const uy = fade(y - iy)
  const uz = fade(z - iz)

  const c000 = hash3(ix, iy, iz, seed)
  const c100 = hash3(ix + 1, iy, iz, seed)
  const c010 = hash3(ix, iy + 1, iz, seed)
  const c110 = hash3(ix + 1, iy + 1, iz, seed)
  const c001 = hash3(ix, iy, iz + 1, seed)
  const c101 = hash3(ix + 1, iy, iz + 1, seed)
  const c011 = hash3(ix, iy + 1, iz + 1, seed)
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed)

  const x00 = c000 + (c100 - c000) * ux
  const x10 = c010 + (c110 - c010) * ux
  const x01 = c001 + (c101 - c001) * ux
  const x11 = c011 + (c111 - c011) * ux
  const y0 = x00 + (x10 - x00) * uy
  const y1 = x01 + (x11 - x01) * uy
  return y0 + (y1 - y0) * uz
}

/** HSL → RGB 0..255. Usado só para materializar a matiz de um poço/onda na
 *  paleta do frame (algumas dezenas de chamadas por sessão, não por frame). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hp = ((((h % 360) + 360) % 360) / 60)
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) {
    r = c
    g = x
  } else if (hp < 2) {
    r = x
    g = c
  } else if (hp < 3) {
    g = c
    b = x
  } else if (hp < 4) {
    g = x
    b = c
  } else if (hp < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

interface Points {
  xs: Float32Array
  ys: Float32Array
}

/**
 * Poisson-disc por Bridson: grade de aceleração com célula = dist/√2 (garante
 * no máximo 1 ponto por célula), lista de ativos e candidatos no anel [r, 2r).
 * O `rand` recebido é semeado pela seed do campo → mesmo céu toda vez.
 */
function poissonDisc(
  width: number,
  height: number,
  minDist: number,
  bleed: number,
  cap: number,
  rand: () => number
): Points {
  const x0 = -bleed
  const y0 = -bleed
  const w = width + bleed * 2
  const h = height + bleed * 2
  if (w <= 0 || h <= 0 || cap <= 0) return { xs: new Float32Array(0), ys: new Float32Array(0) }

  const r = Math.max(4, minDist)
  const r2 = r * r
  const cell = r / Math.SQRT2
  const gw = Math.max(1, Math.ceil(w / cell))
  const gh = Math.max(1, Math.ceil(h / cell))
  const grid = new Int32Array(gw * gh).fill(-1)
  const px: number[] = []
  const py: number[] = []
  const active: number[] = []

  const insert = (x: number, y: number): void => {
    const idx = px.length
    px.push(x)
    py.push(y)
    const gx = Math.min(gw - 1, ((x - x0) / cell) | 0)
    const gy = Math.min(gh - 1, ((y - y0) / cell) | 0)
    grid[gy * gw + gx] = idx
    active.push(idx)
  }

  const fits = (x: number, y: number): boolean => {
    if (x < x0 || y < y0 || x >= x0 + w || y >= y0 + h) return false
    const cx = ((x - x0) / cell) | 0
    const cy = ((y - y0) / cell) | 0
    // 2 células de raio: com célula = r/√2, tudo a menos de r cabe nessa janela
    const gx1 = Math.max(0, cx - 2)
    const gx2 = Math.min(gw - 1, cx + 2)
    const gy1 = Math.max(0, cy - 2)
    const gy2 = Math.min(gh - 1, cy + 2)
    for (let gy = gy1; gy <= gy2; gy++) {
      const row = gy * gw
      for (let gx = gx1; gx <= gx2; gx++) {
        const j = grid[row + gx]
        if (j < 0) continue
        const dx = px[j] - x
        const dy = py[j] - y
        if (dx * dx + dy * dy < r2) return false
      }
    }
    return true
  }

  insert(x0 + w * 0.5, y0 + h * 0.5)
  while (active.length > 0 && px.length < cap) {
    const ai = (rand() * active.length) | 0
    const seedIdx = active[ai]
    const sx = px[seedIdx]
    const sy = py[seedIdx]
    let placed = false
    for (let k = 0; k < K_CANDIDATES; k++) {
      const ang = rand() * TAU
      const rad = r * (1 + rand())
      const nx = sx + Math.cos(ang) * rad
      const ny = sy + Math.sin(ang) * rad
      if (fits(nx, ny)) {
        insert(nx, ny)
        placed = true
        break
      }
    }
    if (!placed) {
      // remoção O(1): troca com o último e encurta
      active[ai] = active[active.length - 1]
      active.pop()
    }
  }
  return { xs: Float32Array.from(px), ys: Float32Array.from(py) }
}

interface Shock {
  x: number
  y: number
  born: number
  strength: number
  hue: number | null
}

const NOOP_FIELD: PaperField = {
  resize: () => undefined,
  pointer: () => undefined,
  setWells: () => undefined,
  shock: () => undefined,
  setPaused: () => undefined,
  destroy: () => undefined
}

export function createPaperField(
  canvas: HTMLCanvasElement,
  options: PaperFieldOptions
): PaperField {
  const ctx = canvas.getContext('2d')
  // getContext pode devolver null (contexto já tomado por outro tipo, aba sem
  // aceleração). O campo é DECORAÇÃO: vira no-op em vez de derrubar a tela.
  if (!ctx) return NOOP_FIELD

  const ink: [number, number, number] = options.ink
    ? [options.ink[0], options.ink[1], options.ink[2]]
    : [DEFAULT_INK[0], DEFAULT_INK[1], DEFAULT_INK[2]]
  const ringRadius = Math.max(24, options.ringRadius ?? DEFAULT_RING_RADIUS)
  const ringBand = ringRadius * RING_BAND_MUL
  const baseSpacing = Math.max(6, options.spacing ?? DEFAULT_SPACING)
  const noiseSeedA = seedInt(options.seed)
  const noiseSeedB = (noiseSeedA ^ 0x5bf03635) | 0

  let spacing = baseSpacing
  let width = 0
  let height = 0
  let sampledArea = 0
  let destroyed = false
  let paused = false
  let rafId = 0
  let lastTs = 0
  let time = 0

  // —— estado das partículas (SoA: um Float32Array por atributo; SoA é o que
  // permite o laço quente ficar monomórfico e sem alocação por frame) ——
  let count = 0
  let restX = new Float32Array(0)
  let restY = new Float32Array(0)
  let dispX = new Float32Array(0)
  let dispY = new Float32Array(0)
  let scale = new Float32Array(0)
  /** fase aleatória por partícula: sem ela a ondulação bateria em uníssono */
  let phase = new Float32Array(0)
  let restAlpha = new Float32Array(0)
  /** variação de tamanho: campo com todos os pontos idênticos parece impresso */
  let sizeVar = new Float32Array(0)

  // —— rascunho de desenho (pré-alocado; nada disso aloca por frame) ——
  let tmpX = new Float32Array(0)
  let tmpY = new Float32Array(0)
  let tmpR = new Float32Array(0)
  let tmpB = new Uint8Array(0)
  /** saída ORDENADA por balde, intercalada [x, y, r] */
  let out = new Float32Array(0)
  const bucketCount = new Int32Array(BUCKETS)
  const bucketStart = new Int32Array(BUCKETS)
  const bucketCursor = new Int32Array(BUCKETS)

  // —— ponteiro / anel ——
  let hasPointer = false
  let ptrX = 0
  let ptrY = 0
  let ringX = 0
  let ringY = 0
  let ringAmp = 0

  // —— poços (cópia defensiva: o chamador costuma reusar o array) ——
  let wells: FieldWell[] = []
  let wellX = new Float32Array(0)
  let wellY = new Float32Array(0)
  let wellR = new Float32Array(0)
  let wellS = new Float32Array(0)
  let wellSlot = new Int8Array(0)
  let wellPhase = new Float32Array(0)

  // —— ondas de choque ——
  const shocks: Shock[] = []
  let shockX = new Float32Array(MAX_SHOCKS)
  let shockY = new Float32Array(MAX_SHOCKS)
  let shockRad = new Float32Array(MAX_SHOCKS)
  let shockAmp = new Float32Array(MAX_SHOCKS)
  let shockSlot = new Int8Array(MAX_SHOCKS)
  let shockLive = 0

  // —— paleta ——
  const hueSlots: number[] = []
  let paletteSig = ''
  let fillStyles: string[] = []

  // —— movimento reduzido ——
  const mq =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
  let reduced = mq ? mq.matches : false

  // —— sonda de custo / degradação ——
  let probeFrames = 0
  let probeAcc = 0
  let degradeSteps = 0

  const rebuildPalette = (): void => {
    const sig = hueSlots.join(',')
    if (sig === paletteSig && fillStyles.length === BUCKETS) return
    paletteSig = sig
    const slots: [number, number, number][] = [[ink[0], ink[1], ink[2]]]
    for (const hue of hueSlots) {
      const target = hslToRgb(hue, TINT_S, TINT_L)
      for (let t = 0; t < TINT_LEVELS; t++) {
        const m = TINT_MIX[t]
        slots.push([
          Math.round(ink[0] + (target[0] - ink[0]) * m),
          Math.round(ink[1] + (target[1] - ink[1]) * m),
          Math.round(ink[2] + (target[2] - ink[2]) * m)
        ])
      }
    }
    // menos matizes ativas que HUE_SLOTS: os slots sobrando ficam na tinta base
    while (slots.length < COLOR_SLOTS) slots.push([ink[0], ink[1], ink[2]])
    const next = new Array<string>(BUCKETS)
    for (let c = 0; c < COLOR_SLOTS; c++) {
      const rgb = slots[c]
      for (let a = 0; a < ALPHA_STEPS; a++) {
        const alpha = ALPHA_MIN + (a / (ALPHA_STEPS - 1)) * ALPHA_SPAN
        next[c * ALPHA_STEPS + a] = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(3)})`
      }
    }
    fillStyles = next
  }

  /** Registra uma matiz e devolve o slot (ou −1 se os 3 slots já estão tomados;
   *  além de 3 matizes simultâneas o olho não separa mesmo). */
  const slotForHue = (hue: number): number => {
    const q = ((Math.round(hue / HUE_QUANT) * HUE_QUANT) % 360 + 360) % 360
    const at = hueSlots.indexOf(q)
    if (at >= 0) return at
    if (hueSlots.length >= HUE_SLOTS) return -1
    hueSlots.push(q)
    return hueSlots.length - 1
  }

  const allocParticles = (n: number): void => {
    count = n
    restX = new Float32Array(n)
    restY = new Float32Array(n)
    dispX = new Float32Array(n)
    dispY = new Float32Array(n)
    scale = new Float32Array(n).fill(1)
    phase = new Float32Array(n)
    restAlpha = new Float32Array(n)
    sizeVar = new Float32Array(n)
    tmpX = new Float32Array(n)
    tmpY = new Float32Array(n)
    tmpR = new Float32Array(n)
    tmpB = new Uint8Array(n)
    out = new Float32Array(n * 3)
  }

  const resample = (): void => {
    if (width <= 0 || height <= 0) {
      allocParticles(0)
      sampledArea = 0
      return
    }
    const bleed = spacing * BLEED_MUL
    const area = (width + bleed * 2) * (height + bleed * 2)
    // Se o spacing pedido estouraria o teto, é a DISTÂNCIA que sobe — nunca o
    // número de partículas. Custo por frame previsível é mais importante que
    // densidade exata num monitor gigante.
    let dist = spacing
    const estimate = (area * POISSON_DENSITY) / (dist * dist)
    if (estimate > HARD_CAP) dist = Math.sqrt((area * POISSON_DENSITY) / HARD_CAP)

    // semente RE-DERIVADA da string a cada amostragem: o céu é o mesmo sempre
    const rand = makeRandom(options.seed)
    const pts = poissonDisc(width, height, dist, bleed, HARD_CAP, rand)
    allocParticles(pts.xs.length)
    for (let i = 0; i < count; i++) {
      restX[i] = pts.xs[i]
      restY[i] = pts.ys[i]
      phase[i] = rand() * TAU
      restAlpha[i] = REST_ALPHA_MIN + rand() * (REST_ALPHA_MAX - REST_ALPHA_MIN)
      sizeVar[i] = 0.8 + rand() * 0.45
    }
    sampledArea = area
  }

  /**
   * Um passo do campo. `f` = delta normalizado a 60fps.
   * f === 0 é o MODO ESTÁTICO (prefers-reduced-motion): com f zerado toda força
   * some, o amortecimento vira 1 e os lerps ficam parados — as partículas
   * ficam exatamente no repouso, mas o TINGIMENTO dos poços continua sendo
   * calculado (cor não é movimento). Um caminho de código só, sem duplicação.
   */
  const step = (f: number): number => {
    // anel: persegue o ponteiro com inércia; sem ponteiro, a influência some
    const kPos = 1 - Math.pow(1 - RING_FOLLOW, f)
    if (hasPointer) {
      ringX += (ptrX - ringX) * kPos
      ringY += (ptrY - ringY) * kPos
    }
    const kAmp = 1 - Math.pow(1 - RING_FADE, f)
    ringAmp += ((hasPointer ? 1 : 0) - ringAmp) * kAmp

    // paleta do frame: matizes vêm dos poços e das ondas (o anel do cursor não
    // tem matiz na API pública — ele excita tamanho/opacidade, não cor)
    hueSlots.length = 0

    // achata os poços em arrays paralelos: o laço quente não deve tocar objetos
    const wn = wells.length
    if (wellX.length < wn) {
      wellX = new Float32Array(wn)
      wellY = new Float32Array(wn)
      wellR = new Float32Array(wn)
      wellS = new Float32Array(wn)
      wellSlot = new Int8Array(wn)
      wellPhase = new Float32Array(wn)
    }
    for (let k = 0; k < wn; k++) {
      const wl = wells[k]
      wellX[k] = wl.x
      wellY[k] = wl.y
      wellR[k] = Math.max(1, wl.radius)
      const raw = Math.max(-1, Math.min(1, wl.strength))
      wellS[k] =
        wl.pulse && f > 0 ? raw * (0.72 + 0.28 * Math.sin(time * PULSE_W + wellPhase[k])) : raw
      wellSlot[k] = wl.hue === undefined ? -1 : slotForHue(wl.hue)
    }

    // ondas vivas → arrays paralelos (as expiradas caem aqui)
    shockLive = 0
    for (let k = shocks.length - 1; k >= 0; k--) {
      const s = shocks[k]
      const age = time - s.born
      if (age < 0 || age > SHOCK_LIFE) {
        shocks.splice(k, 1)
        continue
      }
      const i = shockLive++
      shockX[i] = s.x
      shockY[i] = s.y
      shockRad[i] = age * SHOCK_SPEED
      shockAmp[i] = s.strength * (1 - age / SHOCK_LIFE)
      shockSlot[i] = s.hue === null ? -1 : slotForHue(s.hue)
    }

    rebuildPalette()

    // fatores constantes no frame: fora do laço quente
    const damp = Math.pow(DAMPING, f)
    const kScale = 1 - Math.pow(1 - SCALE_LERP, f)
    const ringIn = ringRadius - ringBand
    const ringInHi = ringRadius - ringBand * 0.3
    const ringOutLo = ringRadius + ringBand * 0.3
    const ringOut = ringRadius + ringBand
    const calmR = ringRadius * RIPPLE_CALM_MUL
    const noiseT1 = time * NOISE_TIME_COARSE
    const noiseT2 = time * NOISE_TIME_FINE
    const ripT1 = time * RIPPLE_W
    const ripT2 = time * RIPPLE_W * 0.83
    const cullMin = -3
    const cullX = width + 3
    const cullY = height + 3

    bucketCount.fill(0)
    let visible = 0

    for (let i = 0; i < count; i++) {
      const rx = restX[i]
      const ry = restY[i]
      let dx = dispX[i]
      let dy = dispY[i]
      const x = rx + dx
      const y = ry + dy
      let exc = 0
      let bestTint = 0
      let bestSlot = -1

      // ——— anel do cursor: BANDA (não disco) + preenchimento fraco dentro ———
      const ax = x - ringX
      const ay = y - ringY
      const dRing = Math.sqrt(ax * ax + ay * ay) || 1e-4
      if (ringAmp > 0.001) {
        const band =
          smoothstep(ringIn, ringInHi, dRing) * (1 - smoothstep(ringOutLo, ringOut, dRing))
        const fill = (1 - smoothstep(0, ringOut, dRing)) * RING_FILL
        const t = Math.min(1, band + fill) * ringAmp
        if (t > 0) {
          const push = (t * RING_PUSH * f) / dRing
          dx += ax * push
          dy += ay * push
          exc += t
        }
      }

      // ——— deriva orgânica: o ruído define o ÂNGULO de um campo de fluxo ———
      // Amostrar UM escalar e virar ângulo custa metade de amostrar um por eixo
      // e sai mais orgânico (as partículas seguem correntes em vez de tremerem
      // cada uma para o seu lado). Amostrado na posição de REPOUSO, nunca na
      // deslocada: realimentar o fluxo com o próprio deslocamento faz as
      // partículas se juntarem em grumos que nunca desfazem.
      if (f > 0) {
        // A escala grossa dá a DIREÇÃO da corrente e percorre o círculo
        // EXATAMENTE uma vez (× TAU) — é a formulação certa de um campo de
        // fluxo: vizinhas que enxergam ruído parecido saem em direções
        // parecidas. Percorrer duas voltas (× TAU × 2, como estava) faz o
        // ângulo girar dentro de poucos pixels e desmancha essa coerência.
        // TEXTURA MEDIDA (distância ao vizinho mais próximo, 1000×700,
        // spacing 26): repouso média 28,8px / p5 25,5; em deriva média 26,3 /
        // p5 18,0 / p95 estável. Ou seja: o campo AFROUXA um pouco e PARA —
        // 1200 frames dão o mesmo número que 400, não há agrupamento
        // progressivo. O deslocamento também é limitado: pico de 13px em 3000
        // frames, contra ~7px de equilíbrio teórico (deriva + ondulação).
        const a =
          noise3(rx * NOISE_FREQ_COARSE, ry * NOISE_FREQ_COARSE, noiseT1, noiseSeedA) * TAU +
          (noise3(rx * NOISE_FREQ_FINE, ry * NOISE_FREQ_FINE, noiseT2, noiseSeedB) - 0.5) *
            FLOW_DETAIL
        const drift = DRIFT_PUSH * f
        dx += Math.cos(a) * drift
        dy += Math.sin(a) * drift

        // ——— ondulação: amplitude CRESCE com a distância do cursor ———
        // perto do cursor manda o anel; longe, a onda toma conta
        const near = ringAmp * (1 - smoothstep(0, calmR, dRing))
        const rip = (1 - near) * RIPPLE_PUSH * f
        if (rip > 0) {
          const ph = phase[i]
          dx += Math.sin(ry * RIPPLE_K + ripT1 + ph) * rip
          dy += Math.cos(rx * RIPPLE_K + ripT2 + ph) * rip
        }
      }

      // ——— poços: atrai (strength > 0) ou repele (< 0) com queda suave ———
      for (let k = 0; k < wn; k++) {
        const wx = x - wellX[k]
        const wy = y - wellY[k]
        const rr = wellR[k]
        const d2 = wx * wx + wy * wy
        if (d2 >= rr * rr) continue
        const d = Math.sqrt(d2) || 1e-4
        const u = 1 - d / rr
        const falloff = u * u * (3 - 2 * u)
        const s = wellS[k]
        if (f > 0 && s !== 0) {
          // strength positivo ATRAI ⇒ desloca no sentido do centro (−normal)
          const amp = (falloff * s * WELL_PUSH * f) / d
          dx -= wx * amp
          dy -= wy * amp
        }
        const e = falloff * Math.abs(s)
        exc += e * WELL_EXC
        const slot = wellSlot[k]
        if (slot >= 0 && e > bestTint) {
          bestTint = e
          bestSlot = slot
        }
      }

      // ——— ondas de choque: empurrão quando a FRENTE passa por cima ———
      for (let k = 0; k < shockLive; k++) {
        const sx = x - shockX[k]
        const sy = y - shockY[k]
        const d = Math.sqrt(sx * sx + sy * sy) || 1e-4
        const front = Math.abs(d - shockRad[k])
        if (front >= SHOCK_THICK) continue
        const wgt = (1 - smoothstep(0, SHOCK_THICK, front)) * shockAmp[k]
        if (wgt <= 0) continue
        const amp = (wgt * SHOCK_PUSH * f) / d
        dx += sx * amp
        dy += sy * amp
        exc += wgt
        const slot = shockSlot[k]
        if (slot >= 0 && wgt > bestTint) {
          bestTint = wgt
          bestSlot = slot
        }
      }

      // ——— amortecimento: o campo SEMPRE volta ao repouso ———
      dx *= damp
      dy *= damp
      dispX[i] = dx
      dispY[i] = dy

      // escala persegue o alvo (nada estala); a opacidade é DERIVADA da escala
      // já suavizada — uma fonte de verdade, e as duas easam juntas
      const target = 1 + Math.min(1, exc) * EXCITED_SCALE
      const sc = scale[i] + (target - scale[i]) * kScale
      scale[i] = sc

      const px = rx + dx
      const py = ry + dy
      // corte barato: as partículas de sangramento não entram no path
      if (px < cullMin || px > cullX || py < cullMin || py > cullY) continue

      const e = (sc - 1) / EXCITED_SCALE
      const ra = restAlpha[i]
      const alpha = ra + e * (HOT_ALPHA - ra)

      let ai = Math.round(((alpha - ALPHA_MIN) / ALPHA_SPAN) * (ALPHA_STEPS - 1))
      if (ai < 0) ai = 0
      else if (ai > ALPHA_STEPS - 1) ai = ALPHA_STEPS - 1

      let cs = 0
      if (bestSlot >= 0 && bestTint > TINT_MIN) {
        const tl = bestTint < 0.45 ? 0 : bestTint < 0.75 ? 1 : 2
        cs = 1 + bestSlot * TINT_LEVELS + tl
      }
      const b = cs * ALPHA_STEPS + ai

      tmpX[visible] = px
      tmpY[visible] = py
      tmpR[visible] = BASE_RADIUS * sizeVar[i] * sc
      tmpB[visible] = b
      bucketCount[b]++
      visible++
    }
    return visible
  }

  const draw = (visible: number): void => {
    ctx.clearRect(0, 0, width, height)
    if (visible === 0) return

    // Counting sort: agrupa por balde SEM alocar um pool por balde (um pool
    // por balde custaria BUCKETS × cap floats; aqui é um array só).
    let acc = 0
    for (let b = 0; b < BUCKETS; b++) {
      bucketStart[b] = acc
      bucketCursor[b] = acc
      acc += bucketCount[b]
    }
    for (let i = 0; i < visible; i++) {
      const b = tmpB[i]
      const o = bucketCursor[b]++ * 3
      out[o] = tmpX[i]
      out[o + 1] = tmpY[i]
      out[o + 2] = tmpR[i]
    }

    // Um beginPath()+fill() por balde NÃO-VAZIO (baldes vazios não custam nada).
    // rect de área casada para o pontinho, moveTo+arc para o excitado — ver o
    // bloco de constantes para os números medidos. O moveTo é OBRIGATÓRIO antes
    // do arc: sem ele o arc liga no subpath anterior por uma reta.
    for (let b = 0; b < BUCKETS; b++) {
      const n = bucketCount[b]
      if (n === 0) continue
      ctx.fillStyle = fillStyles[b]
      ctx.beginPath()
      const s = bucketStart[b]
      for (let k = 0; k < n; k++) {
        const o = (s + k) * 3
        const x = out[o]
        const y = out[o + 1]
        const r = out[o + 2]
        if (r < RECT_MAX_R) {
          const half = r * SQ_HALF
          ctx.rect(x - half, y - half, half * 2, half * 2)
        } else {
          ctx.moveTo(x + r, y)
          ctx.arc(x, y, r, 0, TAU)
        }
      }
      ctx.fill()
    }
  }

  /** Frame estático (movimento reduzido): step(0) deixa tudo no repouso e
   *  ainda assim calcula o tingimento dos poços. */
  const renderStatic = (): void => {
    if (destroyed || width <= 0 || height <= 0) return
    draw(step(0))
  }

  /**
   * Degradação: se a média móvel de 30 frames passar de 9ms, sobe o spacing 25%
   * e reamostra — UMA vez, no máximo duas (MAX_DEGRADE). Sem esse teto uma
   * máquina lenta cairia numa espiral: cada degradação abre espaço para a
   * próxima medição continuar ruim por outro motivo (GPU ocupada pelos
   * terminais, por exemplo) e o campo sumiria da tela.
   */
  const probe = (ms: number): void => {
    if (degradeSteps >= MAX_DEGRADE) return
    probeAcc += ms
    probeFrames++
    if (probeFrames < PROBE_FRAMES) return
    const avg = probeAcc / probeFrames
    probeAcc = 0
    probeFrames = 0
    if (avg <= SLOW_MS) return
    degradeSteps++
    spacing *= DEGRADE_MUL
    resample()
  }

  const frame = (now: number): void => {
    if (destroyed || paused) return
    rafId = requestAnimationFrame(frame)
    // lastTs === 0 é o sentinela de "relógio reiniciado" (boot ou retomada):
    // o 1º frame vale exatamente um frame, então nada salta.
    const dtMs = lastTs === 0 ? FRAME_MS : now - lastTs
    lastTs = now
    // trava do delta: aba de fundo que volta entrega dt de SEGUNDOS; sem isso o
    // campo daria um salto único e absurdo (e o ruído pularia de vizinhança)
    const f = Math.min(3, Math.max(0.05, dtMs / FRAME_MS))
    time += Math.min(dtMs, 100) / 1000
    const t0 = performance.now()
    draw(step(f))
    probe(performance.now() - t0)
  }

  const ensureLoop = (): void => {
    if (destroyed || paused || reduced || rafId !== 0) return
    if (count === 0 || width <= 0 || height <= 0) return
    lastTs = 0
    rafId = requestAnimationFrame(frame)
  }

  const stopLoop = (): void => {
    if (rafId !== 0) cancelAnimationFrame(rafId)
    rafId = 0
  }

  const onMotionChange = (): void => {
    reduced = mq ? mq.matches : false
    if (reduced) {
      stopLoop()
      // zera o que já estava deslocado, senão o campo congela torto
      dispX.fill(0)
      dispY.fill(0)
      scale.fill(1)
      ringAmp = 0
      shocks.length = 0
      renderStatic()
    } else {
      ensureLoop()
    }
  }
  if (mq) mq.addEventListener('change', onMotionChange)

  return {
    resize(w: number, h: number): void {
      if (destroyed) return
      const nw = Math.max(0, Math.floor(w))
      const nh = Math.max(0, Math.floor(h))
      width = nw
      height = nh
      // DPR travado em 2: acima disso o ganho visual num ponto de 1px é nulo e
      // o custo de rasterização cresce com o quadrado
      const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
      const bw = Math.max(1, Math.round(nw * dpr))
      const bh = Math.max(1, Math.round(nh * dpr))
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw
        canvas.height = bh
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const bleed = spacing * BLEED_MUL
      const area = (nw + bleed * 2) * (nh + bleed * 2)
      // Reamostra só quando a área muda de verdade (>10%): um resize pequeno
      // não pode REEMBARALHAR o céu debaixo do olho do usuário. É para isso que
      // existe o sangramento — ele cobre a folga do crescimento pequeno.
      const changed = count === 0 || sampledArea === 0 || Math.abs(area - sampledArea) > sampledArea * 0.1
      if (changed) resample()
      if (reduced) renderStatic()
      else ensureLoop()
    },

    pointer(x: number | null, y: number | null): void {
      if (destroyed) return
      if (x === null || y === null) {
        hasPointer = false
        return
      }
      // ponteiro voltando com o anel já apagado: teleporta em vez de varrer a
      // tela inteira até a posição nova
      if (!hasPointer && ringAmp < 0.02) {
        ringX = x
        ringY = y
      }
      hasPointer = true
      ptrX = x
      ptrY = y
    },

    setWells(next: FieldWell[]): void {
      if (destroyed) return
      // cópia defensiva: o chamador costuma reciclar o mesmo array/objetos
      wells = next.map((w) => ({
        x: w.x,
        y: w.y,
        radius: w.radius,
        strength: w.strength,
        hue: w.hue,
        pulse: w.pulse
      }))
      if (wellPhase.length < wells.length) wellPhase = new Float32Array(wells.length)
      for (let i = 0; i < wells.length; i++) {
        // fase derivada da POSIÇÃO: poço que continua no mesmo lugar mantém a
        // respiração; um índice de array faria a fase pular a cada setWells
        wellPhase[i] = (wells[i].x + wells[i].y) * 0.01
      }
      if (reduced) renderStatic()
    },

    shock(x: number, y: number, opts?: { strength?: number; hue?: number }): void {
      if (destroyed || reduced) return
      shocks.push({
        x,
        y,
        born: time,
        strength: Math.max(0, Math.min(2, opts?.strength ?? 1)),
        hue: opts?.hue ?? null
      })
      // teto de ondas vivas: a mais antiga cai
      while (shocks.length > MAX_SHOCKS) shocks.shift()
      if (shockX.length < MAX_SHOCKS) {
        shockX = new Float32Array(MAX_SHOCKS)
        shockY = new Float32Array(MAX_SHOCKS)
        shockRad = new Float32Array(MAX_SHOCKS)
        shockAmp = new Float32Array(MAX_SHOCKS)
        shockSlot = new Int8Array(MAX_SHOCKS)
      }
    },

    setPaused(next: boolean): void {
      if (destroyed || next === paused) return
      paused = next
      if (paused) {
        // pausa CANCELA o rAF: com vários universos montados ao mesmo tempo,
        // um campo escondido girando é trabalho jogado fora
        stopLoop()
      } else {
        lastTs = 0
        ensureLoop()
      }
    },

    destroy(): void {
      if (destroyed) return
      destroyed = true
      stopLoop()
      if (mq) mq.removeEventListener('change', onMotionChange)
      wells = []
      shocks.length = 0
    }
  }
}
