export const GUI_DIFF_MAX_CHARS = 256 * 1024
export const GUI_DIFF_MAX_LINES = 2_000
export const GUI_DIFF_MAX_FILES = 50
const GUI_TOOL_INPUT_TRUNCATED = '__synkora_input_truncated'

export type GuiFileDiffOperation =
  | 'edit'
  | 'write'
  | 'patch'
  | 'add'
  | 'update'
  | 'delete'
  | 'move'

export type GuiFileDiffSource =
  | {
      format: 'before-after'
      operation: 'edit' | 'write' | 'patch'
      path: string
      oldText: string | null
      newText: string
      truncated: boolean
    }
  | {
      format: 'unified'
      operation: 'patch' | 'add' | 'update' | 'delete' | 'move'
      path: string
      patch: string
      movePath?: string
      truncated: boolean
    }

export interface GuiDiffLine {
  kind: 'context' | 'add' | 'remove' | 'meta'
  text: string
  oldNumber: number | null
  newNumber: number | null
}

export interface GuiRenderedFileDiff {
  source: GuiFileDiffSource
  lines: GuiDiffLine[]
  additions: number
  removals: number
  simplified: boolean
}

interface DiffBudget {
  chars: number
  lines: number
}

interface LimitedText {
  text: string
  truncated: boolean
}

const PATH_CAP = 420
const SOURCE_CHAR_CAP = 96 * 1024
const SOURCE_LINE_CAP = 800
const LCS_CELL_BUDGET = 40_000

function cleanPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const path = value.trim()
  if (!path) return undefined
  return path.length <= PATH_CAP ? path : `${path.slice(0, PATH_CAP - 1)}…`
}

/** Resumo barato do payload `changes`: nunca serializa patches gigantes. */
export function guiToolDiffInputSummary(
  input: Record<string, unknown>
): string | undefined {
  const changes = input['changes']
  if (Array.isArray(changes)) {
    const paths = changes.slice(0, 3).flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const path = cleanPath((value as Record<string, unknown>)['path'])
      return path ? [path] : []
    })
    if (!paths.length)
      return `${changes.length} ${changes.length === 1 ? 'alteração' : 'alterações'}`
    const remaining = Math.max(0, changes.length - paths.length)
    return `${paths.join(', ')}${remaining ? `, +${remaining}` : ''}`
  }
  const patch = textField(input['patch'])
  if (patch !== undefined) {
    const prefix = patch.slice(0, 4_096)
    const header = /(?:\*\*\* (?:Update|Add|Delete) File:|\+\+\+\s+(?:b\/)?)([^\r\n]+)/u.exec(
      prefix
    )
    return cleanPath(header?.[1]) ?? 'patch'
  }
  if (
    textField(input['content']) !== undefined ||
    textField(input['old_string']) !== undefined ||
    textField(input['new_string']) !== undefined
  )
    return 'conteúdo de arquivo'
  return undefined
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function lineCount(text: string): number {
  return text ? text.split('\n').length : 0
}

/** Limita ANTES de o payload entrar no store; nenhum input cru é preservado. */
function takeText(
  raw: string,
  budget: DiffBudget,
  charCap = SOURCE_CHAR_CAP,
  lineCap = SOURCE_LINE_CAP
): LimitedText {
  if (budget.chars <= 0 || budget.lines <= 0) return { text: '', truncated: raw.length > 0 }
  const maxChars = Math.max(0, Math.min(charCap, budget.chars))
  const maxLines = Math.max(0, Math.min(lineCap, budget.lines))
  // O slice inicial impede que normalizar/splitar replique um Write gigantesco.
  const sliced = raw.slice(0, maxChars + 2)
  const normalized = sliced.replace(/\r\n?/gu, '\n')
  const pieces = normalized.split('\n')
  const selected = pieces.slice(0, maxLines)
  let text = selected.join('\n')
  let truncated = raw.length > sliced.length || pieces.length > selected.length
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    truncated = true
  }
  budget.chars -= text.length
  budget.lines -= lineCount(text)
  return { text, truncated }
}

