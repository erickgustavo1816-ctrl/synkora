import GuiMarkdown from './GuiMarkdown'

/**
 * O CORPO DO CARTÃO DE PLANO DO SYNKORA (plan_approval, 2026-09-22).
 *
 * O dono decide sobre o que LÊ: o mini-plano mora dentro do cartão, acima da
 * pergunta, e é markdown como o plano do modo plano (GuiPlanCard). Ele existe
 * porque o texto que o agente escreve antes de um cartão pode se perder no
 * canal de raciocínio — o caso medido em 2026-09-21/22 — e o dono via
 * "aprova o plano?" sem plano nenhum.
 */
export default function GuiQuestionPlan({ paneId, plan }: {
  paneId: string
  plan: string
}): React.JSX.Element {
  return (
    <div className="gui-question-plan" data-question-plan="true">
      <div className="gui-question-plan-label">o plano</div>
      <div className="gui-question-plan-body">
        <GuiMarkdown paneId={paneId} text={plan} />
      </div>
    </div>
  )
}
