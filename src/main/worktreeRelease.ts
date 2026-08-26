// A MORTE DE UM PROCESSO É ASSÍNCRONA (incidente 2026-08-26, missão f5c8fa04).
//
// O ⇪ mata os panes da missão ANTES do merge de propósito — o worktree some na
// limpeza e um processo com `cwd` dentro dele trava a remoção no Windows. A
// intenção sempre esteve certa; o que faltava era ESPERAR: `ptys.kill` e
// `killMissionGuiPanes` retornam quando o SINAL foi enviado, não quando o filho
// (codex/claude `app-server`, nascido com cwd no worktree) soltou a pasta. O
// `git worktree remove` disparado na linha seguinte corre contra esse velório e
// perde: o git remove o `.git` e parte do conteúdo, falha no rmdir final e
// deixa uma CARCAÇA — a pasta órfã que o reparo de boot precisa depois provar e
// pôr de quarentena.
//
// A cura é uma tentativa que insiste por uma janela curta. Nada aqui decide
// nada sobre git: a decisão continua inteira em `removeWorktreeAndBranch`, que
// é chamada de novo tal e qual — só que agora depois de dar ao sistema
// operacional o tempo que ele precisa para enterrar o filho. Fora dessa janela
// o veredito é o mesmo de sempre (falso → o bloqueio operacional, o intent e as
// branches preservados), porque insistir para sempre esconderia um processo
// vivo de verdade segurando a pasta.
//
// O módulo é PURO por dentro (tentativa e espera são injetadas) para que o
// comportamento — insistiu, parou, quantas vezes, quanto esperou — seja
// provável em teste sem git, sem processo e sem relógio real.

/** Pausas (ms) entre as tentativas; a primeira é imediata. ~2,4s no pior caso,
 *  sempre FORA do main thread (quem chama já está no caminho do gitWorker). */
export const DEFAULT_RELEASE_PAUSES: readonly number[] = [0, 150, 350, 700, 1200]

export interface WorktreeReleaseOutcome {
  /** `true` quando alguma tentativa provou a remoção. */
  released: boolean
  /** Quantas tentativas foram gastas (>= 1). */
  attempts: number
  /** Soma das esperas efetivamente cumpridas — o que o recibo audita. */
  waitedMs: number
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Repete `attempt` até ela provar a liberação ou a janela acabar.
 *
 * `attempt` é a remoção REAL (`removeWorktreeAndBranch` pelo gitWorker): ela já
 * é conservadora — recusa por sujeira, por SHA divergente ou por pasta presa —,
 * então repeti-la é seguro por construção: uma recusa por mérito continua
 * recusando em todas as tentativas, e só a recusa TRANSITÓRIA (a pasta ainda
 * presa pelo filho que está morrendo) muda de resposta com o tempo.
 *
 * Uma tentativa que EXPLODE não é resposta: o erro sobe imediatamente, sem
 * consumir a janela — problema de git não é problema de tempo.
 */
export async function retryWorktreeRelease(
  attempt: () => Promise<boolean>,
  options: {
    pauses?: readonly number[]
    sleep?: (ms: number) => Promise<void>
  } = {}
): Promise<WorktreeReleaseOutcome> {
  const pauses = options.pauses ?? DEFAULT_RELEASE_PAUSES
  const sleep = options.sleep ?? realSleep
  let waitedMs = 0
  let attempts = 0
  for (const pause of pauses) {
    if (pause > 0) {
      await sleep(pause)
      waitedMs += pause
    }
    attempts += 1
    if (await attempt()) return { released: true, attempts, waitedMs }
  }
  return { released: false, attempts, waitedMs }
}
