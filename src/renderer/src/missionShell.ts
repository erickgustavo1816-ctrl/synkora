// Ponte tipada do `missions:shellSpec` (Synkora 2.0, onda C).
//
// A missão direta tem uma ÚNICA utilidade de shell no trilho de entrega: um
// terminal cru no worktree dela (rodar git, um script, olhar um arquivo). Não
// é agente e não é servidor de teste — nasce sem CLI, sem persona e sem MCP.
//
// O main já publicou o tipo (o motor da onda C mesclou), então este módulo
// fala com `window.synkora.missions` de verdade — sem cast e sem cópia local
// da forma da spec, que envelheceria em silêncio. O que sobra aqui é o que só
// o renderer sabe fazer: nunca explodir com a ponte ausente (devMock/browser
// puro) e traduzir a falha para uma frase que cabe na UI.
//
// Ele é a ÚNICA costura do renderer com esse canal: nenhum componente chama
// `window.synkora.missions.shellSpec` direto.

import type { MissionShellSpecResult } from '../../preload/index'

export type { MissionShellSpecResult }

function bridge(): Window['synkora']['missions'] | undefined {
  // `window.synkora` não existe no browser puro (devMock monta o que conhece):
  // a leitura é opcional de propósito, apesar do tipo prometer o objeto.
  return (window as Partial<Window>).synkora?.missions
}

const NO_BRIDGE =
  'reinicie o app (npm run dev) para habilitar o terminal da missão — esta janela ainda não tem a ponte'

export const missionShell = {
  /** false = janela sem `shellSpec` (browser puro ou preload antigo). A UI
   *  mostra o aviso em vez de fingir que abriu. */
  available(): boolean {
    return typeof bridge()?.shellSpec === 'function'
  },

  async spec(missionId: string): Promise<MissionShellSpecResult> {
    const api = bridge()
    if (typeof api?.shellSpec !== 'function') return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.shellSpec(missionId)) ?? { ok: false, error: NO_BRIDGE }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
