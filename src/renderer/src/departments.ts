import type { Department, TaskStatus } from './store'

export interface DeptInfo {
  key: Department
  name: string
  icon: string
  hue: number
  desc: string
  skills: string[]
}

export const DEPARTMENTS: DeptInfo[] = [
  {
    key: 'front',
    name: 'front',
    icon: '🎨',
    hue: 21,
    desc: 'interface, componentes e experiência',
    skills: ['design-taste-frontend', 'minimalist-ui', 'image-to-code', 'prototype']
  },
  {
    key: 'back',
    name: 'back',
    icon: '⚙️',
    hue: 210,
    desc: 'servidor, dados e integrações',
    skills: ['tdd', 'implement', 'codebase-design', 'owasp-security']
  },
  {
    key: 'qa',
    name: 'qa',
    icon: '🔍',
    hue: 145,
    desc: 'revisão, testes e qualidade',
    skills: ['code-review', 'security-review', 'tdd', 'diagnosing-bugs']
  },
  {
    key: 'design',
    name: 'design',
    icon: '🖌️',
    hue: 315,
    desc: 'identidade visual, mockups e protótipos',
    skills: ['brandkit', 'imagegen-frontend-mobile', 'high-end-visual-design', 'prototype']
  },
  {
    key: 'research',
    name: 'research',
    icon: '🔬',
    hue: 48,
    desc: 'pesquisa de mercado, tecnologia e referências',
    skills: ['research', 'deep-research', 'grill-me', 'domain-modeling']
  }
]

export const DEPT_BY_KEY = Object.fromEntries(DEPARTMENTS.map((d) => [d.key, d])) as Record<
  Department,
  (typeof DEPARTMENTS)[number]
>

export const STATUS_ORDER: TaskStatus[] = ['backlog', 'analise', 'execucao', 'qa', 'done']

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  analise: 'Em análise',
  execucao: 'Em execução',
  qa: 'QA',
  done: 'Concluída'
}
