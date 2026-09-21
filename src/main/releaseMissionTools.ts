import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { PaneIdentity } from './hub'

export const RELEASE_MISSION_TOOL_NAMES = ['release_missions', 'release_mission_update', 'release_mission_remove'] as const

export interface ReleaseMissionSelection {
  missionId: string
  expectedRevision: string
}

export interface ReleaseMissionUpdate extends ReleaseMissionSelection {
  title?: string
  goal?: string
  scope?: string
  status?: 'ativa' | 'arquivada'
}

export interface ReleaseMissionRemoval extends ReleaseMissionSelection {
  confirmTitle: string
  ownerConfirmed: boolean
}

export interface ReleaseMissionToolkit {
  list(identity: PaneIdentity): string
  update(identity: PaneIdentity, input: ReleaseMissionUpdate): string
  remove(identity: PaneIdentity, input: ReleaseMissionRemoval): Promise<string>
}

export function registerReleaseMissionKit(server: McpServer, kit: ReleaseMissionToolkit | undefined, identity: PaneIdentity): void {
  const reply = (value?: string) => ({ content: [{ type: 'text' as const,
    text: value ?? 'A gestão de missões não está disponível. Reinicie o Synkora e chame release_missions. Nenhuma missão foi alterada.' }] })
  const selection = {
    missionId: z.string().min(1).max(120).describe('ID exato retornado por release_missions'),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u).describe('revisão retornada por release_missions; mudanças concorrentes exigem nova leitura')
  }
  server.registerTool('release_missions', {
    description: 'LISTA as missões do projeto desta Release, com ID, estado e revisão para edição/exclusão. Leia antes de alterar uma missão. A própria Release termina com release_done; integração continua pelo ⇪ do dono.'
  }, () => reply(kit?.list(identity)))
  server.registerTool('release_mission_update', {
    description: 'EDITA título, objetivo e escopo, ou ARQUIVA/REATIVA uma missão deste projeto conforme o pedido do dono. Arquivar interrompe a execução e cancela a espera na fila; preserva a conversa e os arquivos. Não conclui nem integra. Leia release_missions para selecionar o ID e a revisão atuais. Não descarte trabalho apenas para destravar uma publicação.',
    inputSchema: { ...selection, title: z.string().trim().min(1).max(200).optional(),
      goal: z.string().max(4000).optional(), scope: z.string().max(4000).optional(),
      status: z.enum(['ativa', 'arquivada']).optional() }
  }, input => reply(kit?.update(identity, input)))
  server.registerTool('release_mission_remove', {
    description: 'EXCLUI DEFINITIVAMENTE uma missão arquivada ou concluída deste projeto, sua conversa e seu worktree/branch remanescentes pelo fluxo do Synkora. Use SOMENTE quando o dono pediu explicitamente a exclusão dessa missão. Leia release_missions e confira ID, revisão e título. Se estiver ativa, arquive primeiro com release_mission_update dentro da autorização do dono e releia. Nunca exclua a própria Release, missões de outro projeto ou uma integração em andamento. Não apaga os commits já integrados ao produto.',
    inputSchema: { ...selection, confirmTitle: z.string().min(1).max(200).describe('título exato da missão que o dono mandou excluir'),
      ownerConfirmed: z.literal(true).describe('confirma que o dono pediu explicitamente esta exclusão e este alvo; nunca presuma autorização') }
  }, async input => reply(await kit?.remove(identity, input)))
}
