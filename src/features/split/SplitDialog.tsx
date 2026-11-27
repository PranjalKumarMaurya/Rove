import { type ReactNode, useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../../components/ui/icons'
import { useTriggerOrigin } from '../../components/ui/motion'
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
  // Grows out of the button that opened it ("Add expense", "Settle up", "Edit").
  const card = useRef<HTMLDivElement>(null)
  useTriggerOrigin(card)

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
    <div className="dialog-overlay m-backdrop" onClick={() => { if (!locked) close.current() }}>
      <div ref={card} role="dialog" aria-modal="true" aria-labelledby={headingId} data-testid={testId}
        className="dialog-card m-dialog" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <h2 id={headingId} ref={heading} tabIndex={-1} className="t-title2 min-w-0 outline-none"
            style={{ color: 'var(--text-primary)' }}>{title}</h2>
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
    <div className="m-field flex flex-col gap-2 t-callout" style={{ color: 'var(--text-secondary)' }}>
      <label htmlFor={id}>{label}</label>
      {children({ id, 'aria-describedby': note ? noteId : undefined, 'aria-invalid': error ? true : undefined })}
      {error
        ? <span id={noteId} role="alert" className="m-field-error t-footnote" style={{ color: 'var(--accent)' }}>{error}</span>
        : hint ? <span id={noteId} className="t-footnote" style={{ color: 'var(--text-tertiary)' }}>{hint}</span> : null}
    </div>
  )
}

/** Colour and size; the border and background live on `.m-input` (motion.css) so focus can ease them. */
export const inputStyle = {
  color: 'var(--text-primary)',
  // Never under 16px (no iOS zoom on focus); grows with Text size.
  fontSize: 'var(--type-field)',
} as const

export const inputClass = 'm-input field-input w-full outline-none'
