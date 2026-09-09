import { useLayoutEffect, useState, type RefObject } from 'react'

/** Each entry is the measured width of a progressively more compact footer. */
export function guiComposerFitLevel(available: number, widths: readonly number[]): number {
  const level = widths.findIndex(width => width <= available - 2)
  return level < 0 ? widths.length - 1 : level
}

/** Measure labels even when they are visually collapsed. This lets the footer
 * restore the full wording as soon as it fits, without a breakpoint or flicker. */
export function useGuiComposerFit(ref: RefObject<HTMLDivElement | null>, enabled: boolean): number {
  const [level, setLevel] = useState(0)
  useLayoutEffect(() => {
    const surface = ref.current
    if (!enabled || !surface) return
    const inner = surface.querySelector<HTMLElement>('.gui-composer-inner')
    if (!inner) return
    let stopped = false
    const width = (selector: string): number => inner.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0
    const has = (selector: string): boolean => !!inner.querySelector(selector)
    const measure = (): void => {
      if (stopped || inner.clientWidth === 0) return
      const style = getComputedStyle(inner)
      const available = inner.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const modePad = parseFloat(style.getPropertyValue('--composer-mode-padding')) || 8
      const contextPad = parseFloat(style.getPropertyValue('--composer-context-padding')) || 6
      const gap = parseFloat(style.getPropertyValue('--composer-control-gap')) || 6
      const buttonGap = parseFloat(style.getPropertyValue('--composer-label-gap')) || 6
      const modeGlyph = width('.gui-composer-mode .gui-mode-btn > span:first-child')
      const modeText = width('.gui-composer-mode .gui-mode-text')
      const modeShort = width('.gui-composer-mode .gui-mode-short')
      const modeBase = modeGlyph + modePad * 2 + 2
      const mode = [modeBase + buttonGap + modeText, modeBase + buttonGap + modeShort, modeBase]
      const contextBase = width('.gui-context-trigger-bar') + contextPad * 2 + 2
      const context = has('.gui-context-trigger') ? [
        contextBase + 5 + width('.gui-context-trigger-label'),
        contextBase + 5 + width('.gui-context-trigger-percent'), contextBase
      ] : [0, 0, 0]
      const modelText = width('.gui-composer-model .gui-mode-text')
      const modelGlyph = width('.mode-model > span:first-child')
      const model = modelText + modelGlyph + buttonGap + modePad * 2 + 2
      const effortText = width('.gui-composer-effort .gui-mode-text')
      const effortGlyph = width('.mode-effort > span:first-child')
      const effort = has('.mode-effort') ? effortText + effortGlyph + buttonGap + modePad * 2 + 2 : 0
      const fast = width('.gui-fast-btn')
      const fixed = width('.gui-attach-btn') + width('.gui-send')
      const normal = fixed + model + effort + fast + gap * 7
      const compact = fixed + modelText + 8 + (effort ? effortText + 8 : 0) +
        fast + modeGlyph + 8 +
        (context[2] ? context[2] - (contextPad - 3) * 2 : 0) + 2 * 7
      const next = guiComposerFitLevel(available, [
        normal + mode[0] + context[0],
        normal + mode[0] + context[1],
        normal + mode[1] + context[1],
        normal + mode[1] + context[2],
        normal + mode[2] + context[2], compact
      ])
      setLevel(current => current === next ? current : next)
    }
    const observer = new ResizeObserver(measure)
    const observe = (): void => {
      observer.disconnect()
      observer.observe(inner)
      for (const node of inner.querySelectorAll('.gui-mode-btn > span, .gui-context-trigger > span, .gui-sq')) observer.observe(node)
      measure()
    }
    const mutations = new MutationObserver(observe)
    mutations.observe(inner, { childList: true, subtree: true, characterData: true })
    observe()
    void document.fonts?.ready.then(() => { if (!stopped) measure() })
    return () => { stopped = true; observer.disconnect(); mutations.disconnect() }
  }, [enabled, ref])
  return level
}
