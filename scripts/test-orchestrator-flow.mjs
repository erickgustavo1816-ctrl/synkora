import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MISSION_RISK_SURFACE_VALUES,
  assessMissionRisk,
  delegationDirective,
  gatesForTask,
  helperLimitForExecutionMode,
  newTaskDelegationProblem,
  normalizeDelegationMode,
  normalizeExecutionMode,
  normalizeRiskLevel,
  planCardLimit,
  retryLimitForExecutionMode,
  skillSelectionDirective,
  validatePlanCompletion,
  validatePlanDependencies,
  validatePlanSizing,
  validateTaskSizing
} from '../src/main/orchestratorFlow.ts'
import {
  SECURITY_POLICY_VERSION,
  requiresManualSecurityValidation,
  securityPromptForRole
} from '../src/main/securityPolicy.ts'

const validCodeCard = (overrides = {}) => ({
  deliverable: 'code',
  effort: 'leve',
  delegation: 'none',
  quests: ['Aplicar o ajuste'],
  ...overrides
})

test('normaliza valores desconhecidos para defaults conservadores', () => {
  assert.equal(normalizeExecutionMode('fast'), 'fast')
  assert.equal(normalizeExecutionMode('deep'), 'deep')
  assert.equal(normalizeExecutionMode('desconhecido'), 'standard')

  assert.equal(normalizeRiskLevel('low'), 'low')
  assert.equal(normalizeRiskLevel('high'), 'high')
  assert.equal(normalizeRiskLevel(null), 'medium')

  assert.equal(normalizeDelegationMode('parallel', 'standard'), 'parallel')
  assert.equal(normalizeDelegationMode('desconhecido', 'deep'), 'optional')
  assert.equal(normalizeDelegationMode('parallel', 'fast'), 'none')

  const preliminary = assessMissionRisk({ texts: ['Ajustar a cor do cabeçalho.'] })
  assert.equal(preliminary.declaredRisk, 'medium')
  assert.equal(preliminary.effectiveRisk, 'medium')
  assert.equal(preliminary.raised, false)
})

test('piso automático eleva superfícies sensíveis e explica cada razão', () => {
  const assessment = assessMissionRisk({
    declaredRisk: 'low',
    texts: [
      'Adicionar login por OAuth e cobrança recorrente via Stripe.',
      'A entrega também inclui uma migração de dados com rollback.'
    ]
  })

  assert.equal(assessment.declaredRisk, 'low')
  assert.equal(assessment.effectiveRisk, 'high')
  assert.equal(assessment.raised, true)
  assert.deepEqual(assessment.surfaces, ['authentication', 'payments', 'data_migration'])
  assert.ok(assessment.reasons.every((reason) => reason.minimumRisk === 'high'))
  assert.ok(assessment.reasons.every((reason) => reason.reason.length > 20))
  assert.ok(assessment.reasons.every((reason) => reason.evidence.includes('sinal encontrado')))
})

test('superfície tipada aplica piso mesmo sem palavra-chave no resumo', () => {
  const assessment = assessMissionRisk({
    declaredRisk: 'medium',
    texts: ['Ajustar o fluxo interno descrito pelo usuário.'],
    surfaces: ['authorization', 'personal_data', 'desconhecida']
  })

  assert.equal(assessment.effectiveRisk, 'high')
  assert.deepEqual(assessment.surfaces, ['authorization', 'personal_data'])
  assert.ok(assessment.reasons.every((reason) => reason.evidence === 'superfície declarada no plano'))
})

