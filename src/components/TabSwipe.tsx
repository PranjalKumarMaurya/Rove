import { useEffect } from 'react'
import { startsAtEdge, swipeVelocity } from '../lib/edgeSwipe'
import {
  EASE_OUT, SWIPE_PIN_SELECTOR, beginSwipeUnderlay, cancelSwipeUnderlay, navTransitionRunning, onSwipeSettled,
  prefersReducedMotion, swipeBusy, swipeLayers, switchTab, tabSwipeSide, type SwipeLayers,
} from '../lib/screenTransition'
import {
  TAB_SPRING_BACK_MS, classifyTabSwipe, shouldSwitchTab, tabDragDxForOffset, tabDragOffset, tabNeighborOffset,
  tabSwitchDuration, tabSwitchTarget, type TabSide,
} from '../lib/tabSwipe'

/**
 * Swiping sideways between the two home tabs, Trips and Profile-opened-from-home, the
 * way a native tab pager does: swipe left on Trips for Profile, right on Profile for
 * Trips. (The ＋ in HomeNav stays a tap-only button.)
 *
 * A touch anywhere on the screen is watched; once it has moved 10px and mostly
 * sideways it becomes the swipe and the page stops scrolling (non-passive touchmove,
 * preventDefault only from then on); otherwise it is left to scroll. AuthBoundary then
 * renders the other tab in a layer beside the current one (inert, aria-hidden, no
 * pointer events) and both follow the finger edge to edge, while the bottom nav stays
 * put (static copies over the screens, see `pinNavs`). Pulling the wrong way rubber-bands (a quarter of the travel, at most 48px).
 *
 * Let go past 30% of the width, or flick, and the screens finish the slide at the
 * finger's speed (180–300ms); the nav shows the new tab as soon as that is decided,
 * then the layer beside becomes the real screen (no remount, no flash; the history
 * follows as for the HomeNav buttons). Otherwise they spring back over 250ms, and a
 * screen springing back can be caught again.
 *
 * Not tracked: touches in fields, in sideways-scrolling content, in anything marked
 * `data-no-tab-swipe`, while a sheet or dialog is open, during a screen transition or
 * another swipe, and in the 24px left edge (the edge swipe back's, or the browser's).
 * Reduced motion: the screen does not follow the finger; a swipe that would switch
 * just switches, with the crossfade.
 */

function overlayOpen(): boolean {
  return document.body.dataset.scrollLocked === 'true' || document.querySelector('dialog[open]') !== null
}

/** Touches here keep their own meaning: typing, selecting text, or sideways scrolling. */
function ownsHorizontalTouch(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null
  while (node && node !== document.body && node !== document.documentElement) {
    if (node.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-no-tab-swipe]')) return true
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return true
    }
    node = node.parentElement
  }
  return false
}

/** The translateX a layer is showing right now (mid-transition included). */
function currentShift(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform
  if (!transform || transform === 'none') return 0
  try { return new DOMMatrixReadOnly(transform).m41 } catch { return 0 }
}

