import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { onCelebrate, type Celebration } from '../../lib/celebrate'
import './successTick.css'

/** Total time on screen: scale in, hold, fade out (matches successTick.css). */
const VISIBLE_MS = 1180

type PopoverElement = HTMLElement & { showPopover?: () => void; hidePopover?: () => void }

function supportsPopover(): boolean {
  return typeof HTMLElement !== 'undefined' && typeof (HTMLElement.prototype as PopoverElement).showPopover === 'function'
}

/**
 * The one success tick host, mounted once at the app root. It lives in its own
 * `popover="manual"` element so it can be lifted into the top layer above native
 * dialogs and sheets (re-shown on every celebration so it is the newest top-layer
 * item); without popover support it is a fixed layer with a very high z-index.
 * It never takes pointer events or focus.
 */
export function SuccessTick() {
  const [layer, setLayer] = useState<PopoverElement | null>(null)
  const [current, setCurrent] = useState<Celebration | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const hideTimer = useRef<number | undefined>(undefined)
  const announceTimer = useRef<number | undefined>(undefined)
  const shownId = useRef<number | null>(null)

  useEffect(() => {
    const element = document.createElement('div') as PopoverElement
    const popover = supportsPopover()
    element.className = popover ? 'rove-tick-layer' : 'rove-tick-layer rove-tick-layer--fallback'
    element.setAttribute('aria-hidden', 'true')
    element.dataset.testid = 'success-tick-layer'
    if (popover) element.setAttribute('popover', 'manual')
    else element.hidden = true
    document.body.appendChild(element)
    setLayer(element)
    return () => {
      element.remove()
      setLayer(null)
    }
  }, [])

  useEffect(() => onCelebrate((celebration) => {
    setAnnouncement(celebration.label)
    window.clearTimeout(announceTimer.current)
    announceTimer.current = window.setTimeout(() => setAnnouncement(''), 2000)
    if (celebration.quiet) return
    setCurrent(celebration)
    // A coalesced call (same id) only updates the label; it does not restart the tick.
    if (shownId.current === celebration.id) return
    shownId.current = celebration.id
    try { navigator.vibrate?.(10) } catch { /* haptics are optional */ }
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => {
      shownId.current = null
      setCurrent(null)
    }, VISIBLE_MS)
  }), [])

  useEffect(() => () => {
    window.clearTimeout(hideTimer.current)
    window.clearTimeout(announceTimer.current)
  }, [])

  // Show or hide the layer. Re-showing a popover moves it to the top of the top layer.
  const currentId = current?.id ?? null
  useEffect(() => {
    if (!layer) return
    if (currentId === null) {
      if (layer.hidePopover) { try { layer.hidePopover() } catch { /* already hidden */ } }
      else layer.hidden = true
      return
    }
    if (layer.showPopover) {
      try { layer.hidePopover?.() } catch { /* not open */ }
      try { layer.showPopover() } catch { /* detached or unsupported; nothing to show */ }
    } else {
      layer.hidden = false
    }
  }, [layer, currentId])

  return (
    <>
      {createPortal(
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="success-tick-status">{announcement}</div>,
        document.body,
      )}
      {layer && current && createPortal(
        <div key={current.id} className="rove-tick" data-testid="success-tick">
          <span className="rove-tick__circle">
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path className="rove-tick__check" d="M5 12.5l4.5 4.5L19 7.5" pathLength={24} />
            </svg>
          </span>
          <span className="rove-tick__label">{current.label}</span>
        </div>,
        layer,
      )}
    </>
  )
}
