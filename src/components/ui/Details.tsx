import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { Collapse } from './Collapse'

/** Collapse's fold (motion.css --dur-base) plus a frame. */
const CLOSE_MS = 240

/**
 * A native <details> whose content opens and folds by height (Collapse) instead of
 * appearing and vanishing. The summary stays the real control (keyboard, assistive
 * tech, find-in-page); closing waits for the fold before the element closes.
 */
export function Details({ summary, children, className = '', summaryStyle }: {
  summary: ReactNode
  children: ReactNode
  className?: string
  summaryStyle?: CSSProperties
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  const onSummary = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    const element = ref.current
    if (!element) return
    window.clearTimeout(timer.current)
    if (!open) {
      element.open = true
      setOpen(true)
    } else {
      setOpen(false)
      timer.current = window.setTimeout(() => { element.open = false }, CLOSE_MS)
    }
  }

  return (
    // Opened some other way (find-in-page): follow it.
    <details ref={ref} className={className} onToggle={() => { if (ref.current?.open && !open) setOpen(true) }}>
      <summary style={summaryStyle} onClick={onSummary}>{summary}</summary>
      <Collapse open={open} keepMounted>{children}</Collapse>
    </details>
  )
}