test('pisos por superfície são proporcionais e nunca reduzem o risco declarado', () => {
  const medium = assessMissionRisk({
    declaredRisk: 'low',
    surfaces: ['public_contract', 'concurrency', 'file_upload', 'ai_agents']
  })
  assert.equal(medium.effectiveRisk, 'medium')
  assert.equal(medium.raised, true)
  assert.ok(medium.reasons.every((reason) => reason.minimumRisk === 'medium'))

  const highSignal = assessMissionRisk({
    declaredRisk: 'low',
    surfaces: ['security_configuration'],
    texts: ['Corrigir XSS no preview renderizado com innerHTML.']
  })
  assert.equal(highSignal.effectiveRisk, 'high')
  assert.equal(highSignal.reasons[0]?.minimumRisk, 'high')
  assert.match(highSignal.reasons[0]?.evidence ?? '', /sinal encontrado/)

  const declaredHigh = assessMissionRisk({
    declaredRisk: 'high',
    surfaces: ['public_contract']
  })
  assert.equal(declaredHigh.effectiveRisk, 'high')
  assert.equal(declaredHigh.raised, false)
})

test('detecta arquivos de instrução e diretórios de agentes como supply chain', () => {
  for (const text of [
    'Atualizar AGENTS.md com novas ferramentas.',
    'Editar CLAUDE.md para mudar o comportamento do agente.',
    'Revisar GEMINI.md antes de habilitar ferramentas.',
    'Atualizar SKILL.md com uma nova instrução.',
    'Alterar .codex/config.toml no projeto.',
    'Revisar .claude/settings.json antes do release.',
    'Mudar .cursor/rules/frontend.mdc.',
    'Editar .github/copilot-instructions.md.',
    'Editar .github/instructions/security.instructions.md.',
    'Atualizar .github/prompts/security-review.prompt.md.',
    'Mudar .claude/agents/security-reviewer.md.',
    'Mudar .claude/commands/security-review.md.',
    'Mudar .claude/skills/security/SKILL.md.',
    'Revisar .windsurf/rules/security.md.',
    'Revisar .roo/rules/security.md.',
    'Revisar .cline/rules/security.md.',
    'Revisar .continue/rules/security.md.',
    'Revisar .gemini/settings.json.',
    'Revisar .codex-plugin/plugin.json.',
    'Atualizar .antigravity.md.',
    'Atualizar windsurf-ret-product-security.md.',
    'Revisar o manifesto mcp.json.',
    'Atualizar o mcp-server.yaml.',
    'Adicionar um hook PreToolUse que libera comandos.',
    'Alterar o manifesto do plugin que concede ferramentas.',
    'Atualizar uma instrução de agente com acesso a ferramentas.'
  ]) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.ok(assessment.surfaces.includes('supply_chain'), text)
  }
})

test('eleva falhas de autorização por objeto e escalação de privilégios', () => {
  for (const text of [
    'Corrigir IDOR em /api/orders/:id.',
    'Mitigar BOLA na API de documentos.',
    'Corrigir broken object level authorization no endpoint.',
    'Bloquear privilege escalation horizontal.',
    'Corrigir escalação vertical de privilégios.',
    'Validar object ownership antes de retornar o registro.'
  ]) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.ok(assessment.surfaces.includes('authorization'), text)
    assert.equal(
      assessment.reasons.find((reason) => reason.surface === 'authorization')?.minimumRisk,
      'high',
      text
    )
  }
})

test('eleva criptografia, ciclo de chaves e credenciais service_role', () => {
  const cryptography = assessMissionRisk({
    declaredRisk: 'low',
    texts: ['Revisar falha criptográfica e encryption at rest no banco.']
  })
  assert.equal(cryptography.effectiveRisk, 'high')
  assert.deepEqual(cryptography.surfaces, ['cryptography'])

  for (const text of [
    'Implementar key rotation do signing key.',
    'Remover service_role key exposta no cliente.'
  ]) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.ok(assessment.surfaces.includes('secrets'), text)
  }
})

