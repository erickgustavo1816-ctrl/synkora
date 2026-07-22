import { spawn } from 'child_process'
import { freshWindowsPath } from './winPath'
import type { Department, NewTask } from './tasks'

export interface MaestroEvent {
  kind: 'cmd' | 'log' | 'ok' | 'err' | 'say' | 'tool' | 'out' | 'ask'
  tag?: Department | 'maestro'
  text: string
  /** tool: input real (JSON) para expandir na UI · ask: input do pedido de permissão */
  detail?: string
}

export interface RunOptions {
  stdin: string
  cwd: string
  configDir?: string
  sessionId?: string
  model?: string
  effort?: string
  maxTurns?: number
  announceInit: boolean
  /** recebe um kill() para o ⏹ parar conseguir abortar o run */
  registerKill?: (kill: () => void) => void
}

const VALID_DEPARTMENTS: Department[] = ['front', 'back', 'qa', 'design', 'research']

// Persona do Maestro. No Claude vai como prefixo da 1ª mensagem (--resume
// preserva depois); no Codex vai como developerInstructions do thread/start.
const PERSONA_CORE = `Você é o Maestro, o gerente de projeto (PM) deste universo de desenvolvimento agêntico chamado Synkora. Converse SEMPRE em PT-BR, direto, útil e humano, como um colega sênior. Você está dentro da pasta do projeto.

Você deve ser O MAIOR CONHECEDOR deste projeto:
- Se existir o arquivo .synkora/CONTEXT.md, leia-o ANTES da sua primeira resposta — ele é o seu dossiê do projeto.
- Quando precisar de mais contexto, leia os arquivos do repositório (Read/Glob/Grep) antes de responder.
- Se não existir .synkora/CONTEXT.md, sugira ao usuário rodar /estudar para você mapear o projeto.

Você ENXERGA o board e as execuções em tempo real:
- .synkora/BOARD.md = estado atual do board (tarefas por status e quais têm executor ativo). Sempre que perguntarem sobre andamento/status de tarefas, leia este arquivo PRIMEIRO — nunca presuma nem saia fuçando à toa.
- .synkora/runs/<taskId>.md = transcript COMPLETO de cada execução de tarefa (cada ferramenta usada, saídas, resultado final). Para saber o que um executor fez ou está fazendo, leia o transcript da tarefa.

Regras de comportamento:
- Saudações, dúvidas e conversas recebem respostas normais e curtas. NUNCA crie tarefas nesses casos.
- Só crie tarefas quando o usuário pedir explicitamente uma feature ou trabalho concreto.
- Se o pedido for vago, faça 1 a 3 perguntas de esclarecimento ANTES de criar qualquer tarefa.
- Quando (e somente quando) decidir criar tarefas, termine sua resposta com um bloco EXATAMENTE neste formato, sem cercas de código:
<tasks>{"tasks":[{"department":"front","type":"feature","effort":"leve","title":"...","description":"..."}]}</tasks>
- Departamentos válidos: "front" (UI), "back" (servidor/dados), "qa" (testes/validação), "design" (identidade visual, mockups, protótipos, imagens), "research" (pesquisa de mercado, tecnologia, referências, viabilidade).
- "type": "feature" (padrão) ou "bug". Bug relatado pelo usuário vira tarefa type "bug" no departamento certo, com passos de reprodução na descrição — e, se fizer sentido, uma tarefa de validação no qa.
- "effort": classifique o peso da tarefa com julgamento de tech lead. "pesada" = exige raciocínio profundo, arquitetura, muitos arquivos ou risco alto; "leve" = ajuste pontual, escopo pequeno e claro. Isso decide qual modelo executa a tarefa, então seja criterioso.
- Fase de planejamento sem código (pesquisar, definir identidade, prototipar) usa research e design.
- 1 a 8 tarefas, fatias verticais, título ≤60 caracteres, descrição de 2 a 4 frases terminando com critérios de aceite. Tudo em PT-BR.`

export const PERSONA = PERSONA_CORE + '\n\nMensagem do usuário:\n'

/** Persona para developerInstructions (Codex app-server) — sem o sufixo de prefixo. */
export const PERSONA_DEV = PERSONA_CORE

export const SURVEY_PROMPT = `Explore este repositório AGORA usando as ferramentas disponíveis (Read, Glob, Grep): leia README, CLAUDE.md, manifests (package.json ou equivalentes), a estrutura de pastas e os arquivos-chave de cada módulo.

Depois produza um BRIEF completo do projeto em markdown, em PT-BR, com estas seções:
# Contexto do Projeto (gerado pelo Maestro)
## Visão geral  ## Stack e dependências  ## Estrutura de pastas  ## Módulos principais (o que cada um faz)  ## Convenções  ## Estado atual (o que já existe e funciona)  ## Pontos de atenção

Seja específico e factual — nomes reais de arquivos, funções e pastas. Responda APENAS com o markdown do brief, nada antes ou depois.`