function operationFromKind(
  value: unknown
): Exclude<GuiFileDiffOperation, 'edit' | 'write'> {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object'
        ? String(
            (value as Record<string, unknown>)['type'] ??
              (value as Record<string, unknown>)['kind'] ??
              ''
          )
        : ''
  const kind = raw.trim().toLowerCase()
  if (kind.includes('add') || kind.includes('create')) return 'add'
  if (kind.includes('delete') || kind.includes('remove')) return 'delete'
  if (kind.includes('move') || kind.includes('rename')) return 'move'
  return 'update'
}

function movePathFrom(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return cleanPath(record['movePath'] ?? record['move_path'] ?? record['destination'])
}

interface PatchSection {
  path: string
  operation: 'patch' | 'add' | 'update' | 'delete' | 'move'
  movePath?: string
  lines: string[]
}

function specialPatchSections(lines: string[]): PatchSection[] {
  const sections: PatchSection[] = []
  let current: PatchSection | null = null
  const flush = (): void => {
    if (current) sections.push(current)
    current = null
  }
  for (const line of lines) {
    const header = /^\*\*\* (Update|Add|Delete) File:\s*(.+)$/u.exec(line)
    if (header) {
      flush()
      const path = cleanPath(header[2])
      if (!path) continue
      const operation =
        header[1] === 'Add' ? 'add' : header[1] === 'Delete' ? 'delete' : 'update'
      current = { path, operation, lines: [] }
      continue
    }
    const move = /^\*\*\* Move to:\s*(.+)$/u.exec(line)
    if (move && current) {
      current.operation = 'move'
      current.movePath = cleanPath(move[1])
      continue
    }
    if (/^\*\*\* (?:Begin|End) Patch\s*$/u.test(line)) continue
    if (current) current.lines.push(line)
  }
  flush()
  return sections
}

