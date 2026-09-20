import type { GuiPaneSpawn, GuiQueuedDeliveryInput } from './guiSessions'

/** Steering can use only the current executor and permission scope. A raw
 * CLI command or a different snapshot must wait for an idle parent. */
export function canSteerGuiQueuedMessage(
  spawn: GuiPaneSpawn,
  message: GuiQueuedDeliveryInput
): boolean {
  return (
    !message.text.trimStart().startsWith('/') &&
    (spawn.model ?? null) === message.options.model &&
    (spawn.effort ?? null) === message.options.effort &&
    (spawn.permissionMode ?? 'default') === message.options.permissionMode
  )
}
