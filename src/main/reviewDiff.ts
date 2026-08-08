import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

export interface ImmutableReviewDiffEvidence {
  text: string
  truncated: boolean
  mode: 'inline' | 'local'
  /** Arquivos do MESMO range base..snapshot, nunca do acumulado do card. */
  changedPaths: string[]
  /** Compatibilidade com evidências pequenas produzidas por versões antigas. */
  artifactText?: string
  /** Patch completo spoolado fora do repositório quando excede o teto inline. */
  artifactSourcePath?: string
  artifactSha256?: string
  artifactBytes?: number
}

function fileIdentity(path: string): { sha256: string; bytes: number } {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  const chunk = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.byteLength, null)
      if (read === 0) break
      hash.update(chunk.subarray(0, read))
    }
  } finally {
    closeSync(fd)
  }
  return { sha256: hash.digest('hex'), bytes: statSync(path).size }
}

function streamPatchArtifact(
  cwd: string,
  args: string[],
  prefix: string
): { path: string; sha256: string; bytes: number } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'synkora-review-diff-'))
  const path = join(dir, 'review.patch')
  let fd: number | undefined
  try {
    writeFileSync(path, prefix, 'utf8')
    fd = openSync(path, 'a')
    const result = spawnSync('git', args, {
      cwd,
      windowsHide: true,
      timeout: 120_000,
      stdio: ['ignore', fd, 'pipe'],
      encoding: 'utf8',
      // stdout vai direto ao arquivo; este teto cobre apenas stderr.
      maxBuffer: 1024 * 1024
    })
    closeSync(fd)
    fd = undefined
    if (result.error || result.status !== 0) throw result.error ?? new Error('git diff failed')
    return { path, ...fileIdentity(path) }
  } catch {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best effort
      }
    }
    rmSync(dir, { recursive: true, force: true })
    return undefined
  }
}

/** Confirma que ambos os commits existem e que base é ancestral do snapshot. */
export function immutableReviewRangeValid(
  cwd: string,
  baseSha: string,
  snapshotSha: string
): boolean {
  if (!SHA.test(baseSha) || !SHA.test(snapshotSha)) return false
  try {
    gitRead(cwd, ['cat-file', '-e', `${baseSha}^{commit}`], 1024 * 1024)
    gitRead(cwd, ['cat-file', '-e', `${snapshotSha}^{commit}`], 1024 * 1024)
    gitRead(cwd, ['merge-base', '--is-ancestor', baseSha, snapshotSha], 1024 * 1024)
    return true
  } catch {
    return false
  }
}

/** Lista de caminhos presa ao mesmo range SHA usado pelo gate. */
export function immutableReviewChangedPaths(
  cwd: string,
  baseSha: string,
  snapshotSha: string
): string[] | undefined {
  if (!SHA.test(baseSha) || !SHA.test(snapshotSha)) return undefined
  try {
    return gitRead(
      cwd,
      [
        '--no-pager',
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--name-only',
        '-z',
        baseSha,
        snapshotSha,
        '--',
        '.'
      ],
      64 * 1024 * 1024
    )
      .split('\0')
      .map((path) => path.trim())
      .filter(Boolean)
  } catch {
    return undefined
  }
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
 * Materializa o diff imutável no próprio prompt ou num spool temporário. O
 * gate Claude não precisa de Bash e nenhum hook, textconv ou diff externo do
 * repositório é executado. Patches grandes não atravessam um buffer fixo.
 */
export function immutableReviewDiff(
  cwd: string,
  baseSha: string,
  snapshotSha: string,
  maxChars = 120_000
): ImmutableReviewDiffEvidence | undefined {
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
    const changedPaths = immutableReviewChangedPaths(cwd, baseSha, snapshotSha)
    if (!changedPaths) return undefined
    const stat = gitRead(cwd, [...common.slice(0, 2), '--stat', ...common.slice(2)]).trim()
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
    const prefix = `RESUMO\n${stat || '(sem alterações)'}${generated}\n\nPATCH\n`
    let patch: string | undefined
    try {
      // O teto pequeno evita bufferizar um patch enorme só para descobrir que
      // ele deve seguir pelo artefato local.
      patch = gitRead(cwd, common, Math.max(2 * 1024 * 1024, maxChars * 4)).trim()
    } catch {
      patch = undefined
    }
    const complete = patch === undefined ? undefined : `${prefix}${patch || '(vazio)'}`
    if (complete !== undefined && complete.length <= maxChars) {
      return { text: complete, truncated: false, mode: 'inline', changedPaths }
    }

    const streamed = streamPatchArtifact(cwd, common, prefix)
    if (!streamed) return undefined
    const patchBytes = Math.max(0, streamed.bytes - Buffer.byteLength(prefix, 'utf8'))
    return {
      text:
        `RESUMO\n${stat || '(sem alterações)'}${generated}\n\n` +
        `PATCH: ${patchBytes} bytes — grande demais para vir inline; ` +
        `leia o artefato imutável fornecido pelo harness.`,
      truncated: true,
      mode: 'local',
      changedPaths,
      artifactSourcePath: streamed.path,
      artifactSha256: streamed.sha256,
      artifactBytes: streamed.bytes
    }
  } catch {
    return undefined
  }
}
