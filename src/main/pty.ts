import { spawn, type IPty } from '@lydell/node-pty'
import { execFile, spawn as spawnChildProcess, type ChildProcessWithoutNullStreams } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WebContents } from 'electron'
import { hasFatalResumeError, takeResumeProbeChunk } from './ptyRecovery'
import {
  redactSensitiveText,
  sanitizedPaneEnvironment,
  StreamingSensitiveRedactor
} from './securityRedaction'
import {
  inspectShellSubmission,
  type RuntimeSecurityDecision
} from './runtimeSecurityGuard'
import { freshWindowsPath } from './winPath'

// Limpa a saída crua do PTY para o transcript (helper_output, lastlines,
// tails da caixa-preta). SONDADO em TUI claude real (2026-08-03,
// scratchpad/probe-tee-garble.mjs): APAGAR as sequências de cursor era o que
// embaralhava o texto — o TUI pinta com CUF/CUP por cima do que já existe, e
// sem modelar o movimento as palavras fundiam ("transcriptpreservapalavras…",
// "helper_outpt" com letra comida nas leituras reais do diário). Regras:
// CUF (\e[nC) e CHA (\e[nG) = célula/coluna pulada → UM espaço separador;
// CUP (\e[l;cH) na MESMA linha → espaço, linha NOVA → quebra (rastreio da
// linha absoluta); CUU/CUD/CNL/CPL/VPA → quebra. TUIs redesenham muito —
// linhas repetidas continuam suprimidas no flushLog (e agora repaints do
// mesmo conteúdo reagrupam em linhas IDÊNTICAS, então o dedupe pega mais).
// Exportada só para a suíte de regressão (test:pty-transcript).
export function cleanPtyChunk(raw: string): string {
  const stripped = raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // seleção de charset/keypad e DECSC/DECRC (ESC ( B, ESC =, ESC 7/8…):
    // fora do alcance do \x1b[@-_] — viravam lixo "(B", "78" no transcript
    .replace(/\x1b[()#%*+./][0-9A-Za-z@]/g, '')
    .replace(/\x1b[=>78]/g, '')
  let out = ''
  let lastRow = -1
  const separator = (): void => {
    if (out && !out.endsWith('\n') && !out.endsWith(' ')) out += ' '
  }
  const lineBreak = (): void => {
    if (out && !out.endsWith('\n')) out += '\n'
  }
  // params com <=> (kitty keyboard/modifyOtherKeys usam \e[>1u, \e[<u — sem
  // essa classe o CSI não casava e o payload vazava como texto)
  const token = /\x1b\[([0-9;?<=>]*)[ -/]*([@-~])|\x1b[@-_]|\r\n|\r|\n/g
  let index = 0
  let match: RegExpExecArray | null
  while ((match = token.exec(stripped))) {
    out += stripped.slice(index, match.index)
    index = token.lastIndex
    const whole = match[0]
    if (whole === '\n' || whole === '\r\n' || whole === '\r') {
      out += '\n'
      lastRow = -1
      continue
    }
    const final = match[2]
    if (!final) continue // ESC de 2 bytes restante — some sem rastro
    const params = match[1] ?? ''
    if (final === 'C' || final === 'G') {
      separator()
      continue
    }
    if (final === 'H' || final === 'f') {
      const row = Number(params.split(';')[0] || '1') || 1
      if (row === lastRow) separator()
      else {
        lineBreak()
        lastRow = row
      }
      continue
    }
    if (final === 'd') {
      const row = Number(params || '1') || 1
      if (row !== lastRow) {
        lineBreak()
        lastRow = row
      }
      continue
    }
    if (final === 'A' || final === 'B' || final === 'E' || final === 'F') {
      lineBreak()
      lastRow = -1
      continue
    }
    // SGR/EL/ED/modos privados etc.: sem efeito no texto
  }
  out += stripped.slice(index)
  return out
}

/** FRAMES DE ANIMAÇÃO DO TUI comiam letras no transcript (sonda 2026-08-04,
 *  bytes reais do shimmer codex em probe-codex-resume-mcp.mjs: cada frame
 *  repinta SÓ a janela destacada da palavra — "Working" → "orking" →
 *  "• king 4" — a cabeça da palavra genuinamente NÃO está no chunk, então o
 *  cleanPtyChunk não tem como reconstruí-la). A decisão vive aqui, pura e
 *  testável: comparando a linha limpa nova com a última emitida (núcleo =
 *  sem prefixo de glifo/espaço), contenção significa repintura da MESMA
 *  linha — 'drop' descarta fragmento menor/igual, 'replace' troca pela
 *  versão mais longa, 'keep' é linha nova de verdade. Núcleo longo (>80)
 *  nunca colapsa: linhas reais de log não são frames de animação. */
export function collapseRepaintFrame(
  previous: string,
  next: string
): 'drop' | 'replace' | 'keep' {
  const core = (value: string): string => value.replace(/^[•·*✻✽◦›❯\s]+/, '').trim()
  const letters = (value: string): string =>
    value.toLowerCase().replace(/[^a-zá-úà-ãç]/gi, '')
  const a = core(previous)
  const b = core(next)
  // linha SÓ de glifo/espaço ("•") é chrome de animação: além de inútil, ela
  // resetava a comparação e deixava frames vizinhos escaparem (medido no
  // replay da captura).
  if (!b) return 'drop'
  if (!a) return 'keep'
  if (a.length > 80 || b.length > 80) return 'keep'
  if (a === b) return 'drop'
  const la = letters(a)
  const lb = letters(b)
  if (la && lb && la !== lb) {
    // fragmento de animação difere em LETRAS (janela da palavra); linha
    // legítima numerada difere em DÍGITOS ("passo 1"/"passo 2" nunca colapsa)
    if (la.includes(lb)) return 'drop'
    if (lb.includes(la)) return 'replace'
    return 'keep'
  }
  if (a.includes(b)) return 'drop'
  if (b.includes(a)) return 'replace'
  return 'keep'
}

export type PaneKind = 'shell' | 'claude' | 'codex'

export interface PtyCreateOptions {
  id: string
  cwd: string
  kind: PaneKind
  /** Variáveis extras (ex.: CLAUDE_CONFIG_DIR do seat). */
  extraEnv?: Record<string, string>
  /** Prompt inicial: o CLI abre já executando esta instrução (pane de tarefa). */
  initialPrompt?: string
  /** Modelo escolhido pela política do departamento (flag --model do CLI). */
  model?: string
  /** Flags extras do CLI (ex.: --resume <id> para o modo pane do Maestro). */
  cliArgs?: string[]
  /** Persona injetada via --append-system-prompt (Maestro TUI embutido). */
  appendSystemPrompt?: string
  /** Dimensões iniciais (evita o TUI renderizar em 80x24 e embaralhar no resize). */
  cols?: number
  rows?: number
  /** Tee da saída (limpa de ANSI) para um transcript — o Maestro lê o pane. */
  logFile?: string
  /** Guarda reavaliada em cada flush do tee. O projeto pode começar a
   * rastrear `.synkora` enquanto um pane está vivo; nesse caso o transcript
   * para antes da próxima escrita, sem derrubar o terminal. */
  canWriteLog?: () => boolean
  /** Chamado quando a saída parece um PEDIDO DE APROVAÇÃO do CLI (heurística). */
  onAttention?: () => void
  /** Chamado quando o TUI reporta login expirado/ausente (marca o seat). */
  onLoginExpired?: () => void
  /** Chamado quando o processo do pane morre (limpeza de watchers no main).
   *  `outputTail` = últimas linhas limpas que o pane imprimiu — vai para a
   *  caixa-preta (morte em spawn era invisível no diário; caso 02/08). */
  onExit?: (exitCode: number, outputTail?: string[]) => void
  /** Notificação sem payload a cada chunk do processo. Usada apenas para
   *  marcos de latência; o conteúdo nunca sai do fluxo normal do terminal. */
  onOutput?: () => void
  /** Janela REAL de contexto lida do banner do TUI ("Opus 4.8 (1M context)"). */
  onCtxWindow?: (tokens: number) => void
  /** Chamado quando o usuário EXECUTA um /comando no pane (heurística sobre o
   *  input digitado: linha começando com "/" + Enter). Uso: /clear, /new e /fork
   *  invalidam o resume persistido do Maestro. */
  onCommand?: (cmd: string) => void
  /** Chamado quando o usuário submete a primeira mensagem não-slash. */
  onSubmit?: () => void
  /** Content-free decision emitted by the runtime terminal boundary. */
  onSecurityDecision?: (decision: RuntimeSecurityDecision) => void
  /** Chamado quando Claude/Codex recusam a sessão persistida — o main
   * invalida o id; o PtyManager se autocura sem o argumento de resume. */
  onResumeFail?: () => void
}

// Sinais de prompt de aprovação nos TUIs (claude e codex, en/pt).
const ATTENTION_RE =
  /(do you want|allow (this|command)|approve|permission|autorizar|deseja permitir|permitir\?|\by\/n\b|press enter to (approve|confirm)|1\.\s*yes)/i

// Sinais de LOGIN vencido/ausente no TUI — o seat precisa de /login de novo.
const LOGIN_RE =
  /(login expired|please run \/login|not logged in|oauth token (has )?expired|token de login expirou)/i

const CLI_COMMAND: Record<Exclude<PaneKind, 'shell'>, string> = {
  claude: 'claude',
  codex: 'codex'
}

export class PtyManager {
  private ptys = new Map<string, IPty>()
  /** timestamp da última saída de cada pane — heurística de "ocioso" */
  private lastOutput = new Map<string, number>()
  /** timestamp do último TECLADO DO USUÁRIO por pane (write; inject não) */
  private lastKeyAt = new Map<string, number>()
  /** dimensões atuais — resize com o MESMO tamanho é no-op (o ConPTY
   *  redesenhava a tela e o TUI duplicava o banner logo após o spawn) */
  private sizes = new Map<string, string>()
  /** linha de input em digitação por pane (detecção de /comandos executados) */
  private inputBufs = new Map<string, string>()
  /** callback onCommand de cada pane vivo */
  private cmdHooks = new Map<string, (cmd: string) => void>()
  /** callback de submissão de mensagem (sem receber o texto digitado) */
  private submitHooks = new Map<string, () => void>()
  /** Shell-only guard. Agent composers may legitimately discuss secret paths. */
  private shellSecurity = new Map<
    string,
    {
      decide: (command: string, humanInput: boolean) => RuntimeSecurityDecision
      report?: (decision: RuntimeSecurityDecision) => void
      notify: (reason: string) => void
    }
  >()
  /** Fecha a sonda de startup também para injeções automáticas, sem fingir
   * que elas foram a primeira mensagem humana nas métricas. */
  private resumeProbeStops = new Map<string, () => void>()
  /** panes no meio de um bracketed paste (\e[200~ … \e[201~) — colado é
   *  TEXTO no editor do TUI, nunca comando */
  private pasting = new Set<string>()
  /** rabo de sequência ESC cortada entre writes (carry do feedInput — o
   *  \e[201~ fatiado perdia o fechamento do paste e o pane ficava "colando"
   *  para sempre; caso real 2026-07-30) */
  private escCarry = new Map<string, string>()
  /** pane no meio de uma string OSC/DCS (resposta automática do xterm a
   *  query do TUI) — epoch de entrada, para o cap de desistência */
  private inOsc = new Map<string, number>()
  /** último input classificado como HUMANO — válvula do composerBusy */
  private lastHumanAt = new Map<string, number>()
  /** rabo da saída CRUA por pane (~12KB) — limpo sob demanda em outputTail()
   *  (controle de ajudantes: o delegador lê o que o pane está mostrando) */
  private outBufs = new Map<string, string>()
  /** flush do tee (transcript) por pane, exposto para quem precisa do arquivo
   *  COMPLETO antes de agir (report de ajudante: fechar o pane com o debounce
   *  de 1,5s pendente truncava o final da resposta no transcript) */
  private flushers = new Map<string, () => void>()
  /** ConPTY v2 (conpty.dll do pacote) — ver o bloco no spawn. Ligado por
   *  padrão no Windows; settings.conptyDll=false desliga sem rebuild. */
  private conptyDll = process.platform === 'win32'
  /** Pasta (userData/prompts) onde a persona de cada pane vira ARQUIVO para
   *  o --append-system-prompt-file — nunca argv (limite do CreateProcess). */
  private promptDir: string | null = null
  /** INSTRUMENTAÇÃO TEMPORÁRIA: até quando registrar os chunks de cada pane
   *  depois de um resize (diagnóstico da repintura duplicada). */
  private probeUntil = new Map<string, number>()
  /** Geração lógica por paneId. Impede um timer de autocura antigo de
   *  ressuscitar um pane que o usuário já fechou ou que já foi substituído. */
  private generations = new Map<string, number>()
  /** Fallback de saída por objeto nativo. Alguns crashes do ConPTY não emitem
   * onExit; sem isto o Hub/watch/card ficaria vivo para sempre. */
  private exitFallbacks = new Map<
    string,
    { pty: IPty; force: () => void; timer?: NodeJS.Timeout }
  >()

  setConptyDll(enabled: boolean): void {
    this.conptyDll = process.platform === 'win32' && enabled
  }

  /** Broadcast da Fase 3 (docs/FASE3_PLANO.md §3): canais de CHROME
   *  (pane:lastlines, pty:effort, pty:model) são consumidos pelas DUAS views
   *  — o wc capturado no create só alcança a view que montou o pane. O index
   *  injeta o pushAll aqui; sem hook (testes/uso avulso), degrada para o wc.
   *  pty:data/pty:exit/pty:reset NUNCA passam por aqui: unicast por contrato
   *  (broadcast pintaria o mesmo buffer em dois xterms). */
  private broadcast: ((channel: string, ...args: unknown[]) => void) | null = null
  setBroadcast(fn: (channel: string, ...args: unknown[]) => void): void {
    this.broadcast = fn
  }
  private sendChrome(wc: WebContents, channel: string, ...args: unknown[]): void {
    if (this.broadcast) this.broadcast(channel, ...args)
    else if (!wc.isDestroyed()) wc.send(channel, ...args)
  }

  setPromptDir(dir: string): void {
    this.promptDir = dir
  }

  /** Arquivo por pane (sobrescrito a cada spawn — NUNCA apagado no exit: o
   *  respawn de mesmo id acabou de regravar o dele, mesma lição da corrida do
   *  arquivo MCP em F4.2). */
  private sysPromptFileFor(id: string): string | null {
    if (!this.promptDir) return null
    try {
      mkdirSync(this.promptDir, { recursive: true })
      return join(this.promptDir, `${id.replace(/[^A-Za-z0-9._-]/g, '-')}.sysprompt.md`)
    } catch {
      return null
    }
  }

  create(wc: WebContents, opts: PtyCreateOptions): boolean {
    if (this.ptys.has(opts.id)) return false
    // cwd morto (pasta renomeada/movida fora do app): o spawn do node-pty
    // estoura e derruba o invoke do renderer — falha limpa no lugar.
    if (!existsSync(opts.cwd)) {
      throw new Error(`pasta não encontrada: ${opts.cwd} — reloque o projeto na Home`)
    }
    const generation = (this.generations.get(opts.id) ?? 0) + 1
    this.generations.set(opts.id, generation)

    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : (process.env['SHELL'] ?? 'bash')
    // Panes de CLI abrem o shell já executando o comando; se o CLI não
    // estiver instalado, o erro aparece dentro do próprio terminal.
    let args: string[]
    // Persona/prompt inicial NÃO vão inline no comando: viram env vars que o
    // shell expande na hora ($env:X / "$X"). Missão com goal/scope ricos
    // estourava os ~32k do CreateProcess (erro 206 do ConPTY: o base64 do
    // -EncodedCommand infla ~2,7×) e o pane nascia morto.
    const promptEnv: Record<string, string> = {}
    if (opts.kind === 'shell') {
      // -ExecutionPolicy Bypass também no shell interativo (caso real
      // 2026-08-06: o pane do "▶ testar" digitou `npm run dev` e a política
      // Restricted bloqueou o npm.ps1 — mesma lição da F4.4, que só cobria o
      // caminho -EncodedCommand dos panes de CLI). Escopo de PROCESSO, não
      // mexe na máquina.
      args = isWin ? ['-NoLogo', '-ExecutionPolicy', 'Bypass'] : []
    } else {
      const quote = (text: string): string => {
        const flat = text.replace(/\s+/g, ' ').trim()
        if (!isWin) return `'${flat.replace(/'/g, `'\\''`)}'`
        // PS 5.1 NÃO escapa aspas duplas embutidas ao repassar um argumento
        // para exe nativo: uma `"` no meio do prompt fechava o quoting e o
        // resto virava argv solto ("unexpected argument 'o'"). E o parser do
        // FILHO come `"` cruas MESMO em token sem espaço (sondado em codex
        // real 2026-08-04, red/green por -EncodedCommand): -c
        // enabled_tools=["report",…] chegava como string "[report,…]" e o
        // reviewer ABORTAVA no boot ("invalid type: string, expected a
        // sequence"); valor simples tipo key="x" só sobrevivia por SORTE —
        // o -c trata TOML inválido como string crua. Pré-escapa (\" +
        // backslashes dobrados) SEMPRE que houver aspa embutida ou espaço.
        const native =
          flat.includes(' ') || flat.includes('"')
            ? flat.replace(/(\\*)"/g, '$1$1\\"')
            : flat
        return `'${native.replace(/'/g, "''")}'`
      }
      let command = CLI_COMMAND[opts.kind]
      // modelo vai QUOTADO e intacto — o sanitizador antigo comia os
      // colchetes de aliases reais como opus[1m] (virava "opus1m" e o CLI
      // rejeitava o modelo). codex: id em MINÚSCULAS — "GPT-5.6-Luna" (display
      // name vazado p/ política/delegate) dava 400 "model is not supported".
      const model = opts.model && opts.kind === 'codex' ? opts.model.toLowerCase() : opts.model
      if (model) command += ` --model ${quote(model)}`
      // Codex 0.146+ oferece o modo inline oficial. Ele mantém a conversa no
      // buffer normal do terminal, então o xterm publica um scrollback real e
      // uma barra proporcional. Precisa vir ANTES de `resume`, que é subcomando.
      if (opts.kind === 'codex') command += ' --no-alt-screen'
      for (const arg of opts.cliArgs ?? []) {
        // Args simples passam crus; qualquer coisa com espaço/aspas/URL vai
        // quotada (antes o strip destruía `-c chave="valor"` e paths).
        command += /^[\w.,:@%+/\\-]+$/.test(arg) ? ` ${arg}` : ` ${quote(arg)}`
      }
      if (opts.kind === 'codex') {
        // Shift+Enter nos panes: o Synkora manda ESC+CR (alt+enter). O codex
        // não tem binding padrão que o xterm alcance — bind explícito da ação
        // insert_newline (config validada no binário: valor inválido aborta).
        command += ` -c ${quote('tui.keymap.editor.insert_newline="alt-enter"')}`
      }
      // PS 5.1 também não escapa `"` embutida ao repassar VALOR DE VARIÁVEL
      // para exe nativo — mesmo pré-escape do quote(), aplicado no valor.
      const argEnv = (text: string): string =>
        isWin ? text.replace(/(\\*)"/g, '$1$1\\"') : text
      if (opts.appendSystemPrompt) {
        // A env var NÃO escapa do limite: o PS expande $env:X DE VOLTA para a
        // linha de comando do filho, e o teto de 32767 do CreateProcess é
        // re-atingido uma camada abaixo (PROVADO em scripts/probe-argv-limit.mjs:
        // >=33000 chars = erro 206 "nome do arquivo muito grande" em ~210ms —
        // era o loop de respawn do orquestrador "Link bonito no WhatsApp",
        // 02/08: missionPersona ~27KB + goal 4,5KB). Persona claude vai por
        // ARQUIVO (--append-system-prompt-file, flag real do 2.1.220): caminho
        // curto no argv, conteúdo byte a byte, sem escaping nenhum.
        const sysFile = opts.kind === 'claude' ? this.sysPromptFileFor(opts.id) : null
        if (sysFile) {
          writeFileSync(sysFile, opts.appendSystemPrompt, 'utf-8')
          command += ` --append-system-prompt-file ${quote(sysFile)}`
        } else {
          promptEnv['SYNKORA_SYSPROMPT'] = argEnv(opts.appendSystemPrompt)
          command += isWin
            ? ' --append-system-prompt $env:SYNKORA_SYSPROMPT'
            : ' --append-system-prompt "$SYNKORA_SYSPROMPT"'
        }
      }
      // PROMPT GRANDE VAI POR ARQUIVO (caso real 2026-08-04: o prompt do gate
      // de review carrega o diff imutável ~53KB; via $env o PS re-expande tudo
      // na linha do filho e o teto de 32.767 estourava — o reviewer NUNCA
      // abria, guarda de argv recusando ~64k). Mesma lição da persona por
      // arquivo: conteúdo no disco, argv leva um ponteiro curto. O arquivo
      // mora no .synkora do cwd (ignorado pelo git via info/exclude do common
      // dir; legível até por gate em sandbox read-only — é dentro do
      // workspace) e NUNCA é apagado no exit (lição da corrida do arquivo
      // MCP). Baseline/fingerprint do gate não enxerga .synkora (excluído).
      let initialPrompt = opts.initialPrompt
      if (initialPrompt && initialPrompt.length > 8_000) {
        try {
          const dir = join(opts.cwd, '.synkora')
          mkdirSync(dir, { recursive: true })
          const file = join(dir, `prompt-${opts.id}.md`)
          // BOM OBRIGATÓRIO (caso real 2026-08-04: reviewer codex leu o
          // briefing com Get-Content — o PS 5.1 sem BOM decodifica como ANSI
          // e "GESTÃO" virou mojibake DENTRO do contexto; o caminho literal
          // do transcript parou de resolver). Com BOM o PS decodifica UTF-8
          // certo; o Read do claude ignora BOM. (A lição anti-BOM da F6.0 é
          // de SKILL.md parseado pelo frontmatter dos CLIs — outro caso.)
          writeFileSync(file, '\uFEFF' + initialPrompt, 'utf-8')
          initialPrompt =
            `Seu briefing completo está no arquivo ${file} — leia-o INTEIRO agora e execute exatamente o que ele pede. Ele é a sua instrução original desta sessão (vinda do app, não um documento do projeto).`
        } catch {
          // sem disco: segue inline e a guarda de argv dá o veredito legível
        }
      }
      if (initialPrompt) {
        promptEnv['SYNKORA_PROMPT'] = argEnv(initialPrompt)
        command += isWin ? ' $env:SYNKORA_PROMPT' : ' "$SYNKORA_PROMPT"'
      }
      // Windows: -EncodedCommand (base64 UTF-16LE) em vez de -Command — o
      // comando chega no PowerShell BYTE A BYTE, imune à dupla camada de
      // quoting (node-pty monta a linha + PS reparseia; aspas duplas dos
      // args de MCP viravam tokens soltos e o CLI lia pedaços do prompt
      // como argumentos).
      // -ExecutionPolicy Bypass: o `claude`/`codex` do PATH resolve como .ps1
      // (npm-global) e a política PADRÃO do Windows client é Restricted — o
      // pane nascia morto com "o arquivo claude.ps1 não pode ser carregado
      // porque a execução de scripts foi desabilitada" (reproduzido em spawn
      // real 2026-07-24). Hoje isso não aparece porque o app costuma ser
      // lançado de dentro de uma sessão do Claude Code, que exporta
      // PSExecutionPolicyPreference=Bypass e o filho HERDA — pelo atalho/app
      // empacotado, ou de um terminal limpo, quebraria tudo. A flag é de
      // PROCESSO: vale só para este shell, não muda nada na máquina.
      if (isWin) {
        const encoded = Buffer.from(command, 'utf16le').toString('base64')
        // Guarda dos DOIS tetos de 32767 chars do CreateProcess: a linha do
        // powershell (o base64 infla 2,67×) e a linha do filho (com os $env:
        // expandidos + folga do shim .ps1→node). Estourar aqui vira erro
        // LEGÍVEL no pane, em vez de morte muda em ~280ms + respawn em loop.
        const outerLen = 64 + encoded.length
        let innerLen = command.length + 256
        for (const [k, v] of Object.entries(promptEnv)) {
          innerLen += Math.max(0, v.length - `$env:${k}`.length)
        }
        const ARGV_CEILING = 32200
        if (outerLen > ARGV_CEILING || innerLen > ARGV_CEILING) {
          throw new Error(
            `comando do pane ${opts.kind} grande demais para o Windows ` +
              `(powershell ${outerLen} / filho ~${innerLen} chars; teto 32767) — ` +
              `persona ou prompt inicial precisam encolher ou ir por arquivo`
          )
        }
        args = ['-NoLogo', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]
      } else {
        args = ['-lc', command]
      }
    }

    // Cor nos TUIs: no Windows o ConPTY NÃO exporta TERM (o `name` acima só
    // vale em posix) e o Electron pode herdar NO_COLOR=1 do shell que rodou
    // `npm run dev` (o ambiente do Claude Code seta NO_COLOR) — qualquer um
    // dos dois deixa claude/codex 100% monocromáticos. Validado em sonda de
    // PTY real: env cru = 0 sequências de cor; com TERM+COLORTERM e sem
    // NO_COLOR, claude colore e codex emite truecolor.
    // Compatibilidade dos CLIs exige mais que uma allowlist mínima (proxy,
    // locale, shell e toolchains variam por máquina). A fronteira central
    // remove por nome e por formato de credencial antes de aplicar apenas os
    // valores explícitos, gerados pelo backend para este pane.
    const env: Record<string, string> = {
      ...sanitizedPaneEnvironment(process.env, opts.extraEnv),
      PATH: freshWindowsPath(),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      ...promptEnv
    }
    delete env['NO_COLOR']
    delete env['FORCE_COLOR']
    // App lançado de DENTRO de uma sessão do Claude Code (npm run dev no Bash
    // tool): o Electron herda os marcadores CLAUDE_CODE_*/CLAUDECODE e o CLI
    // filho trata o pane como "child session" — TRANSCRIPT SAVING OFF (sondado
    // no 2.1.218: "⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_
    // SESSION marker") — sem JSONL não há badges de tokens/contexto nem
    // --resume. Mesma classe do NO_COLOR acima: limpar tudo antes do spawn.
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_CODE_/i.test(k)) delete env[k]
    }
    delete env['CLAUDECODE']

    // O modo fullscreen do Claude é quem possui o histórico virtual da
    // conversa. Forçar o buffer normal só para obter a barra nativa do xterm
    // faz o Claude 2.1.220 redesenhar a viewport inteira após cada SIGWINCH;
    // esses frames viram cópias no scrollback ao estreitar/alargar o pane.
    // NO_FLICKER restaura o renderer anterior: um único frame no alternate
    // screen, redimensionável sem gravar as repinturas como conteúdo.
    if (opts.kind === 'claude') {
      env['CLAUDE_CODE_NO_FLICKER'] = '1'
    }

    const cols = opts.cols && opts.cols > 0 ? opts.cols : 80
    const rows = opts.rows && opts.rows > 0 ? opts.rows : 24
    // CAUSA RAIZ DE TODA A "TUI BUGADA" (sondado em PTY real 2026-07-24):
    // o ConPTY INBOX do Windows REPINTA O BUFFER VISÍVEL INTEIRO a cada
    // resize — inclusive quando só a ALTURA muda. Medição com 28 linhas
    // marcadas na tela: as 28 reimpressas nos 3 resizes (~2,1 KB cada, um
    // frame \e[H cada, SEM nenhum ED — ele repinta sem limpar). Com a TUI do
    // claude, 12 resizes = 23.094 bytes / 24 frames / 10.472 caracteres
    // reimpressos por cima do transcript antigo: é daí que vinham o banner
    // duplicado, o texto embaralhado e o rodapé cortado.
    // O pacote @lydell/node-pty JÁ EMPACOTA o ConPTY v2 do Windows Terminal
    // (prebuilds/win32-x64/conpty/conpty.dll, FileVersion 1.25.2603.03002,
    // assinado Microsoft) e expõe `useConptyDll`. Os MESMOS 12 resizes com
    // ele: 28 bytes, 0 frames, 0 caracteres reimpressos (~825× menos). É a
    // mesma opção que o VS Code expõe em terminal.integrated.windowsUseConptyDll.
    // ARMADILHA (medida): o ConPTY v2 manda \e[c no boot e BLOQUEIA a saída
    // ~3,2s esperando a resposta de Device Attributes. O xterm responde
    // sozinho, mas só quando o termName dele começa com xterm/rxvt-unicode/
    // screen/linux — o default é "xterm" e o TerminalPane não passa termName.
    // NUNCA setar `termName` no Terminal do renderer: todo pane passaria a
    // nascer com 3,2s de tela preta. (O TERM=xterm-256color do env acima é
    // outra coisa e continua.)
    // Ao empacotar: "build": { "asarUnpack": ["**/node_modules/@lydell/node-pty-*/**"] }
    // — a DLL é carregada por LoadLibraryW num caminho de disco e morre no asar.
    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: opts.cwd,
      env,
      useConptyDll: this.conptyDll
    })
    this.sizes.set(opts.id, `${cols}x${rows}`)

    // Tee com flush periódico: gravar a cada frame de redraw do TUI seria
    // I/O demais — acumula e escreve a cada 1,5s, sem linhas duplicadas.
    let logBuf = ''
    // The renderer is a separate trust boundary. Keep candidate credentials
    // across arbitrary PTY chunk splits instead of redacting each chunk alone.
    const liveRedactor = new StreamingSensitiveRedactor()
    let liveRedactorFinished = false
    // Não persiste uma linha incompleta: uma credencial pode chegar dividida
    // entre dois chunks/flushes. No exit ou flush explícito, o carry inteiro é
    // redigido antes de seguir para transcript/lastlines.
    let cleanLineCarry = ''
    const MAX_CLEAN_LINE_CARRY = 64 * 1024
    let lastLine = ''
    let logTimer: NodeJS.Timeout | null = null
    let lastAttention = 0
    let lastLoginWarn = 0
    // ÚLTIMAS LINHAS do agente (canal pane:lastlines): as mesmas linhas que já
    // vão para o transcript — limpas de ANSI, sem repetição consecutiva. É o
    // que permite mostrar o que 20 panes estão fazendo sem pintar 20
    // terminais (cartões-vivos do mosaico e cards do mapa). Debounce de 400ms
    // porque um TUI repinta muitas vezes por segundo.
    const tailLines: string[] = []
    let tailTimer: NodeJS.Timeout | null = null
    const flushTail = (): void => {
      tailTimer = null
      this.sendChrome(wc, 'pane:lastlines', opts.id, tailLines.slice())
    }
    const inspectNotice = (line: string): void => {
      if (opts.onAttention && ATTENTION_RE.test(line) && Date.now() - lastAttention > 30_000) {
        lastAttention = Date.now()
        opts.onAttention()
      }
      if (opts.onLoginExpired && LOGIN_RE.test(line) && Date.now() - lastLoginWarn > 60_000) {
        lastLoginWarn = Date.now()
        opts.onLoginExpired()
      }
    }
    const flushLog = (flushPartial = false): void => {
      if (!logBuf && (!flushPartial || !cleanLineCarry)) return
      const combined = cleanLineCarry + cleanPtyChunk(logBuf)
      logBuf = ''
      const split = combined.split('\n')
      const lines = flushPartial ? split : split.slice(0, -1)
      cleanLineCarry = flushPartial ? '' : (split.at(-1) ?? '')
      // Um TUI malformado não pode fazer o carry crescer sem limite. O bloco
      // inteiro ainda passa pelo redator antes de qualquer persistência.
      if (!flushPartial && cleanLineCarry.length > MAX_CLEAN_LINE_CARRY) {
        lines.push(cleanLineCarry)
        cleanLineCarry = ''
      }
      if (cleanLineCarry) inspectNotice(cleanLineCarry)
      const out: string[] = []
      for (const line of lines) {
        const t = line.trimEnd()
        if (!t.trim()) continue
        inspectNotice(t)
        const safe = redactSensitiveText(t)
        if (safe === lastLine) continue
        // Frames do shimmer/animação (classe provada em bytes reais — ver
        // collapseRepaintFrame): fragmento da mesma linha não vira transcript.
        const frameVerdict = lastLine ? collapseRepaintFrame(lastLine, safe) : 'keep'
        if (frameVerdict === 'drop') continue
        if (frameVerdict === 'replace') {
          // versão mais longa da MESMA linha: substitui dentro do flush; se a
          // anterior já foi persistida num flush passado, entra como linha
          // nova (append-only) — ainda assim uma por ciclo, não quinze.
          if (out.length && out.at(-1) === lastLine) out[out.length - 1] = safe
          else out.push(safe)
          lastLine = safe
          continue
        }
        lastLine = safe
        out.push(safe)
      }
      if (out.length) {
        // Só linhas com substância: a moldura do TUI (│ ╭ ╰ ─ ▔) e os
        // rodapés de dica não dizem nada sobre o que o agente está fazendo.
        for (const t of out) {
          if (!/[A-Za-zÀ-ÿ0-9]/.test(t.replace(/[─│╭╮╰╯━┃▔▁█]/g, ''))) continue
          tailLines.push(t.replace(/^[│┃|]\s?/, '').slice(0, 160))
        }
        while (tailLines.length > 8) tailLines.shift()
        if (!tailTimer) tailTimer = setTimeout(flushTail, 400)
      }
      if (out.length && opts.logFile) {
        try {
          if (opts.canWriteLog?.() !== true) return
          appendFileSync(opts.logFile, out.join('\n') + '\n', 'utf-8')
        } catch {
          // transcript é best-effort
        }
      }
    }

    // Effort e JANELA DE CONTEXTO reais do banner do CLI ("Opus 4.8 (1M
    // context) with high effort"): o JSONL não registra nenhum dos dois
    // (sondado) — o banner é a única fonte real, e ele REAPARECE após /clear
    // (por isso sem latch de "já enviei"; dedupe por valor). Nas repinturas o
    // ConPTY troca espaços por cursor-forward (\e[1C) — normaliza antes.
    let lastEffort = ''
    let lastCtxWindow = 0
    let ctxBannerBuf = ''
    let lastModel = ''
    // Resume de sessão que não existe mais no disco: Claude/Codex imprimem o
    // erro e morrem. A autocura invalida o id no main e respawna o MESMO pane
    // sem o subcomando; o xterm segue conectado.
    let resumeHealed = false
    let resumeSize: { cols: number; rows: number } | undefined
    let resumeErrorBuf = ''
    let resumeProbeActive = false
    let resumeProbeBytes = 0
    const resumeProbeDeadline = Date.now() + 20_000
    let exitDelivered = false
    const resumeArgIndex =
      opts.kind === 'claude'
        ? (opts.cliArgs ?? []).indexOf('--resume')
        : (opts.cliArgs ?? []).indexOf('resume')
    const hasResume = resumeArgIndex >= 0 && Boolean((opts.cliArgs ?? [])[resumeArgIndex + 1])
    resumeProbeActive = hasResume
    const cleanBanner = (s: string): string => cleanPtyChunk(s.replace(/\x1b\[\d*C/g, ' '))
    const deliverExit = (exitCode: number): void => {
      if (exitDelivered) return
      exitDelivered = true
      try {
        opts.onExit?.(exitCode, tailLines.slice(-8))
      } catch (error) {
        console.error('[pty] callback de saída falhou', error)
      } finally {
        try {
          if (!wc.isDestroyed()) wc.send('pty:exit', opts.id, exitCode)
        } catch {
          // renderer já fechou; a limpeza do main acima continua concluída
        }
      }
    }
    const flushLiveRedactor = (): void => {
      if (liveRedactorFinished) return
      liveRedactorFinished = true
      const finalChunk = liveRedactor.finish()
      if (!finalChunk) return
      this.outBufs.set(opts.id, ((this.outBufs.get(opts.id) ?? '') + finalChunk).slice(-12_000))
      if (!wc.isDestroyed()) wc.send('pty:data', opts.id, finalChunk)
    }
    const forceExit = (): void => {
      const registered = this.exitFallbacks.get(opts.id)
      if (!registered || registered.pty !== pty) return
      const current = this.ptys.get(opts.id)
      if (current && current !== pty) return
      if (logTimer) clearTimeout(logTimer)
      flushLog(true)
      flushLiveRedactor()
      if (tailTimer) {
        clearTimeout(tailTimer)
        flushTail()
      }
      this.ptys.delete(opts.id)
      this.lastOutput.delete(opts.id)
      this.lastKeyAt.delete(opts.id)
      this.sizes.delete(opts.id)
      this.inputBufs.delete(opts.id)
      this.cmdHooks.delete(opts.id)
      this.submitHooks.delete(opts.id)
      this.shellSecurity.delete(opts.id)
      this.resumeProbeStops.delete(opts.id)
      this.pasting.delete(opts.id)
      this.escCarry.delete(opts.id)
      this.inOsc.delete(opts.id)
      this.lastHumanAt.delete(opts.id)
      this.flushers.delete(opts.id)
      this.exitFallbacks.delete(opts.id)
      deliverExit(-1)
    }
    pty.onData((data) => {
      // INSTRUMENTAÇÃO TEMPORÁRIA: durante 3s após um resize, registra CADA
      // chunk que o CLI manda — é a única forma de saber se ele repinta com
      // âncora (\e[H, que o clear do renderer usa) ou se só emite conteúdo.
      // Remover quando o caso estiver fechado.
      const until = this.probeUntil.get(opts.id) ?? 0
      if (until && Date.now() <= until) {
        // O probe antigo imprimia o prefixo cru do chunk, que podia conter
        // prompt/resposta. Mantém apenas contagens estruturais allowlisted.
        console.log(
          `[probe] chunk ${opts.id.slice(0, 8)} @${Date.now() % 100000} len=${data.length}` +
            ` home=${(data.match(/\x1b\[H/g) ?? []).length}` +
            ` h11=${(data.match(/\x1b\[1;1H/g) ?? []).length}` +
            ` el2=${(data.match(/\x1b\[2K/g) ?? []).length}` +
            ` ed2=${(data.match(/\x1b\[2J/g) ?? []).length}`
        )
      } else if (until) {
        this.probeUntil.delete(opts.id)
      }
      this.lastOutput.set(opts.id, Date.now())
      const safeLiveData = liveRedactor.push(data)
      if (safeLiveData) {
        this.outBufs.set(
          opts.id,
          ((this.outBufs.get(opts.id) ?? '') + safeLiveData).slice(-12_000)
        )
      }
      opts.onOutput?.()
      if (safeLiveData && !wc.isDestroyed()) wc.send('pty:data', opts.id, safeLiveData)
      if (resumeProbeActive && Date.now() > resumeProbeDeadline) {
        resumeProbeActive = false
        resumeErrorBuf = ''
      }
      let resumeProbeReachedLimit = false
      if (resumeProbeActive && !resumeHealed) {
        const probe = takeResumeProbeChunk(data, resumeProbeBytes)
        resumeProbeBytes = probe.consumed
        resumeErrorBuf = (resumeErrorBuf + cleanBanner(probe.chunk)).slice(-4_096)
        resumeProbeReachedLimit = probe.reachedLimit
      }
      const invalidResume =
        resumeProbeActive &&
        !resumeHealed &&
        opts.kind !== 'shell' &&
        hasFatalResumeError(opts.kind, resumeErrorBuf)
      if (invalidResume) {
        resumeHealed = true
        resumeProbeActive = false
        const size = /^(\d+)x(\d+)$/.exec(this.sizes.get(opts.id) ?? '')
        resumeSize = size
          ? { cols: Number(size[1]), rows: Number(size[2]) }
          : { cols: opts.cols ?? 80, rows: opts.rows ?? 24 }
        setTimeout(() => {
          if (this.generations.get(opts.id) !== generation) {
            // Cura cancelada por fechamento explícito: se não há substituto,
            // o main ainda precisa receber UM exit para soltar watch/Hub/card.
            if (!this.ptys.has(opts.id)) deliverExit(-1)
            return
          }
          const current = this.ptys.get(opts.id)
          if (current && current !== pty) return // outro respawn chegou antes
          const stripped = [...(opts.cliArgs ?? [])]
          stripped.splice(resumeArgIndex, 2)
          // Se ainda for o processo antigo, desanexa sem invalidar esta
          // geração. Se ele já saiu, onExit limpou os mapas e a autocura
          // continua mesmo assim. Um kill explícito muda a geração e aborta.
          if (current === pty) {
            this.safeKill(pty)
            this.ptys.delete(opts.id)
          }
          if (!wc.isDestroyed()) {
            wc.send(
              'pty:data',
              opts.id,
              '\r\n\x1b[33m[synkora] a sessão antiga não existe mais — abrindo o CLI do zero…\x1b[0m\r\n'
            )
          }
          if (wc.isDestroyed()) {
            deliverExit(-1)
            return
          }
          try {
            const created = this.create(wc, {
              ...opts,
              cliArgs: stripped,
              cols: resumeSize?.cols,
              rows: resumeSize?.rows
            })
            if (!created) deliverExit(-1)
          } catch {
            deliverExit(-1)
          }
        }, 400)
        try {
          opts.onResumeFail?.()
        } catch (error) {
          // A cura já está agendada e não pode virar pane fantasma por falha
          // de persistência do callback no processo principal.
          console.error('[pty] callback de retomada inválida falhou', error)
        }
      } else if (resumeProbeReachedLimit) {
        // Analisa exatamente a janela inicial e depois a fecha. Assim, mesmo
        // um chunk enorme nunca deixa texto posterior disparar uma falsa cura.
        resumeProbeActive = false
        resumeErrorBuf = ''
      }
      if (/effort/i.test(data)) {
        // banner ("with high effort") E footer do claude ("● high · /effort",
        // repinta a cada frame) — o footer muda NA HORA quando o usuário troca
        // via /effort ou /model, então o badge acompanha ao vivo.
        // banner ("with X effort") + confirmação do /effort ("Set effort level
        // to X …") + footer ("◈ max · /effort" — o MARCADOR varia por nível e
        // o ConPTY repinta por DIFF, só a palavra que mudou; por isso nada de
        // exigir ● nem "with").
        const c = cleanBanner(data)
        const m =
          c.match(/with\s+(minimal|low|medium|high|xhigh|max|ultra)\s+effort/i) ??
          c.match(/Set effort level to\s+(minimal|low|medium|high|xhigh|max|ultra)/i) ??
          c.match(/\b(minimal|low|medium|high|xhigh|max|ultra)\s*·\s*\/effort/i)
        if (m && m[1].toLowerCase() !== lastEffort) {
          lastEffort = m[1].toLowerCase()
          this.sendChrome(wc, 'pty:effort', opts.id, lastEffort)
        }
      }
      if (opts.onCtxWindow) ctxBannerBuf = (ctxBannerBuf + data).slice(-4096)
      if (opts.onCtxWindow && /context\)/i.test(ctxBannerBuf)) {
        // ConPTY pode quebrar "(1M context)" entre chunks arbitrarios. Analisa
        // uma janela curta acumulada e usa a ocorrencia mais recente (model
        // switch pode deixar o banner antigo no mesmo buffer).
        const clean = cleanBanner(ctxBannerBuf)
        const re = /\((\d+(?:\.\d+)?)\s*([km])\s*context\)/gi
        let m: RegExpExecArray | null = null
        let candidate: RegExpExecArray | null
        while ((candidate = re.exec(clean))) m = candidate
        if (m) {
          const tokens = Math.round(
            parseFloat(m[1]) * (m[2].toLowerCase() === 'm' ? 1_000_000 : 1_000)
          )
          if (tokens && tokens !== lastCtxWindow) {
            lastCtxWindow = tokens
            opts.onCtxWindow(tokens)
          }
        }
      }
      // MODELO real, AO VIVO (sondado 2026-07-23). claude: banner ("Opus 4.8
      // (1M context) … · Claude Max") + confirmação da troca ("Set model to
      // Fable 5 …"). codex: footer "<modelo> <effort> · ~\cwd" — repinta a
      // cada frame e muda na hora da troca via /model (effort vem junto).
      if (opts.kind === 'claude' && /opus|sonnet|haiku|fable|mythos/i.test(data)) {
        const c = cleanBanner(data)
        // a forma solta ("Opus 4.8 … ·") SÓ vale em chunk com o banner de
        // verdade ("Claude Code v…") — o picker do /model lista os OUTROS
        // modelos no mesmo formato e envenenaria o badge ao navegar.
        const m =
          c.match(
            /Set model to\s+(opus|sonnet|haiku|fable|mythos)\s*(\d[\d.]*)?\s*(?:\(\s*[\d.]+\s*([km])\s*context\s*\))?/i
          ) ??
          (/Claude\s+Code\s+v\d/.test(c)
            ? c.match(
                /\b(opus|sonnet|haiku|fable|mythos)\s*(\d[\d.]*)?\s*(?:\(\s*[\d.]+\s*([km])\s*context\s*\))?[^·\n]{0,60}·/i
              )
            : null)
        if (m) {
          const oneM = (m[3] ?? '').toLowerCase() === 'm'
          const model = `${m[1].toLowerCase()}${m[2] ? `-${m[2]}` : ''}${oneM ? '[1m]' : ''}`
          if (model !== lastModel) {
            lastModel = model
            this.sendChrome(wc, 'pty:model', opts.id, model)
          }
        }
      } else if (opts.kind === 'codex' && /·/.test(data)) {
        // exige "· ~" ou "· C:" (o cwd do footer) p/ não casar texto de conversa
        const m = cleanBanner(data).match(
          /\b([a-z][\w.-]{1,40})\s+(minimal|low|medium|high|xhigh|extra high|max|ultra|default)\s+·\s*(?:~|[A-Za-z]:)/i
        )
        if (m) {
          if (m[1] !== lastModel) {
            lastModel = m[1]
            this.sendChrome(wc, 'pty:model', opts.id, m[1])
          }
          const effort = m[2].toLowerCase().replace(/^extra\s+high$/, 'xhigh')
          if (effort !== lastEffort) {
            lastEffort = effort
            this.sendChrome(wc, 'pty:effort', opts.id, effort)
          }
        }
      }
      if (opts.logFile || opts.onAttention || opts.onLoginExpired) {
        logBuf += data
        if (!logTimer) {
          logTimer = setTimeout(() => {
            logTimer = null
            flushLog(false)
          }, 1500)
        }
      }
    })
    pty.onExit(({ exitCode }) => {
      // PRIMEIRA coisa: este objeto nativo está morto — nenhum kill/write
      // pode mais tocá-lo (o assert de conpty.cc:106 abortaria o app).
      this.deadPtys.add(pty)
      if (logTimer) clearTimeout(logTimer)
      flushLog(true)
      // última leva de linhas vai na hora: o cartão do pane morto deve mostrar
      // o que ele estava dizendo quando parou, não a penúltima atualização
      if (tailTimer) {
        clearTimeout(tailTimer)
        flushTail()
      }
      const fallback = this.exitFallbacks.get(opts.id)
      if (fallback?.pty === pty) {
        if (fallback.timer) clearTimeout(fallback.timer)
        this.exitFallbacks.delete(opts.id)
      }
      // Respawn com o MESMO id (ex.: pane do Maestro ao trocar de seat): se o
      // mapa já aponta para OUTRO pty, este exit é do processo ANTIGO — não
      // pode apagar o registro novo, nem rodar limpeza (matava o teclado e o
      // MCP do pane novo), nem imprimir "[processo encerrado]" nele.
      // A guarda era mais LARGA que a intenção: kill() apaga o mapa ANTES de o
      // processo morrer, então `undefined !== pty` engolia TODO exit vindo de
      // kill explícito — e com ele morriam a devolução da tarefa ao backlog, a
      // missão presa em "integrando", o aviso ao delegador do ajudante e o
      // evento pane-close. Só ignora quando existe um pty NOVO de verdade.
      const cur = this.ptys.get(opts.id)
      if (cur && cur !== pty) return
      // Morte NATURAL (crash/exit do CLI sem kill nosso): os filhos podem ter
      // sobrevivido (crash não roda cleanup de MCP/browser) — o job fecha no
      // kernel e a ceifa cobre o que nasceu antes do assign.
      // Kill explícito já ceifou e limpou o mapa: aqui vira no-op.
      const orphanRoot = this.rootPids.get(opts.id)
      if (orphanRoot) {
        this.jobClose(opts.id)
        this.reapTree(opts.id, orphanRoot)
      }
      flushLiveRedactor()
      this.ptys.delete(opts.id)
      this.lastOutput.delete(opts.id)
      this.lastKeyAt.delete(opts.id)
      this.sizes.delete(opts.id)
      this.inputBufs.delete(opts.id)
      this.cmdHooks.delete(opts.id)
      this.submitHooks.delete(opts.id)
      this.shellSecurity.delete(opts.id)
      this.resumeProbeStops.delete(opts.id)
      this.pasting.delete(opts.id)
      this.escCarry.delete(opts.id)
      this.inOsc.delete(opts.id)
      this.lastHumanAt.delete(opts.id)
      this.flushers.delete(opts.id)
      // O processo antigo que recusou --resume não encerra a fase: o timer
      // acima recria o mesmo pane sem o argumento inválido. Só a nova geração
      // poderá comunicar uma morte real ao main.
      if (resumeHealed && this.generations.get(opts.id) === generation) return
      deliverExit(exitCode)
    })

    this.ptys.set(opts.id, pty)
    // assign IMEDIATO pós-spawn (membership não é retroativa — quanto antes,
    // menor a janela de filho fora do job; o CLI leva ~100-300ms para nascer
    // dentro do PowerShell, o assign quente custa <1ms). MAS o pid do ConPTY
    // DLL é preenchido de forma ASSÍNCRONA: em máquina carregada o acesso
    // imediato lia 0 e o guardião falhava com OpenProcess(0) → err_open_87 em
    // TODOS os panes do boot (caso real 2026-08-06 ~17h — a sonda 42/42
    // passou porque a máquina estava ociosa). Adia até o pid ser real; sem
    // pid em ~3s, desiste (taskkill+ceifa seguem como segunda camada).
    const armJob = (attempt: number): void => {
      const pid = pty.pid
      if (pid && pid > 0) {
        // pty trocado/morto durante a espera: não registrar raiz velha
        if (this.ptys.get(opts.id) !== pty) return
        this.rootPids.set(opts.id, pid)
        this.jobSend(`assign ${opts.id} ${pid}`)
        return
      }
      if (attempt >= 30) {
        console.error(`[synkora] job assign desistiu (pid nunca chegou): ${opts.id}`)
        return
      }
      const retry = setTimeout(() => armJob(attempt + 1), 100)
      retry.unref?.()
    }
    armJob(0)
    this.ensureTreeTracker()
    // fotografia de aquecimento (debounce interno de 5s): o MCP/browser do
    // pane costuma nascer nos primeiros segundos
    const warmup = setTimeout(() => this.refreshTreeSnapshot(), 2_500)
    warmup.unref?.()
    this.flushers.set(opts.id, () => flushLog(true))
    this.exitFallbacks.set(opts.id, { pty, force: forceExit })
    if (opts.onCommand) this.cmdHooks.set(opts.id, opts.onCommand)
    if (hasResume) {
      this.resumeProbeStops.set(opts.id, () => {
        resumeProbeActive = false
        resumeErrorBuf = ''
      })
    }
    if (opts.onSubmit) this.submitHooks.set(opts.id, opts.onSubmit)
    if (opts.kind === 'shell') {
      this.shellSecurity.set(opts.id, {
        decide: (command, humanInput) => inspectShellSubmission(command, { humanInput }),
        report: opts.onSecurityDecision,
        notify: (reason) => {
          if (wc.isDestroyed()) return
          wc.send(
            'pty:data',
            opts.id,
            `\r\n\x1b[31m[synkora] ação bloqueada: ${redactSensitiveText(reason)}\x1b[0m\r\n`
          )
        }
      })
    }
    this.inputBufs.set(opts.id, '')
    return true
  }

  /** Força o flush pendente do tee (transcript) de um pane — o debounce é de
   *  1,5s e quem vai LER o arquivo agora (report de ajudante) não pode esperar
   *  a sorte do timer. No-op para pane sem tee ou já morto. */
  flushLogOf(id: string): void {
    this.flushers.get(id)?.()
  }

  /** Acompanha o que o usuário DIGITA no pane para detectar /comandos
   *  executados (linha começando com "/" + Enter). Setas/CSIs são ignorados;
   *  ESC+CR (shift+enter) é quebra de linha no editor, não submissão; ^C/^U
   *  limpam o input do TUI e zeram o buffer junto. OSC/DCS (respostas
   *  AUTOMÁTICAS do xterm a queries do TUI — \e]11;rgb:… — chegam pelo MESMO
   *  canal do teclado) são consumidas por inteiro, atravessando chunks; e
   *  sequência ESC CORTADA no fim do chunk vira CARRY para o próximo write
   *  (o \e[201~ fatiado perdia o fim do paste e o pane ficava "colando" para
   *  sempre — caso real 2026-07-30: dev codex surdo a toda injeção).
   *  Heurística best-effort. */
  private feedInput(id: string, data: string): RuntimeSecurityDecision | undefined {
    const hook = this.cmdHooks.get(id)
    const submitHook = this.submitHooks.get(id)
    const shellSecurity = this.shellSecurity.get(id)
    if (!hook && !submitHook && !shellSecurity) return
    const carry = this.escCarry.get(id)
    if (carry) {
      this.escCarry.delete(id)
      data = carry + data
    }
    let buf = this.inputBufs.get(id) ?? ''
    let i = 0
    let blocked: RuntimeSecurityDecision | undefined
    // OSC/DCS aberta no chunk anterior: consome até o terminador (BEL/ST)
    if (this.inOsc.has(id)) {
      const end = this.stEnd(data, 0)
      if (end === -1) {
        // resposta que nunca termina desiste em 2s — isto NUNCA prende o pane
        if (Date.now() - (this.inOsc.get(id) ?? 0) > 2000) this.inOsc.delete(id)
        this.inputBufs.set(id, buf)
        return
      }
      this.inOsc.delete(id)
      i = end
    }
    for (; i < data.length; i++) {
      const ch = data[i]
      if (ch === '\x1b') {
        const next = data[i + 1]
        if (next === undefined) {
          this.escCarry.set(id, '\x1b')
          break
        }
        if (next === '\r') {
          i++ // shift+enter: newline no editor do TUI
          continue
        }
        if (next === ']' || next === 'P') {
          // OSC/DCS: resposta automática do xterm (cor de tema etc.) — NUNCA
          // entra no buf (antes o ]11;rgb:… virava "texto digitado" eterno)
          const end = this.stEnd(data, i + 2)
          if (end === -1) {
            this.inOsc.set(id, Date.now())
            break
          }
          i = end - 1
          continue
        }
        if (next === '[') {
          let j = i + 2
          let seq = ''
          while (j < data.length && !/[A-Za-z~]/.test(data[j])) {
            seq += data[j]
            j++
          }
          if (j >= data.length) {
            // CSI cortada entre writes — carry (cap curto: CSI real é pequena)
            const tail = data.slice(i)
            if (tail.length <= 64) this.escCarry.set(id, tail)
            break
          }
          seq += data[j]
          i = j
          if (seq === '200~') this.pasting.add(id)
          else if (seq === '201~') this.pasting.delete(id)
          continue
        }
        i++ // \eO<x> e afins: pula ESC + o byte seguinte
        continue
      }
      if (this.pasting.has(id)) {
        // conteúdo COLADO também suja o composer (o guard de injeção precisa
        // enxergar isso — sonda 2026-07-29: injetar sobre texto pendente
        // concatena e o Enter submete tudo junto)
        if (ch >= ' ') buf += ch
        const cap = shellSecurity ? 8192 : 400
        if (buf.length > cap) buf = buf.slice(-cap)
        continue
      }
      if (ch === '\r' || ch === '\n') {
        const cmd = buf.trim()
        buf = ''
        if (cmd) this.resumeProbeStops.get(id)?.()
        if (cmd && shellSecurity) {
          const decision = shellSecurity.decide(cmd, true)
          if (decision.action !== 'allow') shellSecurity.report?.(decision)
          if (decision.action === 'block') blocked = decision
        }
        if (blocked) continue
        if (cmd.startsWith('/')) hook?.(cmd)
        else if (cmd) submitHook?.()
        continue
      }
      if (ch === '\x7f' || ch === '\b') {
        buf = buf.slice(0, -1)
        continue
      }
      if (ch === '\x03' || ch === '\x15') {
        buf = ''
        continue
      }
      if (ch >= ' ') buf += ch
      const cap = shellSecurity ? 8192 : 400
      if (buf.length > cap) buf = buf.slice(-cap)
    }
    this.inputBufs.set(id, buf)
    return blocked
  }

  /** Fim de string OSC/DCS a partir de `from`: índice APÓS o BEL ou o ST
   *  (\e\\); -1 se o terminador não está neste chunk. */
  private stEnd(data: string, from: number): number {
    for (let i = from; i < data.length; i++) {
      if (data[i] === '\x07') return i + 1
      if (data[i] === '\x1b' && data[i + 1] === '\\') return i + 2
    }
    return -1
  }

  /** O write veio de DEDO HUMANO? O xterm responde SOZINHO a queries do TUI
   *  (DSR → \e[l;cR, DA → \e[?…c, OSC 10/11 de cor → \e]11;rgb:…) pelo MESMO
   *  canal do teclado — resposta automática marcando lastKeyAt deixava o
   *  composer "quente" para sempre em pane codex (que polla) e TODA injeção
   *  morria na fila (caso real 2026-07-30). Humano = printable/edição/Enter,
   *  setas e teclas de função (\e[A…, \e[3~, \e[Z, \eO?); resposta = finais
   *  R/c/n, params começando com ? ou >, e OSC/DCS inteiras. */
  private hasHumanInput(data: string): boolean {
    for (let i = 0; i < data.length; i++) {
      const ch = data[i]
      if (ch === '\x1b') {
        const next = data[i + 1]
        if (next === undefined) return false
        if (next === '\r' || next === 'O') return true // shift+enter · setas SS3
        if (next === ']' || next === 'P') {
          const end = this.stEnd(data, i + 2)
          if (end === -1) return false
          i = end - 1
          continue
        }
        if (next === '[') {
          let j = i + 2
          while (j < data.length && !/[A-Za-z~]/.test(data[j])) j++
          if (j >= data.length) return false // cortada = resposta em trânsito
          const fin = data[j]
          const params = data.slice(i + 2, j)
          i = j
          if (fin === 'R' || fin === 'c' || fin === 'n') continue
          if (params.startsWith('?') || params.startsWith('>')) continue
          return true // \e[A/B/C/D, \e[3~, \e[Z, \e[200~… = gente
        }
        i++
        continue
      }
      if (
        ch >= ' ' ||
        ch === '\r' ||
        ch === '\n' ||
        ch === '\t' ||
        ch === '\x7f' ||
        ch === '\b' ||
        ch === '\x03' ||
        ch === '\x15' ||
        ch === '\x16'
      )
        return true
    }
    return false
  }

  has(id: string): boolean {
    return this.ptys.has(id)
  }

  /** Panes vivos — contexto da caixa-preta de crash. */
  count(): number {
    return this.ptys.size
  }

  /** Ocioso = vivo e sem saída nova há pelo menos `ms` (injeção segura). */
  isIdle(id: string, ms: number): boolean {
    if (!this.ptys.has(id)) return false
    return Date.now() - (this.lastOutput.get(id) ?? 0) >= ms
  }

  /** Instante da saída mais recente, sem expor nenhum byte do terminal. */
  lastOutputAt(id: string): number | undefined {
    if (!this.ptys.has(id)) return undefined
    return this.lastOutput.get(id)
  }

  /** Rabo da saída do pane, LIMPO de ANSI e com repaints colapsados —
   *  é o "olhar por cima do ombro" do delegador sobre o ajudante. */
  outputTail(id: string, chars = 2000): string {
    const raw = this.outBufs.get(id)
    if (!raw) return ''
    const lines = cleanPtyChunk(raw).split('\n')
    const out: string[] = []
    for (const line of lines) {
      const flat = line.trim()
      if (!flat) continue
      if (out[out.length - 1] === flat) continue // repaint repete linhas
      out.push(flat)
    }
    return redactSensitiveText(out.join('\n')).slice(-chars)
  }

  /** Digita uma linha no pane e SUBMETE — eventos do hub para o Maestro.
   *  O Enter vai num write SEPARADO, com folga: os TUIs tratam texto rápido
   *  como PASTE e um \r no mesmo chunk vira quebra de linha no input (o
   *  evento ficava parado no prompt sem ser enviado).
   *  FATIADO (2026-07-28, bug real): uma write única de ~1k chars estoura o
   *  buffer de input do ConPTY e o COMEÇO da mensagem é descartado — o
   *  orquestrador recebia só o rabo do plano de delegação do dev ("só chegou
   *  o final, sem o paneId"). Mesmo remédio do Ctrl+A: chunks pequenos com
   *  folga entre eles. */
  inject(id: string, text: string, onSubmitted?: (submitted: boolean) => void): boolean {
    const target = this.ptys.get(id)
    if (!target) return false
    // Uma mensagem injetada só é enviada depois que o TUI já está utilizável;
    // a partir daqui qualquer frase de erro pertence à conversa, não ao boot.
    this.resumeProbeStops.get(id)?.()
    const flat = text.replace(/\s+/g, ' ').trim()
    const shellSecurity = this.shellSecurity.get(id)
    if (shellSecurity) {
      const decision = shellSecurity.decide(flat, false)
      if (decision.action !== 'allow') shellSecurity.report?.(decision)
      if (decision.action === 'block') {
        shellSecurity.notify(decision.reason)
        onSubmitted?.(false)
        return false
      }
    }
    const CHUNK = 160
    let off = 0
    let settled = false
    const settle = (submitted: boolean): void => {
      if (settled) return
      settled = true
      onSubmitted?.(submitted)
    }
    const step = (): void => {
      const pty = this.ptys.get(id)
      // O id pode renascer com outro processo. Nunca complete uma mensagem
      // iniciada no PTY antigo dentro do PTY novo.
      if (pty !== target) {
        settle(false)
        return
      }
      if (off < flat.length) {
        if (!this.safeWrite(target, flat.slice(off, off + CHUNK))) {
          settle(false)
          return
        }
        off += CHUNK
        setTimeout(step, 24)
      } else {
        setTimeout(() => {
          const p = this.ptys.get(id)
          if (p !== target) {
            settle(false)
            return
          }
          settle(this.safeWrite(target, '\r'))
        }, 300)
      }
    }
    step()
    return true
  }

  // CRASH NATIVO REAL (2026-07-28, dialog do VC++ capturado pelo usuário):
  // "Assertion failed! conpty.cc:106 — remove_pty_baton(baton->id)" dentro do
  // conpty.node do @lydell/node-pty. O assert dispara quando o lado nativo
  // tenta liberar um pty JÁ liberado — kill() duplo, ou kill/write na janela
  // entre a morte do processo e o evento onExit chegar ao JS — e um assert
  // nativo ABORTA o app inteiro sem passar por nenhum handler. Blindagem por
  // OBJETO (WeakSet — id é reusado em respawn, o objeto nunca): cada pty só
  // recebe UM kill na vida, e pty morto/morrendo nunca mais é tocado no
  // nativo. try/catch continua por cima para as exceções JS normais.
  private deadPtys = new WeakSet<IPty>()
  private killedPtys = new WeakSet<IPty>()

  // "O QUE ELES ABRIREM, ELES FECHAM" (decisão do usuário, 2026-08-05): matar
  // só a raiz do PTY deixava a subárvore órfã — Chrome do Playwright MCP e
  // Electron do produto acumulando na máquina do usuário. SONDADO em processo
  // real (scratchpad/probe-tree-kill.mjs, 3 cenários, 2026-08-05):
  // `taskkill /PID <raiz> /T /F` mata a árvore VIVA inteira (inclusive filhos
  // detached e o conhost) em ~160ms, mas NÃO atravessa elo com pai morto e é
  // no-op total (exit 128) se a raiz já morreu. Por isso DUAS camadas:
  // fotografia PERIÓDICA de Win32_Process (everSeen por pane — ~380ms de
  // LATÊNCIA de processo filho, zero main thread) + no fechamento o taskkill
  // fast-path E uma CEIFA ~700ms depois que mata, com verificação de
  // identidade (pid+nome, anti reuso de PID), todo descendente conhecido ou
  // alcançável por parentesco que sobreviveu. Job Object (kill-on-close)
  // seria o tampão 100%, mas exige addon nativo — evolução futura.
  private treeSeen = new Map<string, Map<number, string>>()
  private rootPids = new Map<string, number>()
  private treeTimer: ReturnType<typeof setInterval> | undefined
  private treeSnapshotAt = 0

  // JOB OBJECT KILL-ON-CLOSE — o tampão 100% do "o que abrirem, eles fecham"
  // (SONDADO 42/42 em probe-jobobject-*.mjs, 2026-08-05, incluindo Electron e
  // Chrome REAIS dentro de NESTED jobs): um GUARDIÃO PowerShell de longa vida
  // cria um Job por pane (JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, SEM flags de
  // breakaway — o default NEGA CREATE_BREAKAWAY_FROM_JOB com ACCESS_DENIED) e
  // atribui a raiz logo após o spawn; TODO descendente futuro herda o job e
  // morre no close — inclusive órfão de pai morto, que a ceifa por fotografia
  // corre atrás. CRASH do app = EOF no stdin do guardião = guardião sai =
  // handles fecham = todos os panes morrem sozinhos (era o buraco do
  // dirty-exit). PEGADINHAS PROVADAS: membership NÃO é retroativa (processo
  // nascido antes do assign fica fora — por isso o assign é imediato
  // pós-spawn E o taskkill+ceifa continuam como segunda camada; nunca remover
  // a rede inteira); guardião morto à toa = respawn + re-assign das raízes
  // vivas (cobertura degradada da árvore velha — o taskkill cobre). Custo:
  // ~272ms de boot uma vez, assign <1ms quente, ~82MB de WS (PS 5.1).
  private jobGuardian: ChildProcessWithoutNullStreams | null = null
  private jobGuardianReady = false
  private jobGuardianQueue: string[] = []
  private jobGuardianRespawns: number[] = []

  private static readonly JOB_GUARDIAN_PS1 = `$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
public static class JobGuard {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr info, uint len);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
        public uint LimitFlags; public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
        public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS {
        public ulong ReadOperationCount; public ulong WriteOperationCount;
        public ulong OtherOperationCount; public ulong ReadTransferCount;
        public ulong WriteTransferCount; public ulong OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
    public const uint KILL_ON_CLOSE = 0x2000;
    public static IntPtr MakeJob() {
        IntPtr h = CreateJobObjectW(IntPtr.Zero, null);
        if (h == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = KILL_ON_CLOSE;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(len);
        try {
            Marshal.StructureToPtr(info, p, false);
            if (!SetInformationJobObject(h, 9, p, (uint)len)) throw new System.ComponentModel.Win32Exception();
        } finally { Marshal.FreeHGlobal(p); }
        return h;
    }
    public static string Assign(IntPtr job, uint pid) {
        IntPtr hp = OpenProcess(0x1101, false, pid);
        if (hp == IntPtr.Zero) return "err_open_" + Marshal.GetLastWin32Error();
        bool ok = AssignProcessToJobObject(job, hp);
        int e = ok ? 0 : Marshal.GetLastWin32Error();
        CloseHandle(hp);
        return ok ? "ok" : "err_assign_" + e;
    }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$jobs = @{}
[Console]::Out.WriteLine("ready pid=$PID")
[Console]::Out.Flush()
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq '') { continue }
    $parts = $line -split '\\s+'
    $resp = ''
    try {
        switch ($parts[0]) {
            'assign' {
                $name = $parts[1]; $p = [uint32]$parts[2]
                if (-not $jobs.ContainsKey($name)) { $jobs[$name] = [JobGuard]::MakeJob() }
                $r = [JobGuard]::Assign($jobs[$name], $p)
                if ($r -eq 'ok') { $resp = "ok assign $name $p" } else { $resp = "ERR assign $name $p $r" }
            }
            'close' {
                $name = $parts[1]
                if ($jobs.ContainsKey($name)) {
                    [void][JobGuard]::CloseHandle($jobs[$name])
                    $jobs.Remove($name)
                    $resp = "ok close $name"
                } else { $resp = "ERR close nojob $name" }
            }
            'ping' { $resp = 'pong' }
            default { $resp = "ERR unknown $line" }
        }
    } catch {
        $resp = "ERR exception " + ($_.Exception.Message -replace '\\s+', '_')
    }
    [Console]::Out.WriteLine($resp)
    [Console]::Out.Flush()
}
`

  private ensureJobGuardian(): void {
    if (process.platform !== 'win32' || this.jobGuardian) return
    // teto anti-loop: 3 respawns em 60s param de insistir (evento fica nos
    // logs; taskkill+ceifa seguem cobrindo sozinhos)
    const now = Date.now()
    this.jobGuardianRespawns = this.jobGuardianRespawns.filter((t) => now - t < 60_000)
    if (this.jobGuardianRespawns.length >= 3) return
    this.jobGuardianRespawns.push(now)
    try {
      const scriptPath = join(tmpdir(), 'synkora-job-guardian.ps1')
      writeFileSync(scriptPath, PtyManager.JOB_GUARDIAN_PS1, 'utf-8')
      const child = spawnChildProcess(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      this.jobGuardian = child
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8')
        let idx = buffer.indexOf('\n')
        while (idx >= 0) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          idx = buffer.indexOf('\n')
          if (line.startsWith('ready')) {
            this.jobGuardianReady = true
            // re-assign das raízes vivas (respawn) cobre também os assigns
            // enfileirados (todo assign pendente é de pane em rootPids —
            // repetir daria ERR err_assign no log à toa); da fila sobram só
            // outros comandos
            for (const [paneId, pid] of this.rootPids) {
              child.stdin.write(`assign ${paneId} ${pid}\n`)
            }
            // externos (runtime do QA etc.) também voltam ao kernel no respawn
            for (const [name, pid] of this.externalPids) {
              child.stdin.write(`assign ${name} ${pid}\n`)
            }
            for (const queued of this.jobGuardianQueue.splice(0)) {
              if (!queued.startsWith('assign ')) child.stdin.write(`${queued}\n`)
            }
          } else if (line.startsWith('ERR')) {
            console.error(`[synkora] job guardian: ${line}`)
          }
        }
      })
      child.on('error', () => {
        this.jobGuardian = null
        this.jobGuardianReady = false
      })
      child.on('exit', () => {
        this.jobGuardian = null
        this.jobGuardianReady = false
        // guardião morto com panes vivos: respawn e re-assign (a árvore velha
        // fica coberta pelo taskkill+ceifa; a nova volta ao kernel)
        if (this.rootPids.size > 0) {
          setTimeout(() => this.ensureJobGuardian(), 1_000).unref?.()
        }
      })
    } catch {
      this.jobGuardian = null
      this.jobGuardianReady = false
    }
  }

  private jobSend(command: string): void {
    if (process.platform !== 'win32') return
    const child = this.jobGuardian
    if (child && this.jobGuardianReady) {
      try {
        child.stdin.write(`${command}\n`)
        return
      } catch {
        // guardião caiu no meio do write — enfileira para o respawn
      }
    }
    this.jobGuardianQueue.push(command)
    this.ensureJobGuardian()
  }

  /** close NUNCA ressuscita guardião morto: se ele caiu, o kill-on-close já
   *  derrubou todos os jobs — não há o que fechar. */
  private jobClose(paneId: string): void {
    if (process.platform !== 'win32') return
    const child = this.jobGuardian
    if (!child || !this.jobGuardianReady) return
    try {
      child.stdin.write(`close ${paneId}\n`)
    } catch {
      // guardião caindo agora — o kill-on-close resolve por si
    }
  }

  // PROCESSOS EXTERNOS SOB O GUARDIÃO (fix do mapa de retomada E5×Q4,
  // 2026-08-06): o runtime do QA era spawn próprio FORA dos jobs dos panes —
  // crash sujo do app deixava a árvore órfã. Registrado aqui, cada externo
  // ganha job próprio com KILL_ON_JOB_CLOSE: crash = EOF no guardião = a
  // árvore morre no kernel; e o unguard (close do job) vira a PRIMEIRA camada
  // do stop normal. O respawn do guardião re-assina também estes.
  private externalPids = new Map<string, number>()

  guardExternalPid(name: string, pid: number): void {
    if (process.platform !== 'win32' || !Number.isFinite(pid) || pid <= 0) return
    this.externalPids.set(name, pid)
    this.jobSend(`assign ${name} ${pid}`)
  }

  /** Fecha o job do processo externo — com o guardião vivo isso MATA a árvore
   *  no kernel (kill-on-close); o chamador mantém a própria ceifa como cinto. */
  unguardExternalPid(name: string): void {
    if (!this.externalPids.delete(name)) return
    this.jobClose(name)
  }

  private snapshotProcessTable(
    cb: (table: { pid: number; ppid: number; name: string }[]) => void
  ): void {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'
      ],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
      (error, stdout) => {
        if (error || !stdout) return cb([])
        try {
          const raw = JSON.parse(stdout) as {
            ProcessId?: number
            ParentProcessId?: number
            Name?: string
          }[]
          cb(
            (Array.isArray(raw) ? raw : [raw]).flatMap((row) =>
              typeof row?.ProcessId === 'number' && typeof row.ParentProcessId === 'number'
                ? [{ pid: row.ProcessId, ppid: row.ParentProcessId, name: row.Name ?? '' }]
                : []
            )
          )
        } catch {
          cb([])
        }
      }
    )
  }

  /** Expande o conjunto conhecido de cada pane por parentesco (BFS) — filho
   *  de qualquer pid já conhecido entra no everSeen. É a augmentação que liga
   *  órfãos de intermediário morto (o elo não existe mais na tabela viva). */
  private trackDescendants(table: { pid: number; ppid: number; name: string }[]): void {
    for (const [paneId, rootPid] of this.rootPids) {
      const seen = this.treeSeen.get(paneId) ?? new Map<number, string>()
      const known = new Set<number>([rootPid, ...seen.keys()])
      let grew = true
      while (grew) {
        grew = false
        for (const row of table) {
          if (known.has(row.pid) || !known.has(row.ppid)) continue
          known.add(row.pid)
          grew = true
        }
      }
      for (const row of table) {
        if (known.has(row.pid) && row.pid !== rootPid && row.pid !== process.pid) {
          seen.set(row.pid, row.name)
        }
      }
      if (seen.size) this.treeSeen.set(paneId, seen)
    }
  }

  private refreshTreeSnapshot(): void {
    if (process.platform !== 'win32' || this.rootPids.size === 0) return
    const now = Date.now()
    if (now - this.treeSnapshotAt < 5_000) return
    this.treeSnapshotAt = now
    this.snapshotProcessTable((table) => {
      if (table.length) this.trackDescendants(table)
    })
  }

  private ensureTreeTracker(): void {
    if (process.platform !== 'win32' || this.treeTimer) return
    this.treeTimer = setInterval(() => this.refreshTreeSnapshot(), 20_000)
    this.treeTimer.unref?.()
  }

  /** taskkill fast-path na árvore viva + ceifa verificada dos sobreviventes. */
  private reapTree(paneId: string, rootPid: number): void {
    if (process.platform !== 'win32') return
    execFile('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000
    }, () => {
      // exit 128 = raiz já morreu antes (corrida com o pty.kill) — sem
      // problema: a ceifa abaixo é o backstop determinístico
    })
    const seen = this.treeSeen.get(paneId)
    this.treeSeen.delete(paneId)
    this.rootPids.delete(paneId)
    const timer = setTimeout(() => {
      this.snapshotProcessTable((table) => {
        if (!table.length) return
        const byPid = new Map(table.map((row) => [row.pid, row]))
        // alcançável = everSeen + raiz, expandido por parentesco na tabela
        // FRESCA (pega filho nascido depois da última fotografia; órfão
        // preserva o ppid numérico do pai morto e continua alcançável)
        const known = new Set<number>([rootPid, ...(seen?.keys() ?? [])])
        let grew = true
        while (grew) {
          grew = false
          for (const row of table) {
            if (known.has(row.pid) || !known.has(row.ppid)) continue
            known.add(row.pid)
            grew = true
          }
        }
        for (const pid of known) {
          if (pid === process.pid) continue
          const fresh = byPid.get(pid)
          if (!fresh) continue
          // identidade: pid do everSeen antigo só morre se o NOME ainda bate
          // (anti reuso de PID); pid alcançado pela tabela fresca morre pelo
          // vínculo de parentesco atual
          const expected = seen?.get(pid)
          if (expected !== undefined && expected !== fresh.name) continue
          try {
            process.kill(pid)
          } catch {
            // já morreu ou sem permissão — best-effort
          }
        }
      })
    }, 700)
    timer.unref?.()
  }

  // CEIFA DE VISUAIS NO MARCO DE RODADA (caso real 2026-08-05: dev vivo
  // esperandinho largou 1 Chrome + 2 Electron abertos — a camada dura só age
  // na MORTE do pane, e com gates vivos + dev vivo os panes ficam abertos por
  // design; prompt "feche antes do done" nem alcança conversa retomada).
  // Mata SÓ descendentes com nome de app visual; o CLI e os MCP servers ficam
  // intactos (o Playwright MCP relança o browser quando precisar — provado na
  // sonda). "Abriu, testou, reportou → fechou" vira lei de máquina.
  private static readonly VISUAL_PROCESS_NAMES = new Set([
    'chrome.exe',
    'msedge.exe',
    'firefox.exe',
    'electron.exe'
  ])

  reapVisualsOf(paneId: string): void {
    if (process.platform !== 'win32') return
    const rootPid = this.rootPids.get(paneId)
    if (!rootPid) return
    const seen = this.treeSeen.get(paneId)
    this.snapshotProcessTable((table) => {
      if (!table.length) return
      const byPid = new Map(table.map((row) => [row.pid, row]))
      const known = new Set<number>([rootPid, ...(seen?.keys() ?? [])])
      let grew = true
      while (grew) {
        grew = false
        for (const row of table) {
          if (known.has(row.pid) || !known.has(row.ppid)) continue
          known.add(row.pid)
          grew = true
        }
      }
      for (const pid of known) {
        if (pid === rootPid || pid === process.pid) continue
        const fresh = byPid.get(pid)
        if (!fresh) continue
        if (!PtyManager.VISUAL_PROCESS_NAMES.has(fresh.name.toLowerCase())) continue
        try {
          // matar o processo principal basta: os subprocessos --type= do
          // Chromium se auto-encerram pelo pipe quebrado (sonda: <3s)
          process.kill(pid)
        } catch {
          // já morreu — best-effort
        }
      }
    })
  }

  private safeWrite(pty: IPty, data: string): boolean {
    if (this.deadPtys.has(pty) || this.killedPtys.has(pty)) return false
    try {
      pty.write(data)
      return true
    } catch {
      // processo morto no meio do gesto — ignorar é o comportamento certo
      return false
    }
  }

  write(id: string, data: string): void {
    // rastro do TECLADO DO USUÁRIO (o inject NÃO passa por aqui): é a única
    // coisa que ainda segura uma injeção — colidir com o humano digitando.
    // MAS o xterm também RESPONDE sozinho a queries do TUI por este mesmo
    // canal (DSR/DA/OSC de cor) — resposta automática NÃO é dedo humano e
    // marcá-la deixava o composer quente p/ sempre (caso real 2026-07-30).
    if (this.hasHumanInput(data)) {
      const now = Date.now()
      this.lastKeyAt.set(id, now)
      this.lastHumanAt.set(id, now)
    }
    const blocked = this.feedInput(id, data)
    const pty = this.ptys.get(id)
    if (pty && blocked?.action === 'block') {
      // The line may already be painted by the shell editor. Ctrl+C cancels it
      // without executing any byte; the following notice is renderer-only.
      this.safeWrite(pty, '\x03')
      this.shellSecurity.get(id)?.notify(blocked.reason)
      return
    }
    if (pty) this.safeWrite(pty, data)
  }

  /** Há risco de COLISÃO com o humano neste pane? Sondado em PTY real
   *  (2026-07-29): injetar com o composer SUJO insere na posição do cursor e
   *  o Enter submete tudo concatenado — é o ÚNICO caso em que injeção
   *  corrompe; TUI ocupado imprimindo é seguro (a fila de input do próprio
   *  CLI enfileira e entrega). Sujo = texto pendente rastreado pelo
   *  feedInput OU tecla/paste do usuário há menos de `ms`. */
  composerBusy(id: string, ms = 1500): boolean {
    if ((this.inputBufs.get(id) ?? '').trim() !== '') {
      // VÁLVULA (2026-07-30): resíduo no buffer SEM atividade humana há 30s
      // não é rascunho de gente — é sujeira (resposta automática, paste com
      // marcador perdido). Limpa e libera: composer preso para sempre matava
      // toda a coordenação por injeção (dev surdo ao orquestrador).
      if (Date.now() - (this.lastHumanAt.get(id) ?? 0) > 30_000) {
        this.inputBufs.set(id, '')
        this.pasting.delete(id)
      } else {
        return true
      }
    }
    return Date.now() - (this.lastKeyAt.get(id) ?? 0) < ms
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return
    // O pty PRECISA existir antes de gravar o tamanho: sem pane, o `sizes`
    // passava a MENTIR — o pty nascia depois com o tamanho do spawn enquanto
    // o dedupe achava que já estava no tamanho novo, e a quebra de linha
    // ficava errada para sempre, sem log nenhum.
    const pty = this.ptys.get(id)
    if (!pty) return
    const key = `${cols}x${rows}`
    if (this.sizes.get(id) === key) return
    // INSTRUMENTAÇÃO TEMPORÁRIA (duplicação de banner): quantos SIGWINCH saem
    // por gesto, e quantas vezes o CLI reimprime depois de cada um. Remover
    // quando o caso estiver fechado.
    if (process.env['SYNKORA_PROBE'] === '1') {
      console.log(
        `[probe] RESIZE ${id.slice(0, 8)} ${this.sizes.get(id) ?? '?'} -> ${key} @${Date.now() % 100000}`
      )
      this.probeUntil.set(id, Date.now() + 3000)
    }
    this.sizes.set(id, key)
    if (this.deadPtys.has(pty) || this.killedPtys.has(pty)) return
    try {
      pty.resize(cols, rows)
    } catch {
      // processo morreu entre o get e o resize — no-op
    }
  }

  /** Limpa o buffer do BACKEND (ConptyClearPseudoConsole). No-op sem a DLL;
   *  com ela é a forma OFICIAL de sincronizar o /clear do TUI — melhor que
   *  injetar ED2/ED3 no renderer e torcer para o TUI concordar. */
  clear(id: string): void {
    try {
      ;(this.ptys.get(id) as { clear?: () => void } | undefined)?.clear?.()
    } catch {
      // best-effort: backend antigo não tem clear
    }
  }

  /** Um pty só recebe UM kill na vida (killedPtys) e pty já morto (deadPtys)
   *  nunca é tocado — é o que segura o assert fatal do conpty.node. */
  private safeKill(pty: IPty): void {
    if (this.deadPtys.has(pty) || this.killedPtys.has(pty)) return
    this.killedPtys.add(pty)
    try {
      pty.kill()
    } catch {
      // já estava morto
    }
  }

  kill(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    const pty = this.ptys.get(id)
    const fallback = this.exitFallbacks.get(id)
    if (pty && fallback?.pty === pty && !fallback.timer) {
      fallback.timer = setTimeout(fallback.force, 1_500)
    }
    // A árvore morre junto: Job Object primeiro (kernel — mata inclusive
    // órfão de pai morto), taskkill como segunda camada (cobre o que nasceu
    // antes do assign) e a ceifa por fotografia fecha a corrida.
    if (pty) this.jobClose(id)
    const rootPid = this.rootPids.get(id) ?? pty?.pid
    if (pty && rootPid) this.reapTree(id, rootPid)
    if (pty) this.safeKill(pty)
    this.ptys.delete(id)
    this.lastOutput.delete(id)
    this.sizes.delete(id)
    this.inputBufs.delete(id)
    this.cmdHooks.delete(id)
    this.submitHooks.delete(id)
    this.shellSecurity.delete(id)
    this.resumeProbeStops.delete(id)
    this.pasting.delete(id)
    this.escCarry.delete(id)
    this.inOsc.delete(id)
    this.lastHumanAt.delete(id)
  }

  killAll(): void {
    // Grava a cauda de todos os transcripts antes de encerrar os processos.
    for (const flush of this.flushers.values()) flush()
    for (const id of this.generations.keys()) {
      this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    }
    // Quit do app: fecha os jobs (kernel mata as árvores) + taskkill por raiz
    // viva como segunda camada; a ceifa de 700ms pode não rodar com o app
    // saindo. E mesmo num crash sem passar por aqui, o EOF do guardião fecha
    // os handles e derruba tudo — é o cinto que o dirty-exit não tinha.
    if (process.platform === 'win32') {
      for (const id of this.ptys.keys()) {
        this.jobClose(id)
        const rootPid = this.rootPids.get(id)
        if (!rootPid) continue
        try {
          execFile('taskkill', ['/PID', String(rootPid), '/T', '/F'], { windowsHide: true })
        } catch {
          // best-effort no quit
        }
      }
    }
    for (const pty of this.ptys.values()) this.safeKill(pty)
    this.ptys.clear()
    this.lastOutput.clear()
    this.sizes.clear()
    this.inputBufs.clear()
    this.cmdHooks.clear()
    this.submitHooks.clear()
    this.shellSecurity.clear()
    this.resumeProbeStops.clear()
    for (const fallback of this.exitFallbacks.values()) {
      if (fallback.timer) clearTimeout(fallback.timer)
    }
    this.exitFallbacks.clear()
    this.pasting.clear()
    this.escCarry.clear()
    this.inOsc.clear()
    this.lastHumanAt.clear()
    this.flushers.clear()
  }
}
