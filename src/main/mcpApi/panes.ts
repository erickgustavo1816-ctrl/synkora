/**
 * MCP API — domínio panes (fase 1, commit 4b).
 * Comunicação e controle de panes: runtime do QA, pergunta ao dono,
 * status note do radar, notify maestro/pane e o mapa de panes vivos.
 *
 * Corpo movido VERBATIM do literal mcpApi do index.ts. O return é tipado
 * Pick<McpApi, …> para preservar o contextual typing que o literal dava aos
 * parâmetros. uiSender/mcpPort (e campos nascidos depois do literal, como
 * mcpPaneFirstContact) são lidos via ctx a cada uso — getters reativos.
 */
import { app } from 'electron'
import { join, resolve } from 'path'
import { type SeatCli } from '../seats'
import { type Task } from '../tasks'
import { assessMissionRisk } from '../orchestratorFlow'
import { requiresManualSecurityValidation } from '../securityPolicy'
import { redactSensitiveText } from '../securityRedaction'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'fs'
import { randomUUID } from 'crypto'
import { Hub } from '../hub'
import { paneAccessProfile, paneBrowserAvailable } from '../panePermissions'
import {
  detectRuntimeScript,
  qaRuntimeOf,
  readScriptCommand,
  startQaRuntime,
  stopQaRuntime
} from '../qaRuntime'
import { isElectronScript } from '../qaCdp'
import type { MainContext } from '../mainContext'
import type { McpApi } from '../mcpServer'

/** Dependências do closure do index ainda não migradas (mesmo padrão
 * do PhaseEngineExtras). */
export interface PanesApiExtras {
  securityWaiverOptions(projectId: string): { sensitiveWaiverAllowed: boolean }
  planTaskForWorkTask(task: Task): Task | undefined
  agentModelPool(seat: { cli: SeatCli; id: string }): Promise<{ id: string; label: string }[]>
}

export function buildPanesApi(
  ctx: MainContext, extras: PanesApiExtras
): Pick<
  McpApi,
  | 'runtimeControl'
  | 'askUser'
  | 'declareRuntimePaths'
  | 'recordLearnings'
  | 'statusNote'
  | 'notifyMaestro'
  | 'listPanes'
  | 'notifyPane'
