import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../../components/ui/icons'
import { lockBodyScroll } from '../../hooks/useBodyScrollLock'

/**
 * Modal sheet capped at 480px. Focus starts on the heading; Escape and the
 * backdrop call `onClose` unless `locked` (while a write is in flight).
 */
export function SplitDialog({ title, onClose, locked = false, testId, children }: {
  title: string
  onClose: () => void
  locked?: boolean
  testId?: string
  children: ReactNode
}) {
  const headingId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    heading.current?.focus()
    return lockBodyScroll()
  }, [])

  useEffect(() => {
    if (locked) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close.current() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [locked])

  return createPortal(
    // Starts below the status bar so nothing scrolls under it (iOS blurs content there).
    <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center overflow-y-auto overflow-x-hidden overscroll-none px-4 pt-6"
      style={{ top: 'env(safe-area-inset-top, 0px)', paddingBottom: 'calc(24px + env(safe-area-inset-bottom, 0px))', background: 'rgba(15, 11, 8, 0.92)' }}
      onClick={() => { if (!locked) close.current() }}>
      <div role="dialog" aria-modal="true" aria-labelledby={headingId} data-testid={testId}
        className="animate-slide-up my-auto w-full max-w-[480px]" onClick={(event) => event.stopPropagation()}
        style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 20, padding: 22 }}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="serif-display outline-none"
            style={{ color: 'var(--text-primary)', fontSize: 24, fontWeight: 400 }}>{title}</h2>
          <button type="button" onClick={() => close.current()} disabled={locked} aria-label="Close"
            className="close-x"><IconClose /></button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export interface FieldControlProps {
  id: string
  'aria-describedby'?: string
  'aria-invalid'?: boolean
}

/** A labelled control whose hint or error is linked by aria-describedby. */
export function Field({ label, error, hint, children }: {
  label: string
  error?: string
  hint?: ReactNode
  children: (control: FieldControlProps) => ReactNode
}) {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? hint
  return (
    <div className="flex flex-col gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': note ? noteId : undefined, 'aria-invalid': error ? true : undefined })}
      {error
        ? <span id={noteId} role="alert" style={{ color: 'var(--accent)', fontSize: 12 }}>{error}</span>
        : hint ? <span id={noteId} style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>{hint}</span> : null}
    </div>
  )
}

export const inputStyle = {
  background: 'rgba(245,241,235,0.035)',
  border: '1px solid var(--border)',
  color: 'var(--text-primary)',
  fontSize: 14,
} as const

export const inputClass = 'w-full rounded-md px-3.5 py-2.5 outline-none focus:border-[color:var(--accent)]'
