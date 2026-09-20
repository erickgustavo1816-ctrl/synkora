#!/usr/bin/env node
/**
 * Gerador do ícone do Synkora — ZERO dependências.
 *
 * O repositório não tem (e não vai ter) biblioteca de imagem: sharp, jimp e
 * companhia trazem binário nativo. Então tudo aqui é feito na mão, com o que
 * o Node já oferece: `zlib` para o DEFLATE do PNG e aritmética pura para
 * rasterizar as formas.
 *
 * O DESENHO é a marca do app — a MESMA do titlebar (`SynkoraMark` em
 * src/renderer/src/components/TitleBar.tsx): a estrela de quatro pontas dentro
 * do anel do universo. Aqui ela vai sobre o painel escuro, com a estrela em
 * laranja de acento.
 *
 * Saídas:
 *   build/icon.ico  — 16, 24, 32, 48, 64, 128 e 256px (cada entrada é um PNG)
 *   build/icon.png  — 256px, para plataformas que não usam .ico
 *   build/icon-mac.png — 1024px, modo --mac-only (geometria original)
 *
 * Uso: `node scripts/make-icon.mjs`
 * Mac: `node scripts/make-icon.mjs --mac-only` (não altera os ícones Windows)
 */

import { deflateSync, inflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]

// Preview para inspeção humana (não entra no app).
const PREVIEW_DIR =
  'C:/Users/Erick/AppData/Local/Temp/claude/C--Users-Erick-Desktop-Synkora/3aa159d0-13d3-4302-b627-aa3d133e4da0/scratchpad'

/* ────────────────────────── PALETA E GEOMETRIA ─────────────────────────── */

// Paleta "papel & painel" (:root em src/renderer/src/global.css).
const PANEL = [0x26, 0x24, 0x1f] // --panel: fundo quente escuro
const PANEL_2 = [0x2e, 0x2b, 0x25] // --panel-2: brilho central opcional
const ACCENT = [0xd9, 0x6c, 0x3f] // --accent: a estrela
const PAPER = [0xef, 0xe9, 0xdc] // --paper: o anel, esmaecido

// Geometria idêntica à do <SynkoraMark>, num viewBox de 24x24. Os dois
// elementos são centrados exatamente em (12,12), então centro geométrico ==
// centro óptico e não há nada a compensar.
const CX = 12
const CY = 12
const ORBIT_RX = 10.5
const ORBIT_RY = 5.2
const ORBIT_ROT = (-28 * Math.PI) / 180
const ORBIT_STROKE = 1.1
// O ANEL É LARANJA, não papel. No <SynkoraMark> ele é `stroke="currentColor"`
// com opacity 0.55, e quem pinta é o contexto (`.tb-brand { color: accent }`) —
// ou seja, na tela do app o anel é o MESMO laranja da estrela, esmaecido.
// Pintá-lo de papel dava um anel cinza: um ícone que não é a marca do app.
const ORBIT_COLOR = 'accent'
const ORBIT_ALPHA = 0.55

const COS = Math.cos(ORBIT_ROT)
const SIN = Math.sin(ORBIT_ROT)

// Os quatro cubics do atributo `d` da estrela, já convertidos de relativo para
// absoluto e com o `transform="translate(0 2.2)"` embutido nas coordenadas.
// Cada item é [x0,y0, c1x,c1y, c2x,c2y, x1,y1]. A forma é o quadrilátero
// CÔNCAVO: cúspides em N/L/S/O e a silhueta pinçando para dentro entre elas.
const STAR_CURVES = [
  [12, 5.4, 12.55, 9.6, 13.9, 11.45, 18.1, 12],
  [18.1, 12, 13.9, 12.55, 12.55, 14.4, 12, 18.6],
  [12, 18.6, 11.45, 14.4, 10.1, 12.55, 5.9, 12],
  [5.9, 12, 10.1, 11.45, 11.45, 9.6, 12, 5.4]
]
// Meias-extensões da estrela: as cúspides ficam a 6,1 na horizontal e 6,6 na
// vertical do centro (a marca original é um tico mais alta que larga).
const STAR_HALF_H = 6.6

