/**
 * `browser_shot` — O PIXEL VIRA ARQUIVO NO WORKTREE (H2 do design
 * `.synkora/reports/DESIGN_BROWSER_EMBUTIDO_2026-08-29.md`).
 *
 * Três leis pagas em sonda mandam neste arquivo:
 *
 * 1. **`capturePage()` é do MAIN, e é por isso que a rota B ganhou.** Medido
 *    (P4/P5): 24 ms com a view visível e **7-14 ms com ela colapsada**, contra
 *    100 ms e **~1 060 ms** do `Page.captureScreenshot` pelo CDP. Quatro a
 *    cento e cinquenta vezes — e essa API só existe dentro do processo main.
 *
 * 2. **FRESCOR É CARIMBO, NUNCA FÉ.** O Chromium avisa que capturar de um
 *    renderer suspenso *pode devolver dado velho* (`CopyFromSurface`), e as
 *    issues do Electron (#31992, #35953) mostram captura vazia com a janela
 *    escondida. Screenshot VAZIO é o caso benigno; screenshot ANTIGO é o
 *    perigoso, porque o agente aprova uma tela que não existe mais. A defesa é
 *    dizer a verdade: toda captura roda uma sonda de `rAF` antes e CARIMBA a
 *    idade do quadro no recibo. Quadro que não pulsa vira AVISO em letras
 *    maiúsculas, jamais aprovação silenciosa.
 *
 * 3. **PENDURA SE RECUSA NA HORA.** Com a view fora da árvore (`removeChildView`)
 *    ou a janela escondida, a captura **PENDURA por 5-8 s** (medido em P5) e o
 *    agente perde a rodada. Aqui ela corre contra um relógio curto e a recusa
 *    nomeia a receita — beco sem saída é bug.
 *
 * E a lei que veio da pesquisa de mercado: **o codex descarta imagem de MCP**
 * (`openai/codex#10334`). Então o produto desta tool é o CAMINHO EM TEXTO — que
 * o chat do dono renderiza (R36) — e a imagem inline só entra no `content[]`
 * quando o CLI do pane é o claude E a finalidade visual foi explícita.
 * Artefatos para o dono não adicionam imagem ao contexto do modelo.
 * Nenhuma tool emite `structuredContent`.
 *
 * O módulo não importa `electron`: fala com interfaces estruturais que o
 * `WebContents`/`NativeImage` reais satisfazem sem cast.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ———————————————————————————— contratos estruturais ————————————————————————

export interface NativeImageLike {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: string }): NativeImageLike
  toJPEG(quality: number): Buffer
  toPNG(): Buffer
}

export interface ShotCapturer {
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImageLike>
}

export interface ShotFreshness {
  frames: number
  ms: number
  pulsing: boolean
}

export interface BrowserShotRequest {
  /** Raiz da conversa (worktree da missão): o arquivo nasce DENTRO dela. */
  root: string
  missionId: string
  /** Nome legível que vira o slug do arquivo; sem ele, o título da página. */
  name?: string
  title?: string
  url?: string
  format?: 'jpeg' | 'png'
  quality?: number
  maxWidth?: number
  clip?: { x: number; y: number; width: number; height: number }
  /** De onde veio o recorte (um ref), só para o recibo. */
  clipLabel?: string
  /** Emitir a imagem inline no `content[]` (só quando o CLI do pane é claude). */
  inline?: boolean
  freshness: ShotFreshness
}

export interface BrowserShotResult {
  text: string
  /** Explicit outcome for local check runners; never infer success from prose. */
  ok?: boolean
  artifact?: { path: string; width: number; height: number; bytes: number; fresh: boolean }
  /** Preenchido só quando `inline` E o arquivo coube no teto. */
  image?: { data: string; mimeType: string }
}

/** Teto de largura do arquivo. Acima disso o custo sobe e a informação não. */
export const BROWSER_SHOT_MAX_WIDTH = 1_200
/** JPEG q70 é o default do design: barato, e para o dono OLHAR é suficiente. */
export const BROWSER_SHOT_DEFAULT_QUALITY = 70
/** Teto do que atravessa como base64 no `content[]` do claude. Acima disso o
 *  caminho continua valendo — a imagem é que fica de fora, dito no recibo. */
export const BROWSER_SHOT_INLINE_MAX_BYTES = 1_500_000
/** A captura NUNCA espera mais que isto: acima é pendura de view detached. */
export const BROWSER_SHOT_CAPTURE_TIMEOUT_MS = 2_000
/** Onde os arquivos moram, relativo à raiz da conversa. */
export const BROWSER_SHOT_DIR = '.synkora/browser'

/** A receita de toda recusa de captura. Um lugar só. */
export const BROWSER_SHOT_PANE_RECIPE =
  'Receita: confira se o painel BROWSER desta missão está aberto no dock. Se já estiver, continue com browser_read e browser_probe e informe que a captura de pixels está indisponível.'

// ————————————————————————————— nome do arquivo —————————————————————————————

export function slugify(input: string): string {
  const clean = input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return (clean || 'tela').slice(0, 40).replace(/-+$/g, '') || 'tela'
}

/**
 * O próximo número da missão sai do DISCO, não da memória: o app reinicia, o
 * chat reabre, e a sequência tem de continuar de onde parou — dois arquivos
 * `001-` na mesma pasta perderiam a ordem da investigação.
 */
