import { spawn, type ChildProcess } from 'child_process'

export interface GuiTreeKillCommand {
  file: string
  args: string[]
}

export function guiTreeKillCommand(
  platform: NodeJS.Platform,
  pid: number | undefined
): GuiTreeKillCommand | null {
  if (platform !== 'win32' || !pid || !Number.isSafeInteger(pid) || pid <= 0) return null
  return { file: 'taskkill.exe', args: ['/pid', String(pid), '/t', '/f'] }
}

export function guiChildNeedsTermination(
  exitCode: number | null,
  signalCode: NodeJS.Signals | null
): boolean {
  return exitCode === null && signalCode === null
}

/** Encerra a árvore do CLI, não apenas o shell intermediário do Windows. */
export async function terminateGuiProcessTree(child: ChildProcess): Promise<void> {
  // Depois de `close`, o PID pode ser reutilizado por outro processo. Nunca
  // execute taskkill usando apenas o pid histórico de um filho já terminado.
  if (!guiChildNeedsTermination(child.exitCode, child.signalCode)) return
  try {
    child.stdin?.end()
  } catch {
    // stdin ja fechou
  }

  const command = guiTreeKillCommand(process.platform, child.pid)
  if (command) {
    const fallback = (): void => {
      if (!guiChildNeedsTermination(child.exitCode, child.signalCode)) return
      try {
        child.kill()
      } catch {
        // processo ja saiu
      }
    }
    try {
      const killer = spawn(command.file, command.args, {
        shell: false,
        windowsHide: true,
        stdio: 'ignore'
      })
      await new Promise<void>((resolve) => {
        killer.once('error', () => {
          fallback()
          resolve()
        })
        killer.once('close', (code) => {
          if (code !== 0) fallback()
          resolve()
        })
        killer.unref()
      })
      return
    } catch {
      fallback()
      return
    }
  }

  try {
    child.kill('SIGTERM')
  } catch {
    // processo ja saiu
  }
}
