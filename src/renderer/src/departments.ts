import type { Department, TaskStatus } from './store'

export interface DeptInfo {
  key: Department
  name: string
  icon: string
  hue: number
  desc: string
  /** skills PRÉ-SETADAS pelo app (o executor escolhe a melhor para o caso) */
  skills: string[]
  /** subagentes especializados PRÉ-SETADOS pelo app */
  agents: string[]
}

// Funções enxutas (decisão do usuário): só existe função quando muda QUEM
// executa e COMO — mobile→front, devops→back, docs→research. Skills e
// subagentes vêm setados de fábrica; o usuário pode adicionar/remover na
// página geral e a IA escolhe o melhor para cada caso (injeção real = F4).
export const DEPARTMENTS: DeptInfo[] = [
  {
    key: 'front',
    name: 'front',
    icon: '🎨',
    hue: 21,
    desc: 'interface, componentes e experiência (mobile incluso)',
    // F4: ids REAIS da biblioteca (skillsCatalog.ts no main é a fonte da
    // verdade; estes são os defaultFor de 'front' — a UI da página geral
    // mostra a biblioteca completa e o estado real de instalação).
    skills: ['frontend-design', 'better-ui', 'better-layout'],
    agents: ['ui-visual-validator']
  },
  {
    key: 'back',
    name: 'back',
    icon: '⚙️',
    hue: 210,
    desc: 'servidor, integrações, infra e deploy',
    skills: ['test-driven-development', 'verification-before-completion', 'supabase-postgres-best-practices'],
    agents: ['backend-reality-checker']
  },
  {
    key: 'qa',
    name: 'qa',
    icon: '🔍',
    hue: 145,
    desc: 'revisão, testes e qualidade',
    skills: ['code-review', 'code-review-and-quality', 'webapp-testing'],
    agents: ['test-writer']
  },
  {
    key: 'design',
    name: 'design',
    icon: '🖌️',
    hue: 315,
    desc: 'identidade visual, mockups e protótipos',
    skills: ['create-design-md', 'frontend-design', 'design-system-patterns'],
    agents: ['ui-ux-designer']
  },
  {
    key: 'research',
    name: 'research',
    icon: '🔬',
    hue: 48,
    desc: 'pesquisa, referências e documentação',
    skills: ['research', 'deep-research', 'domain-modeling'],
    agents: ['technical-researcher']
  },
  {
    key: 'copy',
    name: 'copy',
    icon: '✍️',
    hue: 285,
    desc: 'textos, microcopy e voz do produto',
    // F4 rodada 7: ids REAIS (defaultFor de 'copy' no skillsCatalog/agentsBundled)
    skills: ['better-writing', 'humanizer', 'copywriting'],
    agents: ['microcopy-surgeon']
  },
  {
    key: 'cyber',
    name: 'cyber',
    icon: '🛡️',
    hue: 355,
    desc: 'segurança, ameaças e hardening',
    // F4 rodada 8: ids REAIS (defaultFor de 'cyber' no skillsCatalog/agentsBundled)
    skills: ['differential-review', 'insecure-defaults', 'security-testing', 'owasp-security'],
    agents: ['sharp-edges-analyzer']
  },
  {
    key: 'data',
    name: 'data',
    icon: '📊',
    hue: 170,
    desc: 'dados, métricas e analytics',
    // F4 rodada 9: ids REAIS (defaultFor de 'data' no skillsCatalog/agentsBundled)
    skills: ['sql-queries', 'statistical-analysis', 'validate-data', 'data-quality-frameworks'],
    agents: ['data-quality-sentinel']
  }
]

export const DEPT_BY_KEY = Object.fromEntries(DEPARTMENTS.map((d) => [d.key, d])) as Record<
  Department,
  (typeof DEPARTMENTS)[number]
>

// ————————————————————————————————————————————————————————————————————————
// CORES DAS FUNÇÕES EDITÁVEIS (pedido do usuário, 2026-07-29): o `hue` acima é
// só o PADRÃO. O override do usuário vive em localStorage (global à máquina,
// vale para todos os universos) e vira CSS var global `--hue-<função>` no
// :root — quem pinta por função usa `deptHueVar()` e repinta sozinho quando a
// cor muda, sem re-render. Canvas/SVG que precisam de NÚMERO usam
// `deptHueOf()` com `store.deptHues`.
// ————————————————————————————————————————————————————————————————————————
export const DEPT_HUES_LS_KEY = 'synkora.deptHues'

export function loadDeptHues(): Partial<Record<Department, number>> {
  try {
    const raw = localStorage.getItem(DEPT_HUES_LS_KEY)
    if (!raw) return {}
    const obj = JSON.parse(raw) as Record<string, unknown>
    const out: Partial<Record<Department, number>> = {}
    for (const d of DEPARTMENTS) {
      const v = obj[d.key]
      if (typeof v === 'number' && Number.isFinite(v))
        out[d.key] = ((Math.round(v) % 360) + 360) % 360
    }
    return out
  } catch {
    return {}
  }
}

/** Escreve as CSS vars globais (`--hue-front`…) no :root. */
export function applyDeptHueVars(hues: Partial<Record<Department, number>>): void {
  for (const d of DEPARTMENTS)
    document.documentElement.style.setProperty(`--hue-${d.key}`, String(hues[d.key] ?? d.hue))
}

/** Cor viva de uma função em CSS — SEMPRE preferir isto a `DEPT_BY_KEY[k].hue`
 *  num estilo (o número cru ignora o override do usuário). */
export function deptHueVar(key: Department): string {
  return `var(--hue-${key})`
}

/** Hue efetivo em NÚMERO (canvas/strokes calculados que não leem CSS var). */
export function deptHueOf(key: Department, hues: Partial<Record<Department, number>>): number {
  return hues[key] ?? DEPT_BY_KEY[key].hue
}

export const STATUS_ORDER: TaskStatus[] = ['backlog', 'execucao', 'qa', 'done']

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  execucao: 'Em execução',
  qa: 'QA',
  done: 'Concluída'
}
