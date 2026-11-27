import { useEffect } from 'react'
import { entryDepthOf } from '../features/auth/navigationHistory'
import {
  classifySwipe, isStandaloneDisplay, shouldCompleteSwipe, startsAtEdge, swipeVelocity,
} from '../lib/edgeSwipe'

/**
 * iOS home-screen apps have no system swipe-back, so this adds one: a touch starting at
 * the left edge drags the whole app (#root) to the right, and letting go far enough (or
 * flicking) goes back with `history.back()`; AuthBoundary turns that popstate into the
 * previous screen. Active only when running standalone (in Safari the browser's own edge
 * swipe already fires popstate) and when the current history entry is one of our deeper
 * screens. Ignored while a dialog, sheet or overlay is open.
 */

function isStandalone(): boolean {
  const displayMode = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  return isStandaloneDisplay((navigator as Navigator & { standalone?: boolean }).standalone, displayMode)
}

function reducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function overlayOpen(): boolean {
  return document.body.dataset.scrollLocked === 'true' || document.querySelector('dialog[open]') !== null
}

const SETTLE_MS = 220

export function EdgeSwipeBack() {
  useEffect(() => {
    if (typeof window === 'undefined' || !isStandalone()) return

    let tracking: null | {
      startX: number
      startY: number
      intent: 'pending' | 'horizontal'
      dx: number
      samples: { x: number; t: number }[]
      reduce: boolean
    } = null
    let root: HTMLElement | null = null
    let settleTimer: number | undefined
    let animating = false

    const saved = { transform: '', transition: '', boxShadow: '', background: '', willChange: '' }

    const styleRoot = (dx: number, transition: string) => {
      if (!root) return
      root.style.transition = transition
      root.style.transform = dx > 0 ? `translate3d(${dx}px, 0, 0)` : 'translate3d(0, 0, 0)'
      const progress = Math.min(1, dx / Math.max(1, window.innerWidth))
      root.style.boxShadow = `-12px 0 32px rgba(0, 0, 0, ${(0.55 * (1 - progress)).toFixed(3)})`
    }

    const restoreRoot = () => {
      if (!root) return
      root.style.transition = saved.transition
      root.style.transform = saved.transform
      root.style.boxShadow = saved.boxShadow
      root.style.background = saved.background
      root.style.willChange = saved.willChange
      root = null
    }

    const beginDrag = () => {
      root = document.getElementById('root')
      if (!root) return
      saved.transform = root.style.transform
      saved.transition = root.style.transition
      saved.boxShadow = root.style.boxShadow
      saved.background = root.style.background
      saved.willChange = root.style.willChange
      // The moving screen needs its own background so it reads as a sheet over the page.
      root.style.background = getComputedStyle(document.body).backgroundColor || '#0F0B08'
      root.style.willChange = 'transform'
    }

    const onTouchStart = (event: TouchEvent) => {
      tracking = null
      if (animating || event.touches.length !== 1) return
      const touch = event.touches[0]
      if (!startsAtEdge(touch.clientX)) return
      if (entryDepthOf(window.history.state) <= 0 || overlayOpen()) return
      tracking = {
        startX: touch.clientX, startY: touch.clientY, intent: 'pending', dx: 0,
        samples: [{ x: touch.clientX, t: event.timeStamp }], reduce: reducedMotion(),
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!tracking) return
      const touch = event.touches[0]
      if (!touch) return
      const dx = touch.clientX - tracking.startX
      const dy = touch.clientY - tracking.startY
      if (tracking.intent === 'pending') {
        const intent = classifySwipe(dx, dy)
        if (intent === 'pending') return
        if (intent === 'cancel') { tracking = null; return }
        tracking.intent = 'horizontal'
        if (!tracking.reduce) beginDrag()
      }
      // Committed to the back swipe: from here the page must not scroll.
      if (event.cancelable) event.preventDefault()
      tracking.dx = Math.max(0, dx)
      tracking.samples.push({ x: touch.clientX, t: event.timeStamp })
      if (tracking.samples.length > 8) tracking.samples.shift()
      if (!tracking.reduce) styleRoot(tracking.dx, 'none')
    }

    const finish = (cancelled: boolean) => {
      const state = tracking
      tracking = null
      if (!state || state.intent !== 'horizontal') return
      const width = window.innerWidth
      const complete = !cancelled && shouldCompleteSwipe(state.dx, width, swipeVelocity(state.samples))
      if (state.reduce) {
        if (complete) window.history.back()
        return
      }
      animating = true
      if (complete) {
        styleRoot(width, `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.7, 0.3, 1), box-shadow ${SETTLE_MS}ms linear`)
        settleTimer = window.setTimeout(() => {
          // Clear the transform once the previous screen has rendered, so it appears in place.
          const reset = () => {
            window.removeEventListener('popstate', reset)
            window.clearTimeout(fallback)
            requestAnimationFrame(() => requestAnimationFrame(() => {
              restoreRoot()
              animating = false
            }))
          }
          const fallback = window.setTimeout(reset, 400)
          window.addEventListener('popstate', reset)
          window.history.back()
        }, SETTLE_MS)
      } else {
        styleRoot(0, `transform ${SETTLE_MS}ms cubic-bezier(0.3, 1.3, 0.5, 1), box-shadow ${SETTLE_MS}ms linear`)
        settleTimer = window.setTimeout(() => {
          restoreRoot()
          animating = false
        }, SETTLE_MS + 20)
      }
    }

    const onTouchEnd = () => finish(false)
    const onTouchCancel = () => finish(true)

    document.addEventListener('touchstart', onTouchStart, { passive: true })
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    document.addEventListener('touchcancel', onTouchCancel, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onTouchStart)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('touchend', onTouchEnd)
      document.removeEventListener('touchcancel', onTouchCancel)
      window.clearTimeout(settleTimer)
      restoreRoot()
    }
  }, [])

  return null
}
