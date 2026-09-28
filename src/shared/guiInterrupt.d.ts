export type GuiInterruptTarget = 'button' | 'textarea' | 'input' | 'contenteditable' | 'link' | 'other' | 'none'

export interface GuiInterruptOrigin {
  source: 'stop-button' | 'escape' | 'owner-message-handoff' | 'owner-message-force' | 'unknown'
  eventType?: 'click' | 'keydown'
  isTrusted?: boolean
  repeat?: boolean
  defaultPrevented?: boolean
  target?: GuiInterruptTarget
  focus?: GuiInterruptTarget
}