export function toolLabel(name: string, input: Record<string, unknown>): string {
  const raw =
    name === 'Grep'
      ? input['pattern']
      : (input['file_path'] ?? input['path'] ?? input['pattern'] ?? input['command'] ?? '')
  const p = typeof raw === 'string' ? raw : ''
  const base =
    name === 'Bash' || name === 'PowerShell' ? p : p ? (p.split(/[\\/]/).pop() ?? p) : ''
  switch (name) {
    case 'Read':
      return `lendo ${base}`
    case 'Glob':
    case 'LS':
      return `explorando ${base || 'a estrutura'}`
    case 'Grep':
      return `buscando "${base}"`
    case 'Write':
      return `escrevendo ${base}`
    case 'Edit':
      return `editando ${base}`
    case 'Bash':
    case 'PowerShell':
      return `$ ${base.length > 80 ? base.slice(0, 80) + '…' : base}`
    case 'WebFetch':
      return `abrindo ${typeof input['url'] === 'string' ? input['url'] : 'url'}`
    case 'WebSearch':
      return `pesquisando "${typeof input['query'] === 'string' ? input['query'] : ''}"`
    default:
      return `${name.toLowerCase()}${base ? ` ${base}` : ''}`
  }
}

interface HeadlessResult {
  resultText: string
  sessionId?: string
  contextTokens?: number
}

function runHeadless(
  opts: RunOptions,
  onEvent: (evt: MaestroEvent) => void
): Promise<HeadlessResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: freshWindowsPath()
    }
    if (opts.configDir) env['CLAUDE_CONFIG_DIR'] = opts.configDir

    const args = ['-p', '--output-format', 'stream-json', '--verbose']
    if (opts.sessionId) args.push('--resume', opts.sessionId)
    if (opts.model) args.push('--model', opts.model)
    if (opts.effort) args.push('--effort', opts.effort)
    if (opts.maxTurns) args.push('--max-turns', String(opts.maxTurns))

    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env,
      shell: process.platform === 'win32'
    })

    let buffer = ''
    let err = ''
    let resultText = ''
    let sessionId: string | undefined
    let contextTokens: number | undefined
    let killedByUser = false
    opts.registerKill?.(() => {
      killedByUser = true
      child.kill()
    })

    function handleLine(line: string): void {
      if (!line.trim()) return
      try {
        const evt = JSON.parse(line) as {
          type?: string
          subtype?: string
          model?: string
          result?: string
          session_id?: string
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_creation_input_tokens?: number
            cache_read_input_tokens?: number
          }
          message?: { content?: { type?: string; name?: string; input?: Record<string, unknown> }[] }
        }
        if (evt.session_id) sessionId = evt.session_id
        if (evt.type === 'system' && evt.subtype === 'init' && opts.announceInit) {
          onEvent({ kind: 'log', tag: 'maestro', text: `sessão aberta · ${evt.model ?? 'claude'}` })
        } else if (evt.type === 'assistant') {
          // Mostra o Maestro trabalhando: cada ferramenta usada vira uma linha.
          for (const block of evt.message?.content ?? []) {
            if (block.type === 'tool_use' && block.name) {
              onEvent({ kind: 'log', tag: 'maestro', text: toolLabel(block.name, block.input ?? {}) })
            }
          }
        } else if (evt.type === 'result') {
          resultText = typeof evt.result === 'string' ? evt.result : ''
          // Contexto ≈ tudo que entrou + saiu no último turno (vira a base do próximo).
          const u = evt.usage
          if (u) {
            contextTokens =
              (u.input_tokens ?? 0) +
              (u.cache_read_input_tokens ?? 0) +
              (u.cache_creation_input_tokens ?? 0) +
              (u.output_tokens ?? 0)
          }
        }
      } catch {
        // linha parcial — ignora
      }
    }

    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) handleLine(line)
    })
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('tempo esgotado (10 min) aguardando o CLI'))
    }, 600_000)

    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (buffer) handleLine(buffer)
      if (killedByUser) {
        reject(new Error('⏹ interrompido pelo usuário'))
        return
      }
      if (!resultText) {
        reject(new Error(`exit ${code} · ${err.trim().slice(0, 300) || 'sem resposta do CLI'}`))
        return
      }
      resolve({ resultText, sessionId, contextTokens })
    })

    child.stdin.write(opts.stdin)
    child.stdin.end()
  })
}

export function parseTasks(raw: string): NewTask[] {
  try {
    const parsed = JSON.parse(raw) as { tasks?: unknown[] }
    return (parsed.tasks ?? [])
      .filter(
        (t): t is { department: Department; type?: string; title: string; description: string } =>
          typeof t === 'object' &&
          t !== null &&
          VALID_DEPARTMENTS.includes((t as { department: Department }).department) &&
          typeof (t as { title: unknown }).title === 'string' &&
          typeof (t as { description: unknown }).description === 'string'
      )
      .map((t) => ({
        department: t.department,
        title: t.title,
        description: t.description,
        type: (t as { type?: string }).type === 'bug' ? ('bug' as const) : ('feature' as const),
        effort:
          (t as { effort?: string }).effort === 'pesada'
            ? ('pesada' as const)
            : ('leve' as const),
        origin: 'maestro' as const
      }))
  } catch {
    return []
  }
}

/** Varre o repo e devolve o brief em markdown (o main grava em .synkora/CONTEXT.md). */
export async function survey(
  opts: {
    cwd: string
    configDir?: string
    model?: string
    registerKill?: (kill: () => void) => void
  },
  onEvent: (evt: MaestroEvent) => void
): Promise<string> {
  const { resultText } = await runHeadless(
    {
      stdin: SURVEY_PROMPT,
      cwd: opts.cwd,
      configDir: opts.configDir,
      model: opts.model,
      maxTurns: 40,
      announceInit: true,
      registerKill: opts.registerKill
    },
    onEvent
  )
  return resultText.trim()
}
