import { type CSSProperties, type RefObject, useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react'

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

/** A list item folding away (motion.css .m-fold): ~200ms, plus a frame. */
const FOLD_MS = 220
/** A removal the person asked for that never happened (the request failed) stops waiting after this. */
const EXIT_EXPIRY_MS = 60_000

export interface ExitEntry<T> { item: T; key: string; leaving: boolean }

/**
 * Lets items the person removed fold away instead of vanishing. Call `exit(key)` when
 * they remove (or move) an item; when it then leaves `items`, it stays in place for one
 * fold with `leaving: true`. Items that leave for any other reason (a realtime refresh,
 * someone else's change) simply go.
 */
export function useExitList<T>(items: readonly T[], keyOf: (item: T) => string) {
  const shown = useRef<ExitEntry<T>[]>([])
  const expected = useRef(new Map<string, number>())
  const [, rerender] = useReducer((count: number) => count + 1, 0)

  const index = new Map(items.map((item, position) => [keyOf(item), position]))
  const next: ExitEntry<T>[] = []
  let cursor = 0
  const now = Date.now()
  for (const previous of shown.current) {
    const at = index.get(previous.key)
    if (at !== undefined) {
      while (cursor <= at) { const item = items[cursor++]; next.push({ item, key: keyOf(item), leaving: false }) }
    } else if (previous.leaving) {
      next.push(previous)
    } else {
      const since = expected.current.get(previous.key)
      if (since !== undefined && now - since < EXIT_EXPIRY_MS) next.push({ ...previous, leaving: true })
      expected.current.delete(previous.key)
    }
  }
  while (cursor < items.length) { const item = items[cursor++]; next.push({ item, key: keyOf(item), leaving: false }) }
  shown.current = next

  const leavingKeys = next.filter((entry) => entry.leaving).map((entry) => entry.key).join(',')
  useEffect(() => {
    if (!leavingKeys) return
    const timer = window.setTimeout(() => {
      shown.current = shown.current.filter((entry) => !entry.leaving)
      rerender()
    }, FOLD_MS)
    return () => window.clearTimeout(timer)
  }, [leavingKeys])

  const exit = useCallback((key: string) => { expected.current.set(key, Date.now()) }, [])
  return { entries: next, exit }
}

/** Props for an item that may be folding away: `.m-fold` plus, while leaving, hidden from assistive tech. */
export function foldProps(leaving: boolean, className = ''): { className: string; 'aria-hidden'?: true; inert?: '' } {
  return leaving ? { className: `m-fold is-leaving ${className}`, 'aria-hidden': true, inert: '' } : { className: `m-fold ${className}` }
}
