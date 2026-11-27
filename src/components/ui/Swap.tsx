import { type ReactNode, useEffect, useReducer, useRef } from 'react'

interface Entry { id: string; node: ReactNode; leaving: boolean; animate: boolean }

/** Outgoing content fades for 160ms (motion.css .m-swap-out). */
const OUT_MS = 170

/**
 * Crossfades content that changes in place, keyed on `id` (a phase, a mode). The old
 * content fades out (160ms) over the new, which fades in with a 4px rise (200ms). The
 * first content just shows. Old content is a snapshot: hidden from assistive tech and
 * not interactive while it fades. Keep portals (dialogs) outside a Swap.
 */
export function Swap({ id, children, className = '' }: { id: string; children: ReactNode; className?: string }) {
  const entries = useRef<Entry[]>([{ id, node: children, leaving: false, animate: false }])
  const [, rerender] = useReducer((count: number) => count + 1, 0)

  const current = entries.current.find((entry) => !entry.leaving)
  if (current && current.id === id) {
    current.node = children
  } else {
    entries.current = [
      ...entries.current.filter((entry) => entry.id !== id).map((entry) => ({ ...entry, leaving: true })),
      { id, node: children, leaving: false, animate: true },
    ]
  }
  const hasLeaving = entries.current.some((entry) => entry.leaving)

  useEffect(() => {
    if (!hasLeaving) return
    const timer = window.setTimeout(() => {
      entries.current = entries.current.filter((entry) => !entry.leaving)
      rerender()
    }, OUT_MS)
    return () => window.clearTimeout(timer)
  }, [hasLeaving, id])

  return (
    <div className={`m-swap-host ${className}`}>
      {entries.current.map((entry) => (
        <div key={entry.id} className={entry.leaving ? 'm-swap-out' : entry.animate ? 'm-swap-in' : undefined}
          aria-hidden={entry.leaving || undefined} {...(entry.leaving ? { inert: '' } : null)}>
          {entry.node}
        </div>
      ))}
    </div>
  )
}
