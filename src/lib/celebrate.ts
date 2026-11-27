/**
 * A tiny emitter for the success tick: `celebrate('Saved')` after the server confirms
 * something, and the single <SuccessTick /> host at the app root shows it.
 * Calls arriving within a moment of each other (one action reported by two layers)
 * only update the label of the tick already showing instead of playing it twice.
 */

export interface Celebration {
  id: number
  label: string
}

type Listener = (celebration: Celebration) => void

export const COALESCE_MS = 600

const listeners = new Set<Listener>()
let nextId = 1
let last: { id: number; at: number } | null = null

/** True when a call at `now` belongs to the celebration that started at `lastAt`. */
export function shouldCoalesce(now: number, lastAt: number | null, windowMs = COALESCE_MS): boolean {
  return lastAt !== null && now - lastAt >= 0 && now - lastAt < windowMs
}

/** How long after a celebration a follow-up may still relabel it. */
export const FOLLOW_UP_MS = 1200

/**
 * `followUp`: this success is the tail of an action that already celebrated (a Scan bill
 * linked after ExpenseForm saved it). It relabels a tick still showing and otherwise does
 * nothing, so one action never plays twice however slow the second step is.
 */
export function celebrate(label = 'Saved', { followUp = false }: { followUp?: boolean } = {}): void {
  const now = Date.now()
  if (followUp && !(last && shouldCoalesce(now, last.at, FOLLOW_UP_MS))) return
  const id = last && (followUp || shouldCoalesce(now, last.at)) ? last.id : nextId++
  if (!last || last.id !== id) last = { id, at: now }
  const celebration = { id, label: label.trim() || 'Saved' }
  for (const listener of listeners) listener(celebration)
}

export function onCelebrate(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
