import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
}

// Persistência em JSON no F0; migra para SQLite na F2 quando o modelo
// de domínio (departamentos, tarefas, runs) entrar.
export class ProjectStore {
  private file = join(app.getPath('userData'), 'projects.json')
  private projects: Project[] = []

  constructor() {
    if (existsSync(this.file)) {
      try {
        this.projects = JSON.parse(readFileSync(this.file, 'utf-8'))
      } catch {
        this.projects = []
      }
    }
  }

  private persist(): void {
    writeFileSync(this.file, JSON.stringify(this.projects, null, 2), 'utf-8')
  }

  list(): Project[] {
    return this.projects
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  create(name: string, path: string): Project {
    const project: Project = {
      id: randomUUID(),
      name,
      path,
      createdAt: new Date().toISOString()
    }
    this.projects.push(project)
    this.persist()
    return project
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
  }
}
