import { redactSensitiveText } from './securityRedaction'

export type ManualSecurityValidationDecision = 'approved' | 'waived'
/** 'security-gate' = resolvida pelo GATE ESPECIALISTA (decisão do usuário,
 *  2026-08-04: "não sou especialista em segurança — ou retira, ou um
 *  especialista olha o código"). O humano segue decidindo produto/integração. */
export type ManualSecurityValidationActor = 'user' | 'security-gate'

export type ManualSecurityValidation =
  | {
      required: false
      status: 'not_required'
    }
  | {
      required: true
      status: 'pending'
    }
  | {
      required: true
      status: ManualSecurityValidationDecision
      actor: ManualSecurityValidationActor
      resolvedAt: string
      evidence: string
    }

export interface ManualSecurityValidationPlanLike {
  /** Compatibilidade com planos criados antes do estado tipado. */
  manualSecurityValidationRequired?: boolean
  manualSecurityValidation?: unknown
  /** Campos novos são opcionais para planos persistidos antes da policy v2. */
  risk?: unknown
  riskSurfaces?: unknown
}

export const MANUAL_SECURITY_VALIDATION_EVIDENCE_MAX = 1_200

/** Estado inicial persistido junto do plano. */
export function initialManualSecurityValidation(required: boolean): ManualSecurityValidation {
  return required
    ? { required: true, status: 'pending' }
    : { required: false, status: 'not_required' }
}

/**
 * Normaliza inclusive dados antigos/corrompidos. Uma resolucao sem ator, data
 * ou evidencia volta a pending: metadado incompleto nunca libera integracao.
 */
export interface ManualSecurityValidationOptions {
  /** O DONO do projeto liberou superfície sensível (switch "sensível ok" do
   *  board, 2026-08-04): a dispensa com justificativa passa a valer também em
   *  plano sensível — sem o switch, a regra estrita continua. */
  sensitiveWaiverAllowed?: boolean
}

export function manualSecurityValidationOf(
  plan: ManualSecurityValidationPlanLike | undefined,
  options: ManualSecurityValidationOptions = {}
): ManualSecurityValidation {
  if (!plan) return initialManualSecurityValidation(false)
  const value = plan.manualSecurityValidation
  const legacyRequired = plan.manualSecurityValidationRequired === true
  if (!value || typeof value !== 'object') {
    return initialManualSecurityValidation(legacyRequired)
  }

  const candidate = value as Record<string, unknown>
  const required = legacyRequired || candidate.required === true
  if (!required) return initialManualSecurityValidation(false)
  const status = candidate.status
  if (status !== 'approved' && status !== 'waived') {
    return initialManualSecurityValidation(true)
  }
  const evidence = typeof candidate.evidence === 'string' ? candidate.evidence.trim() : ''
  const resolvedAt = typeof candidate.resolvedAt === 'string' ? candidate.resolvedAt : ''
  const actor =
    candidate.actor === 'user' || candidate.actor === 'security-gate'
      ? candidate.actor
      : undefined
  if (!actor || !evidence || !Number.isFinite(Date.parse(resolvedAt))) {
    return initialManualSecurityValidation(true)
  }
  const sensitivePlan =
    plan.risk === 'high' ||
    (Array.isArray(plan.riskSurfaces) &&
      plan.riskSurfaces.some((surface) => typeof surface === 'string' && surface.trim()))
  // Dispensas antigas continuam legíveis, mas uma policy nova não pode usar
  // esse estado legado para liberar trabalho hoje classificado como sensível —
  // SALVO quando o dono do projeto liberou explicitamente (switch do board).
  if (status === 'waived' && sensitivePlan && !options.sensitiveWaiverAllowed)
    return initialManualSecurityValidation(true)
  return {
    required: true,
    status,
    actor,
    resolvedAt,
    evidence
  }
}

export function manualSecurityValidationPending(
  plan: ManualSecurityValidationPlanLike | undefined,
  options: ManualSecurityValidationOptions = {}
): boolean {
  // MODO LEVE do projeto (switch "sensível ok", 2026-08-04): a exigência de
  // validação humana por plano fica dispensada por decisão do dono — planos
  // antigos com status 'pending' param de bloquear conclusão/integração.
  if (options.sensitiveWaiverAllowed) return false
  return manualSecurityValidationOf(plan, options).status === 'pending'
}

export function resolveManualSecurityValidation(
  plan: ManualSecurityValidationPlanLike | undefined,
  decision: unknown,
  rawEvidence: unknown,
  resolvedAt = new Date().toISOString(),
  options: ManualSecurityValidationOptions = {}
): ManualSecurityValidation {
  const current = manualSecurityValidationOf(plan, options)
  if (!current.required) {
    throw new Error('Este plano nao exige validacao humana de seguranca.')
  }
  if (decision !== 'approved' && decision !== 'waived') {
    throw new Error('Decisao de validacao humana invalida.')
  }
  const highRisk = plan?.risk === 'high'
  const sensitiveSurfaces = Array.isArray(plan?.riskSurfaces)
    ? plan.riskSurfaces.filter((surface): surface is string => typeof surface === 'string')
    : []
  if (
    decision === 'waived' &&
    (highRisk || sensitiveSurfaces.length > 0) &&
    !options.sensitiveWaiverAllowed
  ) {
    throw new Error(
      'Validacao de seguranca sensivel nao pode ser dispensada com a protecao de superficie sensivel ligada. Registre a evidencia humana e aprove, ou libere a superficie sensivel no switch do board e dispense com justificativa.'
    )
  }
  if (typeof rawEvidence !== 'string') {
    throw new Error('Informe a evidencia ou justificativa da decisao.')
  }
  const evidence = redactSensitiveText(rawEvidence)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MANUAL_SECURITY_VALIDATION_EVIDENCE_MAX)
  if (evidence.length < 20) {
    throw new Error(
      'Informe uma evidencia verificavel com ao menos 20 caracteres (fluxo, ambiente e resultado).'
    )
  }
  if (!Number.isFinite(Date.parse(resolvedAt))) {
    throw new Error('Data de resolucao da validacao humana invalida.')
  }
  return {
    required: true,
    status: decision,
    actor: 'user',
    resolvedAt,
    evidence
  }
}
