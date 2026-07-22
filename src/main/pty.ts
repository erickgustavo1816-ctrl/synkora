import { spawn, type IPty } from '@lydell/node-pty'
import { appendFileSync } from 'fs'
import type { WebContents } from 'electron'
import { freshWindowsPath } from './winPath'

// Limpa a saída crua do PTY para o transcript: remove sequências ANSI/OSC e
// normaliza quebras. TUIs redesenham muito — linhas repetidas são suprimidas.
function cleanPtyChunk(raw: string): string {
  return raw
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
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
  /** Chamado quando a saída parece um PEDIDO DE APROVAÇÃO do CLI (heurística). */
  onAttention?: () => void
}

// Sinais de prompt de aprovação nos TUIs (claude e codex, en/pt).
const ATTENTION_RE =
  /(do you want|allow (this|command)|approve|permission|autorizar|deseja permitir|permitir\?|\by\/n\b|press enter to (approve|confirm)|1\.\s*yes)/i

const CLI_COMMAND: Record<Exclude<PaneKind, 'shell'>, string> = {
  claude: 'claude',
  codex: 'codex'
}

export class PtyManager {
  private ptys = new Map<string, IPty>()

  create(wc: WebContents, opts: PtyCreateOptions): void {
    if (this.ptys.has(opts.id)) return

    const isWin = process.platform === 'win32'
    const shell = isWin ? 'powershell.exe' : (process.env['SHELL'] ?? 'bash')
    // Panes de CLI abrem o shell já executando o comando; se o CLI não
    // estiver instalado, o erro aparece dentro do próprio terminal.
    let args: string[]
    if (opts.kind === 'shell') {
      args = isWin ? ['-NoLogo'] : []
    } else {
      let command = CLI_COMMAND[opts.kind]
      if (opts.model) command += ` --model ${opts.model.replace(/[^\w.:-]/g, '')}`
      for (const arg of opts.cliArgs ?? []) {
        command += ` ${arg.replace(/[&|;<>$`"'\s]/g, '')}`
      }
      const quote = (text: string): string => {
        const flat = text.replace(/\s+/g, ' ').trim()
        return isWin ? `'${flat.replace(/'/g, "''")}'` : `'${flat.replace(/'/g, `'\\''`)}'`
      }
      if (opts.appendSystemPrompt) {
        command += ` --append-system-prompt ${quote(opts.appendSystemPrompt)}`
      }
      if (opts.initialPrompt) {
        command += ` ${quote(opts.initialPrompt)}`
      }
      args = isWin ? ['-NoLogo', '-NoExit', '-Command', command] : ['-lc', command]
    }

    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cols: opts.cols && opts.cols > 0 ? opts.cols : 80,
      rows: opts.rows && opts.rows > 0 ? opts.rows : 24,
      cwd: opts.cwd,
      env: {
        ...(process.env as Record<string, string>),
        PATH: freshWindowsPath(),
        ...(opts.extraEnv ?? {})
      }
    })

    // Tee com flush periódico: gravar a cada frame de redraw do TUI seria
    // I/O demais — acumula e escreve a cada 1,5s, sem linhas duplicadas.
    let logBuf = ''
    let lastLine = ''
    let logTimer: NodeJS.Timeout | null = null
    let lastAttention = 0
    const flushLog = (): void => {
      if (!logBuf) return
      const lines = cleanPtyChunk(logBuf).split('\n')
      logBuf = ''
      const out: string[] = []
      for (const line of lines) {
        const t = line.trimEnd()
        if (!t.trim() || t === lastLine) continue
        lastLine = t
        out.push(t)
        // Prompt de aprovação detectado → avisa (com folga de 30s entre avisos).
        if (opts.onAttention && ATTENTION_RE.test(t) && Date.now() - lastAttention > 30_000) {
          lastAttention = Date.now()
          opts.onAttention()
        }
      }
      if (out.length && opts.logFile) {
        try {
          appendFileSync(opts.logFile, out.join('\n') + '\n', 'utf-8')
        } catch {
          // transcript é best-effort
        }
      }
    }

    pty.onData((data) => {
      if (!wc.isDestroyed()) wc.send('pty:data', opts.id, data)
      if (opts.logFile || opts.onAttention) {
        logBuf += data
        if (!logTimer) {
          logTimer = setTimeout(() => {
            logTimer = null
            flushLog()
          }, 1500)
        }
      }
    })
    pty.onExit(({ exitCode }) => {
      if (logTimer) clearTimeout(logTimer)
      flushLog()
      this.ptys.delete(opts.id)
      if (!wc.isDestroyed()) wc.send('pty:exit', opts.id, exitCode)
    })

    this.ptys.set(opts.id, pty)
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.ptys.get(id)?.resize(cols, rows)
  }

  kill(id: string): void {
    this.ptys.get(id)?.kill()
    this.ptys.delete(id)
  }

  killAll(): void {
    for (const pty of this.ptys.values()) pty.kill()
    this.ptys.clear()
  }
}
