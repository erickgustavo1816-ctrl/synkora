import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { gitHead, gitRaw, isExpectedWorktree, isWorktreeClean, neutralizeReparsePoints } from './worktree'

const MAX_ENTRIES = 200_000
const MAX_CONTENT_BYTES = 256 * 1024 * 1024
const MAX_GIT_OUTPUT = 16 * 1024 * 1024
const FULL_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right)
}

function physicalEntry(path: string): Stats | undefined {
  const absolute = resolve(path)
  const root = parse(absolute).root
  if (root.startsWith('\\\\')) throw new Error('Unsupported filesystem root')
  let cursor = root
  const parts = relative(root, absolute).split(sep).filter(Boolean)
  for (let index = 0; index <= parts.length; index++) {
    let stat: Stats
    try { stat = lstatSync(cursor) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (stat.isSymbolicLink() || !samePath(realpathSync(cursor), cursor) ||
      (index < parts.length && !stat.isDirectory())) throw new Error('Linked or unsupported path')
    if (index === parts.length) return stat
    cursor = join(cursor, parts[index]!)
  }
  return undefined
}

function proveIdentity(projectPath: string, dir: string, branch: string): string {
  if (!isAbsolute(projectPath) || !isAbsolute(dir) || samePath(projectPath, dir) ||
    Object.keys(process.env).some(key => /^GIT_/iu.test(key) &&
      !['GIT_PAGER', 'GIT_TERMINAL_PROMPT'].includes(key.toUpperCase())) ||
    !physicalEntry(projectPath)?.isDirectory() || !physicalEntry(dir)?.isDirectory()) {
    throw new Error('Unproven isolated directory')
  }
  const marker = physicalEntry(join(dir, '.git'))
  if (!marker?.isFile() || marker.nlink !== 1 || marker.size > 4096 ||
    !isExpectedWorktree(projectPath, dir, branch)) throw new Error('Unproven worktree')
  gitRaw(projectPath, ['check-ref-format', `refs/heads/${branch}`])
  if (!samePath(gitRaw(projectPath, ['rev-parse', '--show-toplevel']).trim(), projectPath)) {
    throw new Error('Project directory is not its root')
  }
  const head = gitHead(dir)
  if (!head || !FULL_SHA.test(head)) throw new Error('Unproven HEAD')
  const listing = gitRaw(projectPath, ['worktree', 'list', '--porcelain', '-z'], MAX_GIT_OUTPUT)
  const records = listing.split('\0\0').filter(Boolean).map(record => record.split('\0'))
  const matching = records.filter(record => record[0]?.startsWith('worktree ') &&
    samePath(record[0].slice(9), dir))
  if (matching.length !== 1 || records[0] === matching[0] ||
    !matching[0]!.includes(`branch refs/heads/${branch}`) || !matching[0]!.includes(`HEAD ${head}`) ||
    matching[0]!.some(field => /^(?:bare|detached|prunable)(?: |$)/u.test(field))) {
    throw new Error('Exact linked registration is missing')
  }
  const common = resolve(projectPath, gitRaw(projectPath, ['rev-parse', '--git-common-dir']).trim())
  const admin = gitRaw(dir, ['rev-parse', '--absolute-git-dir']).trim()
  if (!physicalEntry(common)?.isDirectory() || !physicalEntry(admin)?.isDirectory() ||
    !samePath(dirname(admin), join(common, 'worktrees'))) throw new Error('Unproven Git registry')
  for (const name of ['index.lock', 'HEAD.lock', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD',
    'rebase-merge', 'rebase-apply', 'sequencer']) {
    if (physicalEntry(join(admin, name))) throw new Error('Git operation in progress')
  }
  return head
}

function worktreeLinks(dir: string): string[] {
  const links: string[] = []
  const pending = [dir]
  let count = 0
  while (pending.length) {
    const current = pending.pop()!
    if (!physicalEntry(current)?.isDirectory()) throw new Error('Directory disappeared')
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (++count > MAX_ENTRIES) throw new Error('Worktree exceeds inspection budget')
      const full = join(current, entry.name)
      if (entry.name.toLowerCase() === '.git') {
        if (!samePath(current, dir)) throw new Error('Nested repository is unsupported')
        const marker = lstatSync(full)
        if (!marker.isFile() || marker.isSymbolicLink()) throw new Error('Git marker changed')
        continue
      }
      const stat = lstatSync(full)
      if (stat.isSymbolicLink()) links.push(relative(dir, full).split(sep).join('/'))
      else if (stat.isDirectory()) pending.push(full)
      else if (!stat.isFile()) throw new Error('Unsupported filesystem entry')
    }
  }
  return links
}

function gitPaths(output: string, staged: boolean): string[] {
  return output.split('\0').filter(Boolean).map(entry => {
    const match = (staged
      ? /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/su
      : /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/su).exec(entry)
    if (!match) throw new Error('Unsupported index or tree entry')
    return match[3]!
  })
}

function validateRelativePath(path: string): void {
  if (!path || isAbsolute(path) || /[\\\0\ufffd]/u.test(path) ||
    path.split('/').some(part => !part || part === '.' || part === '..' ||
      part.toLowerCase() === '.git' || (process.platform === 'win32' &&
        (/[<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part))))) {
    throw new Error('Unsupported Git path')
  }
}

