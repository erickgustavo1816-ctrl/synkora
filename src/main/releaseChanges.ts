import type { ReleaseChangeRecord, ReleaseChangesSignal, ReleaseSaveInput } from '../shared/releaseChanges'
import type { ReleaseChangeTarget } from './releaseChangesGit'
import type { ReleaseChangesStore } from './releaseChangesStore'
// @ts-expect-error Node strip-types requires the extension.
import { redactSensitiveText } from './securityRedaction.ts'

export interface ReleaseChangeScope extends ReleaseChangeTarget {
  projectId: string
  versionId: string
  missionId: string
}

type ScopeResult = { scope: ReleaseChangeScope; error?: never } | { error: string; scope?: never }
interface Identity { role: string; projectId: string; missionId?: string }

export interface ReleaseChangesDeps {
  resolve(identity: Identity): ScopeResult
  store: ReleaseChangesStore
  locks: Set<string>
  probe: typeof import('./releaseChangesGit')['releaseChangesProbe']
  prepare(target: ReleaseChangeTarget, input: ReleaseSaveInput): Promise<ReturnType<typeof import('./releaseChangesGit')['prepareReleaseChange']>>
  apply(target: ReleaseChangeTarget, record: ReleaseChangeRecord): Promise<ReturnType<typeof import('./releaseChangesGit')['applyReleaseChange']>>
  push(target: ReleaseChangeTarget, expectedHead: string, savedShas: string[]): Promise<ReturnType<typeof import('./releaseChangesGit')['pushReleaseChanges']>>
  changed(projectId: string): void
  audit(event: string, scope: ReleaseChangeScope, changeId?: string): void
}

const recovery = 'leia release_status e repita release_save com o mesmo requestId; o recibo preserva o commit'

