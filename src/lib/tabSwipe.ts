/**
 * Pure rules for swiping between the two home tabs (Trips | Profile), see TabSwipe.
 * `side` is where the other tab sits: Profile is to the right of Trips, so on Trips the
 * finger drags left to reveal it; Trips is to the left of Profile, revealed dragging right.
 */

import { completionDuration } from './edgeSwipe.ts'

export type TabSide = 'left' | 'right'

/** Movement (px) before a touch is classified as a tab swipe or a scroll. */
export const TAB_SLOP = 10
/** Horizontal must beat vertical by this factor to count as a swipe. */
export const TAB_AXIS_RATIO = 1.5
/** Release past this fraction of the width switches tab. */
export const TAB_SWITCH_FRACTION = 0.3
/** A flick faster than this (px/ms) towards the other tab switches too. */
export const TAB_FLICK_VELOCITY = 0.5
/** Dragging away from the other tab moves the screen this much of the finger's travel... */
export const TAB_RESISTANCE = 0.25
/** ...and never further than this (px). */
export const TAB_RESISTANCE_MAX = 48
/** The finishing slide after a switch: from the finger's speed, within these bounds (ms). */
export const TAB_SWITCH_MIN_MS = 180
export const TAB_SWITCH_MAX_MS = 300
/** A swipe that does not switch springs back over this long (ms). */
export const TAB_SPRING_BACK_MS = 250

export type TabIntent = 'pending' | 'horizontal' | 'cancel'

/** From the movement so far: a horizontal tab swipe, a scroll (cancel), or too early to say. */
export function classifyTabSwipe(dx: number, dy: number, slop = TAB_SLOP): TabIntent {
  if (Math.abs(dx) < slop && Math.abs(dy) < slop) return 'pending'
  return Math.abs(dx) > Math.abs(dy) * TAB_AXIS_RATIO ? 'horizontal' : 'cancel'
}

/** +1 when the other tab is reached by moving the screen right, -1 when by moving it left. */
function towards(side: TabSide): 1 | -1 {
  return side === 'left' ? 1 : -1
}

/**
 * Where the current screen sits (translateX, px) for a finger `dx` from the start:
 * 1:1 towards the other tab (up to a full width), rubber-banded the wrong way.
 */
export function tabDragOffset(dx: number, side: TabSide, width: number): number {
  const sign = towards(side)
  const along = dx * sign
  if (along >= 0) return sign * Math.min(along, Math.max(0, width))
  return -sign * Math.min(-along * TAB_RESISTANCE, TAB_RESISTANCE_MAX)
}

/** The finger travel that puts the screen at `offset` (inverse of tabDragOffset), to catch a moving screen. */
export function tabDragDxForOffset(offset: number, side: TabSide): number {
  const sign = towards(side)
  const along = offset * sign
  return along >= 0 ? offset : offset / TAB_RESISTANCE
}

/** How far (px) the screen has travelled towards the other tab; negative when pulled the wrong way. */
export function tabProgress(offset: number, side: TabSide): number {
  return offset * towards(side)
}

/** translateX (px) of the other tab's screen, kept edge to edge with the current one. */
export function tabNeighborOffset(offset: number, side: TabSide, width: number): number {
  return offset + (side === 'left' ? -width : width)
}

/** On release: switch when dragged past 30% of the width, or flicked towards the other tab. */
export function shouldSwitchTab(offset: number, width: number, velocity: number, side: TabSide): boolean {
  if (width <= 0) return false
  const progress = tabProgress(offset, side)
  if (progress <= 0) return false
  if (progress >= width * TAB_SWITCH_FRACTION) return true
  return velocity * towards(side) > TAB_FLICK_VELOCITY
}

/** Duration (ms) of the slide that finishes a switch: the remaining distance at the finger's speed, 180–300ms. */
export function tabSwitchDuration(offset: number, width: number, velocity: number, side: TabSide): number {
  const remaining = width - tabProgress(offset, side)
  return completionDuration(remaining, velocity * towards(side), TAB_SWITCH_MIN_MS, TAB_SWITCH_MAX_MS)
}

/** Where the current screen ends up after a switch (the other tab then sits at 0). */
export function tabSwitchTarget(side: TabSide, width: number): number {
  return towards(side) * width
}