function unifiedPatchSections(lines: string[]): PatchSection[] {
  const sections: PatchSection[] = []
  let current: PatchSection | null = null
  const flush = (): void => {
    if (current) sections.push(current)
    current = null
  }
  for (const line of lines) {
    const header = /^diff --git\s+(?:"?a\/)?(.+?)"?\s+(?:"?b\/)?(.+?)"?$/u.exec(line)
    if (header) {
      flush()
      const path = cleanPath(header[2] || header[1])
      if (path) current = { path, operation: 'update', lines: [line] }
      continue
    }
    if (!current) continue
    current.lines.push(line)
    if (line === '--- /dev/null') current.operation = 'add'
    if (line === '+++ /dev/null') current.operation = 'delete'
    const target = /^\+\+\+\s+(?:b\/)?(.+)$/u.exec(line)
    if (target && target[1] !== '/dev/null') current.path = cleanPath(target[1]) ?? current.path
    const rename = /^rename to\s+(.+)$/u.exec(line)
    if (rename) {
      current.operation = 'move'
      current.movePath = cleanPath(rename[1])
    }
  }
  flush()
  return sections
}

function patchSources(
  raw: string,
  fallbackPath: string | undefined,
  budget: DiffBudget
): GuiFileDiffSource[] {
  const limited = takeText(raw, budget, GUI_DIFF_MAX_CHARS, GUI_DIFF_MAX_LINES)
  const lines = limited.text.split('\n')
  const parsed = specialPatchSections(lines)
  const sections = parsed.length ? parsed : unifiedPatchSections(lines)
  if (!sections.length) {
    if (!fallbackPath || !limited.text) return []
    return [
      {
        format: 'unified',
        operation: 'patch',
        path: fallbackPath,
        patch: limited.text,
        truncated: limited.truncated
      }
    ]
  }
  const visible = sections.slice(0, GUI_DIFF_MAX_FILES)
  return visible.map((section, index) => ({
    format: 'unified',
    operation: section.operation,
    path: section.path,
    patch: section.lines.join('\n'),
    ...(section.movePath ? { movePath: section.movePath } : {}),
    truncated:
      index === visible.length - 1 && (limited.truncated || sections.length > visible.length)
  }))
}

function normalizeCodexChanges(
  changes: unknown[],
  budget: DiffBudget
): GuiFileDiffSource[] {
  const sources: GuiFileDiffSource[] = []
  for (const value of changes.slice(0, GUI_DIFF_MAX_FILES)) {
    if (!value || typeof value !== 'object') continue
    const change = value as Record<string, unknown>
    const path = cleanPath(change['path'] ?? change['file_path'])
    const diff = textField(change['diff'] ?? change['patch'])
    if (!path || diff === undefined) continue
    const limited = takeText(diff, budget)
    const movePath = movePathFrom(change['kind']) ?? cleanPath(change['move_path'])
    sources.push({
      format: 'unified',
      operation: operationFromKind(change['kind']),
      path,
      patch: limited.text,
      ...(movePath ? { movePath } : {}),
      truncated:
        limited.truncated ||
        (sources.length === GUI_DIFF_MAX_FILES - 1 && changes.length > GUI_DIFF_MAX_FILES)
    })
    if (budget.chars <= 0 || budget.lines <= 0) break
  }
  return sources
}

/** Normalização fechada: só quatro tools conhecidas, sem leitura de arquivo. */
export function normalizeGuiToolDiff(
  name: string,
  input: Record<string, unknown> | undefined
): GuiFileDiffSource[] | undefined {
  if (!input) return undefined
  const tool = name.trim().toLowerCase()
  if (!['edit', 'write', 'applypatch', 'apply_patch', 'patch'].includes(tool)) return undefined
  const budget: DiffBudget = { chars: GUI_DIFF_MAX_CHARS, lines: GUI_DIFF_MAX_LINES }
  const path = cleanPath(input['file_path'] ?? input['path'])
  const finish = (sources: GuiFileDiffSource[]): GuiFileDiffSource[] | undefined => {
    if (!sources.length) return undefined
    if (input[GUI_TOOL_INPUT_TRUNCATED] !== true) return sources
    return sources.map((source, index) =>
      index === sources.length - 1 ? { ...source, truncated: true } : source
    )
  }

  if (tool === 'patch' && Array.isArray(input['changes'])) {
    return finish(normalizeCodexChanges(input['changes'], budget))
  }

  if (tool === 'write') {
    const content = textField(input['content'])
    if (!path || content === undefined) return undefined
    const next = takeText(content, budget, GUI_DIFF_MAX_CHARS, GUI_DIFF_MAX_LINES)
    return finish([
      {
        format: 'before-after',
        operation: 'write',
        path,
        oldText: null,
        newText: next.text,
        truncated: next.truncated
      }
    ])
  }

  const oldText = textField(input['old_string'])
  const newText = textField(input['new_string'])
  if (path && oldText !== undefined && newText !== undefined) {
    const before = takeText(
      oldText,
      budget,
      Math.floor(GUI_DIFF_MAX_CHARS / 2),
      Math.floor(GUI_DIFF_MAX_LINES / 2)
    )
    const after = takeText(newText, budget, GUI_DIFF_MAX_CHARS, GUI_DIFF_MAX_LINES)
    return finish([
      {
        format: 'before-after',
        operation: tool === 'edit' ? 'edit' : 'patch',
        path,
        oldText: before.text,
        newText: after.text,
        truncated: before.truncated || after.truncated
      }
    ])
  }

  const rawPatch = textField(input['patch'])
  if (rawPatch !== undefined) {
    return finish(patchSources(rawPatch, path, budget))
  }
  return undefined
}

type DiffOp = { kind: 'context' | 'add' | 'remove'; text: string }

function splitTextLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n?/gu, '\n').split('\n')
}

