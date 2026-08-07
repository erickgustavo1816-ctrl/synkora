# FASE 1 — mapa de solda do phasePrompts.ts (agente Opus, 2026-08-07)

O módulo `src/main/phasePrompts.ts` (595 linhas, puro, zero imports de estado)
foi gerado por agente com prova de equivalência: sweep diferencial contra as
expressões originais do index — **5810 comparações, 0 divergências** (fases ×
modos × delegação × CLI × 8 depts × variantes de briefing/gates/snapshot/
evidência/resume) + tokenizer confirmando nenhum newline fora de `${…}`.
Typecheck verde com o módulo órfão. Este arquivo é o MAPA DE SOLDA no
index.ts — âncoras textuais únicas (números de linha da época, o texto é a
âncora real).

## Import a adicionar no index.ts

```ts
import {
  buildAgentsBlock, buildAtomicRoundRule, buildBasePrompt, buildBrowserHint,
  buildClosedListBlock, buildDevContract, buildExecutionProfileBlock, buildPhasePrompt,
  buildQaRuntimeBlock, buildQuestBlock, buildResumeReadFirstPrompt, buildReviewDiffBlock,
  buildSkillsBlock, buildStructuredReviewRule, buildVerdictRule, buildWorkspaceMaterialsNote,
  qaRuntimeAlreadyRunningNote, qaRuntimeHarnessFailedNote, qaRuntimeHarnessStartedNote
} from './phasePrompts'
```

## As 18 soldas (âncora original → chamada nova)

1. `resumedRuntimeNote = \`THE PRODUCT IS ALREADY RUNNING at ${liveRuntime.url}` (≈11347) → `resumedRuntimeNote = qaRuntimeAlreadyRunningNote(liveRuntime.url)`
2. `resumedRuntimeNote = started.url` + braços do ternário (≈11361–11363) → `resumedRuntimeNote = started.url ? qaRuntimeHarnessStartedNote(started.url) : qaRuntimeHarnessFailedNote(started.error)`
3. `qaRuntimeBlock =` seguido de `resumedRuntimeNote +` (≈11366–11372) → `qaRuntimeBlock = buildQaRuntimeBlock({ resumedRuntimeNote, portMapLine: qaPortMapLine })`
4. `workspaceMaterialsNote = \`LOCAL COPIES INSIDE THIS WORKSPACE` (≈11399) → `workspaceMaterialsNote = buildWorkspaceMaterialsNote(copied)` (o builder devolve '' para array vazio; o `if (copied.length > 0)` em volta pode ficar ou cair)
5. `const skillsBlock = injSkills.length` (≈11549–11555) → `const skillsBlock = buildSkillsBlock({ injSkills, executionMode, cli: seat.cli })`
6. `injAgents.length && seat.cli === 'claude'` (≈11558–11563) → `const agentsBlock = buildAgentsBlock({ injAgents, cli: seat.cli })`
7. `const structuredReviewRule = structuredSecurityReviewRequired` (≈11573–11575) → `const structuredReviewRule = buildStructuredReviewRule(structuredSecurityReviewRequired, securityAssessment.surfaces)`
8. `` `At the END of your analysis (and only then)` `` (≈11576–11579) → `const verdictRule = buildVerdictRule(structuredReviewRule)`
9. `const browserHint =` + `phase === 'review'` (≈11582–11589) → `const browserHint = buildBrowserHint(phase, sensitiveRuntime)`
10. `` ` EXECUTION PROFILE: ${executionMode.toUpperCase()}` `` (≈11590–11595) → `const executionProfileBlock = buildExecutionProfileBlock({ executionMode, delegationMode, questCount: task.quests?.length ?? 0 })`
11. `const devContract =` (≈11600–11623) → `const devContract = buildDevContract({ feedback, title: task.title, deptLabel: DEPT_NAME[task.department], department: task.department, executionMode, executionProfileBlock, browserHint, marker })`
12. `const questBlock = task.quests?.length` (≈11626–11630) → `const questBlock = buildQuestBlock({ quests: task.quests, executionMode, delegationMode })`
13. `const closedListBlock =` (≈11646–11649) → `const closedListBlock = buildClosedListBlock({ phase, gateRound: task.gateRound })`
14. `const deliveredSnapshot = task.verification?.dev` ATÉ o fim de `const reviewDiffBlock = …` (≈11650–11672; os 5 consts saem JUNTOS — verificado por grep: deliveredSnapshot/reviewBaseSha/reviewChangedPaths/reviewChangedPathsSummary não têm outro leitor) → `const reviewDiffBlock = buildReviewDiffBlock({ delivered: task.verification?.dev, evidence: immutableReviewerEvidence })`
15. `const atomicRoundRule =` (≈11677–11684) → `const atomicRoundRule = buildAtomicRoundRule(phase)`
16. `const basePrompt =` (≈11685–11759) → `const basePrompt = buildBasePrompt({ phase, title: task.title, description: task.description, briefing: task.briefing, gates: task.gates, gateNotes: task.gateNotes, executionMode, logFile, skillsBlock, agentsBlock, questBlock, devContract, workspaceMaterialsNote, atomicRoundRule, reviewDiffBlock, qaRuntimeBlock, browserHint, verdictRule, closedListBlock, gateSkillsBlock: gateKit.skillsBlock, gateAgentsBlock: gateKit.agentsBlock })`
17. `const prompt =` (o ternário grande após o comentário `RE-SPAWN COM RESUME = PROMPT DELTA`, ≈11769–11796) → `const prompt = buildPhasePrompt({ phase, resumed: Boolean(resumable), recoveringPhase, retryingOriginalDev, feedback, taskFeedback: task.feedback, gateNotes: task.gateNotes, logFile, recoveredHelperLogs, basePrompt })`
18. `` deliveredPrompt = `[Synkora] Resumed conversation. FIRST open and read the file `` (≈11920–11924) → `deliveredPrompt = buildResumeReadFirstPrompt(resumePromptFile)`

## Pós-solda

- Imports `skillSelectionDirective` e `delegationDirective` no index (linhas ~83/90) ficam MORTOS — remover (os únicos call sites eram os blocos 5, 10 e 12). `EXECUTION_MODE_LABEL` e `DEPT_NAME` FICAM (usados em outros pontos / no arg deptLabel).
- Comentários PT-BR institucionais foram MIGRADOS para o módulo junto do código; onde parte do mecanismo ficou no index (fs/runtime/write), há ponteiro de uma linha.
- Ficou deliberadamente inline no index (precisa de estado vivo): decisão do resumedRuntimeNote (detectRuntimeScript/startQaRuntime/blackbox), guard do qaRuntimeBlock, loop de cópia do workspaceMaterials, skillIds/agentIds/skillSync, gateKit (gateSkillsFor), structuredSecurityReviewRequired (securityWaiverOptions), immutableReviewerEvidence (gitOff), logFile/marker, o write do arquivo de resume (BOM), e o mapa DEPT_NAME.
- Validação obrigatória pós-solda: `npm run typecheck` + test:orchestrator-flow + test:mission-verification + test:stall-attribution.
