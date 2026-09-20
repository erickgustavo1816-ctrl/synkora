// ABRIR ARQUIVO ONDE O DONO QUISER (rodada 7, item C1 do design).
//
// O dono clicava num `.html` da entrega e caía no preview de CÓDIGO do app, sem
// saída: "quero opções — ver pelo Synkora, abrir fora do app, abrir no
// navegador". Este módulo é o MODELO desse menu — puro, sem React e sem DOM,
// para o contrato viver em teste de node antes de virar pixel:
//
//   · quais saídas existem para um arquivo (e por que um arquivo APAGADO nesta
//     branch não oferece nenhuma);
//   · a GUARDA — o caminho que sai daqui é sempre o que o resolver do main
//     aceitaria; caminho cru do renderer nunca chega ao `shell.*`;
//   · as pontes tipadas dos canais de saída, no mesmo padrão de
//     `missionWorkspace.ts`: cast estreito resolvido A CADA CHAMADA, porque o
//     namespace do preload pode nascer depois deste módulo ser importado.
//
// Browser artifacts in the chat have their own owner-gesture action. Source
// reading and the two external actions keep their independent destinations.
//
// RODADA 7-D (esclarecimento do dono): a superfície que ele queria é o CHAT —
// "quando o agente cita um `.html` e eu clico, abre o painelzinho de código;
// quero o botão direito ali, como o app do Codex faz". O modelo, os rótulos e a
// guarda são os MESMOS; o que muda é o DIALETO do pedido:
//
//   · aba de arquivos / trilho de entrega → `projectId` + raiz lógica +
//     caminho relativo (canal `files:openExternal`);
//   · chat → `paneId` + a referência crua que o agente escreveu (canal
//     `gui:fileOpenExternal`), porque no fio a autoridade é o `cwd` do pane.

import type {
  FileExternalOpenResult,
  FileTreeRoot,
  GuiFileExternalOpenResult
} from '../../preload/index'

/** As três saídas do menu, na ordem em que o dono as pediu. */
export type FileContextAction = 'open-browser' | 'open-in-app' | 'open-default' | 'reveal'

/** O que o main faz com o arquivo: `default` = programa padrão do sistema;
 *  `reveal` = mostrar na pasta. ESPELHO de `FileExternalOpenMode`
 *  (src/main/ipc/files.ts) — o par está declarado nos dois lados. */
export type FileOpenMode = 'default' | 'reveal'

/** O que TODA superfície declara sobre o arquivo, seja qual for o dialeto. */
export interface FileContextTargetBase {
  /** o que o dono LÊ na tela: dá o nome do menu e a família da dica */
  path: string
  /** letra do git quando a origem é o trilho de entrega (`D` = apagado) */
  status?: string
  /** este arquivo JÁ está aberto na superfície que abriu o menu (o viewer) */
  current?: boolean
}

/**
 * Um arquivo apontado pela ABA DE ARQUIVOS ou pelo trilho de entrega. O caminho
 * é SEMPRE relativo à raiz autorizada (worktree da missão ou raiz do projeto) —
 * caminho absoluto não atravessa o renderer, nem para dentro nem para fora.
 */
export interface FileTreeContextTarget extends FileContextTargetBase {
  projectId: string
  root: FileTreeRoot
}

/**
 * Um arquivo CITADO NO FIO. Aqui não existe raiz lógica: quem sabe onde a
 * conversa mora é o registro de sessões do main, pelo `paneId`. A `reference` é
 * o token cru do agente (pode ser nome curto, caminho relativo ou absoluto
 * dentro do worktree) — quem normaliza é o resolver do main, nunca esta camada.
 */
export interface ChatFileContextTarget extends FileContextTargetBase {
  paneId: string
  reference: string
  /** escolha JÁ feita no painel (fecha a ambiguidade antes de sair do app) */
  selectedPath?: string
}

export type FileContextTarget = FileTreeContextTarget | ChatFileContextTarget

/** Discrimina o dialeto sem adivinhar: o chat é quem tem `paneId`. */
export function isChatFileTarget(target: FileContextTarget): target is ChatFileContextTarget {
  return typeof (target as ChatFileContextTarget).paneId === 'string'
}

export interface FileContextOption {
  action: FileContextAction
  label: string
  glyph: string
  tip: string
}