// Meia-largura da bounding box do ANEL (com metade do traço). Para uma elipse
// girada, a projeção do semi-eixo em cada eixo do canvas é
// sqrt(a²cos²θ + b²sin²θ).
const ORBIT_HALF_W =
  Math.sqrt(ORBIT_RX * ORBIT_RX * COS * COS + ORBIT_RY * ORBIT_RY * SIN * SIN) + ORBIT_STROKE / 2

/**
 * ESCALA DA MARCA — e a tensão que ela resolve.
 *
 * O pedido era "bbox da estrela ocupando 62-66% do lado" E "a composição não
 * encosta na borda". As duas coisas não cabem juntas: o anel é 1,54× a altura
 * da bbox da estrela (20,27 contra 13,2 unidades de viewBox), então estrela a
 * 64% joga o anel para 98,3% do lado — 0,85% de margem, ou seja, encostando.
 * Mandou a composição: a estrela fica em 58% e o anel sobra com ~5,5% de
 * folga de cada lado.
 */
const STAR_SPAN = 0.58 // fração do lado ocupada pela ALTURA da bbox da estrela
const CORNER_RADIUS = 0.22 // raio do quadrado arredondado

/**
 * QUANTO DO LADO O DESENHO OCUPA (o viewBox de 24 unidades vezes isto).
 *
 * Em 1.0 o anel encosta em 84,5% do lado — a proporção do SVG solto, mas NÃO
 * como a marca aparece no app: lá ela sempre tem respiro em volta (no rail, um
 * SVG de 22px dentro de um botão de 46px). Um ícone é uma moldura, e a marca
 * precisa da mesma folga que tem na tela.
 *
 * 0,72 (⇒ anel a 61% do lado) foi ESCOLHIDO PELO USUÁRIO comparando quatro
 * variantes renderizadas a 96px lado a lado — não estimado. Ajustável por env
 * (SYNKORA_MARK_SCALE) para refazer essa comparação sem editar o arquivo.
 */
const MARK_SCALE = Number(process.env.SYNKORA_MARK_SCALE ?? 0.72)
// Brilho central: DESLIGADO. Testado a 256px sobre o painel — em #26241f a
// diferença até --panel-2 são 8 níveis, que no escuro não lê como profundidade,
// lê como sujeira/banding em volta da estrela. O fundo chapado é mais limpo.
const VIGNETTE = false

/* ─────────────────────── RASTERIZAÇÃO (na unha) ────────────────────────── */

/** Ponto dentro do quadrado arredondado que cobre o ícone inteiro. */
function insideRoundRect(x, y, size, r) {
  // O retângulo arredondado é o conjunto de pontos a até `r` do retângulo
  // interno [r, size-r]²: basta grampear o ponto nesse retângulo e medir.
  const qx = x < r ? r : x > size - r ? size - r : x
  const qy = y < r ? r : y > size - r ? size - r : y
  const dx = x - qx
  const dy = y - qy
  return dx * dx + dy * dy <= r * r
}

/**
 * Distância APROXIMADA (com sinal) de um ponto até a elipse girada, em pixels.
 * Distância exata a uma elipse é iterativa e cara; a aproximação clássica
 * normaliza a função implícita pelo próprio gradiente:
 *   d ≈ (F(p) − 1) / |∇F(p)|,  F = (u/rx)² + (v/ry)²
 * O erro cresce com a curvatura, mas aqui o menor raio de curvatura é
 * ry²/rx = 2,58 unidades contra meia-espessura de traço de 0,55 — o desvio
 * fica em fração de pixel, e o supersampling ainda o dilui.
 */
function ringDistance(dx, dy, rx, ry) {
  // Desfaz a rotação da elipse.
  const u = dx * COS + dy * SIN
  const v = -dx * SIN + dy * COS
  const f = (u * u) / (rx * rx) + (v * v) / (ry * ry)
  const gx = (2 * u) / (rx * rx)
  const gy = (2 * v) / (ry * ry)
  const g = Math.sqrt(gx * gx + gy * gy)
  if (g < 1e-9) return -Infinity // centro exato: longe do traço, por dentro
  return (f - 1) / g
}

