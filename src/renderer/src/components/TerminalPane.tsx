import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal, type ILink, type ILinkProvider } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { useStore, type PaneKind } from '../store'
import {
  clearSynVoiceTarget,
  isSynVoiceElementVisible,
  setSynVoiceTarget
} from '../synVoiceTarget'
import {
  TERMINAL_DEFAULT_FONT_FAMILY,
  TERMINAL_DEFAULT_FONT_SIZE,
  TERMINAL_DEFAULT_LINE_HEIGHT,
  TERMINAL_SCROLLBAR_WIDTH,
  terminalFontStack
} from '../terminalGeometry'
import '@xterm/xterm/css/xterm.css'

// Tema "overclock": painel escuro quente + paleta ANSI completa. Sem os 16
// slots ANSI o xterm cai nos defaults (azul/verde berrantes ilegíveis no fundo
// marrom) — era isso que deixava os panes "sem cor".
const TERM_THEME = {
  background: '#211f1a',
  foreground: '#efe8d6',
  cursor: '#d96c3f',
  cursorAccent: '#211f1a',
  selectionBackground: 'rgba(217, 108, 63, 0.35)',
  scrollbarSliderBackground: 'rgba(217, 108, 63, 0.7)',
  scrollbarSliderHoverBackground: 'rgba(217, 108, 63, 0.9)',
  scrollbarSliderActiveBackground: '#d96c3f',
  // `overviewRuler.width` define a largura real da barra; o ruler em si não é
  // usado e não deve deixar a linha separadora padrão ao lado do polegar.
  overviewRulerBorder: 'rgba(0, 0, 0, 0)',
  black: '#33302a',
  red: '#c4453a',
  green: '#3e9b5f',
  yellow: '#d9a03f',
  blue: '#6b93bd',
  magenta: '#b07aa0',
  cyan: '#6aa8a0',
  white: '#d8d0bc',
  brightBlack: '#7d7663',
  brightRed: '#e0655a',
  brightGreen: '#5cba7d',
  brightYellow: '#e8b45c',
  brightBlue: '#8fb2d9',
  brightMagenta: '#cf9ac0',
  brightCyan: '#8cc7bf',
  brightWhite: '#f5efe0'
}

// ————————————————————————————————————————————————————————————————————————
// POR QUE ESTE ARQUIVO FICOU SIMPLES DE NOVO (2026-07-27)
//
// Durante meses este componente carregou três gambiarras — clear sintético por
// detecção de frame, modo FIXO 100x30 e zoom de fonte — todas construídas em
// cima de UMA causa: no Windows o ConPTY INBOX REPINTA O BUFFER VISÍVEL INTEIRO
// a cada resize, inclusive quando só a ALTURA muda. Sonda nesta máquina com as
// TUIs reais (12 resizes seguidos, que é o que um arrasto produz):
//
//              claude inbox   claude dll   codex inbox   codex dll
//   12 resizes     23.094 B        28 B      22.739 B     2.188 B
//   só altura       1.088 B        12 B       7.254 B       419 B
//   encolher        1.825 B     1.295 B       4.521 B        38 B
//
// A DLL moderna continua necessária. O Codex usa seu modo inline e o scrollback
// real do xterm. O Claude 2.1.220, porém, repinta a viewport inteira no modo
// inline a cada resize e essas repinturas viram cópias da conversa. Por isso ele
// permanece no renderer fullscreen, que possui histórico virtual e substitui o
// mesmo frame ao redimensionar. O renderer apenas entrega os bytes.
//
// NÃO REINTRODUZIR o clear sintético por DETECÇÃO DE FRAME: a lista de
// sequências "neutras" é fechada, qualquer CSI nova (\e[?2026h synchronized
// output, por exemplo) faz a detecção falhar em silêncio, e o app ATUALIZA os
// CLIs sozinho no boot. Pior: ela olhava bytes o tempo todo, então TEXTO DO
// USUÁRIO disparava o clear e apagava o pane.
//
// TAMBÉM NÃO REINTRODUZIR: fixar as colunas e crescer a FONTE para preencher a
// largura. Foi tentado (teto de 20px) e ficou FEIO — pane largo virava letra
// gigante, e densidade de texto é parte da identidade visual de um terminal.
// Nenhum dos emuladores lidos (VS Code, waveterm, tabby, hyper, ttyd) faz isso:
// todos são elásticos. A fonte fica em 13px (menor só em mosaico denso, via
// prop) e o terminal acompanha a caixa.
//
// Não desligar o reflow com `backend: 'winpty'`: foi testado no app, não
// eliminou a duplicação e ainda clipou texto ao estreitar. O buffer normal de
// Codex/shell depende do reflow; no Claude, o fullscreen cuida do próprio texto.
// ————————————————————————————————————————————————————————————————————————

// O Chromium mata o contexto WebGL MAIS ANTIGO quando o 17º nasce ("Too many
// active WebGL contexts. Oldest context will be lost.") e ele NUNCA é
// restaurado. Cada pane é um contexto e pane ESCONDIDO não libera nada —
// universos montados, um .maestro-slot por missão aberta, panes de execução,
// ajudantes, login — então passar de 16 é fácil, e a vítima é sempre o pane
// mais VELHO (na prática o Maestro do primeiro projeto). O estrago: ~3s de pane
// CONGELADO (o addon espera 3000ms por um restore que nunca vem) e, depois do
// dispose, o pane fica para sempre no renderer DOM, onde `customGlyphs` não
// vale e as caixas ╭─│╰ passam a vir da fonte = "caixas desalinhadas". Melhor
// nascer no DOM de propósito do que derrubar o vizinho.
const WEBGL_BUDGET = 12
let webglLive = 0

/** Piso PADRÃO fora do canvas compacto. O FitAddon grampeia em 2×1; 60×12
 * mantém a TUI íntegra nas caixas normais. PanesView pode pedir um piso menor
 * quando o mosaico inteiro já é fisicamente mais estreito: nesse caso caber na
 * caixa é preferível a recortar apenas a borda direita. */
const MIN_COLS = 60
const MIN_ROWS = 12