export function buildReleaseChanges(deps: ReleaseChangesDeps) {
  function inspect(identity: Identity): ReleaseChangesSignal {
    try {
      const resolved = deps.resolve(identity)
      if (!resolved.scope) return { pending: false, error: resolved.error }
      const scope = resolved.scope
      const records = deps.store.list(scope.projectId, scope.versionId)
      const probe = deps.probe(scope.cwd)
      const pending = deps.locks.has(scope.projectId) || records.some((r) => r.state === 'prepared')
      const pendingPush = probe.hasOrigin === true && records.some((r) =>
        r.phase === 'after-release' && r.state === 'saved' && !r.pushedAt)
      const lines = [
        `CORREÇÕES: ${scope.phase === 'before-release' ? 'antes da subida' : 'após a subida'} · pasta ${scope.cwd} · branch ${scope.branch}.`,
        `HEAD PARA release_save/release_push: ${probe.head ?? '(indisponível)'}.`,
        `ARQUIVOS LOCAIS: ${probe.files.length ? probe.files.slice(0, 100).join(' · ') : 'nenhum'}${probe.files.length > 100 ? ' · lista limitada a 100; confira git status' : ''}.`,
        ...records.map((record) =>
          `CORREÇÃO ${record.id}: ${record.summary} · ${record.state === 'saved' ? 'salva' : record.state === 'prepared' ? 'recibo pendente' : 'não aplicada'} · ${record.sha} · ${record.pushedAt ? 'push confirmado' : record.phase === 'before-release' ? 'na branch da versão' : 'push não confirmado'}\n` +
          `  arquivos: ${record.files.join(' · ')}\n  motivo: ${record.reason}\n  validação informada pelo agente: ${record.validation}`),
        ...(pending ? [`PENDÊNCIA: ${recovery}.`] : [])
      ]
      return { dirty: probe.dirty, pending, pendingPush, text: redactSensitiveText(lines.join('\n')),
        ...(probe.error ? { error: probe.error } : probe.branch !== scope.branch ?
          { error: 'branch atual diverge da release; restaure a branch pelo fluxo do Synkora e leia release_status' } : {}) }
    } catch {
      return { pending: true, error: 'não consegui ler o histórico de correções; restaure o backup do Synkora e leia release_status' }
    }
  }

  function receiptText(record: ReleaseChangeRecord): string {
    return `CORREÇÃO SALVA: ${record.summary} · commit ${record.sha} · registro ${record.id}.\n` +
      `Arquivos: ${record.files.join(' · ')}. Histórico vinculado à release.\n` +
      (record.phase === 'before-release'
        ? 'PRÓXIMO PASSO: leia release_status e prossiga com release_run quando livre.'
        : 'PRÓXIMO PASSO: leia release_status e use release_push para enviar. Se o produto entrega instalador, avalie reconstrução/publicação com a autorização do dono; salvar código não atualiza um instalador já publicado.')
  }

  async function save(identity: Identity, input: ReleaseSaveInput): Promise<string> {
    const resolved = deps.resolve(identity)
    if (!resolved.scope) return resolved.error
    const scope = resolved.scope
    if (deps.locks.has(scope.projectId)) return 'uma operação de release está em andamento; aguarde e leia release_status'
    deps.locks.add(scope.projectId)
    try {
      if (!/^[A-Za-z0-9_-]{1,80}$/u.test(input.requestId) || !/^[a-f0-9]{40,64}$/u.test(input.expectedHead) ||
        !Array.isArray(input.files) || !input.files.length || input.files.length > 100 ||
        input.files.some((file) => typeof file !== 'string') ||
        [input.summary, input.reason, input.validation].some((value) => typeof value !== 'string' || !value.trim() || value.length > 2000) ||
        /[\r\n]/u.test(input.summary) || input.summary.length > 160)
        return 'release_save exige requestId estável, HEAD completo, arquivos explícitos, resumo curto, motivo e validação realizada'
      const clean = { ...input, summary: redactSensitiveText(input.summary.trim()),
        reason: redactSensitiveText(input.reason.trim()), validation: redactSensitiveText(input.validation.trim()) }
      const records = deps.store.list(scope.projectId, scope.versionId)
      let record = records.find((r) => r.id === input.requestId)
      if (record) {
        if (record.missionId !== scope.missionId || record.summary !== clean.summary || record.reason !== clean.reason ||
          record.validation !== clean.validation || record.parentHead !== input.expectedHead ||
          JSON.stringify(record.files) !== JSON.stringify(input.files.map((file) => file.replaceAll('\\', '/')).sort()))
          return 'requestId já pertence a outra seleção/descrição; use os argumentos originais para recuperar ou outro requestId para uma nova correção'
        if (record.state === 'saved') return receiptText(record)
        if (record.state === 'not-applied') return 'operação anterior não aplicada; leia release_status, revise e use outro requestId em release_save'
        if (record.branch !== scope.branch || record.phase !== scope.phase)
          return 'recibo pertence à etapa anterior; confira o histórico da versão com o dono antes de continuar'
      } else {
        if (records.some((r) => r.state === 'prepared')) return `há uma correção aguardando reconciliação: ${recovery}`
        const prepared = await deps.prepare(scope, clean)
        if (!prepared.ok) { deps.audit('release-save-refused', scope, input.requestId); return prepared.error }
        record = deps.store.prepare({ id: input.requestId, projectId: scope.projectId, versionId: scope.versionId,
          missionId: scope.missionId, at: new Date().toISOString(), phase: scope.phase, branch: scope.branch,
          parentHead: input.expectedHead, sha: prepared.sha, files: prepared.files,
          summary: clean.summary, reason: clean.reason, validation: clean.validation, state: 'prepared' })
      }
      const result = await deps.apply(scope, record)
      deps.store.update(record, { state: result.state })
      deps.changed(scope.projectId)
      deps.audit(result.state === 'saved' ? 'release-change-saved' : 'release-change-pending', scope, record.id)
      return result.state === 'saved' ? receiptText(record) : result.error ?? recovery
    } catch {
      return `não confirmei a gravação; ${recovery}. Se o histórico estiver ilegível, restaure o backup antes de continuar`
    } finally { deps.locks.delete(scope.projectId) }
  }

  async function push(identity: Identity, expectedHead: string): Promise<string> {
    const resolved = deps.resolve(identity)
    if (!resolved.scope) return resolved.error
    const scope = resolved.scope
    if (scope.phase !== 'after-release') return 'a versão ainda não subiu; leia release_status e use release_run antes de release_push'
    if (deps.locks.has(scope.projectId)) return 'uma operação de release está em andamento; aguarde e leia release_status'
    deps.locks.add(scope.projectId)
    try {
      const records = deps.store.list(scope.projectId, scope.versionId)
      if (records.some((r) => r.state === 'prepared')) return `há uma correção pendente: ${recovery}`
      const result = await deps.push(scope, expectedHead, records.filter((r) => r.state === 'saved').map((r) => r.sha))
      if (!result.ok) { deps.audit('release-push-refused', scope); return result.error ?? 'não confirmei o push; leia release_status' }
      if (!result.localOnly) for (const record of records) {
        if (record.state === 'saved' && record.phase === 'after-release' && result.includedShas?.includes(record.sha))
          deps.store.update(record, { pushedAt: new Date().toISOString() })
      }
      deps.changed(scope.projectId)
      deps.audit(result.localOnly ? 'release-push-local-only' : 'release-changes-pushed', scope)
      return result.localOnly ? 'sem origin configurado: correções salvas localmente. Confira a entrega e use release_done.' :
        'PUSH CONFIRMADO: principal enviada ao origin. Isso não confirma publicação do instalador; confira a entrega e use release_done quando concluída.'
    } catch {
      return 'não confirmei o recibo do envio; os commits locais foram preservados. Leia release_status e repita release_push'
    } finally { deps.locks.delete(scope.projectId) }
  }

  return { inspect, save, push }
}
