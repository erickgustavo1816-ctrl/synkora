// Ponte tipada do `projects:planningGuiSpec` (Synkora 2.0, onda C).
//
// Sem missão LEGADA viva o projeto não tem PM permanente — e não precisa: o
// planejamento é PONTUAL. O dono abre uma conversa que entrevista, escreve o
// roadmap em `plano/` e fecha. Quem cria as missões continua sendo ele, no
// app; esta sessão só produz o plano.
//
// Mesmo padrão de `missionGui.ts`: enquanto as duas frentes da onda não
// mesclam, o preload deste worktree ainda não declara `planningGuiSpec`, então
// o acesso passa por um cast estreito resolvido A CADA CHAMADA.
// TODO(onda C, motor): quando o preload publicar o tipo, trocar `bridge()` por
// `window.synkora.projects` e apagar a interface local.

import type { GuiPaneSpawn } from './guiApi'

export interface PlanningGuiSpecResult {
  ok: boolean
  spawn?: GuiPaneSpawn
  error?: string
}

interface PlanningGuiBridge {
  planningGuiSpec: (projectId: string) => Promise<PlanningGuiSpecResult>
}

function bridge(): Partial<PlanningGuiBridge> | undefined {
  return (window as unknown as { synkora?: { projects?: Partial<PlanningGuiBridge> } }).synkora
    ?.projects
}

const NO_BRIDGE =
  'reinicie o app (npm run dev) para habilitar a sessão de planejamento — esta janela ainda não tem a ponte'

/** paneId da sessão de planejamento do projeto (convenção do main). */
export function planningPaneId(projectId: string): string {
  return `gui-plan-${projectId.slice(0, 8)}`
}

export const planningGui = {
  /** false = preload sem `planningGuiSpec` (devMock/browser puro, ou motor
   *  ainda não mesclado). A UI mostra o aviso em vez de fingir que abriu. */
  available(): boolean {
    return typeof bridge()?.planningGuiSpec === 'function'
  },

  async spec(projectId: string): Promise<PlanningGuiSpecResult> {
    const api = bridge()
    if (!api?.planningGuiSpec) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.planningGuiSpec(projectId)) ?? { ok: false, error: NO_BRIDGE }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
