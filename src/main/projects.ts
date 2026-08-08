import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { persistJsonStore } from './jsonStore'
import {
  PROJECT_PLAN_TRUST_CONTRACT_VERSION,
  type ProjectPlanLegacyApproval,
  type ProjectPlanningSkillUse
} from './projectPlan'

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
  /** Carimbo control-plane da ultima revisao de roadmap produzida por um
   * receipt real. A copia em .synkora e apenas a representacao legivel. */
  planningEvidence?: ProjectPlanningSkillUse
  /** Migração one-shot do contrato de confiança. Ausente significa projeto
   * criado antes do contrato; projetos novos já nascem na versão atual. */
  planningTrustVersion?: typeof PROJECT_PLAN_TRUST_CONTRACT_VERSION
  /** Única exceção para planos aprovados antes de receipts. Fica no
   * control-plane (userData), nunca no JSON gravável do workspace. */
  legacyPlanningApproval?: ProjectPlanLegacyApproval
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
    persistJsonStore(this.file, this.projects)
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
      mode,
      planningTrustVersion: PROJECT_PLAN_TRUST_CONTRACT_VERSION
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

  setPlanningEvidence(
    id: string,
    evidence: ProjectPlanningSkillUse | undefined
  ): Project | undefined {
    const index = this.projects.findIndex((project) => project.id === id)
    if (index < 0) return undefined
    const previous = this.projects[index]
    const updated: Project = {
      ...previous,
      ...(evidence ? { planningEvidence: { ...evidence } } : {})
    }
    if (!evidence) delete updated.planningEvidence
    else delete updated.legacyPlanningApproval
    const next = [...this.projects]
    next[index] = updated
    persistJsonStore(this.file, next)
    this.projects = next
    return updated
  }

  migratePlanningTrust(
    id: string,
    legacyApproval?: ProjectPlanLegacyApproval
  ): Project | undefined {
    const index = this.projects.findIndex((project) => project.id === id)
    if (index < 0) return undefined
    const previous = this.projects[index]
    if (
      (previous.planningTrustVersion ?? 0) >= PROJECT_PLAN_TRUST_CONTRACT_VERSION
    ) {
      return previous
    }
    const updated: Project = {
      ...previous,
      planningTrustVersion: PROJECT_PLAN_TRUST_CONTRACT_VERSION,
      ...(legacyApproval ? { legacyPlanningApproval: { ...legacyApproval } } : {})
    }
    const next = [...this.projects]
    next[index] = updated
    persistJsonStore(this.file, next)
    this.projects = next
    return updated
  }

  remove(id: string): void {
    this.projects = this.projects.filter((p) => p.id !== id)
    this.persist()
  }
}