/** Achata os cubics da estrela num polígono, já em pixels do dispositivo. */
function flattenStar(size, k) {
  const half = size / 2
  const pts = []
  // 96 segmentos por curva: bem acima do necessário, mas o custo é irrelevante
  // (o polígono é resolvido uma vez por LINHA de amostragem, não por amostra) e
  // garante que as cúspides não achatem nem no preview de 512px.
  const STEPS = 96
  for (const [x0, y0, c1x, c1y, c2x, c2y, x1, y1] of STAR_CURVES) {
    for (let i = 0; i < STEPS; i++) {
      const t = i / STEPS
      const m = 1 - t
      const a = m * m * m
      const b = 3 * m * m * t
      const c = 3 * m * t * t
      const d = t * t * t
      const ux = a * x0 + b * c1x + c * c2x + d * x1
      const uy = a * y0 + b * c1y + c * c2y + d * y1
      pts.push((ux - CX) * k + half, (uy - CY) * k + half)
    }
  }
  return Float64Array.from(pts)
}

/**
 * Cruzamentos do polígono com a linha horizontal `y`, ordenados. É o algoritmo
 * de scanline de sempre: em vez de testar ponto-em-polígono para cada amostra
 * (centenas de arestas × milhões de amostras), resolvemos as arestas UMA vez
 * por linha de amostragem e depois cada amostra é só uma contagem de paridade
 * (par-ímpar — o contorno da estrela é simples, então even-odd == nonzero).
 */
function scanCrossings(poly, y, out) {
  out.length = 0
  const n = poly.length / 2
  let jx = poly[(n - 1) * 2]
  let jy = poly[(n - 1) * 2 + 1]
  for (let i = 0; i < n; i++) {
    const ix = poly[i * 2]
    const iy = poly[i * 2 + 1]
    if (iy <= y !== jy <= y) out.push(ix + ((y - iy) / (jy - iy)) * (jx - ix))
    jx = ix
    jy = iy
  }
  out.sort((a, b) => a - b)
  return out
}

/** Interpolação suave (smoothstep) para o brilho central. */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/**
 * Desenha o ícone num buffer RGBA (não pré-multiplicado, 8 bits por canal).
 * Devolve também a lista de elementos efetivamente desenhados no tamanho.
 *
 * SUPERSAMPLING: não existe rasterizador aqui, então o antialiasing é força
 * bruta — cada pixel é resolvido em SSxSS amostras BINÁRIAS (dentro/fora de
 * cada forma), compositadas em alfa PRÉ-MULTIPLICADO e só no fim promediadas.
 * É o que salva a borda da elipse e as cúspides finas da estrela do
 * serrilhado; sem isso, no 16px o anel viraria uma escada. Ícone pequeno paga
 * MAIS amostras de propósito: é onde um pixel decide a legibilidade.
 */
