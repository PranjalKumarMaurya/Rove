import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from '../../components/ui/icons'
import { NeonBtn } from '../../components/ui/NeonBtn'
import { NeonInput } from '../../components/ui/NeonInput'
import { lockBodyScroll } from '../../hooks/useBodyScrollLock'
import { inviteProofFromInput } from './tripGrouping'
import './home.css'

const EXIT_MS = 200
const INVALID_LINK = 'That doesn’t look like a Trip invite link. Copy the whole link and paste it again.'

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * A centred popup for joining a Trip with a pasted invite link. Fades and scales
 * in, closes on backdrop tap, Escape or ✕ (then plays the reverse before
 * unmounting), and pins the page behind it while open.
 */
export function InviteDialog({ open, onClose, onInvite }: {
  open: boolean
  onClose: () => void
  /** A valid invite proof from the pasted link. */
  onInvite: (proof: string) => void
}) {
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      // Two frames so the closed styles paint before the transition starts.
      let second = 0
      const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setShown(true)) })
      return () => { cancelAnimationFrame(first); cancelAnimationFrame(second) }
    }
    setShown(false)
    const timer = window.setTimeout(() => setMounted(false), prefersReducedMotion() ? 0 : EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  if (!mounted || typeof document === 'undefined') return null
  return createPortal(<InviteDialogCard shown={shown} open={open} onClose={onClose} onInvite={onInvite} />, document.body)
}

function InviteDialogCard({ shown, open, onClose, onInvite }: {
  shown: boolean
  open: boolean
  onClose: () => void
  onInvite: (proof: string) => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | undefined>()
  const cardRef = useRef<HTMLDivElement>(null)
  // NeonInput does not forward refs, so the field is found inside the card.
  const focusInput = () => cardRef.current?.querySelector<HTMLInputElement>('#invite-link')?.focus({ preventScroll: true })
  const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'

  useEffect(() => lockBodyScroll(), [])
  useEffect(() => { focusInput() }, [])

  // Escape closes from anywhere while the dialog is up.
  useEffect(() => {
    if (!open) return
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  // Keep Tab inside the card.
  const trapTab = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || !cardRef.current) return
    const focusable = Array.from(cardRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'))
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const proof = inviteProofFromInput(value)
    if (!proof) {
      setError(INVALID_LINK)
      return
    }
    setError(undefined)
    onInvite(proof)
  }

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim()
      if (text) { setValue(text); setError(undefined) }
    } catch { /* permission denied or nothing to paste: leave the field as is */ }
    focusInput()
  }

  const messageId = 'invite-link-message'
  return (
    <div className={`invite-dialog${shown ? ' is-shown' : ''}`} onKeyDown={trapTab}>
      <div className="invite-dialog__backdrop" aria-hidden="true" onClick={onClose} />
      <div ref={cardRef} className="invite-dialog__card" role="dialog" aria-modal="true" aria-label="Join a Trip">
        <button type="button" className="invite-dialog__close" aria-label="Close" onClick={onClose}>
          <IconClose size={22} />
        </button>
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 pr-8">
            <label htmlFor="invite-link" className="invite-dialog__title">Have an invite link?</label>
            <p id={messageId} className="field-hint" style={{ fontSize: 13 }}>Paste the link a friend sent you to join their Trip.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="relative">
              <NeonInput id="invite-link" value={value}
                onChange={(event) => { setValue(event.target.value); setError(undefined) }}
                aria-describedby={error ? `${messageId} invite-link-error` : messageId} aria-invalid={error ? true : undefined}
                placeholder="Paste invite link" autoComplete="off" autoCapitalize="off" spellCheck={false} inputMode="url"
                enterKeyHint="go" style={{ fontSize: 16, minHeight: 48, paddingRight: canPaste ? 76 : undefined }} />
              {canPaste && (
                <button type="button" className="invite-dialog__paste" onClick={() => { void paste() }}>Paste</button>
              )}
            </div>
            {error && <p id="invite-link-error" className="field-error">{error}</p>}
          </div>
          <NeonBtn type="submit" size="lg" className="w-full">Open invite</NeonBtn>
        </form>
      </div>
    </div>
  )
}
