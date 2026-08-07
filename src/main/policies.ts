import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Department } from './tasks'

export interface PolicySlot {
  seatId: string
  model: string
}

export interface DeptPolicy {
  heavy?: PolicySlot
  light?: PolicySlot
  /** skills instaladas na função (F4 injeta no prompt do executor) */
  skills?: string[]
  /** subagentes especializados da função (F4) */
  agents?: string[]
}

export type ProjectPolicies = Partial<Record<Department, DeptPolicy>>

// Política de execução por departamento: qual seat + modelo atende tarefas
// pesadas e leves. O usuário define a política; o Maestro classifica o peso;
// o harness (F3) aplica sem perguntar.
export class PolicyStore {
  private file = join(app.getPath('userData'), 'policies.json')
  private data: Record<string, ProjectPolicies> = {}

  constructor() {
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, 'utf-8'))
      } catch {
        this.data = {}
      }
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  get(projectId: string): ProjectPolicies {
    return this.data[projectId] ?? {}
  }

  set(projectId: string, dept: Department, policy: DeptPolicy): void {
    this.data[projectId] = { ...this.get(projectId), [dept]: policy }
    this.persist()
  }
}
