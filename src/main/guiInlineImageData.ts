/**
 * A ENTREGA VISUAL APARECE NO CHAT (R36.1 — design vinculante
 * `.synkora/reports/DESIGN_ENTREGA_VISUAL_NO_CHAT_R36_2026-08-23.md`).
 *
 * O CASO REAL (print do dono, 23/08): o dev prometeu "demonstração visual",
 * jurou que a imagem estava "exibida diretamente acima" — e não havia NADA na
 * tela. O diagnóstico não é do modelo: `<img>` PASSA pelo sanitizador do chat,
 * então `![demo](caminho.png)` vira uma tag de verdade; só que o CSP do
 * renderer é `img-src 'self' data:`, e um caminho de worktree não é nem 'self'
 * nem `data:`. A imagem quebra MUDA — sem borda de erro, sem console, sem
 * nada. O modelo não tem como saber e ALUCINA a capacidade.
 *
 * Este módulo é a ponte: bytes que estão no disco viram a ÚNICA forma que o CSP
 * aceita — uma data URL. Três doutrinas da casa moram aqui:
 *
 *  1. O MIME sai dos BYTES, nunca da extensão. Extensão é fala do autor do
 *     arquivo; assinatura é fato. Um `.png` que na verdade é SVG (texto, sem
 *     assinatura) não pode entrar no DOM do chat por causa do nome — e um
 *     `.txt` que é PNG de verdade aparece igual. Quem sabe ler assinatura já é
 *     o `guiSafeImageInfo` dos anexos: reusamos, não copiamos (a régua de
 *     formato e a de medidas do app são UMA só).
 *  2. O teto é a MESMA régua que já governa data URL entrando no renderer
 *     (`GUI_ATTACHMENT_PREVIEW_MAX_BYTES`), e é pago ANTES de alocar o buffer.
 *  3. Recusa NOMEIA a receita. Beco sem saída é bug nesta casa: quem não pode
 *     ver a imagem inline tem de sair daqui sabendo qual clique destrava.
 *
 * O módulo não conhece electron, pane, IPC nem o `cwd` da conversa: ele recebe
 * um caminho que a cerca do `fileOpen` JÁ PROVOU (o absoluto nasce e morre no
 * main, em `src/main/ipc/gui.ts`) e devolve texto. O disco é injetável — a
 * suíte `scripts/test-gui-inline-image.mjs` prova o contrato sem tocar em disco
 * onde isso é possível.
 */
import { readFileSync, statSync } from 'node:fs'
import {
  GUI_ATTACHMENT_PREVIEW_MAX_BYTES,
  formatBytes,
  guiSafeImageInfo
} from './guiAttachments'
import type { GuiFileResolveReason } from './guiFileResolver'

/**
 * Teto do que o chat exibe inline. É a régua do PREVIEW dos anexos de
 * propósito — a mesma que já mede "data URL que atravessa o IPC e vira nó no
 * DOM" —, e não a do anexo bruto (10 MB) nem a do painel de arquivos (5 MB,
 * `GUI_FILE_PREVIEW_IMAGE_MAX_BYTES`): o painel mostra UMA imagem por vez, o
 * fio do chat carrega todas as que o agente citou na conversa inteira. Quando a
 * régua dos anexos mudar, esta muda junto, sem ninguém lembrar de nada.
 */
export const GUI_INLINE_IMAGE_MAX_BYTES = GUI_ATTACHMENT_PREVIEW_MAX_BYTES

/**
 * A RECEITA. Toda recusa deste canal termina nela: o caminho citado já é um
 * token clicável no chat, e o menu "onde abrir" (rodada 7) lê aqui dentro,
 * manda para o programa do sistema ou mostra na pasta. Ou seja: o dono nunca
 * fica sem ver a entrega — ele só vê fora do fio.
 */
export const GUI_INLINE_IMAGE_RECIPE = 'abra pelo menu do arquivo (clique no caminho)'

/**
 * ESPELHO DECLARADO do stub do preload (`src/preload/index.ts`,
 * `guiApi.fileImageData`) e do par no renderer. Só `dataUrl` atravessa: nem
 * caminho absoluto, nem tamanho, nem medidas — o que o renderer não precisa
 * saber, ele não recebe.
 */
export type GuiInlineImageDataResult =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string }

/** O disco, injetável. `sizeOf` existe separado do `read` porque o teto tem de
 *  ser pago sem alocar o arquivo inteiro na memória do main. */
export interface GuiInlineImageDisk {
  sizeOf(absolutePath: string): number
  read(absolutePath: string): Uint8Array
}

export interface GuiInlineImageOptions {
  disk?: GuiInlineImageDisk
  /** Só para bancada: produção usa sempre a régua dos anexos. */
  maxBytes?: number
}