export interface FileOpenOutcome {
  ok: boolean
  action?: 'external' | 'reveal'
  error?: string
}

/** UI em PT-BR; identificadores em inglês (regra da casa). */
export const FILE_CONTEXT_LABELS: Readonly<Record<FileContextAction, string>> = {
  'open-browser': 'Abrir no browser do Synkora',
  'open-in-app': 'abrir no app',
  'open-default': 'abrir com o programa padrão',
  reveal: 'mostrar na pasta'
}

/** Glifos do vocabulário que o app já usa: folha, seta que SAI, pasta. */
export const FILE_CONTEXT_GLYPHS: Readonly<Record<FileContextAction, string>> = {
  'open-browser': '◎',
  'open-in-app': '▤',
  'open-default': '↗',
  reveal: '▱'
}

/** Para ONDE o sistema manda este arquivo. A família não muda a ação (é sempre
 *  o programa padrão do Windows), muda o que a dica PROMETE — dizer "abre no
 *  navegador" para um `.png` seria mentira. */
export type FileOpenFamily = 'page' | 'image' | 'document' | 'media' | 'plain'

const PAGE_EXTENSIONS = new Set(['html', 'htm', 'xhtml', 'svg'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'])
const DOCUMENT_EXTENSIONS = new Set(['pdf'])
const MEDIA_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'm4a', 'mp4', 'webm', 'ogv'])

export function fileOpenFamily(path: string): FileOpenFamily {
  const name = path.replace(/\\/g, '/').split('/').at(-1) ?? ''
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (PAGE_EXTENSIONS.has(extension)) return 'page'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'document'
  if (MEDIA_EXTENSIONS.has(extension)) return 'media'
  return 'plain'
}

const DEFAULT_TIP: Readonly<Record<FileOpenFamily, string>> = {
  page: 'Abre no seu navegador padrão — a página renderizada, não o código.',
  image: 'Abre no visualizador de imagens do sistema.',
  document: 'Abre no leitor de PDF do sistema.',
  media: 'Abre no player de áudio ou vídeo do sistema.',
  plain: 'Abre no programa padrão do sistema para este tipo de arquivo.'
}

const MAX_ID_LENGTH = 256
/** Mesmo teto de `FILE_TREE_MAX_PATH_LENGTH` (src/main/filePreview.ts). */
const MAX_PATH_LENGTH = 2_048

/**
 * ESPELHO DECLARADO de `normalizedRelativePath` (src/main/filePreview.ts): o
 * main continua sendo a autoridade — ele recusa de novo, sempre. Esta cópia
 * existe para o menu não OFERECER uma saída que o resolver vai negar, e para o
 * caminho que sai do renderer já sair normalizado.
 */
function normalizedRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return null
  if (value.includes('\0')) return null
  // Absoluto é medido no BRUTO: `C:\x` viraria `C:/x` e passaria por segmentos.
  if (value.startsWith('/') || value.startsWith('\\') || /^[a-zA-Z]:/u.test(value)) return null
  const segments = value.replace(/\\/g, '/').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

/** ESPELHO DECLARADO de `readOnlyRootPath` (src/main/ipc/files.ts): raiz é
 *  sempre um ID lógico; caminho físico é escolha do main, nunca do renderer. */
function normalizedRoot(root: unknown): FileTreeRoot | null {
  if (!root || typeof root !== 'object') return null
  const value = root as { kind?: unknown; missionId?: unknown }
  if (value.kind === 'project') return { kind: 'project' }
  if (value.kind !== 'mission') return null
  if (typeof value.missionId !== 'string') return null
  if (value.missionId.length === 0 || value.missionId.length > MAX_ID_LENGTH) return null
  return { kind: 'mission', missionId: value.missionId }
}

export interface FileOpenRequest {
  projectId: string
  root: FileTreeRoot
  path: string
}

/**
 * ESPELHO DECLARADO de `cleanReference` (src/main/guiFileResolver.ts): o que o
 * agente escreveu no fio vai INTACTO para o main (só ele sabe normalizar contra
 * o worktree), mas o que nem referência é morre aqui.
 */
function acceptableReference(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_PATH_LENGTH) return null
  if (value.includes('\0') || /[\r\n]/u.test(value)) return null
  // ESPELHO de `hasTraversal`: o resolver recusa, então o menu não oferece.
  if (value.replace(/\\/g, '/').split('/').some((part) => part === '..')) return null
  return value
}

