import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import type { LiveStatus } from '../trip/useLiveRefetch'
import { CHAT_PAGE_SIZE, mergeServerRows, settledPending, type ChatMessage, type PendingMessage } from './chatRules'

const COLUMNS = 'id, group_id, sender_id, body, client_id, created_at'
/** Catch-up reads reach this far behind the newest row: a message committed late can carry an earlier timestamp. */
const CATCH_UP_OVERLAP_MS = 60_000
const CATCH_UP_LIMIT = 200

export class ChatError extends Error {
  constructor(code = 'trip_chat_failed') { super(code) }
}

export interface ChatPage {
  /** Oldest first, ready to display. */
  rows: ChatMessage[]
  /** Older messages exist beyond this page. */
  hasMore: boolean
}

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return ['id', 'group_id', 'sender_id', 'body', 'client_id', 'created_at'].every((key) => typeof row[key] === 'string')
}

function toPage(data: unknown[] | null): ChatPage {
  const rows = (data ?? []).filter(isMessage)
  const hasMore = rows.length > CHAT_PAGE_SIZE
  return { rows: rows.slice(0, CHAT_PAGE_SIZE).reverse(), hasMore }
}

/** The newest 50 messages of a Trip (read newest first, returned oldest first). */
export async function loadLatestMessages(groupId: string): Promise<ChatPage> {
  const { data, error } = await supabase.from('trip_messages').select(COLUMNS).eq('group_id', groupId)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(CHAT_PAGE_SIZE + 1)
  if (error) throw new ChatError()
  return toPage(data)
}

/** The 50 messages before `before` (strictly older, ties broken by id). */
export async function loadEarlierMessages(groupId: string, before: Pick<ChatMessage, 'id' | 'created_at'>): Promise<ChatPage> {
  const at = `"${before.created_at}"`
  const { data, error } = await supabase.from('trip_messages').select(COLUMNS).eq('group_id', groupId)
    .or(`created_at.lt.${at},and(created_at.eq.${at},id.lt.${before.id})`)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(CHAT_PAGE_SIZE + 1)
  if (error) throw new ChatError()
  return toPage(data)
}

/** Everything from shortly before `latest` on, oldest first (merged by id, so overlap is harmless). */
async function loadSince(groupId: string, latest: ChatMessage): Promise<ChatMessage[]> {
  const from = new Date(Date.parse(latest.created_at) - CATCH_UP_OVERLAP_MS).toISOString()
  const { data, error } = await supabase.from('trip_messages').select(COLUMNS).eq('group_id', groupId)
    .gte('created_at', from).order('created_at').order('id').limit(CATCH_UP_LIMIT)
  if (error) throw new ChatError()
  return (data ?? []).filter(isMessage)
}

/**
 * Post a message. `clientId` is made once per message and reused on every retry:
 * if an earlier attempt did reach the server (the reply was lost), the unique
 * (sender_id, client_id) refuses the copy and we return the stored row instead.
 */
export async function sendMessage(groupId: string, senderId: string, body: string, clientId: string): Promise<ChatMessage> {
  const { data, error } = await supabase.from('trip_messages')
    .insert({ group_id: groupId, sender_id: senderId, body, client_id: clientId }).select(COLUMNS).single()
  if (!error && isMessage(data)) return data
  if (error?.code !== '23505') throw new ChatError()
  const { data: existing, error: readError } = await supabase.from('trip_messages').select(COLUMNS)
    .eq('group_id', groupId).eq('sender_id', senderId).eq('client_id', clientId).maybeSingle()
  if (readError || !isMessage(existing)) throw new ChatError()
  return existing
}

/**
 * The Trip's chat, live. Loads the newest page, appends rows as Realtime reports
 * them (Realtime only delivers rows the subscriber may SELECT under RLS), and
 * catches up through RLS once subscribed, when the app becomes visible again and
 * every 30 s, in case the socket dropped. Rows are merged by id, never doubled.
 */