const nodeDisk: GuiInlineImageDisk = {
  sizeOf: (absolutePath) => statSync(absolutePath).size,
  read: (absolutePath) => new Uint8Array(readFileSync(absolutePath))
}

function refuse(error: string): GuiInlineImageDataResult {
  return { ok: false, error: `${error}: ${GUI_INLINE_IMAGE_RECIPE}` }
}

/**
 * Caminho ABSOLUTO já provado pela cerca do `fileOpen` → data URL.
 *
 * Nunca lança: este canal é chamado por um efeito do renderer hidratando o fio,
 * e uma exceção aqui viraria imagem quebrada muda de novo — exatamente o bug
 * que a rodada veio matar.
 */
export function guiInlineImageData(
  absolutePath: string,
  options: GuiInlineImageOptions = {}
): GuiInlineImageDataResult {
  const disk = options.disk ?? nodeDisk
  const maxBytes =
    typeof options.maxBytes === 'number' && options.maxBytes > 0
      ? options.maxBytes
      : GUI_INLINE_IMAGE_MAX_BYTES

  let size: number
  try {
    size = disk.sizeOf(absolutePath)
  } catch {
    // O caminho foi provado há instantes; sumir agora é corrida com o dev
    // escrevendo no worktree. O erro bruto do fs carrega árvore/username e não
    // atravessa — a receita, sim.
    return refuse('não consegui ler este arquivo agora')
  }
  if (!Number.isFinite(size) || size > maxBytes) {
    return refuse(
      `esta imagem tem ${formatBytes(size)} e o chat exibe até ${formatBytes(maxBytes)}`
    )
  }

  let bytes: Uint8Array
  try {
    bytes = disk.read(absolutePath)
  } catch {
    return refuse('não consegui ler este arquivo agora')
  }
  // O `stat` é uma FOTO: entre ele e a leitura o dev pode ter reescrito o
  // arquivo. Quem manda é o buffer que está na mão.
  if (bytes.length > maxBytes) {
    return refuse(
      `esta imagem tem ${formatBytes(bytes.length)} e o chat exibe até ${formatBytes(maxBytes)}`
    )
  }

  const image = guiSafeImageInfo(bytes)
  if (!image) {
    // Cai aqui o que não tem assinatura (SVG é texto), o que a v1 não exibe
    // (bmp/ico/avif) e o bitmap cujas medidas não cabem no orçamento dos
    // anexos. Um só texto para os três: o dono não precisa da taxonomia, e sim
    // do clique que resolve.
    return refuse(
      'não reconheci esta imagem pelos bytes (o chat exibe png, jpeg, gif e webp)'
    )
  }

  return {
    ok: true,
    dataUrl: `data:${image.mime};base64,${Buffer.from(bytes).toString('base64')}`
  }
}

/**
 * A recusa da CERCA, com saída sancionada.
 *
 * O resolver (`guiFileResolver`) fala a mesma língua nos dois canais — é o
 * mesmo texto que o dono já lê ao clicar num caminho. O que falta nele, aqui, é
 * o que fazer AGORA: a imagem não apareceu no fio e ninguém pode ficar olhando
 * para um retângulo vazio sem próximo passo. Este mapa é exaustivo de
 * propósito: `GuiFileResolveReason` novo quebra o `switch` no typecheck, em vez
 * de nascer mudo.
 */
export function guiInlineImageRefusal(reason: GuiFileResolveReason, error: string): string {
  switch (reason) {
    case 'ambiguous':
      // Nome ambíguo NUNCA vira aposta (régua do `fileOpenExternal`): quem
      // escolhe é o dono, no painel que o clique abre.
      return `${error}: clique no caminho e escolha qual arquivo abrir`
    case 'denied':
      // Fora da pasta, link/junction, arquivo sensível. Nenhum clique resolve —
      // a saída é a entrega nascer DENTRO do worktree da missão.
      return `${error}: peça ao dev para gravar a imagem dentro da pasta desta conversa`
    case 'not-found':
      return `${error}: peça ao dev o caminho da imagem relativo à raiz desta conversa`
    case 'limited':
      // O resolver já ensina uma saída ("cite um caminho mais completo"), mas
      // ela é herdada — e receita herdada some quando o texto do outro módulo
      // muda. A nossa diz também QUEM age: quem escreveu a referência foi o
      // dev, não o dono (clicar no token cairia no mesmo limite de busca).
      return `${error} — peça ao dev o caminho a partir da raiz desta conversa`
    case 'invalid':
      return `${error}: cite o caminho do arquivo relativo à raiz desta conversa`
    case 'unavailable':
      return `${error}: abra a conversa deste pane e tente de novo`
  }
}