> {
  const {
    tasks,
    seats,
    projects,
    missions,
    ptys,
    blackbox,
    maestro,
    phaseWatches,
    pendingUserQuestions,
    paneStatusNotes,
    scheduleProgressSnapshot,
    ensureProjectRuntimeWritable,
    externalPlaywrightForPane,
    persistUserQuestions
  } = ctx
  // hub é atribuído 1× antes do mcpApi nascer — capturar é seguro.
  const hub = ctx.hub
  const {
    securityWaiverOptions,
    planTaskForWorkTask,
    agentModelPool
  } = extras
  return {
    // Origem carimbada no texto: o orquestrador responde de volta com
    // notify_pane usando exatamente esse paneId (fluxo de conselho de
    // delegação — decisão do usuário: quem escolhe modelo de ajudante é o
    // orquestrador, que roda no melhor modelo e enxerga os limites).
    // URGENTE: quem pediu conselho encerrou o turno e está esperando.
    runtimeControl: async (id, action, port) => {
      if (id.role !== 'qa' || !id.taskId)
        return 'runtime_control é exclusivo do QA de um card'
      const task = tasks.get(id.taskId)
      const currentIdentity = hub.identityByPane(id.paneId)
      const activeWatch = phaseWatches.get(id.taskId)
      const isCurrentQaRound = (): boolean => {
        const currentTask = tasks.get(id.taskId as string)
        const currentWatch = phaseWatches.get(id.taskId as string)
        const currentPane = hub.identityByPane(id.paneId)
        return Boolean(
          currentTask &&
            currentPane &&
            currentPane.projectId === id.projectId &&
            currentPane.taskId === id.taskId &&
            currentPane.role === 'qa' &&
            currentTask.activePhase === 'qa' &&
            currentTask.phaseState === 'running' &&
            currentWatch?.phase === 'qa' &&
            currentWatch.paneId === id.paneId
        )
      }
      if (
        !task ||
        !currentIdentity ||
        currentIdentity.projectId !== id.projectId ||
        currentIdentity.taskId !== id.taskId ||
        currentIdentity.role !== 'qa'
      ) {
        return 'runtime_control recusado: este pane não é mais o QA vivo deste card'
      }
      const cwd = qaRuntimeOf(id.taskId)?.cwd ?? id.cwd
      if (action === 'status') {
        const rt = qaRuntimeOf(id.taskId)
        if (rt?.cdpEndpoint)
          return `runtime DE PÉ — app Electron REAL no ar, CDP em ${rt.cdpEndpoint} já ligado às suas tools playwright (worktree ${rt.cwd})${rt.url ? `; dev server interno em ${rt.url}` : ''}`
        return rt?.url
          ? `runtime DE PÉ em ${rt.url} (worktree ${rt.cwd})`
          : rt
            ? 'runtime em preparação (processo vivo, URL ainda não anunciada)'
            : 'nenhum runtime vivo para este card — use restart'
      }
      if (action === 'stop') {
        if (activeWatch && !isCurrentQaRound())
          return 'runtime_control recusado: outra rodada de QA é a dona do runtime'
        stopQaRuntime(id.taskId)
        return 'runtime derrubado'
      }
      if (!isCurrentQaRound())
        return 'runtime_control recusado: restart exige a rodada QA atual em execução'
      const planTask = planTaskForWorkTask(task)
      const runtimeRisk = assessMissionRisk({
        declaredRisk: planTask?.plan?.risk,
        surfaces: planTask?.plan?.riskSurfaces,
        texts: [task.title, task.description, task.briefing, ...(task.quests ?? [])]
      })
      const sensitiveRuntime =
        runtimeRisk.effectiveRisk === 'high' ||
        requiresManualSecurityValidation(runtimeRisk.surfaces)
      const sensitiveAutoOk = securityWaiverOptions(id.projectId).sensitiveWaiverAllowed
      const browserAvailable = paneBrowserAvailable(paneAccessProfile('qa'), {
        sensitive: sensitiveRuntime,
        sensitiveAutoOk,
        strict: true,
        mcpReady: ctx.mcpPort !== 0,
        browserConfigured: Boolean(externalPlaywrightForPane())
      })
      if (!browserAvailable) {
        return 'runtime_control recusado: o browser/runtime isolado não está autorizado nesta rodada; reporte bloqueada sem iniciar processo'
      }
      const script = detectRuntimeScript(cwd)
      if (!script)
        return 'nenhum script dev/preview/serve/start no package.json deste worktree — sem runtime para subir'
      blackbox.record({
        cat: 'phase',
        event: 'qa-runtime-control',
        actor: 'qa',
        ids: { projectId: id.projectId, missionId: task?.missionId, taskId: id.taskId, paneId: id.paneId, role: 'qa' },
        reason: `restart pedido pelo QA${port ? ` na porta ${port}` : ''}`
      })
      const rt = await startQaRuntime(id.taskId, cwd, script, port)
      if (!isCurrentQaRound()) {
        stopQaRuntime(id.taskId)
        return 'runtime descartado: a rodada QA mudou enquanto o processo era preparado'
      }
      // Fase 4: produto Electron sobe DE VERDADE e o pane já nasceu com
      // --cdp-endpoint — a resposta ensina a NÃO navegar URL (o erro clássico
      // pós-CDP seria abrir o dev server num tab e voltar ao mundo sem preload).
      if (rt.cdpEndpoint)
        return `runtime DE PÉ — app Electron REAL no ar, CDP em ${rt.cdpEndpoint} JÁ ligado às suas tools playwright: NÃO navegue para URL nenhuma; use browser_snapshot e interaja com a janela aberta (preload/IPC reais)${rt.url ? `; dev server interno em ${rt.url}` : ''}. Ao FIM da rodada, derrube com runtime_control {action:"stop"} — fechar o browser só desconecta. O harness também derruba quando seu gate terminar`
      if (rt.url) return `runtime DE PÉ em ${rt.url} — navegue com o playwright; o harness derruba quando seu gate terminar`
      const pinned = isElectronScript(readScriptCommand(cwd, script))
        ? ' NOTA: este produto usa electron-vite, que TRAVA a porta do renderer na config — porta por parâmetro não tem efeito; se o conflito persistir, a saída é a config de porta própria no produto (mudança de código = decisão do orquestrador/dono).'
        : ''
      return `runtime NÃO subiu: ${(rt.error ?? 'sem detalhe').slice(0, 400)}.${pinned} Se mais tentativas não fizerem sentido, reporte "bloqueada" com este erro`
    },
    askUser: (id, question) => {
      if (id.role !== 'maestro')
        return 'só o Maestro/orquestrador pergunta ao usuário — envie sua dúvida ao seu orquestrador via notify_maestro'
      const q = redactSensitiveText(question).trim().slice(0, 500)
      if (!q) return 'pergunta vazia — nada registrado'
      const missionKey = id.missionId ?? 'geral'
      pendingUserQuestions.set(`${id.projectId}--${missionKey}`, {
        projectId: id.projectId,
        missionKey,
        question: q,
        at: new Date().toISOString()
      })
      persistUserQuestions()
      blackbox.record({
        cat: 'msg',
        event: 'ask-user',
        actor: 'maestro',
        ids: { projectId: id.projectId, missionId: id.missionId, paneId: id.paneId },
        reason: q
      })
      ctx.pushBoard('maestro:userQuestion', id.projectId, missionKey, q)
      // pergunta pendente é o item nº 1 do radar de andamento
      scheduleProgressSnapshot()
      return 'pergunta registrada — a aba correspondente do board pulsa até o usuário abrir; mantenha a pergunta completa no seu terminal e AGUARDE a resposta'
    },
    // T9 (2026-08-10): allowlist de RUNTIME do produto — arquivos rastreados
    // que o app grava AO RODAR. Com ela declarada, sujeira de gate composta
    // só desses caminhos é restaurada ao commit julgado e o veredito
    // sobrevive (fim do loop "QA roda o app → árvore suja → veredito
    // descartado → volta ao dev que nada tinha a corrigir").
    declareRuntimePaths: (id, paths) => {
      if (id.role !== 'maestro')
        return 'só o Maestro/orquestrador declara caminhos de runtime — peça ao seu orquestrador via notify_maestro'
      const clean = [
        ...new Set((paths ?? []).map((p) => String(p).trim().replace(/\\/g, '/')).filter(Boolean))
      ].slice(0, 12)
      const bad = clean.filter(
        (p) =>
          p.includes('..') ||
          p.startsWith('/') ||
          /^[a-z]:/i.test(p) ||
          p === '.git' ||
          p.startsWith('.git/')
      )
      if (bad.length > 0)
        return `caminhos recusados (${bad.join(', ')}): use caminhos RELATIVOS ao repo — nunca absolutos, ".." ou .git`
      const prev = maestro.get(id.projectId).runtimePaths ?? []
      maestro.update(id.projectId, { runtimePaths: clean })
      blackbox.record({
        cat: 'git',
        event: 'runtime-paths-declared',
        actor: 'maestro',
        ids: { projectId: id.projectId, missionId: id.missionId, paneId: id.paneId },
        reason: `${prev.join(', ') || '(vazio)'} → ${clean.join(', ') || '(vazio)'}`
      })
      hub.publish({
        projectId: id.projectId,
        kind: 'info',
        quiet: true,
        text: `caminhos de runtime do produto declarados: ${clean.join(', ') || '(allowlist limpa)'}`,
        actor: 'maestro'
      })
      return clean.length > 0
        ? `caminhos de runtime declarados: ${clean.join(', ')} — divergência de gate composta SÓ de modificação não-staged nesses caminhos passa a ser RESTAURADA ao commit julgado (veredito sobrevive); qualquer coisa fora deles segue invalidando normalmente. A correção definitiva continua sendo o produto gravar runtime fora de caminho rastreado.`
        : 'allowlist de runtime LIMPA — toda divergência de gate volta a invalidar o veredito integralmente'
    },
    // DOCUMENTAÇÃO AUTOMÁTICA DE SESSÃO (pedido do dono, 2026-08-10, após a
    // análise do Xirp: "sessão vira doc, doc alimenta a próxima sessão"):
    // quem VIVEU a missão destila o aprendizado durável em tópicos de
    // .synkora/maestro/ — a estante que o contrato de memória escalável do
    // Maestro já consome (índice ≤120 linhas + tópicos sob demanda). O
    // conteúdo enviado é a REESCRITA COMPLETA do tópico (destilação, nunca
    // append); um .bak de um nível cobre reescrita cega.
    recordLearnings: (id, topic, content) => {
      if (id.role !== 'maestro')
        return 'só o Maestro/orquestrador grava aprendizados — mande os seus ao orquestrador via notify_maestro que ele destila'
      const project = projects.get(id.projectId)
      if (!project || !existsSync(project.path)) return 'projeto não encontrado'
      let slug = topic
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48)
        .replace(/-+$/, '')
      // Nome reservado do Windows: no Win11 grava normal (testado), mas no
      // Win10 clássico `nul.md` redireciona pro device e a gravação "sucede"
      // sem arquivo — 1 linha elimina a classe (o app distribui installer).
      if (/^(con|prn|aux|nul|com\d|lpt\d)$/.test(slug)) slug = `t-${slug}`
      if (!slug)
        return 'topic inválido — nome curto em kebab-case (ex.: "telas", "dados-runtime", "licoes")'
      const clean = redactSensitiveText(content).trim()
      if (clean.length < 20)
        return 'conteúdo curto demais — escreva 5-15 linhas destiladas do que importa para missões futuras'
      // Teto acima do cap do zod (8k): só a EXPANSÃO da redação de segredos
      // alcança — folga para não punir conteúdo enviado dentro do limite.
      if (clean.length > 9000)
        return 'conteúdo grande demais: aprendizado é snapshot destilado, nunca log — reescreva menor'
      const dir = join(project.path, '.synkora', 'maestro')
      try {
        mkdirSync(dir, { recursive: true })
      } catch {
        return 'não consegui preparar .synkora/maestro/ no projeto — verifique permissões da pasta'
      }
      const file = join(dir, `${slug}.md`)
      const existed = existsSync(file)
      let bakOk = false
      if (existed) {
        // Um nível de desfazer para reescrita cega (a regra é ler o tópico
        // antes de reescrever — mas um acidente não pode custar a estante).
        // bakOk condiciona a MENSAGEM: anunciar um .bak que falhou (EPERM
        // transitório de AV é caso real do repo) seria mentir o caminho de
        // restauração — mensagem honesta é princípio de projeto.
        try {
          writeFileSync(`${file}.bak`, readFileSync(file, 'utf-8'), 'utf-8')
          bakOk = true
        } catch {
          // backup é best-effort
        }
      }
      const stampSource = id.missionId
        ? `orquestrador (missão ${id.missionId.slice(0, 8)})`
        : 'Maestro'
      try {
        writeFileSync(
          file,
          `# ${slug}\n\n_Atualizado ${new Date().toISOString().slice(0, 10)} por ${stampSource}_\n\n${clean}\n`,
          'utf-8'
        )
      } catch {
        return 'não consegui gravar o tópico — verifique permissões de .synkora/maestro/'
      }
      let topics: string[] = []
      try {
        topics = readdirSync(dir)
          .filter((name) => name.endsWith('.md'))
          .map((name) => name.replace(/\.md$/, ''))
          .sort()
      } catch {
        // listagem é cosmética
      }
      blackbox.record({
        cat: 'msg',
        event: 'learnings-recorded',
        actor: id.role,
        ids: { projectId: id.projectId, missionId: id.missionId, paneId: id.paneId },
        reason: `tópico ${slug} ${existed ? 'reescrito' : 'criado'} (${clean.length} chars)`
      })
      // O PM é o dono do ÍNDICE (MAESTRO.md) — sem este aviso, tópico criado
      // por orquestrador nunca entraria no mapa e a sessão seguinte do PM não
      // o descobriria (achado do review de 2026-08-10). Evento de PROJETO
      // (sem missionId) chega ao PM; quiet = correio/EVENTS.md, sem turno.
      if (id.missionId)
        hub.publish({
          projectId: id.projectId,
          kind: 'info',
          quiet: true,
          text: `aprendizado de missão gravado na estante: .synkora/maestro/${slug}.md (${existed ? 'reescrito' : 'tópico NOVO'}) — inclua no mapa de tópicos do MAESTRO.md na próxima reescrita do índice`,
          actor: 'orchestrator'
        })
      return `aprendizado gravado em .synkora/maestro/${slug}.md (${
        existed
          ? bakOk
            ? `tópico REESCRITO — versão anterior em ${slug}.md.bak`
            : 'tópico REESCRITO — ATENÇÃO: o backup .bak FALHOU, a versão anterior se foi'
          : 'tópico NOVO'
      }). Tópicos do projeto: ${topics.join(', ') || slug}. O índice MAESTRO.md (do PM) deve listar os tópicos no mapa.`
    },
    statusNote: (id, note) => {
      const clean = redactSensitiveText(note).replace(/\s+/g, ' ').trim().slice(0, 120)
      if (!clean) return 'nota vazia — nada registrado'
      paneStatusNotes.set(id.paneId, { text: clean, at: new Date().toISOString() })
      scheduleProgressSnapshot()
      return 'nota registrada no radar do dono — atualize quando mudar de etapa'
    },
    notifyMaestro: (id, text) => {
      // PM e orquestrador compartilham role='maestro'. Quando o remetente é o
      // orquestrador, o destino correto é o PM (evento de projeto), não ele
      // próprio; actor distinto evita a supressão de eco do Hub.
      if (id.role === 'maestro' && id.missionId) {
        const mission = missions.get(id.missionId)
        hub.publish(
          {
            projectId: id.projectId,
            kind: 'info',
            text: `(do orquestrador da missão "${mission?.title ?? id.missionId}" · pane ${id.paneId}) ${text}`,
            actor: 'orchestrator',
            urgent: true
          },
          {
            excludePaneId: id.paneId,
            sourcePaneId: id.paneId,
            communicationKind: 'message',
            correlationId: randomUUID()
          }
        )
        return 'aviso enviado ao Maestro (PM) do projeto — a resposta chega no seu terminal como linha "[synkora]"'
      }
      hub.publish(
        {
          projectId: id.projectId,
          missionId: id.missionId,
          kind: 'info',
          text: `(de ${id.role} · pane ${id.paneId}) ${text}`,
          actor: id.role,
          urgent: true
        },
        {
          excludePaneId: id.paneId,
          sourcePaneId: id.paneId,
          communicationKind: 'message',
          correlationId: randomUUID()
        }
      )
      // Nomeia o destinatário CERTO (bug de terminologia: o dev anunciava
      // "enviado ao Maestro" quando o alvo era o ORQUESTRADOR da missão).
      return id.missionId
        ? 'aviso enviado ao ORQUESTRADOR da sua missão — se foi pedido de conselho, a resposta chega no seu terminal como linha "[synkora]"'
        : id.role === 'maestro'
          ? 'você já é o Maestro (PM) deste projeto'
          : 'aviso enviado ao Maestro (PM) do projeto — se foi pedido de conselho, a resposta chega no seu terminal como linha "[synkora]"'
    },
    // Panes do escopo do chamador, com paneId — é o que permite ao
    // orquestrador FALAR com o QA/dev de fase (reclamação real 2026-07-29:
    // "não consigo mandar recado pro pane do QA — o app não expõe o
    // identificador dele").
    listPanes: (id) => {
      if (id.role !== 'maestro')
        return 'só o Maestro/orquestrador lista panes — devs acompanham ajudantes via list_helpers'
      const mine = hub
        .panesOf(id.projectId)
        .filter((p) => p.paneId !== id.paneId)
        .filter((p) => (id.missionId ? p.missionId === id.missionId : true))
      if (!mine.length) return 'nenhum pane aberto no seu escopo agora'
      const lines = mine.map((p) => {
        const task = p.taskId ? tasks.get(p.taskId) : undefined
        const state = !ptys.has(p.paneId)
          ? 'morto'
          : ptys.isIdle(p.paneId, 4000)
            ? 'ocioso'
            : 'trabalhando'
        const who =
          p.role === 'ajudante'
            ? `ajudante (do pane ${p.delegatorPaneId ?? '?'})`
            : (p.role ?? 'pane')
        return `- paneId ${p.paneId} · ${who}${task ? ` · card "${task.title}"` : ''} · seat ${seats.get(p.seatId ?? '')?.name ?? '?'} · ${state}`
      })
      return (
        `Panes do seu escopo:\n${lines.join('\n')}\n` +
        `Fale com qualquer um via notify_pane {paneId, text} — EXCETO ajudantes (quem fala com ajudante é o dev que o abriu).`
      )
    },
    notifyPane: async (id, wanted, msg) => {
      if (id.role !== 'maestro')
        return 'apenas o Maestro/orquestrador envia linhas diretas a panes (você recebe as respostas dele)'
      // Resolução em 3 passos — paneId vivo > lápide do paneId (mesmo
      // card+papel vivo) > taskId+role direto. O CARD é o endereço estável;
      // paneId tem churn de minutos (3 ids para o mesmo dev em 4min no caso
      // real de 05/08 — o orquestrador usou o velho mesmo com o novo no
      // evento; bookkeeping de máquina não se joga no LLM).
      let target = wanted.paneId ? hub.identityByPane(wanted.paneId) : undefined
      let redirected = false
      if (!target) {
        const tomb = wanted.paneId ? hub.tombstoneOf(wanted.paneId) : undefined
        const stableTaskId = wanted.taskId ?? tomb?.taskId
        const stableRole = wanted.role ?? tomb?.role
        if (
          stableTaskId &&
          stableRole &&
          stableRole !== 'ajudante' &&
          stableRole !== 'maestro' &&
          stableRole !== 'livre'
        ) {
          target = hub
            .panesOf(id.projectId)
            .find((p) => p.taskId === stableTaskId && p.role === stableRole && ptys.has(p.paneId))
          redirected = Boolean(target && wanted.paneId && target.paneId !== wanted.paneId)
        }
      }
      const paneId = target?.paneId ?? wanted.paneId ?? ''
      if (!target || target.projectId !== id.projectId)
        return 'pane não encontrado neste projeto (ele pode ter fechado — endereço estável: notify_pane {taskId, role}; ou veja list_panes)'
      if (id.missionId && target.missionId !== id.missionId)
        return 'esse pane não é da sua missão'
      // Decisão do usuário (2026-07-29): o orquestrador fala com QUALQUER pane
      // da missão dele — MENOS ajudante; ajudante é território do dev que o
      // abriu (a cadeia de comando não se atropela).
      if (target.role === 'ajudante')
        return `ajudante é território do DEV que o abriu — mande a instrução ao dev (pane ${target.delegatorPaneId ?? '?'}) e ele repassa`
      if (!ptys.has(paneId)) return 'o pane de destino já morreu'
      const normalizedMessage = redactSensitiveText(msg.trim())
      if (!normalizedMessage) return 'mensagem vazia — nada foi enviado'
      // A fila de injeção vive em memória. Grave primeiro no transcript do
      // card para que um crash não apague uma correção já aceita pelo sistema.
      if (
        target.taskId &&
        (target.role === 'dev' || target.role === 'review' || target.role === 'qa')
      ) {
        try {
          ensureProjectRuntimeWritable(target.projectId)
          const project = projects.get(target.projectId)
          if (!project) return 'projeto do pane não encontrado — nada foi enviado'
          appendFileSync(
            join(project.path, '.synkora', 'runs', `${target.taskId}.md`),
            `\n\n[synkora · coordenação durável · ${new Date().toISOString()}]\n(${id.missionId ? 'do orquestrador' : 'do Maestro'}) ${normalizedMessage}\n`,
            'utf-8'
          )
        } catch (error) {
          return `não consegui registrar a instrução com segurança; nada foi injetado: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      // Conselho citando modelo MORTO (conversa antiga do orquestrador ainda
      // tinha gpt-5.4-mini no contexto): a correção viaja JUNTO da mensagem —
      // o dev nem tenta o id inválido.
      let extra = ''
      const cited = [...new Set(normalizedMessage.match(/gpt-[\w.-]+/gi) ?? [])]
      if (cited.length > 0) {
        try {
          const pools = await Promise.all(
            seats
              .list()
              .filter((s) => s.cli === 'codex')
              .map((s) => agentModelPool(s).catch(() => []))
          )
          const valid = new Set(pools.flat().map((m) => m.id.toLowerCase()))
          const bad = cited.filter((m) => valid.size > 0 && !valid.has(m.toLowerCase()))
          if (bad.length > 0)
            extra = ` — CORREÇÃO synkora: ${bad.join(', ')} NÃO existe(m); modelos codex válidos: ${[...valid].join(' · ')}`
        } catch {
          // catálogo indisponível — melhor entregar sem verificação
        }
      }
      // URGENTE + origem nomeada: resposta que o pane está esperando de turno
      // encerrado, e o destinatário precisa saber DE QUEM veio.
      const from = id.missionId ? 'do orquestrador' : 'do Maestro'
      const delivered = hub.notifyPaneNow(
        paneId,
        `(${from}) ${normalizedMessage}${extra}`,
        {
          sourcePaneId: id.paneId,
          kind: 'message',
          correlationId: randomUUID()
        }
      )
      if (delivered === 'dead')
        return 'o pane de destino MORREU (fechou/foi reaberto com outro id) — endereço estável: reenvie com notify_pane {taskId, role} e o app resolve o pane vivo sozinho'
      const redirectNote = redirected
        ? ` (o paneId informado estava MORTO; reencaminhei ao pane ATUAL do mesmo card/papel: ${paneId})`
        : ''
      // Retorno HONESTO por via de entrega (F5-F2): o F1 dizia "apareceu no
      // terminal" para mensagem que foi ao correio.
      return delivered === 'mailboxed'
        ? `ENTREGUE NO CORREIO do pane — chega no resultado da PRÓXIMA tool dele (e no check_messages); aviso 📬 dado no terminal. Não reenvie${redirectNote}`
        : delivered === 'injected'
          ? `ENTREGUE AGORA — a linha "[synkora]" já apareceu no terminal do pane${redirectNote}`
          : `na fila (composer do pane ocupado ou outra injeção em curso) — entra no terminal em segundos, não reenvie${redirectNote}`
    }
  }
}