test('eleva vulnerabilidade conhecida de dependência sem marcar atualização comum', () => {
  for (const text of [
    'Atualizar dependência lodash afetada por CVE-2025-0001.',
    'Corrigir GHSA-abcd-1234-efgh no pacote transitivo.',
    'Corrigir dependency vulnerability no parser.',
    'Substituir uma dependência vulnerável do servidor.',
    'Executar npm audit e validar o alcance no runtime.'
  ]) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.ok(assessment.surfaces.includes('supply_chain'), text)
    assert.equal(
      assessment.reasons.find((reason) => reason.surface === 'supply_chain')?.minimumRisk,
      'high',
      text
    )
  }

  const routineUpgrade = assessMissionRisk({
    declaredRisk: 'low',
    texts: ['Atualizar lodash para melhorar o desempenho do build.']
  })
  assert.equal(routineUpgrade.effectiveRisk, 'low')
  assert.deepEqual(routineUpgrade.surfaces, [])
})

test('eleva desserialização insegura, open redirect e exposição de dados', () => {
  for (const text of [
    'Corrigir unsafe deserialization no importador.',
    'Remover pickle.loads do conteúdo recebido.',
    'Bloquear open redirect no retorno da aplicação.'
  ]) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.ok(assessment.surfaces.includes('security_configuration'), text)
  }

  for (const text of [
    'Conter data exfiltration pelo conector externo.',
    'Conter exfiltration pelo canal lateral.',
    'Corrigir vazamento de dados entre contas.',
    'Eliminar sensitive data exposure no cache.'
  ]) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.ok(assessment.surfaces.includes('data_exposure'), text)
  }
})

test('eleva prompt injection, envenenamento de RAG e agência excessiva', () => {
  for (const text of [
    'Conter prompt injection indireta em documentos enviados.',
    'Mitigar RAG poisoning no índice compartilhado.',
    'Remover excessive agency do agente com ferramentas.',
    'Bloquear acesso irrestrito do MCP antes de habilitar ações.'
  ]) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.ok(assessment.surfaces.includes('ai_agents'), text)
    assert.equal(
      assessment.reasons.find((reason) => reason.surface === 'ai_agents')?.minimumRisk,
      'high',
      text
    )
  }

  const ordinaryRag = assessMissionRisk({
    declaredRisk: 'low',
    texts: ['Adicionar busca RAG com documentos sintéticos.']
  })
  assert.equal(ordinaryRag.effectiveRisk, 'medium')
  assert.deepEqual(ordinaryRag.surfaces, ['ai_agents'])
})

test('novos sinais concretos forçam review e QA sem falsos positivos genéricos', () => {
  const sensitive = assessMissionRisk({
    declaredRisk: 'low',
    texts: ['Corrigir IDOR no acesso a pedidos.']
  })
  assert.deepEqual(gatesForTask('fast', sensitive.effectiveRisk, 'code', []), ['review', 'qa'])

  const ordinary = assessMissionRisk({
    declaredRisk: 'low',
    texts: [
      'Serializar o estado local do componente.',
      'Rotacionar o ícone de chave no cabeçalho.',
      'Montar painel de preços de criptoativos.',
      'Animar a bola que representa o fluxo entre os cards.',
      'Ajustar ownership do pacote npm.',
      'Redirecionar para a tela inicial.',
      'Mostrar dados agregados no gráfico.'
    ]
  })
  assert.equal(ordinary.effectiveRisk, 'low')
  assert.deepEqual(ordinary.surfaces, [])
})

test('gates explicitos sao contrato: UI nao re-impoe QA (ordem do dono 2026-08-12)', () => {
  // Escolha explícita vale literalmente, inclusive em card de UI (caso real
  // M09: o ownerOrder gravou ["review"] e o force-append reabria o QA).
  assert.deepEqual(gatesForTask('standard', 'low', 'code', ['review'], true), ['review'])
  assert.deepEqual(gatesForTask('standard', 'low', 'code', ['review'], false), ['review'])
  // Default de card de UI sem gates segue integral (review+qa via pipeline).
  assert.equal(gatesForTask('standard', 'low', 'code', undefined, true), undefined)
})

