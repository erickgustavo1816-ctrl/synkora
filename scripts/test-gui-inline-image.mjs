/**
 * R36.1 — O CANAL SEGURO DA IMAGEM CITADA NO CHAT.
 *
 * O caso do dono: o dev prometeu "demonstração visual", citou o arquivo, e a
 * imagem NUNCA apareceu — o CSP do renderer é `img-src 'self' data:`, então um
 * caminho de worktree quebra MUDO. A ponte é este módulo: bytes do disco viram
 * data URL no main, com o MIME saindo dos BYTES (nunca da extensão) e teto
 * herdado da régua dos anexos.
 *
 * A suíte roda o .ts compilado (o módulo importa `guiAttachments`, e importação
 * relativa sem extensão não resolve sob `--experimental-strip-types` — sondado
 * em 2026-08-23). O compilado sai plano em `.tmp/gui-inline-image-test/`.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  GUI_INLINE_IMAGE_MAX_BYTES,
  GUI_INLINE_IMAGE_RECIPE,
  guiInlineImageData,
  guiInlineImageRefusal
} from '../.tmp/gui-inline-image-test/guiInlineImageData.js'
import {
  GUI_ATTACHMENT_PREVIEW_MAX_BYTES,
  formatBytes
} from '../.tmp/gui-inline-image-test/guiAttachments.js'

// ————— bitmaps sintéticos: só CABEÇALHO, que é tudo o que o canal olha —————
// Nada aqui é decodificado: o contrato provado é o do sniff por assinatura.

function pngBytes(width = 8, height = 6) {
  const bytes = Buffer.alloc(24)
  bytes[0] = 0x89
  bytes.write('PNG\r\n\u001a\n', 1, 'latin1')
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return new Uint8Array(bytes)
}

function jpegBytes(width = 10, height = 4) {
  const bytes = Buffer.alloc(24)
  bytes[0] = 0xff
  bytes[1] = 0xd8
  bytes[2] = 0xff
  bytes[3] = 0xc0
  bytes.writeUInt16BE(17, 4)
  bytes[6] = 8
  bytes.writeUInt16BE(height, 7)
  bytes.writeUInt16BE(width, 9)
  return new Uint8Array(bytes)
}

function gifBytes(signature = 'GIF89a', width = 3, height = 5) {
  const bytes = Buffer.alloc(16)
  bytes.write(signature, 0, 'latin1')
  bytes.writeUInt16LE(width, 6)
  bytes.writeUInt16LE(height, 8)
  return new Uint8Array(bytes)
}

function webpBytes(width = 12, height = 9) {
  const bytes = Buffer.alloc(32)
  bytes.write('RIFF', 0, 'latin1')
  bytes.writeUInt32LE(24, 4)
  bytes.write('WEBP', 8, 'latin1')
  bytes.write('VP8X', 12, 'latin1')
  bytes.writeUInt32LE(10, 16)
  bytes.writeUIntLE(width - 1, 24, 3)
  bytes.writeUIntLE(height - 1, 27, 3)
  return new Uint8Array(bytes)
}

/** Disco de mentira: registra CADA leitura, para provar que o teto é pago
 *  antes de alocar o buffer. `size` pode divergir dos bytes de propósito. */
function fakeDisk(entries) {
  const reads = []
  const files = new Map(Object.entries(entries))
  return {
    reads,
    disk: {
      sizeOf(path) {
        const file = files.get(path)
        if (!file) throw new Error('ENOENT')
        return typeof file.size === 'number' ? file.size : file.bytes.length
      },
      read(path) {
        reads.push(path)
        const file = files.get(path)
        if (!file) throw new Error('ENOENT')
        if (file.unreadable) throw new Error('EBUSY')
        return file.bytes
      }
    }
  }
}

function decode(dataUrl) {
  const marker = ';base64,'
  const at = dataUrl.indexOf(marker)
  assert.notEqual(at, -1, 'a data URL precisa ser base64')
  return {
    mime: dataUrl.slice('data:'.length, at),
    bytes: new Uint8Array(Buffer.from(dataUrl.slice(at + marker.length), 'base64'))
  }
}

