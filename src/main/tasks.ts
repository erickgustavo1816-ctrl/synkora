import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export type Department = 'front' | 'back' | 'qa' | 'design' | 'research'
export type TaskStatus = 'backlog' | 'analise' | 'execucao' | 'qa' | 'done'
export type TaskType = 'feature' | 'bug'
export type TaskEffort = 'leve' | 'pesada'

export interface Task {
  id: string
  projectId: string
  department: Department
  type: TaskType
  effort: TaskEffort
  title: string
  description: string
  status: TaskStatus
  origin: 'maestro' | 'manual'
  createdAt: string
  updatedAt: string
  /** metadados da execução — o card mostra tudo, sem adivinhação */
  runSeat?: string
  runModel?: string
  /** ciclos de retry automático dev↔gate já gastos */
  cycles?: number
  /** último feedback de reprovação (revisor/QA) */
  feedback?: string
}

export interface NewTask {
  department: Department
  type: TaskType
  effort: TaskEffort
  title: string
  description: string
  origin: 'maestro' | 'manual'
}

export class TaskStore {
  private file = join(app.getPath('userData'), 'tasks.json')
  private tasks: Task[] = []

  constructor() {
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as Task[]
        // Migração leve: tarefas antigas não tinham `type`/`effort`.
        this.tasks = raw.map((t) => ({
          ...t,
          type: t.type ?? 'feature',
          effort: t.effort ?? 'leve'
        }))
      } catch {
        this.tasks = []
      }
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.tasks, null, 2), 'utf-8')
  }

  list(projectId: string): Task[] {
    return this.tasks.filter((t) => t.projectId === projectId)
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id)
  }

  createMany(projectId: string, items: NewTask[]): Task[] {
    const now = new Date().toISOString()
    const created = items.map(
      (item): Task => ({
        id: randomUUID(),
        projectId,
        department: item.department,
        type: item.type,
        effort: item.effort,
        title: item.title,
        description: item.description,
        status: 'backlog',
        origin: item.origin,
        createdAt: now,
        updatedAt: now
      })
    )
    this.tasks.push(...created)
    this.persist()
    return created
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | 'title'
        | 'description'
        | 'status'
        | 'department'
        | 'type'
        | 'effort'
        | 'runSeat'
        | 'runModel'
        | 'cycles'
        | 'feedback'
      >
    >
  ): Task | undefined {
    const task = this.tasks.find((t) => t.id === id)
    if (!task) return undefined
    Object.assign(task, patch, { updatedAt: new Date().toISOString() })
    this.persist()
    return task
  }

  remove(id: string): void {
    this.tasks = this.tasks.filter((t) => t.id !== id)
    this.persist()
  }
}