/** LCS deliberadamente ORÇADO; acima do teto cai num script linear honesto. */
function diffLineOps(oldLines: string[], newLines: string[]): {
  operations: DiffOp[]
  simplified: boolean
} {
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix += 1

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix += 1

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  const head: DiffOp[] = oldLines
    .slice(0, prefix)
    .map((text) => ({ kind: 'context', text }))
  const tail: DiffOp[] = suffix
    ? oldLines.slice(oldLines.length - suffix).map((text) => ({ kind: 'context', text }))
    : []

  if (oldMiddle.length * newMiddle.length > LCS_CELL_BUDGET) {
    return {
      operations: [
        ...head,
        ...oldMiddle.map((text): DiffOp => ({ kind: 'remove', text })),
        ...newMiddle.map((text): DiffOp => ({ kind: 'add', text })),
        ...tail
      ],
      simplified: true
    }
  }

  const width = newMiddle.length + 1
  const table = new Uint16Array((oldMiddle.length + 1) * width)
  for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
      const at = oldIndex * width + newIndex
      table[at] =
        oldMiddle[oldIndex] === newMiddle[newIndex]
          ? table[(oldIndex + 1) * width + newIndex + 1] + 1
          : Math.max(table[(oldIndex + 1) * width + newIndex], table[at + 1])
    }
  }

  const middle: DiffOp[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
    if (
      oldIndex < oldMiddle.length &&
      newIndex < newMiddle.length &&
      oldMiddle[oldIndex] === newMiddle[newIndex]
    ) {
      middle.push({ kind: 'context', text: oldMiddle[oldIndex] })
      oldIndex += 1
      newIndex += 1
    } else if (
      newIndex < newMiddle.length &&
      (oldIndex >= oldMiddle.length ||
        table[oldIndex * width + newIndex + 1] >=
          table[(oldIndex + 1) * width + newIndex])
    ) {
      middle.push({ kind: 'add', text: newMiddle[newIndex] })
      newIndex += 1
    } else {
      middle.push({ kind: 'remove', text: oldMiddle[oldIndex] })
      oldIndex += 1
    }
  }
  return { operations: [...head, ...middle, ...tail], simplified: false }
}

function numberedOperations(operations: DiffOp[]): GuiDiffLine[] {
  let oldNumber = 1
  let newNumber = 1
  return operations.map((operation) => {
    const line: GuiDiffLine = {
      kind: operation.kind,
      text: operation.text,
      oldNumber: operation.kind === 'add' ? null : oldNumber,
      newNumber: operation.kind === 'remove' ? null : newNumber
    }
    if (operation.kind !== 'add') oldNumber += 1
    if (operation.kind !== 'remove') newNumber += 1
    return line
  })
}

function unifiedLines(patch: string): GuiDiffLine[] {
  let oldNumber = 1
  let newNumber = 1
  return splitTextLines(patch).map((raw) => {
    const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(raw)
    if (hunk) {
      oldNumber = Number(hunk[1])
      newNumber = Number(hunk[2])
      return { kind: 'meta', text: raw, oldNumber: null, newNumber: null }
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff --git')) {
      return { kind: 'meta', text: raw, oldNumber: null, newNumber: null }
    }
    if (raw.startsWith('+')) {
      const line = { kind: 'add' as const, text: raw.slice(1), oldNumber: null, newNumber }
      newNumber += 1
      return line
    }
    if (raw.startsWith('-')) {
      const line = { kind: 'remove' as const, text: raw.slice(1), oldNumber, newNumber: null }
      oldNumber += 1
      return line
    }
    if (raw.startsWith(' ')) {
      const line = { kind: 'context' as const, text: raw.slice(1), oldNumber, newNumber }
      oldNumber += 1
      newNumber += 1
      return line
    }
    return { kind: 'meta', text: raw, oldNumber: null, newNumber: null }
  })
}

export function renderGuiFileDiff(source: GuiFileDiffSource): GuiRenderedFileDiff {
  let lines: GuiDiffLine[]
  let simplified = false
  if (source.format === 'unified') {
    lines = unifiedLines(source.patch)
  } else if (source.oldText === null) {
    lines = splitTextLines(source.newText).map((text, index) => ({
      kind: 'add',
      text,
      oldNumber: null,
      newNumber: index + 1
    }))
  } else {
    const diff = diffLineOps(splitTextLines(source.oldText), splitTextLines(source.newText))
    lines = numberedOperations(diff.operations)
    simplified = diff.simplified
  }
  return {
    source,
    lines,
    additions: lines.filter((line) => line.kind === 'add').length,
    removals: lines.filter((line) => line.kind === 'remove').length,
    simplified
  }
}

export function guiDiffBasename(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}
