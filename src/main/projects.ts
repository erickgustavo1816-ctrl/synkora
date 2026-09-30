import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { persistJsonStore } from './jsonStore'
import type { ProjectVersioning } from '../shared/projectVersioning'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: string
  /** LETRA MORTA desde a limpa F6 (2026-08-17): a classificação greenfield ×
   *  existente era do plano mestre. O campo fica DECLARADO e sem leitor para
   *  que o registro antigo continue carregando e regravando o valor. */
  mode?: 'greenfield' | 'existing'
  /** avatar do projeto (data URL PNG 128px) — rail estilo Discord */
  photo?: string
  /** Modalidade gravada no nascimento (definitiva). Ausente = 'git'. Leia
   *  SEMPRE por `projectVersioning()` de shared/projectVersioning. */
  versioning?: ProjectVersioning
}

/* REGISTRO LEGADO (limpa F6, 2026-08-17): `planningEvidence`,
 * `planningTrustVersion` e `legacyPlanningApproval` eram do plano mestre e
 * saíram do tipo. NADA foi apagado do disco: o loader faz `JSON.parse` cru,
 * sem validador nem allowlist, e `persist()` grava o objeto parseado — as
 * chaves órfãs sobrevivem intactas em projects.json. Por isso NÃO se
 * acrescenta validador/sanitizador a este store (R-12): ele apagaria a
 * evidência real do dono. */

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
    persistJsonStore(this.file, this.projects)
  }

  list(): Project[] {
    return this.projects
  }

  get(id: string): Project | undefined {
    return this.projects.find((p) => p.id === id)
  }

  create(name: string, path: string, versioning: ProjectVersioning = 'git'): Project {
    const project: Project = {
      id: randomUUID(),
      name,
      path,
      createdAt: new Date().toISOString(),
      // só a exceção é gravada: registro sem a chave continua sendo 'git'
      ...(versioning === 'none' ? { versioning } : {})
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
