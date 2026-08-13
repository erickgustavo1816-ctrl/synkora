// Ponte tipada do `missions:shellSpec` (Synkora 2.0, onda C).
//
// A missão direta tem uma ÚNICA utilidade de shell no trilho de entrega: um
// terminal cru no worktree dela (rodar git, um script, olhar um arquivo). Não
// é agente e não é servidor de teste — nasce sem CLI, sem persona e sem MCP.
//
// Mesmo padrão de `missionGui.ts`: enquanto as duas frentes da onda não
// mesclam, o preload deste worktree ainda não declara `shellSpec`, então o
// acesso passa por um cast estreito resolvido A CADA CHAMADA (o namespace pode
// nascer depois deste módulo ser importado).
// TODO(onda C, motor): quando o preload publicar o tipo, trocar `bridge()` por
// `window.synkora.missions` e apagar a interface local — nada fora daqui muda.

/** Spec de um pane SHELL, no formato que o deck de panes já sabe montar. */
export interface MissionShellSpec {
  paneId: string
  cwd: string
  kind?: 'shell'
  seatId?: string
  missionId?: string
  title?: string
  cliArgs?: string[]
  initialPrompt?: string
  logFile?: string
}

export interface MissionShellSpecResult {
  ok: boolean
  spec?: MissionShellSpec
  error?: string
}

interface MissionShellBridge {
  shellSpec: (missionId: string) => Promise<MissionShellSpecResult>
}

function bridge(): Partial<MissionShellBridge> | undefined {
  return (window as unknown as { synkora?: { missions?: Partial<MissionShellBridge> } }).synkora
    ?.missions
}

const NO_BRIDGE =
  'reinicie o app (npm run dev) para habilitar o terminal da missão — esta janela ainda não tem a ponte'

export const missionShell = {
  /** false = preload sem `shellSpec` (devMock/browser puro, ou motor ainda não
   *  mesclado). A UI mostra o aviso em vez de fingir que abriu. */
  available(): boolean {
    return typeof bridge()?.shellSpec === 'function'
  },

  async spec(missionId: string): Promise<MissionShellSpecResult> {
    const api = bridge()
    if (!api?.shellSpec) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.shellSpec(missionId)) ?? { ok: false, error: NO_BRIDGE }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
