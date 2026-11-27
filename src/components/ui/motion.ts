import { type CSSProperties, type RefObject, useLayoutEffect } from 'react'

/** List entrance stagger (`.m-enter`, motion.css): the first six items 30ms apart, later ones at once. */
export function enterIndex(index: number): CSSProperties {
  return { '--i': index < 6 ? index : 0 } as CSSProperties
}

const CONTROL = 'button, a, [role="button"], [role="tab"]'

// The control the person last pressed. iPhone Safari does not focus a button on tap,
// so document.activeElement alone cannot say which control opened a dialog.
let lastPress: { element: Element; at: number } | null = null
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (event) => {
    const control = event.target instanceof Element ? event.target.closest(CONTROL) : null
    lastPress = control ? { element: control, at: performance.now() } : null
  }, { capture: true, passive: true })
}

/** The control that most likely opened a dialog just now: a fresh press, else the focused control. */
function recentTrigger(): Element | null {
  if (lastPress && lastPress.element.isConnected && performance.now() - lastPress.at < 1500) return lastPress.element
  const active = typeof document === 'undefined' ? null : document.activeElement
  return active instanceof HTMLElement && active.matches(CONTROL) ? active : null
}

/**
 * Points a centred dialog's scale origin at the control that opened it, so it grows
 * out of (and shrinks back into) that control while staying centred. Sets
 * `--m-origin-x/y` and `data-origin` on the card (`.m-dialog`, motion.css). With no
 * trigger it leaves the centre origin, and the CSS uses the gentler 0.96 scale.
 */
export function useTriggerOrigin(card: RefObject<HTMLElement | null>, trigger?: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = card.current
    const source = trigger?.current ?? recentTrigger()
    if (!element || !source || element.contains(source)) return
    const from = source.getBoundingClientRect()
    if (from.width === 0 && from.height === 0) return
    // Measured while the card's origin is still its centre, so the centre is where it
    // will settle whatever the current scale; offset sizes are unscaled layout sizes.
    const rect = element.getBoundingClientRect()
    const left = rect.left + rect.width / 2 - element.offsetWidth / 2
    const top = rect.top + rect.height / 2 - element.offsetHeight / 2
    element.style.setProperty('--m-origin-x', `${from.left + from.width / 2 - left}px`)
    element.style.setProperty('--m-origin-y', `${from.top + from.height / 2 - top}px`)
    element.dataset.origin = 'trigger'
  // Measured once, at open: the card should return to where it came from.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