test('test card (dept qa) nasce so com review, inclusive sob risco alto', () => {
  assert.deepEqual(gatesForTask('standard', 'low', 'code', undefined, false, 'qa'), ['review'])
  assert.deepEqual(gatesForTask('standard', 'high', 'code', undefined, false, 'qa'), ['review'])
  // Escolha explícita do orquestrador em card qa continua valendo.
  assert.deepEqual(gatesForTask('standard', 'low', 'code', ['review', 'qa'], false, 'qa'), [
    'review',
    'qa'
  ])
})

test('detecta classes concretas de injeção, traversal e fronteira Electron', () => {
  const cases = [
    'Corrigir XSS refletido no campo de busca.',
    'Trocar outerHTML por construção segura de elementos.',
    'Adicionar proteção CSRF no formulário autenticado.',
    'Adicionar token XSRF na mutação autenticada.',
    'Bloquear SSRF no importador de URLs.',
    'Eliminar SQL injection na consulta de clientes.',
    'Substituir SQL concatenado por parâmetros.',
    'Validar entrada antes de chamar exec("comando dinâmico").',
    'Remover shell injection no subprocess.run("comando").',
    'Sanitizar argumentos antes de ProcessBuilder iniciar o comando.',
    'Remover popen("comando") do parser.',
    'Corrigir path traversal no download de arquivos.',
    'Bloquear arquivo ../private no caminho de download.',
    'Endurecer ipcRenderer, contextBridge e sandbox do Electron.',
    'Validar cada canal IPC exposto no preload.',
    'Restringir webContents.setWindowOpenHandler a URLs permitidas.'
  ]

  for (const text of cases) {
    const assessment = assessMissionRisk({ declaredRisk: 'low', texts: [text] })
    assert.equal(assessment.effectiveRisk, 'high', text)
    assert.deepEqual(assessment.surfaces, ['security_configuration'], text)
    assert.equal(assessment.reasons[0]?.minimumRisk, 'high', text)
  }
})

test('não confunde semântica de UI, skill visual ou preview de anexo com segurança', () => {
  const assessment = assessMissionRisk({
    declaredRisk: 'low',
    texts: [
      'Ajustar o role ARIA do botão para melhorar acessibilidade.',
      'Usar uma skill de animação para suavizar a entrada dos cards.',
      'Melhorar o preview do anexo e o plugin de animação.',
      'Redimensionar o BrowserWindow e animar sua abertura.',
      'Ajustar o spawn de partículas no fundo visual.',
      'Renomear myagents.md, que é apenas uma nota comum.',
      'Documentar o diretório fictício .codex-old sem alterar agentes.',
      'Atualizar o import ../components/Button no componente visual.'
    ]
  })

  assert.equal(assessment.effectiveRisk, 'low')
  assert.deepEqual(assessment.surfaces, [])
  assert.deepEqual(assessment.reasons, [])
})

test('upload real continua classificado sem transformar preview de anexo em upload', () => {
  const assessment = assessMissionRisk({
    declaredRisk: 'low',
    texts: ['Adicionar upload de avatar com limite de tamanho.']
  })
  assert.equal(assessment.effectiveRisk, 'medium')
  assert.deepEqual(assessment.surfaces, ['file_upload'])
  assert.equal(assessment.reasons[0]?.minimumRisk, 'medium')
})

test('agrega evidências concretas da mesma superfície com limite', () => {
  const assessment = assessMissionRisk({
    declaredRisk: 'low',
    texts: ['Corrigir XSS, CSRF e ipcMain na mesma fronteira.']
  })
  const reason = assessment.reasons.find((item) => item.surface === 'security_configuration')
  assert.equal(assessment.effectiveRisk, 'high')
  assert.match(reason?.evidence ?? '', /xss/i)
  assert.match(reason?.evidence ?? '', /csrf/i)
  assert.match(reason?.evidence ?? '', /ipcmain/i)
  assert.equal((reason?.evidence.match(/sinal encontrado/g) ?? []).length, 3)
})

