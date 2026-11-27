import { type PointerEvent, type ReactNode, useEffect, useId, useRef } from 'react'
import { lockBodyScroll } from '../../hooks/useBodyScrollLock'
import { IconClose } from './icons'

/** Pull the sheet down this far (px), or flick it down this fast (px/ms), to close it. */
const CLOSE_DISTANCE = 90
const CLOSE_SPEED = 0.6
/** A body touch becomes a sheet drag after this much mostly-downward movement (px). */
const BODY_DRAG_SLOP = 6
/** Settle and close on the drawer curve the sheet opens with (`--ease-drawer`, motion.css). */
const DRAWER_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
const SETTLE_MS = 300
const CLOSE_MS = 220

/** Touches that start here keep their own behaviour (typing, caret moves, pickers, the handle). */
const BODY_DRAG_IGNORE = 'input, textarea, select, [contenteditable="true"], .sheet__drag'

/** True when the touch target or anything up to the sheet is scrolled down. */
function scrolledBetween(target: Element, dialog: HTMLElement) {
  for (let node: Element | null = target; node && node !== dialog.parentElement; node = node.parentElement) {
    if (node.scrollTop > 0) return true
  }
  return false
}

/**
 * Bottom sheet on a native modal <dialog>: focus is trapped, Escape and a tap on
 * the backdrop close it, and focus returns to the opener on close. The page
 * behind is locked while it is open. Dragging the handle or title row down
 * moves the sheet with the finger; far or fast enough closes it, otherwise it
 * springs back. A downward drag anywhere in the body does the same while the
 * sheet is scrolled to its top; otherwise it scrolls the content.
 */
export function Sheet({ title, onClose, testId, children }: {
  title: string
  onClose: () => void
  testId?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const drag = useRef<{ pointerId: number; startY: number; lastY: number; lastTime: number; speed: number } | null>(null)
  const closing = useRef(false)

  useEffect(() => {
    const dialog = ref.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const unlock = lockBodyScroll()
    if (dialog && !dialog.open) dialog.showModal()
    // showModal() focuses the close button, which drew a focus ring on open. Start on
    // the title instead, so screen readers still begin there (unless a child already
    // chose a field to focus).
    const active = document.activeElement
    if (dialog && (!dialog.contains(active) || active?.classList.contains('close-x'))) heading.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
      unlock()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

  const moveTo = (offset: number, animate: boolean, duration = SETTLE_MS) => {
    const dialog = ref.current
    if (!dialog) return
    dialog.style.transition = animate && !reducedMotion() ? `transform ${duration}ms ${DRAWER_EASE}` : 'none'
    dialog.style.transform = offset > 0 ? `translateY(${offset}px)` : ''
  }

  const dismiss = () => {
    if (closing.current) return
    closing.current = true
    const dialog = ref.current
    if (!dialog || reducedMotion()) { onClose(); return }
    moveTo(dialog.offsetHeight + 40, true, CLOSE_MS)
    // The drawer curve front-loads the travel, so the sheet is off screen well before it ends.
    window.setTimeout(onClose, CLOSE_MS - 20)
  }

  // Kept current so the native touch listeners below (bound once) see this render's onClose.
  const dismissRef = useRef(dismiss)
  dismissRef.current = dismiss

  // Body drag-to-close. Native listeners because React's touch handlers are passive, and
  // preventDefault() is what stops the browser from scrolling once the sheet takes over.
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    let touch: { id: number; startX: number; startY: number; lastY: number; lastTime: number; speed: number; mode: 'pending' | 'drag' | 'scroll' } | null = null

    const find = (list: TouchList) => touch ? Array.from(list).find((entry) => entry.identifier === touch?.id) : undefined

    const onStart = (event: TouchEvent) => {
      const target = event.target as Element | null
      // A tap on the backdrop targets the dialog itself; it closes on click instead.
      if (closing.current || event.touches.length > 1 || !target || target === dialog || target.closest(BODY_DRAG_IGNORE)) { touch = null; return }
      const point = event.changedTouches[0]
      touch = { id: point.identifier, startX: point.clientX, startY: point.clientY, lastY: point.clientY, lastTime: event.timeStamp, speed: 0, mode: scrolledBetween(target, dialog) ? 'scroll' : 'pending' }
    }

    const onMove = (event: TouchEvent) => {
      const state = touch
      const point = find(event.changedTouches)
      if (!state || !point || state.mode === 'scroll') return
      const dx = point.clientX - state.startX
      const dy = point.clientY - state.startY
      if (state.mode === 'pending') {
        const sideways = Math.abs(dx) > Math.abs(dy)
        // Up or sideways is the browser's (scroll, carousels), once it is clearly so.
        if ((dy < 0 && !sideways) || (sideways && Math.abs(dx) >= BODY_DRAG_SLOP)) { state.mode = 'scroll'; return }
        if (sideways) return
        // At the top a downward move cannot scroll anything, so hold it back from the
        // browser from the start; iOS ignores preventDefault once a scroll has begun.
        if (event.cancelable) event.preventDefault()
        if (dy < BODY_DRAG_SLOP) return
        state.mode = 'drag'
        state.startY = point.clientY
        moveTo(0, false)
      }
      if (event.cancelable) event.preventDefault()
      const elapsed = Math.max(1, event.timeStamp - state.lastTime)
      state.speed = (point.clientY - state.lastY) / elapsed
      state.lastY = point.clientY
      state.lastTime = event.timeStamp
      const offset = point.clientY - state.startY
      moveTo(offset > 0 ? offset : 0, false)
    }

    const onEnd = (event: TouchEvent) => {
      const state = touch
      const point = find(event.changedTouches)
      if (!state || !point) return
      touch = null
      if (state.mode !== 'drag') return
      const offset = point.clientY - state.startY
      if (event.type === 'touchend' && (offset > CLOSE_DISTANCE || (offset > 24 && state.speed > CLOSE_SPEED))) dismissRef.current()
      else moveTo(0, true)
    }

    dialog.addEventListener('touchstart', onStart, { passive: true })
    dialog.addEventListener('touchmove', onMove, { passive: false })
    dialog.addEventListener('touchend', onEnd)
    dialog.addEventListener('touchcancel', onEnd)
    return () => {
      dialog.removeEventListener('touchstart', onStart)
      dialog.removeEventListener('touchmove', onMove)
      dialog.removeEventListener('touchend', onEnd)
      dialog.removeEventListener('touchcancel', onEnd)
    }
  // moveTo only touches the ref; dismiss is read through dismissRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
          <h2 id={titleId} ref={heading} tabIndex={-1} className="sheet__title t-title2 min-w-0 flex-1 truncate">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="close-x">
            <IconClose />
          </button>
        </div>
      </div>
      <div className="sheet__body">{children}</div>
    </dialog>
  )
}
