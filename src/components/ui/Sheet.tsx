import { type PointerEvent, type ReactNode, useEffect, useId, useRef } from 'react'
import { lockBodyScroll } from '../../hooks/useBodyScrollLock'
import { IconClose } from './icons'

/** Pull the sheet down this far (px), or flick it down this fast (px/ms), to close it. */
const CLOSE_DISTANCE = 90
const CLOSE_SPEED = 0.6

/**
 * Bottom sheet on a native modal <dialog>: focus is trapped, Escape and a tap on
 * the backdrop close it, and focus returns to the opener on close. The page
 * behind is locked while it is open. Dragging the handle or title row down
 * moves the sheet with the finger; far or fast enough closes it, otherwise it
 * springs back.
 */
export function Sheet({ title, onClose, testId, children }: {
  title: string
  onClose: () => void
  testId?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const drag = useRef<{ pointerId: number; startY: number; lastY: number; lastTime: number; speed: number } | null>(null)
  const closing = useRef(false)

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const unlock = lockBodyScroll()
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
      unlock()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const moveTo = (offset: number, animate: boolean) => {
    const dialog = ref.current
    if (!dialog) return
    dialog.style.transition = animate && !reducedMotion() ? 'transform 0.2s cubic-bezier(0.22, 1, 0.36, 1)' : 'none'
    dialog.style.transform = offset > 0 ? `translateY(${offset}px)` : ''
  }

  const dismiss = () => {
    if (closing.current) return
    closing.current = true
    const dialog = ref.current
    if (!dialog || reducedMotion()) { onClose(); return }
    moveTo(dialog.offsetHeight + 40, true)
    window.setTimeout(onClose, 180)
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // The close button keeps working as a button.
    if ((event.target as HTMLElement).closest('button') || closing.current) return
    drag.current = { pointerId: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, speed: 0 }
    event.currentTarget.setPointerCapture(event.pointerId)
    moveTo(0, false)
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    const elapsed = Math.max(1, event.timeStamp - state.lastTime)
    state.speed = (event.clientY - state.lastY) / elapsed
    state.lastY = event.clientY
    state.lastTime = event.timeStamp
    // Down follows the finger; up is resisted.
    const offset = event.clientY - state.startY
    moveTo(offset > 0 ? offset : 0, false)
  }

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current
    if (!state || state.pointerId !== event.pointerId) return
    drag.current = null
    const offset = event.clientY - state.startY
    if (event.type === 'pointerup' && (offset > CLOSE_DISTANCE || (offset > 24 && state.speed > CLOSE_SPEED))) dismiss()
    else moveTo(0, true)
  }

  return (
    <dialog ref={ref} className="sheet" aria-labelledby={titleId} data-testid={testId}
      // Nested dialogs (e.g. a confirm sheet opened from here) bubble through React; act only on our own.
      onCancel={(event) => { if (event.target !== event.currentTarget) return; event.preventDefault(); onClose() }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="sheet__drag" data-testid="sheet-drag-handle"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
        <div className="sheet__grabber" aria-hidden="true" />
        <div className="sheet__head">
          <h2 id={titleId} className="serif-display min-w-0 flex-1 truncate" style={{ fontSize: 22 }}>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="topbar-btn topbar-btn--icon" style={{ border: 'none', background: 'none' }}>
            <IconClose />
          </button>
        </div>
      </div>
      <div className="sheet__body">{children}</div>
    </dialog>
  )
}
