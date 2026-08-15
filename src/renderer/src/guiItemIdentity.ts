/**
 * Identidade dos itens do fio do pane GUI.
 *
 * O id de um item é a CHAVE de reconciliação do React na lista do transcript
 * (`GuiPane.tsx` renderiza `key={item.id}`) e o MESMO id viaja até o main como
 * `messageId` do `gui:send` — é ele que dá idempotência ao envio. Portanto a
 * identidade precisa ser única ao longo de toda a vida da CONVERSA, que é bem
 * maior que a vida do renderer: o fio visível é persistido em
 * `userData/gui-sessions.json` e a fila do composer mora no `localStorage`.
 *
 * O contador puro de processo (`g1`, `g2`, …) reiniciava do zero a cada boot do
 * app e re-cunhava ids que ainda existiam na fotografia hidratada — o
 * `user-message` persistido guarda o id da geração anterior, enquanto os itens
 * de assistente/ferramenta são re-cunhados na hidratação. Duas gerações
 * dividindo a mesma chave é o que fazia a bolha do dono aparecer DUAS VEZES
 * depois de fechar e reabrir o app. Medido na fotografia real do dono
 * (2026-08-15): 13 ids colididos num único pane hidratado.
 *
 * O prefixo de boot é o que separa as gerações — e também as duas views que
 * rodam o mesmo bundle (host e panes), que antes compartilhavam a sequência de
 * um contador por processo.
 *
 * Charset fechado em `[A-Za-z0-9._:-]` e teto de 128: é exatamente o que
 * `guiMessageIdProblem` (src/main/guiSessions.ts) aceita como `messageId`, e um
 * id fora dessa régua faria o main recusar o envio e o validador do disco
 * descartar o `user-message` na hidratação.
 */

/** Mesma régua do `guiMessageIdProblem` do main — a identidade atravessa o IPC. */
export const GUI_ITEM_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u

export function isGuiItemId(value: unknown): value is string {
  return typeof value === 'string' && GUI_ITEM_ID_RE.test(value)
}

/**
 * Marca desta execução do renderer. Aleatoriedade real quando a WebCrypto
 * existe; o relógio entra junto para que duas janelas abertas no mesmo
 * milissegundo continuem separadas mesmo num fallback pobre de `Math.random`.
 */
export function createGuiBootToken(): string {
  const bytes = new Uint8Array(6)
  const webCrypto = globalThis.crypto
  if (typeof webCrypto?.getRandomValues === 'function') webCrypto.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  let random = ''
  for (const byte of bytes) random += byte.toString(36).padStart(2, '0')
  return `${Date.now().toString(36)}${random}`
}

const GUI_BOOT_TOKEN = createGuiBootToken()

let guiItemSeq = 0

/** Id novo, único nesta conversa e em qualquer geração anterior dela. */
export function guiItemId(): string {
  guiItemSeq += 1
  return `g${GUI_BOOT_TOKEN}-${guiItemSeq}`
}

/**
 * Id preferido de FORA desta geração (bilhete da fila, que sobrevive ao
 * restart no `localStorage`, inclusive gravado por uma versão antiga do app).
 * Ele só é aceito quando está livre no fio já montado: um id repetido viraria
 * chave duplicada na lista e, no main, cairia no `messageIds` da fotografia
 * restaurada — a mensagem seria engolida em silêncio.
 */
export function claimGuiItemId(
  preferred: string | undefined,
  taken: Iterable<{ id: string }>
): string {
  if (!isGuiItemId(preferred)) return guiItemId()
  for (const item of taken) if (item.id === preferred) return guiItemId()
  return preferred
}
