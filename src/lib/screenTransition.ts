import { flushSync } from 'react-dom'
import type { NavDirection } from '../features/auth/navigationHistory'

/**
 * Screen-to-screen motion shared by AuthBoundary (which owns the screens) and
 * EdgeSwipeBack (which owns the iOS edge-swipe gesture).
 *
 * - Button navigation and the system back gesture animate with the View Transitions
 *   API (`runNavTransition`, keyframes in styles/screens.css): push slides the new
 *   screen in from the right over the old one, pop slides the current one off to the
 *   right, revealing the previous one. Unsupported browsers just switch screens.
 * - The edge swipe asks AuthBoundary (the registered `SwipeHost`) to render the
 *   previous screen in a layer beneath the current one, then moves the layers with the
 *   finger. A completed swipe goes `history.back()`, flagged with `markSwipeNavigation`
 *   so the resulting popstate does not animate a second time.
 * - The tab swipe (TabSwipe, between the Trips home and Profile-from-home) asks the same
 *   host for the other tab in a layer beside the current one (`begin('tab')`), moves
 *   both like a pager, and on a switch asks the host to make that layer the current
 *   screen (`switchTab`). Tapping the tabs in HomeNav slides them with a view transition.
 */

/** iOS navigation push/pop curve. */
export const PUSH_EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'
/** Entrances and settling back. */
export const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)'

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// ---- Swipes: the screen underneath (edge swipe) or beside (tab swipe) ------------

/** `back`: the previous screen beneath the current one. `tab`: the other home tab beside it. */
export type SwipeMode = 'back' | 'tab'

export interface SwipeHost {
  /** Render the other screen for this swipe, synchronously. False if there is none. */
  begin(mode: SwipeMode): boolean
  /** Remove that screen again (the swipe was cancelled and has settled back). */
  cancel(): void
  /** Where the other home tab sits for the current screen, if it is one of the two tabs. */
  tabSide(): 'left' | 'right' | null
  /**
   * Switch to the other home tab. With the tab layer showing (after `begin('tab')`), it
   * becomes the current screen as it is; without one, the switch plays the tab slide
   * (or its reduced-motion crossfade).
   */
  switchTab(): void
}

let host: SwipeHost | null = null
// The swipe whose layers are showing, so the edge and tab swipes never run together.
let activeSwipe: SwipeMode | null = null

export function registerSwipeHost(next: SwipeHost): () => void {
  host = next
  return () => { if (host === next) host = null }
}

export function beginSwipeUnderlay(mode: SwipeMode = 'back'): boolean {
  if (activeSwipe) return false
  let ok = false
  try { ok = host?.begin(mode) ?? false } catch { ok = false }
  if (ok) activeSwipe = mode
  return ok
}

export function cancelSwipeUnderlay(): void {
  activeSwipe = null
  host?.cancel()
}

/** A swipe's layers are on screen (being dragged, settling back or finishing). */
export function swipeBusy(): boolean {
  return activeSwipe !== null
}

export function tabSwipeSide(): 'left' | 'right' | null {
  try { return host?.tabSide() ?? null } catch { return null }
}

export function switchTab(): void {
  host?.switchTab()
}

export interface SwipeLayers {
  current: HTMLElement
  underlay: HTMLElement
  dim: HTMLElement | null
}

/** The layers AuthBoundary rendered for a swipe (see `rove-layer` in screens.css). */
export function swipeLayers(): SwipeLayers | null {
  const current = document.querySelector<HTMLElement>('[data-screen-layer="current"]')
  const underlay = document.querySelector<HTMLElement>('[data-screen-layer="underlay"]')
  if (!current || !underlay) return null
  return { current, underlay, dim: document.querySelector<HTMLElement>('[data-screen-dim]') }
}

/** Bars that stay put on screen while a tab swipe moves the screens (HomeNav). */
export const SWIPE_PIN_SELECTOR = '[data-swipe-pin]'

function clearMotionStyles(element: HTMLElement): void {
  element.style.removeProperty('transform')
  element.style.removeProperty('transition')
  element.style.removeProperty('opacity')
}

/** Drops everything the swipe wrote on a layer, so it is an ordinary screen again. */
export function clearLayerStyles(element: HTMLElement): void {
  clearMotionStyles(element)
  element.querySelectorAll<HTMLElement>(SWIPE_PIN_SELECTOR).forEach(clearMotionStyles)
  element.removeAttribute('inert')
}

let swipeNavigation = false

/** The next popstate comes from a completed edge swipe (already animated). */
export function markSwipeNavigation(): void { swipeNavigation = true }

/** Reads and clears the flag set by `markSwipeNavigation`. */
export function takeSwipeNavigation(): boolean {
  const value = swipeNavigation
  swipeNavigation = false
  return value
}

const settledListeners = new Set<() => void>()

/** Called once the swiped-to screen is the real one (or the swipe was abandoned). */
export function onSwipeSettled(listener: () => void): () => void {
  settledListeners.add(listener)
  return () => { settledListeners.delete(listener) }
}

export function notifySwipeSettled(): void {
  activeSwipe = null
  for (const listener of [...settledListeners]) listener()
}

// ---- Button navigation: View Transitions ----------------------------------------

interface ViewTransitionLike {
  finished: Promise<unknown>
  ready: Promise<unknown>
  updateCallbackDone: Promise<unknown>
}
type ViewTransitionDocument = { startViewTransition?: (update: () => void) => ViewTransitionLike }

let navToken = 0

/** A view transition is animating screens right now. */
export function navTransitionRunning(): boolean {
  return typeof document !== 'undefined' && !!document.documentElement.dataset.nav
}

/**
 * Applies `update` (a React state change) inside a view transition so the screens
 * slide: `data-nav` on <html> picks the keyframes in screens.css. Reduced motion
 * crossfades instead. Without the API (or for `none`) the update just happens.
 */
export function runNavTransition(direction: NavDirection, update: () => void): void {
  const doc = typeof document === 'undefined' ? null : document as unknown as ViewTransitionDocument
  if (direction === 'none' || !doc || typeof doc.startViewTransition !== 'function'
    || document.visibilityState === 'hidden') {
    update()
    return
  }
  const html = document.documentElement
  const token = ++navToken
  html.dataset.nav = prefersReducedMotion() ? 'fade' : direction
  const done = () => { if (token === navToken) delete html.dataset.nav }
  let applied = false
  try {
    const transition = doc.startViewTransition.call(document, () => {
      applied = true
      flushSync(update)
    })
    transition.ready.catch(() => { /* skipped (e.g. interrupted by the next one): nothing to animate */ })
    transition.updateCallbackDone.catch(() => { /* the update itself failed; React reports it */ })
    transition.finished.then(done, done)
  } catch {
    done()
    if (!applied) update()
  }
}

/**
 * The browser already animated this back navigation itself (Safari's swipe in a tab,
 * Chrome's predictive back), so ours would play twice.
 */
export function systemAnimatedBack(event: PopStateEvent): boolean {
  if ((event as PopStateEvent & { hasUAVisualTransition?: boolean }).hasUAVisualTransition === true) return true
  if (typeof navigator === 'undefined') return false
  const ios = /iP(hone|ad|od)/u.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (!ios) return false
  // In a Safari tab the edge swipe is the browser's own; installed to the home
  // screen there is none (EdgeSwipeBack's swipe is flagged separately).
  const standalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
    || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches)
  return !standalone
}