test('cada assinatura conhecida vira data URL com o MIME dos bytes e volta idêntica', () => {
  const cases = [
    ['C:/wt/demo.png', pngBytes(), 'image/png'],
    ['C:/wt/demo.jpg', jpegBytes(), 'image/jpeg'],
    ['C:/wt/velho.gif', gifBytes('GIF87a'), 'image/gif'],
    ['C:/wt/novo.gif', gifBytes('GIF89a'), 'image/gif'],
    ['C:/wt/demo.webp', webpBytes(), 'image/webp']
  ]
  for (const [path, bytes, mime] of cases) {
    const { disk } = fakeDisk({ [path]: { bytes } })
    const result = guiInlineImageData(path, { disk })
    assert.equal(result.ok, true, `${path} deveria ser aceito`)
    const decoded = decode(result.dataUrl)
    assert.equal(decoded.mime, mime)
    assert.deepEqual(decoded.bytes, bytes, 'a ida e volta em base64 tem de preservar os bytes')
  }
})

test('o MIME sai dos BYTES: extensão que mente não decide nada', () => {
  // Um .png que na verdade é SVG (texto) — a v1 não exibe SVG, e a extensão
  // não pode contrabandeá-lo para dentro do DOM do chat.
  const svg = new Uint8Array(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'))
  const mentiroso = fakeDisk({ 'C:/wt/mentiroso.png': { bytes: svg } })
  const recusa = guiInlineImageData('C:/wt/mentiroso.png', { disk: mentiroso.disk })
  assert.equal(recusa.ok, false)
  assert.match(recusa.error, /menu do arquivo/u, 'recusa sem receita é beco sem saída')

  // E o contrário: um .txt que é PNG de verdade é exibido do mesmo jeito.
  const honesto = fakeDisk({ 'C:/wt/print.txt': { bytes: pngBytes() } })
  const aceito = guiInlineImageData('C:/wt/print.txt', { disk: honesto.disk })
  assert.equal(aceito.ok, true)
  assert.match(aceito.dataUrl, /^data:image\/png;base64,/u)
})

test('bytes que não são bitmap conhecido recusam nomeando a receita', () => {
  const desconhecidos = {
    'C:/wt/doc.pdf': new Uint8Array(Buffer.from('%PDF-1.7\n%????\n', 'latin1')),
    'C:/wt/nada.bin': new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
    'C:/wt/vazio.png': new Uint8Array(0),
    // BMP e ICO existem no mundo, mas não entram na v1: a recusa é explícita.
    'C:/wt/icone.ico': new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10])
  }
  for (const [path, bytes] of Object.entries(desconhecidos)) {
    const { disk } = fakeDisk({ [path]: { bytes } })
    const result = guiInlineImageData(path, { disk })
    assert.equal(result.ok, false, `${path} não podia ser exibido`)
    assert.equal(result.dataUrl, undefined, 'recusa nunca carrega data URL')
    assert.match(result.error, /png/u, 'a recusa diz o que o chat exibe')
    assert.ok(result.error.includes(GUI_INLINE_IMAGE_RECIPE), 'a recusa nomeia a receita')
    assert.ok(!result.error.includes(path), 'a recusa não repete o caminho absoluto')
  }
})

