import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  /** Fluxo do Maestro: projeto vazio nasce greenfield e conserva esse modo
   *  mesmo depois que as primeiras missões criarem arquivos. */
  mode?: 'greenfield' | 'existing'
  /** avatar do projeto (data URL PNG 128px) — rail estilo Discord */
  photo?: string
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

  create(name: string, path: string, mode?: Project['mode']): Project {
    const project: Project = {
      id: randomUUID(),
      name,
      path,
      createdAt: new Date().toISOString(),
      mode
    }
    this.projects.push(project)
    this.persist()
    return project
  }

  rename(id: string, name: string): Project | undefined {
    const project = this.projects.find((p) => p.id === id)
    if (!project) return undefined
    project.name = name
    this.persist()
    return project
  }

  /** Relocação: a pasta foi movida/renomeada fora do app — só o caminho muda,
   *  o id (e todo estado chaveado por ele) permanece. */
  setPath(id: string, path: string): Project | undefined {
    const project = this.projects.find((p) => p.id === id)
    if (!project) return undefined
    project.path = path
    this.persist()
    return project
  }

  setMode(id: string, mode: NonNullable<Project['mode']>): Project | undefined {
    const project = this.projects.find((p) => p.id === id)
    if (!project) return undefined
    project.mode = mode
    this.persist()
    return project
  }

  setPhoto(id: string, dataUrl: string | null): Project | undefined {
    const project = this.projects.find((p) => p.id === id)
    if (!project) return undefined
    if (dataUrl) project.photo = dataUrl
    else delete project.photo
    this.persist()
    return project
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
  }
}