/** REFLOW PADRÃO DO XTERM.
 *
 *  Já tentei desligá-lo com `backend: 'winpty'` — a teoria era que o reflow
 *  empurrava o frame antigo para o scrollback. TESTADO NO APP: a duplicação
 *  CONTINUOU e apareceu uma regressão feia — sem reflow o texto impresso numa
 *  largura maior fica CLIPADO ao estreitar ("…e deixe eles em stan"). Ou seja:
 *  custou legibilidade e não comprou nada. Revertido.
 *
 *  Não passar `windowsPty`: essa opção descreve o contrato do ConPTY inbox.
 *  Com a DLL v2 usada pelo app, o A/B real 58→80 mostrou o oposto: a opção
 *  deixou linhas vazias ao crescer, enquanto o comportamento padrão do xterm
 *  restaurou o scrollback corretamente. `windowsMode` também continua proibido
 *  porque liga a heurística de wrapping e desliga o reflow. */

// ————————————————————————————————————————————————————————————————————————
// TAMANHO DEFINITIVO ANTES DO PRIMEIRO BYTE
//
// Pane que nasce ESCONDIDO (ajudante criado em segundo plano, nó não ancorado,
// outro universo) não pode ser medido: ele bootava num tamanho de chute e era
// redimensionado ao aparecer — e AÍ o claude reimprimia tudo na largura nova,
// deixando a cópia antiga acima do viewport. Era essa a duplicação que sobrou.
//
// Como todos os ladrilhos do palco têm EXATAMENTE a mesma caixa, o primeiro
// pane que consegue se medir publica o resultado aqui, e os que nascem
// escondidos no mesmo grupo já nascem no tamanho FINAL — quando aparecem, o
// resize é no-op e não há repintura nenhuma.
// ————————————————————————————————————————————————————————————————————————
const MEASURED_BY_GROUP = new Map<string, { cols: number; rows: number }>()
const MAX_MEASURED_GROUPS = 256

/** Espera (ms) por uma medida REAL do grupo antes de spawnar um pane escondido.
 *  Ajudante nasce em segundo plano, em bloco: o primeiro pane visível mede e os
 *  outros aproveitam. Só depois disso vale cair na estimativa. */
const WAIT_FOR_GROUP_MS = 4000
/** Dá ao irmão visível tempo para substituir uma entrada antiga do mesmo grupo
 *  pela medida desta montagem antes de um pane oculto consumi-la. */
const GROUP_CACHE_GRACE_MS = 1200

interface Props {
  paneId: string
  cwd: string
  kind: PaneKind
  /** Universo dono do pane. Habilita links de arquivo validados pelo main. */
  projectId?: string
  seatId?: string
  taskId?: string
  initialPrompt?: string
  model?: string
  cliArgs?: string[]
  /** persona injetada via --append-system-prompt (pane do Maestro) */
  appendSystemPrompt?: string
  logFile?: string
  /** colar IMAGEM vira PNG em .synkora/attachments deste projeto + path digitado */
  imagePasteProjectId?: string
  /** chamado quando o usuário digita no pane (limpa o alerta de aprovação) */
  onUserInput?: () => void
  /** Tamanho da fonte em px. O mosaico usa isto para caber mais ladrilhos sem
   *  espremer as COLUNAS abaixo do legível (texto menor, não linha quebrada).
   *  Lido por REF: mudar não pode remontar o xterm — isso mataria o PTY. */
  fontSize?: number
  /** Altura da linha e família também são globais e mudam sem remontar o PTY. */
  lineHeight?: number
  fontFamily?: string
  /** Pisos do xterm. Claude usa 60x12; callers só devem pedir menos para CLIs
   *  cuja TUI tenha sido validada nessa geometria. */
  minCols?: number
  minRows?: number
  /** Tamanho (cols×rows) para o pane que NASCE ESCONDIDO — sem medida real o
   *  xterm ficaria nos 80x24 de fábrica e o TUI bootaria estreito. Também
   *  lido por ref. */
  fallbackSize?: { cols: number; rows: number }
  /** Identidade explícita da GEOMETRIA do ladrilho. Panes do mesmo grupo têm
   *  caixa e fonte idênticas, então a medida real de um vale para todos. O
   *  caller deve incluir contexto suficiente (projeto/layout/fonte) para não
   *  colidir com outro conjunto. Ver MEASURED_BY_GROUP. */
  sizeGroup?: string
  /** Nome legível do destino mostrado pelo SynVoice. */
  voiceLabel?: string
  /** Terminais de login/segredos nunca podem virar destino de ditado. */
  voiceEnabled?: boolean
  /** Feedback imediato enquanto o processo principal prepara o ambiente. */
  startupMessage?: string
}