test('catálogo tipado de create_plan é único e contém as superfícies aceitas', () => {
  assert.equal(new Set(MISSION_RISK_SURFACE_VALUES).size, MISSION_RISK_SURFACE_VALUES.length)
  for (const surface of [
    'authentication',
    'tenant_boundary',
    'security_configuration',
    'supply_chain',
    'cryptography',
    'data_exposure'
  ]) {
    assert.ok(MISSION_RISK_SURFACE_VALUES.includes(surface), surface)
  }
})

test('detecta fronteiras SaaS e agentes sem depender do rótulo do planejador', () => {
  const assessment = assessMissionRisk({
    declaredRisk: 'low',
    texts: [
      'Adicionar upload em bucket privado por workspace_id.',
      'O agente RAG usa MCP para exportar dados no painel admin.'
    ]
  })

  assert.equal(assessment.effectiveRisk, 'high')
  assert.deepEqual(assessment.surfaces, [
    'tenant_boundary',
    'file_upload',
    'admin_support',
    'ai_agents'
  ])
  assert.equal(requiresManualSecurityValidation(assessment.surfaces), true)
})

test('criptografia e exposição de dados exigem validação humana explícita', () => {
  assert.equal(requiresManualSecurityValidation(['cryptography']), true)
  assert.equal(requiresManualSecurityValidation(['data_exposure']), true)
})

test('piso preserva classificações comuns e nunca reduz risco já alto', () => {
  const common = assessMissionRisk({
    declaredRisk: 'low',
    texts: ['Trocar o texto de ajuda e alinhar o ícone do cabeçalho.']
  })
  assert.equal(common.effectiveRisk, 'low')
  assert.equal(common.raised, false)
  assert.deepEqual(common.reasons, [])

  const alreadyHigh = assessMissionRisk({
    declaredRisk: 'high',
    texts: ['Atualizar a cor de um botão.']
  })
  assert.equal(alreadyHigh.effectiveRisk, 'high')
  assert.equal(alreadyHigh.raised, false)
})

test('limites de cards distinguem fast, standard e deep', () => {
  assert.deepEqual(
    ['fast', 'standard', 'deep'].map((mode) => planCardLimit(mode)),
    [1, 4, 12]
  )

  assert.deepEqual(validatePlanSizing({ mode: 'fast', expectedCards: 1, laneCount: 1 }), [])
  assert.deepEqual(validatePlanSizing({ mode: 'standard', expectedCards: 4, laneCount: 4 }), [])
  assert.deepEqual(validatePlanSizing({ mode: 'deep', expectedCards: 12, laneCount: 8 }), [])

  assert.ok(
    validatePlanSizing({ mode: 'fast', expectedCards: 2, laneCount: 2 }).length >= 2,
    'fast deve recusar mais de um card e mais de uma lane'
  )
  assert.ok(
    validatePlanSizing({ mode: 'standard', expectedCards: 5, laneCount: 5 }).length >= 2,
    'standard deve encaminhar planos maiores para deep'
  )
  assert.ok(
    validatePlanSizing({ mode: 'deep', expectedCards: 13, laneCount: 8 }).length >= 1,
    'deep ainda possui um teto explícito'
  )
})

test('grafo tipado aceita paralelismo real e dependências entre ondas', () => {
  assert.deepEqual(
    validatePlanDependencies({
      mode: 'standard',
      expectedCards: 3,
      items: [
        { id: 'front-shell', waveId: 'O01-base', dependsOn: [] },
        { id: 'back-api', waveId: 'O01-base', dependsOn: [] },
        {
          id: 'wire-flow',
          waveId: 'O02-integracao',
          dependsOn: ['front-shell', 'back-api']
        }
      ]
    }),
    []
  )
})