export function nextShotSeq(dir: string, list: (path: string) => string[] = readdirSync): number {
  let max = 0
  try {
    for (const name of list(dir)) {
      const match = /^(\d{1,4})-/.exec(name)
      if (match) max = Math.max(max, Number.parseInt(match[1]!, 10))
    }
  } catch {
    // pasta ainda não existe: a primeira captura é a 001
  }
  return max + 1
}

export function shotFileName(seq: number, slug: string, format: 'jpeg' | 'png'): string {
  return `${String(seq).padStart(3, '0')}-${slug}.${format === 'png' ? 'png' : 'jpg'}`
}

/** O carimbo da lei 2, em uma linha (ou três, quando é aviso). */
export function freshnessStamp(freshness: ShotFreshness): string {
  if (freshness.pulsing) {
    return `quadro FRESCO (${freshness.frames} rAF em ${freshness.ms}ms — o compositor está pulsando)`
  }
  return `AVISO DE FRESCOR: o compositor NÃO pulsou (${freshness.frames} quadro(s) em ${freshness.ms}ms). O painel pode estar oculto e este pixel pode ser um quadro VELHO — NÃO aprove a tela por esta imagem. ${BROWSER_SHOT_PANE_RECIPE}`
}

// ————————————————————————————— a captura —————————————————————————————

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Captura, grava e devolve o TEXTO (caminho relativo + medidas + carimbo).
 * A imagem só volta inline quando o chamador pediu análise visual no claude.
 */
export async function captureBrowserShot(
  capturer: ShotCapturer,
  request: BrowserShotRequest,
  io: {
    ensureDir?: (dir: string) => void
    write?: (file: string, data: Buffer) => void
    list?: (dir: string) => string[]
  } = {}
): Promise<BrowserShotResult> {
  const ensureDir =
    io.ensureDir ??
    ((dir: string): void => {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    })
  const write = io.write ?? ((file: string, data: Buffer): void => writeFileSync(file, data))
  const list = io.list ?? readdirSync

  const captured = await withTimeout(
    capturer.capturePage(request.clip),
    BROWSER_SHOT_CAPTURE_TIMEOUT_MS
  )
  if (captured === 'timeout') {
    return {
      ok: false,
      text: `a captura PENDUROU (mais de ${BROWSER_SHOT_CAPTURE_TIMEOUT_MS}ms sem retorno). Não foi possível obter pixels no prazo. NADA foi gravado. ${BROWSER_SHOT_PANE_RECIPE}`
    }
  }
  if (captured.isEmpty()) {
    return {
      ok: false,
      text: `a captura voltou VAZIA. O compositor não entregou pixels. NADA foi gravado. ${BROWSER_SHOT_PANE_RECIPE}`
    }
  }

  const original = captured.getSize()
  const maxWidth = Math.min(request.maxWidth ?? BROWSER_SHOT_MAX_WIDTH, BROWSER_SHOT_MAX_WIDTH)
  const image = original.width > maxWidth ? captured.resize({ width: maxWidth }) : captured
  const size = image.getSize()
  const format = request.format === 'png' ? 'png' : 'jpeg'
  const quality = Math.min(Math.max(request.quality ?? BROWSER_SHOT_DEFAULT_QUALITY, 20), 100)
  const bytes = format === 'png' ? image.toPNG() : image.toJPEG(quality)

  const dir = join(request.root, ...BROWSER_SHOT_DIR.split('/'), request.missionId)
  ensureDir(dir)
  const seq = nextShotSeq(dir, list)
  const slug = slugify(request.name ?? request.title ?? 'tela')
  const file = shotFileName(seq, slug, format)
  write(join(dir, file), bytes)
  const relative = `${BROWSER_SHOT_DIR}/${request.missionId}/${file}`

  const lines = [
    `${relative} — ${size.width}x${size.height}px, ${format.toUpperCase()}${
      format === 'jpeg' ? ` q${quality}` : ''
    }, ${Math.round(bytes.byteLength / 1024)} KB`,
    request.clip
      ? `recorte: ${request.clipLabel ?? `${request.clip.width}x${request.clip.height} em (${request.clip.x}, ${request.clip.y})`}`
      : `página inteira da viewport${
          original.width > maxWidth ? ` (reduzida de ${original.width}px para caber no teto de ${maxWidth}px)` : ''
        }`,
    request.url ? `url: ${request.url}` : '',
    freshnessStamp(request.freshness),
    'CITE ESTE CAMINHO no chat para o dono ver a imagem — ele renderiza no fio da conversa.'
  ].filter(Boolean)

  const result: BrowserShotResult = {
    ok: true,
    text: lines.join('\n'),
    artifact: { path: relative, width: size.width, height: size.height, bytes: bytes.byteLength, fresh: request.freshness.pulsing }
  }
  if (request.inline) {
    if (bytes.byteLength <= BROWSER_SHOT_INLINE_MAX_BYTES) {
      result.image = {
        data: bytes.toString('base64'),
        mimeType: format === 'png' ? 'image/png' : 'image/jpeg'
      }
    } else {
      result.text += `\n(a imagem não veio inline: ${Math.round(bytes.byteLength / 1024)} KB passa do teto de ${Math.round(
        BROWSER_SHOT_INLINE_MAX_BYTES / 1024
      )} KB — abra pelo caminho, ou repita com maxWidth menor)`
    }
  }
  return result
}
