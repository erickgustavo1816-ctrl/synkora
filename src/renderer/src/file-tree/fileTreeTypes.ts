import type { FileActionTreeEntry } from '../../../preload/index'

export type FileTreeAction =
  | 'create-file'
  | 'create-folder'
  | 'rename'
  | 'trash'
  | 'copy-path'
  | 'download-zip'

export interface FileTreeNode extends FileActionTreeEntry {
  /** Entrada sintética; serve somente para criar filhos na raiz. */
  root?: true
}

export interface FileTreeChange {
  action: FileTreeAction
  path?: string
  previousPath?: string
}

export function actionsForFileTreeNode(node: FileTreeNode): FileTreeAction[] {
  if (node.kind === 'blocked') return []
  if (node.root) return ['create-file', 'create-folder']
  if (node.kind === 'directory') {
    return [
      'create-file',
      'create-folder',
      'rename',
      'trash',
      'copy-path',
      'download-zip'
    ]
  }
  return ['rename', 'trash', 'copy-path']
}
