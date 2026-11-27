/**
 * Pure rules that keep the signed-in screens (React state in AuthBoundary) in step with
 * the browser history, so Android's back gesture and the iOS edge swipe move between
 * screens instead of leaving the app.
 *
 * Each screen has a depth: the Trips home is 0, a Trip, Create and Profile-from-home are 1,
 * Profile opened from a Trip is 2. The history holds one entry per depth level, each
 * tagged `{ rove, roveDepth }`. Going deeper pushes entries, going shallower goes back
 * through them, and moving sideways (Create → the new Trip) replaces the current entry.
 */

export type View =
  | { kind: 'home' }
  | { kind: 'trip'; groupId: string }
  | { kind: 'create' }
  | { kind: 'profile'; from: { kind: 'home' } | { kind: 'trip'; groupId: string } }

export interface RoveHistoryState {
  rove: View
  roveDepth: number
}

export type HistoryPlan =
  | { kind: 'none' }
  | { kind: 'push'; count: number }
  | { kind: 'back'; count: number }
  | { kind: 'replace' }

export function viewDepth(view: View): number {
  if (view.kind === 'home') return 0
  if (view.kind === 'profile' && view.from.kind === 'trip') return 2
  return 1
}

/** A stable identity for a view, so the same screen is not recorded twice. */
export function viewKey(view: View): string {
  switch (view.kind) {
    case 'home': return 'home'
    case 'create': return 'create'
    case 'trip': return `trip:${view.groupId}`
    case 'profile': return view.from.kind === 'trip' ? `profile:trip:${view.from.groupId}` : 'profile:home'
  }
}

/** How to move from the current history entry (at `entryDepth`) to a view at `targetDepth`. */
export function planHistory(entryDepth: number, targetDepth: number): HistoryPlan {
  if (targetDepth > entryDepth) return { kind: 'push', count: targetDepth - entryDepth }
  if (targetDepth < entryDepth) return { kind: 'back', count: entryDepth - targetDepth }
  return { kind: 'replace' }
}

export function roveState(view: View, depth = viewDepth(view)): RoveHistoryState {
  return { rove: view, roveDepth: depth }
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function readView(value: unknown): View | null {
  if (!value || typeof value !== 'object') return null
  const view = value as Record<string, unknown>
  if (view.kind === 'home' || view.kind === 'create') return { kind: view.kind }
  if (view.kind === 'trip') return isId(view.groupId) ? { kind: 'trip', groupId: view.groupId } : null
  if (view.kind === 'profile') {
    const from = view.from as Record<string, unknown> | null | undefined
    if (from?.kind === 'home') return { kind: 'profile', from: { kind: 'home' } }
    if (from?.kind === 'trip' && isId(from.groupId)) return { kind: 'profile', from: { kind: 'trip', groupId: from.groupId } }
  }
  return null
}

/** Reads a history entry's state; anything not written by us counts as the Trips home at depth 0. */
export function readRoveState(state: unknown): RoveHistoryState {
  const raw = state && typeof state === 'object' ? state as Record<string, unknown> : null
  const view = raw ? readView(raw.rove) : null
  if (!view) return { rove: { kind: 'home' }, roveDepth: 0 }
  const depth = typeof raw?.roveDepth === 'number' && Number.isInteger(raw.roveDepth) && raw.roveDepth >= 0
    ? raw.roveDepth : viewDepth(view)
  return { rove: view, roveDepth: depth }
}

/** The depth of the current entry: 0 unless it is one of ours. */
export function entryDepthOf(state: unknown): number {
  return readRoveState(state).roveDepth
}

/** Merges our tag into an entry's state, keeping anything else stored there. */
export function withRoveState(state: unknown, view: View, depth = viewDepth(view)): Record<string, unknown> {
  const base = state && typeof state === 'object' ? state as Record<string, unknown> : {}
  return { ...base, ...roveState(view, depth) }
}

/**
 * The screen one level back in the history stack: what the iOS edge swipe shows
 * beneath the current screen. A Trip, Create and Profile-from-home sit on the Trips
 * home; Profile opened from a Trip sits on that Trip. The Trips home has nothing below.
 */
export function previousView(view: View): View | null {
  if (view.kind === 'home') return null
  if (view.kind === 'profile' && view.from.kind === 'trip') return { kind: 'trip', groupId: view.from.groupId }
  return { kind: 'home' }
}

export type NavDirection = 'push' | 'pop' | 'tab-left' | 'tab-right' | 'none'

/**
 * The two home tabs, Trips and Profile-opened-from-home, sit side by side like tabs in
 * a native app: Profile to the right of Trips. Each has the other as its neighbour, on
 * that side; every other screen has none. (In the history Profile-from-home is still
 * one level above the Trips home, so going to Profile pushes and back to Trips pops.)
 */
export function adjacentTab(view: View): { view: View; side: 'left' | 'right' } | null {
  if (view.kind === 'home') return { view: { kind: 'profile', from: { kind: 'home' } }, side: 'right' }
  if (view.kind === 'profile' && view.from.kind === 'home') return { view: { kind: 'home' }, side: 'left' }
  return null
}

/**
 * How moving between two screens animates: deeper slides the new screen in from the
 * right (push), shallower slides the current one off to the right (pop), a sideways
 * move (Create → the new Trip, Profile → Create) reads as forward, the same screen is none.
 * Between the two home tabs the screens slide side by side instead: `tab-left` moves
 * them left (Trips → Profile), `tab-right` moves them right (Profile → Trips).
 */
export function navDirection(from: View, to: View): NavDirection {
  if (viewKey(from) === viewKey(to)) return 'none'
  const tab = adjacentTab(from)
  if (tab && viewKey(tab.view) === viewKey(to)) return tab.side === 'right' ? 'tab-left' : 'tab-right'
  return viewDepth(to) < viewDepth(from) ? 'pop' : 'push'
}
