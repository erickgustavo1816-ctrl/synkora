import type { Department, NewTask } from './tasks'

/**
 * Keep the legacy conversational task parser aligned with the authoritative
 * department model. MCP planning has its own typed schema, but free Maestro
 * conversations still pass through this parser.
 */
export const MAESTRO_DEPARTMENTS = [
  'front',
  'back',
  'qa',
  'design',
  'research',
  'copy',
  'cyber',
  'data'
] as const satisfies readonly Department[]

const MAESTRO_DEPARTMENT_SET = new Set<Department>(MAESTRO_DEPARTMENTS)

export function parseMaestroTasks(raw: string): NewTask[] {
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown[] }
    return (parsed.tasks ?? [])
      .filter(
        (task): task is {
          department: Department
          type?: string
          effort?: string
          title: string
          description: string
        } =>
          typeof task === 'object' &&
          task !== null &&
          MAESTRO_DEPARTMENT_SET.has((task as { department: Department }).department) &&
          typeof (task as { title: unknown }).title === 'string' &&
          typeof (task as { description: unknown }).description === 'string'
      )
      .map((task) => ({
        department: task.department,
        title: task.title,
        description: task.description,
        type: task.type === 'bug' ? ('bug' as const) : ('feature' as const),
        effort: task.effort === 'pesada' ? ('pesada' as const) : ('leve' as const),
        origin: 'maestro' as const
      }))
  } catch {
    return []
  }
}