function renderIcon(size) {
  const SS = size <= 64 ? 8 : 6
  const samples = SS * SS
  const parts = ['painel', 'estrela']

  const radius = size * CORNER_RADIUS
  const cx = size / 2
  const cy = size / 2

  // HINTING ÓPTICO no 16px. Cada tamanho é rasterizado do zero, então o menor
  // pode ter proporções próprias — e precisa: a estrela é uma forma CÔNCAVA, e
  // concavidade é a primeira coisa que morre quando a figura encolhe. Na
  // escala nominal as pontas ficam com ~1px e a silhueta pinçada some: vira um
  // sinal de mais borrado, com o anel cortando por cima. Comparei seis
  // variantes a 16px (olhando os pixels ampliados, não deduzindo) e o que
  // salva é:
  //  · a ESTRELA cresce para 72% do lado;
  //  · o anel CLAREIA (0,40 → 0,45): no escuro, anel mais brilhante lê como
  //    elemento próprio; esmaecê-lo só produzia um cinza médio indeciso;
  //  · e, principalmente, um HALO — o anel é apagado numa faixa de 1,2px em
  //    volta da estrela. Sem isso o traço encosta nas cúspides e as duas
  //    formas viram uma mancha só. O halo é feito com a PRÓPRIA estrela
  //    escalada a partir do centro (dilatação barata: a expansão é máxima
  //    justo nas pontas, que é onde o anel cruza).
  // MARCA ÚNICA EM TODO TAMANHO (decisão do usuário, 2026-07-28). Houve duas
  // tentativas de tratar o 16px como caso especial — estrela maior com halo, e
  // depois sem anel nenhum — e as duas foram recusadas: a marca é a estrela
  // DENTRO do anel, e um ícone que muda de composição conforme o tamanho é
  // outra marca. Fica a mesma proporção em toda a família; o que o 16px ganha
  // é apenas o piso de 1px no traço, para o anel não desaparecer na
  // rasterização (isso é fidelidade, não simplificação).
  const drawOrbit = true
  const haloPx = 0
  // ESCALA = O VIEWBOX INTEIRO NO LADO DO ÍCONE, e nada mais.
  //
  // Antes a escala saía de "a estrela deve ocupar X% do lado", o que inflava a
  // marca: com STAR_SPAN 0,58 o anel ia a 89,1% do lado, contra os 84,5% que
  // ele ocupa no <SynkoraMark>. O usuário viu a diferença na tela ("você está
  // deixando a estrela e a órbita maior") — e ele está certo, eram ~5%.
  //
  // O SVG já resolve isso sozinho: o viewBox de 24 unidades É a caixa, e a
  // marca ocupa a fração dela que o desenho define (estrela 55%, anel 84,5%).
  // Mapear 24 unidades no lado do ícone reproduz a proporção EXATA do app —
  // que é o que "o mesmo ícone" quer dizer.
  const starK = (size / 24) * MARK_SCALE
  const orbitK = starK
  const rx = ORBIT_RX * orbitK
  const ry = ORBIT_RY * orbitK
  // Piso de 1px no traço: a 16px o traço nominal dá 0,77px e o anel some.
  const strokeHalf = Math.max(ORBIT_STROKE * orbitK, 1) / 2
  const orbitAlpha = ORBIT_ALPHA

  const vignette = VIGNETTE && size >= 64
  if (drawOrbit) parts.push('anel')
  if (vignette) parts.push('brilho central')
  if (haloPx > 0) parts.push('halo do anel')

  const star = flattenStar(size, starK)
  const halo = null // sem halo: ver a nota sobre a composição única
  const acc = new Float64Array(size * size * 4)
  const crossings = []
  const haloCrossings = []
  const maxDist = Math.hypot(cx, cy)

  const rows = size * SS
  for (let sy = 0; sy < rows; sy++) {
    const y = (sy + 0.5) / SS
    scanCrossings(star, y, crossings)
    if (halo) scanCrossings(halo, y, haloCrossings)
    const rowBase = ((sy / SS) | 0) * size * 4
    const dy = y - cy
    for (let sx = 0; sx < rows; sx++) {
      const x = (sx + 0.5) / SS
      if (!insideRoundRect(x, y, size, radius)) continue // fora = transparente
      const dx = x - cx

      // 1. Painel escuro, com um brilho central opcional.
      let r = PANEL[0]
      let g = PANEL[1]
      let b = PANEL[2]
      if (vignette) {
        const t = 1 - smoothstep(0, 0.85, Math.hypot(dx, dy) / maxDist)
        r += (PANEL_2[0] - PANEL[0]) * t
        g += (PANEL_2[1] - PANEL[1]) * t
        b += (PANEL_2[2] - PANEL[2]) * t
      }

      // 2. Anel: papel esmaecido (source-over com alfa pré-multiplicado).
      const d = drawOrbit ? ringDistance(dx, dy, rx, ry) : Infinity
      if (d > -strokeHalf && d < strokeHalf) {
        const ink = ORBIT_COLOR === 'accent' ? ACCENT : PAPER
        r = ink[0] * orbitAlpha + r * (1 - orbitAlpha)
        g = ink[1] * orbitAlpha + g * (1 - orbitAlpha)
        b = ink[2] * orbitAlpha + b * (1 - orbitAlpha)
      }

      // 3. Halo: devolve o painel numa faixa em volta da estrela, para o traço
      //    do anel não encostar nas cúspides (só no 16px).
      if (halo) {
        let n = 0
        for (let i = 0; i < haloCrossings.length; i++) if (haloCrossings[i] < x) n++
        if (n & 1) {
          r = PANEL[0]
          g = PANEL[1]
          b = PANEL[2]
        }
      }

      // 4. Estrela: laranja sólido por cima de tudo (paridade dos cruzamentos).
      let hits = 0
      for (let i = 0; i < crossings.length; i++) if (crossings[i] < x) hits++
      if (hits & 1) {
        r = ACCENT[0]
        g = ACCENT[1]
        b = ACCENT[2]
      }

      const o = rowBase + ((sx / SS) | 0) * 4
      // Alfa da amostra é sempre 1 aqui (fora da moldura já saímos no continue),
      // então o pré-multiplicado é a própria cor.
      acc[o] += r
      acc[o + 1] += g
      acc[o + 2] += b
      acc[o + 3] += 1
    }
  }

  const px = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    const o = i * 4
    const al = acc[o + 3] / samples
    if (al <= 0) continue
    // Desfaz a pré-multiplicação: a média das amostras está em premultiplied.
    px[o] = Math.round(Math.min(255, acc[o] / samples / al))
    px[o + 1] = Math.round(Math.min(255, acc[o + 1] / samples / al))
    px[o + 2] = Math.round(Math.min(255, acc[o + 2] / samples / al))
    px[o + 3] = Math.round(al * 255)
  }
  return { px, parts }
}

