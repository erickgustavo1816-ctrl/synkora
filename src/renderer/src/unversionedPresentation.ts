import { openSoloMission } from '../../shared/projectVersioning'

// ————————————————————————————————————————————————————————————————————————
// O UNIVERSO SEM VERSIONAMENTO FORA DELE: a Home e o rail (2026-09-30; mockup
// aprovado: docs/mockups/projeto-sem-versao-2026-09-30.html cena 7, com a
// marca trocada pelo SELO DE PASTA — opção B de
// projeto-sem-versao-marca-2026-09-30.html).
//
// Puro: nenhum store, nenhum DOM. O card e o rail perguntam aqui o que dizer;
// scripts/test-unversioned-home.mjs prova as regras pelos componentes.
// ————————————————————————————————————————————————————————————————————————

/** A etiqueta textual do modo — acompanha o selo onde há espaço (o ícone
 *  nunca fica sozinho). */
export const UNVERSIONED_MODE_LABEL = 'sem versionamento'

/** O retrato do card da Home: a missão que o dono procura (a ABERTA, pelo
 *  título) e o tamanho do histórico. Sem versão, não há barra para medir. */
export interface SoloHomeStats {
  openMissionTitle: string | null
  finished: number
}

export function soloHomeStats(
  missions: readonly { projectId: string; status: string; title: string }[],
  projectId: string
): SoloHomeStats {
  return {
    openMissionTitle: openSoloMission(missions, projectId)?.title ?? null,
    finished: missions.filter((m) => m.projectId === projectId && m.status === 'concluida').length
  }
}

export type SoloActivityLine = { kind: 'open'; title: string } | { kind: 'idle'; text: string }

/** A linha "missão" do card: o título da aberta, ou "nenhuma aberta · N
 *  finalizadas" (com o plural certo; sem histórico, só "nenhuma aberta"). */
export function soloActivityLine(stats: SoloHomeStats): SoloActivityLine {
  if (stats.openMissionTitle) return { kind: 'open', title: stats.openMissionTitle }
  if (stats.finished === 0) return { kind: 'idle', text: 'nenhuma aberta' }
  const finished = stats.finished === 1 ? '1 finalizada' : `${stats.finished} finalizadas`
  return { kind: 'idle', text: `nenhuma aberta · ${finished}` }
}

/** O nome acessível do universo com o modo dito em palavras (o selo é
 *  `aria-hidden`: quem carrega o sentido é o rótulo do avatar). */
export function projectNameWithMode(name: string, unversioned: boolean): string {
  return unversioned ? `${name} (${UNVERSIONED_MODE_LABEL})` : name
}

/** A dica do rail ganha o modo logo abaixo do nome (primeira linha). */
export function railTipWithMode(tip: string, unversioned: boolean): string {
  if (!unversioned) return tip
  const cut = tip.indexOf('\n')
  return cut < 0
    ? `${tip}\n${UNVERSIONED_MODE_LABEL}`
    : `${tip.slice(0, cut)}\n${UNVERSIONED_MODE_LABEL}${tip.slice(cut)}`
}
