// Ponte tipada do `projects:planningGuiSpec` (Synkora 2.0, onda C).
//
// Sem missão LEGADA viva o projeto não tem PM permanente — e não precisa: o
// planejamento é PONTUAL. O dono abre uma conversa que entrevista, escreve o
// roadmap em `plano/` e fecha. Quem cria as missões continua sendo ele, no
// app; esta sessão só produz o plano.
//
// O main já publicou o tipo (o motor da onda C mesclou), então este módulo
// fala com `window.synkora.projects` de verdade. O que sobra aqui é o que só o
// renderer sabe fazer: não explodir com a ponte ausente (devMock/browser puro)
// e traduzir a falha para uma frase que cabe na UI.
//
// Ele é a ÚNICA costura do renderer com esse canal: nenhum componente chama
// `window.synkora.projects.planningGuiSpec` direto.

import type { PlanningGuiSpecResult } from '../../preload/index'

export type { PlanningGuiSpecResult }

function bridge(): Window['synkora']['projects'] | undefined {
  // `window.synkora` não existe no browser puro (devMock monta o que conhece):
  // a leitura é opcional de propósito, apesar do tipo prometer o objeto.
  return (window as Partial<Window>).synkora?.projects
}

const NO_BRIDGE =
  'reinicie o app (npm run dev) para habilitar a sessão de planejamento — esta janela ainda não tem a ponte'

/** paneId da sessão de planejamento do projeto — a MESMA convenção do main
 *  (`projects:planningGuiSpec`): é ele que endereça o resume gravado, e é por
 *  isso que reabrir o universo cai na conversa de antes, não numa em branco. */
export function planningPaneId(projectId: string): string {
  return `gui-plan-${projectId.slice(0, 8)}`
}

export const planningGui = {
  /** false = janela sem `planningGuiSpec` (browser puro ou preload antigo). A
   *  UI mostra o aviso em vez de fingir que abriu. */
  available(): boolean {
    return typeof bridge()?.planningGuiSpec === 'function'
  },

  async spec(projectId: string): Promise<PlanningGuiSpecResult> {
    const api = bridge()
    if (typeof api?.planningGuiSpec !== 'function') return { ok: false, error: NO_BRIDGE }
    try {
      return (await api.planningGuiSpec(projectId)) ?? { ok: false, error: NO_BRIDGE }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }
}