test('grafo tipado recusa ids ausentes, ciclos e ondas artificiais', () => {
  const invalid = validatePlanDependencies({
    mode: 'deep',
    expectedCards: 5,
    items: [
      { id: 'a', waveId: 'O01', dependsOn: ['c'] },
      { id: 'b', waveId: 'O02', dependsOn: ['fantasma'] },
      { id: 'c', waveId: 'O03', dependsOn: ['a'] },
      { id: 'd', waveId: 'O04', dependsOn: [] },
      { id: 'e', waveId: 'O02', dependsOn: ['a'] }
    ]
  })

  assert.ok(invalid.some((problem) => problem.includes('não existe no grafo')))
  assert.ok(invalid.some((problem) => problem.includes('ciclo de dependências')))
  assert.ok(invalid.some((problem) => problem.includes('onda posterior sem depender')))
  assert.ok(invalid.some((problem) => problem.includes('reaparece depois de outra onda')))
  assert.ok(invalid.some((problem) => problem.includes('mesma onda ou numa onda futura')))
})

test('grafo FAST exige um único card sem dependências nem ondas extras', () => {
  assert.deepEqual(
    validatePlanDependencies({
      mode: 'fast',
      expectedCards: 1,
      items: [{ id: 'ajuste', waveId: 'O01', dependsOn: [] }]
    }),
    []
  )

  const empty = validatePlanDependencies({ mode: 'fast', expectedCards: 1, items: [] })
  assert.ok(empty.some((problem) => problem.includes('ao menos um card')))
  assert.ok(empty.some((problem) => problem.includes('exatamente um card')))

  const split = validatePlanDependencies({
    mode: 'fast',
    expectedCards: 1,
    items: [
      { id: 'a', waveId: 'O01', dependsOn: [] },
      { id: 'b', waveId: 'O02', dependsOn: ['a'] }
    ]
  })
  assert.ok(split.some((problem) => problem.includes('não aceita múltiplas ondas')))
  assert.ok(split.some((problem) => problem.includes('não aceita dependências')))
})

test('FAST não conclui com zero cards, card aberto ou entrega duplicada', () => {
  const noCards = validatePlanCompletion({ mode: 'fast', expectedCards: 1, cards: [] })
  assert.ok(noCards.some((problem) => problem.includes('entregar exatamente um card')))

  const openCard = validatePlanCompletion({
    mode: 'fast',
    expectedCards: 1,
    cards: [{ status: 'backlog' }]
  })
  assert.ok(openCard.some((problem) => problem.includes('não concluído')))
  assert.ok(openCard.some((problem) => problem.includes('entregar exatamente um card')))

  assert.deepEqual(
    validatePlanCompletion({
      mode: 'fast',
      expectedCards: 1,
      cards: [{ status: 'done' }]
    }),
    []
  )

  const duplicate = validatePlanCompletion({
    mode: 'fast',
    expectedCards: 1,
    cards: [{ status: 'done' }, { status: 'done' }]
  })
  assert.ok(duplicate.some((problem) => problem.includes('registrados: 2, entregues: 2')))
})

test('sizing recusa contagens inválidas e criação além do plano aprovado', () => {
  assert.ok(
    validatePlanSizing({ mode: 'fast', expectedCards: 0, laneCount: 1 }).some((problem) =>
      problem.includes('inteiro positivo')
    )
  )

  const problems = validateTaskSizing('standard', 'medium', 2, 1, [
    validCodeCard(),
    validCodeCard()
  ])
  assert.ok(problems.some((problem) => problem.includes('levaria o total a 3')))
})

test('fast proíbe trabalho pesado, helpers, subagentes e skills amplas', () => {
  const problems = validateTaskSizing('fast', 'low', 1, 0, [
    validCodeCard({
      effort: 'pesada',
      delegation: 'parallel',
      agents: ['especialista-a'],
      skills: ['skill-a', 'skill-b'],
      quests: ['Parte A', 'Parte B']
    })
  ])

  assert.ok(problems.some((problem) => problem.includes('trabalho pesado')))
  assert.ok(problems.some((problem) => problem.includes('não abre ajudantes')))
  assert.ok(problems.some((problem) => problem.includes('subagentes')))
  assert.ok(problems.some((problem) => problem.includes('no máximo uma skill')))
})