export interface GuiChatFileOpenRequest {
  paneId: string
  reference: string
  selectedPath?: string
}

/**
 * A GUARDA do dialeto do CHAT. A escolha do painel segue a régua da seleção no
 * resolver (`resolve` com `selectedPath`): relativa, sem `..` e sem raiz de
 * disco — ela nomeia um arquivo DENTRO da conversa, nunca um lugar do sistema.
 */
export function guiChatFileRequest(target: unknown): GuiChatFileOpenRequest | null {
  if (!target || typeof target !== 'object') return null
  const value = target as { paneId?: unknown; reference?: unknown; selectedPath?: unknown }
  if (typeof value.paneId !== 'string') return null
  if (value.paneId.length === 0 || value.paneId.length > MAX_ID_LENGTH) return null
  const reference = acceptableReference(value.reference)
  if (reference == null) return null
  if (value.selectedPath === undefined) return { paneId: value.paneId, reference }
  const selected = acceptableReference(value.selectedPath)
  if (selected == null) return null
  if (selected.startsWith('/') || selected.startsWith('\\') || /^[a-zA-Z]:/u.test(selected)) {
    return null
  }
  return { paneId: value.paneId, reference, selectedPath: selected }
}

/**
 * A GUARDA. Devolve o pedido normalizado — ou `null`, e então nada atravessa a
 * ponte. É o único caminho por onde o renderer fala com `files:openExternal`.
 */
export function fileContextRequest(target: unknown): FileOpenRequest | null {
  if (!target || typeof target !== 'object') return null
  const value = target as { projectId?: unknown; root?: unknown; path?: unknown }
  if (typeof value.projectId !== 'string') return null
  if (value.projectId.length === 0 || value.projectId.length > MAX_ID_LENGTH) return null
  const root = normalizedRoot(value.root)
  if (!root) return null
  const path = normalizedRelativePath(value.path)
  if (path == null) return null
  return { projectId: value.projectId, root, path }
}

/**
 * O menu por arquivo. Vazio = o menu nem abre: arquivo APAGADO nesta branch não
 * existe no disco (abrir e "mostrar na pasta" falhariam os dois), e caminho que
 * a guarda recusa não vira oferta.
 */
export function fileContextOptions(target: FileContextTarget): FileContextOption[] {
  if (target.status === 'D') return []
  const accepted = isChatFileTarget(target)
    ? guiChatFileRequest(target)
    : fileContextRequest(target)
  if (!accepted) return []
  const family = fileOpenFamily(target.path)
  const browserArtifact = isChatFileTarget(target) && (family === 'page' || family === 'image' || family === 'media')
  return [
    ...(browserArtifact ? [{
      action: 'open-browser' as const,
      label: FILE_CONTEXT_LABELS['open-browser'],
      glyph: FILE_CONTEXT_GLYPHS['open-browser'],
      tip: 'Mostra o arquivo renderizado em uma aba sua no browser desta missão.'
    }] : []),
    ...(!browserArtifact || family === 'page' || family === 'image' ? [{
      action: 'open-in-app' as const,
      label: browserArtifact && family === 'page' ? 'Ler código no app' : FILE_CONTEXT_LABELS['open-in-app'],
      glyph: FILE_CONTEXT_GLYPHS['open-in-app'],
      tip: target.current
        ? 'Já está aberto aqui — recarrega a leitura desta folha.'
        : 'Lê aqui dentro do Synkora, na bancada de papel (somente leitura).'
    }] : []),
    {
      action: 'open-default',
      label: FILE_CONTEXT_LABELS['open-default'],
      glyph: FILE_CONTEXT_GLYPHS['open-default'],
      tip: DEFAULT_TIP[family]
    },
    {
      action: 'reveal',
      label: FILE_CONTEXT_LABELS.reveal,
      glyph: FILE_CONTEXT_GLYPHS.reveal,
      tip: 'Abre a pasta no explorador de arquivos, com este arquivo selecionado.'
    }
  ]
}

interface FileOpenBridge {
  openExternal: (
    projectId: string,
    root: FileTreeRoot,
    relativePath: string,
    mode: FileOpenMode
  ) => Promise<FileExternalOpenResult>
}

