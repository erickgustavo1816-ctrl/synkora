import type { Department } from './store'

export interface DeptInfo {
  key: Department
  name: string
  icon: string
  hue: number
  desc: string
  /** contratos nativos sempre visíveis; o roteador soma no máximo uma técnica contextual */
  skills: string[]
  /** resumo humano do fluxo automático desta função */
  skillFlow: string
  /** exemplos históricos; a autoridade real é o roteador por card paralelo */
  agents: string[]
}

// Funções enxutas (decisão do usuário): só existe função quando muda QUEM
// executa e COMO — mobile→front, devops→back, docs→research. O board mostra
// somente os contratos nativos estáveis; a biblioteca completa permanece na
// página geral e o roteador escolhe no máximo uma técnica contextual por card.
export const DEPARTMENTS: DeptInfo[] = [
  {
    key: 'front',
    name: 'front',
    icon: '🎨',
    hue: 21,
    desc: 'interface, componentes e experiência (mobile incluso)',
    // O método visual é contextual e, por isso, não aparece como contrato fixo.
    skills: ['synkora-frontend-standard', 'synkora-ui-qa'],
    skillFlow: 'contrato visual + 1 operação Impeccable; QA visual independente',
    agents: ['ui-visual-validator']
  },
  {
    key: 'back',
    name: 'back',
    icon: '⚙️',
    hue: 210,
    desc: 'servidor, integrações, infra e deploy',
    skills: [
      'synkora-backend-standard',
      'synkora-backend-qa',
      'synkora-devops-standard',
      'synkora-devops-qa'
    ],
    skillFlow: 'Back ou DevOps + 1 técnica contextual; QA próprio da entrega',
    agents: ['backend-reality-checker']
  },
  {
    key: 'qa',
    name: 'qa',
    icon: '🔍',
    hue: 145,
    desc: 'revisão, testes e qualidade',
    skills: ['synkora-qa-standard', 'synkora-qa-qa'],
    skillFlow: 'contrato de autoria + 1 técnica; QA independente dos testes',
    agents: ['test-writer']
  },
  {
    key: 'design',
    name: 'design',
    icon: '🖌️',
    hue: 315,
    desc: 'identidade visual, mockups e protótipos',
    skills: [
      'synkora-frontend-standard',
      'synkora-design-system-standard',
      'synkora-design-system-qa',
      'synkora-ui-qa'
    ],
    skillFlow: 'método e QA próprios de Design System; uso em telas volta ao fluxo Front',
    agents: ['ui-ux-designer']
  },
  {
    key: 'research',
    name: 'research',
    icon: '🔬',
    hue: 48,
    desc: 'pesquisa, referências e documentação',
    skills: ['synkora-research-standard', 'synkora-research-qa'],
    skillFlow: 'contrato de fontes + 1 técnica; QA audita claims e incerteza',
    agents: ['technical-researcher']
  },
  {
    key: 'copy',
    name: 'copy',
    icon: '✍️',
    hue: 285,
    desc: 'textos, microcopy e voz do produto',
    skills: ['synkora-copy-standard', 'synkora-copy-qa'],
    skillFlow: 'contrato de verdade e voz + 1 técnica do canal; QA independente',
    agents: ['microcopy-surgeon']
  },
  {
    key: 'cyber',
    name: 'cyber',
    icon: '🛡️',
    hue: 355,
    desc: 'segurança, ameaças e hardening',
    skills: ['synkora-cyber-standard', 'synkora-cyber-qa'],
    skillFlow: 'contrato defensivo + 1 lente contextual; QA fechado ao escopo',
    agents: ['sharp-edges-analyzer']
  },
  {
    key: 'data',
    name: 'data',
    icon: '📊',
    hue: 170,
    desc: 'dados, métricas e analytics',
    skills: ['synkora-data-standard', 'synkora-data-qa'],
    skillFlow: 'contrato de métricas + 1 técnica; QA recompõe e reconcilia',
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

// STATUS_ORDER e STATUS_LABEL descreviam as quatro colunas do KANBAN
// (backlog → execução → QA → concluída). O kanban saiu na purga F6
// (2026-08-17): o estado que a era 2.0 mostra é o da MISSÃO, e o vocabulário
// dele mora em `missionPresentation.MISSION_STATUS_LABEL`.
