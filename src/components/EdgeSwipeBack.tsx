import { useEffect } from 'react'
import { entryDepthOf } from '../features/auth/navigationHistory'
import {
  CANCEL_MS, EDGE_WIDTH, classifySwipe, completionDuration, isStandaloneDisplay, shouldCompleteSwipe, startsAtEdge,
  swipeProgress, swipeVelocity, underlayDim, underlayShift,
} from '../lib/edgeSwipe'
import {
  EASE_OUT, PUSH_EASE, beginSwipeUnderlay, cancelSwipeUnderlay, markSwipeNavigation, navTransitionRunning,
  onSwipeSettled, prefersReducedMotion, swipeLayers, takeSwipeNavigation, type SwipeLayers,
} from '../lib/screenTransition'

/**
 * iOS home-screen apps have no system swipe-back, so this adds one, the way
 * UINavigationController does it: a touch starting at the left edge asks AuthBoundary
 * to render the previous screen beneath the current one, then the current screen
 * follows the finger (with a soft shadow on its left edge) while the one beneath
 * slides in from -30% and its dim fades. Letting go past 35% of the width, or flicking,
 * finishes the slide at the finger's speed and goes `history.back()`; AuthBoundary
 * turns that popstate into the previous screen, which is the layer already showing.
 * Otherwise the screen settles back. A screen settling back can be caught again.
 *
 * Active only when running standalone (in Safari the browser's own edge swipe already
 * fires popstate) and when the current history entry is one of our deeper screens.
 * Ignored while a dialog, sheet or overlay is open. Reduced motion: no drag, a
 * completed swipe just goes back (AuthBoundary crossfades).
 */

function isStandalone(): boolean {
  const displayMode = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
  return isStandaloneDisplay((navigator as Navigator & { standalone?: boolean }).standalone, displayMode)
}

function overlayOpen(): boolean {
  return document.body.dataset.scrollLocked === 'true' || document.querySelector('dialog[open]') !== null
}

/** The translateX a layer is showing right now (mid-transition included). */
function currentShift(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform
  if (!transform || transform === 'none') return 0
  try { return new DOMMatrixReadOnly(transform).m41 } catch { return 0 }
}

export function EdgeSwipeBack() {
  useEffect(() => {
    if (typeof window === 'undefined' || !isStandalone()) return

    let tracking: null | {
      startX: number
      startY: number
      intent: 'pending' | 'horizontal'
      dx: number
      samples: { x: number; t: number }[]
      /** No layers to move (reduced motion, or no screen underneath): release just goes back. */
      plain: boolean
    } = null
    let layers: SwipeLayers | null = null
    let phase: 'idle' | 'tracking' | 'settling-back' | 'finishing' = 'idle'
    let timer: number | undefined
    let fallback: number | undefined

    const paint = (dx: number, transition: string) => {
      if (!layers) return
      const width = window.innerWidth
      const progress = swipeProgress(dx, width)
      const { current, underlay, dim } = layers
      current.style.transition = transition
      underlay.style.transition = transition
      current.style.transform = `translate3d(${dx}px, 0, 0)`
      underlay.style.transform = `translate3d(${underlayShift(progress, width)}px, 0, 0)`
      if (dim) {
        dim.style.transition = transition
        dim.style.opacity = underlayDim(progress).toFixed(3)
      }
    }

    const reset = () => {
      window.clearTimeout(timer)
      window.clearTimeout(fallback)
      tracking = null
      layers = null
      phase = 'idle'
    }

    // AuthBoundary made the screen underneath the real one (or the screens changed
    // under the gesture): nothing left to move.
    const stopSettled = onSwipeSettled(reset)

    const onTouchStart = (event: TouchEvent) => {
      // A second finger: let the screen settle back.
      if (event.touches.length !== 1) { if (phase === 'tracking') finish(true); return }
      const touch = event.touches[0]
      if (phase === 'settling-back' && layers) {
        // Catch the screen while it slides back: it stops under the finger.
        const dx = Math.max(0, currentShift(layers.current))
        if (touch.clientX > dx + EDGE_WIDTH * 2) return
        window.clearTimeout(timer)
        paint(dx, 'none')
        phase = 'tracking'
        tracking = {
          startX: touch.clientX - dx, startY: touch.clientY, intent: 'horizontal', dx,
          samples: [{ x: touch.clientX, t: event.timeStamp }], plain: false,
        }
        return
      }
      if (phase !== 'idle') return
      tracking = null
      if (!startsAtEdge(touch.clientX)) return
      if (entryDepthOf(window.history.state) <= 0 || overlayOpen() || navTransitionRunning()) return
      phase = 'tracking'
      tracking = {
        startX: touch.clientX, startY: touch.clientY, intent: 'pending', dx: 0,
        samples: [{ x: touch.clientX, t: event.timeStamp }], plain: prefersReducedMotion(),
      }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (phase !== 'tracking' || !tracking) return
      const touch = event.touches[0]
      if (!touch) return
      const dx = touch.clientX - tracking.startX
      const dy = touch.clientY - tracking.startY
      if (tracking.intent === 'pending') {
        const intent = classifySwipe(dx, dy)
        if (intent === 'pending') return
        if (intent === 'cancel') { reset(); return }
        tracking.intent = 'horizontal'
        if (!tracking.plain) {
          // Renders the previous screen underneath, synchronously, before the first move.
          layers = beginSwipeUnderlay() ? swipeLayers() : null
          if (!layers) tracking.plain = true
        }
      }
      // Committed to the back swipe: from here the page must not scroll.
      if (event.cancelable) event.preventDefault()
      tracking.dx = Math.max(0, dx)
      tracking.samples.push({ x: touch.clientX, t: event.timeStamp })
      if (tracking.samples.length > 8) tracking.samples.shift()
      if (!tracking.plain) paint(tracking.dx, 'none')
    }

    const goBack = () => {
      markSwipeNavigation()
      // If the popstate never arrives, put the screens back rather than strand them.
      fallback = window.setTimeout(() => {
        takeSwipeNavigation()
        cancelSwipeUnderlay()
        reset()
      }, 600)
      window.history.back()
    }

    const finish = (cancelled: boolean) => {
      const state = tracking
      tracking = null
      if (phase !== 'tracking') return
      if (!state || state.intent !== 'horizontal') { phase = 'idle'; return }
      const width = window.innerWidth
      const velocity = swipeVelocity(state.samples)
      const complete = !cancelled && shouldCompleteSwipe(state.dx, width, velocity)
      if (state.plain || !layers) {
        phase = 'idle'
        if (complete) window.history.back()
        return
      }
      if (complete) {
        phase = 'finishing'
        const duration = completionDuration(width - state.dx, velocity)
        paint(width, `transform ${duration}ms ${PUSH_EASE}, opacity ${duration}ms ${PUSH_EASE}`)
        timer = window.setTimeout(goBack, duration)
      } else {
        phase = 'settling-back'
        paint(0, `transform ${CANCEL_MS}ms ${EASE_OUT}, opacity ${CANCEL_MS}ms ${EASE_OUT}`)
        timer = window.setTimeout(() => {
          cancelSwipeUnderlay()
          reset()
        }, CANCEL_MS)
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
      stopSettled()
      if (layers) cancelSwipeUnderlay()
      reset()
    }
  }, [])

  return null
}
