import type {
  MaestroEvent,
  MaestroLiveEvent,
  NewTask,
  Seat,
  SynkoraApi,
  Task
} from '../../preload/index'

// Mock do bridge para desenvolver a UI num browser comum (sem Electron).
// No app real o preload injeta window.synkora antes e este arquivo não faz nada.
export function installDevMock(): void {
  if (typeof window.synkora !== 'undefined') return

  const projects = [
    {
      id: 'mock-1',
      name: 'App Fitness',
      path: 'C:\\dev\\app-fitness',
      createdAt: '2026-07-18T12:00:00.000Z'
    },
    {
      id: 'mock-2',
      name: 'Synkora',
      path: 'C:\\Users\\Erick\\Desktop\\Synkora',
      createdAt: '2026-07-21T12:00:00.000Z'
    }
  ]

  const seats: Seat[] = [
    {
      id: 'seat-1',
      name: 'Claude Principal',
      cli: 'claude',
      createdAt: '2026-07-21T12:00:00.000Z',
      status: 'logado',
      configDir: 'C:\\mock\\seats\\seat-1'
    },
    {
      id: 'seat-2',
      name: 'Claude Turbo',
      cli: 'claude',
      createdAt: '2026-07-21T12:00:00.000Z',
      status: 'pendente',
      configDir: 'C:\\mock\\seats\\seat-2'
    },
    {
      id: 'seat-3',
      name: 'Codex GPT',
      cli: 'codex',
      createdAt: '2026-07-21T12:00:00.000Z',
      status: 'pendente',
      configDir: 'C:\\mock\\seats\\seat-3'
    }
  ]

  let dataCb: ((id: string, data: string) => void) | null = null
  let maestroCb: ((evt: MaestroEvent) => void) | null = null
  let liveCb: ((evt: MaestroLiveEvent) => void) | null = null
  let runEventCb: ((taskId: string, evt: MaestroEvent) => void) | null = null
  let runLiveCb: ((taskId: string, evt: MaestroLiveEvent) => void) | null = null
  let ctxCb: ((tokens: number) => void) | null = null
  let mockCtx = 87_000

  const tasks: Task[] = [
    {
      id: 't1',
      projectId: 'mock-1',
      department: 'front',
      type: 'feature',
      effort: 'pesada',
      title: 'Tela de login com Google',
      description: 'Criar a tela de login com botão OAuth Google. Critério: usuário entra e vê a home logada.',
      status: 'execucao',
      origin: 'maestro',
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z'
    },
    {
      id: 't2',
      projectId: 'mock-1',
      department: 'back',
      type: 'bug',
      effort: 'leve',
      title: 'Endpoint de sessão OAuth',
      description: 'Callback do Google, criação de sessão e cookie httpOnly. Critério: token válido gera sessão.',
      status: 'backlog',
      origin: 'maestro',
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z'
    },
    {
      id: 't3',
      projectId: 'mock-1',
      department: 'qa',
      type: 'feature',
      effort: 'leve',
      title: 'Testes do fluxo de login',
      description: 'Cobrir sucesso, cancelamento e token inválido. Critério: 3 cenários verdes no CI.',
      status: 'qa',
      origin: 'manual',
      createdAt: '2026-07-21T12:00:00.000Z',
      updatedAt: '2026-07-21T12:00:00.000Z'
    }
  ]

  function makeTasks(projectId: string, items: NewTask[]): Task[] {
    const now = new Date().toISOString()
    const created = items.map(
      (item, i): Task => ({
        id: `t-${Date.now()}-${i}`,
        projectId,
        ...item,
        status: 'backlog',
        createdAt: now,
        updatedAt: now
      })
    )
    tasks.push(...created)
    return created
  }

  const api: SynkoraApi = {
    projects: {
      list: async () => [...projects],
      create: async (name: string, path: string) => {
        const p = { id: `mock-${Date.now()}`, name, path, createdAt: new Date().toISOString() }
        projects.push(p)
        return p
      },
      remove: async (id: string) => {
        const i = projects.findIndex((p) => p.id === id)
        if (i >= 0) projects.splice(i, 1)
      }
    },
    seats: {
      list: async () => [...seats],
      create: async (name: string, cli) => {
        const seat: Seat = {
          id: `seat-${Date.now()}`,
          name,
          cli,
          createdAt: new Date().toISOString(),
          status: 'pendente',
          configDir: `C:\\mock\\seats\\${name}`
        }
        seats.push(seat)
        return seat
      },
      remove: async (id: string) => {
        const i = seats.findIndex((s) => s.id === id)
        if (i >= 0) seats.splice(i, 1)
      }
    },
    tasks: {
      onChanged: () => () => undefined,
      list: async (projectId: string) => tasks.filter((t) => t.projectId === projectId),
      create: async (projectId: string, item: NewTask) => makeTasks(projectId, [item]),
      update: async (id: string, patch: Partial<Task>) => {
        const t = tasks.find((x) => x.id === id)
        if (t) Object.assign(t, patch, { updatedAt: new Date().toISOString() })
        return t
      },
      remove: async (id: string) => {
        const i = tasks.findIndex((t) => t.id === id)
        if (i >= 0) tasks.splice(i, 1)
      },
      run: async () => null,
      onPaneOpen: () => () => undefined,
      onPaneClose: () => () => undefined,
      onFeedback: () => () => undefined,
      onAttention: () => () => undefined,
      runPermission: async () => undefined,
      runInterrupt: async () => undefined,
      runHandoff: async () => null,
      runSend: async () => true,
      runClose: async () => undefined,
      runState: async () => [],
      onRunEvent: (cb) => {
        runEventCb = cb
        return () => {
          runEventCb = null
        }
      },
      onRunLive: (cb) => {
        runLiveCb = cb
        return () => {
          runLiveCb = null
        }
      }
    },
    maestro: {
      onEvent: (cb) => {
        maestroCb = cb
        return () => {
          maestroCb = null
        }
      },
      // Simula o painel de fundo: cmd, ferramenta real, stream de texto, turno.
      send: async (projectId: string, message: string) => {
        maestroCb?.({ kind: 'cmd', text: message })
        if (/permiss/i.test(message)) {
          setTimeout(() => {
            liveCb?.({
              type: 'permission',
              requestId: 'mock-perm',
              toolName: 'Write',
              description: '~\\Desktop\\exemplo.txt',
              inputPretty: '{\n  "file_path": "C:\\\\Users\\\\Erick\\\\Desktop\\\\exemplo.txt",\n  "content": "oi"\n}',
              reason: 'Path is outside allowed working directories',
              canAlways: true
            })
          }, 700)
          return
        }
        setTimeout(() => liveCb?.({ type: 'thinking' }), 200)
        setTimeout(
          () =>
            maestroCb?.({
              kind: 'tool',
              tag: 'maestro',
              text: 'lendo CONTEXT.md',
              detail: '{\n  "file_path": ".synkora/CONTEXT.md"\n}'
            }),
          600
        )
        setTimeout(() => maestroCb?.({ kind: 'out', text: '# Contexto do Projeto…' }), 900)
        const reply =
          'Oi! Sou o Maestro (mock do preview de browser). No app real, tudo isto é o espelho ao vivo de um processo claude rodando de fundo.'
        const words = reply.split(' ')
        words.forEach((w, i) =>
          setTimeout(() => liveCb?.({ type: 'delta', text: w + ' ' }), 1100 + i * 60)
        )
        setTimeout(() => {
          liveCb?.({ type: 'flush' })
          maestroCb?.({ kind: 'say', text: reply })
          const wantsWork = /quero|cria|faz|implementa|adiciona|constr/i.test(message)
          if (wantsWork) {
            const created = makeTasks(projectId, [
              {
                department: 'front',
                type: 'feature',
                effort: 'pesada',
                title: `UI: ${message.slice(0, 40)}`,
                description: 'Tarefa simulada pelo mock do Maestro (preview de browser).',
                origin: 'maestro'
              },
              {
                department: 'back',
                type: 'feature',
                effort: 'leve',
                title: `API: ${message.slice(0, 40)}`,
                description: 'Tarefa simulada pelo mock do Maestro (preview de browser).',
                origin: 'maestro'
              }
            ])
            for (const t of created) maestroCb?.({ kind: 'log', tag: t.department, text: t.title })
            maestroCb?.({ kind: 'ok', text: `${created.length} tarefas criadas no backlog` })
          }
          mockCtx += 12_000
          ctxCb?.(mockCtx)
          liveCb?.({ type: 'turn-end' })
        }, 1100 + words.length * 60 + 200)
      },
      permission: async (_projectId: string, _requestId: string, choice) => {
        maestroCb?.({
          kind: 'ask',
          text: `${choice === 'deny' ? '✗ negado' : '✓ permitido'} — Write ~\\Desktop\\exemplo.txt`
        })
        liveCb?.({ type: 'turn-end' })
      },
      interrupt: async () => {
        maestroCb?.({ kind: 'log', tag: 'maestro', text: '⏹ interrompendo o turno…' })
        liveCb?.({ type: 'turn-end' })
      },
      onLive: (cb) => {
        liveCb = cb
        return () => {
          liveCb = null
        }
      },
      capabilities: async () => ({
        commands: [
          { name: 'usage', description: 'mostra o uso do plano (mock)', argumentHint: '' },
          { name: 'compact', description: 'compacta a conversa (mock)', argumentHint: '' },
          { name: 'recap', description: 'resumo da sessão (mock)', argumentHint: '' }
        ],
        models: [
          {
            value: 'default',
            resolvedModel: 'claude-opus-4-8[1m]',
            displayName: 'Default (recommended)',
            description: 'Opus 4.8 with 1M context · Best for everyday, complex tasks',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
          },
          {
            value: 'claude-fable-5[1m]',
            resolvedModel: 'claude-fable-5',
            displayName: 'Fable',
            description: 'Fable 5 · Most capable for your hardest and longest-running tasks',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
          },
          {
            value: 'haiku',
            resolvedModel: 'claude-haiku-4-5',
            displayName: 'Haiku',
            description: 'Haiku 4.5 · Fastest for quick answers',
            supportsEffort: false
          }
        ],
        account: { email: 'mock@synkora.dev', subscriptionType: 'Claude Max' }
      }),
      survey: async () =>
        new Promise((resolve) => {
          const seq: MaestroEvent[] = [
            { kind: 'cmd', text: 'maestro estudar' },
            { kind: 'log', tag: 'maestro', text: 'mapeando o projeto…' },
            { kind: 'log', tag: 'maestro', text: 'lendo package.json' },
            { kind: 'log', tag: 'maestro', text: 'lendo CLAUDE.md' },
            { kind: 'log', tag: 'maestro', text: 'explorando src/' },
            { kind: 'log', tag: 'maestro', text: 'buscando "TODO"' },
            { kind: 'ok', text: 'dossiê salvo em .synkora/CONTEXT.md · sessão reiniciada com o novo contexto' }
          ]
          seq.forEach((evt, i) => setTimeout(() => maestroCb?.(evt), 350 * (i + 1)))
          setTimeout(() => resolve(undefined), 350 * (seq.length + 1))
        }),
      getState: async () => ({
        log: [],
        contextTokens: 87_000,
        contextLimit: null,
        contextWindow: 1_000_000,
        model: null,
        effort: null,
        sessionId: 'mock-session',
        autopilot: false
      }),
      setEffort: async (_projectId: string, effort: string) => {
        maestroCb?.({ kind: 'ok', text: `effort do maestro: ${effort || 'padrão do modelo'}` })
      },
      setContextLimit: async (_projectId: string, limit: number) => {
        maestroCb?.({ kind: 'ok', text: `limite de contexto do maestro: ${Math.round(limit / 1000)}k (janela do modelo: 200k)` })
      },
      onCtx: (cb) => {
        ctxCb = cb
        return () => {
          ctxCb = null
        }
      },
      reset: async () => undefined,
      setModel: async (_projectId: string, model: string) => {
        maestroCb?.({ kind: 'ok', text: `modelo do maestro: ${model}` })
      }
    },
    harness: {
      setAutopilot: async () => undefined
    },
    policies: {
      get: async () => ({}),
      set: async () => undefined
    },
    catalog: {
      get: async (cli: 'claude' | 'codex') =>
        cli === 'claude'
          ? {
              models: [
                { id: 'fable', label: 'fable — Claude Fable 5 (máximo, 1M ctx)' },
                { id: 'opus', label: 'opus — Claude Opus 4.8' },
                { id: 'sonnet', label: 'sonnet — Claude Sonnet 5' },
                { id: 'haiku', label: 'haiku — Claude Haiku 4.5 (leve)' }
              ],
              efforts: ['low', 'medium', 'high', 'xhigh', 'max']
            }
          : {
              models: [
                {
                  id: 'gpt-5.6-sol',
                  label: 'GPT-5.6-Sol',
                  efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                  defaultEffort: 'low'
                }
              ],
              efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
            }
    },
    clipboard: {
      hasImage: () => false,
      saveImage: async () => null
    },
    pickFolder: async () => 'C:\\dev\\novo-projeto',
    pty: {
      create: async (opts: { id: string }) => {
        const id = opts.id
        setTimeout(() => {
          dataCb?.(
            id,
            '\x1b[38;5;111m✦ Synkora\x1b[0m · preview de UI no browser\r\n' +
              '\x1b[90mTerminais reais só rodam dentro do Electron (npm run dev).\x1b[0m\r\n'
          )
        }, 80)
      },
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: (cb) => {
        dataCb = cb
        return () => {
          dataCb = null
        }
      },
      onExit: () => () => undefined
    }
  }

  window.synkora = api
}
