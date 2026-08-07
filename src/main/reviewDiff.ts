import { execFileSync } from 'node:child_process'

const SHA = /^[0-9a-f]{40,64}$/i

function gitRead(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    maxBuffer,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** Lockfiles GERADOS por ferramenta: nenhum reviewer lê milhares de linhas de
 *  máquina — ficam fora do PATCH e do orçamento de tamanho, mas LISTADOS no
 *  resumo (existência + volume) para o gate saber que mudaram. Caso real
 *  2026-08-04: package-lock.json (7.684 linhas, 83% do diff) estourava o
 *  limite da fundação greenfield e devolvia o card ao dev com um conselho
 *  impossível — nenhuma divisão de card remove o lockfile. */
const GENERATED_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum'
]

/**
 * Materializa o diff imutável no próprio prompt do Reviewer. Assim o gate
 * Claude não precisa receber Bash só para enxergar a entrega. Nenhum hook,
 * textconv ou diff externo do repositório é executado.
 */
export function immutableReviewDiff(
  cwd: string,
  baseSha: string,
  snapshotSha: string,
  maxChars = 120_000
): { text: string; truncated: boolean; mode: 'inline' | 'local' } | undefined {
  if (!SHA.test(baseSha) || !SHA.test(snapshotSha) || maxChars < 2_000) return undefined
  try {
    const excludes = GENERATED_LOCKFILES.flatMap((name) => [
      `:(exclude)${name}`,
      `:(exclude,glob)**/${name}`
    ])
    const common = [
      '--no-pager',
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      baseSha,
      snapshotSha,
      '--',
      '.',
      ...excludes
    ]
    const stat = gitRead(cwd, [...common.slice(0, 2), '--stat', ...common.slice(2)]).trim()
    const patch = gitRead(cwd, common).trim()
    let generated = ''
    try {
      const lockPathspecs = GENERATED_LOCKFILES.flatMap((name) => [name, `:(glob)**/${name}`])
      const numstat = gitRead(cwd, [
        '--no-pager',
        'diff',
        '--no-ext-diff',
        '--numstat',
        baseSha,
        snapshotSha,
        '--',
        ...lockPathspecs
      ]).trim()
      if (numstat) {
        generated =
          '\n\nARQUIVOS GERADOS (lockfiles — fora do patch e do limite; confira presença/coerência, não o conteúdo):\n' +
          numstat
            .split('\n')
            .map((line) => {
              const [added, deleted, file] = line.split('\t')
              return `- ${file} (+${added}/-${deleted})`
            })
            .join('\n')
      }
    } catch {
      // a lista de gerados é informativa; o diff principal segue válido sem ela
    }
    const complete = `RESUMO\n${stat || '(sem alterações)'}${generated}\n\nPATCH\n${patch || '(vazio)'}`
    if (complete.length <= maxChars) return { text: complete, truncated: false, mode: 'inline' }
    // Entrega LEGÍTIMA pode passar do teto inline (caso real 2026-08-04: o
    // design system da onda 2 chegou a ~120k de código real e o harness
    // devolvia o card com "divida a entrega" — conselho impossível para
    // trabalho já commitado). O range por SHA é imutável por definição: o
    // gate lê o patch LOCALMENTE com git de leitura, guiado pelo prompt do
    // harness; aqui dentro (conteúdo untrusted) fica só o resumo por arquivo.
    return {
      text:
        `RESUMO\n${stat || '(sem alterações)'}${generated}\n\n` +
        `PATCH: ${patch.length} caracteres — grande demais para vir inline; ` +
        `leia-o localmente conforme instruído FORA deste bloco.`,
      truncated: true,
      mode: 'local'
    }
  } catch {
    return undefined
  }
}
