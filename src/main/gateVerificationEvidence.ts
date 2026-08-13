export interface GateVerificationEvidence {
  /** Conclusão curta derivada da evidência, não uma lista de atividades. */
  summary: string
  /** Superfícies/rotas/famílias realmente verificadas. */
  surfaces?: string[]
  /** Estados reais exercitados (padrão, vazio, erro, conteúdo longo etc.). */
  states?: string[]
  /** Tamanhos renderizados, por exemplo `390x844` e `1440x900`. */
  viewports?: string[]
  /** Observações verificáveis: screenshot, locator, URL/runtime ou arquivo/linha. */
  observations: string[]
}

export interface GateVerificationEvidenceInput {
  status: 'done' | 'aprovada' | 'reprovada' | 'bloqueada'
  phase: 'dev' | 'review' | 'qa'
  uiWork: boolean
  evidence?: GateVerificationEvidence
  /** Rodada QUICK (ajuste rápido do dono, 2026-08-12): evidência do DELTA —
   * summary + observação + a superfície mudada bastam; o catálogo completo de
   * states/viewports é exigência de rodada cheia. */
  quickRound?: boolean
}

export function validateGateVerificationEvidence(
  input: GateVerificationEvidenceInput
): { ok: true } | { ok: false; reason: string } {
  if (input.status === 'bloqueada') return { ok: true }

  const decisiveGate =
    (input.phase === 'review' || input.phase === 'qa') &&
    (input.status === 'aprovada' || input.status === 'reprovada')
  const visualDelivery = input.uiWork && (input.phase === 'dev' || input.phase === 'qa')
  if (!decisiveGate && !visualDelivery) return { ok: true }

  const evidence = input.evidence
  if (!evidence?.summary.trim() || !evidence.observations?.some((item) => item.trim())) {
    return {
      ok: false,
      reason: 'verificationEvidence precisa de summary e ao menos uma observacao verificavel'
    }
  }

  if (visualDelivery) {
    const missing = input.quickRound
      ? [!evidence.surfaces?.some((item) => item.trim()) ? 'surfaces' : undefined].filter(Boolean)
      : [
          !evidence.surfaces?.some((item) => item.trim()) ? 'surfaces' : undefined,
          !evidence.states?.some((item) => item.trim()) ? 'states' : undefined,
          !evidence.viewports?.some((item) => item.trim()) ? 'viewports' : undefined
        ].filter(Boolean)
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `verificationEvidence de UI precisa registrar ${missing.join(', ')}`
      }
    }
  }

  return { ok: true }
}