test('standard e deep também limitam o carimbo a uma técnica e um especialista', () => {
  for (const mode of ['standard', 'deep']) {
    const problems = validateTaskSizing(mode, 'medium', 1, 0, [
      validCodeCard({
        skills: ['skill-a', 'skill-b'],
        agents: ['especialista-a', 'especialista-b']
      })
    ])
    assert.ok(problems.some((problem) => problem.includes('uma skill técnica explícita')))
    assert.ok(problems.some((problem) => problem.includes('um subagente especialista explícito')))
  }
})

test('persona selecionada exige decisão parallel do orquestrador', () => {
  for (const delegation of ['none', 'optional']) {
    const problems = validateTaskSizing('standard', 'medium', 1, 0, [
      validCodeCard({
        agents: ['especialista-a'],
        delegation
      })
    ])
    assert.ok(
      problems.some((problem) => problem.includes('exige paralelismo planejado')),
      delegation
    )
  }
})

test('fast aceita várias quests sequenciais sem transformar checklist em delegação', () => {
  const card = validCodeCard({
    delegation: 'none',
    quests: ['Ajustar o texto', 'Atualizar o teste', 'Conferir o resultado'],
    skills: ['skill-direta']
  })

  assert.deepEqual(validateTaskSizing('fast', 'low', 1, 0, [card]), [])

  const directive = delegationDirective('fast', 'none', card.quests.length)
  assert.match(directive, /EXECUTE DIRETAMENTE/)
  assert.match(directive, /Checklist não significa paralelismo/)
  assert.doesNotMatch(directive, /aguarde uma única orientação/)
})

test('delegação optional sobrevive apenas como compatibilidade legada', () => {
  const directive = delegationDirective('standard', 'optional', 6)
  assert.match(directive, /MESMO modelo e MESMO effort/)
  assert.match(directive, /COMPATIBILIDADE LEGADA/)
  assert.match(directive, /Cards novos nunca usam optional/)

  assert.equal(newTaskDelegationProblem('none'), undefined)
  assert.equal(newTaskDelegationProblem('parallel'), undefined)
  assert.match(newTaskDelegationProblem('optional'), /apenas legado/)
  assert.match(newTaskDelegationProblem(undefined), /precisa declarar/)

  const invalidParallel = validateTaskSizing('standard', 'medium', 1, 0, [
    validCodeCard({ delegation: 'parallel', quests: ['Um único bloco'] })
  ])
  assert.ok(invalidParallel.some((problem) => problem.includes('ao menos dois blocos')))
})

test('delegação paralela abre os ajudantes direto, até o teto do modo', () => {
  // Contrato 2026-08-10: paralelismo planejado não pede aprovação prévia —
  // abre os blocos independentes numa chamada só, teto 2 (standard)/4 (deep).
  const directive = delegationDirective('deep', 'parallel', 3)
  assert.match(directive, /DIRETO/)
  assert.match(directive, /teto do modo/)
  assert.doesNotMatch(directive, /único ajudante aprovado|aguarde uma orientação/)
  assert.equal(helperLimitForExecutionMode('deep'), 4)
})

test('non_code comum não abre gate, mas instrução/configuração sensível recebe review', () => {
  assert.deepEqual(gatesForTask('fast', 'low', 'non_code', undefined), [])
  assert.deepEqual(gatesForTask('standard', 'medium', 'non_code', ['review', 'qa']), [])
  assert.deepEqual(gatesForTask('deep', 'high', 'non_code', ['qa']), ['review'])

  assert.deepEqual(
    validateTaskSizing('fast', 'low', 1, 0, [
      {
        deliverable: 'non_code',
        effort: 'leve',
        gates: [],
        delegation: 'none',
        quests: ['Produzir o documento']
      }
    ]),
    []
  )

  const sensitive = validateTaskSizing('deep', 'high', 1, 0, [
    {
      deliverable: 'non_code',
      effort: 'pesada',
      gates: [],
      delegation: 'none',
      quests: ['Atualizar uma instrução de agente com acesso a cloud']
    }
  ])
  assert.ok(sensitive.some((problem) => problem.includes('risco alto exige review')))
})

