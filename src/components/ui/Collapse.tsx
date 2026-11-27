import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type Space, space } from './space'

type Phase = 'closed' | 'entering' | 'opening' | 'open' | 'closing'

/** Matches --dur-base in motion.css, plus a little slack for the last frame. */
const SETTLE_MS = 240

/**
 * Opens and closes its content by height (grid rows 0fr ↔ 1fr, which iPhone Safari
 * animates; `calc-size()` it does not) with an opacity fade, so the layout around it
 * flows instead of jumping. Closed, nothing is rendered: no aria, no test ids. While
 * closing, the last content stays (hidden from assistive tech) until it has folded.
 *
 * `gap`: the flex/grid gap of the parent as a spacing step (gap-4 → 4), folded away with the content so the
 * siblings settle exactly where they will end up. Margins on the child go inside.
 */
export function Collapse({ open, children, gap = 0, appear = false, keepMounted = false, id, className = '', testId }: {
  open: boolean
  children?: ReactNode
  gap?: Space
  /** Animate open on first mount too (default: start open without animating). */
  appear?: boolean
  /** Keep the closed content in the DOM, `hidden` (e.g. the target of an aria-controls). */
  keepMounted?: boolean
  id?: string
  className?: string
  testId?: string
}) {
  const [phase, setPhase] = useState<Phase>(open ? (appear ? 'entering' : 'open') : 'closed')
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef<ReactNode>(children)
  if (open) last.current = children
  // (keepMounted renders the live children throughout.)

  useLayoutEffect(() => {
    if (open) {
      if (phase === 'closed') setPhase('entering')
      else if (phase === 'entering') {
        // Commit the folded state first, so the change to 1fr is a transition.
        void ref.current?.offsetHeight
        setPhase('opening')
      } else if (phase === 'closing') setPhase('opening')
    } else if (phase !== 'closed' && phase !== 'closing') setPhase('closing')
  }, [open, phase])

  useEffect(() => {
    if (phase !== 'opening' && phase !== 'closing') return
    const timer = window.setTimeout(() => setPhase(phase === 'opening' ? 'open' : 'closed'), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (phase === 'closed' && !keepMounted) return null
  const closed = phase === 'closed'
  const expanded = phase === 'opening' || phase === 'open'
  const hidden = phase === 'closing'
  return (
    <div ref={ref} id={id} data-testid={testId} hidden={closed || undefined}
      className={`m-collapse${expanded ? ' is-open' : ''}${phase === 'open' ? ' is-settled' : ''} ${className}`}
      style={gap ? { '--collapse-gap': space(gap) } as CSSProperties : undefined}
      aria-hidden={hidden || undefined} {...(hidden ? { inert: '' } : null)}>
      <div className="m-collapse__inner">{open || keepMounted ? children : last.current}</div>
    </div>
  )
}