export function TabSwipe() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    let tracking: null | {
      startX: number
      startY: number
      side: TabSide
      intent: 'pending' | 'horizontal'
      offset: number
      samples: { x: number; t: number }[]
      /** No layers to move (reduced motion, or none could be rendered): release just switches. */
      plain: boolean
    } = null
    let layers: SwipeLayers | null = null
    let phase: 'idle' | 'tracking' | 'springing-back' | 'switching' = 'idle'
    let timer: number | undefined
    let fallback: number | undefined

    // The bottom nav stays put while the screens move. Each screen's own nav moves with
    // its layer (and is clipped by it), so both are hidden and static copies of the two
    // navs are shown over the screens instead, pinned to the viewport: the current one,
    // crossfading to the other tab's once a switch is decided. They go when the swipe
    // settles, in the same frame the real nav comes back.
    let pinned: { current: HTMLElement[]; neighbor: HTMLElement[] } | null = null

    const copyPins = (layer: HTMLElement, visible: boolean) => [...layer.querySelectorAll<HTMLElement>(SWIPE_PIN_SELECTOR)].map((pin) => {
      const copy = pin.cloneNode(true) as HTMLElement
      copy.removeAttribute('data-swipe-pin')
      copy.setAttribute('aria-hidden', 'true')
      copy.setAttribute('inert', '')
      copy.style.pointerEvents = 'none'
      copy.style.opacity = visible ? '1' : '0'
      pin.style.opacity = '0'
      document.body.appendChild(copy)
      return copy
    })

    const pinNavs = () => {
      if (!layers || pinned) return
      pinned = { current: copyPins(layers.current, true), neighbor: copyPins(layers.underlay, false) }
    }

    const showNeighborNav = () => {
      if (!pinned) return
      const fade = `opacity 120ms ${EASE_OUT}`
      pinned.current.forEach((copy) => { copy.style.transition = fade; copy.style.opacity = '0' })
      pinned.neighbor.forEach((copy) => { copy.style.transition = fade; copy.style.opacity = '1' })
    }

    const unpinNavs = () => {
      if (!pinned) return
      for (const copy of [...pinned.current, ...pinned.neighbor]) copy.remove()
      pinned = null
    }

    /** Places both screens edge to edge for the current screen at `offset`, animated over `ms` (or at once). */
    const paint = (offset: number, side: TabSide, ms: number | null) => {
      if (!layers) return
      const width = window.innerWidth
      const transition = ms === null ? 'none' : `transform ${ms}ms ${EASE_OUT}`
      const { current, underlay } = layers
      current.style.transition = transition
      underlay.style.transition = transition
      current.style.transform = `translate3d(${offset}px, 0, 0)`
      underlay.style.transform = `translate3d(${tabNeighborOffset(offset, side, width)}px, 0, 0)`
    }

    const reset = () => {
      window.clearTimeout(timer)
      window.clearTimeout(fallback)
      tracking = null
      layers = null
      phase = 'idle'
      unpinNavs()
    }

    // AuthBoundary made the tab beside the real screen (or the screens changed under
    // the gesture): nothing left to move.
    const stopSettled = onSwipeSettled(reset)

    const onTouchStart = (event: TouchEvent) => {
      // A second finger: let the screen spring back.
      if (event.touches.length !== 1) { if (phase === 'tracking') finish(true); return }
      const touch = event.touches[0]
      if (phase === 'springing-back' && layers && tracking === null) {
        // Catch the screens while they spring back: they stop under the finger.
        const side = tabSwipeSide()
        if (!side) return
        const offset = currentShift(layers.current)
        window.clearTimeout(timer)
        paint(offset, side, null)
        phase = 'tracking'
        tracking = {
          startX: touch.clientX - tabDragDxForOffset(offset, side), startY: touch.clientY, side,
          intent: 'horizontal', offset, samples: [{ x: touch.clientX, t: event.timeStamp }], plain: false,
        }
        return
      }
      if (phase !== 'idle') return
      tracking = null
      // The left edge belongs to the swipe back (EdgeSwipeBack, or the browser's own).
      if (startsAtEdge(touch.clientX)) return
      const side = tabSwipeSide()
      if (!side || swipeBusy() || overlayOpen() || navTransitionRunning() || ownsHorizontalTouch(event.target)) return
      phase = 'tracking'
      tracking = {
        startX: touch.clientX, startY: touch.clientY, side, intent: 'pending', offset: 0,
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
        const intent = classifyTabSwipe(dx, dy)
        if (intent === 'pending') return
        // A scroll: leave it alone for the rest of this touch.
        if (intent === 'cancel' || overlayOpen()) { reset(); return }
        tracking.intent = 'horizontal'
        if (!tracking.plain) {
          // Renders the other tab beside this screen, synchronously, before the first move.
          layers = beginSwipeUnderlay('tab') ? swipeLayers() : null
          if (!layers) tracking.plain = true
          else pinNavs()
        }
      }
      // Committed to the tab swipe: from here the page must not scroll.
      if (event.cancelable) event.preventDefault()
      tracking.offset = tabDragOffset(dx, tracking.side, window.innerWidth)
      tracking.samples.push({ x: touch.clientX, t: event.timeStamp })
      if (tracking.samples.length > 8) tracking.samples.shift()
      if (!tracking.plain) paint(tracking.offset, tracking.side, null)
    }

    const finish = (cancelled: boolean) => {
      const state = tracking
      tracking = null
      if (phase !== 'tracking') return
      if (!state || state.intent !== 'horizontal') { phase = 'idle'; return }
      const width = window.innerWidth
      const velocity = swipeVelocity(state.samples)
      const switching = !cancelled && shouldSwitchTab(state.offset, width, velocity, state.side)
      if (state.plain || !layers) {
        if (layers) cancelSwipeUnderlay()
        reset()
        if (switching) switchTab()
        return
      }
      if (switching) {
        phase = 'switching'
        const duration = tabSwitchDuration(state.offset, width, velocity, state.side)
        paint(tabSwitchTarget(state.side, width), state.side, duration)
        // The nav shows the new tab as soon as the switch is decided.
        showNeighborNav()
        timer = window.setTimeout(() => {
          // AuthBoundary turns the layer beside into the screen and reports it settled.
          switchTab()
          // If that never happens, put the screens back rather than strand them.
          if (phase === 'switching') {
            fallback = window.setTimeout(() => {
              if (phase !== 'switching') return
              cancelSwipeUnderlay()
              reset()
            }, 300)
          }
        }, duration)
      } else {
        phase = 'springing-back'
        paint(0, state.side, TAB_SPRING_BACK_MS)
        timer = window.setTimeout(() => {
          cancelSwipeUnderlay()
          reset()
        }, TAB_SPRING_BACK_MS)
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
