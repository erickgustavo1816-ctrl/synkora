/** Native DevTools uses a 20×20 grid and 1.5px visual weight. A broken element
 * outline plus an add sign distinguishes this action from the adjacent picker.
 * Both forms share the same small, hand-optimized drawing. */
const REFERENCE_ICON_CONTENT = '<path d="M5 3.75H3.75V5M7.5 3.75H9M11.5 3.75H13M15.5 3.75H16.25V5M16.25 7.5V9M3.75 7.5V9M3.75 11.5V13M3.75 15.5V16.25H5M7.5 16.25H9M10 13.5H17M13.5 10V17" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="round"/>'

/** Used as a native icon mask; the native control supplies its themed color. */
export const BROWSER_REFERENCE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" aria-hidden="true">${REFERENCE_ICON_CONTENT}</svg>`
/** Reusable symbol form for other Synkora surfaces. Label the containing button. */
export const BROWSER_REFERENCE_ICON_SYMBOL = `<symbol id="synkora-reference-selected" viewBox="0 0 20 20">${REFERENCE_ICON_CONTENT}</symbol>`