export default function TerminalPane({
  paneId,
  cwd,
  kind,
  projectId,
  seatId,
  taskId,
  initialPrompt,
  model,
  cliArgs,
  appendSystemPrompt,
  logFile,
  imagePasteProjectId,
  onUserInput,
  fontSize,
  lineHeight,
  fontFamily,
  minCols,
  minRows,
  fallbackSize,
  sizeGroup,
  voiceLabel,
  voiceEnabled = true,
  startupMessage
}: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  // Props que mudam SEM remontar o terminal moram em refs: entrar nas deps do
  // efeito principal recriaria o xterm e MATARIA o PTY (regra de ouro).
  const requestedFont = fontSize ?? TERMINAL_DEFAULT_FONT_SIZE
  const requestedLineHeight = lineHeight ?? TERMINAL_DEFAULT_LINE_HEIGHT
  const requestedFontFamily = fontFamily ?? TERMINAL_DEFAULT_FONT_FAMILY
  const requestedMinCols = Number.isFinite(minCols)
    ? Math.max(2, Math.floor(minCols as number))
    : MIN_COLS
  const requestedMinRows = Number.isFinite(minRows)
    ? Math.max(1, Math.floor(minRows as number))
    : MIN_ROWS
  const fontRef = useRef(requestedFont)
  fontRef.current = requestedFont
  const lineHeightRef = useRef(requestedLineHeight)
  lineHeightRef.current = requestedLineHeight
  const fontFamilyRef = useRef(requestedFontFamily)
  fontFamilyRef.current = requestedFontFamily
  const minColsRef = useRef(requestedMinCols)
  minColsRef.current = requestedMinCols
  const minRowsRef = useRef(requestedMinRows)
  minRowsRef.current = requestedMinRows
  const fallbackRef = useRef(fallbackSize)
  fallbackRef.current = fallbackSize
  const groupRef = useRef(sizeGroup)
  groupRef.current = sizeGroup
  const voiceLabelRef = useRef(voiceLabel)
  voiceLabelRef.current = voiceLabel
  const voiceEnabledRef = useRef(voiceEnabled)
  voiceEnabledRef.current = voiceEnabled
  const relayoutRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    window.synkora.pty.markStartupRequest(paneId)
    // Ponto certo do reset da telemetria: este efeito só roda quando um pty NOVO
    // vai nascer para este paneId. Os mapas são por paneId e só o closePane os
    // limpava — o pane do PM e os dos orquestradores nunca passam por lá, então
    // respawn de mesmo id (⇄ seat, missão reativada, autocura do --resume)
    // exibia ↓/↑, contexto e modelo da sessão MORTA sobre um terminal vazio.
    // Zerar no pty:exit seria errado: apagaria os números do pane morto que o
    // usuário ainda está lendo na aba Panes.
    useStore.getState().resetPaneTelemetry(paneId)

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: terminalFontStack(fontFamilyRef.current),
      // O primeiro fit precisa usar a fonte pedida pelo caller. Inicializar em
      // 13px e apenas guardar o prop no ref fazia panes MINI nascerem medidos
      // com a métrica errada; como o ref já continha 11/12, o efeito de fonte
      // também não detectava mudança para corrigir depois.
      fontSize: fontRef.current,
      lineHeight: lineHeightRef.current,
      scrollback: 5000,
      smoothScrollDuration: 70,
      // O xterm e o FitAddon leem esta mesma opção; mudar apenas o CSS deixa
      // a barra fina por fora, mas ainda rouba 14px da grade por dentro.
      // No Claude, o fullscreen possui seu próprio histórico virtual: a barra
      // do buffer normal não representa esse histórico e fica desativada.
      ...(kind === 'claude' ? {} : { overviewRuler: { width: TERMINAL_SCROLLBAR_WIDTH } }),
      theme: TERM_THEME,
      // NUNCA setar `termName` aqui. O ConPTY v2 (conpty.dll, ligado no
      // pty.ts) manda \e[c no boot e BLOQUEIA a saída ~3,2s esperando a
      // resposta de Device Attributes. O xterm responde sozinho, mas só quando
      // o termName casa por PREFIXO com xterm/rxvt-unicode/screen/linux — o
      // default é "xterm" e por isso funciona. Trocar por "xterm-256color"
      // parece inofensivo e continua casando; trocar por qualquer outra coisa
      // faz TODO pane nascer com 3,2s de tela preta.
      //
      // Alt+clique DIGITA uma rajada de setas no PTY (moveToCellSequence, feito
      // para mover o cursor de um shell) — num TUI isso mexe no picker de
      // opções e no histórico sem o usuário pedir, e NÃO passa pelo
      // attachCustomKeyEventHandler (é caminho de mouse, não de teclado).
      altClickMovesCursor: false,
      // Glifo de 1 célula que rasteriza mais largo é ENCOLHIDO em vez de vazar
      // por cima do vizinho (default do xterm é false).
      rescaleOverlappingGlyphs: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)

    term.attachCustomKeyEventHandler((ev) => {
      // Shift+Enter = NOVA LINHA no input do TUI. Bloqueia keydown E keypress
      // (o xterm também processa Enter no keypress — o \r vazava e SUBMETIA).
      // ESC+CR = alt+enter: nativo no claude; no codex o pane nasce com
      // insert_newline bindado em alt-enter (-c no pty.ts).
      if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
        if (ev.type === 'keydown') {
          window.synkora.pty.write(paneId, '\x1b\r')
        }
        return false
      }
      // Shift+Tab = ESC[Z (cicla modos nos TUIs: bypass no claude, plan/modo
      // no codex) — sem isso o browser usa a tecla para NAVEGAÇÃO DE FOCO e
      // ela nunca chega ao terminal.
      if (ev.key === 'Tab' && ev.shiftKey && !ev.ctrlKey && !ev.altKey) {
        if (ev.type === 'keydown') window.synkora.pty.write(paneId, '\x1b[Z')
        return false
      }
      // Ctrl+Alt+… é a faixa de atalhos da aba Panes (ancorar nó, trocar de
      // pane, mosaico, próximo 🖐). Nem claude nem codex usam essa combinação;
      // deixar passar faria o TUI receber lixo. O listener global vive no
      // PanesView, em fase de captura — aqui só é preciso não repassar.
      if (ev.ctrlKey && ev.altKey && ev.type === 'keydown') return false
      // Ctrl+A = "selecionar tudo e apagar" o INPUT do TUI. A seleção do
      // xterm é visual e o editor do CLI não a conhece — o equivalente real
      // é limpar o input inteiro. Sequência validada em sonda de PTY real
      // (claude 2.1.216 e codex): por linha, Ctrl+K (mata após o cursor) +
      // Ctrl+U (mata antes) + Backspace (junta com a linha de cima) — ^U
      // sozinho só limpa a LINHA ATUAL em multilinha, e ^C interromperia
      // resposta em andamento. FATIADO a 20ms: rajada única cai na detecção
      // de paste do editor e os controles são filtrados (sondado).
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'a' && kind !== 'shell') {
        if (ev.type === 'keydown') {
          for (let i = 0; i < 40; i++) {
            window.setTimeout(() => window.synkora.pty.write(paneId, '\x0b\x15\x7f'), i * 20)
          }
        }
        return false
      }
      // Ctrl+Shift+C = copiar seleção (atalho clássico de terminal).
      if (ev.ctrlKey && ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c') {
        if (ev.type === 'keydown' && term.hasSelection()) {
          void navigator.clipboard.writeText(term.getSelection())
          term.clearSelection()
        }
        return false
      }
      // Ctrl+C COM seleção = copiar (seleção visível é intenção de cópia,
      // padrão VS Code no Windows); sem seleção segue cru = interrupt do TUI.
      if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 'c') {
        if (!term.hasSelection()) return true
        if (ev.type === 'keydown') {
          void navigator.clipboard.writeText(term.getSelection())
          term.clearSelection()
        }
        return false
      }
      if (ev.type !== 'keydown') return true
      // Ctrl+V com o terminal focado: cola JÁ no keydown (caminho garantido).
      // O evento paste nativo que pode vir logo atrás é engolido pela trava.
      if (ev.type === 'keydown' && ev.ctrlKey && ev.key.toLowerCase() === 'v') {
        lastManualPaste = Date.now()
        doPaste(null)
        return false
      }
      return true
    })

    // Colagem CERTEIRA com dedupe: o keydown acima cobre o terminal focado;
    // este listener cobre paste vindo por outros caminhos (menu/contexto) e
    // ENGOLE o paste nativo duplicado logo após o manual.
    let lastManualPaste = 0
    const doPaste = (clipText: string | null): void => {
      if (window.synkora.clipboard.hasImage()) {
        if (imagePasteProjectId) {
          void window.synkora.clipboard.saveImage(imagePasteProjectId).then((path) => {
            if (path) window.synkora.pty.write(paneId, `(veja a imagem: ${path}) `)
          })
        } else {
          window.synkora.pty.write(paneId, '\x16')
        }
        return
      }
      if (clipText !== null) {
        if (clipText) term.paste(clipText)
        return
      }
      void window.synkora.clipboard.readText().then((text) => {
        if (text) term.paste(text)
      })
    }
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (Date.now() - lastManualPaste < 400) return // já colado pelo keydown
      doPaste(e.clipboardData?.getData('text/plain') ?? '')
    }
    container.addEventListener('paste', onPaste, true)

    // Clique direito = copiar a seleção (e limpar); sem seleção = colar.
    // Padrão de terminal (Windows Terminal) — sem menu nativo, que no
    // Windows quebraria o foco da janela.
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
      } else {
        doPaste(null)
      }
    }
    container.addEventListener('contextmenu', onContextMenu)

    // SOLTAR ARQUIVOS NO PANE = anexar: o main copia para .synkora/attachments
    // do projeto e os caminhos das CÓPIAS entram no composer via term.paste
    // (bracketed paste — nada é enviado sozinho; o usuário revisa e dá Enter).
    // Pane sem projeto armado cola o path original. Electron 43: File.path
    // morreu — o caminho vem do preload (webUtils.getPathForFile).
    const quoteDropPath = (p: string): string => (/\s/.test(p) ? `"${p}"` : p)
    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
      container.classList.add('drop-target')
    }
    const onDragLeave = (): void => container.classList.remove('drop-target')
    const onDrop = (e: DragEvent): void => {
      container.classList.remove('drop-target')
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      e.preventDefault()
      e.stopPropagation()
      const dropped = Array.from(files)
        .map((f) => window.synkora.pathForFile(f))
        .filter((p): p is string => !!p)
      if (dropped.length === 0) return
      const typePaths = (paths: string[]): void => {
        if (paths.length) term.paste(paths.map(quoteDropPath).join(' ') + ' ')
      }
      if (imagePasteProjectId) {
        void window.synkora.attachments
          .import(imagePasteProjectId, dropped)
          .then((saved) => typePaths(saved.length ? saved : dropped))
          .catch(() => typePaths(dropped))
      } else {
        typePaths(dropped)
      }
    }
    container.addEventListener('dragover', onDragOver)
    container.addEventListener('dragleave', onDragLeave)
    container.addEventListener('drop', onDrop)

    term.open(container)

    // Links de ARQUIVO usam o provider nativo do xterm (cursor + sublinhado),
    // mas a decisão de tornar algo clicável pertence ao main: só volta como
    // link se existir e o caminho real estiver dentro do projeto/cwd ARMADO do
    // pane. A linha lógica inclui continuações visuais, então paths compridos
    // continuam clicáveis mesmo quando quebram na borda do terminal.
    let fileLinksDisposed = false
    const fileLinkCache = new Map<string, Promise<Array<{ start: number; length: number; text: string }>>>()
    const fileLinkProvider: ILinkProvider | null =
      projectId && window.synkora.files?.terminalLinks
        ? {
            provideLinks: (bufferLineNumber, callback): void => {
              const buffer = term.buffer.active
              const requested = bufferLineNumber - 1
              if (requested < 0 || requested >= buffer.length) {
                callback(undefined)
                return
              }

              let first = requested
              while (first > 0 && buffer.getLine(first)?.isWrapped) first--
              let last = requested
              while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped) last++

              // Protege o IPC contra uma única linha patológica com milhares
              // de wraps. Linhas normais de path ocupam 1–4 linhas físicas.
              const maxPhysical = Math.max(1, Math.floor(16_000 / Math.max(1, term.cols)))
              if (last - first + 1 > maxPhysical) {
                first = Math.max(first, requested - Math.floor(maxPhysical / 2))
                last = Math.min(last, first + maxPhysical - 1)
              }

              const columns = term.cols
              const parts: string[] = []
              const offsetCells: Array<{ startX: number; endX: number; y: number }> = []
              for (let line = first; line <= last; line++) {
                const bufferLine = buffer.getLine(line)
                for (let x = 0; x < columns; x++) {
                  const cell = bufferLine?.getCell(x)
                  const width = cell?.getWidth() ?? 1
                  // Segunda metade de um glifo largo: a primeira célula já
                  // carrega os caracteres e ocupa as duas colunas visuais.
                  if (width === 0) continue
                  const chars = cell?.getChars() || ' '
                  parts.push(chars)
                  const position = {
                    startX: x + 1,
                    endX: Math.min(columns, x + Math.max(1, width)),
                    y: line + 1
                  }
                  // O parser devolve offsets UTF-16. Emoji/combinações podem
                  // ter várias code units na mesma célula, portanto cada uma
                  // aponta explicitamente para a geometria visual do glifo.
                  for (let unit = 0; unit < chars.length; unit++) offsetCells.push(position)
                }
              }
              const logicalText = parts.join('').replace(/\s+$/u, '')
              if (!logicalText) {
                callback(undefined)
                return
              }

              let request = fileLinkCache.get(logicalText)
              if (!request) {
                request = window.synkora.files.terminalLinks(projectId, paneId, logicalText)
                fileLinkCache.set(logicalText, request)
                if (fileLinkCache.size > 192) {
                  const oldest = fileLinkCache.keys().next().value
                  if (oldest !== undefined) fileLinkCache.delete(oldest)
                }
              }

              void request
                .then((matches) => {
                  if (fileLinksDisposed) return
                  // Um resize pode refluir o buffer enquanto o main valida o
                  // arquivo. Nesse caso o xterm pedirá os links de novo; nunca
                  // devolvemos ranges calculados para a grade antiga.
                  if (term.cols !== columns || term.buffer.active !== buffer) {
                    callback(undefined)
                    return
                  }
                  const links = matches.map((match): ILink | null => {
                    const endIndex = match.start + match.length - 1
                    const startCell = offsetCells[match.start]
                    const endCell = offsetCells[endIndex]
                    if (!startCell || !endCell) return null
                    return {
                      text: match.text,
                      range: {
                        start: { x: startCell.startX, y: startCell.y },
                        end: { x: endCell.endX, y: endCell.y }
                      },
                      decorations: { pointerCursor: true, underline: true },
                      activate: (_event, candidate): void => {
                        // F3-c4: o desfecho markdown volta por push do main ao
                        // HOST (files:navigate) — um caminho só para clique
                        // vindo do host ou da view de panes.
                        void window.synkora.files.openTerminalFile(projectId, paneId, candidate)
                      }
                    }
                  }).filter((link): link is ILink => link !== null)
                  callback(links.length ? links : undefined)
                })
                .catch(() => {
                  if (!fileLinksDisposed) callback(undefined)
                })
            }
          }
        : null
    const disposeFileLinks = fileLinkProvider ? term.registerLinkProvider(fileLinkProvider) : null

    // Destino do SynVoice é o terminal REALMENTE focado, nunca o primeiro
    // pane montado nem o pane ampliado. `term.paste` preserva bracketed paste e
    // não acrescenta Enter; quebras de linha são achatadas para uma fala nunca
    // executar dois comandos sem revisão explícita.
    // F3-c4/c5: este componente monta nos DOIS processos (host: maestros;
    // view: execução) — a classe da página diz onde estamos, e é ela que liga
    // os relays de activity e de foco de ditado para o outro lado.
    const inPanesView = document.body.classList.contains('panes-view-page')
    const voiceTargetId = `terminal:${paneId}`
    const onVoiceFocus = (): void => {
      if (!voiceEnabledRef.current) return
      // F3-c5: na VIEW de panes o SynVoice (host) não enxerga este registry —
      // o foco de ditado é reportado ao main, que responde ao host na entrega.
      if (inPanesView) {
        window.synkora.panesView.reportVoiceFocus(
          voiceLabelRef.current?.trim() || 'painel ativo'
        )
      }
      setSynVoiceTarget({
        id: voiceTargetId,
        label: voiceLabelRef.current?.trim() || 'painel ativo',
        element: container,
        isAvailable: () =>
          voiceEnabledRef.current && isSynVoiceElementVisible(container),
        focus: () => term.focus(),
        insert: (rawText) => {
          const text = rawText
            .replace(/[\u0000-\u001f\u007f]/g, (char) => (char === '\n' || char === '\r' ? ' ' : ''))
            .replace(/\s+/g, ' ')
            .trim()
          if (!text) return
          term.focus()
          term.paste(text)
          onUserInput?.()
        }
      })
    }
    container.addEventListener('focusin', onVoiceFocus)

    // WebGL deixa o render nítido; se o contexto cair (driver/GPU), volta ao
    // renderer DOM sozinho — nunca pode derrubar o pane.
    let webgl: WebglAddon | null = null
    if (webglLive < WEBGL_BUDGET) {
      try {
        webgl = new WebglAddon()
        webglLive++
        webgl.onContextLoss(() => {
          webgl?.dispose()
          webgl = null
          webglLive = Math.max(0, webglLive - 1)
        })
        term.loadAddon(webgl)
      } catch {
        if (webgl) webglLive = Math.max(0, webglLive - 1)
        webgl = null
      }
    }

    // O guard combina caixa computada e retângulo de layout. Um elemento dentro
    // de ancestral display:none pode conservar width/height no CSS sem possuir
    // pixels reais; ele não pode autorizar fit/spawn. Qualquer caixa positiva é
    // válida: os pisos de cols/rows protegem o xterm e panes minúsculos não ficam
    // presos para sempre esperando cruzar um limiar arbitrário.
    const contentBox = (): { w: number; h: number } => {
      const cs = getComputedStyle(container)
      return { w: parseFloat(cs.width) || 0, h: parseFloat(cs.height) || 0 }
    }
    const hasRealSize = (): boolean => {
      const { w, h } = contentBox()
      return container.getClientRects().length > 0 && w > 0 && h > 0
    }
    const sizeKey = `synkora.paneSize.${paneId}`
    const readSavedLayout = (): { cols: number; rows: number } | undefined => {
      const raw = localStorage.getItem(sizeKey)
      if (!raw) return undefined

      // v2 carimba geometria, fonte e kind pelo sizeGroup. Uma medida de outra
      // caixa nunca pode ganhar do fallback atual só por ter o mesmo paneId.
      try {
        const saved = JSON.parse(raw) as { group?: unknown; cols?: unknown; rows?: unknown }
        if (saved.group !== (groupRef.current ?? null)) return undefined
        const cols = Number(saved.cols)
        const rows = Number(saved.rows)
        if (!Number.isInteger(cols) || cols < 2 || !Number.isInteger(rows) || rows < 1) {
          return undefined
        }
        return { cols, rows }
      } catch {
        // O formato legado (`120x30`) só é seguro para callers sem sizeGroup.
        // Board/canvas não tinham assinatura suficiente e o descartam.
        if (groupRef.current) return undefined
        const legacy = /^(\d+)x(\d+)$/.exec(raw)
        return legacy ? { cols: Number(legacy[1]), rows: Number(legacy[2]) } : undefined
      }
    }

    // Estado VIVO do pane (chip ●/◌/■ no titlebar): saída = rodando; 4s sem
    // saída = esperando; exit = parado. Só publica quando MUDA.
    const setActivity = useStore.getState().setPaneActivity
    let actState: 'run' | 'idle' | 'dead' | null = null
    let actTimer: number | undefined
    const mark = (state: 'run' | 'idle' | 'dead'): void => {
      if (actState === state) return
      actState = state
      setActivity(paneId, state)
      if (inPanesView) window.synkora.panesView.reportActivity(paneId, state)
    }

    // Estado do ciclo create: um fit anterior à resolução do IPC nunca pode
    // tentar redimensionar um PTY que ainda não existe.
    let started = false
    let ptyReady = false
    let disposed = false

    // ————————————————————————————————————————————————————————————————————
    // LAYOUT: FONTE CONSTANTE, TERMINAL ELÁSTICO (o jeito normal)
    //
    // A fonte NUNCA cresce para preencher a caixa. Tentei isso (colunas fixas +
    // fonte elástica até 20px) e o resultado ficou FEIO: pane largo virava letra
    // gigante. Densidade de texto é parte da identidade visual do terminal — ela
    // fica em 13px (12/11 em mosaico denso, via prop) e pronto.
    //
    // Então o terminal é elástico como em qualquer app de terminal de verdade:
    // as colunas seguem a caixa. Codex/shell usam o reflow do xterm; o Claude
    // redesenha seu frame fullscreen. Nenhum caminho altera a fonte configurada.
    // ————————————————————————————————————————————————————————————————————
    /** Mede sem aplicar. A guarda de NaN é necessária: `NaN < minCols` é
     *  false, então os pisos abaixo NÃO protegeriam desse caso sozinhos. */
    const propose = (): { cols: number; rows: number } | null => {
      if (!hasRealSize()) return null
      const d = fit.proposeDimensions()
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null
      // Em uma caixa VISÍVEL, o FitAddon é o limite físico absoluto. Pisos são
      // úteis apenas no boot oculto; forçá-los aqui cria uma grade maior que o
      // host e recorta a borda direita/últimas linhas em fontes largas.
      return { cols: Math.max(2, d.cols), rows: Math.max(1, d.rows) }
    }

    let rememberTimer: number | undefined
    const rememberLayout = (): void => {
      localStorage.setItem(
        sizeKey,
        JSON.stringify({ group: groupRef.current ?? null, cols: term.cols, rows: term.rows })
      )
      // O cache só existe quando o caller fornece uma identidade explícita. A
      // chave separa caixas/fontes. Mantemos LRU limitado: durante a vida do app
      // o mesmo pane pode assentar em muitas dimensões diferentes.
      const group = groupRef.current
      if (group) {
        MEASURED_BY_GROUP.delete(group)
        MEASURED_BY_GROUP.set(group, { cols: term.cols, rows: term.rows })
        while (MEASURED_BY_GROUP.size > MAX_MEASURED_GROUPS) {
          const oldest = MEASURED_BY_GROUP.keys().next().value
          if (oldest === undefined) break
          MEASURED_BY_GROUP.delete(oldest)
        }
      }
    }

    // Fit visual e SIGWINCH acompanham o gesto em rAF; disco/cache esperam a
    // caixa assentar. Isso evita centenas de writes síncronos por arrasto.
    const scheduleRememberLayout = (): void => {
      window.clearTimeout(rememberTimer)
      rememberTimer = window.setTimeout(() => {
        rememberTimer = undefined
        rememberLayout()
      }, 180)
    }

    /** ORDEM OFICIAL (demo do xterm e `_updatePtyDimensions` do VS Code): xterm
     *  PRIMEIRO, e o que vai ao PTY é lido DE VOLTA do xterm — nunca o valor
     *  que o fit calculou. */
    const commit = (cols: number, rows: number): void => {
      const changed = cols !== term.cols || rows !== term.rows
      if (!changed) {
        scheduleRememberLayout()
        return
      }

      term.resize(cols, rows)
      if (ptyReady) window.synkora.pty.resize(paneId, term.cols, term.rows)
      scheduleRememberLayout()
    }

    // O Claude roda no alternate screen (NO_FLICKER): durante resize vivo cada
    // SIGWINCH substitui o mesmo frame, em vez de gravar cópias no transcript.
    // Transições estruturais ainda usam `stage-transition` e assentam de uma vez.
    const initial = propose()
    if (initial) {
      // Pré-fit VISUAL apenas: usa os mesmos pisos do restante do pipeline,
      // mas não publica cache nem toca no PTY. A caixa ainda pode estar no meio
      // de uma animação; o spawn aguarda as duas amostras estáveis abaixo.
      term.resize(initial.cols, initial.rows)
    } else {
      // Pane que NASCE ESCONDIDO (ajudante criado em segundo plano, nó não
      // ancorado, outro universo) não pode ser medido — e o xterm ficaria nos
      // 80x24 de fábrica, que é o tamanho que vai para o spawn do ConPTY.
      // Ordem de palpite: MEDIDA REAL de um irmão do mesmo ladrilho (exata, e
      // por isso o resize ao aparecer vira no-op — sem repintura, sem cópia
      // duplicada) > último tamanho bom DESTE pane > estimativa da geometria >
      // padrão largo. O tamanho persistido só ganha quando foi validado pelo
      // FitAddon exatamente para a geometria/fonte/kind atuais.
      const measured = groupRef.current ? MEASURED_BY_GROUP.get(groupRef.current) : undefined
      const previous = readSavedLayout()
      const fb = measured ?? previous ?? fallbackRef.current
      const cols = fb?.cols ?? 120
      const rows = fb?.rows ?? 30
      term.resize(Math.max(minColsRef.current, cols), Math.max(minRowsRef.current, rows))
    }

    // Assina os eventos ANTES de criar o PTY para não perder o output inicial.
    // `term.open()` pode pintar um frame vazio; só conta o primeiro render que
    // acontece DEPOIS de bytes reais do processo entrarem no xterm.
    let receivedPtyData = false
    let firstFrameReported = false
    const disposeFirstFrame = term.onRender(() => {
      if (!receivedPtyData || firstFrameReported) return
      firstFrameReported = true
      window.synkora.pty.markFirstFrame(paneId)
    })
    const offData = window.synkora.pty.onData((id, data) => {
      if (id !== paneId) return
      receivedPtyData = true
      term.write(data)
      mark('run')
      window.clearTimeout(actTimer)
      actTimer = window.setTimeout(() => mark('idle'), 4000)
    })
    // /clear e /new: o main sabe pelo INPUT digitado (não por adivinhação de
    // texto) e já limpou o buffer do BACKEND via ConptyClearPseudoConsole.
    // Aqui basta descartar o SCROLLBACK (ED3): a tela visível é repintada pelo
    // próprio CLI no frame seguinte, e sem isto a conversa "apagada"
    // continuaria acessível rolando para cima.
    const offReset = window.synkora.pty.onReset
      ? window.synkora.pty.onReset((id) => {
          if (id === paneId) term.write('\x1b[3J')
        })
      : () => undefined
    const offExit = window.synkora.pty.onExit((id, exitCode) => {
      if (id !== paneId) return
      term.write(`\r\n\x1b[90m[processo encerrado · código ${exitCode}]\x1b[0m\r\n`)
      window.clearTimeout(actTimer)
      mark('dead')
    })

    // ————————————————————————————————————————————————————————————————————
    // O PTY SÓ NASCE COM O LAYOUT PARADO.
    //
    // Medido no app real: o pane era criado com 63x20 e logo depois ia para
    // 176x39 — porque ele nasce DURANTE a animação da coluna do mapa (420ms) e
    // se mediu no meio dela. O claude bootava em 63 colunas, imprimia o banner,
    // e reimprimia no tamanho certo: DUAS cópias antes de o usuário tocar em
    // nada. O bloqueio de fit (`stage-transition`) existia, mas o SPAWN não
    // passava por ele — era o buraco.
    //
    // Pane visível agora espera duas medidas iguais. Só pane realmente oculto
    // usa a medida estável de um irmão (ou o fallback após a espera limite).
    // O CLI nasce UMA vez, no melhor tamanho definitivo disponível.
    // ————————————————————————————————————————————————————————————————————
    const startPty = (): void => {
      if (started) return
      started = true
      if (startupMessage) {
        term.write(`\x1b[90m[synkora] ${startupMessage}\x1b[0m\r\n`)
      }
      const spawnCols = term.cols
      const spawnRows = term.rows
      void window.synkora.pty
        .create({
          id: paneId,
          cwd,
          kind,
          seatId,
          taskId,
          initialPrompt,
          model,
          cliArgs,
          appendSystemPrompt,
          logFile,
          cols: spawnCols,
          rows: spawnRows
        })
        .then((created) => {
          if (disposed) return
          if (!created) {
            onCreateError(new Error('o processo recusou ou cancelou a abertura deste terminal'))
            return
          }
          ptyReady = true
          // Normalmente é no-op: o spawn já esperou a caixa estável. Cobre só
          // uma mudança legítima ocorrida enquanto o IPC de create estava em voo.
          if (term.cols !== spawnCols || term.rows !== spawnRows) {
            window.synkora.pty.resize(paneId, term.cols, term.rows)
          }
        })
        .catch((err: unknown) => {
          if (!disposed) onCreateError(err)
        })
    }
    function onCreateError(err: unknown): void {
      // cwd morto (pasta renomeada/movida fora do app) e afins: o
      // PtyManager.create lança de propósito, o invoke REJEITA e — sem catch —
      // a mensagem morria como unhandled rejection. O pane ficava PRETO e
      // vazio, sem cursor, sem erro e sem nem o chip de estado (o mark nunca
      // saía de null).
      term.write(
        `\r\n\x1b[31m[synkora] não foi possível abrir o pane: ${
          err instanceof Error ? err.message : String(err)
        }\x1b[0m\r\n`
      )
      mark('dead')
    }

    const disposeInput = term.onData((data) => {
      window.synkora.pty.write(paneId, data)
      onUserInput?.()
    })

    // Rede de segurança do renderer DOM (pane que estourou o orçamento de
    // WebGL): rolar o scrollback enquanto o TUI redesenha deixava texto
    // SOBREPOSTO. Com WebGL o frame já sai completo, então só vale no modo DOM
    // — e mesmo lá, COALESCIDO em rAF: marcar o viewport inteiro como sujo a
    // cada linha rolada custava um refresh por linha numa rolagem contínua.
    let refreshRaf = 0
    const disposeScroll = term.onScroll(() => {
      if (webgl || refreshRaf) return
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = 0
        term.refresh(0, term.rows - 1)
      })
    })

    // Antes do spawn esperamos a caixa parar, para o CLI não nascer no meio da
    // animação do palco. Depois que o PTY está pronto, resize é coalescido em
    // requestAnimationFrame: o terminal acompanha o pane continuamente e o
    // renderer fullscreen do Claude substitui o mesmo frame sem criar cópias.
    let fitTimer: number | undefined
    let metricRaf = 0
    let resizeRaf = 0
    let lastBox = ''
    const applyRequestedTypography = (): boolean => {
      let changed = false
      const family = terminalFontStack(fontFamilyRef.current)
      if (term.options.fontSize !== fontRef.current) {
        term.options.fontSize = fontRef.current
        changed = true
      }
      if (term.options.lineHeight !== lineHeightRef.current) {
        term.options.lineHeight = lineHeightRef.current
        changed = true
      }
      if (term.options.fontFamily !== family) {
        term.options.fontFamily = family
        changed = true
      }
      if (changed) {
        lastBox = ''
        // Trocar fonte invalida o atlas WebGL inteiro. Sem o clear+refresh o
        // canvas podia redesenhar só as linhas tocadas depois da mudança.
        term.clearTextureAtlas()
        term.refresh(0, term.rows - 1)
      }
      return changed
    }

    const applyLiveFit = (): void => {
      if (document.body.classList.contains('stage-transition')) {
        window.clearTimeout(fitTimer)
        fitTimer = window.setTimeout(scheduleFit, 50)
        return
      }
      if (!hasRealSize()) return

      if (applyRequestedTypography()) {
        if (metricRaf) cancelAnimationFrame(metricRaf)
        metricRaf = requestAnimationFrame(() => {
          metricRaf = 0
          scheduleFit()
        })
        return
      }

      const d = propose()
      if (d) commit(d.cols, d.rows)
    }

    function scheduleFit(): void {
      if (ptyReady) {
        if (resizeRaf) return
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0
          applyLiveFit()
        })
        return
      }

      window.clearTimeout(fitTimer)
      fitTimer = window.setTimeout(() => {
        // O IPC de criação pode ter terminado durante o debounce inicial.
        if (ptyReady) {
          scheduleFit()
          return
        }
        if (document.body.classList.contains('stage-transition')) {
          scheduleFit()
          return
        }

        // Pane oculto não tem caixa para validar. Em especial, duas leituras
        // 0x0 iguais NÃO podem autorizar o spawn.
        if (!hasRealSize()) {
          lastBox = ''
          return
        }

        // Fonte e caixa percorrem o mesmo debounce. A troca da métrica precisa
        // de um frame para chegar ao renderer; depois disso haverá exatamente
        // UM commit de cols×rows, nunca a dupla applyLayout + rAF anterior.
        if (applyRequestedTypography()) {
          if (metricRaf) cancelAnimationFrame(metricRaf)
          metricRaf = requestAnimationFrame(() => {
            metricRaf = 0
            scheduleFit()
          })
          return
        }

        const { w, h } = contentBox()
        const box = `${Math.round(w)}x${Math.round(h)}`
        // exige DUAS medidas iguais seguidas: uma pausa curta no meio do
        // arrasto não pode contar como fim de gesto, senão volta a virar vários
        // resizes (= vários banners empilhados)
        if (box !== lastBox) {
          lastBox = box
          scheduleFit()
          return
        }
        const d = propose()
        if (!d) {
          lastBox = ''
          scheduleFit()
          return
        }
        commit(d.cols, d.rows)
        // caixa parada e medida: é AGORA que o CLI pode nascer
        startPty()
      }, 220)
    }
    // A opção visual da fonte acompanha o prop imediatamente. Colunas e linhas
    // só mudam no commit estável acima, sempre junto do PTY: assim panes
    // equivalentes convergem sem linhas fantasmas nem SIGWINCHs intermediários.
    relayoutRef.current = () => {
      lastBox = ''
      if (applyRequestedTypography()) {
        if (metricRaf) cancelAnimationFrame(metricRaf)
        metricRaf = requestAnimationFrame(() => {
          metricRaf = 0
          scheduleFit()
        })
      } else {
        scheduleFit()
      }
    }
    const observer = new ResizeObserver(scheduleFit)
    observer.observe(container)
    // relayout de ASSENTAMENTO: o pane nasce durante a animação de entrada do
    // palco — re-mede quando o layout estabiliza.
    const settleTimer = window.setTimeout(scheduleFit, 350)
    // REDE para o pane que nasce ESCONDIDO (ajudante criado pelo Maestro em
    // segundo plano, nó não ancorado, outro universo): ele nunca estabiliza
    // porque não tem caixa para medir.
    //
    // Espera até 4s por uma medida REAL de um irmão do mesmo ladrilho antes de
    // cair na estimativa. A estimativa erra feio — medido: ela dizia 63x19 onde
    // o real era 94x28, e o CLI nascia num frame estreito cujas quebras de
    // linha sobravam por baixo do frame largo depois (os fragmentos
    // ".md file…", "-opus-5`…" que apareciam na tela). Ajudantes nascem em
    // bloco, então basta um deles aparecer para todos acertarem.
    let bootWait = 0
    const bootTimer = window.setInterval(() => {
      if (started) {
        window.clearInterval(bootTimer)
        return
      }

      // O atalho de cache/fallback é EXCLUSIVO de pane realmente escondido
      // (display:none em algum ancestral). Um pane visível, ainda estreito no
      // meio da transição, precisa esperar as duas amostras reais acima.
      if (container.getClientRects().length > 0) return
      if (document.body.classList.contains('stage-transition')) return
      bootWait += 200
      const group = groupRef.current
      const measured = group ? MEASURED_BY_GROUP.get(group) : undefined
      if ((measured && bootWait >= GROUP_CACHE_GRACE_MS) || bootWait >= WAIT_FOR_GROUP_MS) {
        window.clearInterval(bootTimer)
        if (measured) {
          term.resize(
            Math.max(minColsRef.current, measured.cols),
            Math.max(minRowsRef.current, measured.rows)
          )
        } else {
          // fallbackSize pode ter mudado enquanto o pane ficou oculto; usa o
          // valor mais recente no instante do spawn, sem remontar o terminal.
          const previous = readSavedLayout()
          const fb = previous ?? fallbackRef.current
          const cols = fb?.cols ?? 120
          const rows = fb?.rows ?? 30
          term.resize(Math.max(minColsRef.current, cols), Math.max(minRowsRef.current, rows))
        }
        startPty()
      }
    }, 200)

    return () => {
      disposed = true
      fileLinksDisposed = true
      observer.disconnect()
      window.clearTimeout(fitTimer)
      window.clearTimeout(rememberTimer)
      window.clearTimeout(settleTimer)
      window.clearInterval(bootTimer)
      window.clearTimeout(actTimer)
      relayoutRef.current = () => undefined
      if (metricRaf) cancelAnimationFrame(metricRaf)
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      if (refreshRaf) cancelAnimationFrame(refreshRaf)
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('dragleave', onDragLeave)
      container.removeEventListener('drop', onDrop)
      container.removeEventListener('focusin', onVoiceFocus)
      clearSynVoiceTarget(voiceTargetId)
      disposeScroll.dispose()
      disposeFirstFrame.dispose()
      disposeInput.dispose()
      offData()
      offReset()
      offExit()
      disposeFileLinks?.dispose()
      window.synkora.pty.kill(paneId)
      if (webgl) {
        webgl = null
        webglLive = Math.max(0, webglLive - 1)
      }
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, cwd, kind, projectId, seatId, taskId, initialPrompt, model, cliArgs, appendSystemPrompt, logFile, startupMessage])

  // Fonte/grupo/pisos em efeito SEPARADO — não podem entrar nas deps do efeito de
  // cima, senão a mudança remontaria o xterm e mataria o PTY. Ambos apenas
  // invalidam a amostra e entram no mesmo pipeline estável usado pela caixa.
  useLayoutEffect(() => {
    relayoutRef.current()
  }, [
    requestedFont,
    requestedLineHeight,
    requestedFontFamily,
    requestedMinCols,
    requestedMinRows,
    sizeGroup
  ])

  return <div ref={containerRef} className="terminal-host" />
}
