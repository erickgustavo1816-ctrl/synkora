import type {
  Mission,
  ProgressOverlaySnapshot,
  Seat,
  SkillsKitState,
  SkillsLibraryItem,
  SynVoiceConfig,
  SynVoiceModel,
  SynVoiceOverlayState,
  SynVoiceProvider,
  SynkoraApi,
  SynkoraSettings,
  FilePreviewResult,
  FileTreeResult
} from '../../preload/index'

/**
 * Skills no preview de browser: um retrato REPRESENTATIVO do seed v3 (a lei
 * fixa, as duas alas, o kit de planejamento) + biblioteca com os três estados
 * que a tela desenha (no kit, fora do kit — alvo da poda — e com BOM), com
 * mutações vivas em memória para o toggle/adicionar/remover responderem no
 * preview. Sem rede e sem disco: instalar recusa com a verdade.
 *
 * Só ids do kit v3 aparecem aqui: retrato com id que a biblioteca não tem mais
 * ensina a tela errada a quem for olhar o preview.
 */
function skillsMock(): SynkoraApi['skills'] {
  const kit: SkillsKitState = {
    version: 1,
    dev: {
      execucao: [
        { id: 'impeccable', occasion: 'mexer em UI (a lei da persona)', enabled: true, law: true },
        {
          id: 'synkora-design-system-standard',
          occasion: 'criar/evoluir design system',
          enabled: true
        },
        { id: 'synkora-investigacao', occasion: 'investigar antes de mexer', enabled: true },
        { id: 'test-driven-development', occasion: 'código novo com teste', enabled: true },
        { id: 'systematic-debugging', occasion: 'caçar um bug', enabled: false }
      ],
      orquestracao: [
        { id: 'writing-plans', occasion: 'destrinchar/planejar a frota', enabled: true }
      ]
    },
    planejamento: [
      { id: 'grilling', occasion: 'estressar uma proposta', enabled: true },
      { id: 'grill-with-docs', occasion: 'entrevista que escreve docs/ADRs', enabled: true },
      { id: 'writing-plans', occasion: 'escrever o plano', enabled: true }
    ]
  }
  const library: SkillsLibraryItem[] = [
    { id: 'grill-with-docs', description: 'A mesma entrevista, escrevendo ADRs e glossário no caminho.', hasBom: false, inKit: true },
    { id: 'grilling', description: 'Interrogatório por rodadas até a árvore de decisão fechar.', hasBom: false, inKit: true },
    { id: 'impeccable', description: 'Design-ops: 23 comandos e 60 detectores determinísticos de polish.', hasBom: false, inKit: true },
    { id: 'old-era-skill', description: 'Sobra da era F6 sem slot em kit nenhum — alvo da poda.', hasBom: false, inKit: false },
    { id: 'quirky-bom-skill', description: 'Exemplo com BOM no SKILL.md para a tela avisar.', hasBom: true, inKit: false },
    { id: 'synkora-design-system-standard', description: 'Método da casa: tokens semânticos, componentes, specimen e governança.', hasBom: false, inKit: true },
    { id: 'synkora-investigacao', description: 'Investigar antes de mexer: mapa do terreno, sinal estrutural.', hasBom: false, inKit: true },
    { id: 'systematic-debugging', description: 'Quatro fases; proíbe guess-and-check.', hasBom: false, inKit: true },
    { id: 'test-driven-development', description: 'Se não viu o teste falhar, não sabe o que ele testa.', hasBom: false, inKit: true },
    { id: 'writing-plans', description: 'Fatiar trabalho em planos executáveis, para a frota ou para si.', hasBom: false, inKit: true }
  ]
  const clone = (): SkillsKitState => JSON.parse(JSON.stringify(kit)) as SkillsKitState
  const lists = (): Array<{ chat: 'dev' | 'planejamento'; slots: SkillsKitState['planejamento'] }> => [
    { chat: 'dev', slots: kit.dev.execucao },
    { chat: 'dev', slots: kit.dev.orquestracao },
    { chat: 'planejamento', slots: kit.planejamento }
  ]
  return {
    list: async () => ({ library, kit: clone() }),
    setEnabled: async (chat, id, enabled) => {
      for (const list of lists()) {
        if (list.chat !== chat) continue
        const slot = list.slots.find((candidate) => candidate.id === id)
        if (slot && !slot.law) slot.enabled = enabled
      }
      return clone()
    },
    addToKit: async (chat, id, occasion, wing) => {
      const target =
        chat === 'dev'
          ? wing === 'orquestracao'
            ? kit.dev.orquestracao
            : kit.dev.execucao
          : kit.planejamento
      if (!target.some((slot) => slot.id === id)) target.push({ id, occasion, enabled: true })
      const row = library.find((entry) => entry.id === id)
      if (row) row.inKit = true
      return clone()
    },
    removeFromKit: async (chat, id) => {
      for (const list of lists()) {
        if (list.chat !== chat) continue
        const index = list.slots.findIndex((slot) => slot.id === id && !slot.law)
        if (index >= 0) list.slots.splice(index, 1)
      }
      const stillCited = lists().some((list) => list.slots.some((slot) => slot.id === id))
      const row = library.find((entry) => entry.id === id)
      if (row) row.inKit = stillCited
      return clone()
    },
    installFromUrl: async () => ({ ok: false, error: 'preview: sem rede no browser' }),
    prune: async () => ({ ok: false, error: 'preview: sem biblioteca no browser' })
  }
}