function bridge(): Partial<FileOpenBridge> | undefined {
  return (window as unknown as { synkora?: { files?: Partial<FileOpenBridge> } }).synkora?.files
}

/** Recusa que NOMEIA a receita: beco sem saída é bug (regra da casa). */
const NO_BRIDGE =
  'reinicie o app (npm run dev) para abrir arquivo fora do Synkora — esta janela ainda não tem a ponte'

const REFUSED =
  'este caminho não pode ser aberto: o Synkora só abre arquivo de dentro do worktree da missão ou da raiz do projeto'

/** true = o preload desta janela já publica o canal novo. */
export function fileOpenAvailable(): boolean {
  return typeof bridge()?.openExternal === 'function'
}

/**
 * Manda o arquivo para o sistema (`default`) ou abre a pasta dele (`reveal`).
 * O main resolve a raiz por ID e o arquivo pelo resolver físico antes de tocar
 * em `shell.*` — aqui a guarda serve para o app não pedir o impossível e para
 * caminho torto morrer antes do IPC.
 */
export async function runFileOpen(
  mode: FileOpenMode,
  target: FileContextTarget
): Promise<FileOpenOutcome> {
  const request = fileContextRequest(target)
  if (!request) return { ok: false, error: REFUSED }
  const api = bridge()
  if (typeof api?.openExternal !== 'function') return { ok: false, error: NO_BRIDGE }
  try {
    const raw = await api.openExternal(request.projectId, request.root, request.path, mode)
    return openOutcome(raw)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** A resposta do main (dos DOIS canais) vira o mesmo desfecho para a tela. */
function openOutcome(raw: FileExternalOpenResult | GuiFileExternalOpenResult): FileOpenOutcome {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'o canal de abrir arquivo não respondeu' }
  }
  if (raw.ok === true) {
    return { ok: true, action: raw.action === 'reveal' ? 'reveal' : 'external' }
  }
  const error = (raw as { error?: unknown }).error
  return {
    ok: false,
    error: typeof error === 'string' && error ? error : 'não deu para abrir este arquivo agora'
  }
}

interface GuiChatFileOpenBridge {
  fileOpenExternal: (
    paneId: string,
    reference: string,
    selectedPath: string | undefined,
    mode: FileOpenMode
  ) => Promise<GuiFileExternalOpenResult>
}

/**
 * ESPELHO DECLARADO de `guiApi.fileOpenExternal` (src/renderer/src/guiApi.ts),
 * que é o par tipado deste canal para o resto do renderer.
 *
 * Este módulo NÃO importa o `guiApi` de propósito: ele é carregado DIRETO pelo
 * node nas suítes (`--experimental-strip-types`), e import relativo sem extensão
 * não resolve fora do bundler. O cast estreito é resolvido A CADA CHAMADA porque
 * o namespace do preload pode nascer depois deste módulo ser importado.
 */
function guiBridge(): Partial<GuiChatFileOpenBridge> | undefined {
  return (window as unknown as { synkora?: { gui?: Partial<GuiChatFileOpenBridge> } }).synkora?.gui
}

const NO_GUI_BRIDGE =
  'reinicie o app (npm run dev) para abrir arquivo fora do Synkora — este chat ainda '
  + 'não tem a ponte'

const CHAT_REFUSED =
  'este caminho não pode ser aberto: o chat só abre arquivo de dentro da pasta desta conversa'

/**
 * A saída de fora do app para um arquivo CITADO NO FIO. O main resolve a
 * conversa pelo `paneId` e o arquivo pelo resolver físico antes de tocar em
 * `shell.*`; aqui a guarda serve para o app não pedir o impossível.
 */
export async function runGuiChatFileOpen(
  mode: FileOpenMode,
  target: FileContextTarget
): Promise<FileOpenOutcome> {
  const request = guiChatFileRequest(target)
  if (!request) return { ok: false, error: CHAT_REFUSED }
  const api = guiBridge()
  if (typeof api?.fileOpenExternal !== 'function') return { ok: false, error: NO_GUI_BRIDGE }
  try {
    const raw = await api.fileOpenExternal(
      request.paneId,
      request.reference,
      request.selectedPath,
      mode
    )
    return openOutcome(raw)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
