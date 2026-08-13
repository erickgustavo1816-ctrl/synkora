// Ponte tipada do `missions:guiSpec` (Synkora 2.0, onda B).
//
// A missão DIRETA não tem orquestrador: abrir a aba dela abre um CHAT GUI já
// posicionado no worktree, com a conta/modelo da missão e o briefing como
// primeiro turno. Quem monta essa spec é o main (agente MOTOR); este arquivo é
// a ÚNICA costura do lado do renderer — nenhum componente fala com
// `window.synkora.missions.guiSpec` direto.
//
// Mesmo padrão de `guiApi.ts`: enquanto as duas frentes da onda não mesclam, o
// preload deste worktree ainda não declara `guiSpec`, então o acesso passa por
// um cast estreito resolvido A CADA CHAMADA (o namespace pode nascer depois
// deste módulo ser importado).
// TODO(onda B, motor): quando o preload publicar o tipo, trocar `bridge()` por
// `window.synkora.missions` e apagar a interface local — nada fora daqui muda.

import type { GuiPaneSpawn } from './guiApi'

/** Papéis que a missão direta sabe abrir. `helper` nasce com paneId único a
 *  cada chamada (sufixo numérico) — os demais são estáveis por missão. */
export type MissionGuiRole = 'dev' | 'reviewer' | 'helper'

export interface MissionGuiSpecResult {
  ok: boolean
  spawn?: GuiPaneSpawn
  error?: string
}

interface MissionGuiBridge {
  guiSpec: (missionId: string, role: MissionGuiRole) => Promise<MissionGuiSpecResult>
}

function bridge(): Partial<MissionGuiBridge> | undefined {
  return (window as unknown as { synkora?: { missions?: Partial<MissionGuiBridge> } }).synkora
    ?.missions
}

const NO_BRIDGE =
  'reinicie o app (npm run dev) para habilitar o chat da missão — esta janela ainda não tem a ponte'

export const missionGui = {
  /** false = preload sem `guiSpec` (devMock/browser puro, ou motor ainda não
   *  mesclado). A UI mostra o aviso em vez de fingir que abriu. */
  available(): boolean {
    return typeof bridge()?.guiSpec === 'function'
  },

  async spec(missionId: string, role: MissionGuiRole): Promise<MissionGuiSpecResult> {
    const api = bridge()
    if (!api?.guiSpec) return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.guiSpec(missionId, role)) ?? { ok: false, error: NO_BRIDGE }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