test('acima do teto o canal recusa com o tamanho real, e sem alocar o buffer', () => {
  const grande = GUI_INLINE_IMAGE_MAX_BYTES + 1
  const { disk, reads } = fakeDisk({ 'C:/wt/enorme.png': { bytes: pngBytes(), size: grande } })
  const result = guiInlineImageData('C:/wt/enorme.png', { disk })
  assert.equal(result.ok, false)
  assert.ok(result.error.includes(formatBytes(grande)), 'o dono precisa ver o tamanho real')
  assert.ok(result.error.includes(formatBytes(GUI_INLINE_IMAGE_MAX_BYTES)), 'e o teto')
  assert.ok(result.error.includes(GUI_INLINE_IMAGE_RECIPE), 'a recusa nomeia a receita')
  assert.deepEqual(reads, [], 'o teto é pago ANTES de ler o arquivo inteiro')

  // Exatamente no teto ainda passa (a borda é inclusiva).
  const naBorda = new Uint8Array(GUI_INLINE_IMAGE_MAX_BYTES)
  naBorda.set(pngBytes(), 0)
  const borda = fakeDisk({ 'C:/wt/borda.png': { bytes: naBorda } })
  assert.equal(guiInlineImageData('C:/wt/borda.png', { disk: borda.disk }).ok, true)
})

test('o teto é a régua dos anexos, não um número privado deste módulo', () => {
  assert.equal(GUI_INLINE_IMAGE_MAX_BYTES, GUI_ATTACHMENT_PREVIEW_MAX_BYTES)
})

test('arquivo que cresceu entre o stat e a leitura ainda é recusado', () => {
  // TOCTOU: o `sizeOf` disse que cabia, o `read` devolveu mais que o teto.
  const bytes = new Uint8Array(GUI_INLINE_IMAGE_MAX_BYTES + 64)
  bytes.set(pngBytes(), 0)
  const { disk } = fakeDisk({ 'C:/wt/cresceu.png': { bytes, size: 1024 } })
  const result = guiInlineImageData('C:/wt/cresceu.png', { disk })
  assert.equal(result.ok, false)
  assert.ok(result.error.includes(GUI_INLINE_IMAGE_RECIPE))
})

test('falha de disco vira recusa com receita, nunca exceção que derruba o canal', () => {
  const { disk } = fakeDisk({ 'C:/wt/travado.png': { bytes: pngBytes(), unreadable: true } })
  const result = guiInlineImageData('C:/wt/travado.png', { disk })
  assert.equal(result.ok, false)
  assert.ok(result.error.includes(GUI_INLINE_IMAGE_RECIPE))

  const sumido = fakeDisk({})
  const ausente = guiInlineImageData('C:/wt/sumido.png', { disk: sumido.disk })
  assert.equal(ausente.ok, false)
  assert.ok(ausente.error.includes(GUI_INLINE_IMAGE_RECIPE))
})

test('toda recusa da cerca do fileOpen chega ao dono com uma saída sancionada', () => {
  const reasons = ['ambiguous', 'denied', 'invalid', 'limited', 'not-found', 'unavailable']
  for (const reason of reasons) {
    const message = guiInlineImageRefusal(reason, 'o arquivo fica fora da pasta desta conversa')
    assert.ok(message.length > 0, `${reason} sem mensagem`)
    assert.match(
      message,
      /clique|escolha|peça|cite|abra/u,
      `a recusa "${reason}" precisa nomear a ação que destrava`
    )
  }
  // O texto do resolver é preservado: o dono vê a MESMA recusa dos dois canais.
  assert.match(
    guiInlineImageRefusal('denied', 'links simbólicos e junctions não podem ser abertos pelo chat'),
    /links simbólicos e junctions/u
  )
  // Nome ambíguo não vira aposta: a receita é escolher no painel.
  assert.match(guiInlineImageRefusal('ambiguous', 'há mais de um arquivo com esse nome'), /escolha/u)
})

test('sem disco injetado o canal lê o arquivo de verdade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-inline-image-'))
  try {
    const path = join(dir, 'demo.png')
    const bytes = pngBytes(320, 200)
    writeFileSync(path, bytes)
    const result = guiInlineImageData(path)
    assert.equal(result.ok, true)
    assert.deepEqual(decode(result.dataUrl).bytes, bytes)

    const texto = join(dir, 'leia.md')
    writeFileSync(texto, '# não sou imagem\n')
    const recusa = guiInlineImageData(texto)
    assert.equal(recusa.ok, false)
    assert.ok(recusa.error.includes(GUI_INLINE_IMAGE_RECIPE))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
