/**
 * DE QUEM É A ABA — e quem está com o volante agora (design
 * `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`, D1/D2).
 *
 * Módulo PURO (sem Electron, sem MCP): é o único lugar onde o conceito de DONO
 * DE ABA existe, e por isso os dois lados da fronteira o IMPORTAM em vez de
 * espelhá-lo — o motor (`./browserPane`) e o kit de tools do agente
 * (`./guiBrowserTools`). Espelho de tipo puro entre irmãos que já compilam
 * juntos seria uma segunda verdade sem ganho nenhum; o espelho DECLARADO que
 * continua valendo é o do preload/renderer, que não pode importar do main.
 *
 * ——— por que a aba ganhou dono ———
 * Até 01/09 o browser embutido era UM painel por missão com UMA aba ativa, e
 * TODA tool operava nela (`withSession` → `activeTab`). A medição da missão
 * 86a05c06 (01/09) mostrou o preço: o único ajudante que dirigiu o browser
 * (`finish_ui_review`, 48 chamadas) dividiu a MESMA aba com o dev — a URL
 * alternou entre a porta 8791 (dele) e as 8159/8148/8163 (do dev) em minutos,
 * TRÊS leituras dele caíram na página do dev, e o dev o cancelou aos 20 min.
 * Desde o browser (29/08): 1 de 72 ajudantes claude usaram; 0 de 91 codex.
 * Aba por identidade é a cura — e ela começa por saber de quem é cada aba.
 *
 * ——— e por que o ⚡ mora aqui também ———
 * "Quem está dirigindo" é a mesma pergunta que "de quem é isto", só que no
 * tempo presente: o indicador do chrome existe para o dono saber QUEM mexeu na
 * página que ele está olhando. O decaimento é o mesmo desde a H1 — a última
 * tool segura o ⚡ por ~2s, senão ele pisca entre chamadas encadeadas de um QA
 * de vinte passos.
 */

/** As quatro origens possíveis de uma aba. `agent` é a identidade de agente sem
 *  classificação — nunca um chute: o harness diz o papel, e o que ele não
 *  souber classificar entra como agente com o próprio papel de rótulo. */
export type BrowserTabOwnerKind = 'user' | 'dev' | 'helper' | 'agent'

export interface BrowserTabOwner {
  kind: BrowserTabOwnerKind
  /** O que o dono LÊ na aba (o nome do ajudante, `dev`, `dono`). */
  label: string
  /** A identidade dona da aba. Ausente nas abas do DONO: o gesto dele não vem
   *  de pane nenhum, e é por isso que `tabOf` jamais devolve uma aba do dono a
   *  um agente que pediu a sua. */
  paneId?: string
}

/** O gesto do dono (barra de URL, `+`, pop-up de uma página) nasce assim. */
export const BROWSER_USER_TAB_OWNER: BrowserTabOwner = Object.freeze({
  kind: 'user',
  label: 'dono'
})

/** ⚡ do chrome: a última tool de ação segura o indicador por ~2s. */
export const BROWSER_AGENT_DRIVING_DECAY_MS = 2000

/**
 * O rótulo do dono em UMA linha, do jeito que o agente lê na lista de abas.
 * O ajudante ganha aspas e a palavra "ajudante" porque o nome dele é apelido de
 * delegação (`inv-brand`) e sozinho pareceria um endereço.
 */
export function browserTabOwnerLabel(owner: BrowserTabOwner): string {
  const label = owner.label.trim() || owner.kind
  return owner.kind === 'helper' ? `ajudante "${label}"` : label
}

/** A aba É desta identidade? Sem `paneId` (aba do dono) a resposta é sempre
 *  não — o dono não é uma identidade de agente. */
export function browserTabOwnedBy(owner: BrowserTabOwner, ownerPaneId: string): boolean {
  return owner.paneId !== undefined && owner.paneId === ownerPaneId
}

/** O portador do ⚡: a missão inteira tem um, e cada ABA tem o seu (D2). */
export interface BrowserDrivingFlag {
  driving: boolean
  driveTimer: NodeJS.Timeout | null
}

/**
 * Acende/re-arma o ⚡ com o decaimento da casa.
 *
 * `true` acende e re-arma; `false` **NÃO apaga na hora** — o indicador segura
 * ~2s depois da última tool para não piscar entre chamadas encadeadas. Um `false`
 * sobre um flag já apagado é no-op (nunca acende relógio à toa), e `onChange` só
 * é chamado quando o valor VIRA — o repaint do dock é caro e o agente manda um
 * evento por passo.
 */
export function armBrowserDriving(
  flag: BrowserDrivingFlag,
  driving: boolean,
  onChange: () => void
): void {
  const was = flag.driving
  if (!driving && !was) return
  if (driving) flag.driving = true
  if (flag.driveTimer) clearTimeout(flag.driveTimer)
  flag.driveTimer = setTimeout(() => {
    flag.driveTimer = null
    if (!flag.driving) return
    flag.driving = false
    onChange()
  }, BROWSER_AGENT_DRIVING_DECAY_MS)
  flag.driveTimer.unref?.()
  if (flag.driving !== was) onChange()
}

/** Para o teardown: um flag que morre leva o relógio junto (senão o timer
 *  seguraria uma referência viva de uma aba já fechada). */
export function clearBrowserDriving(flag: BrowserDrivingFlag): void {
  if (flag.driveTimer) clearTimeout(flag.driveTimer)
  flag.driveTimer = null
  flag.driving = false
}