/* ───────────────────────────── PNG na mão ──────────────────────────────── */

// CRC-32 (polinômio 0xEDB88320) — todo chunk PNG termina com ele, calculado
// sobre TIPO + DADOS (o campo de tamanho fica de fora).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Chunk PNG: tamanho(4 BE) + tipo(4 ASCII) + dados + CRC(4 BE). */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

/**
 * Monta um PNG RGBA de 8 bits: assinatura + IHDR + IDAT + IEND.
 * O IDAT é um fluxo zlib (RFC1950 — exatamente o que `deflateSync` produz) das
 * scanlines cruas, cada uma precedida de um byte de FILTRO. Usamos filtro 0
 * (None) em todas: o desenho é quase todo cor chapada, então o DEFLATE já
 * resolve, e o encoder fica trivial de auditar.
 */
function encodePng(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc(size * (stride + 1))
  for (let y = 0; y < size; y++) {
    const o = y * (stride + 1)
    raw[o] = 0 // filtro None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, o + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 6 // tipo de cor 6 = RGBA
  ihdr[10] = 0 // compressão (sempre 0 = deflate)
  ihdr[11] = 0 // método de filtro (sempre 0)
  ihdr[12] = 0 // sem entrelaçamento
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* ───────────────────────────── ICO na mão ──────────────────────────────── */

/**
 * Empacota vários PNGs num .ico.
 *
 * Layout: ICONDIR de 6 bytes (reservado=0, tipo=1, quantidade) seguido de uma
 * ICONDIRENTRY de 16 bytes por imagem e, depois de todas as entradas, os blobs
 * na mesma ordem. Cada entrada guarda TAMANHO e OFFSET absoluto do seu blob.
 * Desde o Vista o blob pode ser um arquivo PNG inteiro em vez de um DIB — é o
 * caminho mais simples e o único que cabe no 256px sem inchar o arquivo.
 * Detalhe do formato: largura/altura são de 1 byte, então 256 é gravado como 0.
 * Tudo em little-endian (o ICO é formato da Microsoft; o PNG é big-endian).
 */
function encodeIco(images) {
  const head = Buffer.alloc(6 + images.length * 16)
  head.writeUInt16LE(0, 0) // reservado
  head.writeUInt16LE(1, 2) // 1 = ícone (2 seria cursor)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach((img, i) => {
    const e = 6 + i * 16
    head[e] = img.size >= 256 ? 0 : img.size // largura (0 == 256)
    head[e + 1] = img.size >= 256 ? 0 : img.size // altura  (0 == 256)
    head[e + 2] = 0 // cores da paleta (0 = sem paleta)
    head[e + 3] = 0 // reservado
    head.writeUInt16LE(1, e + 4) // planos de cor
    head.writeUInt16LE(32, e + 6) // bits por pixel
    head.writeUInt32LE(img.png.length, e + 8) // tamanho do blob
    head.writeUInt32LE(offset, e + 12) // offset do blob no arquivo
    offset += img.png.length
  })
  return Buffer.concat([head, ...images.map((i) => i.png)])
}

/* ─────────────────────── Autoverificação da saída ──────────────────────── */