test('código nunca aceita gates explicitamente vazios', () => {
  const problems = validateTaskSizing('standard', 'low', 1, 0, [
    validCodeCard({ gates: [] })
  ])
  assert.ok(problems.some((problem) => problem.includes('código nunca usa gates vazios')))
})

test('risco alto sempre resulta em review e QA completos', () => {
  assert.deepEqual(gatesForTask('fast', 'high', 'code', undefined), ['review', 'qa'])
  assert.deepEqual(gatesForTask('standard', 'high', 'code', ['qa']), ['review', 'qa'])
  assert.deepEqual(gatesForTask('deep', 'high', 'code', ['review']), ['review', 'qa'])

  for (const gates of [[], ['review'], ['qa']]) {
    const problems = validateTaskSizing('deep', 'high', 1, 0, [
      validCodeCard({ gates })
    ])
    assert.ok(
      problems.some((problem) => problem.includes('risco alto exige review + QA')),
      `gates parciais ${JSON.stringify(gates)} devem ser recusados em risco alto`
    )
  }

  assert.deepEqual(
    validateTaskSizing('deep', 'high', 1, 0, [
      validCodeCard({ gates: ['review', 'qa'] })
    ]),
    []
  )
})

test('código de risco baixo ou médio preserva gates explícitos e defaults', () => {
  assert.equal(gatesForTask('fast', 'low', 'code', undefined), undefined)
  assert.deepEqual(gatesForTask('standard', 'medium', 'code', ['qa']), ['qa'])
  assert.deepEqual(gatesForTask('deep', 'medium', 'code', ['review']), ['review'])
})

test('retry e helpers possuem orçamentos proporcionais e fechados', () => {
  assert.deepEqual(
    ['fast', 'standard', 'deep'].map((mode) => retryLimitForExecutionMode(mode)),
    [1, 1, 2]
  )
  assert.deepEqual(
    ['fast', 'standard', 'deep'].map((mode) => helperLimitForExecutionMode(mode)),
    // F6.2 restaurado (ordem do dono 2026-08-10): fast 0 · standard 2 · deep 4
    [0, 2, 4]
  )
})

test('diretiva de skills mantém fast estreito e limita os demais modos', () => {
  const fast = skillSelectionDirective('fast')
  const standard = skillSelectionDirective('standard')
  const deep = skillSelectionDirective('deep')

  assert.match(fast, /no máximo UMA skill/)
  assert.match(fast, /Nenhuma skill também é uma resposta válida/)
  assert.match(fast, /Não deixe uma metodologia adicionar fases/)
  assert.match(standard, /no máximo UMA skill técnica/)
  assert.match(deep, /no máximo UMA skill técnica/)
})

test('política de segurança é curta, versionada e contextual por papel/superfície', () => {
  assert.equal(SECURITY_POLICY_VERSION, 2)
  const planner = securityPromptForRole('planner')
  const qa = securityPromptForRole('qa', ['tenant_boundary', 'payments'])

  assert.match(planner, /SECURITY BASELINE/)
  assert.match(planner, /Security signals are hypotheses/)
  assert.match(planner, /PLANNING SECURITY/)
  assert.doesNotMatch(planner, /100% secure|guaranteed security|complete pentest/i)
  assert.match(qa, /synthetic accounts\/data/)
  assert.match(qa, /tenant\/customer data isolation/)
  assert.match(qa, /signed webhook/)
  assert.match(qa, /Never claim the product is secure/)
})
