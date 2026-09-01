/**
 * PORTA POR AJUDANTE — a reserva do spawn (D4 do design vinculante
 * `.synkora/reports/DESIGN_BROWSER_ABAS_POR_IDENTIDADE_2026-09-01.md`).
 *
 * A COLISÃO MEDIDA (missão 86a05c06, 01/09): o único ajudante que dirigiu o
 * browser embutido dividiu a MESMA aba com o dev — a URL alternou entre a porta
 * dele (8791) e as do dev (8159/8148/8163) em minutos, três leituras do ajudante
 * caíram na página do outro e o dev o cancelou aos 20 min. Ordem do dono na
 * mesma sessão: "cada um na sua aba, na sua porta". A aba é da fatia A; a PORTA
 * é este módulo.
 *
 * POR QUE UM POOL, E NÃO UMA SONDAGEM: node não tem "achar porta livre"
 * síncrono, e o spawn do ajudante é síncrono (o adaptador devolve o processo na
 * hora). Sondar com `net.listen(0)` antes de cada partida transformaria a
 * reserva em promessa — e a promessa chegaria depois do argv, que é lido no
 * nascimento. Então a régua é o POOL determinístico `47100..47499`, e o que ele
 * não garante a PERSONA cobre: "se a porta estiver ocupada, pegue a seguinte e
 * DIGA qual". Sondagem real fica anotada como pendência do design.
 *
 * NODE PURO de propósito (nem electron, nem disco): o registro é lido pelo
 * adaptador da delegação (`guiDelegationWiring`) e pelo mapa de portas do
 * "▶ testar" (`paneLifecycle.harnessPortsInUse`), e as duas pontas se provam em
 * suíte sem app. A dependência inversa não existe: o paneLifecycle importa
 * daqui, este módulo não importa de ninguém além do TIPO da ficha do mapa.
 */
import type { PortUseEntry } from './portMap'

/**
 * A FAIXA. Alta o bastante para não brigar com o que produto nenhum usa por
 * convenção (3000/4200/5173/8080/8791 do caso real) e larga o bastante para uma
 * frota inteira do dono com folga de sobra.
 */
export const GUI_HELPER_PORT_BASE = 47100
export const GUI_HELPER_PORT_SPAN = 400

/** O que a ficha do mapa precisa saber sobre o dono da porta. Tudo opcional
 *  menos o projeto, porque é por ele que o mapa filtra: o modal do "▶ testar" é
 *  de UM universo, e porta de outro projeto ali seria ruído. */
export interface GuiHelperPortMeta {
  projectId: string
  /** Apelido do ajudante — o que o dono lê no mapa. */
  name?: string
  missionId?: string
  delegatorPaneId?: string
}

export interface GuiHelperPortRegistry {
  /**
   * A porta DESTE ajudante. IDEMPOTENTE por `helperId`: a re-tentativa do motor
   * (529 na partida) e o `helper_resume` passam por aqui de novo e recebem a
   * MESMA porta — servidor que o ajudante deixou pinado continua batendo.
   *
   * `taken` é o que mais alguém já ocupa (o mapa do harness, o servidor de
   * teste do dono): a reserva salta essas portas do mesmo jeito que salta as
   * já reservadas. NUNCA lança — pool cheio devolve candidato e a ficha avisa.
   */
  reserve(helperId: string, meta: GuiHelperPortMeta, taken?: Iterable<number>): number
  /** O desfecho devolve a porta à faixa (o par exato do `reserve`). */
  release(helperId: string): void
  portOf(helperId: string): number | undefined
  /** As fichas deste projeto para o mapa de portas da casa (`formatPortMap`). */
  entries(projectId: string): PortUseEntry[]
}

interface GuiHelperPortRecord {
  port: number
  meta: GuiHelperPortMeta
  /** Pool cheio no instante da reserva: a porta pode estar repetida, e o mapa
   *  do dono tem de dizer isso em vez de fingir exclusividade. */
  crowded: boolean
}

/**
 * FNV-1a de 32 bits sobre o id. A porta é função do AJUDANTE, não da ordem de
 * chegada: quem sai e volta (o `helper_resume`) reencontra o próprio endereço
 * mesmo que a frota inteira tenha girado no meio.
 */
function helperPortSeed(helperId: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < helperId.length; i += 1) {
    hash ^= helperId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash % GUI_HELPER_PORT_SPAN
}

/** O id curto é a régua da casa para nomear ajudante em texto do dono (a mesma
 *  do `missionShortId` e do rótulo da aba): uuid inteiro não cabe na linha. */
function helperPortOwner(helperId: string, record: GuiHelperPortRecord): string {
  const name = record.meta.name?.trim()
  const who = name ? `ajudante "${name}"` : `ajudante ${helperId.slice(0, 8) || '—'}`
  return record.crowded ? `${who} (pool cheio — a porta pode repetir)` : who
}

export function createGuiHelperPortRegistry(): GuiHelperPortRegistry {
  // FONTE ÚNICA: as portas ocupadas se derivam daqui a cada reserva. Um segundo
  // Set de "em uso" seria uma segunda verdade sobre a mesma faixa, e frota do
  // dono cabe folgada numa varredura de dezenas de fichas.
  const byHelper = new Map<string, GuiHelperPortRecord>()

  return {
    reserve(helperId, meta, taken) {
      const existing = byHelper.get(helperId)
      if (existing) {
        // A ficha se atualiza (o apelido pode ter chegado depois), a PORTA não:
        // mover a porta de um ajudante vivo é derrubar o servidor dele.
        existing.meta = meta
        return existing.port
      }
      const blocked = new Set<number>()
      for (const record of byHelper.values()) blocked.add(record.port)
      if (taken) {
        for (const port of taken) if (Number.isInteger(port)) blocked.add(port)
      }
      const seed = helperPortSeed(helperId)
      // O primeiro candidato é o do id; se ele estiver ocupado, anda para a
      // frente DENTRO da faixa (e dá a volta) — nunca sai dela.
      let port = GUI_HELPER_PORT_BASE + seed
      let crowded = true
      for (let step = 0; step < GUI_HELPER_PORT_SPAN; step += 1) {
        const candidate = GUI_HELPER_PORT_BASE + ((seed + step) % GUI_HELPER_PORT_SPAN)
        if (blocked.has(candidate)) continue
        port = candidate
        crowded = false
        break
      }
      byHelper.set(helperId, { port, meta, crowded })
      return port
    },
    release(helperId) {
      byHelper.delete(helperId)
    },
    portOf(helperId) {
      return byHelper.get(helperId)?.port
    },
    entries(projectId) {
      const rows: PortUseEntry[] = []
      for (const [helperId, record] of byHelper) {
        if (record.meta.projectId !== projectId) continue
        rows.push({
          port: record.port,
          // PEDIDA, como o servidor de teste do dono: o produto pode ter pinado
          // outra porta (strictPort na config), e o mapa não mente sobre isso.
          requested: true,
          owner: helperPortOwner(helperId, record)
        })
      }
      return rows.sort((a, b) => (a.port ?? 0) - (b.port ?? 0))
    }
  }
}

/**
 * O REGISTRO DO PROCESSO. Um só, porque as duas pontas falam da MESMA faixa: o
 * adaptador da delegação reserva no spawn e o mapa do "▶ testar" lê. Dois
 * registros seriam duas verdades sobre as mesmas 400 portas.
 */
export const guiHelperPorts: GuiHelperPortRegistry = createGuiHelperPortRegistry()