function hashContent(path: string, hash: ReturnType<typeof createHash>, remaining: number): number {
  const stat = physicalEntry(path)
  if (!stat) { hash.update('missing\0'); return 0 }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > remaining) throw new Error('Unsupported file')
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(file)
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile() || opened.nlink !== 1) {
      throw new Error('File identity changed')
    }
    hash.update(`file\0${stat.mode}\0${stat.size}\0`)
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let total = 0
    for (;;) {
      const length = readSync(file, buffer, 0, buffer.length, null)
      if (!length) break
      total += length
      if (total > remaining) throw new Error('Content exceeds inspection budget')
      hash.update(buffer.subarray(0, length))
    }
    const after = fstatSync(file)
    const present = physicalEntry(path)
    if (!present || total !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs || present.dev !== stat.dev || present.ino !== stat.ino ||
      present.size !== stat.size || present.mtimeMs !== stat.mtimeMs || present.ctimeMs !== stat.ctimeMs) {
      throw new Error('Content changed while reading')
    }
    hash.update('\0')
    return total
  } finally { closeSync(file) }
}

function capture(projectPath: string, dir: string, branch: string): { snapshot: string; trackedSnapshot: string; head: string } {
  const head = proveIdentity(projectPath, dir, branch)
  const links = worktreeLinks(dir)
  const index = gitRaw(dir, ['ls-files', '--stage', '-z'], MAX_GIT_OUTPUT)
  const tree = gitRaw(dir, ['ls-tree', '-r', '--full-tree', '-z', head], MAX_GIT_OUTPUT)
  const tracked = [...new Set([...gitPaths(index, true), ...gitPaths(tree, false)])]
  tracked.forEach(validateRelativePath)
  const flags = gitRaw(dir, ['ls-files', '-v', '-z'], MAX_GIT_OUTPUT)
  if (flags.split('\0').filter(Boolean).some(entry => !entry.startsWith('H '))) {
    throw new Error('Sparse or hidden tracked changes are unsupported')
  }
  for (const link of links) {
    if (tracked.some(path => path === link || path.startsWith(`${link}/`))) {
      throw new Error('Tracked path traverses a link')
    }
    gitRaw(dir, ['check-ignore', '--no-index', '--quiet', '--', link])
  }
  const untracked = gitRaw(dir, ['ls-files', '--others', '--exclude-standard', '-z'], MAX_GIT_OUTPUT)
  const untrackedPaths = untracked.split('\0').filter(Boolean)
  untrackedPaths.forEach(validateRelativePath)
  const status = gitRaw(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], MAX_GIT_OUTPUT)
  const hash = createHash('sha256')
  hash.update(JSON.stringify([resolve(projectPath), resolve(dir), branch, head, index, tree, flags]))
  let remaining = MAX_CONTENT_BYTES
  for (const path of tracked.sort()) {
    hash.update(`\0${path}\0`)
    remaining -= hashContent(join(dir, path), hash, remaining)
  }
  const trackedSnapshot = hash.copy().digest('hex')
  hash.update(JSON.stringify([status, untracked]))
  for (const path of untrackedPaths.sort()) {
    if (!physicalEntry(join(dir, path))?.isFile()) throw new Error('Untracked content disappeared')
    hash.update(`\0${path}\0`)
    remaining -= hashContent(join(dir, path), hash, remaining)
  }
  if (proveIdentity(projectPath, dir, branch) !== head ||
    gitRaw(dir, ['ls-files', '--stage', '-z'], MAX_GIT_OUTPUT) !== index ||
    gitRaw(dir, ['ls-files', '--others', '--exclude-standard', '-z'], MAX_GIT_OUTPUT) !== untracked ||
    gitRaw(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], MAX_GIT_OUTPUT) !== status) {
    throw new Error('Snapshot changed during inspection')
  }
  return { snapshot: hash.digest('hex'), trackedSnapshot, head }
}

export function missionWorktreeSnapshot(projectPath: string, dir: string, branch: string): string | undefined {
  try { return capture(projectPath, dir, branch).snapshot }
  catch { return undefined }
}

export function discardMissionWorktreeChanges(
  projectPath: string, dir: string, branch: string, expectedSnapshot: string
): boolean {
  try {
    if (!/^[a-f0-9]{64}$/u.test(expectedSnapshot)) return false
    const approved = capture(projectPath, dir, branch)
    if (approved.snapshot !== expectedSnapshot) return false
    const clean = isWorktreeClean(dir)
    if (clean === undefined) return false
    if (clean) return capture(projectPath, dir, branch).snapshot === expectedSnapshot && isWorktreeClean(dir) === true
    neutralizeReparsePoints(dir)
    if (worktreeLinks(dir).length || capture(projectPath, dir, branch).snapshot !== expectedSnapshot) return false
    gitRaw(dir, ['clean', '-fd', '--'])
    const beforeRestore = capture(projectPath, dir, branch)
    if (beforeRestore.head !== approved.head || beforeRestore.trackedSnapshot !== approved.trackedSnapshot ||
      worktreeLinks(dir).length) return false
    gitRaw(dir, ['restore', '--source', approved.head, '--staged', '--worktree', '--no-recurse-submodules', '--', '.'])
    return proveIdentity(projectPath, dir, branch) === approved.head &&
      worktreeLinks(dir).length === 0 && isWorktreeClean(dir) === true
  } catch { return false }
}