/** A verdade do preview para o painel de browser: aqui não há Electron, então
 *  não há `WebContentsView` para compor por cima do retângulo. */
const BROWSER_PREVIEW_REFUSAL = 'preview: sem browser no browser'

/** A mesma verdade como NOTA do motor, com carimbo FIXO: o painel compara a
 *  nota por `at`, e um relógio novo a cada leitura repintaria o dock à toa. */
const BROWSER_PREVIEW_NOTICE = {
  kind: 'load-failed',
  text: BROWSER_PREVIEW_REFUSAL,
  at: '2026-08-29T12:00:00.000Z'
}

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
              roleLabel: 'agente',
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
            },
            {
              id: 'mission-queue',
              projectId: 'mock-2',
              title: 'Melhorar integração paralela',
              state: 'blocked',
              tone: 'attention',
              label: 'integração bloqueada',
              detail: 'a decisão de como resolver o conflito está pendente',
              updatedAt: new Date(Date.now() - 90_000).toISOString(),
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
              roleLabel: 'agente',
              label: 'acompanhando o projeto e suas missões',
              tone: 'running',
              updatedAt: new Date().toISOString()
            }
          ],
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
          updatedAt: new Date(Date.now() - index * 12_000).toISOString()
        }
      })
      snapshot = {
        revision: 3,
        generatedAt: new Date().toISOString(),
        totals: {
          projects: 1,
          activeProjects: 1,
          activeMissions: activeMissions.length,
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
          recentCompletions
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
    externalServicePreparation: 'automatic',
    terminalFontSize: 13,
    terminalLineHeight: 1.25,
    terminalFontFamily: 'Cascadia Code',
    chatNotifyNeedsYou: true,
    chatNotifyFinished: true,
    chatNotifyFailed: true,
    chatSoundsEnabled: true
  }

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
  // F3-c3: simula o broadcast panes:open-free do main no preview de browser.
  let openFreeCb:
    | ((projectId: string, kind: string, opts: Record<string, unknown>) => void)
    | null = null

  // As fixtures de CARD (tasks + makeTasks) morreram na purga F6
  // (2026-08-17): a missão 2.0 não tem card.

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
    blackbox: {
      exportDiagnostics: async () => ({ ok: false, msg: 'preview: sem diagnóstico no browser' }),
      // preview de browser nao tem diario: o recibo cai no vazio, sem quebrar
      noteOrphanedTool: () => {}
    },
    backlog: {
      listVersions: async () => [],
      versionReleases: async () => [],
      projectReleases: async () => [],
      createVersion: async () => ({ ok: false, error: 'preview: sem backlog no browser' }),
      removeVersion: async () => 'mock: versão removida',
      releaseChat: async () => ({ ok: false as const, error: 'preview: sem release no browser' }),
      releaseVersion: async () => 'mock: sem git no preview',
      listItems: async () => [],
      updateItem: async () => null,
      removeItem: async () => undefined,
      onChanged: () => () => undefined
    },
    skills: skillsMock(),
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
      workspaceFileDiff: async () => ({ ok: false, error: 'sem worktree no preview' }),
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
      // Abrir FORA do app depende do `shell` do Electron: no preview de browser
      // não há programa padrão nem pasta para mostrar. Recusa honesta que nomeia
      // a saída — nunca um "abriu" que não abriu nada (rodada 7, C1).
      openExternal: async () => ({
        ok: false as const,
        error: 'abrir fora do app só dentro do Synkora — o preview de browser não tem shell'
      }),
      tree: async () => ({
        ok: true,
        truncated: false,
        entries: [
          {
            path: 'src',
            parentPath: '',
            name: 'src',
            kind: 'directory' as const,
            depth: 1,
            size: 0,
            mtime: Date.now()
          },
          {
            path: 'src/App.tsx',
            parentPath: 'src',
            name: 'App.tsx',
            kind: 'file' as const,
            depth: 2,
            size: 2_400,
            mtime: Date.now()
          },
          {
            path: 'docs/PLANO.md',
            parentPath: 'docs',
            name: 'PLANO.md',
            kind: 'file' as const,
            depth: 2,
            size: 9_000,
            mtime: Date.now() - 86_400_000
          },
          {
            path: 'docs',
            parentPath: '',
            name: 'docs',
            kind: 'directory' as const,
            depth: 1,
            size: 0,
            mtime: Date.now()
          }
        ]
      }),
      createFile: async (_scope, parentPath, name) => ({
        ok: true,
        path: parentPath ? `${parentPath}/${name}` : name
      }),
      createFolder: async (_scope, parentPath, name) => ({
        ok: true,
        path: parentPath ? `${parentPath}/${name}` : name
      }),
      rename: async (_scope, relativePath, name) => ({
        ok: true,
        previousPath: relativePath,
        path: relativePath.includes('/')
          ? `${relativePath.slice(0, relativePath.lastIndexOf('/'))}/${name}`
          : name
      }),
      trash: async (_scope, relativePath) => ({ ok: true, previousPath: relativePath }),
      copyPath: async (_scope, relativePath) => ({ ok: true, path: relativePath }),
      downloadZip: async (_scope, relativePath) => ({
        ok: true,
        path: relativePath,
        savedName: `${relativePath.split('/').at(-1) ?? 'pasta'}.zip`,
        archive: { files: 2, bytes: 10_200 }
      }),
      onChanged: () => () => undefined,
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
      // R25.2 — no preview não existe poller, então o cache está SEMPRE frio:
      // `null` é a resposta honesta, e o painel do chat some com a linha da
      // cota em vez de mostrar um número inventado.
      usagePeek: async () => null,
      onChanged: () => () => undefined
    },
    // O namespace `tasks` (espelho do pipeline de cards) morreu na purga F6
    // (2026-08-17), junto com o pipeline.
    panes: {
      // Browser preview não mantém PTYs fora do renderer.
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
      requestClose: () => undefined,
      // R11: o preview não tem main para ecoar fecho — ouvinte inerte.
      onCloseById: () => () => undefined
    },
    // O namespace `maestro` (chat do PM + ask_user) morreu na purga F6.
    perf: {
      reportStall: () => undefined
    },
    // O namespace `harness` (bypass do universo) morreu na purga F6: a
    // permissão da era 2.0 é por CONVERSA.
    history: {
      search: async (input) => ({
        ok: true,
        requestId: input.requestId,
        hits: [],
        cancelled: false,
        truncated: false,
        scannedFiles: 0,
        scannedBytes: 0
      }),
      cancel: () => undefined,
      load: async (selectionId) => ({
        ok: false,
        selectionId,
        error: 'o preview do navegador não tem históricos locais'
      }),
      // R24.2: a recusa nomeia a receita mesmo no mock — o preview não tem
      // disco de CLI para ler, e dizer isso é melhor que um overlay vazio.
      loadForPane: async (paneId) => ({
        ok: false,
        paneId,
        error: 'o preview do navegador não tem históricos locais — abra a conversa no app'
      })
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
      // Padrão dos ajudantes (D8): sem main não há documento por pane, então a
      // leitura é VAZIA ("herdado da conversa", que é a verdade) e a escrita
      // recusa em vez de fingir um pino que ninguém gravou.
      delegationDefaults: async () => ({}),
      setDelegationDefaults: async () => ({
        ok: false,
        error: 'o padrão dos ajudantes só funciona no app'
      }),
      send: async () => ({ ok: true }),
      deliverQueued: async () => ({ ok: true }),
      permission: async () => ({ ok: true }),
      answerQuestion: async () => ({ ok: true }),
      answerPlan: async () => ({ ok: true }),
      // BLOCO NOVO (2.0, onda D): sem main não existe rascunho guardado, então
      // a decisão do card recusa em vez de fingir que criou um plano.
      answerPlanProposal: async () => ({ ok: false, error: 'planos só funcionam no app' }),
      // O ✕ da frota (R27F3): sem main não existe motor de ajudantes, então a
      // recusa é honesta — fingir "descartei" tiraria da tela uma ficha que
      // continua inteira do outro lado.
      dismissHelper: async () => ({
        ok: false,
        error: 'descartar ajudante só funciona no app'
      }),
      interrupt: async () => ({ ok: true }),
      kill: async () => ({ ok: true }),
      state: async () => ({ events: [], cursor: 0, exists: false, alive: false }),
      workspaceFiles: async () => ({ ok: false, error: 'arquivos só funcionam no app' }),
      fileOpen: async () => ({
        ok: false,
        reason: 'unavailable',
        error: 'arquivos do chat só abrem no app'
      }),
      fileOpenExternal: async () => ({
        ok: false,
        reason: 'unavailable',
        error: 'abrir arquivo fora do app só funciona no app'
      }),
      // R36: sem main não há disco para ler os bytes da imagem citada. Recusa
      // com receita — no chat ela vira a linha que NOMEIA o caminho, que é
      // justamente o oposto do sumiço mudo que o CSP causava.
      fileImageData: async () => ({
        ok: false,
        error: 'imagens do chat só aparecem no app'
      }),
      onLive: () => () => undefined,
      visibility: () => undefined,
      presented: () => undefined,
      onAlert: () => () => undefined,
      // Anexo no browser puro não tem disco nem pane vivo: recusa honesta com
      // o mesmo texto de UI do main (nunca um path falso que o prompt citaria).
      attach: async () => ({ ok: false, error: 'anexos só funcionam no app' }),
      attachFolder: async () => ({ ok: false, error: 'anexos só funcionam no app' }),
      attachmentPreview: async () => ({ ok: false, error: 'prévias só funcionam no app' }),
      attachmentAction: async () => ({ ok: false, error: 'anexos só funcionam no app' })
    },
    // ————— BLOCO NOVO (2.0, onda D): planos do universo —————
    // Sem main não há store: a leitura é vazia e toda mutação RECUSA com a
    // mesma honestidade dos outros mocks — nunca finge que gravou.
    plans: {
      list: async () => [],
      create: async () => ({ ok: false, error: 'planos só funcionam no app' }),
      update: async () => ({ ok: false, error: 'planos só funcionam no app' }),
      setKind: async () => ({ ok: false, error: 'planos só funcionam no app' }),
      archive: async () => ({ ok: false, error: 'planos só funcionam no app' }),
      remove: async () => ({ ok: false, error: 'planos só funcionam no app' }),
      linkMission: async () => ({ ok: false, error: 'planos só funcionam no app' }),
      onChanged: () => () => undefined
    },
    // ————— fim do BLOCO NOVO —————
    // ————— BLOCO NOVO (2026-08-29): o browser embutido —————
    // A página do painel é uma `WebContentsView` do Electron: no preview de
    // browser ela simplesmente NÃO EXISTE. O mock conta isso — estado fechado
    // (o convite "abrir browser" aparece, que é justamente o estado que se vem
    // conferir aqui) e recusa honesta em cada alavanca. `bounds` engole o
    // report sem ruído: medir é o certo mesmo sem motor do outro lado.
    browser: {
      state: async () => ({
        alive: false,
        agentDriving: false,
        tabs: [],
        notice: BROWSER_PREVIEW_NOTICE
      }),
      navigate: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      back: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      forward: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      reload: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      newTab: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      closeTab: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      selectTab: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      devtools: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      // ⧉ e o reencaixe (pop-out, 2026-08-29): destacar é abrir uma
      // `BrowserWindow` de verdade — no preview de browser não há nenhuma, e a
      // recusa é a mesma das outras alavancas.
      popOut: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      dockBack: async () => ({ ok: false, error: BROWSER_PREVIEW_REFUSAL }),
      bounds: () => undefined,
      onChanged: () => () => undefined
    },
    // ————— fim do BLOCO NOVO do browser —————
    hub: {
      onEvent: () => () => undefined,
      onCommunication: () => () => undefined
    },
    // O namespace `policies` (modelos por função) morreu na purga F6.
    catalog: {
      // `supportsFastMode` espelha a sonda real (R13): só o opus e o sol têm o
      // modo — é o que faz o ⚡ do painel de padrões aparecer para uns e sumir
      // para outros aqui no browser, sem CLI nenhum instalado.
      get: async (cli: 'claude' | 'codex') =>
        cli === 'claude'
          ? {
              models: [
                { id: 'fable', label: 'fable — o mais capaz' },
                {
                  id: 'opus[1m]',
                  label: 'opus — equilíbrio do dia a dia (1M ctx)',
                  supportsFastMode: true
                },
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
                  defaultEffort: 'low',
                  supportsFastMode: true
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
          text: 'Crie uma nova missão no Synkora e converse com o agente dela.',
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