/** Reabre o PNG que acabamos de escrever e devolve os pixels RGBA. */
function decodePng(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('assinatura PNG inválida')
  let p = 8
  let width = 0
  let height = 0
  const idat = []
  while (p < buf.length) {
    const len = buf.readUInt32BE(p)
    const type = buf.toString('ascii', p + 4, p + 8)
    const data = buf.subarray(p + 8, p + 8 + len)
    const crc = buf.readUInt32BE(p + 8 + len)
    if (crc !== crc32(buf.subarray(p + 4, p + 8 + len))) throw new Error(`CRC quebrado em ${type}`)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6) throw new Error('esperado RGBA 8 bits')
    } else if (type === 'IDAT') idat.push(data)
    p += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const px = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1)
    if (raw[o] !== 0) throw new Error(`filtro ${raw[o]} inesperado na linha ${y}`)
    raw.copy(px, y * stride, o + 1, o + 1 + stride)
  }
  return { width, height, px }
}

function pixelAt(img, x, y) {
  const o = (y * img.width + x) * 4
  return [img.px[o], img.px[o + 1], img.px[o + 2], img.px[o + 3]]
}

const dist2 = (p, c) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2

/**
 * Fração da moldura ocupada pela ESTRELA. Classifica cada pixel opaco pela cor
 * mais próxima entre painel / anel / acento e conta os de acento — proxy
 * barato de "a estrela ainda tem massa suficiente para ser vista".
 */
function accentCoverage(img, ringAlpha) {
  const ring = PANEL.map((c, i) => c * (1 - ringAlpha) + PAPER[i] * ringAlpha)
  let hit = 0
  let total = 0
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const p = pixelAt(img, x, y)
      if (p[3] < 128) continue
      total++
      const da = dist2(p, ACCENT)
      if (da < dist2(p, PANEL) && da < dist2(p, ring)) hit++
    }
  }
  return hit / total
}

/** Amplia por replicação de pixel (nearest-neighbour) — sem suavizar nada. */
function upscaleNearest(img, factor) {
  const w = img.width * factor
  const px = new Uint8Array(w * w * 4)
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const s = (((y / factor) | 0) * img.width + ((x / factor) | 0)) * 4
      const d = (y * w + x) * 4
      px[d] = img.px[s]
      px[d + 1] = img.px[s + 1]
      px[d + 2] = img.px[s + 2]
      px[d + 3] = img.px[s + 3]
    }
  }
  return { size: w, px }
}