export function useTripChat(groupId: string, me: string) {
  const [rows, setRows] = useState<ChatMessage[]>([])
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [live, setLive] = useState<LiveStatus>('connecting')
  const rowsRef = useRef<ChatMessage[]>([])
  const pendingRef = useRef<PendingMessage[]>([])
  const mounted = useRef(true)
  const updatePending = useCallback((change: (current: PendingMessage[]) => PendingMessage[]) => {
    const next = change(pendingRef.current)
    if (next === pendingRef.current) return
    pendingRef.current = next
    setPending(next)
  }, [])
  const loaded = useRef(false)

  const apply = useCallback((incoming: ChatMessage[]) => {
    if (!mounted.current || !incoming.length) return
    const next = mergeServerRows(rowsRef.current, incoming)
    if (next === rowsRef.current) return
    rowsRef.current = next
    setRows(next)
    updatePending((current) => settledPending(next, current))
  }, [updatePending])

  const loadFirst = useCallback(async () => {
    try {
      const page = await loadLatestMessages(groupId)
      if (!mounted.current) return
      loaded.current = true
      setError(false)
      setHasMore(page.hasMore)
      rowsRef.current = mergeServerRows(rowsRef.current, page.rows)
      setRows(rowsRef.current)
    } catch {
      if (mounted.current) setError(true)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [groupId])

  const catchUp = useCallback(async () => {
    const latest = rowsRef.current[rowsRef.current.length - 1]
    if (!loaded.current || !latest) {
      await loadFirst()
      return
    }
    try {
      apply(await loadSince(groupId, latest))
    } catch { /* the next nudge or poll tries again */ }
  }, [apply, groupId, loadFirst])

  useEffect(() => {
    mounted.current = true
    void loadFirst()
    return () => { mounted.current = false }
  }, [loadFirst])

  const catchUpRef = useRef(catchUp)
  useEffect(() => { catchUpRef.current = catchUp }, [catchUp])

  useEffect(() => {
    let active = true
    // A unique topic per mount (see useLiveRefetch): StrictMode mounts twice.
    const channel = supabase.channel(`trip-chat:${groupId}:${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'trip_messages', filter: `group_id=eq.${groupId}` },
        (payload) => { if (active && isMessage(payload.new) && payload.new.group_id === groupId) apply([payload.new]) })
    channel.subscribe((state) => {
      if (!active) return
      if (state === 'SUBSCRIBED') {
        setLive('live')
        void catchUpRef.current()
      } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        setLive('offline')
      }
    })
    const onVisible = () => { if (document.visibilityState === 'visible') void catchUpRef.current() }
    document.addEventListener('visibilitychange', onVisible)
    const poll = window.setInterval(onVisible, 30_000)
    return () => {
      active = false
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', onVisible)
      void supabase.removeChannel(channel)
    }
  }, [apply, groupId])

  /** Prepend the page before the oldest loaded message. Resolves to the rows added. */
  const loadEarlier = useCallback(async (): Promise<ChatMessage[]> => {
    const oldest = rowsRef.current[0]
    if (!oldest || loadingEarlier) return []
    setLoadingEarlier(true)
    try {
      const page = await loadEarlierMessages(groupId, oldest)
      if (!mounted.current) return []
      setHasMore(page.hasMore)
      apply(page.rows)
      return page.rows
    } catch {
      return []
    } finally {
      if (mounted.current) setLoadingEarlier(false)
    }
  }, [apply, groupId, loadingEarlier])

  const attempt = useCallback(async (item: PendingMessage) => {
    try {
      apply([await sendMessage(groupId, item.senderId, item.body, item.clientId)])
    } catch {
      if (!mounted.current) return
      updatePending((current) => current.map((entry) => entry.clientId === item.clientId ? { ...entry, status: 'failed' } : entry))
    }
  }, [apply, groupId, updatePending])

  /** Show the message at once as pending, then post it. `body` must already be validated. */
  const send = useCallback((body: string) => {
    const item: PendingMessage = { clientId: crypto.randomUUID(), senderId: me, body, createdAt: new Date().toISOString(), status: 'sending' }
    updatePending((current) => [...current, item])
    void attempt(item)
  }, [attempt, me, updatePending])

  /** Resend a failed message with the same client_id, so it can never post twice. */
  const retry = useCallback((clientId: string) => {
    const failed = pendingRef.current.find((entry) => entry.clientId === clientId && entry.status === 'failed')
    if (!failed) return
    const item: PendingMessage = { ...failed, status: 'sending' }
    updatePending((current) => current.map((entry) => entry.clientId === clientId ? item : entry))
    void attempt(item)
  }, [attempt, updatePending])

  return { rows, pending, hasMore, loading, error, loadingEarlier, live, loadEarlier, send, retry, reload: loadFirst }
}
