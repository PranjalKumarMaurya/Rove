/** Pure thresholds for the iOS-standalone edge swipe back (see EdgeSwipeBack). */

export const EDGE_WIDTH = 24
/** Movement (px) before the gesture is classified as a swipe or a scroll. */
export const SLOP = 8
export const COMPLETE_FRACTION = 0.35
/** px per ms. */
export const FLICK_VELOCITY = 0.5

export type SwipeIntent = 'pending' | 'horizontal' | 'cancel'

export function startsAtEdge(clientX: number, edge = EDGE_WIDTH): boolean {
  return clientX >= 0 && clientX <= edge
}

/** Decides, from the movement so far, whether this touch is a back swipe. */
export function classifySwipe(dx: number, dy: number, slop = SLOP): SwipeIntent {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return 'pending'
  if (dx > 0 && dx > Math.abs(dy) * 1.5) return 'horizontal'
  return 'cancel'
}

/** On release: go back when dragged far enough, or flicked right fast enough. */
export function shouldCompleteSwipe(dx: number, width: number, velocity: number): boolean {
  if (dx <= 0 || width <= 0) return false
  if (dx >= width * COMPLETE_FRACTION) return true
  return velocity > FLICK_VELOCITY && dx > SLOP
}

/** Velocity (px/ms) over the recent samples, ignoring ones older than `windowMs`. */
export function swipeVelocity(samples: ReadonlyArray<{ x: number; t: number }>, windowMs = 100): number {
  if (samples.length < 2) return 0
  const last = samples[samples.length - 1]
  let first = samples[0]
  for (const sample of samples) {
    if (last.t - sample.t <= windowMs) { first = sample; break }
  }
  const dt = last.t - first.t
  return dt > 0 ? (last.x - first.x) / dt : 0
}

export function isStandaloneDisplay(standalone: unknown, displayModeStandalone: boolean): boolean {
  return standalone === true || displayModeStandalone
}
