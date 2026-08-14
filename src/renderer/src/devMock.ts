import type {
  MaestroEvent,
  MaestroLiveEvent,
  Mission,
  NewTask,
  ProgressOverlaySnapshot,
  Seat,
  ServicesSnapshot,
  SynVoiceConfig,
  SynVoiceModel,
  SynVoiceOverlayState,
  SynVoiceProvider,
  SynkoraApi,
  SynkoraSettings,
  Task,
  FilePreviewResult,
  FileTreeResult
} from '../../preload/index'

// Mock do bridge para desenvolver a UI num browser comum (sem Electron).
// No app real o preload injeta window.synkora antes e este arquivo não faz nada.
export function installDevMock(): void {
  const view = new URLSearchParams(window.location.search).get('view')
  if (view === 'progress-overlay') {
    if (typeof window.synkoraProgressOverlay !== 'undefined') return
    const progressScenario = new URLSearchParams(window.location.search).get('scenario')
    let snapshot: ProgressOverlaySnapshot = {
      revision: 1,
      generatedAt: new Date().toISOString(),
      totals: {
        projects: 3,
        activeProjects: 2,
        activeMissions: 3,
        activeCards: 1,
        activeCoordinators: 3,
        attentionMissions: 1,
        attentionProjects: 0,
        recentCompletions: 1
      },
      projects: [
        {
          id: 'mock-2',
          name: 'Synkora',
          mode: 'existing',
          missing: false,
          state: 'attention',
          tone: 'attention',
          label: 'precisa de atenção',
          coordinators: [
            {
              id: 'orchestrator:mission-radar',
              projectId: 'mock-2',
              missionId: 'mission-radar',
              role: 'orchestrator',
              roleLabel: 'Orquestrador',
              label: 'acompanhando a revisão',
              detail: 'Criar radar de andamento',
              tone: 'running',
              updatedAt: new Date().toISOString()
            },
            {
              id: 'maestro:mock-2',
              projectId: 'mock-2',
              role: 'maestro',
              roleLabel: 'Maestro',
              label: 'decidindo como resolver uma integração bloqueada',
              detail: 'Melhorar integração paralela',
              tone: 'running',
              updatedAt: new Date().toISOString()
            }
          ],
          activeMissions: [
            {
              id: 'mission-radar',
              projectId: 'mock-2',
              title: 'Criar radar de andamento',
              state: 'reviewing',
              tone: 'running',
              label: 'revisando o trabalho',
              detail: 'Validar janela flutuante',
              updatedAt: new Date().toISOString(),
              progress: { done: 3, total: 5, active: 1 },
              activeCards: [
                {
                  id: 'card-radar-review',
                  title: 'Validar janela flutuante em tamanhos diferentes',
                  phase: 'review',
                  phaseLabel: 'em revisão',
                  interrupted: false,
                  tone: 'running',
                  note: 'lendo o diff da janela flutuante',
                  updatedAt: new Date().toISOString()
                }
              ]
            },
            {
              id: 'mission-queue',
              projectId: 'mock-2',
              title: 'Melhorar integração paralela',
              state: 'blocked',
              tone: 'attention',
              label: 'integração bloqueada',
              detail: 'o Maestro está decidindo como resolver o conflito',
              updatedAt: new Date(Date.now() - 90_000).toISOString(),
              progress: { done: 4, total: 4, active: 0 },
              activeCards: [],
              queue: { state: 'blocked', position: 1, total: 2, owner: 'maestro' }
            }
          ],
          recentCompletions: []
        },
        {
          id: 'mock-1',
          name: 'App Fitness',
          mode: 'greenfield',
          missing: false,
          state: 'planning',
          tone: 'waiting',
          label: 'missões em preparação',
          coordinators: [
            {
              id: 'maestro:mock-1',
              projectId: 'mock-1',
              role: 'maestro',
              roleLabel: 'Maestro',
              label: 'acompanhando o projeto e suas missões',
              tone: 'running',
              updatedAt: new Date().toISOString()
            }
          ],
          masterPlan: {
            status: 'in_progress',
            label: 'projeto em construção',
            done: 8,
            active: 1,
            total: 24,
            currentWave: 'onda-3'
          },
          activeMissions: [
            {
              id: 'mission-app',
              projectId: 'mock-1',
              title: 'Tela inicial e autenticação',
              state: 'awaiting_approval',
              tone: 'attention',
              label: 'aguardando sua aprovação',
              detail: 'o plano da missão está pronto para revisão',
              updatedAt: new Date(Date.now() - 180_000).toISOString(),
              progress: { done: 0, total: 0, active: 0 },
              activeCards: []
            }
          ],
          recentCompletions: [
            {
              id: 'mission-done',
              projectId: 'mock-1',
              title: 'Definir identidade visual',
              state: 'completed',
              tone: 'success',
              label: 'concluída',
              updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
              completedAt: new Date(Date.now() - 3_600_000).toISOString(),
              progress: { done: 0, total: 0, active: 0 },
              activeCards: []
            }
          ]
        },
        {
          id: 'mock-idle',
          name: 'Site antigo',
          mode: 'existing',
          missing: false,
          state: 'idle',
          tone: 'idle',
          label: 'sem missão em andamento',
          coordinators: [],
          activeMissions: [],
          recentCompletions: []
        }
      ]
    }
    if (progressScenario === 'empty') {
      snapshot = {
        revision: 2,
        generatedAt: new Date().toISOString(),
        totals: {
          projects: snapshot.projects.length,
          activeProjects: 0,
          activeMissions: 0,
          activeCards: 0,
          activeCoordinators: 0,
          attentionMissions: 0,
          attentionProjects: 0,
          recentCompletions: 0
        },
        projects: snapshot.projects.map((project) => ({
          ...project,
          state: 'idle',
          tone: 'idle',
          label: 'sem missão em andamento',
          coordinators: [],
          activeMissions: [],
          recentCompletions: [],
          masterPlan: undefined
        }))
      }
    } else if (progressScenario === 'many') {
      const source = snapshot.projects[0]
      const missionSources = source.activeMissions
      const activeMissions = Array.from({ length: 14 }, (_, index) => {
        const original = missionSources[index % missionSources.length]
        return {
          ...original,
          id: 'many-mission-' + index,
          title: 'Missão simultânea ' + (index + 1),
          updatedAt: new Date(Date.now() - index * 12_000).toISOString(),
          activeCards: original.activeCards.map((card, cardIndex) => ({
            ...card,
            id: 'many-card-' + index + '-' + cardIndex
          }))
        }
      })
      snapshot = {
        revision: 3,
        generatedAt: new Date().toISOString(),
        totals: {
          projects: 1,
          activeProjects: 1,
          activeMissions: activeMissions.length,
          activeCards: activeMissions.reduce(
            (total, mission) => total + mission.activeCards.length,
            0
          ),
          activeCoordinators: source.coordinators.length,
          attentionMissions: activeMissions.filter((mission) => mission.tone === 'attention').length,
          attentionProjects: 1,
          recentCompletions: 0
        },
        projects: [{
          ...source,
          activeMissions,
          recentCompletions: []
        }]
      }
    } else if (progressScenario === 'history') {
      const source = snapshot.projects[1]
      const completedSource = source.recentCompletions[0]
      const recentCompletions = Array.from({ length: 12 }, (_, index) => ({
        ...completedSource,
        id: 'history-mission-' + index,
        title: 'Entrega concluída ' + (index + 1),
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
        completedAt: new Date(Date.now() - index * 60_000).toISOString()
      }))
      snapshot = {
        revision: 4,
        generatedAt: new Date().toISOString(),
        totals: {
          projects: 1,
          activeProjects: 0,
          activeMissions: 0,
          activeCards: 0,
          activeCoordinators: 0,
          attentionMissions: 0,
          attentionProjects: 0,
          recentCompletions: recentCompletions.length
        },
        projects: [{
          ...source,
          state: 'idle',
          tone: 'idle',
          label: 'sem missão em andamento',
          coordinators: [],
          activeMissions: [],
          recentCompletions,
          masterPlan: undefined
        }]
      }
    }
    const listeners = new Set<(next: ProgressOverlaySnapshot) => void>()
    const modeListeners = new Set<(next: { compact: boolean }) => void>()
    const historyListeners = new Set<(next: { clearedAt: string | null }) => void>()
    let compact = false
    let historyClearedAt: string | null = null
    window.synkoraProgressOverlay = {
      getState: async () => ({ snapshot, compact, historyClearedAt }),
      resize: () => undefined,
      command: (command) => {
        if (command === 'compact' || command === 'expand') {
          compact = command === 'compact'
          for (const listener of modeListeners) listener({ compact })
          return
        }
        if (command === 'clear-history') {
          historyClearedAt = snapshot.generatedAt
          for (const listener of historyListeners) listener({ clearedAt: historyClearedAt })
        }
      },
      onSnapshot: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      onMode: (listener) => {
        modeListeners.add(listener)
        return () => modeListeners.delete(listener)
      },
      onHistory: (listener) => {
        historyListeners.add(listener)
        return () => historyListeners.delete(listener)
      }
    }
    return
  }
  if (view === 'synvoice-overlay') {
    if (typeof window.synkoraOverlay !== 'undefined') return
    const voiceScenario = new URLSearchParams(window.location.search).get('scenario')
    let overlayState: SynVoiceOverlayState = {
      stage: 'idle',
      elapsed: 0,
      level: 0,
      bands: Array.from({ length: 13 }, () => 0),
      configured: true,
      status: 'Clique para falar',
      activationMode: 'toggle',
      activationLabel: 'Mouse 5 (Lateral)'
    }
    if (voiceScenario === 'recording') {
      overlayState = {
        ...overlayState,
        stage: 'recording',
        elapsed: 83_000,
        level: 0.62,
        bands: [0.2, 0.48, 0.73, 0.35, 0.88, 0.56, 0.95, 0.42, 0.7, 0.3, 0.82, 0.5, 0.24],
        status: 'Ouvindo'
      }
    } else if (voiceScenario === 'processing') {
      overlayState = { ...overlayState, stage: 'processing', status: 'Transcrevendo o áudio' }
    } else if (voiceScenario === 'inserted') {
      overlayState = { ...overlayState, stage: 'inserted', status: 'Texto inserido no destino' }
    }
    const voiceHistory = voiceScenario === 'history'
      ? [
          {
            text: 'Revise o painel do SynVoice e deixe os controles bem alinhados.',
            at: new Date(Date.now() - 45_000).toISOString()
          },
          {
            text: 'Esta é uma fala propositalmente muito longa para validar que a prévia termina com reticências sem aumentar o cartão nem escapar da largura disponível no mini painel.',
            at: new Date(Date.now() - 120_000).toISOString()
          },
          {
            text: 'Criar os testes focados do histórico.',
            at: new Date(Date.now() - 300_000).toISOString()
          },
          {
            text: 'SynkoraSuperLongWordWithoutNaturalBreaksNeedsToStayInsideTheCardAtEveryWidth',
            at: new Date(Date.now() - 600_000).toISOString()
          }
        ]
      : []
    const listeners = new Set<(state: SynVoiceOverlayState) => void>()
    window.synkoraOverlay = {
    getState: async () => overlayState,
    prepareInteraction: () => undefined,
    history: async () => voiceHistory,
    historyCopy: async (index) => Boolean(voiceHistory[index]),
    setHistoryOpen: () => undefined,
    command: (command) => {
        if (command !== 'toggle') return
        overlayState = overlayState.stage === 'recording'
          ? { ...overlayState, stage: 'processing', status: 'Transcrevendo' }
          : { ...overlayState, stage: 'recording', elapsed: 0, status: 'Ouvindo' }
        for (const listener of listeners) listener(overlayState)
      },
      showTooltip: () => undefined,
      hideTooltip: () => undefined,
      onState: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
    return
  }
  if (typeof window.synkora !== 'undefined') return

  let appSettings: SynkoraSettings = {
    codeIntelligenceMode: 'automatic',
    mcpProtocolMode: 'auto',
    externalServicePreparation: 'automatic',
    imageProvider: 'codex',
    openrouterKeyConfigured: false,
    githubTokenConfigured: false,
    terminalFontSize: 13,
    terminalLineHeight: 1.25,
    terminalFontFamily: 'Cascadia Code',
    chatNotifyNeedsYou: true,
    chatNotifyFinished: true,
    chatNotifyFailed: true,
    chatSoundsEnabled: true
  }

  const servicesSnapshot = (): ServicesSnapshot => ({
    generatedAt: Date.now(),
    codeIntelligence: {
      mode: appSettings.codeIntelligenceMode,
      state: appSettings.codeIntelligenceMode === 'off' ? 'off' : 'active',
      processCount: appSettings.codeIntelligenceMode === 'off' ? 0 : 1,
      languages: ['TypeScript', 'JavaScript'],
      servers: appSettings.codeIntelligenceMode === 'off'
        ? []
        : [{
            kind: 'typescript-native',
            name: 'TypeScript Language Server',
            version: '7.0.2',
            running: true,
            activeQueries: 0,
            openDocuments: 3
          }],
      telemetry: { starts: 1, restarts: 0, evictions: 0, failures: 0, requests: 142, reuses: 141 }
    },
    internalMcp: { state: 'ready', protocol: 'dual-era', port: 43117 },
    codexProbe: {
      state: 'ready',
      seats: [{
        seatId: 'codex-seat',
        seatName: 'Codex',
        state: 'ready',
        checkedAt: Date.now(),
        version: '0.146.0',
        featurePresent: true,
        featureEnabled: false,
        capability: false,
        reason: 'fallback legado seguro'
      }]
    },
    externalServices: {
      preparation: appSettings.externalServicePreparation,
      state: 'available',
      checkedAt: Date.now(),
      playwright: { available: true, availability: 'on-demand', version: '0.0.78' }
    },
    paneStartup: {
      primaryMilestone: 'agent_first_output',
      windowSize: 128,
      samples: 18,
      p50Ms: 784,
      p95Ms: 1310,
      milestones: {
        terminal_first_frame: { samples: 18, p50Ms: 110, p95Ms: 184 },
        external_mcp_available: { samples: 12, p50Ms: 232, p95Ms: 401 },
        agent_first_output: { samples: 18, p50Ms: 784, p95Ms: 1310 }
      }
    }
  })

  let voiceProvider: SynVoiceProvider = 'openai'
  const voiceConfigured: Record<SynVoiceProvider, boolean> = { openai: true, openrouter: false }
  const voiceSelectedModel: Record<SynVoiceProvider, string | null> = {
    openai: null,
    openrouter: null
  }
  let voiceCustomVocabulary = ['Synkora']
  const voiceCancelled = new Set<string>()
  const voiceModelCatalog: Record<SynVoiceProvider, SynVoiceModel[]> = {
    openai: [
      { id: 'gpt-transcribe', name: 'GPT Transcribe', description: 'Máxima precisão.', recommended: true },
      { id: 'gpt-4o-transcribe', name: 'GPT-4o Transcribe', description: 'Alta qualidade.' },
      { id: 'gpt-4o-mini-transcribe', name: 'GPT-4o Mini Transcribe', description: 'Mais econômico.' }
    ],
    openrouter: [
      { id: 'openai/gpt-4o-transcribe', name: 'OpenAI: GPT-4o Transcribe', description: 'Alta precisão.', recommended: true },
      { id: 'deepgram/nova-3', name: 'Deepgram: Nova-3', description: 'Modelo de transcrição.' },
      { id: 'mistralai/voxtral-mini-transcribe', name: 'Mistral: Voxtral Mini Transcribe', description: 'Modelo multilíngue.' }
    ]
  }
  const voiceConfig = (): SynVoiceConfig => {
    const providers = {
      openai: {
        configured: voiceConfigured.openai,
        source: voiceConfigured.openai ? ('secure-storage' as const) : ('none' as const),
        model: voiceSelectedModel.openai ?? 'gpt-transcribe',
        selectedModel: voiceSelectedModel.openai
      },
      openrouter: {
        configured: voiceConfigured.openrouter,
        source: voiceConfigured.openrouter ? ('secure-storage' as const) : ('none' as const),
        model: voiceSelectedModel.openrouter ?? 'openai/gpt-4o-transcribe',
        selectedModel: voiceSelectedModel.openrouter
      }
    }
    return {
      provider: voiceProvider,
      ...providers[voiceProvider],
      customVocabulary: [...voiceCustomVocabulary],
      secureStorageAvailable: true,
      providers
    }
  }

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
  // F3-c3: simula o broadcast panes:open-free do main no preview de browser.
  let openFreeCb:
    | ((projectId: string, kind: string, opts: Record<string, unknown>) => void)
    | null = null
  let liveCb: ((evt: MaestroLiveEvent) => void) | null = null
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

  const missions: Mission[] = [
    {
      id: 'mission-1',
      projectId: 'mock-1',
      title: 'Tela de perfil',
      goal: 'Perfil do usuário com foto, metas e histórico.',
      scope: 'src/screens/profile',
      status: 'ativa',
      branch: 'mission/abc12345',
      baseBranch: 'main',
      createdAt: '2026-07-22T09:00:00.000Z',
      updatedAt: '2026-07-22T09:00:00.000Z'
    }
  ]

  const api: SynkoraApi = {
    skills: {
      list: async () => [
        {
          id: 'frontend-design',
          kind: 'skill',
          depts: ['front'],
          group: 'direção estética',
          repo: 'anthropics/skills',
          summary: 'Direção estética oficial da Anthropic — a skill de design mais instalada.',
          hint: 'Use when building or restyling any user-facing screen.',
          defaultFor: ['front'],
          installed: true,
          sha: 'abc1234def',
          installedAt: '2026-07-29T12:00:00.000Z',
          updateAvailable: true
        },
        {
          id: 'better-ui',
          kind: 'skill',
          depts: ['front'],
          group: 'polish & micro-interações',
          repo: 'jakubkrehel/skills',
          summary: 'Polimento com valores exatos: press states, springs, focus rings.',
          hint: 'Use when polishing components/micro-interactions.',
          defaultFor: ['front'],
          installed: true,
          sha: 'bbb1234def',
          installedAt: '2026-07-29T12:00:00.000Z',
          updateAvailable: false
        },
        {
          id: 'ui-reviewer',
          kind: 'agent',
          depts: ['front'],
          group: 'subagentes especializados',
          repo: 'mock/agents',
          summary: 'Subagente de crítica de UI (mock do preview).',
          hint: 'Delegate UI critiques to this specialist.',
          installed: true,
          sha: 'ccc1234def',
          installedAt: '2026-07-29T12:00:00.000Z',
          updateAvailable: false
        },
        {
          id: 'emil-design-eng',
          kind: 'skill',
          depts: ['front'],
          group: 'animação',
          repo: 'emilkowalski/skills',
          summary: 'Animação de interface do Emil Kowalski: easing, duração, propósito.',
          hint: 'Use when adding or reviewing interface animations.',
          installed: false,
          updateAvailable: false
        }
      ],
      install: async () => ({ ok: false, msg: 'preview: sem instalação no browser' }),
      installMany: async () => ({ ok: false, msg: 'preview: sem instalação no browser' }),
      addCustom: async () => ({ ok: false, msg: 'preview: sem instalação no browser' }),
      addCustomAgent: async () => ({ ok: false, msg: 'preview: sem instalação no browser' }),
      remove: async () => ({ ok: false, msg: 'preview: sem instalação no browser' }),
      update: async () => ({ ok: false, msg: 'preview: sem instalação no browser' }),
      check: async () => 0,
      exportLib: async () => ({ ok: false, msg: 'preview: sem export no browser' }),
      importLib: async () => ({ ok: false, msg: 'preview: sem import no browser' }),
      onChanged: () => () => undefined
    },
    blackbox: {
      exportDiagnostics: async () => ({ ok: false, msg: 'preview: sem diagnóstico no browser' }),
      tail: async () => []
    },
    backlog: {
      listVersions: async () => [],
      createVersion: async () => null,
      updateVersion: async () => null,
      removeVersion: async () => 'mock: versão removida',
      releaseVersion: async () => 'mock: sem git no preview',
      listItems: async () => [],
      createItem: async () => null,
      updateItem: async () => null,
      removeItem: async () => undefined,
      onChanged: () => () => undefined
    },
    missions: {
      list: async (projectId: string) => missions.filter((m) => m.projectId === projectId),
      versionChoices: async () => ({ versions: [], defaultVersionId: undefined }),
      create: async (projectId: string, input) => {
        const now = new Date().toISOString()
        const m: Mission = {
          id: `mission-${Date.now()}`,
          projectId,
          title: input.title,
          goal: input.goal,
          scope: input.scope,
          status: 'ativa',
          branch: 'mission/mock1234',
          baseBranch: 'main',
          createdAt: now,
          updatedAt: now
        }
        missions.push(m)
        return m
      },
      update: async (id, patch) => {
        const m = missions.find((x) => x.id === id)
        if (m) Object.assign(m, patch, { updatedAt: new Date().toISOString() })
        return m ?? null
      },
      integrate: async () => 'missão na fila de integração #1 (mock)',
      remove: async (id: string) => {
        const i = missions.findIndex((m) => m.id === id)
        if (i >= 0) missions.splice(i, 1)
        return true
      },
      confirmOrchestrator: async (_projectId: string, missionId: string, choice) => {
        const m = missions.find((x) => x.id === missionId)
        if (!m) return false
        Object.assign(m, {
          seatId: choice.seatId,
          model: choice.model,
          effort: choice.effort,
          pendingOrchestrator: undefined,
          updatedAt: new Date().toISOString()
        })
        return true
      },
      setOrchestratorSeat: async (_projectId: string, missionId: string, choice) => {
        const m = missions.find((x) => x.id === missionId)
        if (!m) return { ok: false, msg: 'missão não encontrada' }
        Object.assign(m, {
          seatId: choice.seatId,
          model: choice.model,
          effort: choice.effort,
          updatedAt: new Date().toISOString()
        })
        return { ok: true, msg: 'conta trocada (mock)' }
      },
      paneSpec: async () => null,
      // 2.0: a conta da conversa é escolhida DENTRO da missão (card do chat
      // vazio / menu do cabeçalho). No preview o mock só carimba o seat.
      setChatSeat: async (_projectId: string, missionId: string, seatId: string) => {
        const m = missions.find((x) => x.id === missionId)
        if (!m) return { ok: false, msg: 'missão não encontrada' }
        Object.assign(m, { seatId, updatedAt: new Date().toISOString() })
        return { ok: true, msg: 'conta escolhida (mock)' }
      },
      // 2.0: no preview de browser não há CLI para conversar — a spec do chat
      // da missão recusa com texto honesto em vez de fingir sessão.
      guiSpec: async () => ({ ok: false, error: 'sem sessão de chat no preview' }),
      // 2.0: terminal do worktree é um PTY de verdade — o preview de browser
      // não tem processo nenhum para abrir, então recusa em vez de fingir.
      shellSpec: async () => ({ ok: false, error: 'sem terminal no preview' }),
      workspaceFiles: async () => ({ ok: false, error: 'sem worktree no preview' }),
      // 2.0: sem worktree não há diff para ler — recusa honesta em vez de um
      // patch inventado, que ensinaria a UI a confiar em texto que não existe.
      fileDiff: async () => ({ ok: false, error: 'sem worktree no preview' }),
      // Sem repositório no browser não há commit para listar — recusa honesta,
      // nunca um histórico inventado que o dono leria como trabalho real.
      commits: async () => ({ ok: false, error: 'sem worktree no preview' }),
      // E o patch por commit segue a mesma regra: o preview não possui uma
      // autoridade Git para provar SHA, então nunca fabrica um diff.
      commitDiff: async () => ({ ok: false, error: 'sem worktree no preview' }),
      onChanged: () => () => undefined
    },
    files: {
      listTree: async (): Promise<FileTreeResult> => ({
        entries: [
          { path: 'src', name: 'src', kind: 'directory', depth: 0 },
          { path: 'src/App.tsx', name: 'App.tsx', kind: 'file', depth: 1, size: 2400, mtime: Date.now(), previewKind: 'code' },
          { path: 'docs', name: 'docs', kind: 'directory', depth: 0 },
          { path: 'docs/PLANO.md', name: 'PLANO.md', kind: 'file', depth: 1, size: 9000, mtime: Date.now() - 86_400_000, previewKind: 'markdown' },
          { path: 'README.md', name: 'README.md', kind: 'file', depth: 0, size: 1200, mtime: Date.now() - 3 * 86_400_000, previewKind: 'markdown' }
        ],
        truncated: false,
        skipped: 0
      }),
      preview: async (_projectId: string, _root: unknown, relativePath: string): Promise<FilePreviewResult> => ({
        ok: true,
        path: relativePath,
        name: relativePath.split('/').at(-1) ?? relativePath,
        size: 420,
        mtime: Date.now(),
        kind: relativePath.endsWith('.md') ? 'markdown' : 'code',
        content: relativePath.endsWith('.md')
          ? `# ${relativePath}\n\nConteúdo **mockado** do preview somente leitura.`
          : `const preview = true\nexport default preview\n`
      }),
      listDocs: async () => [
        { path: '.synkora/CONTEXT.md', name: 'CONTEXT.md', group: 'synkora', mtime: Date.now(), size: 4200 },
        { path: 'docs/PLANO.md', name: 'PLANO.md', group: 'docs', mtime: Date.now() - 86_400_000, size: 9000 },
        { path: 'README.md', name: 'README.md', group: 'projeto', mtime: Date.now() - 3 * 86_400_000, size: 1200 }
      ],
      readDoc: async (_projectId: string, relPath: string) => ({
        content: `# ${relPath}\n\nConteúdo **mockado** do viewer.\n\n- item 1\n- item 2\n\n\`\`\`ts\nconst ok = true\n\`\`\``,
        mtime: Date.now()
      }),
      terminalLinks: async (_projectId, _paneId, text) => {
        const links: Array<{ start: number; length: number; text: string }> = []
        const known = /\.synkora[\\/]CONTEXT\.md|docs[\\/]PLANO\.md|README\.md/gu
        let match: RegExpExecArray | null
        while ((match = known.exec(text))) {
          links.push({ start: match.index, length: match[0].length, text: match[0] })
        }
        return links
      },
      openTerminalFile: async (_projectId, paneId, candidate) => {
        const path = candidate.replace(/\\/g, '/')
        if (!['.synkora/CONTEXT.md', 'docs/PLANO.md', 'README.md'].includes(path)) {
          return { ok: false as const, error: 'arquivo indisponível no mock' }
        }
        return {
          ok: true as const,
          action: 'markdown' as const,
          paneId,
          root: 'project' as const,
          path,
          name: path.split('/').at(-1) ?? path,
          displayPath: candidate
        }
      },
      readTerminalDoc: async (_projectId, _paneId, _root, relPath) => ({
        content: `# ${relPath}\n\nArquivo aberto a partir do terminal (mock).`,
        mtime: Date.now()
      }),
      onNavigate: () => () => undefined
    },
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
      },
      setPhoto: async (id: string) => projects.find((p) => p.id === id) ?? null,
      removePhoto: async (id: string) => projects.find((p) => p.id === id) ?? null,
      rename: async (id: string, name: string) => {
        const p = projects.find((x) => x.id === id)
        if (p) p.name = name
        return p ?? null
      },
      relocate: async (id: string) => ({
        ok: true,
        project: projects.find((p) => p.id === id)
      }),
      // 2.0: mesma honestidade do chat da missão — sem CLI no preview, a
      // sessão de planejamento recusa em vez de simular conversa.
      planningGuiSpec: async () => ({ ok: false, error: 'sem sessão de chat no preview' }),
      onFlowChanged: () => () => undefined
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
      rename: async (id: string, name: string) => {
        const s = seats.find((x) => x.id === id)
        if (s) s.name = name
      },
      remove: async (id: string) => {
        const i = seats.findIndex((s) => s.id === id)
        if (i >= 0) seats.splice(i, 1)
      },
      usage: async () => ({
        at: Date.now(),
        account: 'erick@example.com',
        plan: 'MAX',
        meters: [
          { label: 'sessão', pct: 23, mode: 'used' as const, severity: 0.23, reset: '14:00' },
          {
            label: 'semana (geral)',
            pct: 41,
            mode: 'used' as const,
            severity: 0.41,
            reset: '25/07 09:00'
          }
        ],
        lines: []
      }),
      onChanged: () => () => undefined
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
      // F5.7 — plano da missão: o mock só troca o status/lanes localmente.
      approvePlan: async (id: string, lanes) => {
        const t = tasks.find((x) => x.id === id)
        if (t && t.kind === 'plan' && t.plan) {
          t.plan = { ...t.plan, lanes, approvedAt: new Date().toISOString() }
          t.status = 'execucao'
          t.updatedAt = new Date().toISOString()
        }
        return t
      },
      stopPlan: async (id: string) => {
        const t = tasks.find((x) => x.id === id)
        if (t && t.kind === 'plan' && t.status === 'execucao') {
          t.status = 'backlog'
          t.updatedAt = new Date().toISOString()
        }
        return t
      },
      resolvePlanSecurityValidation: async (
        id: string,
        decision: 'approved' | 'waived',
        evidence: string
      ) => {
        const t = tasks.find((x) => x.id === id)
        if (t?.plan?.manualSecurityValidationRequired) {
          const workTasks = tasks.filter(
            (candidate) =>
              candidate.missionId === t.missionId &&
              candidate.kind !== 'plan' &&
              (candidate.planId === t.id || (!candidate.planId && !t.plan?.executionMode))
          )
          if (
            t.status !== 'execucao' ||
            workTasks.length === 0 ||
            workTasks.some((candidate) => candidate.status !== 'done') ||
            (t.plan.expectedCards !== undefined && workTasks.length < t.plan.expectedCards)
          ) {
            throw new Error(
              'A validação fica disponível depois que todos os cards previstos estiverem concluídos.'
            )
          }
          t.plan = {
            ...t.plan,
            manualSecurityValidation: {
              required: true,
              status: decision,
              actor: 'user',
              resolvedAt: new Date().toISOString(),
              evidence
            }
          }
          t.updatedAt = new Date().toISOString()
        }
        return t
      },
      onPaneOpen: () => () => undefined,
      onPaneClose: () => () => undefined,
      onPaneCloseById: () => () => undefined,
      onAttention: () => () => undefined,
      // Troca de conta de fase exige PTY/worktree reais — não existe no preview.
      setPhaseSeat: async () => ({
        ok: false,
        msg: 'preview do browser: sem panes reais para trocar de conta'
      })
    },
    panes: {
      // Browser preview não mantém PTYs fora do renderer.
      live: async () => [],
      // Spec plausível (o app RECUSA abrir agente livre com spec nula — sem
      // armamento ele viraria um CLI cru na branch base); no preview o pane só
      // imprime o aviso do mock.
      freeSpec: async (projectId: string, seatId: string, _effort?: string, model?: string) => {
        const paneId = `free-${seatId}-${Math.random().toString(16).slice(2, 8)}`
        openFreeCb?.(projectId, 'claude', { id: paneId, seatId, model })
        return {
          paneId,
          cliArgs: [],
          appendSystemPrompt: '(persona do agente livre — mock)'
        }
      },
      testServerSpec: async (
        projectId: string,
        target: { missionId?: string; versionId?: string },
        port?: number
      ) => {
        const paneId = `testsrv-${Math.random().toString(16).slice(2, 8)}`
        openFreeCb?.(projectId, 'shell', {
          id: paneId,
          title: '▶ teste (mock)',
          cwd: 'C:\\mock\\worktree',
          missionId: target.missionId,
          versionId: target.versionId,
          testServer: true
        })
        return {
          ok: true,
          paneId,
          cwd: 'C:\\mock\\worktree',
          command: `npm run dev${port ? ` -- --port ${port}` : ''}`,
          title: '▶ teste (mock)'
        }
      },
      portsInUse: async (_projectId: string) =>
        '5174 = QA do card "tela de exemplo" · 2057 (pedida) = servidor de teste do dono',
      // F3-c3: no app real o registro do pane chega por evento do main — o
      // mock dispara o callback ao resolver a spec (senão o preview não abre
      // pane nenhum).
      onOpenFree: (cb) => {
        openFreeCb = cb
        return () => {
          openFreeCb = null
        }
      },
      requestClose: () => undefined
    },
    // Fase 3: no browser não há WebContentsView — layout/estado são no-op e a
    // view (?view=panes no preview) nunca recebe push do host.
    panesView: {
      layout: () => undefined,
      state: () => undefined,
      onState: () => () => undefined,
      onShown: () => () => undefined,
      guiEscape: () => undefined,
      onGuiEscape: () => () => undefined,
      navigateHost: () => undefined,
      reportActivity: () => undefined,
      reportAttentionCleared: () => undefined,
      onNavigateHost: () => () => undefined,
      onActivity: () => () => undefined,
      onAttentionCleared: () => () => undefined,
      reportVoiceFocus: () => undefined,
      voiceTarget: async () => null,
      voicePaste: () => undefined,
      onVoicePaste: () => () => undefined,
      // 2026-08-11: sem WebContentsView no browser — captura sempre falha
      // (o App cai no fallback de esconder sem congelado) e tooltip nunca é
      // roteado (panesViewVisibleRect devolve null sem anchor de view).
      capture: async () => null,
      tipShow: () => undefined,
      tipHide: () => undefined,
      onTip: () => () => undefined
    },
    maestro: {
      pendingQuestions: async () => [],
      questionSeen: async () => true,
      onUserQuestion: () => () => undefined,
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
        bypass: true,
        sensitiveBypassOk: false,
        seatId: 's1',
        version: 'v0.1'
      }),
      setSeat: async () => undefined,
      getReviewer: async () => ({ seatId: null, model: null, effort: null }),
      setReviewer: async () => undefined,
      paneSpec: async () => null,
      setVersion: async () => undefined,
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
      cleanup: async () => '🧹 0 arquivo(s) sem uso removido(s) do .synkora (mock)',
      setModel: async (_projectId: string, model: string) => {
        maestroCb?.({ kind: 'ok', text: `modelo do maestro: ${model}` })
      }
    },
    perf: {
      reportStall: () => undefined
    },
    harness: {
      setBypass: async () => undefined,
      setSensitiveBypass: async () => undefined
    },
    // Pane GUI (docs/GUI_PANE_CONTRACT.md): no preview de browser não há CLI —
    // as chamadas respondem ok e nenhum evento vivo chega.
    gui: {
      create: async () => ({ ok: true }),
      configureExecutor: async (_paneId, patch) => ({
        ok: true,
        model: patch.model ?? null,
        effort: patch.effort ?? null
      }),
      send: async () => ({ ok: true }),
      deliverQueued: async () => ({ ok: true }),
      permission: async () => ({ ok: true }),
      answerQuestion: async () => ({ ok: true }),
      answerPlan: async () => ({ ok: true }),
      interrupt: async () => ({ ok: true }),
      kill: async () => ({ ok: true }),
      state: async () => ({ events: [], cursor: 0, exists: false, alive: false }),
      workspaceFiles: async () => ({ ok: false, error: 'arquivos só funcionam no app' }),
      onLive: () => () => undefined,
      visibility: () => undefined,
      presented: () => undefined,
      onAlert: () => () => undefined,
      // Anexo no browser puro não tem disco nem pane vivo: recusa honesta com
      // o mesmo texto de UI do main (nunca um path falso que o prompt citaria).
      attach: async () => ({ ok: false, error: 'anexos só funcionam no app' }),
      attachFolder: async () => ({ ok: false, error: 'anexos só funcionam no app' })
    },
    projectPlan: {
      get: async () => null,
      approve: async () => 'mock: roadmap aprovado pelo usuário',
      startMission: async (_projectId, itemId) => `mock: missão ${itemId} aberta pelo usuário`
    },
    hub: {
      onEvent: () => () => undefined,
      onCommunication: () => () => undefined
    },
    policies: {
      get: async () => ({}),
      set: async () => undefined,
      onChanged: () => () => undefined
    },
    catalog: {
      get: async (cli: 'claude' | 'codex') =>
        cli === 'claude'
          ? {
              models: [
                { id: 'fable', label: 'fable — o mais capaz' },
                { id: 'opus[1m]', label: 'opus — equilíbrio do dia a dia (1M ctx)' },
                { id: 'sonnet', label: 'sonnet — eficiente para rotina' },
                { id: 'haiku', label: 'haiku — o mais rápido' }
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
    cli: {
      status: async () => [
        { cli: 'claude' as const, version: '2.1.219', state: 'current' as const, checkedAt: 0 },
        { cli: 'codex' as const, version: '0.145.0', state: 'current' as const, checkedAt: 0 }
      ],
      update: async () => [
        { cli: 'claude' as const, version: '2.1.219', state: 'current' as const, checkedAt: 0 },
        { cli: 'codex' as const, version: '0.145.0', state: 'current' as const, checkedAt: 0 }
      ],
      onStatus: () => () => undefined
    },
    // usage mock: barras de exemplo p/ ver o tooltip no browser
    settings: {
        get: async () => ({ ...appSettings }),
        set: async (patch) => {
          appSettings = { ...appSettings, ...patch }
          return { ...appSettings }
        },
        onChanged: () => () => undefined,
        setSecret: async (name, _value) => {
          const masked = '••••••••'
          appSettings = name === 'openrouterKey'
            ? { ...appSettings, openrouterKeyConfigured: true, openrouterKeyMasked: masked }
            : { ...appSettings, githubTokenConfigured: true, githubTokenMasked: masked }
          return { ...appSettings }
        },
        clearSecret: async (name) => {
          if (name === 'openrouterKey') {
            const { openrouterKeyMasked: _masked, ...next } = appSettings
            appSettings = { ...next, openrouterKeyConfigured: false }
          } else {
            const { githubTokenMasked: _masked, ...next } = appSettings
            appSettings = { ...next, githubTokenConfigured: false }
          }
          return { ...appSettings }
        }
      },
    services: {
      get: async () => servicesSnapshot(),
      restart: async () => servicesSnapshot()
    },
    progress: {
      ready: () => undefined,
      openOverlay: async () => undefined,
      getSnapshot: async () => ({
        revision: 1,
        generatedAt: new Date().toISOString(),
        totals: {
          projects: projects.length,
          activeProjects: 1,
          activeMissions: 2,
          activeCards: 1,
          activeCoordinators: 1,
          attentionMissions: 1,
          attentionProjects: 0,
          recentCompletions: 0
        },
        projects: []
      }),
      onSnapshot: () => () => undefined,
      onOpenTarget: () => () => undefined
    },
    voice: {
      getConfig: async () => voiceConfig(),
      setProvider: async (provider) => {
        voiceProvider = provider
        return voiceConfig()
      },
      setModel: async (provider, model) => {
        voiceSelectedModel[provider] = model
        return voiceConfig()
      },
      setCustomVocabulary: async (terms) => {
        voiceCustomVocabulary = [...terms]
        return voiceConfig()
      },
      listModels: async (provider) => voiceModelCatalog[provider],
      setApiKey: async (provider, key) => {
        voiceConfigured[provider] = Boolean(key)
        return voiceConfig()
      },
      openApiKeys: async () => undefined,
      transcribe: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 900))
        if (voiceCancelled.delete(request.requestId)) throw new Error('Transcrição cancelada.')
        return {
          text: 'Crie uma nova tarefa no Synkora e envie para o painel do Maestro.',
          languages: ['pt'],
          model: voiceConfig().model
        }
      },
      cancel: (requestId) => {
        voiceCancelled.add(requestId)
      },
      history: async () => [],
      historyCopy: async () => false,
      captureExternalTarget: async () => null,
      discardExternalTarget: () => undefined,
      openOverlay: async () => undefined,
      isOverlayDetached: async () => false,
      publishOverlayState: () => undefined,
      onOverlayCommand: () => () => undefined,
      onOverlayVisibility: () => () => undefined,
      setGlobalActivation: () => undefined,
      onGlobalActivation: () => () => undefined,
      showNotice: () => undefined
    },
    pathForFile: () => '',
    attachments: {
      import: async () => []
    },
    clipboard: {
      hasImage: () => false,
      saveImage: async () => null,
      readText: async () => ''
    },
    host: { platform: 'win32', windowsBuild: 26200 },
    pickFolder: async () => 'C:\\dev\\novo-projeto',
    pty: {
      create: async (opts: { id: string }) => {
        const id = opts.id
        setTimeout(() => {
          dataCb?.(
            id,
            '\x1b[38;5;111m✦ Synkora\x1b[0m · preview de UI no browser\r\n' +
              '\x1b[90mTerminais reais só rodam dentro do Electron (npm run dev).\x1b[0m\r\n' +
              '\x1b[90m中 🧪 Arquivo de exemplo: \x1b[0mdocs\\PLANO.md\r\n'
          )
        }, 80)
        return true
      },
      write: () => undefined,
      resize: () => undefined,
    kill: () => undefined,
    markStartupRequest: () => undefined,
    markFirstFrame: () => undefined,
      onData: (cb) => {
        dataCb = cb
        return () => {
          dataCb = null
        }
      },
      onExit: () => () => undefined,
      onReset: () => () => undefined,
      onLastLines: () => () => undefined,
      onStats: () => () => undefined,
      onEffort: () => () => undefined,
      onModel: () => () => undefined
    }
  }

  window.synkora = api
}
