import type { CliName, CliStatus } from './cliUpdate'

export interface GuiCliLaunchDeps {
  getStatus(): readonly Pick<CliStatus, 'cli' | 'state'>[]
  isUpdating(): boolean
  updateAll(): Promise<unknown>
}

/**
 * Impede o pane GUI de nascer enquanto o atualizador pode estar trocando o
 * executável global do CLI. `updateAll` é single-flight: no estado `updating`
 * esta chamada apenas se junta à rodada viva; em `unknown`, ela antecipa a
 * checagem do boot e aguarda a mesma barreira.
 */
export async function waitForGuiCliStable(
  cli: CliName,
  deps: GuiCliLaunchDeps
): Promise<void> {
  const state = deps.getStatus().find((candidate) => candidate.cli === cli)?.state ?? 'unknown'
  // `updateAllClis` atualiza os dois CLIs. O sinal global fecha a janela em
  // que a rodada já nasceu, mas o `readVersion` ainda não mudou este CLI de
  // um estado estável para `updating`.
  if (deps.isUpdating() || state === 'unknown' || state === 'updating') await deps.updateAll()
}
