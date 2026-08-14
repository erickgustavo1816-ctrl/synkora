import type { GuiCliCommand } from './guiApi'

export interface SlashQuery {
  at: number
  query: string
}

/** A consulta fechada continua inerte enquanto for o mesmo token do composer. */
export interface SlashDismissal {
  at: number
  token: string
}

/** '/nome' a partir do name cru das caps. */
export function slashName(command: GuiCliCommand): string {
  return command.name.startsWith('/') ? command.name : `/${command.name}`
}

/**
 * O trecho digitado que abre o menu: barra no começo do texto ou depois de um
 * espaço, até o cursor. Dentro de cerca de código (``` ímpares antes do
 * cursor) NÃO abre — ali a barra é conteúdo, não comando.
 */
export function slashQueryAt(text: string, cursor: number): SlashQuery | null {
  const before = text.slice(0, cursor)
  if ((before.match(/```/gu)?.length ?? 0) % 2 === 1) return null
  const match = /(?:^|\s)(\/\S*)$/u.exec(before)
  if (!match) return null
  const token = match[1]
  return { at: before.length - token.length, query: token.slice(1).toLowerCase() }
}

function slashTokenAt(text: string, at: number): string | null {
  return /^\/\S*/u.exec(text.slice(at))?.[0] ?? null
}

/** Marca o token atual como concluído/dispensado sem alterar o texto. */
export function slashDismissalAt(text: string, at: number): SlashDismissal | null {
  const token = slashTokenAt(text, at)
  return token ? { at, token } : null
}

/**
 * Um cursor atrasado dentro do mesmo comando selecionado não pode reabrir o
 * menu. Ao editar esse token, ou iniciar outro em outra posição, ele volta a
 * ser uma consulta nova e válida.
 */
export function isSlashQueryDismissed(
  dismissal: SlashDismissal | null,
  text: string,
  query: SlashQuery | null
): boolean {
  return Boolean(
    dismissal &&
      query &&
      dismissal.at === query.at &&
      dismissal.token === slashTokenAt(text, query.at)
  )
}

export interface SlashCompletion {
  text: string
  cursor: number
  dismissal: SlashDismissal
}

/**
 * Completa a consulta atual sem enviar nada. A própria conclusão entrega o
 * cursor e a invalidação da consulta para que mouse, Tab e Enter tenham a
 * mesma transição terminal.
 */
export function completeSlashCommand(
  text: string,
  cursor: number,
  command: GuiCliCommand
): SlashCompletion | null {
  const query = slashQueryAt(text, cursor)
  if (!query) return null

  const before = text.slice(0, query.at)
  const after = text.slice(cursor)
  const inserted = `${slashName(command)} `
  const next = `${before}${inserted}${after}`
  const dismissal = slashDismissalAt(next, query.at)
  if (!dismissal) return null

  return {
    text: next,
    cursor: before.length + inserted.length,
    dismissal
  }
}

/**
 * Filtro em três degraus (mesma regra do fork): prefixo do nome primeiro —
 * é o que a pessoa está tentando completar —, depois nome contendo, e só
 * então descrição. Consulta com ':' (comando de plugin) para no prefixo.
 */
export function filterSlashCommands(
  commands: GuiCliCommand[],
  query: string
): GuiCliCommand[] {
  if (!query) return commands
  const byPrefix = commands.filter((c) => slashName(c).slice(1).toLowerCase().startsWith(query))
  if (byPrefix.length || query.includes(':')) return byPrefix
  const byName = commands.filter((c) => slashName(c).toLowerCase().includes(query))
  if (byName.length) return byName
  return commands.filter((c) => (c.description ?? '').toLowerCase().includes(query))
}
