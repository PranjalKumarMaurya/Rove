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

/** How far (fraction of the width) the screen underneath starts shifted left, as on iOS. */
export const UNDERLAY_SHIFT = 0.3
/** Opacity of the dim over the screen underneath when the swipe starts. */
export const UNDERLAY_DIM = 0.35
/** Shortest and longest finishing slide after a completed swipe (ms). */
export const COMPLETE_MIN_MS = 180
export const COMPLETE_MAX_MS = 320
/** A cancelled swipe settles back over this long (ms). */
export const CANCEL_MS = 250

/** 0 at rest, 1 when the current screen has left the viewport. */
export function swipeProgress(dx: number, width: number): number {
  if (width <= 0) return 0
  return Math.min(1, Math.max(0, dx / width))
}

/** translateX (px) of the screen underneath: -30% of the width at rest, 0 when uncovered. */
export function underlayShift(progress: number, width: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return -UNDERLAY_SHIFT * width * (1 - p)
}

/** Opacity of the dim over the screen underneath: 0.35 at rest, fading to 0. */
export function underlayDim(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  return UNDERLAY_DIM * (1 - p)
}

/**
 * Duration (ms) of the slide that finishes a released swipe: the remaining distance
 * at the finger's speed, so a flick carries on as fast as it was thrown, clamped so a
 * slow release still finishes briskly and a fast one is never a jump.
 */
export function completionDuration(remaining: number, velocity: number,
  min = COMPLETE_MIN_MS, max = COMPLETE_MAX_MS): number {
  if (!(remaining > 0)) return min
  const raw = velocity > 0.01 ? remaining / velocity : max
  return Math.round(Math.min(max, Math.max(min, raw)))
}