function assert(ok, label, detail) {
  console.log(`  ${ok ? 'ok   ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

/* ──────────────────────────────── main ─────────────────────────────────── */

mkdirSync(OUT_DIR, { recursive: true })

if (process.argv.includes('--mac-only')) {
  const png = encodePng(1024, renderIcon(1024).px)
  writeFileSync(join(OUT_DIR, 'icon-mac.png'), png)
  console.log(`build/icon-mac.png  ${png.length} bytes (1024px, geometria original)`)
  process.exit(0)
}

const images = SIZES.map((size) => {
  const { px, parts } = renderIcon(size)
  return { size, parts, png: encodePng(size, px) }
})

const ico = encodeIco(images)
const icoPath = join(OUT_DIR, 'icon.ico')
const pngPath = join(OUT_DIR, 'icon.png')
const png256 = images[images.length - 1].png
writeFileSync(icoPath, ico)
writeFileSync(pngPath, png256)

// Proporções efetivas da composição, para o relatório não depender de memória.
const orbitSpan = (2 * ORBIT_HALF_W) / 24
console.log('elementos desenhados por tamanho:')
for (const { size, parts, png } of images) {
  console.log(
    `  ${String(size).padStart(3)}px  ${String(png.length).padStart(6)}B  ${parts.join(' · ')}`
  )
}
console.log(
  `
  bbox da estrela = ${(((2 * STAR_HALF_H) / 24) * 100).toFixed(1)}% do lado · ` +
    `anel = ${(orbitSpan * 100).toFixed(1)}% do lado, ` +
    `margem ${(((1 - orbitSpan) / 2) * 100).toFixed(1)}% de cada lado`
)
console.log(`  build/icon.ico  ${ico.length} bytes · ${images.length} entradas`)
console.log(`  build/icon.png  ${png256.length} bytes (256px)`)

console.log('\nverificação do .ico:')
assert(ico.readUInt16LE(0) === 0, 'campo reservado = 0', `0x${ico.readUInt16LE(0).toString(16)}`)
assert(ico.readUInt16LE(2) === 1, 'tipo = 1 (ícone)', String(ico.readUInt16LE(2)))
assert(
  ico.readUInt16LE(4) === SIZES.length,
  `quantidade = ${SIZES.length}`,
  String(ico.readUInt16LE(4))
)
let entriesOk = true
for (let i = 0; i < SIZES.length; i++) {
  const e = 6 + i * 16
  const w = ico[e] === 0 ? 256 : ico[e]
  const len = ico.readUInt32LE(e + 8)
  const off = ico.readUInt32LE(e + 12)
  const inside = off >= 6 + SIZES.length * 16 && off + len <= ico.length
  const isPng = ico.readUInt32BE(off) === 0x89504e47
  const declared = w === SIZES[i] && ico.readUInt16LE(e + 6) === 32
  entriesOk = entriesOk && inside && isPng && declared
  console.log(
    `  [${i}] ${String(w).padStart(3)}px  offset ${String(off).padStart(6)}  len ${String(len).padStart(6)}` +
      `  fim ${String(off + len).padStart(6)}/${ico.length}  ${inside ? 'dentro' : 'FORA DO ARQUIVO'}` +
      `  ${isPng ? 'PNG' : 'NÃO-PNG'}  ${ico.readUInt16LE(e + 6)}bpp`
  )
}
assert(entriesOk, 'toda entrada aponta para um PNG inteiramente dentro do arquivo')
const lastEntry = 6 + (SIZES.length - 1) * 16
assert(
  ico.readUInt32LE(lastEntry + 8) + ico.readUInt32LE(lastEntry + 12) === ico.length,
  'última entrada termina exatamente no fim do arquivo',
  `${ico.readUInt32LE(lastEntry + 8) + ico.readUInt32LE(lastEntry + 12)} == ${ico.length}`
)

console.log('\nverificação do PNG 256 (decodificado de volta com inflateSync):')
const back = decodePng(png256)
assert(back.width === 256 && back.height === 256, 'dimensões 256x256', `${back.width}x${back.height}`)
const center = pixelAt(back, 128, 128)
assert(
  center[0] === ACCENT[0] && center[1] === ACCENT[1] && center[2] === ACCENT[2] && center[3] === 255,
  'centro (miolo da estrela) = laranja de acento #d96c3f',
  `rgba(${center.join(', ')})`
)
// Canto DENTRO da curva do quadrado arredondado (o pixel 0,0 é transparente
// por construção: a moldura é um quadrado ARREDONDADO).
const corner = pixelAt(back, Math.round(256 * 0.08), Math.round(256 * 0.08))
assert(
  corner[0] === PANEL[0] && corner[1] === PANEL[1] && corner[2] === PANEL[2] && corner[3] === 255,
  'canto = painel escuro #26241f, opaco',
  `rgba(${corner.join(', ')}) em (20,20)`
)

console.log('\nverificação do 16px (o tamanho que decide tudo):')
const small = decodePng(images[0].png)
const cov = accentCoverage(small, 0.34)
assert(cov >= 0.08, 'estrela ocupa ao menos 8% da moldura (tem massa para ler)', `${(cov * 100).toFixed(1)}%`)
const smallCenter = pixelAt(small, 8, 8)
assert(
  smallCenter[0] === ACCENT[0] && smallCenter[3] === 255,
  'miolo continua laranja sólido a 16px',
  `rgba(${smallCenter.join(', ')})`
)
const smallCorner = pixelAt(small, 2, 2)
assert(
  smallCorner[3] === 255 && smallCorner[0] === PANEL[0],
  'canto a 16px = painel puro',
  `rgba(${smallCorner.join(', ')})`
)

/* ── Previews para inspeção humana (fora do app) ─────────────────────────── */

mkdirSync(PREVIEW_DIR, { recursive: true })
const preview512 = join(PREVIEW_DIR, 'icon-preview.png')
const preview16 = join(PREVIEW_DIR, 'icon-preview-16.png')
writeFileSync(preview512, encodePng(512, renderIcon(512).px))
const up = upscaleNearest(small, 8) // 16px ampliado 8x, sem suavização
writeFileSync(preview16, encodePng(up.size, up.px))
console.log(`\npreviews:\n  ${preview512}\n  ${preview16} (16px × 8, nearest-neighbour)`)
