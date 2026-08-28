import { execFile } from 'child_process'
import { resolve } from 'path'

// O NAVEGADOR QUE SEGURAVA A MISSÃO (incidente 2026-08-28).
//
// A integração da missão e8579a6d gravou o merge e travou na limpeza. O
// culpado, achado por varredura filho a filho: um Edge HEADLESS aberto às
// 14:19 por um agente para teste visual, com `--user-data-dir` dentro do
// worktree (`.synkora/runs/file-step-…/edge-profile`). Os arquivos LOCK do
// perfil fazem o `git worktree remove` falhar PARA SEMPRE — nenhuma janela de
// re-tentativa resolve, porque o processo não estava morrendo: estava vivo.
//
// A ceifa que já existia (`PtyManager.reapVisualsOf`) age por PARENTESCO de
// pane. Este navegador escapou dela: nasceu de uma sessão GUI/ajudante, fora
// da árvore de um PTY. Aqui a régua é o CAMINHO — quem aponta para dentro do
// worktree que vai sumir.
//
// DUAS condições, sempre as duas: nome de app visual E linha de comando
// apontando para a raiz. Só o nome seria o fratricídio proibido pela casa
// (matar o Chrome do dono); só o caminho mataria a própria sonda que menciona
// a pasta — foi exatamente o falso positivo colhido na investigação.

/** Apps que ABREM JANELA (ou fingem abrir, no headless). Fonte única: o
 *  `PtyManager` importa daqui — duas listas divergiriam com o tempo. */
export const VISUAL_PROCESS_NAMES = new Set([
  'chrome.exe',
  'msedge.exe',
  'firefox.exe',
  'electron.exe'
])

/** `\` e `/` misturados são a regra no Windows; a comparação é sem caixa. */
function comparable(value: string): string {
  return resolve(value).replace(/\\/g, '/').toLocaleLowerCase('en-US')
}

export function processTargetsRoot(commandLine: string, root: string): boolean {
  if (!commandLine.trim() || !root.trim()) return false
  return commandLine.replace(/\\/g, '/').toLocaleLowerCase('en-US').includes(comparable(root))
}

/**
 * Derruba os apps visuais enraizados em `root`. Best-effort e assíncrono: a
 * limpeza que vem depois tem a própria janela de re-tentativa, e um navegador
 * que insiste vira bloqueio auditado — nunca uma missão declarada pronta.
 */
export function reapVisualsUnder(root: string, onDone?: () => void): void {
  if (process.platform !== 'win32' || !root.trim()) return onDone?.()
  execFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 },
    (error, stdout) => {
      if (error || !stdout) return onDone?.()
      let linhas: { ProcessId?: number; Name?: string; CommandLine?: string }[] = []
      try {
        const bruto = JSON.parse(stdout) as unknown
        linhas = (Array.isArray(bruto) ? bruto : [bruto]) as typeof linhas
      } catch {
        return onDone?.()
      }
      for (const linha of linhas) {
        const pid = linha?.ProcessId
        const nome = linha?.Name?.toLocaleLowerCase('en-US')
        if (typeof pid !== 'number' || pid === process.pid || !nome) continue
        if (!VISUAL_PROCESS_NAMES.has(nome)) continue
        if (!processTargetsRoot(linha.CommandLine ?? '', root)) continue
        try {
          // o principal basta: os `--type=` do Chromium caem pelo pipe quebrado
          process.kill(pid)
        } catch {
          // já morreu ou sem permissão — best-effort
        }
      }
      onDone?.()
    }
  )
}
