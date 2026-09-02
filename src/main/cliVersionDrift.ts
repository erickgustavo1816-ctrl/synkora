/**
 * A RÉGUA DO VIGIA DE VERSÃO DOS CLIs (2026-09-01).
 *
 * Caso real do dono: o Fable 5.1 saiu, o `claude` foi atualizado por fora do
 * app (15:29) e o Synkora — de pé desde a véspera — continuou servindo o
 * catálogo do binário velho: o modelo novo não aparecia em lugar nenhum. O
 * updater só lê a versão no BOOT, e o catálogo de modelos é cache eterno por
 * processo invalidado SÓ por mudança de versão — que nunca era observada.
 *
 * Este módulo é a decisão pura: dado o estado que o app carrega e a versão que
 * o binário respondeu AGORA, o que muda. Folha de propósito (sem electron, sem
 * child_process) para a suíte provar a régua em node cru; a costura com o
 * relógio e o `--version` real mora em `cliUpdate.ts`.
 */

export interface CliVersionSeen {
  /** versão que o app carrega para este CLI (null = ausente) */
  version: string | null
  /** estado do updater — uma rodada em curso é dona da verdade */
  state: string
}

export interface CliVersionDrift {
  version: string | null
  from?: string
  state: 'updated' | 'missing'
  detail: string
}

/**
 * `null` = nada mudou (ou não é hora de dizer: rodada de update em curso e
 * versão ainda nunca lida são do updater, não do vigia).
 *
 * Versão diferente da carregada vira `updated` — o MESMO estado que uma
 * rodada do app produz, porque para o resto do app é o mesmo fato: o binário
 * mudou e todo catálogo lido antes está velho. O `detail` diz de onde veio.
 * Binário que sumiu do PATH vira `missing`, uma vez só.
 */
export function cliVersionDrift(
  current: CliVersionSeen,
  observed: string | null
): CliVersionDrift | null {
  if (current.state === 'updating' || current.state === 'unknown') return null
  if (observed === null) {
    if (current.version === null) return null
    return {
      version: null,
      from: current.version,
      state: 'missing',
      detail: `o CLI sumiu do PATH (era ${current.version})`
    }
  }
  if (observed === current.version) return null
  return {
    version: observed,
    ...(current.version ? { from: current.version } : {}),
    state: 'updated',
    detail: current.version
      ? `versão mudou fora do app: ${current.version} → ${observed}`
      : `CLI voltou ao PATH na versão ${observed}`
  }
}
