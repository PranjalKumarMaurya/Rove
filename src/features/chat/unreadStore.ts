import { useEffect, useSyncExternalStore } from 'react'
import { supabase } from '../../lib/supabase'

// Unread chat messages per Trip, for the Chat tab's dot, the Trips home cards and
// the Home Screen app badge. One store for the whole app, read from
// `get_my_unread_counts` (the caller's own read state only, migration 097).

let counts: Readonly<Record<string, number>> = {}
const listeners = new Set<() => void>()
let inFlight: Promise<void> | null = null
let again = false

function emit() {
  for (const listener of listeners) listener()
  applyAppBadge()
}

/** The Home Screen icon's count: every unread message across Trips, cleared when all are read. */
function applyAppBadge() {
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0)
  const nav = typeof navigator === 'undefined' ? null : navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  try {
    if (total > 0) void nav?.setAppBadge?.(total)?.catch(() => {})
    else void nav?.clearAppBadge?.()?.catch(() => {})
  } catch { /* the Badging API is optional */ }
}

function set(next: Record<string, number>) {
  const same = Object.keys(next).length === Object.keys(counts).length && Object.entries(next).every(([key, value]) => counts[key] === value)
  if (same) return
  counts = next
  emit()
}

/** Re-read the counts (coalesced: calls while one is running queue one more read). */
export function refreshUnread(): Promise<void> {
  if (inFlight) {
    again = true
    return inFlight
  }
  inFlight = (async () => {
    try {
      const { data, error } = await supabase.rpc('get_my_unread_counts')
      if (!error && Array.isArray(data)) {
        set(Object.fromEntries(data.filter((row) => typeof row.group_id === 'string' && typeof row.unread === 'number')
          .map((row) => [row.group_id, row.unread])))
      }
    } catch { /* offline: keep what is shown */ } finally {
      inFlight = null
      if (again) {
        again = false
        void refreshUnread()
      }
    }
  })()
  return inFlight
}

/** The person just read this Trip's chat: show it at once, before the server confirms. */
export function markTripReadLocally(groupId: string) {
  if (!counts[groupId]) return
  set({ ...counts, [groupId]: 0 })
}

/** Signed out: forget everything (and clear the badge). */
export function resetUnread() {
  set({})
}

export function useUnreadCounts(): Readonly<Record<string, number>> {
  return useSyncExternalStore((listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, () => counts, () => counts)
}

/**
 * Keep the counts fresh while this screen is mounted: on mount, when the app
 * comes back to the front, when a push arrives (the service worker tells open
 * windows), and once a minute while visible.
 */
export function useUnreadRefresh(enabled = true) {
  useEffect(() => {
    if (!enabled) return
    void refreshUnread()
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshUnread() }
    const onMessage = (event: MessageEvent) => { if ((event.data as { type?: string } | null)?.type === 'rove:push') void refreshUnread() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    const worker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null
    worker?.addEventListener('message', onMessage)
    const poll = window.setInterval(onVisible, 60_000)
    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      worker?.removeEventListener('message', onMessage)
    }
  }, [enabled])
}

/** New messages in one Trip, live (a nudge to re-read the counts, debounced). */
export function useUnreadLive(groupId: string) {
  useEffect(() => {
    let timer: number | undefined
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refreshUnread(), 400)
    }
    const channel = supabase.channel(`trip-unread:${groupId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_messages', filter: `group_id=eq.${groupId}` }, schedule)
    channel.subscribe()
    return () => {
      window.clearTimeout(timer)
      void supabase.removeChannel(channel)
    }
  }, [groupId])
}
